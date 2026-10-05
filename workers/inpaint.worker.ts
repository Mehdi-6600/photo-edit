import * as ort from "onnxruntime-web/webgpu";
import { MODEL_INPUT_SIZE } from "../lib/image-processing";

const DEFAULT_MODEL_URL =
  "https://huggingface.co/Carve/LaMa-ONNX/resolve/9d292e165e1a997f3b7b2fbeab74bb7207b1637d/lama_fp32.onnx";
const EXPECTED_MODEL_BYTES = 208_044_816;
const MODEL_CACHE_NAME = "still-lama-fp32-v1";
const MODEL_PIXELS = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;

interface InpaintRequest {
  type: "inpaint";
  requestId: number;
  tileIndex: number;
  tileCount: number;
  imageTensor: Float32Array;
  maskTensor: Float32Array;
}

interface WorkerScope {
  crossOriginIsolated?: boolean;
  navigator: Navigator & { gpu?: unknown };
  caches: CacheStorage;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<InpaintRequest>) => void) | null;
}

const workerScope = self as unknown as WorkerScope;
let modelSession: ort.InferenceSession | null = null;
let activeProvider: "webgpu" | "wasm" | null = null;
let sessionPromise: Promise<void> | null = null;
let modelInputNames: { image: string; mask: string; output: string } | null = null;

function postProgress(
  requestId: number,
  phase: "download" | "prepare" | "inference",
  message: string,
  progress: number | null = null,
  tileIndex?: number,
  tileCount?: number,
  provider?: "webgpu" | "wasm",
): void {
  workerScope.postMessage({
    type: "progress",
    requestId,
    phase,
    message,
    progress,
    tileIndex,
    tileCount,
    provider,
  });
}

async function loadModelBytes(requestId: number): Promise<ArrayBuffer> {
  const modelUrl = process.env.NEXT_PUBLIC_LAMA_MODEL_URL || DEFAULT_MODEL_URL;
  let cache: Cache | null = null;
  let response: Response | undefined;
  let loadedFromCache = false;

  try {
    const openedCache = await workerScope.caches.open(MODEL_CACHE_NAME);
    cache = openedCache;
    response = (await openedCache.match(modelUrl)) ?? undefined;
  } catch {
    cache = null;
  }

  if (!response) {
    postProgress(requestId, "download", "Downloading the on-device model", 0);
    try {
      response = await fetch(modelUrl, {
        mode: "cors",
        credentials: "omit",
        cache: "force-cache",
      });
    } catch {
      throw new Error("The AI model could not be downloaded. Check your connection and try again.");
    }

    if (!response.ok) {
      throw new Error(`The AI model download failed (${response.status}).`);
    }

    if (cache) {
      try {
        void cache.put(modelUrl, response.clone()).catch(() => undefined);
      } catch {
        // Browser storage can be unavailable or full; normal HTTP caching still applies.
      }
    }
  } else {
    loadedFromCache = true;
    postProgress(requestId, "download", "Loading the cached on-device model", 0);
  }

  const contentLength = Number(response.headers.get("content-length")) || 0;
  const expectedLength = modelUrl === DEFAULT_MODEL_URL ? EXPECTED_MODEL_BYTES : 0;
  const totalBytes = contentLength || expectedLength;
  const reader = response.body?.getReader();

  if (!reader) {
    const buffer = await response.arrayBuffer();
    if (expectedLength && buffer.byteLength !== expectedLength) {
      throw new Error("The downloaded AI model is incomplete. Refresh the page and try again.");
    }
    return buffer;
  }

  let capacity = totalBytes || 8 * 1024 * 1024;
  let bytes = new Uint8Array(capacity);
  let received = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;

    const required = received + value.byteLength;
    if (required > bytes.byteLength) {
      if (totalBytes && required > totalBytes) {
        throw new Error("The model host returned an unexpected file size.");
      }
      const nextCapacity = Math.max(required, bytes.byteLength * 2);
      const expanded = new Uint8Array(nextCapacity);
      expanded.set(bytes.subarray(0, received));
      bytes = expanded;
    }

    bytes.set(value, received);
    received = required;

    const progress = totalBytes ? Math.min(100, Math.round((received / totalBytes) * 100)) : null;
    postProgress(
      requestId,
      "download",
      loadedFromCache ? "Loading the cached on-device model" : "Downloading the on-device model",
      progress,
    );
  }

  if (expectedLength && received !== expectedLength) {
    throw new Error("The downloaded AI model is incomplete. Refresh the page and try again.");
  }

  const exactBytes = bytes.subarray(0, received);
  return exactBytes.buffer.slice(exactBytes.byteOffset, exactBytes.byteOffset + exactBytes.byteLength);
}

async function createSession(
  modelBytes: ArrayBuffer,
  executionProvider: "webgpu" | "wasm",
): Promise<ort.InferenceSession> {
  return ort.InferenceSession.create(modelBytes, {
    executionProviders: [executionProvider],
    graphOptimizationLevel: "all",
  });
}

async function ensureSession(requestId: number): Promise<void> {
  if (modelSession) return;
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    ort.env.logLevel = "error";
    const isIsolated = workerScope.crossOriginIsolated === true;
    const cores = workerScope.navigator?.hardwareConcurrency ?? 1;
    ort.env.wasm.numThreads = isIsolated ? Math.max(1, Math.min(4, Math.floor(cores / 2))) : 1;

    const modelBytes = await loadModelBytes(requestId);
    postProgress(requestId, "prepare", "Preparing the AI model for this device", null);

    const hasWebGPU = typeof workerScope.navigator !== "undefined"
      && "gpu" in (workerScope.navigator as Navigator & { gpu?: unknown });

    if (hasWebGPU) {
      try {
        modelSession = await createSession(modelBytes, "webgpu");
        activeProvider = "webgpu";
      } catch {
        modelSession = null;
      }
    }

    if (!modelSession) {
      modelSession = await createSession(modelBytes, "wasm");
      activeProvider = "wasm";
    }

    const inputNames = modelSession.inputNames;
    const imageName = inputNames.find((name) => name.toLowerCase() === "image") ?? inputNames[0];
    const maskName = inputNames.find((name) => name.toLowerCase() === "mask") ?? inputNames[1];
    const outputName = modelSession.outputNames[0];

    if (!imageName || !maskName || !outputName) {
      throw new Error("The selected model does not expose the expected LaMa image and mask inputs.");
    }

    modelInputNames = { image: imageName, mask: maskName, output: outputName };
    postProgress(
      requestId,
      "prepare",
      activeProvider === "webgpu" ? "AI model ready · WebGPU" : "AI model ready · WebAssembly",
      100,
      undefined,
      undefined,
      activeProvider ?? undefined,
    );
  })();

  try {
    await sessionPromise;
  } catch (error) {
    modelSession = null;
    activeProvider = null;
    sessionPromise = null;
    throw error;
  }
}

async function switchToWasm(requestId: number): Promise<void> {
  if (activeProvider === "wasm") throw new Error("The WebAssembly inference session failed.");

  postProgress(requestId, "prepare", "Switching to the compatible WebAssembly engine", null);
  try {
    await modelSession?.release();
  } catch {
    // Recreate the session even if a GPU session could not be released cleanly.
  }

  const modelBytes = await loadModelBytes(requestId);
  modelSession = await createSession(modelBytes, "wasm");
  activeProvider = "wasm";

  const inputNames = modelSession.inputNames;
  const imageName = inputNames.find((name) => name.toLowerCase() === "image") ?? inputNames[0];
  const maskName = inputNames.find((name) => name.toLowerCase() === "mask") ?? inputNames[1];
  const outputName = modelSession.outputNames[0];

  if (!imageName || !maskName || !outputName) {
    throw new Error("The selected model does not expose the expected LaMa image and mask inputs.");
  }

  modelInputNames = { image: imageName, mask: maskName, output: outputName };
  postProgress(requestId, "prepare", "Continuing on WebAssembly", 100, undefined, undefined, "wasm");
}

function outputToRgb(tensorData: ort.Tensor["data"]): Uint8Array {
  const output = tensorData as Float32Array;
  const rgb = new Uint8Array(MODEL_PIXELS * 3);
  let maximum = -Infinity;
  let minimum = Infinity;

  for (let index = 0; index < output.length; index += 1) {
    const value = output[index];
    if (value > maximum) maximum = value;
    if (value < minimum) minimum = value;
  }

  const valuesAreNormalized = maximum <= 1.5 && minimum >= -0.25;
  const scale = valuesAreNormalized ? 255 : 1;

  for (let pixel = 0; pixel < MODEL_PIXELS; pixel += 1) {
    const red = output[pixel] * scale;
    const green = output[MODEL_PIXELS + pixel] * scale;
    const blue = output[MODEL_PIXELS * 2 + pixel] * scale;
    const rgbIndex = pixel * 3;

    rgb[rgbIndex] = Math.max(0, Math.min(255, Math.round(red)));
    rgb[rgbIndex + 1] = Math.max(0, Math.min(255, Math.round(green)));
    rgb[rgbIndex + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  }

  return rgb;
}

async function runRequest(request: InpaintRequest): Promise<void> {
  try {
    await ensureSession(request.requestId);
    if (!modelSession || !modelInputNames) {
      throw new Error("The AI session could not be started.");
    }

    const image = new ort.Tensor("float32", request.imageTensor, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]);
    const mask = new ort.Tensor("float32", request.maskTensor, [1, 1, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]);
    const feeds: Record<string, ort.Tensor> = {
      [modelInputNames.image]: image,
      [modelInputNames.mask]: mask,
    };

    postProgress(
      request.requestId,
      "inference",
      `Rebuilding selected area ${request.tileIndex} of ${request.tileCount}`,
      null,
      request.tileIndex,
      request.tileCount,
      activeProvider ?? undefined,
    );

    let results: ort.InferenceSession.OnnxValueMapType;
    try {
      results = await modelSession.run(feeds);
    } catch (error) {
      if (activeProvider !== "webgpu") throw error;
      await switchToWasm(request.requestId);
      if (!modelSession || !modelInputNames) throw error;
      const fallbackFeeds: Record<string, ort.Tensor> = {
        [modelInputNames.image]: image,
        [modelInputNames.mask]: mask,
      };
      results = await modelSession.run(fallbackFeeds);
    }

    const outputTensor = results[modelInputNames.output];
    if (!outputTensor || outputTensor.data.length < MODEL_PIXELS * 3) {
      throw new Error("The AI model returned an incomplete image.");
    }

    const outputRgb = outputToRgb(outputTensor.data);
    workerScope.postMessage(
      {
        type: "result",
        requestId: request.requestId,
        outputRgb,
        provider: activeProvider,
      },
      [outputRgb.buffer],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "The AI image processing failed.";
    workerScope.postMessage({ type: "error", requestId: request.requestId, message });
  }
}

workerScope.onmessage = (event: MessageEvent<InpaintRequest>) => {
  const request = event.data;
  if (request?.type !== "inpaint") return;
  void runRequest(request);
};
