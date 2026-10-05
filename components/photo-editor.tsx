"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { EditorStage, type EditorStageHandle } from "@/components/editor-stage";
import { Icon } from "@/components/ui-icons";
import {
  addTileOutputToOverlay,
  createOutputBlobs,
  createTileInput,
  loadPhoto,
  MAX_INFERENCE_TILES,
  planInpaintTiles,
  type PhotoAsset,
  type TileInput,
} from "@/lib/image-processing";

type Tool = "brush" | "eraser" | "pan";
type WorkspaceMode = "edit" | "compare";
type ProcessingPhase = "download" | "prepare" | "inference" | "export";
type Provider = "webgpu" | "wasm" | null;

interface MaskState {
  hasMask: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

interface ProcessingState {
  phase: ProcessingPhase;
  message: string;
  progress: number | null;
  tileIndex: number;
  tileCount: number;
}

interface InpaintWorkerProgress {
  type: "progress";
  requestId: number;
  phase: "download" | "prepare" | "inference";
  message: string;
  progress: number | null;
  tileIndex?: number;
  tileCount?: number;
  provider?: Provider;
}

interface InpaintWorkerResult {
  type: "result";
  requestId: number;
  outputRgb: Uint8Array;
  provider: Provider;
}

interface InpaintWorkerError {
  type: "error";
  requestId: number;
  message: string;
}

type InpaintWorkerMessage = InpaintWorkerProgress | InpaintWorkerResult | InpaintWorkerError;

interface PendingRequest {
  resolve: (result: InpaintWorkerResult) => void;
  reject: (error: Error) => void;
}

const initialProcessingState: ProcessingState = {
  phase: "prepare",
  message: "Getting the private AI engine ready…",
  progress: null,
  tileIndex: 0,
  tileCount: 0,
};

function getFriendlyProcessingError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const lowerMessage = message.toLowerCase();

  if (
    lowerMessage.includes("memory")
    || lowerMessage.includes("allocation")
    || lowerMessage.includes("out of memory")
    || lowerMessage.includes("rangeerror")
  ) {
    return "Your device may not have enough memory to process this photo. Try a smaller image or close other tabs and try again.";
  }

  if (
    lowerMessage.includes("download")
    || lowerMessage.includes("fetch")
    || lowerMessage.includes("network")
    || lowerMessage.includes("incomplete")
    || lowerMessage.includes("unexpected file size")
  ) {
    return "The AI model could not be downloaded. Check your internet connection and try again. Your photo was not uploaded.";
  }

  if (lowerMessage.includes("worker") || lowerMessage.includes("unsupported")) {
    return "This browser does not have the local processing features Still needs. Try a recent version of Chrome, Edge, or Safari.";
  }

  if (lowerMessage.includes("large selection")) {
    return "That selection is too large for one pass on this device. Remove it in a few smaller sections instead.";
  }

  return "The object could not be removed this time. Your original photo is unchanged—try a smaller selection or a smaller image.";
}

function getBaseName(fileName: string): string {
  const name = fileName.replace(/\.[^/.]+$/, "").trim();
  return name || "photo";
}

export function PhotoEditor() {
  const [photo, setPhoto] = useState<PhotoAsset | null>(null);
  const [mode, setMode] = useState<WorkspaceMode>("edit");
  const [tool, setTool] = useState<Tool>("brush");
  const [brushSize, setBrushSize] = useState(48);
  const [showMask, setShowMask] = useState(true);
  const [maskState, setMaskState] = useState<MaskState>({ hasMask: false, canUndo: false, canRedo: false });
  const [isLoadingPhoto, setIsLoadingPhoto] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingState, setProcessingState] = useState(initialProcessingState);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [processingError, setProcessingError] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [downloadName, setDownloadName] = useState("cleaned-photo.png");
  const [comparePosition, setComparePosition] = useState(50);
  const [provider, setProvider] = useState<Provider>(null);
  const [exportDetails, setExportDetails] = useState<{ width: number; height: number; wasDownscaled: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<EditorStageHandle>(null);
  const workerRef = useRef<Worker | null>(null);
  const pendingRequestsRef = useRef<Map<number, PendingRequest>>(new Map());
  const activeRequestRef = useRef(0);
  const nextRequestIdRef = useRef(1);
  const dragDepthRef = useRef(0);

  const clearResult = useCallback(() => {
    setPreviewUrl(null);
    setDownloadUrl(null);
    setExportDetails(null);
    setProvider(null);
  }, []);

  useEffect(() => {
    if (!photo) return;
    return () => URL.revokeObjectURL(photo.sourceUrl);
  }, [photo]);

  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  useEffect(() => {
    if (!downloadUrl) return;
    return () => URL.revokeObjectURL(downloadUrl);
  }, [downloadUrl]);

  useEffect(() => () => {
    workerRef.current?.terminate();
    for (const request of pendingRequestsRef.current.values()) {
      request.reject(new Error("The image-processing worker stopped."));
    }
    pendingRequestsRef.current.clear();
  }, []);

  const openWorker = useCallback((): Worker => {
    if (workerRef.current) return workerRef.current;
    if (typeof Worker === "undefined") throw new Error("Web Workers are not available in this browser.");

    const worker = new Worker(new URL("../workers/inpaint.worker.ts", import.meta.url), {
      type: "module",
      name: "still-local-inpainting",
    });

    worker.addEventListener("message", (event: MessageEvent<InpaintWorkerMessage>) => {
      const message = event.data;
      if (!message || typeof message.requestId !== "number") return;

      if (message.type === "progress") {
        if (message.provider) setProvider(message.provider);
        if (activeRequestRef.current !== message.requestId) return;

        if (message.phase === "download") {
          setProcessingState({
            phase: "download",
            message: message.message.toLowerCase().includes("cached")
              ? "Loading the cached AI model on this device…"
              : "Downloading the AI model · about 208 MB the first time",
            progress: message.progress,
            tileIndex: 0,
            tileCount: 0,
          });
        } else if (message.phase === "prepare") {
          setProcessingState({
            phase: "prepare",
            message: message.message,
            progress: message.progress,
            tileIndex: 0,
            tileCount: 0,
          });
        } else {
          const currentTile = message.tileIndex ?? 1;
          const totalTiles = message.tileCount ?? 1;
          setProcessingState({
            phase: "inference",
            message: totalTiles > 1
              ? `Rebuilding area ${currentTile} of ${totalTiles} on your device…`
              : "Rebuilding the selected area on your device…",
            progress: Math.round(((currentTile - 1) / totalTiles) * 100),
            tileIndex: currentTile,
            tileCount: totalTiles,
          });
        }
        return;
      }

      const pending = pendingRequestsRef.current.get(message.requestId);
      if (!pending) return;
      pendingRequestsRef.current.delete(message.requestId);

      if (message.type === "result") {
        if (message.provider) setProvider(message.provider);
        pending.resolve(message);
      } else {
        pending.reject(new Error(message.message));
      }
    });

    worker.addEventListener("error", (event) => {
      const error = new Error(event.message || "The local processing worker failed.");
      for (const pending of pendingRequestsRef.current.values()) pending.reject(error);
      pendingRequestsRef.current.clear();
      workerRef.current?.terminate();
      workerRef.current = null;
    });

    workerRef.current = worker;
    return worker;
  }, []);

  const runTile = useCallback((
    input: TileInput,
    tileIndex: number,
    tileCount: number,
  ): Promise<InpaintWorkerResult> => {
    const worker = openWorker();
    const requestId = nextRequestIdRef.current++;
    activeRequestRef.current = requestId;

    return new Promise((resolve, reject) => {
      pendingRequestsRef.current.set(requestId, { resolve, reject });
      try {
        worker.postMessage(
          {
            type: "inpaint",
            requestId,
            tileIndex,
            tileCount,
            imageTensor: input.imageTensor,
            maskTensor: input.maskTensor,
          },
          [input.imageTensor.buffer, input.maskTensor.buffer],
        );
      } catch (error) {
        pendingRequestsRef.current.delete(requestId);
        reject(error instanceof Error ? error : new Error("Could not send image data to the local worker."));
      }
    });
  }, [openWorker]);

  const handleSelectPhoto = useCallback(async (file?: File) => {
    if (!file) return;
    setUploadError(null);
    setProcessingError(null);
    setIsLoadingPhoto(true);

    try {
      const loadedPhoto = await loadPhoto(file);
      clearResult();
      setPhoto(loadedPhoto);
      setMode("edit");
      setTool("brush");
      setMaskState({ hasMask: false, canUndo: false, canRedo: false });
      setBrushSize(48);
      setShowMask(true);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "This image could not be opened.");
    } finally {
      setIsLoadingPhoto(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }, [clearResult]);

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    void handleSelectPhoto(file);
  };

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (photo || isLoadingPhoto || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDropActive(true);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (photo || isLoadingPhoto || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (photo) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDropActive(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (photo) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDropActive(false);
    void handleSelectPhoto(event.dataTransfer.files?.[0]);
  };

  const handleRemove = async () => {
    if (!photo || !maskState.hasMask || isProcessing) return;
    setProcessingError(null);
    clearResult();
    setMode("edit");
    setIsProcessing(true);
    setProcessingState(initialProcessingState);

    try {
      const maskCanvas = stageRef.current?.getMaskCanvas();
      const sourceContext = photo.workingCanvas.getContext("2d", { willReadFrequently: true });
      const maskContext = maskCanvas?.getContext("2d", { willReadFrequently: true });
      if (!maskCanvas || !sourceContext || !maskContext) {
        throw new Error("The browser could not access the image workspace.");
      }

      if (typeof HTMLCanvasElement === "undefined" || !HTMLCanvasElement.prototype.toBlob) {
        throw new Error("This browser does not support image export.");
      }

      const maskPixels = maskContext.getImageData(0, 0, photo.workingWidth, photo.workingHeight).data;
      const { tiles, snapshot } = planInpaintTiles(maskPixels, photo.workingWidth, photo.workingHeight);
      if (!snapshot.hasMask || tiles.length === 0) {
        throw new Error("Paint over the object you want to remove first.");
      }
      if (tiles.length > MAX_INFERENCE_TILES) {
        throw new Error("This is a large selection. Split it into a few smaller areas so your device can process it safely.");
      }

      setProcessingState({
        phase: "prepare",
        message: tiles.length > 1
          ? `Preparing ${tiles.length} overlapping image areas for inpainting…`
          : "Preparing the marked area for inpainting…",
        progress: null,
        tileIndex: 0,
        tileCount: tiles.length,
      });

      const overlayCanvas = document.createElement("canvas");
      overlayCanvas.width = photo.workingWidth;
      overlayCanvas.height = photo.workingHeight;
      const overlayContext = overlayCanvas.getContext("2d");
      if (!overlayContext) throw new Error("The browser could not create a result layer.");

      for (let index = 0; index < tiles.length; index += 1) {
        const tile = tiles[index];
        const tileInput = createTileInput(photo.workingCanvas, maskCanvas, tile);
        const result = await runTile(tileInput, index + 1, tiles.length);
        addTileOutputToOverlay(
          overlayCanvas,
          result.outputRgb,
          tileInput.maskAlpha,
          tile,
          photo.workingWidth,
          photo.workingHeight,
        );
        setProcessingState({
          phase: "inference",
          message: tiles.length > 1
            ? `Filled area ${index + 1} of ${tiles.length} · still running locally…`
            : "The selected area is filled · preparing your result…",
          progress: Math.round(((index + 1) / tiles.length) * 100),
          tileIndex: index + 1,
          tileCount: tiles.length,
        });
      }

      setProcessingState({
        phase: "export",
        message: "Compositing a full-quality download in your browser…",
        progress: null,
        tileIndex: tiles.length,
        tileCount: tiles.length,
      });

      const output = await createOutputBlobs(photo, overlayCanvas);
      const nextPreviewUrl = URL.createObjectURL(output.previewBlob);
      const nextDownloadUrl = URL.createObjectURL(output.exportBlob);
      setPreviewUrl(nextPreviewUrl);
      setDownloadUrl(nextDownloadUrl);
      setDownloadName(`${getBaseName(photo.fileName)}-cleaned.png`);
      setExportDetails({
        width: output.exportWidth,
        height: output.exportHeight,
        wasDownscaled: output.wasDownscaled,
      });
      setComparePosition(50);
      setMode("compare");
    } catch (error) {
      setProcessingError(getFriendlyProcessingError(error));
    } finally {
      setIsProcessing(false);
    }
  };

  const handleStartOver = () => {
    if (isProcessing) return;
    setPhoto(null);
    setMode("edit");
    setTool("brush");
    setMaskState({ hasMask: false, canUndo: false, canRedo: false });
    setProcessingError(null);
    setUploadError(null);
    clearResult();
    if (inputRef.current) inputRef.current.value = "";
  };

  const handleEditMask = () => {
    if (isProcessing) return;
    setProcessingError(null);
    setMode("edit");
  };

  const imageDetails = photo
    ? `${photo.originalWidth.toLocaleString()} × ${photo.originalHeight.toLocaleString()} px`
    : "";
  const backendLabel = provider === "webgpu"
    ? "WebGPU accelerated"
    : provider === "wasm"
      ? "WASM · on-device"
      : "On-device AI";

  return (
    <div
      className="app-shell"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <header className="app-header">
        <div className="header-inner">
          <a
            href="/"
            className="brand-lockup"
            aria-label="Still, return to the start"
            onClick={(event) => {
              if (photo && !isProcessing) {
                event.preventDefault();
                handleStartOver();
              }
            }}
          >
            <span className="brand-mark"><span className="brand-name" style={{ color: "#fffaf3", fontSize: 19, lineHeight: 1 }}>s</span></span>
            <span className="brand-name">still</span>
            <span className="brand-caption">private image studio</span>
          </a>
          <div className="privacy-chip" aria-label="Your photo stays on this device">
            <Icon name="lock" size={14} />
            <span>Private by design</span>
          </div>
        </div>
      </header>

      <main className="page-content">
        {!photo ? (
          <section className="upload-page" aria-labelledby="upload-title">
            <div className="upload-intro">
              <div className="eyebrow"><span className="eyebrow-dot" /> Personal image tool</div>
              <h1 className="upload-title" id="upload-title">Make the unwanted <em>disappear.</em></h1>
              <p className="upload-description">
                Brush over people, objects, and distractions. Local AI rebuilds what was behind them—right in your browser.
              </p>
            </div>

            <div className="upload-card">
              <div
                className={`dropzone ${dropActive ? "is-active" : ""}`}
                role="region"
                aria-label="Upload an image"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    inputRef.current?.click();
                  }
                }}
                onClick={(event) => {
                  if (isLoadingPhoto || (event.target as HTMLElement).closest("button, label")) return;
                  inputRef.current?.click();
                }}
              >
                <span className="upload-icon-wrap"><Icon name="upload" size={25} strokeWidth={1.65} /></span>
                <h2 className="dropzone-title">{isLoadingPhoto ? "Opening your image…" : "Start with a photo"}</h2>
                <p className="dropzone-copy">Drop an image here, or choose one from your device</p>
                <button
                  className="primary-button"
                  type="button"
                  disabled={isLoadingPhoto}
                  onClick={() => inputRef.current?.click()}
                >
                  {isLoadingPhoto ? <span className="spinner" aria-hidden="true" /> : <Icon name="image" size={17} />}
                  {isLoadingPhoto ? "Opening image…" : "Choose an image"}
                </button>
                <div className="format-note">
                  <strong>JPG</strong><span>·</span><strong>PNG</strong><span>·</span><strong>WebP</strong><span>·</span><span>up to 50 MB</span>
                </div>
              </div>
            </div>

            {uploadError && (
              <div className="upload-error" role="alert">
                <Icon name="alert" size={17} />
                <span>{uploadError}</span>
              </div>
            )}

            <div className="private-note">
              <Icon name="shield-check" size={17} />
              <span>
                <strong>Your photo never leaves this browser.</strong> The AI model (about 208 MB) downloads from a public model host; only model weights—not your image—use the network.
              </span>
            </div>

            <div className="upload-steps" aria-label="How it works">
              <div className="upload-step"><span className="step-number">1</span><span>Upload</span></div>
              <div className="upload-step"><span className="step-number">2</span><span>Mark an object</span></div>
              <div className="upload-step"><span className="step-number">3</span><span>Save your result</span></div>
            </div>

            <input
              ref={inputRef}
              className="hidden-input"
              type="file"
              accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
              aria-label="Choose a JPG, PNG, or WebP image"
              onChange={handleInputChange}
            />
          </section>
        ) : (
          <section className="editor-page" aria-label="Photo object remover">
            {uploadError && (
              <div className="error-banner" role="alert">
                <Icon name="alert" size={16} />
                <span>{uploadError}</span>
              </div>
            )}
            <div className="editor-topline">
              <div className="editor-fileline">
                <span className="file-thumb"><img src={photo.sourceUrl} alt="" /></span>
                <div className="file-meta">
                  <p className="file-name" title={photo.fileName}>{photo.fileName}</p>
                  <p className="file-dimensions">{imageDetails}</p>
                </div>
              </div>
              <div className="topline-actions">
                {mode === "compare" && (
                  <button className="secondary-button" type="button" onClick={handleEditMask}>
                    <Icon name="brush" size={15} /> Edit mask
                  </button>
                )}
                <button
                  className="secondary-button"
                  type="button"
                  disabled={isProcessing || isLoadingPhoto}
                  onClick={() => inputRef.current?.click()}
                >
                  <Icon name="replace" size={15} />
                  <span>Replace</span>
                </button>
              </div>
            </div>

            <div className="steps-bar" aria-label="Editing steps">
              <div className="editor-step is-complete"><span className="step-number"><Icon name="check" size={13} /></span><span>Upload</span></div>
              <span className="step-connector" />
              <div className={`editor-step ${mode === "edit" ? "is-current" : "is-complete"}`}>
                <span className="step-number">{mode === "compare" ? <Icon name="check" size={13} /> : "2"}</span><span>Select</span>
              </div>
              <span className="step-connector" />
              <div className={`editor-step ${mode === "compare" ? "is-current" : ""}`}><span className="step-number">3</span><span>Result</span></div>
            </div>

            <div className="editor-heading-row">
              <div>
                <h1 className="editor-heading">{mode === "compare" ? "A little more room to breathe." : "What should disappear?"}</h1>
                <p className="editor-subheading">
                  {mode === "compare"
                    ? "Drag across the image to compare your original with the inpainted result."
                    : "Paint over the whole object, including its shadow, for a cleaner fill."}
                </p>
              </div>
              <div className="model-chip"><span className="model-chip-dot" />{backendLabel}</div>
            </div>

            <div className="workspace-grid">
              <section className="editor-canvas-panel" aria-label="Image canvas">
                <div className="canvas-toolbar">
                  <div className="canvas-toolbar-left">
                    <span className="toolbar-label">{mode === "compare" ? "Before / after" : "Selection mask"}</span>
                  </div>
                  <div className="canvas-toolbar-right">
                    {mode === "edit" && (
                      <>
                        <button
                          className="icon-button compact"
                          type="button"
                          aria-label="Undo last mask stroke"
                          title="Undo · Ctrl/⌘ Z"
                          disabled={!maskState.canUndo || isProcessing}
                          onClick={() => stageRef.current?.undo()}
                        >
                          <Icon name="undo" size={16} />
                        </button>
                        <button
                          className="icon-button compact"
                          type="button"
                          aria-label="Redo mask stroke"
                          title="Redo · Ctrl/⌘ Shift Z"
                          disabled={!maskState.canRedo || isProcessing}
                          onClick={() => stageRef.current?.redo()}
                        >
                          <Icon name="redo" size={16} />
                        </button>
                        <span className="toolbar-separator" />
                        <button
                          className={`icon-button compact ${showMask ? "is-selected" : ""}`}
                          type="button"
                          aria-label={showMask ? "Hide mask preview" : "Show mask preview"}
                          aria-pressed={showMask}
                          disabled={isProcessing}
                          onClick={() => setShowMask((visible) => !visible)}
                        >
                          <Icon name={showMask ? "eye" : "eye-off"} size={16} />
                        </button>
                      </>
                    )}
                    {mode === "compare" && exportDetails && (
                      <span className="toolbar-label">{exportDetails.width.toLocaleString()} × {exportDetails.height.toLocaleString()} px</span>
                    )}
                  </div>
                </div>

                <EditorStage
                  ref={stageRef}
                  photo={photo}
                  tool={tool}
                  brushSize={brushSize}
                  showMask={showMask}
                  mode={mode}
                  resultUrl={previewUrl}
                  comparePosition={comparePosition}
                  onComparePositionChange={setComparePosition}
                  onToolChange={setTool}
                  onMaskStateChange={setMaskState}
                  isProcessing={isProcessing}
                  processingState={processingState}
                />
              </section>

              {mode === "edit" ? (
                <aside className="tools-panel" aria-label="Mask and inpainting controls">
                  <div className="panel-heading-row">
                    <span className="panel-icon"><Icon name="wand" size={19} /></span>
                    <div>
                      <h2 className="panel-heading">Paint your selection</h2>
                      <p className="panel-description">LaMa sees a small crop for context. It runs locally, never on a server.</p>
                    </div>
                  </div>

                  <div className="panel-divider" />

                  <div className="tool-label-row"><span>Tool</span><span className="subtle-value">{tool === "pan" ? "Move canvas" : "Mask"}</span></div>
                  <div className="tool-switcher" role="group" aria-label="Mask tool">
                    <button
                      className={`tool-button ${tool === "brush" ? "is-active" : ""}`}
                      type="button"
                      aria-pressed={tool === "brush"}
                      disabled={isProcessing}
                      onClick={() => setTool("brush")}
                    >
                      <Icon name="brush" size={16} /> Brush
                    </button>
                    <button
                      className={`tool-button ${tool === "eraser" ? "is-active" : ""}`}
                      type="button"
                      aria-pressed={tool === "eraser"}
                      disabled={isProcessing}
                      onClick={() => setTool("eraser")}
                    >
                      <Icon name="eraser" size={16} /> Eraser
                    </button>
                  </div>

                  <div style={{ marginTop: 19 }}>
                    <div className="control-label-row">
                      <label htmlFor="brush-size">Brush size</label>
                      <span className="subtle-value">{brushSize} px</span>
                    </div>
                    <input
                      id="brush-size"
                      className="range-control"
                      type="range"
                      min="12"
                      max="180"
                      step="2"
                      value={brushSize}
                      disabled={isProcessing || tool === "pan"}
                      onChange={(event) => setBrushSize(Number(event.target.value))}
                    />
                    <div className="range-ends"><span>Fine</span><span>Broad</span></div>
                  </div>

                  <div className="panel-divider" />

                  <div className="mask-toggle-row">
                    <span>Preview mask</span>
                    <button
                      className="toggle-switch"
                      type="button"
                      role="switch"
                      aria-checked={showMask}
                      aria-label="Preview mask"
                      disabled={isProcessing}
                      onClick={() => setShowMask((visible) => !visible)}
                    >
                      <span className="toggle-knob" />
                    </button>
                  </div>

                  <div className="tip-card">
                    <Icon name="info" size={15} />
                    <span>Cover the object fully. A little extra around the edge helps avoid leftover outlines.</span>
                  </div>

                  {processingError && (
                    <div className="error-banner" role="alert" style={{ marginTop: 13, marginBottom: 0 }}>
                      <Icon name="alert" size={16} />
                      <span>{processingError}</span>
                    </div>
                  )}

                  <div className="panel-actions">
                    <button
                      className="primary-button remove-button"
                      type="button"
                      disabled={!maskState.hasMask || isProcessing}
                      onClick={() => void handleRemove()}
                    >
                      {isProcessing ? <span className="spinner" aria-hidden="true" /> : <Icon name="sparkles" size={17} />}
                      {isProcessing ? "Working locally…" : "Remove object"}
                    </button>
                    <div className="clear-mask-row">
                      <span className="subtle-value">{maskState.hasMask ? "Selection ready" : "Paint to make a selection"}</span>
                      <button
                        className="tertiary-button"
                        type="button"
                        disabled={!maskState.hasMask || isProcessing}
                        onClick={() => stageRef.current?.clearMask()}
                      >
                        Clear mask
                      </button>
                    </div>
                    <p className="remove-hint">
                      First use downloads <strong>LaMa AI · ≈208 MB</strong>. The browser caches it when storage allows.
                    </p>
                  </div>
                </aside>
              ) : (
                <aside className="result-panel" aria-label="Download result">
                  <span className="result-success-icon"><Icon name="check-circle" size={20} /></span>
                  <h2 className="result-title">Object removed</h2>
                  <p className="result-copy">Compare the fill against the original, then save a clean PNG to your device.</p>
                  <ul className="result-detail-list">
                    <li><Icon name="check" size={14} /> AI inpainting ran in this browser</li>
                    <li><Icon name="check" size={14} /> Original pixels kept outside the mask</li>
                    <li><Icon name="check" size={14} /> {provider === "webgpu" ? "WebGPU accelerated" : "WebAssembly fallback"}</li>
                    {exportDetails && (
                      <li><Icon name="image" size={14} />
                        {exportDetails.wasDownscaled
                          ? `Safe export · ${exportDetails.width.toLocaleString()} × ${exportDetails.height.toLocaleString()} px`
                          : `Full resolution · ${exportDetails.width.toLocaleString()} × ${exportDetails.height.toLocaleString()} px`}
                      </li>
                    )}
                  </ul>
                  {downloadUrl && (
                    <a className="primary-button download-button" href={downloadUrl} download={downloadName}>
                      <Icon name="download" size={17} /> Download PNG
                    </a>
                  )}
                  <button className="secondary-button result-edit-button" type="button" onClick={handleEditMask}>
                    <Icon name="brush" size={15} /> Refine selection
                  </button>
                  <button className="tertiary-button result-edit-button" type="button" onClick={handleStartOver}>
                    Start with another image
                  </button>
                  <p className="result-privacy-note"><Icon name="lock" size={13} />This result exists only in this tab until you download it.</p>
                </aside>
              )}
            </div>

            <div className="footer-note">
              <Icon name="shield-check" size={14} />
              <span>Your image is processed locally. No login, upload, or image storage.</span>
            </div>

            <input
              ref={inputRef}
              className="hidden-input"
              type="file"
              accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
              aria-label="Choose a JPG, PNG, or WebP image"
              onChange={handleInputChange}
            />
          </section>
        )}
      </main>
    </div>
  );
}
