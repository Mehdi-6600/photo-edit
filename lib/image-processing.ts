export const MODEL_INPUT_SIZE = 512;
export const MAX_WORKING_DIMENSION = 2048;
export const MAX_IMAGE_PIXELS = 55_000_000;
export const MAX_EXPORT_PIXELS = 24_000_000;
export const MAX_EXPORT_DIMENSION = 6000;
export const MAX_INFERENCE_TILES = 25;

const TILE_CONTEXT = 64;
const TILE_STRIDE = 384;
const MASK_THRESHOLD = 32;
const MODEL_MASK_THRESHOLD = 24;
const MODEL_PIXELS = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;

export interface PhotoAsset {
  sourceUrl: string;
  fileName: string;
  imageElement: HTMLImageElement;
  originalWidth: number;
  originalHeight: number;
  workingWidth: number;
  workingHeight: number;
  workingCanvas: HTMLCanvasElement;
}

export interface MaskSnapshot {
  hasMask: boolean;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  pixelCount: number;
}

interface TileRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface InpaintTile {
  kind: "crop" | "fit";
  x: number;
  y: number;
  commit: TileRect;
  offsetX: number;
  offsetY: number;
  contentWidth: number;
  contentHeight: number;
}

export interface TileInput {
  imageTensor: Float32Array;
  maskTensor: Float32Array;
  maskAlpha: Uint8Array;
}

export interface OutputBlobs {
  previewBlob: Blob;
  exportBlob: Blob;
  exportWidth: number;
  exportHeight: number;
  wasDownscaled: boolean;
}

const acceptedExtensions = new Set(["jpg", "jpeg", "png", "webp"]);
const acceptedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function loadPhoto(file: File): Promise<PhotoAsset> {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!acceptedExtensions.has(extension) && !acceptedMimeTypes.has(file.type)) {
    throw new Error("Choose a JPG, PNG, or WebP image to get started.");
  }

  if (file.size > 50 * 1024 * 1024) {
    throw new Error("This file is over 50 MB. Please choose a smaller image to protect your device’s memory.");
  }

  const sourceUrl = URL.createObjectURL(file);
  const imageElement = new Image();
  imageElement.decoding = "async";
  imageElement.src = sourceUrl;

  try {
    await imageElement.decode();
  } catch {
    URL.revokeObjectURL(sourceUrl);
    throw new Error("This image could not be opened. Try saving it as a JPG, PNG, or WebP and upload it again.");
  }

  const originalWidth = imageElement.naturalWidth;
  const originalHeight = imageElement.naturalHeight;
  const totalPixels = originalWidth * originalHeight;

  if (!originalWidth || !originalHeight || totalPixels > MAX_IMAGE_PIXELS) {
    URL.revokeObjectURL(sourceUrl);
    throw new Error("This image is too large to open safely. Resize it to under 55 megapixels and try again.");
  }

  const scale = Math.min(1, MAX_WORKING_DIMENSION / Math.max(originalWidth, originalHeight));
  const workingWidth = Math.max(1, Math.round(originalWidth * scale));
  const workingHeight = Math.max(1, Math.round(originalHeight * scale));
  const workingCanvas = document.createElement("canvas");
  workingCanvas.width = workingWidth;
  workingCanvas.height = workingHeight;

  const context = workingCanvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    URL.revokeObjectURL(sourceUrl);
    throw new Error("This browser could not create an image workspace. Try a newer browser or a smaller image.");
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(imageElement, 0, 0, workingWidth, workingHeight);

  return {
    sourceUrl,
    fileName: file.name || "photo",
    imageElement,
    originalWidth,
    originalHeight,
    workingWidth,
    workingHeight,
    workingCanvas,
  };
}

export function getMaskSnapshot(
  maskPixels: Uint8ClampedArray,
  width: number,
  height: number,
): MaskSnapshot {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let pixelCount = 0;

  for (let y = 0; y < height; y += 1) {
    let index = (y * width) * 4 + 3;
    for (let x = 0; x < width; x += 1, index += 4) {
      if (maskPixels[index] <= MASK_THRESHOLD) continue;
      pixelCount += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (pixelCount === 0) {
    return { hasMask: false, minX: 0, minY: 0, maxX: 0, maxY: 0, pixelCount: 0 };
  }

  return { hasMask: true, minX, minY, maxX, maxY, pixelCount };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function startsForRange(min: number, max: number, dimension: number): number[] {
  const maxStart = dimension - MODEL_INPUT_SIZE;
  const rangeSize = max - min + 1;

  if (rangeSize <= MODEL_INPUT_SIZE - TILE_CONTEXT * 2) {
    const centered = clamp((min + max + 1) / 2 - MODEL_INPUT_SIZE / 2, 0, maxStart);
    return [Math.round(centered)];
  }

  const first = Math.round(clamp(min - TILE_CONTEXT, 0, maxStart));
  const last = Math.round(clamp(max + TILE_CONTEXT + 1 - MODEL_INPUT_SIZE, 0, maxStart));
  const starts = [first];

  while (starts[starts.length - 1] + TILE_STRIDE < last) {
    starts.push(starts[starts.length - 1] + TILE_STRIDE);
  }

  if (last > starts[starts.length - 1]) starts.push(last);
  return starts;
}

function commitBounds(starts: number[], index: number): { start: number; end: number } {
  const current = starts[index];
  const start = index === 0
    ? 0
    : Math.floor((starts[index - 1] + MODEL_INPUT_SIZE + current) / 2) - current;
  const end = index === starts.length - 1
    ? MODEL_INPUT_SIZE
    : Math.floor((current + MODEL_INPUT_SIZE + starts[index + 1]) / 2) - current;

  return {
    start: clamp(start, 0, MODEL_INPUT_SIZE),
    end: clamp(end, 0, MODEL_INPUT_SIZE),
  };
}

function tileHasSelection(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
): boolean {
  const endX = Math.min(width, x + MODEL_INPUT_SIZE);
  const endY = Math.min(height, y + MODEL_INPUT_SIZE);

  for (let row = y; row < endY; row += 1) {
    let index = (row * width + x) * 4 + 3;
    for (let column = x; column < endX; column += 1, index += 4) {
      if (pixels[index] > MASK_THRESHOLD) return true;
    }
  }

  return false;
}

export function planInpaintTiles(
  maskPixels: Uint8ClampedArray,
  width: number,
  height: number,
): { tiles: InpaintTile[]; snapshot: MaskSnapshot } {
  const snapshot = getMaskSnapshot(maskPixels, width, height);
  if (!snapshot.hasMask) return { tiles: [], snapshot };

  if (width < MODEL_INPUT_SIZE || height < MODEL_INPUT_SIZE) {
    const scale = MODEL_INPUT_SIZE / Math.max(width, height);
    const contentWidth = width * scale;
    const contentHeight = height * scale;
    const offsetX = (MODEL_INPUT_SIZE - contentWidth) / 2;
    const offsetY = (MODEL_INPUT_SIZE - contentHeight) / 2;

    return {
      snapshot,
      tiles: [{
        kind: "fit",
        x: 0,
        y: 0,
        commit: { left: 0, top: 0, right: MODEL_INPUT_SIZE, bottom: MODEL_INPUT_SIZE },
        offsetX,
        offsetY,
        contentWidth,
        contentHeight,
      }],
    };
  }

  const xStarts = startsForRange(snapshot.minX, snapshot.maxX, width);
  const yStarts = startsForRange(snapshot.minY, snapshot.maxY, height);
  const tiles: InpaintTile[] = [];

  for (let yIndex = 0; yIndex < yStarts.length; yIndex += 1) {
    const y = yStarts[yIndex];
    const vertical = commitBounds(yStarts, yIndex);

    for (let xIndex = 0; xIndex < xStarts.length; xIndex += 1) {
      const x = xStarts[xIndex];
      if (!tileHasSelection(maskPixels, width, height, x, y)) continue;

      const horizontal = commitBounds(xStarts, xIndex);
      tiles.push({
        kind: "crop",
        x,
        y,
        commit: {
          left: horizontal.start,
          top: vertical.start,
          right: horizontal.end,
          bottom: vertical.end,
        },
        offsetX: 0,
        offsetY: 0,
        contentWidth: MODEL_INPUT_SIZE,
        contentHeight: MODEL_INPUT_SIZE,
      });
    }
  }

  return { tiles, snapshot };
}

function makeCanvas(): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = MODEL_INPUT_SIZE;
  canvas.height = MODEL_INPUT_SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Your browser could not create an image-processing canvas.");
  return { canvas, context };
}

export function createTileInput(
  sourceCanvas: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement,
  tile: InpaintTile,
): TileInput {
  const { context: imageContext } = makeCanvas();
  const { context: maskContext } = makeCanvas();

  if (tile.kind === "crop") {
    imageContext.drawImage(
      sourceCanvas,
      tile.x,
      tile.y,
      MODEL_INPUT_SIZE,
      MODEL_INPUT_SIZE,
      0,
      0,
      MODEL_INPUT_SIZE,
      MODEL_INPUT_SIZE,
    );
    maskContext.drawImage(
      maskCanvas,
      tile.x,
      tile.y,
      MODEL_INPUT_SIZE,
      MODEL_INPUT_SIZE,
      0,
      0,
      MODEL_INPUT_SIZE,
      MODEL_INPUT_SIZE,
    );
  } else {
    imageContext.fillStyle = "#777777";
    imageContext.fillRect(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
    imageContext.drawImage(
      sourceCanvas,
      0,
      0,
      sourceCanvas.width,
      sourceCanvas.height,
      tile.offsetX,
      tile.offsetY,
      tile.contentWidth,
      tile.contentHeight,
    );
    maskContext.drawImage(
      maskCanvas,
      0,
      0,
      maskCanvas.width,
      maskCanvas.height,
      tile.offsetX,
      tile.offsetY,
      tile.contentWidth,
      tile.contentHeight,
    );
  }

  const imageData = imageContext.getImageData(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE).data;
  const maskData = maskContext.getImageData(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE).data;
  const imageTensor = new Float32Array(3 * MODEL_PIXELS);
  const maskTensor = new Float32Array(MODEL_PIXELS);
  const maskAlpha = new Uint8Array(MODEL_PIXELS);

  for (let pixel = 0; pixel < MODEL_PIXELS; pixel += 1) {
    const rgbaIndex = pixel * 4;
    imageTensor[pixel] = imageData[rgbaIndex] / 255;
    imageTensor[MODEL_PIXELS + pixel] = imageData[rgbaIndex + 1] / 255;
    imageTensor[MODEL_PIXELS * 2 + pixel] = imageData[rgbaIndex + 2] / 255;

    const alpha = maskData[rgbaIndex + 3];
    maskAlpha[pixel] = alpha;
    maskTensor[pixel] = alpha > MODEL_MASK_THRESHOLD ? 1 : 0;
  }

  return { imageTensor, maskTensor, maskAlpha };
}

export function addTileOutputToOverlay(
  overlayCanvas: HTMLCanvasElement,
  outputRgb: Uint8Array,
  maskAlpha: Uint8Array,
  tile: InpaintTile,
  workingWidth: number,
  workingHeight: number,
): void {
  const { canvas: tileCanvas, context } = makeCanvas();
  const tilePixels = context.createImageData(MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);

  for (let y = 0; y < MODEL_INPUT_SIZE; y += 1) {
    for (let x = 0; x < MODEL_INPUT_SIZE; x += 1) {
      const pixel = y * MODEL_INPUT_SIZE + x;
      const rgbaIndex = pixel * 4;
      const inCommitRect = tile.kind === "fit"
        || (x >= tile.commit.left && x < tile.commit.right && y >= tile.commit.top && y < tile.commit.bottom);
      const alpha = inCommitRect ? maskAlpha[pixel] : 0;

      tilePixels.data[rgbaIndex] = outputRgb[pixel * 3];
      tilePixels.data[rgbaIndex + 1] = outputRgb[pixel * 3 + 1];
      tilePixels.data[rgbaIndex + 2] = outputRgb[pixel * 3 + 2];
      tilePixels.data[rgbaIndex + 3] = alpha;
    }
  }

  context.putImageData(tilePixels, 0, 0);
  const overlayContext = overlayCanvas.getContext("2d");
  if (!overlayContext) throw new Error("Your browser could not create the result layer.");

  if (tile.kind === "fit") {
    overlayContext.drawImage(
      tileCanvas,
      tile.offsetX,
      tile.offsetY,
      tile.contentWidth,
      tile.contentHeight,
      0,
      0,
      workingWidth,
      workingHeight,
    );
  } else {
    overlayContext.drawImage(tileCanvas, tile.x, tile.y);
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("The browser could not export this image. Try a smaller photo."));
    }, type);
  });
}

export async function createOutputBlobs(
  photo: PhotoAsset,
  overlayCanvas: HTMLCanvasElement,
): Promise<OutputBlobs> {
  const previewCanvas = document.createElement("canvas");
  previewCanvas.width = photo.workingWidth;
  previewCanvas.height = photo.workingHeight;
  const previewContext = previewCanvas.getContext("2d");
  if (!previewContext) throw new Error("Your browser could not prepare a result preview.");

  previewContext.drawImage(photo.workingCanvas, 0, 0);
  previewContext.drawImage(overlayCanvas, 0, 0);
  const previewBlob = await canvasToBlob(previewCanvas, "image/png");

  const originalPixels = photo.originalWidth * photo.originalHeight;
  const exportScale = Math.min(
    1,
    MAX_EXPORT_DIMENSION / Math.max(photo.originalWidth, photo.originalHeight),
    Math.sqrt(MAX_EXPORT_PIXELS / originalPixels),
  );
  const exportWidth = Math.max(1, Math.round(photo.originalWidth * exportScale));
  const exportHeight = Math.max(1, Math.round(photo.originalHeight * exportScale));
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = exportWidth;
  exportCanvas.height = exportHeight;

  const exportContext = exportCanvas.getContext("2d");
  if (!exportContext) throw new Error("Your browser ran out of memory while preparing the download.");

  exportContext.imageSmoothingEnabled = true;
  exportContext.imageSmoothingQuality = "high";
  exportContext.drawImage(photo.imageElement, 0, 0, exportWidth, exportHeight);
  exportContext.drawImage(
    overlayCanvas,
    0,
    0,
    photo.workingWidth,
    photo.workingHeight,
    0,
    0,
    exportWidth,
    exportHeight,
  );

  const exportBlob = await canvasToBlob(exportCanvas, "image/png");
  return {
    previewBlob,
    exportBlob,
    exportWidth,
    exportHeight,
    wasDownscaled: exportWidth !== photo.originalWidth || exportHeight !== photo.originalHeight,
  };
}
