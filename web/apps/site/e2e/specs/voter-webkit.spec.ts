import { expect, test } from "@playwright/test";

import {
  canvasInkCenter,
  drawCard,
  expectCommandSummary,
  expectNoHorizontalOverflow,
  expectNoVerticalOverflow,
  gotoVoterFixture,
  settlePaint,
} from "./voter-helpers";

test("iPhone touch input stays aligned without document scrolling", async ({
  page,
}) => {
  await gotoVoterFixture(page, "playing");
  await expectNoVerticalOverflow(page);

  const identity = page.locator(".vote-name > span");
  await expect(identity).toContainText("Voting as E2E Voter");
  const identityGeometry = await identity.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const right = left + (viewport?.width ?? window.innerWidth);
    const bottom = top + (viewport?.height ?? window.innerHeight);
    const hit = document.elementFromPoint(
      bounds.left + bounds.width / 2,
      bounds.top + bounds.height / 2,
    );
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
      unobstructed: hit !== null && element.contains(hit),
      viewport: { bottom, left, right, top },
    };
  });
  expect(identityGeometry.contained, JSON.stringify(identityGeometry)).toBe(
    true,
  );
  expect(identityGeometry.unobstructed, JSON.stringify(identityGeometry)).toBe(
    true,
  );

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
  await expectNoVerticalOverflow(page);
  await expectCommandSummary(page, []);
  await expect(page.getByTestId("drawing-stage")).toHaveClass(
    /vote-draw-stage--empty/u,
  );

  const alignedSurface = await surface.boundingBox();
  if (alignedSurface === null) {
    throw new Error("Aligned handwriting surface has no browser bounds.");
  }
  await drawCard(page, "5");
  await settlePaint(page);
  const ink = await canvasInkCenter(page);
  expect(ink.alphaPixels).toBeGreaterThan(100);
  expect(ink.x).toBeGreaterThan(alignedSurface.width * 0.35);
  expect(ink.x).toBeLessThan(alignedSurface.width * 0.65);
  expect(ink.y).toBeGreaterThan(alignedSurface.height * 0.25);
  expect(ink.y).toBeLessThan(alignedSurface.height * 0.8);
  await expectNoVerticalOverflow(page);
  await expectCommandSummary(page, [{ args: ["5"], name: "vote" }]);
  await expect(page.getByLabel("Current vote 5")).toBeVisible();
});
