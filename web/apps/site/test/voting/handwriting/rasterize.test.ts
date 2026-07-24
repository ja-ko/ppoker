import { describe, expect, it } from "vitest";

import {
  PREPROCESSING_CONFIG,
  computeBounds,
  prepareRasterGeometry,
  rasterizeInk,
  rgbaToNchw,
  totalPathLength,
  transformPoint,
} from "../../../src/voting/handwriting/ink/rasterize";
import type { InkStroke } from "../../../src/voting/handwriting/ink/types";

const stroke = (coordinates: [number, number][]): InkStroke => ({
  points: coordinates.map(([x, y], time) => ({ x, y, time })),
});

describe("recognition raster geometry", () => {
  it("computes bounds across every stroke and ignores empty strokes", () => {
    expect(
      computeBounds([
        stroke([
          [12, 8],
          [20, 30],
        ]),
        { points: [] },
        stroke([
          [-4, 18],
          [16, 40],
        ]),
      ]),
    ).toEqual({
      minX: -4,
      minY: 8,
      maxX: 20,
      maxY: 40,
      width: 24,
      height: 32,
    });
    expect(computeBounds([])).toBeNull();
  });

  it("measures path length within strokes without joining separate strokes", () => {
    expect(
      totalPathLength([
        stroke([
          [0, 0],
          [3, 4],
        ]),
        stroke([
          [100, 100],
          [100, 105],
        ]),
      ]),
    ).toBe(10);
  });

  it("adds proportional padding, preserves aspect ratio, and centers the fit", () => {
    const geometry = prepareRasterGeometry([
      stroke([
        [10, 20],
        [110, 70],
      ]),
    ]);
    expect(geometry).not.toBeNull();
    if (!geometry) return;

    expect(geometry.paddedBounds.width).toBe(120);
    expect(geometry.paddedBounds.height).toBe(70);
    expect(geometry.paddedBounds.width * geometry.scale).toBeLessThanOrEqual(
      PREPROCESSING_CONFIG.contentWidth,
    );
    expect(geometry.paddedBounds.height * geometry.scale).toBeCloseTo(
      PREPROCESSING_CONFIG.contentHeight,
    );

    const topLeft = transformPoint(
      {
        x: geometry.paddedBounds.minX,
        y: geometry.paddedBounds.minY,
      },
      geometry,
    );
    const bottomRight = transformPoint(
      {
        x: geometry.paddedBounds.maxX,
        y: geometry.paddedBounds.maxY,
      },
      geometry,
    );
    expect((topLeft.x + bottomRight.x) / 2).toBeCloseTo(64, 1);
    expect((topLeft.y + bottomRight.y) / 2).toBeCloseTo(16, 1);
    expect(
      (bottomRight.x - topLeft.x) / (bottomRight.y - topLeft.y),
    ).toBeCloseTo(120 / 70, 2);
  });

  it("rejects empty, tapped, and trivially tiny input", () => {
    expect(rasterizeInk([])).toBeNull();
    expect(rasterizeInk([stroke([[10, 10]])])).toBeNull();
    expect(
      rasterizeInk([
        stroke([
          [10, 10],
          [12, 11],
        ]),
      ]),
    ).toBeNull();
  });
});

describe("recognition raster pixels", () => {
  it("produces deterministic white-on-black row-major NCHW data", () => {
    const strokes = [
      stroke([
        [10, 20],
        [100, 20],
      ]),
    ];
    const first = rasterizeInk(strokes);
    const second = rasterizeInk(strokes);
    expect(first).not.toBeNull();
    if (!first || !second) return;

    expect(first.shape).toEqual([1, 1, 32, 128]);
    expect(first.data).toHaveLength(128 * 32);
    expect(first.data).toEqual(second.data);
    expect(first.preprocessingVersion).toBe("digits-model-input-v1");
    expect(Math.max(...first.data)).toBe(1);
    expect(first.data[0]).toBe(0);
    expect(first.data.every((value) => value >= 0 && value <= 1)).toBe(true);

    const occupiedRows = Array.from({ length: first.height }, (_, y) =>
      first.data
        .slice(y * first.width, (y + 1) * first.width)
        .some((value) => value > 0),
    );
    const firstRow = occupiedRows.indexOf(true);
    const lastRow = occupiedRows.lastIndexOf(true);
    expect((firstRow + lastRow) / 2).toBeCloseTo(15.5, 0);
  });

  it("retains disconnected marks once the complete drawing is substantial", () => {
    const raster = rasterizeInk([
      stroke([
        [0, 0],
        [0, 30],
      ]),
      stroke([[20, 15]]),
    ]);
    expect(raster).not.toBeNull();
    if (!raster) return;

    const litPixels = raster.data.filter((value) => value > 0).length;
    expect(litPixels).toBeGreaterThan(50);
  });

  it("converts RGBA pixels to one-channel row-major values over black", () => {
    const tensor = rgbaToNchw(
      new Uint8ClampedArray([
        0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 128, 255, 0, 0, 255,
      ]),
      2,
      2,
    );

    expect(Array.from(tensor)).toEqual([
      0,
      1,
      expect.closeTo(128 / 255, 5),
      expect.closeTo(0.2126, 5),
    ]);
    expect(() => rgbaToNchw(new Uint8ClampedArray(3), 1, 1)).toThrow(
      RangeError,
    );
  });
});
