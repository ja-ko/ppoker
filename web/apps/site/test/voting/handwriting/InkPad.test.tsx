// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-empty-function, @typescript-eslint/no-floating-promises, @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */

import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InkPad } from "../../../src/voting/handwriting/InkPad";
import type { InkPadHandle } from "../../../src/voting/handwriting/InkPad";

let surfaceBounds = { left: 0, top: 0, width: 320, height: 640 };
let triggerResize: (() => void) | null = null;

function pointerEvent(
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  x: number,
  y: number,
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: 0,
    clientX: x,
    clientY: y,
  });
  Object.defineProperties(event, {
    isPrimary: { value: true },
    pointerId: { value: 7 },
    pointerType: { value: "mouse" },
    pressure: { value: 0.5 },
  });
  return event;
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  surfaceBounds = { left: 0, top: 0, width: 320, height: 640 };
  triggerResize = null;
  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    value: 1,
  });
  const captures = new WeakMap<HTMLElement, Set<number>>();
  Object.defineProperties(HTMLCanvasElement.prototype, {
    getContext: {
      configurable: true,
      value: () => ({
        arc: vi.fn(),
        beginPath: vi.fn(),
        clearRect: vi.fn(),
        drawImage: vi.fn(),
        fill: vi.fn(),
        moveTo: vi.fn(),
        quadraticCurveTo: vi.fn(),
        restore: vi.fn(),
        save: vi.fn(),
        setTransform: vi.fn(),
        stroke: vi.fn(),
      }),
    },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({
        bottom: 400,
        height: 320,
        left: 80,
        right: 240,
        top: 80,
        width: 160,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    },
  });
  Object.defineProperties(HTMLElement.prototype, {
    getBoundingClientRect: {
      configurable: true,
      value: () => ({
        bottom: surfaceBounds.top + surfaceBounds.height,
        height: surfaceBounds.height,
        left: surfaceBounds.left,
        right: surfaceBounds.left + surfaceBounds.width,
        top: surfaceBounds.top,
        width: surfaceBounds.width,
        x: surfaceBounds.left,
        y: surfaceBounds.top,
        toJSON: () => ({}),
      }),
    },
    hasPointerCapture: {
      configurable: true,
      value(this: HTMLElement, pointerId: number) {
        return captures.get(this)?.has(pointerId) ?? false;
      },
    },
    releasePointerCapture: {
      configurable: true,
      value(this: HTMLElement, pointerId: number) {
        captures.get(this)?.delete(pointerId);
      },
    },
    setPointerCapture: {
      configurable: true,
      value(this: HTMLElement, pointerId: number) {
        let current = captures.get(this);
        if (!current) {
          current = new Set();
          captures.set(this, current);
        }
        current.add(pointerId);
      },
    },
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: vi.fn(() => 1),
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        triggerResize = () => {
          callback([], this as unknown as ResizeObserver);
        };
      }
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("InkPad surface API", () => {
  it("reports accepted desktop input, immutable vectors, rasterization, and reuse", async () => {
    const accepted = vi.fn(() => ref.current?.restoreVectorInk());
    const activeChanges = vi.fn();
    const completed = vi.fn();
    const cleared = vi.fn();
    const ref = createRef<InkPadHandle>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <InkPad
          ref={ref}
          onPointerAccepted={accepted}
          onActivePointerChange={activeChanges}
          onStrokeComplete={completed}
          onClear={cleared}
        />,
      );
    });
    const canvas = container.querySelector("canvas");
    const surface = container.querySelector<HTMLElement>(".ink-surface");
    expect(canvas).not.toBeNull();
    expect(surface).not.toBeNull();
    expect(surface?.getAttribute("role")).toBe("region");
    expect(surface?.tabIndex).toBe(-1);
    expect(canvas?.getAttribute("aria-hidden")).toBe("true");
    expect(canvas?.width).toBe(320);
    expect(canvas?.height).toBe(640);

    act(() => surface?.dispatchEvent(pointerEvent("pointerdown", 20, 30)));
    expect(accepted).toHaveBeenCalledOnce();
    expect(ref.current?.isPointerActive()).toBe(true);
    expect(ref.current?.getLatestPointTime()).toBeTypeOf("number");

    act(() => surface?.dispatchEvent(pointerEvent("pointerup", 120, 230)));
    expect(ref.current?.isPointerActive()).toBe(false);
    expect(activeChanges.mock.calls.map(([active]) => active)).toEqual([
      true,
      false,
    ]);
    expect(completed).toHaveBeenCalledWith({ strokeCount: 1, pointCount: 2 });
    expect(ref.current?.getStats()).toEqual({ strokeCount: 1, pointCount: 2 });
    expect(ref.current?.getVisualBounds()).toMatchObject({
      centerX: 70,
      centerY: 130,
      surfaceWidth: 320,
      surfaceHeight: 640,
    });
    expect(ref.current?.getCanonicalInkLocus()).toEqual({
      center: { x: 70, y: 130 },
      coordinateSpace: { width: 320, height: 640 },
    });
    expect(Object.isFrozen(ref.current?.getCanonicalInkLocus())).toBe(true);
    const strokes = ref.current?.getStrokes();
    expect(Object.isFrozen(strokes)).toBe(true);
    expect(Object.isFrozen(strokes?.[0])).toBe(true);
    expect(Object.isFrozen(strokes?.[0]!.points)).toBe(true);
    expect(Object.isFrozen(strokes?.[0]!.points[0])).toBe(true);
    expect(ref.current?.rasterize()).not.toBeNull();

    if (canvas) {
      canvas.style.opacity = "0.3";
      canvas.style.transform = "scale(0.8)";
      canvas.style.filter = "blur(2px)";
    }
    act(() => ref.current?.restoreVectorInk());
    expect(canvas?.style.getPropertyValue("animation")).toBe("none");
    expect(canvas?.style.getPropertyPriority("animation")).toBe("important");
    expect(canvas?.style.opacity).toBe("1");
    expect(canvas?.style.transform).toBe("none");
    expect(canvas?.style.filter).toBe("none");
    act(() => ref.current?.focus());
    expect(document.activeElement).toBe(surface);

    act(() => ref.current?.clear());
    expect(cleared).toHaveBeenCalledOnce();
    expect(ref.current?.getStats()).toEqual({ strokeCount: 0, pointCount: 0 });
    expect(ref.current?.getLatestPointTime()).toBeNull();
    expect(ref.current?.getVisualBounds()).toBeNull();
    expect(ref.current?.getCanonicalInkLocus()).toBeNull();
    expect(ref.current?.rasterize()).toBeNull();

    if (canvas) {
      canvas.style.opacity = "0.2";
      canvas.style.transform = "scale(0.68)";
    }
    act(() => surface?.dispatchEvent(pointerEvent("pointerdown", 319, 639)));
    expect(accepted).toHaveBeenCalledTimes(2);
    expect(canvas?.style.opacity).toBe("1");
    expect(canvas?.style.transform).toBe("none");
    expect(canvas?.style.filter).toBe("none");
    await act(async () => {
      root.unmount();
    });
  });

  it("discards a cancelled partial stroke and ignores input while disabled", async () => {
    const accepted = vi.fn();
    const cancelled = vi.fn();
    const ref = createRef<InkPadHandle>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <InkPad
          ref={ref}
          onPointerAccepted={accepted}
          onStrokeCancel={cancelled}
        />,
      );
    });
    const canvas = container.querySelector("canvas");
    const surface = container.querySelector<HTMLElement>(".ink-surface");
    act(() => surface?.dispatchEvent(pointerEvent("pointerdown", 20, 30)));
    act(() => surface?.dispatchEvent(pointerEvent("pointercancel", 40, 60)));
    expect(cancelled).toHaveBeenCalledWith("pointercancel", {
      strokeCount: 0,
      pointCount: 0,
    });
    expect(ref.current?.getStats().strokeCount).toBe(0);

    await act(async () => {
      root.render(
        <InkPad
          ref={ref}
          enabled={false}
          onPointerAccepted={accepted}
          onStrokeCancel={cancelled}
        />,
      );
    });
    act(() => surface?.dispatchEvent(pointerEvent("pointerdown", 50, 70)));
    expect(accepted).toHaveBeenCalledOnce();
    expect(canvas?.getAttribute("aria-disabled")).toBeNull();
    expect(surface?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      root.unmount();
    });
  });

  it("ignores starts outside the surface and splits re-entering ink into bounded segments", async () => {
    const accepted = vi.fn();
    const completed = vi.fn();
    const ref = createRef<InkPadHandle>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <InkPad
          ref={ref}
          onPointerAccepted={accepted}
          onStrokeComplete={completed}
        />,
      );
    });
    const surface = container.querySelector<HTMLElement>(".ink-surface");

    act(() => surface?.dispatchEvent(pointerEvent("pointerdown", -1, 30)));
    expect(accepted).not.toHaveBeenCalled();
    expect(ref.current?.isPointerActive()).toBe(false);

    act(() => surface?.dispatchEvent(pointerEvent("pointerdown", 20, 30)));
    act(() => surface?.dispatchEvent(pointerEvent("pointermove", 120, 230)));
    act(() => surface?.dispatchEvent(pointerEvent("pointermove", 330, 250)));
    act(() => surface?.dispatchEvent(pointerEvent("pointermove", 220, 330)));
    act(() => surface?.dispatchEvent(pointerEvent("pointerup", 400, 400)));

    expect(accepted).toHaveBeenCalledOnce();
    expect(completed).toHaveBeenCalledWith({ strokeCount: 2, pointCount: 3 });
    expect(ref.current?.getStrokes()).toHaveLength(2);
    for (const stroke of ref.current?.getStrokes() ?? []) {
      for (const point of stroke.points) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(320);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(640);
      }
    }
    await act(async () => {
      root.unmount();
    });
  });

  it("refreshes pointer coordinates after the page scrolls without resizing", async () => {
    const ref = createRef<InkPadHandle>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<InkPad ref={ref} />);
    });
    const surface = container.querySelector<HTMLElement>(".ink-surface");

    surfaceBounds = { left: 100, top: 200, width: 320, height: 640 };
    act(() => surface?.dispatchEvent(pointerEvent("pointerdown", 120, 230)));
    act(() => surface?.dispatchEvent(pointerEvent("pointerup", 220, 430)));

    expect(ref.current?.getStrokes()[0]?.points).toMatchObject([
      { x: 20, y: 30 },
      { x: 120, y: 230 },
    ]);
    await act(async () => {
      root.unmount();
    });
  });

  it("cancels active capture when the viewport moves", async () => {
    const cancelled = vi.fn();
    const ref = createRef<InkPadHandle>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<InkPad ref={ref} onStrokeCancel={cancelled} />);
    });
    const surface = container.querySelector<HTMLElement>(".ink-surface");

    act(() => surface?.dispatchEvent(pointerEvent("pointerdown", 20, 30)));
    act(() => window.dispatchEvent(new Event("scroll")));

    expect(ref.current?.isPointerActive()).toBe(false);
    expect(cancelled).toHaveBeenCalledWith("viewport", {
      strokeCount: 0,
      pointCount: 0,
    });
    expect(ref.current?.getStrokes()).toHaveLength(0);
    await act(async () => {
      root.unmount();
    });
  });

  it("measures the fixed surface across resize and DPR changes during a visual effect", async () => {
    const ref = createRef<InkPadHandle>();
    const surfaceChanged = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<InkPad ref={ref} onSurfaceChange={surfaceChanged} />);
    });
    const surface = container.querySelector<HTMLElement>(".ink-surface");
    const canvas = container.querySelector("canvas");

    act(() => surface?.dispatchEvent(pointerEvent("pointerdown", 20, 30)));
    act(() => surface?.dispatchEvent(pointerEvent("pointerup", 120, 230)));
    if (canvas) {
      canvas.style.opacity = "0.35";
      canvas.style.transform = "scale(0.72)";
      canvas.style.filter = "blur(1px)";
    }
    surfaceBounds = { left: 10, top: 20, width: 480, height: 320 };
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 2,
    });
    act(() => triggerResize?.());

    expect(canvas?.width).toBe(960);
    expect(canvas?.height).toBe(640);
    expect(ref.current?.getVisualBounds()).toMatchObject({
      centerX: 195,
      centerY: 65,
      surfaceWidth: 480,
      surfaceHeight: 320,
    });
    expect(ref.current?.getStats().strokeCount).toBe(1);
    expect(ref.current?.getCanonicalInkLocus()).toEqual({
      center: { x: 70, y: 130 },
      coordinateSpace: { width: 320, height: 640 },
    });
    expect(surfaceChanged).toHaveBeenLastCalledWith({
      width: 480,
      height: 320,
    });

    act(() => ref.current?.clear());
    act(() => surface?.dispatchEvent(pointerEvent("pointerdown", 489, 339)));
    act(() => surface?.dispatchEvent(pointerEvent("pointerup", 450, 300)));
    expect(ref.current?.getStats()).toEqual({ strokeCount: 1, pointCount: 2 });
    expect(ref.current?.getStrokes()[0]!.points[0]).toMatchObject({
      x: 479,
      y: 319,
    });
    await act(async () => {
      root.unmount();
    });
  });
});
