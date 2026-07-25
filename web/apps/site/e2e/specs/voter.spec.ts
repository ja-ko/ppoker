import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  CARD_STROKES,
  MODEL_READY_TIMEOUT_MS,
  canvasInkCenter,
  commandSummary,
  drawCard,
  expectCommandSummary,
  expectNoHorizontalOverflow,
  expectNoVerticalOverflow,
  gotoVoterFixture,
  publishVoterFixture,
  settlePaint,
  startMouseStroke,
} from "./voter-helpers";

const stage = (page: Page) => page.getByTestId("drawing-stage");
const surface = (page: Page) =>
  page.getByRole("region", { name: /Handwriting surface/u });

async function commitMorphGeometry(page: Page): Promise<{
  readonly aspectRatioError: number;
  readonly firstTransform: string | null;
  readonly layerBlend: { readonly base: string; readonly tint: string };
  readonly layerOpacity: {
    readonly end: { readonly base: number; readonly tint: number };
    readonly middle: { readonly base: number; readonly tint: number };
    readonly start: { readonly base: number; readonly tint: number };
  };
  readonly originError: { readonly left: number; readonly top: number };
  readonly scale: number;
  readonly targetError: {
    readonly centerX: number;
    readonly centerY: number;
    readonly overflowHeight: number;
    readonly overflowWidth: number;
  };
  readonly tint: {
    readonly blue: number;
    readonly green: number;
    readonly red: number;
  };
}> {
  return stage(page).evaluate((drawingStage) => {
    const handwritingSurface =
      drawingStage.querySelector<HTMLElement>(".ink-surface");
    const visual = drawingStage.querySelector<HTMLElement>(".ink-visual");
    const base =
      drawingStage.querySelector<HTMLCanvasElement>(".ink-canvas--base");
    const tint =
      drawingStage.querySelector<HTMLCanvasElement>(".ink-canvas--tint");
    const output = drawingStage.querySelector<HTMLOutputElement>(
      "output.vote-result--morphing",
    );
    if (
      handwritingSurface === null ||
      visual === null ||
      base === null ||
      tint === null ||
      output === null
    ) {
      throw new Error("Commit morph elements are missing.");
    }

    const stageStyle = getComputedStyle(drawingStage);
    const number = (property: string): number => {
      const value = Number.parseFloat(stageStyle.getPropertyValue(property));
      if (!Number.isFinite(value)) {
        throw new Error(`${property} is not finite.`);
      }
      return value;
    };
    const originX = number("--vote-ink-origin-x");
    const originY = number("--vote-ink-origin-y");
    const scale = number("--vote-ink-scale");

    const context = base.getContext("2d");
    const tintContext = tint.getContext("2d");
    if (context === null || tintContext === null) {
      throw new Error("Commit canvases have no 2D context.");
    }
    const pixels = context.getImageData(0, 0, base.width, base.height).data;
    let minX = base.width;
    let minY = base.height;
    let maxX = -1;
    let maxY = -1;
    for (let offset = 3; offset < pixels.length; offset += 4) {
      if (pixels[offset] === 0) {
        continue;
      }
      const pixel = (offset - 3) / 4;
      const x = pixel % base.width;
      const y = Math.floor(pixel / base.width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    if (maxX < minX || maxY < minY) {
      throw new Error("Commit ink is empty.");
    }
    const surfaceBounds = handwritingSurface.getBoundingClientRect();
    const pixelScaleX = surfaceBounds.width / base.width;
    const pixelScaleY = surfaceBounds.height / base.height;
    const source = {
      left: minX * pixelScaleX,
      top: minY * pixelScaleY,
      width: (maxX - minX + 1) * pixelScaleX,
      height: (maxY - minY + 1) * pixelScaleY,
    };

    const originalAnimation = output.style.getPropertyValue("animation");
    const originalPriority = output.style.getPropertyPriority("animation");
    output.style.setProperty("animation", "none", "important");
    const range = document.createRange();
    range.selectNodeContents(output);
    const targetBounds = range.getBoundingClientRect();
    if (originalAnimation.length === 0) {
      output.style.removeProperty("animation");
    } else {
      output.style.setProperty(
        "animation",
        originalAnimation,
        originalPriority,
      );
    }
    const target = {
      left: targetBounds.left - surfaceBounds.left,
      top: targetBounds.top - surfaceBounds.top,
      width: targetBounds.width,
      height: targetBounds.height,
    };

    const tintPixels = tintContext.getImageData(
      0,
      0,
      tint.width,
      tint.height,
    ).data;
    let tintOffset = 3;
    for (let offset = 7; offset < tintPixels.length; offset += 4) {
      if ((tintPixels[offset] ?? 0) > (tintPixels[tintOffset] ?? 0)) {
        tintOffset = offset;
      }
    }
    if (tintPixels[tintOffset] === 0) {
      throw new Error("Tint canvas is empty.");
    }

    const visualAnimation = visual.getAnimations()[0];
    const effect = visualAnimation?.effect;
    const firstTransform =
      effect instanceof KeyframeEffect
        ? String(effect.getKeyframes()[0]?.["transform"] ?? "")
        : null;
    if (visualAnimation === undefined) {
      throw new Error("Commit transform animation is missing.");
    }
    const visualAnimationState = {
      currentTime: visualAnimation.currentTime,
      playState: visualAnimation.playState,
    };
    visualAnimation.pause();
    visualAnimation.currentTime = 460;
    const visualStyle = getComputedStyle(visual);
    const matrix = new DOMMatrixReadOnly(visualStyle.transform);
    const transformOrigin = visualStyle.transformOrigin.split(" ");
    const transformOriginX = Number.parseFloat(transformOrigin[0] ?? "");
    const transformOriginY = Number.parseFloat(transformOrigin[1] ?? "");
    if (
      !Number.isFinite(transformOriginX) ||
      !Number.isFinite(transformOriginY)
    ) {
      throw new Error("Commit transform origin is not finite.");
    }
    const projectPoint = (x: number, y: number) => ({
      x:
        transformOriginX +
        matrix.a * (x - transformOriginX) +
        matrix.c * (y - transformOriginY) +
        matrix.e,
      y:
        transformOriginY +
        matrix.b * (x - transformOriginX) +
        matrix.d * (y - transformOriginY) +
        matrix.f,
    });
    const projectedTopLeft = projectPoint(source.left, source.top);
    const projectedBottomRight = projectPoint(
      source.left + source.width,
      source.top + source.height,
    );
    const projected = {
      height: Math.abs(projectedBottomRight.y - projectedTopLeft.y),
      left: Math.min(projectedTopLeft.x, projectedBottomRight.x),
      top: Math.min(projectedTopLeft.y, projectedBottomRight.y),
      width: Math.abs(projectedBottomRight.x - projectedTopLeft.x),
    };
    visualAnimation.currentTime = visualAnimationState.currentTime;
    if (visualAnimationState.playState === "running") {
      visualAnimation.play();
    }
    const baseAnimation = base.getAnimations()[0];
    const tintAnimation = tint.getAnimations()[0];
    if (baseAnimation === undefined || tintAnimation === undefined) {
      throw new Error("Commit tint animations are missing.");
    }
    const animationState = [baseAnimation, tintAnimation].map((candidate) => ({
      currentTime: candidate.currentTime,
      playState: candidate.playState,
    }));
    baseAnimation.pause();
    tintAnimation.pause();
    const opacityAt = (time: number) => {
      baseAnimation.currentTime = time;
      tintAnimation.currentTime = time;
      return {
        base: Number.parseFloat(getComputedStyle(base).opacity),
        tint: Number.parseFloat(getComputedStyle(tint).opacity),
      };
    };
    const layerOpacity = {
      start: opacityAt(0),
      middle: opacityAt(230),
      end: opacityAt(460),
    };
    for (const [index, candidate] of [baseAnimation, tintAnimation].entries()) {
      const state = animationState[index];
      if (state === undefined) {
        continue;
      }
      candidate.currentTime = state.currentTime;
      if (state.playState === "running") {
        candidate.play();
      }
    }
    return {
      aspectRatioError: Math.abs(
        projected.width / projected.height - source.width / source.height,
      ),
      firstTransform,
      layerBlend: {
        base: getComputedStyle(base).mixBlendMode,
        tint: getComputedStyle(tint).mixBlendMode,
      },
      layerOpacity,
      originError: {
        left: Math.abs(originX - source.left),
        top: Math.abs(originY - source.top),
      },
      scale,
      targetError: {
        centerX: Math.abs(
          projected.left +
            projected.width / 2 -
            (target.left + target.width / 2),
        ),
        centerY: Math.abs(
          projected.top +
            projected.height / 2 -
            (target.top + target.height / 2),
        ),
        overflowHeight: Math.max(0, projected.height - target.height),
        overflowWidth: Math.max(0, projected.width - target.width),
      },
      tint: {
        red: tintPixels[tintOffset - 3] ?? 0,
        green: tintPixels[tintOffset - 2] ?? 0,
        blue: tintPixels[tintOffset - 1] ?? 0,
      },
    };
  });
}

async function expectMinimumTouchTargets(page: Page): Promise<void> {
  const undersizedTargets = await page
    .locator("button:visible, a:visible")
    .evaluateAll((targets) =>
      targets.flatMap((target) => {
        const bounds = target.getBoundingClientRect();
        return bounds.width < 44 || bounds.height < 44
          ? [
              `${target.tagName.toLowerCase()}:${target.textContent.trim()}:${bounds.width.toFixed(1)}x${bounds.height.toFixed(1)}`,
            ]
          : [];
      }),
    );
  expect(undersizedTargets).toEqual([]);
}

async function expectFullyWithinVisualViewport(
  locator: Locator,
): Promise<void> {
  await expect(locator).toBeAttached();
  const geometry = await locator.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const right = left + (viewport?.width ?? window.innerWidth);
    const bottom = top + (viewport?.height ?? window.innerHeight);
    return {
      bounds: {
        bottom: bounds.bottom,
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
      },
      contained:
        bounds.left >= left - 1 &&
        bounds.right <= right + 1 &&
        bounds.top >= top - 1 &&
        bounds.bottom <= bottom + 1,
      text: element.textContent.trim() || element.tagName,
      viewport: { bottom, left, right, top },
      visible:
        bounds.width > 0 &&
        bounds.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden",
    };
  });
  expect(geometry.visible, JSON.stringify(geometry)).toBe(true);
  expect(geometry.contained, JSON.stringify(geometry)).toBe(true);
}

async function expectInteractiveControlsWithinViewport(
  page: Page,
): Promise<void> {
  const controls = page.locator(
    ".vote-route button:visible, .vote-route a:visible",
  );
  for (const control of await controls.all()) {
    await expectFullyWithinVisualViewport(control);
  }
}

async function expectRenderedTextContained(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const geometry = await locator.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    const textRects = [...range.getClientRects()]
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        top: rect.top,
      }));
    return {
      bounds: {
        bottom: bounds.bottom,
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
      },
      textRects,
      textTransform: getComputedStyle(element).textTransform,
    };
  });
  expect(geometry.textTransform).toBe("uppercase");
  expect(geometry.textRects.length, JSON.stringify(geometry)).toBeGreaterThan(
    0,
  );
  expect(
    geometry.textRects.every(
      (rect) =>
        rect.left >= geometry.bounds.left &&
        rect.right <= geometry.bounds.right &&
        rect.top >= geometry.bounds.top &&
        rect.bottom <= geometry.bounds.bottom,
    ),
    JSON.stringify(geometry),
  ).toBe(true);
}

async function expectUsableHandwritingSurface(page: Page): Promise<void> {
  const handwritingSurface = surface(page);
  await expect(handwritingSurface).toHaveAttribute("aria-disabled", "false");
  await expectFullyWithinVisualViewport(handwritingSurface);
  const bounds = await handwritingSurface.boundingBox();
  if (bounds === null) {
    throw new Error("Handwriting surface has no browser bounds.");
  }
  expect(bounds.width).toBeGreaterThanOrEqual(200);
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  const coverage = await handwritingSurface.evaluate((element) => {
    const stage = element.closest<HTMLElement>(".vote-draw-stage");
    const heading = stage?.querySelector<HTMLElement>(".vote-draw-heading");
    if (stage === null || heading === null || heading === undefined) {
      throw new Error("Handwriting stage or heading is missing.");
    }
    const surfaceBounds = element.getBoundingClientRect();
    const stageBounds = stage.getBoundingClientRect();
    const headingBounds = heading.getBoundingClientRect();
    const headingHit = document.elementFromPoint(
      headingBounds.left + headingBounds.width / 2,
      headingBounds.top + headingBounds.height / 2,
    );
    return {
      bottom: Math.abs(surfaceBounds.bottom - stageBounds.bottom),
      headingHeight: headingBounds.height,
      headingHitsSurface:
        headingHit === element || element.contains(headingHit),
      headingPointerEvents: getComputedStyle(heading).pointerEvents,
      headingTop: Math.abs(headingBounds.top - stageBounds.top),
      left: Math.abs(surfaceBounds.left - stageBounds.left),
      right: Math.abs(surfaceBounds.right - stageBounds.right),
      top: Math.abs(surfaceBounds.top - stageBounds.top),
    };
  });
  expect(coverage.headingHitsSurface).toBe(true);
  expect(coverage.headingPointerEvents).toBe("none");
  expect(coverage.headingTop).toBeLessThanOrEqual(1.5);
  expect(coverage.headingHeight).toBeLessThan(bounds.height / 2);
  expect(coverage.left).toBeLessThanOrEqual(1.5);
  expect(coverage.right).toBeLessThanOrEqual(1.5);
  expect(coverage.top).toBeLessThanOrEqual(1.5);
  expect(coverage.bottom).toBeLessThanOrEqual(1.5);
}

async function expectCountdownControlsSeparated(page: Page): Promise<void> {
  const overlaps = await page.evaluate(() => {
    const box = (selector: string): DOMRect => {
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null) {
        throw new Error(`${selector} is missing.`);
      }
      return element.getBoundingClientRect();
    };
    const intersects = (left: DOMRect, right: DOMRect): boolean =>
      left.left < right.right - 1 &&
      left.right > right.left + 1 &&
      left.top < right.bottom - 1 &&
      left.bottom > right.top + 1;
    const phase = box(".vote-phase-button");
    const cancel = box(".vote-countdown-cancel");
    const context = box(".vote-room-context");
    const drawingHeading = box(".vote-draw-heading");
    const drawingStage = box(".vote-draw-stage");
    return {
      cancelContext: intersects(cancel, context),
      cancelHeading: intersects(cancel, drawingHeading),
      cancelStage: intersects(cancel, drawingStage),
      phaseCancel: intersects(phase, cancel),
      phaseContext: intersects(phase, context),
      phaseHeading: intersects(phase, drawingHeading),
      phaseStage: intersects(phase, drawingStage),
    };
  });
  expect(overlaps).toEqual({
    cancelContext: false,
    cancelHeading: false,
    cancelStage: false,
    phaseCancel: false,
    phaseContext: false,
    phaseHeading: false,
    phaseStage: false,
  });
}

test.describe("voter real recognition", () => {
  test.use({ hasTouch: true, viewport: { height: 844, width: 390 } });

  test("plain HTTP loads the committed model and morphs touch and pointer votes", async ({
    page,
  }) => {
    const responses = new Map<string, number>();
    page.on("response", (response) => {
      responses.set(new URL(response.url()).pathname, response.status());
    });

    await gotoVoterFixture(page, "playing");
    expect(new URL(page.url()).protocol).toBe("http:");
    for (const asset of [
      "/models/digits-crnn.json",
      "/models/digits-crnn.onnx",
      "/ort/ort-wasm-simd-threaded.mjs",
      "/ort/ort-wasm-simd-threaded.wasm",
    ]) {
      expect(
        responses.get(asset),
        `${asset} should load from the harness`,
      ).toBe(200);
    }

    await drawCard(page, "5", true);
    await expect(stage(page)).toHaveClass(/vote-draw-stage--committing/u);
    const inkVisual = page.locator(".ink-visual");
    await expect(inkVisual).toHaveCSS("animation-name", "vote-ink-commit");
    const morphingResult = page.locator("output.vote-result--morphing");
    await expect(morphingResult).toHaveText("5");
    await expect(morphingResult).toHaveCSS(
      "animation-name",
      "vote-type-emerge",
    );
    await expect
      .poll(() =>
        stage(page).evaluate((element) =>
          getComputedStyle(element).getPropertyValue("--vote-ink-scale"),
        ),
      )
      .not.toBe("");
    const morph = await commitMorphGeometry(page);
    expect(morph.firstTransform).toBe("translate(0px) scale(1)");
    expect(morph.layerBlend).toEqual({
      base: "plus-lighter",
      tint: "plus-lighter",
    });
    expect(morph.layerOpacity.start).toEqual({ base: 1, tint: 0 });
    expect(morph.layerOpacity.middle.base).toBeGreaterThan(0);
    expect(morph.layerOpacity.middle.base).toBeLessThan(1);
    expect(morph.layerOpacity.middle.tint).toBeGreaterThan(0);
    expect(morph.layerOpacity.middle.tint).toBeLessThan(1);
    expect(
      morph.layerOpacity.middle.base + morph.layerOpacity.middle.tint,
    ).toBeCloseTo(1, 3);
    expect(morph.layerOpacity.end).toEqual({ base: 0, tint: 1 });
    expect(morph.originError.left).toBeLessThanOrEqual(1);
    expect(morph.originError.top).toBeLessThanOrEqual(1);
    expect(morph.aspectRatioError).toBeLessThanOrEqual(0.001);
    expect(morph.targetError.centerX).toBeLessThanOrEqual(0.5);
    expect(morph.targetError.centerY).toBeLessThanOrEqual(0.5);
    expect(morph.targetError.overflowWidth).toBeLessThanOrEqual(1);
    expect(morph.targetError.overflowHeight).toBeLessThanOrEqual(1);
    expect(morph.scale).toBeGreaterThan(0);
    expect(morph.tint).toEqual({ blue: 31, green: 75, red: 255 });
    await expect(stage(page)).toHaveClass(/vote-draw-stage--committed/u);
    await expect(page.getByLabel("Current vote 5")).toBeVisible();
    await expect(page.getByLabel("Current vote 5")).not.toHaveClass(
      /vote-result--handwritten/u,
    );
    await expect(page.getByLabel("Current vote 5")).toHaveCSS(
      "overflow",
      "visible",
    );

    await drawCard(page, "13");
    await expect(stage(page)).toHaveClass(/vote-draw-stage--committing/u);
    await expect(page.locator("output.vote-result--morphing")).toHaveText("13");
    await expect(stage(page)).toHaveClass(/vote-draw-stage--committed/u);
    await expect(page.getByLabel("Current vote 13")).toBeVisible();
    await expectCommandSummary(page, [
      { args: ["5"], name: "vote" },
      { args: ["13"], name: "vote" },
    ]);
  });
});

test("invalid real-model ink retracts an existing vote and shakes to transparent", async ({
  page,
}) => {
  await gotoVoterFixture(page, "existing-vote");
  await expect(page.getByLabel("Current vote 5")).toBeVisible();

  await drawCard(page, "2");
  await expect(stage(page)).toHaveClass(/vote-draw-stage--rejecting/u);
  await expect(page.locator(".ink-visual")).toHaveCSS(
    "animation-name",
    "vote-ink-reject",
  );
  const rejectionFrames = await page.locator(".ink-visual").evaluate((canvas) =>
    canvas.getAnimations().flatMap((animation) => {
      const effect = animation.effect;
      return effect instanceof KeyframeEffect
        ? effect.getKeyframes().map((frame) => ({
            opacity: frame["opacity"] ?? null,
            transform: frame["transform"] ?? null,
          }))
        : [];
    }),
  );
  expect(
    new Set(rejectionFrames.map(({ transform }) => transform)).size,
  ).toBeGreaterThan(2);
  expect(rejectionFrames.some(({ opacity }) => opacity === "0")).toBe(true);
  await expectCommandSummary(page, [{ args: [], name: "retractVote" }]);
  await expect(stage(page)).toHaveClass(/vote-draw-stage--empty/u);
  await expect(page.getByLabel("Current vote 5")).toHaveCount(0);
});

test("final-vote countdown cancellation, replacement, and rejection stay deterministic", async ({
  page,
}) => {
  await gotoVoterFixture(page, "final-vote");
  await page.clock.install({ time: new Date("2026-07-24T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-07-24T12:00:00.100Z"));

  await page.getByRole("button", { name: "Vote 5" }).click();
  await expect(page.getByRole("button", { name: "Reveal in 3" })).toBeVisible();
  await expectRenderedTextContained(page.locator(".vote-countdown-cancel"));
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(
    page.getByRole("button", { name: "Reveal", exact: true }),
  ).toBeVisible();
  await page.clock.runFor(4_000);
  expect(
    (await commandSummary(page)).some(({ name }) => name === "reveal"),
  ).toBe(false);

  await page.getByRole("button", { name: "Vote 8" }).click();
  await expect(page.getByRole("button", { name: "Reveal in 3" })).toBeVisible();
  await startMouseStroke(page, CARD_STROKES["5"][0]);
  await expect(
    page.getByRole("button", { name: "Reveal", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await publishVoterFixture(page, "final-voted");
  await page.mouse.up();
  await page.clock.runFor(700);
  await expectCommandSummary(page, [
    { args: ["5"], name: "vote" },
    { args: ["8"], name: "vote" },
    { args: ["5"], name: "vote" },
  ]);
  await expect(page.getByRole("button", { name: "Reveal in 3" })).toBeVisible();

  await drawCard(page, "2");
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await page.clock.runFor(1_100);
  await expect(stage(page)).toHaveClass(/vote-draw-stage--rejecting/u);
  await expectCommandSummary(page, [
    { args: ["5"], name: "vote" },
    { args: ["8"], name: "vote" },
    { args: ["5"], name: "vote" },
    { args: [], name: "retractVote" },
  ]);
  await page.clock.runFor(4_000);
  expect(
    (await commandSummary(page)).some(({ name }) => name === "reveal"),
  ).toBe(false);
});

test("countdown expiry reveals once", async ({ page }) => {
  await gotoVoterFixture(page, "final-vote", { waitForRecognizer: false });
  await page.clock.install({ time: new Date("2026-07-24T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-07-24T12:00:00.100Z"));
  await page.getByRole("button", { name: "Vote 5" }).click();
  await expect(page.getByRole("button", { name: "Reveal in 3" })).toBeVisible();

  await page.clock.runFor(3_000);
  await expectCommandSummary(page, [
    { args: ["5"], name: "vote" },
    { args: [], name: "reveal" },
  ]);
  await page.clock.runFor(6_000);
  await expectCommandSummary(page, [
    { args: ["5"], name: "vote" },
    { args: [], name: "reveal" },
  ]);
});

test("manual reveal at the timeout boundary cannot duplicate", async ({
  page,
}) => {
  await gotoVoterFixture(page, "final-vote", { waitForRecognizer: false });
  await page.clock.install({ time: new Date("2026-07-24T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-07-24T12:00:00.100Z"));
  await page.getByRole("button", { name: "Vote 8" }).click();
  await page.clock.runFor(2_999);
  await page.getByRole("button", { name: "Reveal in 1" }).click();
  await page.clock.runFor(3_001);

  await expectCommandSummary(page, [
    { args: ["8"], name: "vote" },
    { args: [], name: "reveal" },
  ]);
});

test("reveal and reset dialogs focus safely and issue only confirmed commands", async ({
  page,
}) => {
  await gotoVoterFixture(page, "playing", { waitForRecognizer: false });
  const phaseButton = page.getByRole("button", { name: "Reveal", exact: true });
  await phaseButton.click();
  const revealDialog = page.getByRole("dialog", {
    name: "Reveal with missing votes?",
  });
  await expect(revealDialog).toBeVisible();
  await expect(
    revealDialog.getByRole("button", { name: "Cancel" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(revealDialog).toHaveCount(0);
  await expect(phaseButton).toBeFocused();

  await phaseButton.click();
  await revealDialog.getByRole("button", { name: "Reveal anyway" }).click();
  await expectCommandSummary(page, [{ args: [], name: "reveal" }]);

  await publishVoterFixture(page, "revealed");
  const resetButton = page.getByRole("button", { name: "Reset", exact: true });
  await resetButton.click();
  const resetDialog = page.getByRole("dialog", { name: "Start new round?" });
  await expect(
    resetDialog.getByRole("button", { name: "Cancel" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(resetDialog).toHaveCount(0);
  await expect(resetButton).toBeFocused();
  await resetButton.click();
  await resetDialog.getByRole("button", { name: "Start new round" }).click();
  await expectCommandSummary(page, [
    { args: [], name: "reveal" },
    { args: [], name: "startNewRound" },
  ]);
});

test("revealed rounds use the contained dedicated voter result view", async ({
  page,
}) => {
  await page.setViewportSize({ height: 664, width: 390 });
  await gotoVoterFixture(page, "playing");
  await publishVoterFixture(page, "revealed");
  await settlePaint(page);

  const result = page.locator(".vote-result-view");
  await expect(result).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Round result" }),
  ).toBeVisible();
  await expect(page.getByLabel("Final average 6.5")).toHaveText("6.5");
  await expect(page.locator(".vote-final-own-vote")).toContainText(
    "Your vote 5",
  );
  await expect(
    page.getByText("Vote distribution", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: /Vote distribution:/u }),
  ).toBeVisible();
  await expect(page.getByRole("group", { name: "Voting cards" })).toHaveCount(
    0,
  );
  await expect(surface(page)).toHaveCount(0);
  await expect(page.locator(".vote-responses, .vote-slots")).toHaveCount(0);
  await expect(page.getByText("Responses locked", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText("Ready Peer", { exact: true })).toHaveCount(0);

  await expectFullyWithinVisualViewport(result);
  await expectFullyWithinVisualViewport(page.locator(".vote-name"));
  await expectInteractiveControlsWithinViewport(page);
  await expectNoHorizontalOverflow(page);
  await expectNoVerticalOverflow(page);
});

test("phone layouts keep voter controls and identity in the viewport", async ({
  page,
}) => {
  const portraitViewports = [
    { height: 664, width: 390, vote: "5" },
    { height: 568, width: 320, vote: "8" },
  ] as const;

  await page.setViewportSize(portraitViewports[0]);
  await gotoVoterFixture(page, "long-deck");
  for (const viewport of portraitViewports) {
    await page.setViewportSize(viewport);
    await publishVoterFixture(page, "long-deck");
    await settlePaint(page);
    await expectNoHorizontalOverflow(page);
    await expectNoVerticalOverflow(page);

    await expectFullyWithinVisualViewport(page.locator(".vote-room-context"));
    await expectFullyWithinVisualViewport(page.locator(".vote-phase-control"));
    await expectFullyWithinVisualViewport(page.locator(".vote-deck-panel"));
    await expectFullyWithinVisualViewport(page.locator(".vote-responses"));
    await expectFullyWithinVisualViewport(page.locator(".vote-name"));
    await expectUsableHandwritingSurface(page);
    await expectInteractiveControlsWithinViewport(page);
    await expectMinimumTouchTargets(page);

    const longCard = page.getByRole("button", {
      name: "Vote Needs another conversation with stakeholders",
    });
    await expect(longCard).toContainText(
      "Needs another conversation with stakeholders",
    );
    const longCardGeometry = await longCard.evaluate((button) => {
      const deck = button.closest<HTMLElement>(".vote-deck");
      if (deck === null) {
        throw new Error("Long card deck is missing.");
      }
      const cardBounds = button.getBoundingClientRect();
      const deckBounds = deck.getBoundingClientRect();
      const textRange = document.createRange();
      textRange.selectNodeContents(button);
      const textLines = [...textRange.getClientRects()].filter(
        (line) => line.width > 0 && line.height > 0,
      );
      return {
        cardRight: cardBounds.right,
        deckLeft: deckBounds.left,
        deckRight: deckBounds.right,
        heightFits: button.scrollHeight <= button.clientHeight + 1,
        left: cardBounds.left,
        lineCount: textLines.length,
        linesContained: textLines.every(
          (line) =>
            line.left >= cardBounds.left - 1 &&
            line.right <= cardBounds.right + 1,
        ),
        width: cardBounds.width,
        widthFits: button.scrollWidth <= button.clientWidth + 1,
      };
    });
    expect(longCardGeometry.left).toBeGreaterThanOrEqual(
      longCardGeometry.deckLeft - 1,
    );
    expect(longCardGeometry.cardRight).toBeLessThanOrEqual(
      longCardGeometry.deckRight + 1,
    );
    expect(longCardGeometry.width).toBeGreaterThanOrEqual(
      (longCardGeometry.deckRight - longCardGeometry.deckLeft) * 0.65,
    );
    expect(longCardGeometry.lineCount).toBeGreaterThan(0);
    expect(longCardGeometry.lineCount).toBeLessThanOrEqual(3);
    expect(longCardGeometry).toMatchObject({
      heightFits: true,
      linesContained: true,
      widthFits: true,
    });

    await publishVoterFixture(page, "final-vote");
    await page
      .getByRole("button", { name: `Vote ${viewport.vote}`, exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: /Reveal in [123]/u }),
    ).toBeVisible();
    const cancel = page.getByRole("button", { name: "Cancel" });
    await expect(cancel).toBeVisible();
    await expectRenderedTextContained(cancel);
    await expectCountdownControlsSeparated(page);
    await expectFullyWithinVisualViewport(page.locator(".vote-phase-control"));
    await expectFullyWithinVisualViewport(page.locator(".vote-name"));
    await expectInteractiveControlsWithinViewport(page);
    await expectMinimumTouchTargets(page);
    await expectNoHorizontalOverflow(page);
    await expectNoVerticalOverflow(page);
    await cancel.click();
  }
});

test("short landscape keeps drawing and deck interaction on-page", async ({
  page,
}) => {
  await page.setViewportSize({ height: 390, width: 844 });
  await gotoVoterFixture(page, "long-deck");
  await settlePaint(page);
  await expectNoHorizontalOverflow(page);
  await expectNoVerticalOverflow(page);
  await expectFullyWithinVisualViewport(page.locator(".vote-room-context"));
  await expectFullyWithinVisualViewport(page.locator(".vote-phase-control"));
  await expectFullyWithinVisualViewport(page.locator(".vote-name"));
  await expectUsableHandwritingSurface(page);
  await expectMinimumTouchTargets(page);

  const longLandscapeCard = page.getByRole("button", {
    name: "Vote Needs another conversation with stakeholders",
  });
  await longLandscapeCard.scrollIntoViewIfNeeded();
  await expect(longLandscapeCard).toBeVisible();
  await longLandscapeCard.click();
  await expectCommandSummary(page, [
    {
      args: ["Needs another conversation with stakeholders"],
      name: "vote",
    },
  ]);
  await expectNoHorizontalOverflow(page);
  await expectNoVerticalOverflow(page);

  await publishVoterFixture(page, "final-vote");
  await page.getByRole("button", { name: "Vote 5", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Reveal in [123]/u }),
  ).toBeVisible();
  const cancel = page.getByRole("button", { name: "Cancel" });
  await expectRenderedTextContained(cancel);
  await expectCountdownControlsSeparated(page);
  await expectFullyWithinVisualViewport(page.locator(".vote-phase-control"));
  await expectInteractiveControlsWithinViewport(page);
  await expectMinimumTouchTargets(page);
  await expectNoHorizontalOverflow(page);
  await expectNoVerticalOverflow(page);
});

test("extremely short narrow viewports scroll instead of clipping controls", async ({
  page,
}) => {
  await page.setViewportSize({ height: 320, width: 390 });
  await gotoVoterFixture(page, "long-deck");
  await expectNoHorizontalOverflow(page);
  await expectUsableHandwritingSurface(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollHeight >
          document.documentElement.clientHeight,
      ),
    )
    .toBe(true);

  await page.locator(".vote-footer").scrollIntoViewIfNeeded();
  await expect(page.locator(".vote-name")).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
});

test("compact portrait drawing stays aligned without document scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ height: 664, width: 390 });
  await gotoVoterFixture(page, "playing");
  await expectNoVerticalOverflow(page);

  const surfaceBox = await surface(page).boundingBox();
  if (surfaceBox === null) {
    throw new Error("Handwriting surface has no browser bounds.");
  }
  expect(surfaceBox.y).toBeGreaterThanOrEqual(0);
  await drawCard(page, "5");
  await settlePaint(page);
  const glyphGeometry = await page
    .getByLabel("Current vote 5")
    .evaluate((glyph) => {
      const drawingStage = glyph.closest(".vote-draw-stage");
      if (drawingStage === null) {
        throw new Error("Current vote drawing stage is missing.");
      }
      const glyphBounds = glyph.getBoundingClientRect();
      const stageBounds = drawingStage.getBoundingClientRect();
      return {
        bottom: glyphBounds.bottom <= stageBounds.bottom + 1,
        left: glyphBounds.left >= stageBounds.left - 1,
        right: glyphBounds.right <= stageBounds.right + 1,
        top: glyphBounds.top >= stageBounds.top - 1,
      };
    });
  expect(glyphGeometry).toEqual({
    bottom: true,
    left: true,
    right: true,
    top: true,
  });
  const ink = await canvasInkCenter(page);
  expect(ink.alphaPixels).toBeGreaterThan(100);
  expect(ink.x).toBeGreaterThan(surfaceBox.width * 0.35);
  expect(ink.x).toBeLessThan(surfaceBox.width * 0.65);
  expect(ink.y).toBeGreaterThan(surfaceBox.height * 0.25);
  expect(ink.y).toBeLessThan(surfaceBox.height * 0.8);
  await expectNoVerticalOverflow(page);
  await expectCommandSummary(page, [{ args: ["5"], name: "vote" }]);
});

test("reduced motion still produces the recognized vote", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await gotoVoterFixture(page, "playing");
  await page.evaluate(() => {
    const captureWindow = window as typeof window & {
      __reducedVoteEffect?: {
        readonly animationName: string;
        readonly effectMotion: string | null;
      };
    };
    const drawingStage = document.querySelector<HTMLElement>(
      "[data-testid='drawing-stage']",
    );
    if (drawingStage === null) {
      throw new Error("Drawing stage is missing.");
    }
    const observer = new MutationObserver(() => {
      if (!drawingStage.classList.contains("vote-draw-stage--committing")) {
        return;
      }
      const inkVisual = drawingStage.querySelector(".ink-visual");
      if (inkVisual === null) {
        throw new Error("Vote ink is missing.");
      }
      captureWindow.__reducedVoteEffect = {
        animationName: getComputedStyle(inkVisual).animationName,
        effectMotion: drawingStage.dataset["effectMotion"] ?? null,
      };
      observer.disconnect();
    });
    observer.observe(drawingStage, {
      attributeFilter: ["class", "data-effect-motion"],
      attributes: true,
    });
  });

  await drawCard(page, "5");
  await expect(stage(page)).toHaveClass(/vote-draw-stage--committed/u, {
    timeout: MODEL_READY_TIMEOUT_MS,
  });
  expect(
    await page.evaluate(
      () =>
        (
          window as typeof window & {
            __reducedVoteEffect?: {
              readonly animationName: string;
              readonly effectMotion: string | null;
            };
          }
        ).__reducedVoteEffect,
    ),
  ).toEqual({
    animationName: "vote-ink-commit-reduced",
    effectMotion: "reduced",
  });
  await expect(page.getByLabel("Current vote 5")).toBeVisible();
  await expectCommandSummary(page, [{ args: ["5"], name: "vote" }]);
});
