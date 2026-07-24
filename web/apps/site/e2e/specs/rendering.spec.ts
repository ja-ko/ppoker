import { expect, test } from "@playwright/test";

import {
  expectMotionSettled,
  expectNoCommands,
  expectNoHorizontalOverflow,
  expectPanelHeadersInFlow,
  gotoFixture,
  publishFixture,
} from "./helpers";

test.describe("scoreboard harness rendering", () => {
  test("renders an initial playing snapshot", async ({ page }) => {
    await gotoFixture(page, "playing");

    await expect(
      page.getByRole("heading", { name: "Cards in play" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 1, name: "Planning Poker Room" }),
    ).toBeVisible();
    await expect(page.locator(".eyebrow")).toContainText(
      "Authoritative E2E Room / E2E-ROOM",
    );
    const roomAccess = page.getByRole("region", { name: "Room access" });
    await expect(roomAccess.getByText("Scan to join")).toBeVisible();
    await expect(
      roomAccess.locator(".room-code > strong", {
        hasText: "Authoritative E2E Room",
      }),
    ).toBeVisible();
    await expect(
      roomAccess.getByRole("link", {
        name: "Join Authoritative E2E Room voting room",
      }),
    ).toHaveAttribute("href", /\/vote\?room=E2E-ROOM$/u);
    await expect(
      roomAccess.getByRole("img", {
        name: "QR code to join Authoritative E2E Room",
      }),
    ).toBeVisible();
    await expect(page.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "6",
    );
    await expect(page.locator('[data-participant-id^="player:"]')).toHaveCount(
      10,
    );
    const participantGeometry = await page
      .locator(".participant-grid")
      .evaluate((grid) => {
        const style = getComputedStyle(grid);
        return {
          childCount: grid.children.length,
          columns: style.gridTemplateColumns.split(" ").filter(Boolean).length,
          rows: style.gridTemplateRows.split(" ").filter(Boolean).length,
        };
      });
    expect(participantGeometry).toEqual({
      childCount: 10,
      columns: 5,
      rows: 2,
    });
    await expect(page.getByRole("region", { name: "Round 08" })).toBeVisible();
    await expect(page.getByText("Observed just now").first()).toBeVisible();
    await expect(page.getByText(/Completed /)).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText(
      "Round 9. Voting open. 6 of 10 responses locked.",
    );
    await expectMotionSettled(page, "playing");
    await expectPanelHeadersInFlow(page);
    await expectNoHorizontalOverflow(page);
    await expectNoCommands(page);
  });

  test("animates THINKING stripes across a seamless two-period transform loop", async ({
    page,
  }) => {
    await gotoFixture(page, "playing");
    await expectMotionSettled(page, "playing");

    const result = await page.evaluate(async () => {
      const card = document.querySelector<HTMLElement>(
        ".participant-card--thinking",
      );
      if (card === null) {
        throw new Error("THINKING card missing.");
      }
      const pseudoStyle = getComputedStyle(card, "::before");
      const animation = card
        .getAnimations({ subtree: true })
        .find(
          (candidate) =>
            candidate instanceof CSSAnimation &&
            candidate.animationName === pseudoStyle.animationName,
        );
      if (
        animation === undefined ||
        !(animation.effect instanceof KeyframeEffect)
      ) {
        throw new Error("THINKING pseudo-element animation missing.");
      }
      const effect = animation.effect;
      const vector = (transform: string) => {
        const matrix = new DOMMatrix(transform);
        return { x: matrix.m41, y: matrix.m42 };
      };
      const computedVector = () =>
        vector(getComputedStyle(card, "::before").transform);
      const nextFrame = () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      const transformKeyframes = effect
        .getKeyframes()
        .flatMap((frame) =>
          typeof frame["transform"] === "string" ? [frame["transform"]] : [],
        );
      const firstKeyframe = transformKeyframes[0];
      const lastKeyframe = transformKeyframes.at(-1);
      if (firstKeyframe === undefined || lastKeyframe === undefined) {
        throw new Error("THINKING transform keyframes missing.");
      }
      const duration = effect.getComputedTiming().duration;
      if (typeof duration !== "number") {
        throw new Error("THINKING animation duration is not numeric.");
      }

      animation.pause();
      animation.currentTime = 0;
      await nextFrame();
      const atStart = computedVector();
      animation.currentTime = duration - 0.01;
      await nextFrame();
      const nearEnd = computedVector();

      animation.currentTime = 1_000;
      animation.play();
      const samples: { readonly x: number; readonly y: number }[] = [];
      for (let index = 0; index < 24; index += 1) {
        await nextFrame();
        samples.push(computedVector());
      }
      animation.pause();

      const cardStyle = getComputedStyle(card);
      const state = card.querySelector<HTMLElement>(".card-state");
      return {
        animation: {
          duration: pseudoStyle.animationDuration,
          iterationCount: pseudoStyle.animationIterationCount,
          name: pseudoStyle.animationName,
          timing: pseudoStyle.animationTimingFunction,
        },
        atStart,
        keyframes: {
          end: vector(lastKeyframe),
          start: vector(firstKeyframe),
        },
        layer: {
          backgroundImage: pseudoStyle.backgroundImage,
          bottom: Number.parseFloat(pseudoStyle.bottom),
          left: Number.parseFloat(pseudoStyle.left),
          overflow: cardStyle.overflow,
          pointerEvents: pseudoStyle.pointerEvents,
          right: Number.parseFloat(pseudoStyle.right),
          stateZIndex: state === null ? null : getComputedStyle(state).zIndex,
          top: Number.parseFloat(pseudoStyle.top),
          willChange: pseudoStyle.willChange,
          zIndex: pseudoStyle.zIndex,
        },
        nearEnd,
        samples,
      };
    });

    expect(result.animation).toEqual({
      duration: "8s",
      iterationCount: "infinite",
      name: "thinking-pattern-scroll",
      timing: "linear",
    });
    expect(result.keyframes.start).toEqual({ x: 0, y: 0 });
    expect(result.keyframes.end).toEqual({ x: 24, y: 18 });
    const endpointTravel = Math.hypot(
      result.keyframes.end.x - result.keyframes.start.x,
      result.keyframes.end.y - result.keyframes.start.y,
    );
    expect(endpointTravel).toBe(30);
    expect(endpointTravel / 15).toBe(2);
    expect(result.atStart.x).toBeCloseTo(0, 3);
    expect(result.atStart.y).toBeCloseTo(0, 3);
    expect(result.nearEnd.x).toBeCloseTo(24, 2);
    expect(result.nearEnd.y).toBeCloseTo(18, 2);
    expect(result.layer).toMatchObject({
      bottom: -30,
      left: -30,
      overflow: "hidden",
      pointerEvents: "none",
      right: -30,
      stateZIndex: "1",
      top: -30,
      willChange: "transform",
      zIndex: "0",
    });
    expect(-result.layer.left - result.keyframes.end.x).toBe(6);
    expect(-result.layer.top - result.keyframes.end.y).toBe(12);
    expect(result.layer.backgroundImage).toMatch(/-53\.1301\d*deg/u);
    expect(
      [...result.layer.backgroundImage.matchAll(/ (\d+)px/gu)].map((match) =>
        Number(match[1]),
      ),
    ).toEqual([0, 14, 14, 15]);
    expect(result.samples).toHaveLength(24);
    const firstSample = result.samples[0];
    const lastSample = result.samples.at(-1);
    if (firstSample === undefined || lastSample === undefined) {
      throw new Error("THINKING animation samples missing.");
    }
    expect(lastSample.x - firstSample.x).toBeGreaterThan(0.5);
    expect(lastSample.y - firstSample.y).toBeGreaterThan(0.35);
    expect(
      result.samples.slice(1).every((sample, index) => {
        const previous = result.samples[index];
        return (
          previous !== undefined &&
          sample.x >= previous.x - 0.001 &&
          sample.y >= previous.y - 0.001
        );
      }),
    ).toBe(true);
    await expectNoCommands(page);
  });

  test("renders an initial revealed snapshot", async ({ page }) => {
    await gotoFixture(page, "revealed");

    await expect(
      page.getByRole("heading", { name: "Participant cards" }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Vote distribution" }),
    ).toBeVisible();
    await expect(page.locator(".average-value")).toHaveText("5.3");
    await expect(
      page.locator('[data-participant-id="player:Ada:1"]'),
    ).toHaveAttribute("aria-label", "Ada: 5");
    await expectMotionSettled(page, "revealed");
    await expectPanelHeadersInFlow(page);
    await expectNoHorizontalOverflow(page);
    await expectNoCommands(page);
  });

  test("sorts revealed cards by vote while retaining duplicate identities", async ({
    page,
  }) => {
    await gotoFixture(page, "sorted-revealed");
    await expectMotionSettled(page, "revealed");

    const cards = page.locator(".participant-grid > .participant-card");
    await expect(cards).toHaveCount(10);
    expect(
      await cards.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-participant-id")),
      ),
    ).toEqual([
      "player:Ada:1",
      "player:Zoe:1",
      "player:Five:1",
      "player:Same:1",
      "player:Same:2",
      "player:Break:1",
      "player:Question:1",
      "player:Unknown%20alpha:1",
      "player:Unknown%20zebra:1",
      "player:Missing:1",
    ]);
    await expect(cards).toContainText([
      "3Ada",
      "3Zoe",
      "5Five",
      "8Same",
      "8Same",
      "BreakBreak",
      "?Question",
      "AlphaUnknown alpha",
      "ZebraUnknown zebra",
      "-Missing",
    ]);
    await expectNoCommands(page);
  });

  test("omits the previous-result slot on the first round", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1024 });
    await gotoFixture(page, "first-playing");

    await expect(page.locator(".phase-panel")).toHaveCount(0);
    await expect(page.getByText("Awaiting first result")).toHaveCount(0);
    const emptyTrackGeometry = await page.evaluate(() => {
      const column = document.querySelector<HTMLElement>(".primary-column");
      const panel = document.querySelector<HTMLElement>(
        '[data-motion-key="broadcast:participant-panel"]',
      );
      if (column === null || panel === null) {
        throw new Error("First-round primary geometry is missing.");
      }
      const columnBox = column.getBoundingClientRect();
      const panelBox = panel.getBoundingClientRect();
      return {
        columnBottom: columnBox.bottom,
        emptyHeight: columnBox.bottom - panelBox.bottom,
        panelBottom: panelBox.bottom,
      };
    });
    expect(emptyTrackGeometry.panelBottom).toBeLessThan(
      emptyTrackGeometry.columnBottom,
    );
    expect(emptyTrackGeometry.emptyHeight).toBeGreaterThan(100);
    await expect(page.getByText("No completed rounds yet.")).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Round history" }),
    ).toBeVisible();
    await expectPanelHeadersInFlow(page);
    await expectNoHorizontalOverflow(page);
    await expectNoCommands(page);
  });

  test("renders overflow totals and the participant summary", async ({
    page,
  }) => {
    await gotoFixture(page, "overflow");

    await expect(page.getByRole("progressbar")).toHaveAttribute(
      "aria-valuemax",
      "18",
    );
    await expect(
      page.getByRole("listitem", { name: "7 more participants" }),
    ).toBeVisible();
    await expect(page.locator(".participant-card")).toHaveCount(12);
    await expectNoCommands(page);
  });

  test("renders a terminal fake-client error state", async ({ page }) => {
    await gotoFixture(page, "playing");
    await publishFixture(page, "terminal-error");

    await expect(
      page.getByRole("heading", { name: "Connection ended" }),
    ).toBeVisible();
    await expect(page.getByText(/E2E fixture transport ended/)).toBeVisible();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.locator(".broadcast-main")).toHaveCount(0);
    await expect(page.locator(".broadcast-meta")).toHaveCount(0);
    await expect(page.locator(".live-flag")).toHaveCount(0);
    await expectPanelHeadersInFlow(page);

    await publishFixture(page, "closed");
    await expect(
      page.getByRole("heading", { name: "Connection closed" }),
    ).toBeVisible();
    await expect(page.locator(".broadcast-main")).toHaveCount(0);
    await expect(page.locator(".broadcast-meta")).toHaveCount(0);
    await expect(page.locator(".live-flag")).toHaveCount(0);

    await gotoFixture(page, "terminal-error");
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Connection ended" }),
    ).toBeVisible();
    await expect(page.locator(".broadcast-main")).toHaveCount(0);
    await expect(page.locator(".broadcast-meta")).toHaveCount(0);
    await expect(page.locator(".live-flag")).toHaveCount(0);
    await expectNoCommands(page);
  });
});
