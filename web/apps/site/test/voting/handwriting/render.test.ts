/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { describe, expect, it, vi } from "vitest";

import {
  canvasMetrics,
  distance,
  inkBounds,
  midpoint,
  normalizedDevicePixelRatio,
  strokeWidths,
  watchDevicePixelRatio,
} from "../../../src/voting/handwriting/ink/render";
import type { InkPoint } from "../../../src/voting/handwriting/ink/types";

const point = (x: number, y: number, time: number): InkPoint => ({
  x,
  y,
  time,
});

describe("visible ink geometry", () => {
  it("computes distances and curve midpoints", () => {
    expect(distance(point(0, 0, 0), point(3, 4, 1))).toBe(5);
    expect(midpoint(point(2, 6, 0), point(8, 10, 1))).toEqual({ x: 5, y: 8 });
  });

  it("derives a padded center from every retained vector stroke", () => {
    expect(
      inkBounds(
        [
          { points: [point(20, 30, 0), point(80, 130, 1)] },
          { points: [point(120, 50, 2)] },
        ],
        5,
      ),
    ).toEqual({
      minX: 15,
      minY: 25,
      maxX: 125,
      maxY: 135,
      width: 110,
      height: 110,
      centerX: 70,
      centerY: 80,
    });
    expect(inkBounds([{ points: [] }])).toBeNull();
  });

  it("makes fast movement narrower without exceeding restrained bounds", () => {
    const style = {
      minWidth: 4,
      maxWidth: 8,
      velocityForMinWidth: 1,
      velocitySmoothing: 0,
    };
    const slow = strokeWidths([point(0, 0, 0), point(1, 0, 10)], style);
    const fast = strokeWidths([point(0, 0, 0), point(20, 0, 10)], style);

    expect(fast[1]!).toBeLessThan(slow[1]!);
    expect(fast[1]!).toBeGreaterThanOrEqual(style.minWidth);
    expect(slow[1]!).toBeLessThanOrEqual(style.maxWidth);
  });

  it("handles identical timestamps without infinite widths", () => {
    const widths = strokeWidths([point(0, 0, 10), point(8, 0, 10)]);
    expect(widths.every(Number.isFinite)).toBe(true);
  });

  it("scales only the backing store for DPR", () => {
    expect(canvasMetrics(320, 640, 3)).toEqual({
      logicalWidth: 320,
      logicalHeight: 640,
      pixelWidth: 960,
      pixelHeight: 1920,
      dpr: 3,
    });
    expect(normalizedDevicePixelRatio(Number.NaN)).toBe(1);
  });

  it("re-arms DPR observation at the new resolution and cleans up", () => {
    let dpr = 2;
    const subscriptions: {
      query: string;
      listener?: () => void;
      removed: boolean;
    }[] = [];
    const source = {
      get devicePixelRatio() {
        return dpr;
      },
      matchMedia(query: string) {
        const subscription: (typeof subscriptions)[number] = {
          query,
          removed: false,
        };
        subscriptions.push(subscription);
        return {
          addEventListener: (_type: string, listener: () => void) => {
            subscription.listener = listener;
          },
          removeEventListener: () => {
            subscription.removed = true;
          },
        } as unknown as MediaQueryList;
      },
    } as Pick<Window, "devicePixelRatio" | "matchMedia">;
    const onChange = vi.fn();

    const stop = watchDevicePixelRatio(source, onChange);
    expect(subscriptions[0]!.query).toBe("(resolution: 2dppx)");

    dpr = 3;
    subscriptions[0]!.listener?.();
    expect(subscriptions[0]!.removed).toBe(true);
    expect(subscriptions[1]!.query).toBe("(resolution: 3dppx)");
    expect(onChange).toHaveBeenCalledOnce();

    stop();
    expect(subscriptions[1]!.removed).toBe(true);
  });

  it("falls back to legacy MediaQueryList listeners", () => {
    const listener = vi.fn();
    const removeListener = vi.fn();
    const source = {
      devicePixelRatio: 2,
      matchMedia: () =>
        ({
          addEventListener: undefined,
          removeEventListener: undefined,
          addListener: listener,
          removeListener,
        }) as unknown as MediaQueryList,
    } as Pick<Window, "devicePixelRatio" | "matchMedia">;

    const stop = watchDevicePixelRatio(source, vi.fn());
    expect(listener).toHaveBeenCalledOnce();
    stop();
    expect(removeListener).toHaveBeenCalledOnce();
  });
});
