import { expect, test } from "@playwright/test";

import {
  expectMotionSettled,
  expectNoCommands,
  expectNoHorizontalOverflow,
  expectPanelsSeparated,
  expectParticipantCardsContained,
  gotoFixture,
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

test.describe("reduced motion", () => {
  test.use({ contextOptions: { reducedMotion: "reduce" } });

  test("applies final geometry without transform-driven intermediate states", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 901 });
    await gotoFixture(page, "playing");
    await expectMotionSettled(page, "playing");

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
