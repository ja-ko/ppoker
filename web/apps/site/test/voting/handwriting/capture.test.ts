/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { describe, expect, it } from "vitest";

import {
  appendOrderedPoints,
  canonicalPointToViewport,
  coalescedPointerEvents,
  fitCoordinateSpace,
  isPrimaryPointerStart,
  pointFromPointerEvent,
  pointsFromPointerEvent,
  strokeToViewport,
  transformCoordinatePoint,
  viewportPointToCanonical,
} from "../../../src/voting/handwriting/ink/capture";
import { rasterizeInk } from "../../../src/voting/handwriting/ink/rasterize";
import type { InkPoint } from "../../../src/voting/handwriting/ink/types";

function pointerEvent(overrides: Partial<PointerEvent> = {}): PointerEvent {
  return {
    button: 0,
    clientX: 0,
    clientY: 0,
    isPrimary: true,
    pointerId: 1,
    pointerType: "touch",
    pressure: 0.5,
    timeStamp: 10,
    ...overrides,
  } as PointerEvent;
}

describe("pointer capture utilities", () => {
  it("accepts one primary pointer and only the primary button", () => {
    expect(isPrimaryPointerStart(pointerEvent(), null)).toBe(true);
    expect(
      isPrimaryPointerStart(pointerEvent({ pointerType: "mouse" }), null),
    ).toBe(true);
    expect(
      isPrimaryPointerStart(pointerEvent({ isPrimary: false }), null),
    ).toBe(false);
    expect(isPrimaryPointerStart(pointerEvent({ button: 2 }), null)).toBe(
      false,
    );
    expect(isPrimaryPointerStart(pointerEvent(), 7)).toBe(false);
  });

  it("stores logical coordinates, timestamps, pressure, and pointer type", () => {
    const point = pointFromPointerEvent(
      pointerEvent({
        clientX: 128.25,
        clientY: 80.5,
        pressure: 1.4,
        pointerType: "pen",
        timeStamp: 42,
      }),
      { left: 28.25, top: 20.5 },
    );

    expect(point).toEqual({
      x: 100,
      y: 60,
      time: 42,
      pressure: 1,
      pointerType: "pen",
    });
  });

  it("keeps logical coordinates independent from device pixel ratio", () => {
    const event = pointerEvent({ clientX: 80, clientY: 120 });
    const pointAtDprOne = pointFromPointerEvent(event, { left: 10, top: 20 });
    const pointAtDprThree = pointFromPointerEvent(event, { left: 10, top: 20 });

    expect(pointAtDprThree).toEqual(pointAtDprOne);
    expect(pointAtDprThree).toMatchObject({ x: 70, y: 100 });
  });

  it("uses ordered coalesced samples and falls back to the dispatched event", () => {
    const first = pointerEvent({ clientX: 10, timeStamp: 1 });
    const second = pointerEvent({ clientX: 20, timeStamp: 2 });
    const event = pointerEvent({
      getCoalescedEvents: () => [first, second],
    });

    expect(coalescedPointerEvents(event)).toEqual([first, second]);
    expect(pointsFromPointerEvent(event, { left: 0, top: 0 })).toMatchObject([
      { x: 10, time: 1 },
      { x: 20, time: 2 },
    ]);
    expect(coalescedPointerEvents(pointerEvent())).toHaveLength(1);
  });

  it("drops duplicate and out-of-order samples when appending", () => {
    const points: InkPoint[] = [{ x: 1, y: 1, time: 4 }];
    const added = appendOrderedPoints(points, [
      { x: 1, y: 1, time: 4 },
      { x: 0, y: 0, time: 3 },
      { x: 2, y: 2, time: 5 },
    ]);

    expect(added).toBe(1);
    expect(points).toEqual([
      { x: 1, y: 1, time: 4 },
      { x: 2, y: 2, time: 5 },
    ]);
  });

  it("aspect-fits canonical portrait ink without mutating its vectors", () => {
    const stroke = {
      points: [
        { x: 0, y: 0, time: 1 },
        { x: 300, y: 600, time: 2, pressure: 0.7 },
      ],
    };
    const transform = fitCoordinateSpace(
      { width: 300, height: 600 },
      { width: 800, height: 400 },
    );

    expect(transform).toEqual({
      scale: 2 / 3,
      offsetX: 300,
      offsetY: 0,
    });
    expect(strokeToViewport(stroke, transform).points).toEqual([
      { x: 300, y: 0, time: 1 },
      { x: 500, y: 400, time: 2, pressure: 0.7 },
    ]);
    expect(stroke.points).toEqual([
      { x: 0, y: 0, time: 1 },
      { x: 300, y: 600, time: 2, pressure: 0.7 },
    ]);
  });

  it("returns existing ink exactly after a portrait-landscape-portrait cycle", () => {
    const canonicalSurface = { width: 300, height: 600 };
    const stroke = {
      points: [
        { x: 50, y: 100, time: 1 },
        { x: 100, y: 500, time: 2 },
        { x: 250, y: 500, time: 3 },
      ],
    };
    const originalPoints = stroke.points.map((point) => ({ ...point }));
    const rasterBefore = rasterizeInk([stroke]);

    const landscapeTransform = fitCoordinateSpace(canonicalSurface, {
      width: 800,
      height: 400,
    });
    expect(strokeToViewport(stroke, landscapeTransform).points).not.toEqual(
      originalPoints,
    );
    const returnedTransform = fitCoordinateSpace(
      canonicalSurface,
      canonicalSurface,
    );
    expect(strokeToViewport(stroke, returnedTransform).points).toEqual(
      originalPoints,
    );
    expect(stroke.points).toEqual(originalPoints);

    const rasterAfter = rasterizeInk([stroke]);
    expect(rasterAfter?.geometry).toEqual(rasterBefore?.geometry);
    expect(rasterAfter?.data).toEqual(rasterBefore?.data);
  });

  it("keeps a letterbox stroke under the pointer when it completes", () => {
    const transform = fitCoordinateSpace(
      { width: 300, height: 600 },
      { width: 800, height: 400 },
    );
    const viewportPoints: InkPoint[] = [
      { x: 730, y: 180, time: 3 },
      { x: 770, y: 220, time: 4 },
    ];
    const canonicalStroke = {
      points: viewportPoints.map((point) =>
        viewportPointToCanonical(point, transform),
      ),
    };
    expect(canonicalStroke.points.every((point) => point.x > 300)).toBe(true);
    const activePosition = strokeToViewport(canonicalStroke, transform).points;
    const completed = [canonicalStroke];
    const completedPosition = strokeToViewport(completed[0]!, transform).points;

    expect(activePosition).toEqual(viewportPoints);
    expect(completedPosition).toEqual(viewportPoints);
    expect(
      canonicalPointToViewport(canonicalStroke.points[0]!, transform),
    ).toEqual(viewportPoints[0]);
    expect(canonicalStroke.points).toEqual(
      viewportPoints.map((point) => viewportPointToCanonical(point, transform)),
    );
  });

  it("rejects degenerate resize surfaces", () => {
    expect(() =>
      fitCoordinateSpace(
        { width: 0, height: 100 },
        { width: 100, height: 100 },
      ),
    ).toThrow(RangeError);
  });

  it("maps an off-center canonical locus with the same portrait-to-landscape fit", () => {
    const transform = fitCoordinateSpace(
      { width: 390, height: 844 },
      { width: 653, height: 280 },
    );

    expect(transform).toEqual({
      scale: 280 / 844,
      offsetX: (653 - 390 * (280 / 844)) / 2,
      offsetY: 0,
    });
    expect(transformCoordinatePoint({ x: 72, y: 510 }, transform)).toEqual({
      x: 72 * (280 / 844) + (653 - 390 * (280 / 844)) / 2,
      y: 510 * (280 / 844),
    });
  });
});
