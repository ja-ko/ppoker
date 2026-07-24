import { expect, test } from "@playwright/test";

import {
  canvasInkCenter,
  drawCard,
  expectCommandSummary,
  expectNoHorizontalOverflow,
  gotoVoterFixture,
  settlePaint,
} from "./voter-helpers";

test("iOS-style touch input is captured after scrolling without moving the page", async ({
  page,
}) => {
  await gotoVoterFixture(page, "playing");
  await page.evaluate(() => {
    window.scrollTo(0, 90);
  });
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(0);
  const surface = page.getByRole("region", { name: /Handwriting surface/u });
  const bounds = await surface.boundingBox();
  if (bounds === null) {
    throw new Error("Handwriting surface has no browser bounds.");
  }
  const beforeScroll = await page.evaluate(() => window.scrollY);
  await page.touchscreen.tap(
    bounds.x + bounds.width * 0.5,
    bounds.y + bounds.height * 0.52,
  );

  await expect(page.getByTestId("drawing-stage")).toHaveClass(
    /vote-draw-stage--settling/u,
  );
  expect(
    await surface.evaluate((element) => getComputedStyle(element).touchAction),
  ).toBe("none");
  expect(await page.evaluate(() => window.scrollY)).toBe(beforeScroll);
  await expectNoHorizontalOverflow(page);
  await expectCommandSummary(page, []);
  await expect(page.getByTestId("drawing-stage")).toHaveClass(
    /vote-draw-stage--empty/u,
  );

  const alignedSurface = await surface.boundingBox();
  if (alignedSurface === null) {
    throw new Error("Scrolled handwriting surface has no browser bounds.");
  }
  await drawCard(page, "5");
  await settlePaint(page);
  const ink = await canvasInkCenter(page);
  expect(ink.alphaPixels).toBeGreaterThan(100);
  expect(ink.x).toBeGreaterThan(alignedSurface.width * 0.35);
  expect(ink.x).toBeLessThan(alignedSurface.width * 0.65);
  expect(ink.y).toBeGreaterThan(alignedSurface.height * 0.25);
  expect(ink.y).toBeLessThan(alignedSurface.height * 0.8);
  await expectCommandSummary(page, [{ args: ["5"], name: "vote" }]);
  await expect(page.getByLabel("Current vote 5")).toBeVisible();
});
