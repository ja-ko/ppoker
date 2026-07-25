import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  fitRectToRect,
  type InkMorphTransform,
  type MorphRect,
} from "../../../src/voting/handwriting/ink/morph";

describe("handwriting commit morph", () => {
  it("fits the complete source rectangle to the final text rectangle", () => {
    const source = { left: 40, top: 120, width: 80, height: 100 };
    const target = { left: 130, top: 210, width: 220, height: 70 };
    const transform = fitRectToRect(source, target);

    expect(transform).toEqual({
      originX: 40,
      originY: 120,
      translateX: 90,
      translateY: 90,
      scaleX: 2.75,
      scaleY: 0.7,
    });
    if (transform === null) {
      throw new Error("Expected valid morph geometry.");
    }
    expect(projectRect(source, transform, 0)).toEqual(source);
    expect(projectRect(source, transform, 1)).toEqual(target);
  });

  it("rejects unavailable and degenerate source or destination geometry", () => {
    const rect = { left: 0, top: 0, width: 10, height: 20 };
    expect(fitRectToRect({ ...rect, width: 0 }, rect)).toBeNull();
    expect(fitRectToRect(rect, { ...rect, height: 0 })).toBeNull();
    expect(fitRectToRect({ ...rect, left: Number.NaN }, rect)).toBeNull();
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
    expect(commit).toContain(
      "scale(var(--vote-ink-scale-x, 1), var(--vote-ink-scale-y, 1))",
    );
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
    expect(css).toMatch(/\.vote-draw-heading \{[\s\S]*?pointer-events: none;/u);
    expect(inkPad).toContain('tintContext.fillStyle = "#ff4b1f";');
  });
});

function projectRect(
  source: MorphRect,
  transform: InkMorphTransform,
  progress: number,
): MorphRect {
  const scaleX = 1 + (transform.scaleX - 1) * progress;
  const scaleY = 1 + (transform.scaleY - 1) * progress;
  const translateX = transform.translateX * progress;
  const translateY = transform.translateY * progress;
  return {
    left:
      transform.originX +
      translateX +
      (source.left - transform.originX) * scaleX,
    top:
      transform.originY +
      translateY +
      (source.top - transform.originY) * scaleY,
    width: source.width * scaleX,
    height: source.height * scaleY,
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
