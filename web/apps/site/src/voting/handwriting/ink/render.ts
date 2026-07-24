import type { InkPoint, InkStroke } from "./types";

export interface VisibleInkStyle {
  color: string;
  minWidth: number;
  maxWidth: number;
  velocityForMinWidth: number;
  velocitySmoothing: number;
  shadowBlur: number;
  shadowColor: string;
}

export interface CanvasMetrics {
  logicalWidth: number;
  logicalHeight: number;
  pixelWidth: number;
  pixelHeight: number;
  dpr: number;
}

export interface InkBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

type DevicePixelRatioSource = Pick<Window, "devicePixelRatio" | "matchMedia">;

interface LegacyMediaQueryList {
  addListener(listener: (event: MediaQueryListEvent) => void): void;
  removeListener(listener: (event: MediaQueryListEvent) => void): void;
}

const DEFAULT_STYLE: VisibleInkStyle = {
  color: "#f5ead3",
  minWidth: 4,
  maxWidth: 8,
  velocityForMinWidth: 1.8,
  velocitySmoothing: 0.68,
  shadowBlur: 8,
  shadowColor: "rgba(103, 169, 255, 0.2)",
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function distance(a: InkPoint, b: InkPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function midpoint(a: InkPoint, b: InkPoint): Pick<InkPoint, "x" | "y"> {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

export function inkBounds(
  strokes: readonly InkStroke[],
  padding = 0,
): InkBounds | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const stroke of strokes) {
    for (const point of stroke.points) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        continue;
      }
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }

  if (!Number.isFinite(minX)) {
    return null;
  }

  const inset = Number.isFinite(padding) ? Math.max(0, padding) : 0;
  minX -= inset;
  minY -= inset;
  maxX += inset;
  maxY += inset;

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}

export function strokeWidths(
  points: readonly InkPoint[],
  style: Pick<
    VisibleInkStyle,
    "minWidth" | "maxWidth" | "velocityForMinWidth" | "velocitySmoothing"
  > = DEFAULT_STYLE,
): number[] {
  if (points.length === 0) {
    return [];
  }

  const widths = [style.maxWidth];
  let filteredVelocity = 0;

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    if (!previous || !point) {
      continue;
    }
    const elapsed = Math.max(1, point.time - previous.time);
    const velocity = distance(previous, point) / elapsed;
    filteredVelocity =
      filteredVelocity * style.velocitySmoothing +
      velocity * (1 - style.velocitySmoothing);

    const velocityMix = clamp(
      filteredVelocity / style.velocityForMinWidth,
      0,
      1,
    );
    const pressureMix =
      point.pressure === undefined ? 1 : 0.92 + point.pressure * 0.16;
    const width =
      (style.maxWidth - velocityMix * (style.maxWidth - style.minWidth)) *
      pressureMix;
    widths.push(clamp(width, style.minWidth, style.maxWidth));
  }

  return widths;
}

export function canvasMetrics(
  logicalWidth: number,
  logicalHeight: number,
  requestedDpr: number,
): CanvasMetrics {
  const dpr = normalizedDevicePixelRatio(requestedDpr);
  return {
    logicalWidth,
    logicalHeight,
    pixelWidth: Math.max(1, Math.round(logicalWidth * dpr)),
    pixelHeight: Math.max(1, Math.round(logicalHeight * dpr)),
    dpr,
  };
}

export function normalizedDevicePixelRatio(value: number): number {
  return Number.isFinite(value) ? Math.max(1, value) : 1;
}

export function watchDevicePixelRatio(
  source: DevicePixelRatioSource,
  onChange: () => void,
): () => void {
  let mediaQuery: MediaQueryList | null = null;
  let stopped = false;

  const removeListener = () => {
    if (!mediaQuery) {
      return;
    }
    if (typeof mediaQuery.removeEventListener === "function") {
      mediaQuery.removeEventListener("change", handleChange);
    } else {
      (mediaQuery as unknown as LegacyMediaQueryList).removeListener(
        handleChange,
      );
    }
    mediaQuery = null;
  };

  const arm = () => {
    mediaQuery = source.matchMedia(
      `(resolution: ${String(normalizedDevicePixelRatio(source.devicePixelRatio))}dppx)`,
    );
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
    } else {
      (mediaQuery as unknown as LegacyMediaQueryList).addListener(handleChange);
    }
  };

  const handleChange = () => {
    if (stopped) {
      return;
    }
    removeListener();
    arm();
    onChange();
  };

  arm();
  return () => {
    stopped = true;
    removeListener();
  };
}

export function resizeCanvas(
  canvas: HTMLCanvasElement,
  logicalWidth: number,
  logicalHeight: number,
  requestedDpr: number,
): CanvasMetrics {
  const metrics = canvasMetrics(logicalWidth, logicalHeight, requestedDpr);

  if (canvas.width !== metrics.pixelWidth) {
    canvas.width = metrics.pixelWidth;
  }
  if (canvas.height !== metrics.pixelHeight) {
    canvas.height = metrics.pixelHeight;
  }

  const context = canvas.getContext("2d");
  context?.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);
  return metrics;
}

function paintDot(
  context: CanvasRenderingContext2D,
  point: InkPoint,
  width: number,
): void {
  context.beginPath();
  context.arc(point.x, point.y, width / 2, 0, Math.PI * 2);
  context.fill();
}

function paintStroke(
  context: CanvasRenderingContext2D,
  stroke: InkStroke,
  style: VisibleInkStyle,
): void {
  const { points } = stroke;
  if (points.length === 0) {
    return;
  }

  const widths = strokeWidths(points, style);
  const firstPoint = points[0];
  const firstWidth = widths[0];
  if (!firstPoint || firstWidth === undefined) {
    return;
  }
  if (points.length === 1) {
    paintDot(context, firstPoint, firstWidth);
    return;
  }

  let start = firstPoint;
  for (let index = 1; index < points.length; index += 1) {
    const control = points[index];
    const startWidth = widths[index - 1];
    const endWidth = widths[index];
    if (!control || startWidth === undefined || endWidth === undefined) {
      continue;
    }
    const next = points[index + 1];
    const end =
      index === points.length - 1 || !next ? control : midpoint(control, next);

    context.beginPath();
    context.moveTo(start.x, start.y);
    context.quadraticCurveTo(control.x, control.y, end.x, end.y);
    context.lineWidth = (startWidth + endWidth) / 2;
    context.stroke();
    start = { ...control, ...end };
  }
}

export function renderInk(
  context: CanvasRenderingContext2D,
  strokes: readonly InkStroke[],
  logicalWidth: number,
  logicalHeight: number,
  styleOverrides: Partial<VisibleInkStyle> = {},
): void {
  clearInk(context, logicalWidth, logicalHeight);
  drawInk(context, strokes, styleOverrides);
}

export function clearInk(
  context: CanvasRenderingContext2D,
  logicalWidth: number,
  logicalHeight: number,
): void {
  context.clearRect(0, 0, logicalWidth, logicalHeight);
}

export function drawInk(
  context: CanvasRenderingContext2D,
  strokes: readonly InkStroke[],
  styleOverrides: Partial<VisibleInkStyle> = {},
): void {
  const style = { ...DEFAULT_STYLE, ...styleOverrides };
  context.save();
  context.strokeStyle = style.color;
  context.fillStyle = style.color;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.shadowBlur = style.shadowBlur;
  context.shadowColor = style.shadowColor;

  for (const stroke of strokes) {
    paintStroke(context, stroke, style);
  }

  context.restore();
}
