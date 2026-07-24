import type { InkPoint, InkStroke } from "./types";

export type PointerOrigin = Pick<DOMRectReadOnly, "left" | "top">;

export interface LogicalSurface {
  width: number;
  height: number;
}

export interface UniformTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface CoordinatePoint {
  x: number;
  y: number;
}

type PointerStart = Pick<
  PointerEvent,
  "button" | "isPrimary" | "pointerId" | "pointerType"
>;

export function isPrimaryPointerStart(
  event: PointerStart,
  activePointerId: number | null,
): boolean {
  if (activePointerId !== null || !event.isPrimary) {
    return false;
  }

  return event.button === 0;
}

export function pointFromPointerEvent(
  event: PointerEvent,
  origin: PointerOrigin,
): InkPoint {
  const point: InkPoint = {
    x: event.clientX - origin.left,
    y: event.clientY - origin.top,
    time: event.timeStamp,
  };

  if (Number.isFinite(event.pressure)) {
    point.pressure = Math.min(1, Math.max(0, event.pressure));
  }

  if (event.pointerType) {
    point.pointerType = event.pointerType;
  }

  return point;
}

export function coalescedPointerEvents(event: PointerEvent): PointerEvent[] {
  if (typeof event.getCoalescedEvents !== "function") {
    return [event];
  }

  const events = event.getCoalescedEvents();
  return events.length > 0 ? events : [event];
}

export function pointsFromPointerEvent(
  event: PointerEvent,
  origin: PointerOrigin,
): InkPoint[] {
  return coalescedPointerEvents(event).map((sample) =>
    pointFromPointerEvent(sample, origin),
  );
}

export function appendOrderedPoints(
  target: InkPoint[],
  points: readonly InkPoint[],
): number {
  let added = 0;

  for (const point of points) {
    const last = target.at(-1);
    if (last && point.time < last.time) {
      continue;
    }
    if (point.x === last?.x && point.y === last.y && point.time === last.time) {
      continue;
    }

    target.push(point);
    added += 1;
  }

  return added;
}

export function fitCoordinateSpace(
  source: LogicalSurface,
  target: LogicalSurface,
): UniformTransform {
  if (
    source.width <= 0 ||
    source.height <= 0 ||
    target.width <= 0 ||
    target.height <= 0
  ) {
    throw new RangeError("Logical surfaces must have positive dimensions");
  }

  const scale = Math.min(
    target.width / source.width,
    target.height / source.height,
  );
  return {
    scale,
    offsetX: (target.width - source.width * scale) / 2,
    offsetY: (target.height - source.height * scale) / 2,
  };
}

export function transformCoordinatePoint(
  point: CoordinatePoint,
  transform: UniformTransform,
): CoordinatePoint {
  return {
    x: point.x * transform.scale + transform.offsetX,
    y: point.y * transform.scale + transform.offsetY,
  };
}

export function canonicalPointToViewport(
  point: InkPoint,
  transform: UniformTransform,
): InkPoint {
  const mapped = transformCoordinatePoint(point, transform);
  return {
    ...point,
    ...mapped,
  };
}

export function viewportPointToCanonical(
  point: InkPoint,
  transform: UniformTransform,
): InkPoint {
  return {
    ...point,
    x: (point.x - transform.offsetX) / transform.scale,
    y: (point.y - transform.offsetY) / transform.scale,
  };
}

export function strokeToViewport(
  stroke: InkStroke,
  transform: UniformTransform,
): InkStroke {
  return {
    points: stroke.points.map((point) =>
      canonicalPointToViewport(point, transform),
    ),
  };
}
