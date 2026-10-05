"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Icon } from "@/components/ui-icons";
import type { PhotoAsset } from "@/lib/image-processing";

type Tool = "brush" | "eraser" | "pan";
type MaskAction =
  | { type: "stroke"; mode: "brush" | "eraser"; radius: number; points: Point[] }
  | { type: "clear" };

interface Point {
  x: number;
  y: number;
}

interface ActiveStroke extends Extract<MaskAction, { type: "stroke" }> {
  pointerId: number;
}

interface MaskState {
  hasMask: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

interface ProcessingState {
  phase: "download" | "prepare" | "inference" | "export";
  message: string;
  progress: number | null;
  tileIndex: number;
  tileCount: number;
}

export interface EditorStageHandle {
  getMaskCanvas: () => HTMLCanvasElement | null;
  undo: () => void;
  redo: () => void;
  clearMask: () => void;
}

interface EditorStageProps {
  photo: PhotoAsset;
  tool: Tool;
  brushSize: number;
  showMask: boolean;
  mode: "edit" | "compare";
  resultUrl: string | null;
  comparePosition: number;
  onComparePositionChange: (value: number) => void;
  onToolChange: (tool: Tool) => void;
  onMaskStateChange: (state: MaskState) => void;
  isProcessing: boolean;
  processingState: ProcessingState;
}

interface PointerPoint {
  x: number;
  y: number;
}

interface PinchGesture {
  distance: number;
  zoom: number;
  midpoint: PointerPoint;
  pan: PointerPoint;
}

interface PanGesture {
  pointerId: number;
  point: PointerPoint;
  pan: PointerPoint;
}

interface CursorState {
  x: number;
  y: number;
  size: number;
  visible: boolean;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pointDistance(a: PointerPoint, b: PointerPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function getMidpoint(a: PointerPoint, b: PointerPoint): PointerPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export const EditorStage = forwardRef<EditorStageHandle, EditorStageProps>(function EditorStage(
  {
    photo,
    tool,
    brushSize,
    showMask,
    mode,
    resultUrl,
    comparePosition,
    onComparePositionChange,
    onToolChange,
    onMaskStateChange,
    isProcessing,
    processingState,
  },
  ref,
) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageCanvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const actionsRef = useRef<MaskAction[]>([]);
  const actionIndexRef = useRef(0);
  const activeStrokeRef = useRef<ActiveStroke | null>(null);
  const pointersRef = useRef<Map<number, PointerPoint>>(new Map());
  const pinchRef = useRef<PinchGesture | null>(null);
  const panRef = useRef<PanGesture | null>(null);
  const compareDraggingRef = useRef(false);
  const spaceDownRef = useRef(false);
  const zoomRef = useRef(1);
  const panOffsetRef = useRef<PointerPoint>({ x: 0, y: 0 });
  const toolRef = useRef(tool);
  const brushSizeRef = useRef(brushSize);
  const maskCallbackRef = useRef(onMaskStateChange);
  const [fitSize, setFitSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState<PointerPoint>({ x: 0, y: 0 });
  const [cursor, setCursor] = useState<CursorState>({ x: 0, y: 0, size: 0, visible: false });

  toolRef.current = tool;
  brushSizeRef.current = brushSize;
  maskCallbackRef.current = onMaskStateChange;

  const updateMaskState = useCallback(() => {
    const canvas = maskCanvasRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    let hasMask = false;

    if (canvas && context) {
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let index = 3; index < pixels.length; index += 4) {
        if (pixels[index] > 32) {
          hasMask = true;
          break;
        }
      }
    }

    maskCallbackRef.current({
      hasMask,
      canUndo: actionIndexRef.current > 0,
      canRedo: actionIndexRef.current < actionsRef.current.length,
    });
  }, []);

  const redrawHistory = useCallback((targetIndex: number) => {
    const canvas = maskCanvasRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !context) return;

    context.clearRect(0, 0, canvas.width, canvas.height);
    const actions = actionsRef.current.slice(0, targetIndex);

    for (const action of actions) {
      if (action.type === "clear") {
        context.clearRect(0, 0, canvas.width, canvas.height);
        continue;
      }

      context.save();
      context.globalCompositeOperation = action.mode === "eraser" ? "destination-out" : "source-over";
      context.strokeStyle = "#f2765d";
      context.fillStyle = "#f2765d";
      context.lineWidth = action.radius * 2;
      context.lineCap = "round";
      context.lineJoin = "round";

      if (action.points.length === 1) {
        const point = action.points[0];
        context.beginPath();
        context.arc(point.x, point.y, action.radius, 0, Math.PI * 2);
        context.fill();
      } else {
        context.beginPath();
        context.moveTo(action.points[0].x, action.points[0].y);
        for (let index = 1; index < action.points.length; index += 1) {
          context.lineTo(action.points[index].x, action.points[index].y);
        }
        context.stroke();
      }

      context.restore();
    }

    actionIndexRef.current = targetIndex;
    updateMaskState();
  }, [updateMaskState]);

  const pushAction = useCallback((action: MaskAction) => {
    const nextActions = actionsRef.current.slice(0, actionIndexRef.current);
    nextActions.push(action);

    actionsRef.current = nextActions;
    actionIndexRef.current = nextActions.length;
    updateMaskState();
  }, [updateMaskState]);

  const finishStroke = useCallback(() => {
    const stroke = activeStrokeRef.current;
    if (!stroke) return;

    activeStrokeRef.current = null;
    if (stroke.points.length > 0) {
      const { pointerId: _pointerId, ...record } = stroke;
      pushAction(record);
    }
  }, [pushAction]);

  const undo = useCallback(() => {
    if (isProcessing || actionIndexRef.current <= 0) return;
    redrawHistory(actionIndexRef.current - 1);
  }, [isProcessing, redrawHistory]);

  const redo = useCallback(() => {
    if (isProcessing || actionIndexRef.current >= actionsRef.current.length) return;
    redrawHistory(actionIndexRef.current + 1);
  }, [isProcessing, redrawHistory]);

  const clearMask = useCallback(() => {
    if (isProcessing) return;
    const canvas = maskCanvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    context.clearRect(0, 0, canvas.width, canvas.height);
    activeStrokeRef.current = null;
    pushAction({ type: "clear" });
  }, [isProcessing, pushAction]);

  useImperativeHandle(ref, () => ({
    getMaskCanvas: () => maskCanvasRef.current,
    undo,
    redo,
    clearMask,
  }), [clearMask, redo, undo]);

  useEffect(() => {
    const imageCanvas = imageCanvasRef.current;
    const maskCanvas = maskCanvasRef.current;
    if (!imageCanvas || !maskCanvas) return;

    imageCanvas.width = photo.workingWidth;
    imageCanvas.height = photo.workingHeight;
    maskCanvas.width = photo.workingWidth;
    maskCanvas.height = photo.workingHeight;

    const imageContext = imageCanvas.getContext("2d");
    const maskContext = maskCanvas.getContext("2d", { willReadFrequently: true });
    if (imageContext && maskContext) {
      imageContext.clearRect(0, 0, imageCanvas.width, imageCanvas.height);
      imageContext.drawImage(photo.workingCanvas, 0, 0);
      maskContext.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    }

    actionsRef.current = [];
    actionIndexRef.current = 0;
    activeStrokeRef.current = null;
    pointersRef.current.clear();
    pinchRef.current = null;
    panRef.current = null;
    zoomRef.current = 1;
    panOffsetRef.current = { x: 0, y: 0 };
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
    setCursor({ x: 0, y: 0, size: 0, visible: false });
    maskCallbackRef.current({ hasMask: false, canUndo: false, canRedo: false });
  }, [photo]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const measure = () => {
      const bounds = viewport.getBoundingClientRect();
      const availableWidth = Math.max(80, bounds.width - 72);
      const availableHeight = Math.max(80, bounds.height - 76);
      const scale = Math.min(
        1,
        availableWidth / photo.workingWidth,
        availableHeight / photo.workingHeight,
      );
      setFitSize({
        width: Math.max(1, photo.workingWidth * scale),
        height: Math.max(1, photo.workingHeight * scale),
      });
    };

    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [photo.workingHeight, photo.workingWidth]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) {
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        spaceDownRef.current = true;
      }

      const isModifier = event.metaKey || event.ctrlKey;
      if (!isModifier || event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") spaceDownRef.current = false;
    };
    const onBlur = () => {
      spaceDownRef.current = false;
      finishStroke();
      panRef.current = null;
      compareDraggingRef.current = false;
      pointersRef.current.clear();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [finishStroke, redo, undo]);

  const setZoomValue = useCallback((value: number) => {
    const safeValue = clamp(value, MIN_ZOOM, MAX_ZOOM);
    zoomRef.current = safeValue;
    setZoom(safeValue);
  }, []);

  const setPanValue = useCallback((value: PointerPoint) => {
    panOffsetRef.current = value;
    setPanOffset(value);
  }, []);

  const imagePointFromEvent = useCallback((event: ReactPointerEvent<HTMLCanvasElement>): Point | null => {
    const canvas = maskCanvasRef.current;
    if (!canvas) return null;
    const bounds = canvas.getBoundingClientRect();
    if (
      event.clientX < bounds.left
      || event.clientX > bounds.right
      || event.clientY < bounds.top
      || event.clientY > bounds.bottom
      || bounds.width <= 0
      || bounds.height <= 0
    ) {
      return null;
    }

    return {
      x: clamp(((event.clientX - bounds.left) / bounds.width) * photo.workingWidth, 0, photo.workingWidth),
      y: clamp(((event.clientY - bounds.top) / bounds.height) * photo.workingHeight, 0, photo.workingHeight),
    };
  }, [photo.workingHeight, photo.workingWidth]);

  const updateCursor = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (mode !== "edit" || toolRef.current === "pan" || isProcessing) {
      setCursor((current) => current.visible ? { ...current, visible: false } : current);
      return;
    }

    const canvas = maskCanvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport) return;
    const bounds = canvas.getBoundingClientRect();
    const inside = event.clientX >= bounds.left
      && event.clientX <= bounds.right
      && event.clientY >= bounds.top
      && event.clientY <= bounds.bottom;

    if (!inside) {
      setCursor((current) => current.visible ? { ...current, visible: false } : current);
      return;
    }

    const viewportBounds = viewport.getBoundingClientRect();
    setCursor({
      x: event.clientX - viewportBounds.left,
      y: event.clientY - viewportBounds.top,
      size: brushSizeRef.current * (bounds.width / photo.workingWidth),
      visible: true,
    });
  }, [isProcessing, mode, photo.workingWidth]);

  const drawFromPoint = useCallback((point: Point, previous: Point | null, modeToDraw: "brush" | "eraser", radius: number) => {
    const canvas = maskCanvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    context.save();
    context.globalCompositeOperation = modeToDraw === "eraser" ? "destination-out" : "source-over";
    context.strokeStyle = "#f2765d";
    context.fillStyle = "#f2765d";
    context.lineWidth = radius * 2;
    context.lineCap = "round";
    context.lineJoin = "round";

    if (previous) {
      context.beginPath();
      context.moveTo(previous.x, previous.y);
      context.lineTo(point.x, point.y);
      context.stroke();
    } else {
      context.beginPath();
      context.arc(point.x, point.y, radius, 0, Math.PI * 2);
      context.fill();
    }

    context.restore();
  }, []);

  const updateCompareFromPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width === 0) return;
    onComparePositionChange(clamp(((event.clientX - bounds.left) / bounds.width) * 100, 0, 100));
  }, [onComparePositionChange]);

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (isProcessing || mode !== "edit" || event.button > 1) return;
    event.preventDefault();

    const currentTarget = event.currentTarget;
    try {
      currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is not available in a few older embedded browsers.
    }

    const point = { x: event.clientX, y: event.clientY };
    pointersRef.current.set(event.pointerId, point);

    if (pointersRef.current.size >= 2) {
      finishStroke();
      const pointerPair = [...pointersRef.current.values()].slice(-2);
      pinchRef.current = {
        distance: Math.max(1, pointDistance(pointerPair[0], pointerPair[1])),
        zoom: zoomRef.current,
        midpoint: getMidpoint(pointerPair[0], pointerPair[1]),
        pan: panOffsetRef.current,
      };
      panRef.current = null;
      setCursor((current) => current.visible ? { ...current, visible: false } : current);
      return;
    }

    const shouldPan = toolRef.current === "pan" || spaceDownRef.current || event.button === 1;
    if (shouldPan) {
      panRef.current = {
        pointerId: event.pointerId,
        point,
        pan: panOffsetRef.current,
      };
      return;
    }

    const imagePoint = imagePointFromEvent(event);
    if (!imagePoint) return;

    const drawMode = toolRef.current === "eraser" ? "eraser" : "brush";
    const radius = brushSizeRef.current / 2;
    activeStrokeRef.current = {
      pointerId: event.pointerId,
      type: "stroke",
      mode: drawMode,
      radius,
      points: [imagePoint],
    };
    drawFromPoint(imagePoint, null, drawMode, radius);
    updateCursor(event);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = { x: event.clientX, y: event.clientY };
    if (pointersRef.current.has(event.pointerId)) pointersRef.current.set(event.pointerId, point);

    if (pointersRef.current.size >= 2 && pinchRef.current) {
      const pointerPair = [...pointersRef.current.values()].slice(-2);
      const nextDistance = Math.max(1, pointDistance(pointerPair[0], pointerPair[1]));
      const nextMidpoint = getMidpoint(pointerPair[0], pointerPair[1]);
      const gesture = pinchRef.current;
      setZoomValue(gesture.zoom * (nextDistance / gesture.distance));
      setPanValue({
        x: gesture.pan.x + nextMidpoint.x - gesture.midpoint.x,
        y: gesture.pan.y + nextMidpoint.y - gesture.midpoint.y,
      });
      return;
    }

    const panGesture = panRef.current;
    if (panGesture?.pointerId === event.pointerId) {
      setPanValue({
        x: panGesture.pan.x + event.clientX - panGesture.point.x,
        y: panGesture.pan.y + event.clientY - panGesture.point.y,
      });
      return;
    }

    const stroke = activeStrokeRef.current;
    if (stroke?.pointerId === event.pointerId) {
      const imagePoint = imagePointFromEvent(event);
      if (imagePoint) {
        const previous = stroke.points[stroke.points.length - 1];
        if (pointDistance(previous, imagePoint) >= 1.2) {
          stroke.points.push(imagePoint);
          drawFromPoint(imagePoint, previous, stroke.mode, stroke.radius);
        }
      }
    }

    updateCursor(event);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (activeStrokeRef.current?.pointerId === event.pointerId) finishStroke();
    if (panRef.current?.pointerId === event.pointerId) panRef.current = null;
    pointersRef.current.delete(event.pointerId);

    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size === 1 && mode === "edit" && toolRef.current === "pan") {
      const [pointerId, point] = [...pointersRef.current.entries()][0];
      panRef.current = { pointerId, point, pan: panOffsetRef.current };
    }

    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Ignore a lost capture during browser gesture cancellation.
    }
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (activeStrokeRef.current?.pointerId === event.pointerId) finishStroke();
    if (panRef.current?.pointerId === event.pointerId) panRef.current = null;
    pointersRef.current.delete(event.pointerId);
    pinchRef.current = null;
  };

  const onViewportPointerLeave = () => {
    if (!activeStrokeRef.current) {
      setCursor((current) => current.visible ? { ...current, visible: false } : current);
    }
  };

  const artboardStyle = fitSize.width > 0
    ? { width: `${fitSize.width}px`, height: `${fitSize.height}px`, transform: `scale(${zoom})` }
    : undefined;

  return (
    <>
      <div
        className="canvas-viewport"
        ref={viewportRef}
        onPointerLeave={onViewportPointerLeave}
        aria-label={mode === "edit" ? "Image masking workspace" : "Before and after comparison"}
      >
        <div
          className="canvas-center"
          style={{ transform: `translate(${panOffset.x}px, ${panOffset.y}px)` }}
        >
          <div className="artboard" style={artboardStyle}>
            <canvas
              ref={imageCanvasRef}
              className="artboard-image"
              aria-label="Uploaded photo"
            />
            <canvas
              ref={maskCanvasRef}
              className="artboard-mask"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              onPointerEnter={updateCursor}
              onPointerLeave={onViewportPointerLeave}
              style={{
                opacity: mode === "edit" && showMask ? 0.45 : 0,
                cursor: tool === "pan" ? "grab" : "none",
                pointerEvents: mode === "edit" ? "auto" : "none",
              }}
              aria-label="Paint over the part of the photo to remove"
            />
            {mode === "compare" && resultUrl && (
              <>
                <img
                  src={resultUrl}
                  className="compare-result-image"
                  style={{ clipPath: `inset(0 0 0 ${comparePosition}%)` }}
                  alt="AI-processed result"
                  draggable={false}
                />
                <span className="compare-tag before">Before</span>
                <span className="compare-tag after">After</span>
                <div
                  className="compare-divider"
                  style={{ left: `${comparePosition}%` }}
                >
                  <span className="compare-handle"><Icon name="arrows" size={16} strokeWidth={1.8} /></span>
                </div>
              </>
            )}
          </div>
        </div>

        {mode === "edit" ? (
          <>
            {cursor.visible && tool !== "pan" && !isProcessing && (
              <span
                className={`cursor-ring ${tool === "eraser" ? "is-eraser" : ""}`}
                style={{
                  left: cursor.x,
                  top: cursor.y,
                  width: Math.max(12, cursor.size),
                  height: Math.max(12, cursor.size),
                }}
              />
            )}
            <div className="canvas-hint">
              {tool === "pan" ? <Icon name="hand" size={14} /> : <Icon name="mouse" size={14} />}
              <span>{tool === "pan" ? "Drag to move · pinch to zoom" : "Paint over the object · pinch to zoom"}</span>
            </div>
            <div className="canvas-zoom-controls" aria-label="Canvas zoom controls">
              <button
                className="icon-button compact"
                type="button"
                aria-label="Zoom out"
                disabled={isProcessing || zoom <= MIN_ZOOM}
                onClick={() => setZoomValue(zoomRef.current - 0.25)}
              >
                <Icon name="minus" size={17} />
              </button>
              <span className="zoom-value">{Math.round(zoom * 100)}%</span>
              <button
                className="icon-button compact"
                type="button"
                aria-label="Zoom in"
                disabled={isProcessing || zoom >= MAX_ZOOM}
                onClick={() => setZoomValue(zoomRef.current + 0.25)}
              >
                <Icon name="plus" size={17} />
              </button>
              <span className="toolbar-separator" />
              <button
                className={`icon-button compact ${tool === "pan" ? "is-selected" : ""}`}
                type="button"
                aria-label={tool === "pan" ? "Switch to brush" : "Pan canvas"}
                aria-pressed={tool === "pan"}
                disabled={isProcessing}
                onClick={() => onToolChange(tool === "pan" ? "brush" : "pan")}
              >
                <Icon name="hand" size={16} />
              </button>
              <button
                className="icon-button compact"
                type="button"
                aria-label="Reset zoom and position"
                disabled={isProcessing}
                onClick={() => {
                  setZoomValue(1);
                  setPanValue({ x: 0, y: 0 });
                }}
              >
                <Icon name="arrows" size={15} />
              </button>
            </div>
          </>
        ) : (
          <div
            className="compare-scrub-layer"
            onPointerDown={(event) => {
              compareDraggingRef.current = true;
              event.currentTarget.setPointerCapture(event.pointerId);
              updateCompareFromPointer(event);
            }}
            onPointerMove={(event) => {
              if (compareDraggingRef.current) updateCompareFromPointer(event);
            }}
            onPointerUp={(event) => {
              compareDraggingRef.current = false;
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
            }}
            onPointerCancel={() => { compareDraggingRef.current = false; }}
            aria-label="Drag to compare the original and result"
          />
        )}

        {isProcessing && (
          <div className="processing-cover" role="status" aria-live="polite">
            <div className="processing-card">
              <div className="spinner-wrap"><span className="spinner" /></div>
              <h2 className="processing-title">Working on your photo</h2>
              <p className="processing-copy">{processingState.message}</p>
              <div className="progress-track" aria-hidden="true">
                <div
                  className={`progress-fill ${processingState.progress === null ? "is-indeterminate" : ""}`}
                  style={processingState.progress === null ? undefined : { width: `${processingState.progress}%` }}
                />
              </div>
              <div className="progress-caption">
                <span>
                  {processingState.phase === "download"
                    ? "First-time model download"
                    : processingState.phase === "inference"
                      ? "Inpainting stays on this device"
                      : processingState.phase === "export"
                        ? "Preparing your download"
                        : "Preparing the local AI model"}
                </span>
                <span>{processingState.progress === null ? "" : `${processingState.progress}%`}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {mode === "compare" && resultUrl && (
        <div className="compare-slider-row">
          <span>Before</span>
          <input
            type="range"
            min="0"
            max="100"
            value={comparePosition}
            aria-label="Compare before and after"
            onChange={(event) => onComparePositionChange(Number(event.target.value))}
          />
          <span>After</span>
        </div>
      )}
    </>
  );
});
