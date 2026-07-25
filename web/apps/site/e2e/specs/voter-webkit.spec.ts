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

test("iPhone handwriting header and countdown text remain interactive and contained", async ({
  page,
}) => {
  await gotoVoterFixture(page, "final-vote");

  const geometry = await page
    .getByRole("region", { name: /Handwriting surface/u })
    .evaluate((surface) => {
      const stage = surface.closest<HTMLElement>(".vote-draw-stage");
      const heading = stage?.querySelector<HTMLElement>(".vote-draw-heading");
      if (stage === null || heading === null || heading === undefined) {
        throw new Error("Handwriting stage or heading is missing.");
      }
      const surfaceBounds = surface.getBoundingClientRect();
      const stageBounds = stage.getBoundingClientRect();
      const headingBounds = heading.getBoundingClientRect();
      const hit = document.elementFromPoint(
        headingBounds.left + headingBounds.width / 2,
        headingBounds.top + headingBounds.height / 2,
      );
      return {
        edges: {
          bottom: Math.abs(surfaceBounds.bottom - stageBounds.bottom),
          left: Math.abs(surfaceBounds.left - stageBounds.left),
          right: Math.abs(surfaceBounds.right - stageBounds.right),
          top: Math.abs(surfaceBounds.top - stageBounds.top),
        },
        headingChildrenIgnorePointers: [...heading.querySelectorAll("*")].every(
          (element) => getComputedStyle(element).pointerEvents === "none",
        ),
        headingCenter: {
          x: headingBounds.left + headingBounds.width / 2,
          y: headingBounds.top + headingBounds.height / 2,
        },
        headingHeight: headingBounds.height,
        headingHitsSurface: hit === surface || surface.contains(hit),
        headingPointerEvents: getComputedStyle(heading).pointerEvents,
        headingTop: Math.abs(headingBounds.top - stageBounds.top),
        stageHeight: stageBounds.height,
      };
    });
  expect(geometry.headingChildrenIgnorePointers).toBe(true);
  expect(geometry.headingHitsSurface).toBe(true);
  expect(geometry.headingPointerEvents).toBe("none");
  expect(geometry.headingTop).toBeLessThanOrEqual(1.5);
  expect(geometry.headingHeight).toBeLessThan(geometry.stageHeight / 2);
  expect(Object.values(geometry.edges).every((gap) => gap <= 1.5)).toBe(true);

  await page.touchscreen.tap(
    geometry.headingCenter.x,
    geometry.headingCenter.y,
  );
  await expect(page.getByTestId("drawing-stage")).toHaveClass(
    /vote-draw-stage--settling/u,
  );
  await expect(page.getByTestId("drawing-stage")).toHaveClass(
    /vote-draw-stage--empty/u,
  );

  await page.getByRole("button", { name: "Vote 5", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Reveal in [123]/u }),
  ).toBeVisible();
  const cancelGeometry = await page
    .getByRole("button", { name: "Cancel" })
    .evaluate((button) => {
      const bounds = button.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(button);
      const text = range.getBoundingClientRect();
      range.detach();
      return {
        bottom: text.bottom <= bounds.bottom,
        left: text.left >= bounds.left,
        right: text.right <= bounds.right,
        top: text.top >= bounds.top,
      };
    });
  expect(cancelGeometry).toEqual({
    bottom: true,
    left: true,
    right: true,
    top: true,
  });
});

test("iPhone commit morph keeps the painted digit aspect ratio", async ({
  page,
}) => {
  await gotoVoterFixture(page, "playing");
  await drawCard(page, "5");
  const drawingStage = page.getByTestId("drawing-stage");
  await expect(drawingStage).toHaveClass(/vote-draw-stage--committing/u);

  const scales = await page.locator(".ink-visual").evaluate((visual) => {
    const animation = visual.getAnimations()[0];
    if (animation === undefined) {
      throw new Error("Commit transform animation is missing.");
    }
    const state = {
      currentTime: animation.currentTime,
      playState: animation.playState,
    };
    animation.pause();
    animation.currentTime = 460;
    const matrix = new DOMMatrixReadOnly(getComputedStyle(visual).transform);
    const result = {
      x: Math.hypot(matrix.a, matrix.b),
      y: Math.hypot(matrix.c, matrix.d),
    };
    animation.currentTime = state.currentTime;
    if (state.playState === "running") {
      animation.play();
    }
    return result;
  });

  expect(scales.x).toBeGreaterThan(0);
  expect(scales.y).toBeGreaterThan(0);
  expect(Math.abs(scales.x - scales.y)).toBeLessThanOrEqual(0.001);
});

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
