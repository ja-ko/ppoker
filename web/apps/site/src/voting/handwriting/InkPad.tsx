import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";

import {
  appendOrderedPoints,
  fitCoordinateSpace,
  isPrimaryPointerStart,
  pointsFromPointerEvent,
  strokeToViewport,
  viewportPointToCanonical,
} from "./ink/capture";
import type {
  LogicalSurface,
  PointerOrigin,
  UniformTransform,
} from "./ink/capture";
import { rasterizeInk } from "./ink/rasterize";
import type { RasterizedInk } from "./ink/rasterize";
import {
  clearInk,
  drawInk,
  inkBounds,
  normalizedDevicePixelRatio,
  renderInk,
  resizeCanvas,
  watchDevicePixelRatio,
} from "./ink/render";
import type { CanvasMetrics, InkBounds, VisibleInkStyle } from "./ink/render";
import type { ImmutableInkStroke, InkStroke } from "./ink/types";

interface ActivePointer {
  pointerId: number;
  strokes: InkStroke[];
  currentStroke: InkStroke | null;
}

export interface InkStats {
  strokeCount: number;
  pointCount: number;
}

export type StrokeCancellationReason =
  | "pointercancel"
  | "lost-capture"
  | "resize"
  | "orientation"
  | "viewport"
  | "disabled";

export interface InkPadHandle {
  isPointerActive(): boolean;
  getLatestPointTime(): number | null;
  getStats(): InkStats;
  getStrokes(): readonly ImmutableInkStroke[];
  getVisualBounds(): InkVisualBounds | null;
  getCanonicalInkLocus(): CanonicalInkLocus | null;
  rasterize(): RasterizedInk | null;
  restoreVectorInk(): void;
  focus(): void;
  clear(): void;
}

export interface InkVisualBounds extends InkBounds {
  surfaceWidth: number;
  surfaceHeight: number;
}

export interface InkSurfaceSize {
  width: number;
  height: number;
}

export interface CanonicalInkLocus {
  readonly center: Readonly<{ x: number; y: number }>;
  readonly coordinateSpace: Readonly<InkSurfaceSize>;
}

export interface InkPadProps {
  enabled?: boolean;
  className?: string;
  onPointerAccepted?: () => void;
  onActivePointerChange?: (active: boolean) => void;
  onStrokeComplete?: (stats: InkStats) => void;
  onStrokeCancel?: (reason: StrokeCancellationReason, stats: InkStats) => void;
  onSurfaceChange?: (size: InkSurfaceSize) => void;
  onClear?: () => void;
}

function inkStats(strokes: readonly InkStroke[]): InkStats {
  return {
    strokeCount: strokes.length,
    pointCount: strokes.reduce(
      (count, stroke) => count + stroke.points.length,
      0,
    ),
  };
}

function immutableStrokeSnapshot(
  strokes: readonly InkStroke[],
): readonly ImmutableInkStroke[] {
  return Object.freeze(
    strokes.map((stroke) =>
      Object.freeze({
        points: Object.freeze(
          stroke.points.map((point) => Object.freeze({ ...point })),
        ),
      }),
    ),
  );
}

function latestCompletedPointTime(
  strokes: readonly InkStroke[],
): number | null {
  let latest: number | null = null;
  for (const stroke of strokes) {
    for (const point of stroke.points) {
      latest = latest === null ? point.time : Math.max(latest, point.time);
    }
  }
  return latest;
}

export const InkPad = forwardRef<InkPadHandle, InkPadProps>(function InkPad(
  {
    enabled = true,
    className = "",
    onPointerAccepted,
    onActivePointerChange,
    onStrokeComplete,
    onStrokeCancel,
    onSurfaceChange,
    onClear,
  },
  ref,
) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const completedStrokesRef = useRef<InkStroke[]>([]);
  const activeStrokeRef = useRef<ActivePointer | null>(null);
  const latestPointTimeRef = useRef<number | null>(null);
  const visualBoundsRef = useRef<InkVisualBounds | null>(null);
  const canonicalInkLocusRef = useRef<CanonicalInkLocus | null>(null);
  const clearRef = useRef<() => void>(() => undefined);
  const restoreVectorInkRef = useRef<() => void>(() => undefined);
  const cancelRef = useRef<
    (reason: StrokeCancellationReason, notify?: boolean) => void
  >(() => undefined);
  const propsRef = useRef({
    enabled,
    onPointerAccepted,
    onActivePointerChange,
    onStrokeComplete,
    onStrokeCancel,
    onSurfaceChange,
    onClear,
  });

  useLayoutEffect(() => {
    propsRef.current = {
      enabled,
      onPointerAccepted,
      onActivePointerChange,
      onStrokeComplete,
      onStrokeCancel,
      onSurfaceChange,
      onClear,
    };
  }, [
    enabled,
    onPointerAccepted,
    onActivePointerChange,
    onStrokeComplete,
    onStrokeCancel,
    onSurfaceChange,
    onClear,
  ]);

  useLayoutEffect(() => {
    if (!enabled) {
      cancelRef.current("disabled");
    }
  }, [enabled]);

  useImperativeHandle(
    ref,
    () => ({
      isPointerActive: () => activeStrokeRef.current !== null,
      getLatestPointTime: () => latestPointTimeRef.current,
      getStats: () => inkStats(completedStrokesRef.current),
      getStrokes: () => immutableStrokeSnapshot(completedStrokesRef.current),
      getVisualBounds: () => visualBoundsRef.current,
      getCanonicalInkLocus: () => canonicalInkLocusRef.current,
      rasterize: () => rasterizeInk(completedStrokesRef.current),
      restoreVectorInk: () => {
        restoreVectorInkRef.current();
      },
      focus: () => surfaceRef.current?.focus({ preventScroll: true }),
      clear: () => {
        clearRef.current();
      },
    }),
    [],
  );

  useEffect(() => {
    const surface = surfaceRef.current;
    const canvas = canvasRef.current;
    if (!surface || !canvas) {
      return;
    }

    // A detached canvas works in Safari and keeps completed vectors off the hot path.
    const completedInkCanvas = document.createElement("canvas");
    let metrics: CanvasMetrics | null = null;
    let canonicalSurface: LogicalSurface | null = null;
    let viewportTransform: UniformTransform | null = null;
    let pointerOrigin: PointerOrigin = { left: 0, top: 0 };
    let animationFrame: number | null = null;
    let orientationFrame: number | null = null;
    let restorationFrame: number | null = null;

    const visibleStyle = (): Partial<VisibleInkStyle> => {
      if (!metrics) {
        return {};
      }
      const scale = Math.min(metrics.logicalWidth, metrics.logicalHeight);
      return {
        minWidth: Math.max(3.8, Math.min(5.5, scale * 0.011)),
        maxWidth: Math.max(7, Math.min(10.5, scale * 0.02)),
      };
    };

    const viewportStroke = (stroke: InkStroke): InkStroke => {
      return viewportTransform
        ? strokeToViewport(stroke, viewportTransform)
        : stroke;
    };

    const updateVisualBounds = () => {
      if (!metrics) {
        visualBoundsRef.current = null;
        return;
      }
      const style = visibleStyle();
      const bounds = inkBounds(
        completedStrokesRef.current.map(viewportStroke),
        (style.maxWidth ?? 8) / 2 + 2,
      );
      visualBoundsRef.current = bounds
        ? {
            ...bounds,
            surfaceWidth: metrics.logicalWidth,
            surfaceHeight: metrics.logicalHeight,
          }
        : null;
    };

    const updateCanonicalInkLocus = () => {
      const bounds = inkBounds(completedStrokesRef.current);
      canonicalInkLocusRef.current =
        bounds && canonicalSurface
          ? Object.freeze({
              center: Object.freeze({
                x: bounds.centerX,
                y: bounds.centerY,
              }),
              coordinateSpace: Object.freeze({ ...canonicalSurface }),
            })
          : null;
    };

    const rebuildCompletedInk = () => {
      if (!metrics) {
        return;
      }
      resizeCanvas(
        completedInkCanvas,
        metrics.logicalWidth,
        metrics.logicalHeight,
        metrics.dpr,
      );
      const context = completedInkCanvas.getContext("2d");
      if (!context) {
        return;
      }
      renderInk(
        context,
        completedStrokesRef.current.map(viewportStroke),
        metrics.logicalWidth,
        metrics.logicalHeight,
        visibleStyle(),
      );
      updateVisualBounds();
    };

    const appendCompletedInk = (strokes: readonly InkStroke[]) => {
      updateCanonicalInkLocus();
      const context = completedInkCanvas.getContext("2d");
      if (!context) {
        return;
      }
      drawInk(context, strokes.map(viewportStroke), visibleStyle());
      updateVisualBounds();
    };

    const paint = () => {
      animationFrame = null;
      const context = canvas.getContext("2d");
      if (!context || !metrics) {
        return;
      }
      clearInk(context, metrics.logicalWidth, metrics.logicalHeight);
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.drawImage(completedInkCanvas, 0, 0);
      context.restore();

      const active = activeStrokeRef.current;
      if (active) {
        drawInk(context, active.strokes.map(viewportStroke), visibleStyle());
      }
    };

    const requestPaint = () => {
      animationFrame ??= window.requestAnimationFrame(paint);
    };

    const restoreVectorInk = () => {
      if (restorationFrame !== null) {
        window.cancelAnimationFrame(restorationFrame);
      }
      const getAnimations = (
        canvas as unknown as { getAnimations?: () => Animation[] }
      ).getAnimations;
      for (const animation of getAnimations?.call(canvas) ?? []) {
        animation.cancel();
      }
      canvas.style.setProperty("animation", "none", "important");
      canvas.style.setProperty("transition", "none", "important");
      canvas.style.setProperty("opacity", "1", "important");
      canvas.style.setProperty("transform", "none", "important");
      canvas.style.setProperty("filter", "none", "important");
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = null;
      }
      paint();
      restorationFrame = window.requestAnimationFrame(() => {
        restorationFrame = null;
        canvas.style.removeProperty("animation");
        canvas.style.removeProperty("transition");
        canvas.style.removeProperty("opacity");
        canvas.style.removeProperty("transform");
        canvas.style.removeProperty("filter");
      });
    };
    restoreVectorInkRef.current = restoreVectorInk;

    const releaseCapture = (pointerId: number) => {
      if (surface.hasPointerCapture(pointerId)) {
        surface.releasePointerCapture(pointerId);
      }
    };

    const cancelActiveStroke = (
      reason: StrokeCancellationReason,
      notify = true,
    ) => {
      const active = activeStrokeRef.current;
      if (!active) {
        return;
      }
      activeStrokeRef.current = null;
      releaseCapture(active.pointerId);
      latestPointTimeRef.current = latestCompletedPointTime(
        completedStrokesRef.current,
      );
      propsRef.current.onActivePointerChange?.(false);
      if (notify) {
        propsRef.current.onStrokeCancel?.(
          reason,
          inkStats(completedStrokesRef.current),
        );
      }
      requestPaint();
    };
    cancelRef.current = cancelActiveStroke;

    const refreshPointerOrigin = () => {
      const bounds = surface.getBoundingClientRect();
      pointerOrigin = { left: bounds.left, top: bounds.top };
      return bounds;
    };

    const resizeSurface = () => {
      cancelActiveStroke("resize");
      const bounds = refreshPointerOrigin();
      if (bounds.width <= 0 || bounds.height <= 0) {
        return;
      }
      metrics = resizeCanvas(
        canvas,
        bounds.width,
        bounds.height,
        window.devicePixelRatio,
      );
      if (!canonicalSurface || completedStrokesRef.current.length === 0) {
        canonicalSurface = {
          width: metrics.logicalWidth,
          height: metrics.logicalHeight,
        };
      }
      viewportTransform = fitCoordinateSpace(canonicalSurface, {
        width: metrics.logicalWidth,
        height: metrics.logicalHeight,
      });
      rebuildCompletedInk();
      propsRef.current.onSurfaceChange?.({
        width: metrics.logicalWidth,
        height: metrics.logicalHeight,
      });
      requestPaint();
    };

    const isWithinSurface = (x: number, y: number): boolean => {
      return Boolean(
        metrics &&
        x >= 0 &&
        y >= 0 &&
        x <= metrics.logicalWidth &&
        y <= metrics.logicalHeight,
      );
    };

    const appendCapturedPoints = (
      active: ActivePointer,
      event: PointerEvent,
    ) => {
      const transform = viewportTransform;
      for (const point of pointsFromPointerEvent(event, pointerOrigin)) {
        if (!isWithinSurface(point.x, point.y)) {
          active.currentStroke = null;
          continue;
        }
        if (!active.currentStroke) {
          active.currentStroke = { points: [] };
          active.strokes.push(active.currentStroke);
        }
        const capturedPoint = transform
          ? viewportPointToCanonical(point, transform)
          : point;
        appendOrderedPoints(active.currentStroke.points, [capturedPoint]);
        const latest = active.currentStroke.points.at(-1)?.time;
        if (latest !== undefined) {
          latestPointTimeRef.current = latest;
        }
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (
        !propsRef.current.enabled ||
        !isPrimaryPointerStart(
          event,
          activeStrokeRef.current?.pointerId ?? null,
        )
      ) {
        return;
      }

      const bounds = refreshPointerOrigin();
      if (
        metrics?.logicalWidth !== bounds.width ||
        metrics.logicalHeight !== bounds.height ||
        metrics.dpr !== normalizedDevicePixelRatio(window.devicePixelRatio)
      ) {
        resizeSurface();
      }
      if (
        !isWithinSurface(
          event.clientX - pointerOrigin.left,
          event.clientY - pointerOrigin.top,
        )
      ) {
        return;
      }
      event.preventDefault();
      propsRef.current.onPointerAccepted?.();
      const active: ActivePointer = {
        pointerId: event.pointerId,
        strokes: [],
        currentStroke: null,
      };
      appendCapturedPoints(active, event);
      activeStrokeRef.current = active;
      propsRef.current.onActivePointerChange?.(true);
      surface.setPointerCapture(event.pointerId);
      requestPaint();
    };

    const onPointerMove = (event: PointerEvent) => {
      const active = activeStrokeRef.current;
      if (active?.pointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();
      appendCapturedPoints(active, event);
      requestPaint();
    };

    const onPointerUp = (event: PointerEvent) => {
      const active = activeStrokeRef.current;
      if (active?.pointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();
      appendCapturedPoints(active, event);
      activeStrokeRef.current = null;
      const strokes = active.strokes.filter(
        (stroke) => stroke.points.length > 0,
      );
      completedStrokesRef.current.push(...strokes);
      releaseCapture(event.pointerId);
      appendCompletedInk(strokes);
      propsRef.current.onActivePointerChange?.(false);
      propsRef.current.onStrokeComplete?.(
        inkStats(completedStrokesRef.current),
      );
      requestPaint();
    };

    const onPointerCancel = (event: PointerEvent) => {
      if (activeStrokeRef.current?.pointerId === event.pointerId) {
        event.preventDefault();
        cancelActiveStroke("pointercancel");
      }
    };

    const onLostPointerCapture = (event: PointerEvent) => {
      if (activeStrokeRef.current?.pointerId === event.pointerId) {
        cancelActiveStroke("lost-capture");
      }
    };

    const onViewportMovement = () => {
      if (activeStrokeRef.current) {
        cancelActiveStroke("viewport");
      } else {
        refreshPointerOrigin();
      }
    };

    const suppressDefault = (event: Event) => {
      event.preventDefault();
    };
    const onOrientationChange = () => {
      cancelActiveStroke("orientation");
      if (orientationFrame !== null) {
        window.cancelAnimationFrame(orientationFrame);
      }
      orientationFrame = window.requestAnimationFrame(() => {
        orientationFrame = null;
        resizeSurface();
      });
    };

    clearRef.current = () => {
      cancelActiveStroke("disabled", false);
      completedStrokesRef.current.length = 0;
      latestPointTimeRef.current = null;
      visualBoundsRef.current = null;
      canonicalInkLocusRef.current = null;
      if (metrics) {
        canonicalSurface = {
          width: metrics.logicalWidth,
          height: metrics.logicalHeight,
        };
        viewportTransform = fitCoordinateSpace(
          canonicalSurface,
          canonicalSurface,
        );
      }
      rebuildCompletedInk();
      propsRef.current.onClear?.();
      requestPaint();
    };

    surface.addEventListener("pointerdown", onPointerDown);
    surface.addEventListener("pointermove", onPointerMove);
    surface.addEventListener("pointerup", onPointerUp);
    surface.addEventListener("pointercancel", onPointerCancel);
    surface.addEventListener("lostpointercapture", onLostPointerCapture);
    surface.addEventListener("contextmenu", suppressDefault);
    surface.addEventListener("dragstart", suppressDefault);
    surface.addEventListener("selectstart", suppressDefault);
    window.addEventListener("resize", resizeSurface);
    window.addEventListener("orientationchange", onOrientationChange);
    window.addEventListener("scroll", onViewportMovement, true);
    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener("scroll", onViewportMovement);
    visualViewport?.addEventListener("resize", onViewportMovement);

    const resizeObserver = new ResizeObserver(resizeSurface);
    resizeObserver.observe(surface);
    const stopWatchingDevicePixelRatio = watchDevicePixelRatio(
      window,
      resizeSurface,
    );
    resizeSurface();

    return () => {
      clearRef.current = () => undefined;
      restoreVectorInkRef.current = () => undefined;
      cancelRef.current = () => undefined;
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
      if (orientationFrame !== null) {
        window.cancelAnimationFrame(orientationFrame);
      }
      if (restorationFrame !== null) {
        window.cancelAnimationFrame(restorationFrame);
      }
      stopWatchingDevicePixelRatio();
      resizeObserver.disconnect();
      surface.removeEventListener("pointerdown", onPointerDown);
      surface.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("pointerup", onPointerUp);
      surface.removeEventListener("pointercancel", onPointerCancel);
      surface.removeEventListener("lostpointercapture", onLostPointerCapture);
      surface.removeEventListener("contextmenu", suppressDefault);
      surface.removeEventListener("dragstart", suppressDefault);
      surface.removeEventListener("selectstart", suppressDefault);
      window.removeEventListener("resize", resizeSurface);
      window.removeEventListener("orientationchange", onOrientationChange);
      window.removeEventListener("scroll", onViewportMovement, true);
      visualViewport?.removeEventListener("scroll", onViewportMovement);
      visualViewport?.removeEventListener("resize", onViewportMovement);
    };
  }, []);

  return (
    <div
      ref={surfaceRef}
      className="ink-surface"
      role="region"
      tabIndex={-1}
      aria-label="Handwriting surface. Write a number from zero through 255."
      aria-describedby="ink-instructions"
      aria-disabled={!enabled}
    >
      <canvas
        ref={canvasRef}
        className={`ink-canvas ${className}`.trim()}
        aria-hidden="true"
      />
    </div>
  );
});
