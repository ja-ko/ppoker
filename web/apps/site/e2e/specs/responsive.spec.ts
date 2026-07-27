import { expect, test } from "@playwright/test";

import {
  expectMotionSettled,
  expectNoCommands,
  expectNoHorizontalOverflow,
  expectPanelHeadersInFlow,
  expectPanelsSeparated,
  expectParticipantCardContentSeparated,
  expectParticipantCardsContained,
  gotoFixture,
  publishAutoRevealAnnouncement,
  publishCoveredAutoReveal,
  publishFixture,
  samplePlayingToRevealed,
  visible,
} from "./helpers";

const viewports = [
  { height: 844, label: "mobile", width: 390 },
  { height: 800, label: "desktop threshold", width: 901 },
  { height: 640, label: "short desktop", width: 1024 },
  { height: 900, label: "large desktop", width: 1440 },
] as const;

for (const viewport of viewports) {
  test(`${viewport.label} remains contained through reveal`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await gotoFixture(page, "playing");
    await expectMotionSettled(page, "playing");
    await expectPanelHeadersInFlow(page);
    await expectNoHorizontalOverflow(page);
    await expectParticipantCardsContained(page);

    const sample = await samplePlayingToRevealed(page);
    expect(sample.documentWidth).toBeLessThanOrEqual(sample.viewportWidth);
    expect(
      sample.frames.every(
        ({ documentWidth, viewportWidth }) => documentWidth <= viewportWidth,
      ),
    ).toBe(true);
    expect(
      sample.frames.every(
        ({ participantCardsContained }) => participantCardsContained,
      ),
    ).toBe(true);
    expect(
      sample.frames.every(({ final, panel, participantCards, previous }) =>
        [final, panel, previous, ...participantCards]
          .filter((element) => visible(element))
          .every(
            (element) =>
              element !== null &&
              element.left >= -1 &&
              element.right <= sample.viewportWidth + 1,
          ),
      ),
    ).toBe(true);
    expect(
      sample.frames
        .filter(
          ({ final, panel }) =>
            visible(final) && final?.ariaHidden === null && panel !== null,
        )
        .every(
          ({ final, panel }) =>
            final !== null && panel !== null && final.bottom <= panel.top + 1,
        ),
    ).toBe(true);

    await expectMotionSettled(page, "revealed");
    await expectPanelHeadersInFlow(page);
    await expectPanelsSeparated(
      page.locator('[data-motion-key="broadcast:final-tally-panel"]'),
      page.locator('[data-motion-key="broadcast:participant-panel"]'),
    );
    await expectParticipantCardsContained(page);
    await expectNoHorizontalOverflow(page);
    if (viewport.width > 900) {
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollHeight <=
            document.documentElement.clientHeight,
        ),
      ).toBe(true);
    }
    await expectNoCommands(page);
  });
}

test("dense short-desktop cards separate state, vote, and name content", async ({
  page,
}) => {
  await page.setViewportSize({ height: 640, width: 1024 });
  await gotoFixture(page, "dense-playing");
  await expectMotionSettled(page, "playing");

  const grid = page.locator(".participant-grid");
  await expect(grid).toHaveClass(/participant-grid--dense/u);
  await expect(page.locator(".participant-card")).toHaveCount(12);
  expect(
    await grid.evaluate((element) => ({
      columns: getComputedStyle(element)
        .gridTemplateColumns.split(" ")
        .filter(Boolean).length,
      rows: getComputedStyle(element)
        .gridTemplateRows.split(" ")
        .filter(Boolean).length,
    })),
  ).toEqual({ columns: 5, rows: 3 });
  await expectParticipantCardContentSeparated(page);

  await publishFixture(page, "dense-revealed");
  await expectMotionSettled(page, "revealed");
  await expect(page.locator(".participant-card")).toHaveCount(12);
  await expectParticipantCardContentSeparated(page);
  await expectParticipantCardsContained(page);
  await expectNoHorizontalOverflow(page);
  await expectNoCommands(page);
});

test("mobile reserves two equal participant tracks for one card", async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await gotoFixture(page, "first-playing");
  await expect(
    page.getByRole("heading", { name: "Cards in play" }),
  ).toBeVisible();

  const geometry = await page.locator(".participant-grid").evaluate((grid) => {
    const columns = getComputedStyle(grid)
      .gridTemplateColumns.split(" ")
      .filter(Boolean)
      .map((track) => Number.parseFloat(track));
    const card = grid.querySelector<HTMLElement>(".participant-card");
    if (card === null) {
      throw new Error("Single mobile participant card missing.");
    }
    return {
      cardCount: grid.children.length,
      cardWidth: card.getBoundingClientRect().width,
      columns,
    };
  });
  expect(geometry.cardCount).toBe(1);
  expect(geometry.columns).toHaveLength(2);
  expect(
    Math.abs((geometry.columns[0] ?? 0) - (geometry.columns[1] ?? 0)),
  ).toBe(0);
  expect(
    Math.abs(geometry.cardWidth - (geometry.columns[0] ?? 0)),
  ).toBeLessThan(0.2);
  await expectNoHorizontalOverflow(page);
  await expectNoCommands(page);
});

test("auto-reveal edge overlay stays contained on desktop and mobile", async ({
  page,
}) => {
  for (const viewport of [
    { height: 900, width: 1440 },
    { height: 844, width: 390 },
  ]) {
    await page.setViewportSize(viewport);
    await gotoFixture(page, "playing");
    await publishCoveredAutoReveal(page);

    const countdown = page.locator(
      '[data-auto-reveal-countdown="active"][data-present="true"]',
    );
    await expect(countdown).toBeVisible();
    await expect(countdown).toHaveAttribute(
      "data-countdown-motion",
      "depleting",
    );
    await expect(countdown).toContainText("Auto-reveal");
    await expect(countdown).toHaveAttribute("aria-hidden", "true");
    await expect(page.getByRole("timer")).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText(
      "Auto-reveal countdown active.",
    );
    const contained = await countdown.evaluate((element) => {
      const panel = element.closest<HTMLElement>(".playing-panel");
      const label = element.querySelector<HTMLElement>(
        ".auto-reveal-countdown__label",
      );
      const track = element.querySelector<HTMLElement>(
        ".auto-reveal-countdown__track",
      );
      if (panel === null || label === null || track === null) {
        throw new Error("Auto-reveal overlay geometry is incomplete.");
      }
      const panelBox = panel.getBoundingClientRect();
      const labelBox = label.getBoundingClientRect();
      const trackBox = track.getBoundingClientRect();
      return (
        labelBox.left >= panelBox.left &&
        labelBox.right <= panelBox.right &&
        labelBox.top >= panelBox.top &&
        labelBox.bottom <= panelBox.bottom &&
        trackBox.left >= panelBox.left &&
        trackBox.right <= panelBox.right &&
        trackBox.top >= panelBox.top &&
        trackBox.bottom <= panelBox.bottom
      );
    });
    expect(contained).toBe(true);
    await expectParticipantCardsContained(page);
    await expectNoHorizontalOverflow(page);
    await expectNoCommands(page);
  }
});

test("auto-reveal progress visibly depletes and restarts", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await gotoFixture(page, "playing");
  await publishCoveredAutoReveal(page, 4_000);
  const countdown = page.locator(
    '[data-auto-reveal-countdown="active"][data-present="true"]',
  );
  const progress = () =>
    countdown
      .locator(".auto-reveal-countdown__fill")
      .evaluate((fill) => new DOMMatrix(getComputedStyle(fill).transform).a);
  await expect(countdown).toBeVisible();
  const firstKey = await countdown.getAttribute("data-countdown-key");
  const initialProgress = await progress();

  await page.waitForTimeout(400);
  const depletedProgress = await progress();
  expect(depletedProgress).toBeLessThan(initialProgress - 0.05);

  await publishAutoRevealAnnouncement(page, 4_000);
  await expect
    .poll(() => countdown.getAttribute("data-countdown-key"))
    .not.toBe(firstKey);
  const restartedProgress = await progress();
  expect(restartedProgress).toBeGreaterThan(depletedProgress + 0.05);

  await page.waitForTimeout(300);
  expect(await progress()).toBeLessThan(restartedProgress - 0.04);
  await expectNoCommands(page);
});

const statusHeaderViewports = [
  { height: 800, label: "desktop", width: 1280 },
  { height: 800, label: "tablet", width: 1024 },
  { height: 844, label: "mobile", width: 390 },
] as const;

for (const viewport of statusHeaderViewports) {
  test(`${viewport.label} status header gives the title all remaining width`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await gotoFixture(page, "playing");
    const headerGeometry = () =>
      page.evaluate(() => {
        const header = document.querySelector<HTMLElement>(".scorebug");
        const brand = document.querySelector<HTMLElement>(".brand-block");
        const room = document.querySelector<HTMLElement>(".room-heading");
        if (header === null || brand === null || room === null) {
          throw new Error("Header geometry is missing.");
        }
        const title = room.querySelector<HTMLElement>("h1");
        if (title === null) {
          throw new Error("Header title geometry is missing.");
        }
        return {
          brandWidth: brand.getBoundingClientRect().width,
          childCount: header.children.length,
          columns: getComputedStyle(header)
            .gridTemplateColumns.split(" ")
            .filter(Boolean).length,
          headerRight: header.getBoundingClientRect().right,
          headerWidth: header.getBoundingClientRect().width,
          roomRight: room.getBoundingClientRect().right,
          roomWidth: room.getBoundingClientRect().width,
          titleWidth: title.getBoundingClientRect().width,
        };
      });
    const active = await headerGeometry();

    await publishFixture(page, "terminal-error");
    await expect(
      page.getByRole("heading", { name: "Connection ended" }),
    ).toBeVisible();
    await expect(page.locator(".scorebug")).toHaveClass(/scorebug--status/u);
    await expect(page.locator(".broadcast-meta")).toHaveCount(0);
    await expect(page.locator(".live-flag")).toHaveCount(0);
    const status = await headerGeometry();

    expect(status.childCount).toBe(2);
    expect(status.columns).toBe(2);
    expect(status.roomWidth).toBeGreaterThan(active.roomWidth);
    expect(status.titleWidth).toBeGreaterThan(active.titleWidth);
    expect(Math.abs(status.roomRight - status.headerRight)).toBeLessThanOrEqual(
      1,
    );
    expect(
      Math.abs(status.roomWidth - (status.headerWidth - status.brandWidth)),
    ).toBeLessThanOrEqual(1);
    await expectNoCommands(page);
  });
}

test.describe("reduced motion", () => {
  test.use({ contextOptions: { reducedMotion: "reduce" } });

  test("applies final geometry without transform-driven intermediate states", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 901 });
    await gotoFixture(page, "playing");
    await expectMotionSettled(page, "playing");
    expect(
      await page
        .locator(".participant-card--thinking")
        .first()
        .evaluate((card) => {
          const style = getComputedStyle(card, "::before");
          const transform = new DOMMatrix(style.transform);
          return {
            animationName: style.animationName,
            x: transform.m41,
            y: transform.m42,
          };
        }),
    ).toEqual({ animationName: "none", x: 0, y: 0 });

    await publishCoveredAutoReveal(page);
    const countdown = page.locator(
      '[data-auto-reveal-countdown="active"][data-present="true"]',
    );
    await expect(countdown).toBeVisible();
    await expect(countdown).toHaveAttribute("data-countdown-motion", "static");
    await expect(countdown).toContainText("Auto-revealCountdown active");
    const reducedProgress = await countdown.evaluate((element) => {
      const fill = element.querySelector<HTMLElement>(
        ".auto-reveal-countdown__fill",
      );
      const signal = element.querySelector<HTMLElement>(
        ".auto-reveal-countdown__signal",
      );
      if (fill === null || signal === null) {
        throw new Error("Reduced-motion countdown details are missing.");
      }
      return {
        fillScale: new DOMMatrix(getComputedStyle(fill).transform).a,
        initialProgress: Number(element.getAttribute("data-initial-progress")),
        runningAnimations: element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.playState === "running").length,
        signalAnimation: getComputedStyle(signal).animationName,
      };
    });
    expect(reducedProgress).toMatchObject({
      runningAnimations: 0,
      signalAnimation: "none",
    });
    expect(reducedProgress.fillScale).toBeCloseTo(
      reducedProgress.initialProgress,
      5,
    );

    const sample = await samplePlayingToRevealed(page);
    expect(sample.frames.length).toBeGreaterThan(0);
    expect(
      sample.frames.every(
        ({ final, panel }) =>
          panel?.transform === "none" &&
          (final === null || final.transform === "none"),
      ),
    ).toBe(true);
    const finalFrame = sample.frames.find(({ final }) => final !== null)?.final;
    expect(finalFrame?.ariaHidden).toBeNull();
    expect(finalFrame?.opacity).toBe(1);
    await expectMotionSettled(page, "revealed");
    await expect(
      page.getByRole("region", { name: "Vote distribution" }),
    ).toBeVisible();
    await expect(page.locator(".average-value")).not.toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expectPanelsSeparated(
      page.locator('[data-motion-key="broadcast:final-tally-panel"]'),
      page.locator('[data-motion-key="broadcast:participant-panel"]'),
    );
    await expectNoCommands(page);
  });
});
