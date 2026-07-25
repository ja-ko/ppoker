import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  fitRectPreservingAspect,
  type InkMorphTransform,
  type MorphRect,
} from "../../../src/voting/handwriting/ink/morph";

describe("handwriting commit morph", () => {
  it("centers the source inside the final text without changing its aspect ratio", () => {
    const source = { left: 40, top: 120, width: 80, height: 100 };
    const target = { left: 130, top: 210, width: 220, height: 70 };
    const transform = fitRectPreservingAspect(source, target);

    expect(transform).toEqual({
      originX: 40,
      originY: 120,
      scale: 0.7,
      translateX: 172,
      translateY: 90,
    });
    if (transform === null) {
      throw new Error("Expected valid morph geometry.");
    }
    expect(projectRect(source, transform, 0)).toEqual(source);
    const projected = projectRect(source, transform, 1);
    expect(projected).toEqual({
      height: 70,
      left: 212,
      top: 210,
      width: 56,
    });
    expect(rectCenter(projected)).toEqual(rectCenter(target));
    expect(projected.width / projected.height).toBe(
      source.width / source.height,
    );
  });

  it("rejects unavailable and degenerate source or destination geometry", () => {
    const rect = { left: 0, top: 0, width: 10, height: 20 };
    expect(fitRectPreservingAspect({ ...rect, width: 0 }, rect)).toBeNull();
    expect(fitRectPreservingAspect(rect, { ...rect, height: 0 })).toBeNull();
    expect(
      fitRectPreservingAspect({ ...rect, left: Number.NaN }, rect),
    ).toBeNull();
  });

  it("centers a width-constrained source without stretching it vertically", () => {
    const source = { left: 10, top: 20, width: 80, height: 100 };
    const target = { left: 100, top: 200, width: 50, height: 200 };
    const transform = fitRectPreservingAspect(source, target);
    if (transform === null) {
      throw new Error("Expected valid morph geometry.");
    }

    expect(transform.scale).toBe(0.625);
    const projected = projectRect(source, transform, 1);
    expect(projected).toEqual({
      height: 62.5,
      left: 100,
      top: 268.75,
      width: 50,
    });
    expect(rectCenter(projected)).toEqual(rectCenter(target));
  });

  it("keeps the glyph appearance animation and morph effect contract", async () => {
    const css = await readFile(join(process.cwd(), "src/styles.css"), "utf8");
    const commit = keyframes(css, "vote-ink-commit");

    expect(css).toContain(
      "animation: vote-type-emerge 460ms cubic-bezier(0.22, 1, 0.36, 1) both;",
    );
    expect(keyframes(css, "vote-type-emerge"))
      .toBe(`@keyframes vote-type-emerge {
  from {
    opacity: 0;
    filter: blur(6px);
    transform: translate(-50%, -50%) scale(0.68);
  }

  to {
    opacity: 1;
    filter: blur(0);
    transform: translate(-50%, -50%) scale(1);
  }
}`);
    expect(commit).toContain("filter: blur(0);");
    expect(commit).toContain("filter: blur(0.6px);");
    expect(commit).toContain("filter: blur(4px);");
    expect(commit).toContain("opacity: 0.72;");
    expect(commit).toContain("opacity: 0;");
    expect(commit).toContain("scale(var(--vote-ink-scale, 1))");
    expect(commit).not.toContain("scale(1.2)");
    expect(commit).not.toContain("scale(1.38)");
    expect(keyframes(css, "vote-ink-light-out")).toContain(`from {
    opacity: 1;`);
    expect(keyframes(css, "vote-ink-light-out")).toContain(`to {
    opacity: 0;`);
    expect(keyframes(css, "vote-ink-tint-in")).toContain(`from {
    opacity: 0;`);
    expect(keyframes(css, "vote-ink-tint-in")).toContain(`to {
    opacity: 1;`);
    expect(css).toContain("mix-blend-mode: plus-lighter;");
  });

  it("has one score font path and a full-stage pointer surface", async () => {
    const [css, inkPad] = await Promise.all([
      readFile(join(process.cwd(), "src/styles.css"), "utf8"),
      readFile(
        join(process.cwd(), "src/voting/handwriting/InkPad.tsx"),
        "utf8",
      ),
    ]);

    expect(css).not.toContain("--font-handwritten");
    expect(css).not.toContain(".vote-result--handwritten");
    expect(css).toMatch(
      /\.vote-route \.ink-surface \{[\s\S]*?position: absolute;[\s\S]*?inset: 0;/u,
    );
    expect(css).toMatch(
      /\.vote-draw-heading \{[\s\S]*?position: absolute;[\s\S]*?top: 0;[\s\S]*?pointer-events: none;/u,
    );
    expect(inkPad).toContain('tintContext.fillStyle = "#ff4b1f";');
  });
});

function projectRect(
  source: MorphRect,
  transform: InkMorphTransform,
  progress: number,
): MorphRect {
  const scale = 1 + (transform.scale - 1) * progress;
  const translateX = transform.translateX * progress;
  const translateY = transform.translateY * progress;
  return {
    left:
      transform.originX +
      translateX +
      (source.left - transform.originX) * scale,
    top:
      transform.originY + translateY + (source.top - transform.originY) * scale,
    width: source.width * scale,
    height: source.height * scale,
  };
}

function rectCenter(rect: MorphRect): {
  readonly x: number;
  readonly y: number;
} {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

function keyframes(css: string, name: string): string {
  const start = css.indexOf(`@keyframes ${name} {`);
  if (start < 0) {
    throw new Error(`Missing ${name} keyframes.`);
  }
  const next = css.indexOf("\n@keyframes ", start + 1);
  return css.slice(start, next < 0 ? css.length : next).trim();
}
