import { expect, test, type Page } from "@playwright/test";

import {
  CARD_STROKES,
  MODEL_READY_TIMEOUT_MS,
  canvasInkCenter,
  commandSummary,
  drawCard,
  expectCommandSummary,
  expectNoHorizontalOverflow,
  gotoVoterFixture,
  publishVoterFixture,
  settlePaint,
  startMouseStroke,
} from "./voter-helpers";

const stage = (page: Page) => page.getByTestId("drawing-stage");
const surface = (page: Page) =>
  page.getByRole("region", { name: /Handwriting surface/u });

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
    await expect(page.locator("canvas.vote-ink")).toHaveCSS(
      "animation-name",
      "vote-ink-commit",
    );
    await expect(page.locator("output.vote-result--morphing")).toHaveText("5");
    await expect(stage(page)).toHaveClass(/vote-draw-stage--committed/u);
    await expect(page.getByLabel("Current vote 5")).toBeVisible();

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
  await expect(page.locator("canvas.vote-ink")).toHaveCSS(
    "animation-name",
    "vote-ink-reject",
  );
  const rejectionFrames = await page
    .locator("canvas.vote-ink")
    .evaluate((canvas) =>
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
  const resetDialog = page.getByRole("dialog", { name: "Reset this round?" });
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

test("phone and short-landscape layouts preserve the drawing-first interaction", async ({
  page,
}) => {
  await gotoVoterFixture(page, "long-deck");
  for (const viewport of [
    { height: 844, width: 390 },
    { height: 568, width: 320 },
    { height: 390, width: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await settlePaint(page);
    await expectNoHorizontalOverflow(page);

    const geometry = await page.evaluate(() => {
      const box = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (element === null) {
          throw new Error(`${selector} is missing.`);
        }
        const bounds = element.getBoundingClientRect();
        return {
          bottom: bounds.bottom,
          height: bounds.height,
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          width: bounds.width,
        };
      };
      const headerContext = box(".vote-room-context");
      const phaseControl = box(".vote-phase-control");
      const drawing = box(".vote-draw-stage");
      const deck = box(".vote-deck-panel");
      const writingSurface = box(".ink-surface");
      return {
        deck,
        drawing,
        headerSeparated:
          headerContext.right <= phaseControl.left + 1 ||
          phaseControl.right <= headerContext.left + 1,
        writingSurface,
      };
    });
    expect(geometry.headerSeparated).toBe(true);
    expect(geometry.writingSurface.height).toBeGreaterThanOrEqual(250);
    expect(geometry.drawing.width * geometry.drawing.height).toBeGreaterThan(
      geometry.deck.width * geometry.deck.height,
    );

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

    await expectMinimumTouchTargets(page);

    if (viewport.width === 320) {
      await page.evaluate(() => {
        window.scrollTo(0, 0);
      });
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      await publishVoterFixture(page, "final-vote");
      await page.getByRole("button", { name: "Vote 5" }).evaluate((button) => {
        if (!(button instanceof HTMLButtonElement)) {
          throw new Error("Vote 5 target is not a button.");
        }
        button.click();
      });
      await expect(
        page.getByRole("button", { name: "Reveal in 3" }),
      ).toBeVisible();
      const cancel = page.getByRole("button", { name: "Cancel" });
      await expect(cancel).toBeVisible();
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
        const cancelButton = box(".vote-countdown-cancel");
        const drawingHeading = box(".vote-draw-heading");
        const drawingStage = box(".vote-draw-stage");
        return {
          cancelHeading: intersects(cancelButton, drawingHeading),
          cancelStage: intersects(cancelButton, drawingStage),
          phaseCancel: intersects(phase, cancelButton),
          phaseHeading: intersects(phase, drawingHeading),
          phaseStage: intersects(phase, drawingStage),
        };
      });
      expect(overlaps).toEqual({
        cancelHeading: false,
        cancelStage: false,
        phaseCancel: false,
        phaseHeading: false,
        phaseStage: false,
      });
      await expectMinimumTouchTargets(page);
      await cancel.click();
      await publishVoterFixture(page, "long-deck");
    }

    await page.locator(".vote-footer").scrollIntoViewIfNeeded();
    await expect(page.locator(".vote-footer")).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await expectNoHorizontalOverflow(page);
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
  }
});

test("drawing after document scroll keeps the pointer origin aligned", async ({
  page,
}) => {
  await page.setViewportSize({ height: 568, width: 390 });
  await gotoVoterFixture(page, "playing");
  await page.evaluate(() => {
    window.scrollTo(0, 110);
  });
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(0);

  const surfaceBox = await surface(page).boundingBox();
  if (surfaceBox === null) {
    throw new Error("Handwriting surface has no browser bounds.");
  }
  expect(surfaceBox.y).toBeGreaterThanOrEqual(0);
  await drawCard(page, "5");
  await settlePaint(page);
  const ink = await canvasInkCenter(page);
  expect(ink.alphaPixels).toBeGreaterThan(100);
  expect(ink.x).toBeGreaterThan(surfaceBox.width * 0.35);
  expect(ink.x).toBeLessThan(surfaceBox.width * 0.65);
  expect(ink.y).toBeGreaterThan(surfaceBox.height * 0.25);
  expect(ink.y).toBeLessThan(surfaceBox.height * 0.8);
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
      const canvas = drawingStage.querySelector("canvas.vote-ink");
      if (canvas === null) {
        throw new Error("Vote ink is missing.");
      }
      captureWindow.__reducedVoteEffect = {
        animationName: getComputedStyle(canvas).animationName,
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
