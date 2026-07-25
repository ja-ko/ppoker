import { expect, test, type Page } from "@playwright/test";

import { expectNoHorizontalOverflow, publishFixture } from "./helpers";

test("joins through the real route, holds the reveal gate, and stages the desk", async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  await gotoJoin(page);

  const heading = page.getByRole("heading", {
    name: "Planning Poker Live Desk",
  });
  const input = page.getByRole("textbox", { name: "Room name" });
  const button = page.getByRole("button", { name: "Join room" });
  await expect(heading).toBeVisible();
  await expect(input).toHaveAttribute("placeholder", "Enter room name");
  await expect(button.locator("svg")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator(".scorebug")).toHaveCount(0);

  await input.fill("Roadmap planning");
  const confirmedAt = Date.now();
  await input.press("Enter");
  await publishFixture(page, "playing");
  const entrancePromise = sampleEntrance(page);

  await expect(heading).toHaveCount(0);
  expect(
    await page.locator(".site-root").evaluate((root) => {
      const stripe = getComputedStyle(root, "::before");
      return stripe.content !== "none" && stripe.position === "fixed";
    }),
  ).toBe(true);
  await page.waitForTimeout(250);
  await expect(page.locator(".scorebug")).toHaveCount(0);
  expect((await page.locator(".site-root").textContent())?.trim()).toBe("");

  const line = page.locator('[data-entrance="line"]');
  await expect(line).toBeAttached();
  const revealedAfter = Date.now() - confirmedAt;
  expect(revealedAfter).toBeGreaterThanOrEqual(600);
  expect(revealedAfter).toBeLessThan(1_200);
  await expect(line).toHaveCSS("background-color", "rgb(198, 239, 255)");

  const entrance = await entrancePromise;
  expect(entrance.lineStarted).not.toBeNull();
  expect(entrance.lineComplete).not.toBeNull();
  expect(entrance.brandStarted).not.toBeNull();
  expect(entrance.brandComplete).not.toBeNull();
  expect(entrance.roomStarted).not.toBeNull();
  expect(entrance.phaseStarted).not.toBeNull();
  expect(entrance.roundStarted).not.toBeNull();
  expect(entrance.observedStarted).not.toBeNull();
  expect(entrance.liveStarted).not.toBeNull();
  expect(entrance.liveComplete).not.toBeNull();
  expect(entrance.bodyStarted).not.toBeNull();
  expect(entrance.bodyComplete).not.toBeNull();
  const frameSamplingTolerance = 200;
  expectStageGap(
    entrance.brandStarted,
    entrance.lineComplete,
    frameSamplingTolerance,
  );
  expectStageGap(
    entrance.roomStarted,
    entrance.brandComplete,
    frameSamplingTolerance,
  );
  expectStageGap(
    entrance.phaseStarted,
    entrance.roomStarted,
    frameSamplingTolerance,
  );
  expectStageGap(
    entrance.roundStarted,
    entrance.phaseStarted,
    frameSamplingTolerance,
  );
  expectStageGap(
    entrance.observedStarted,
    entrance.roundStarted,
    frameSamplingTolerance,
  );
  expectStageGap(
    entrance.liveStarted,
    entrance.observedStarted,
    frameSamplingTolerance,
  );
  expectStageGap(
    entrance.bodyStarted,
    entrance.liveComplete,
    frameSamplingTolerance,
  );
  const entranceDuration =
    (entrance.bodyComplete ?? 0) - (entrance.lineStarted ?? 0);
  expect(entranceDuration).toBeGreaterThanOrEqual(800);
  expect(entranceDuration).toBeLessThanOrEqual(1_200);
  expect(entrance.finalGeometry).toBe(true);

  const persisted = await page.evaluate(async () => {
    const entranceLine = document.querySelector('[data-entrance="line"]');
    const entranceBrand = document.querySelector('[data-entrance="brand"]');
    window.__broadcastTestDriver.publishFixture("revealed");
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });
    const currentBrand = document.querySelector('[data-entrance="brand"]');
    if (currentBrand === null || entranceLine === null) {
      throw new Error("Entrance nodes disappeared during the phase update.");
    }
    return {
      brandTransform: getComputedStyle(currentBrand).transform,
      lineColor: getComputedStyle(entranceLine).backgroundColor,
      sameBrand:
        entranceBrand === document.querySelector('[data-entrance="brand"]'),
      sameLine:
        entranceLine === document.querySelector('[data-entrance="line"]'),
    };
  });
  expect(persisted).toEqual({
    brandTransform: "none",
    lineColor: "rgb(255, 75, 31)",
    sameBrand: true,
    sameLine: true,
  });
  await expectNoHorizontalOverflow(page);
});

test("required empty join form stays active", async ({ page }) => {
  await gotoJoin(page);

  await page.getByRole("button", { name: "Join room" }).click();

  await expect(
    page.getByRole("heading", { name: "Planning Poker Live Desk" }),
  ).toBeVisible();
  await expect(page.locator('[data-route-state="active"]')).toBeAttached();
  await expect(page.locator('[data-route-state="exiting"]')).toHaveCount(0);
  expect(
    await page
      .getByRole("textbox", { name: "Room name" })
      .evaluate(
        (input) => input instanceof HTMLInputElement && input.validity.valid,
      ),
  ).toBe(false);
  await expect(page.locator(".scorebug")).toHaveCount(0);
});

test("exiting join controls are hidden, disabled, and unfocused", async ({
  page,
}) => {
  await gotoJoin(page);
  const input = page.getByRole("textbox", { name: "Room name" });
  await input.fill("Accessible exit room");
  await input.focus();

  const exposure = await page.evaluate(async () => {
    const sampleExit = () => {
      const route = document.querySelector<HTMLElement>(
        '[data-route-state="exiting"]',
      );
      if (route === null) {
        return null;
      }
      const controls = [...route.querySelectorAll("input, button")];
      return {
        activeInside: route.contains(document.activeElement),
        ariaHidden: route.getAttribute("aria-hidden"),
        controlsDisabled: controls.every(
          (control) =>
            (control instanceof HTMLInputElement ||
              control instanceof HTMLButtonElement) &&
            control.disabled,
        ),
      };
    };
    const result = new Promise<NonNullable<ReturnType<typeof sampleExit>>>(
      (resolve) => {
        const observer = new MutationObserver(() => {
          const sample = sampleExit();
          if (sample !== null) {
            observer.disconnect();
            resolve(sample);
          }
        });
        observer.observe(document.body, {
          attributeFilter: ["aria-hidden", "data-route-state", "disabled"],
          attributes: true,
          childList: true,
          subtree: true,
        });
      },
    );
    document
      .querySelector<HTMLButtonElement>('button[aria-label="Join room"]')
      ?.click();
    return result;
  });

  expect(exposure).toEqual({
    activeInside: false,
    ariaHidden: "true",
    controlsDisabled: true,
  });
});

test("browser back cleans up the room and forward reconnects", async ({
  page,
}) => {
  await gotoJoin(page);
  const input = page.getByRole("textbox", { name: "Room name" });
  await expect(input).toBeFocused();
  await input.fill("History room");
  await page.getByRole("button", { name: "Join room" }).click();
  await expect(page).toHaveURL(
    /\/e2e\/harness\/room\?room=History(?:\+|%20)room$/u,
  );
  await expectSessionState(page, {
    activeRoom: "History room",
    closeCount: 0,
    startCount: 1,
  });
  await expectCommandCounts(page, { close: 0, connect: 1 });

  await page.goBack();

  await expect(
    page.getByRole("heading", { name: "Planning Poker Live Desk" }),
  ).toBeVisible();
  await expect(input).toBeFocused();
  await expectSessionState(page, {
    activeRoom: null,
    closeCount: 1,
    startCount: 1,
  });
  await expectCommandCounts(page, { close: 1, connect: 1 });

  await page.goForward();

  await expect(page).toHaveURL(
    /\/e2e\/harness\/room\?room=History(?:\+|%20)room$/u,
  );
  await expectSessionState(page, {
    activeRoom: "History room",
    closeCount: 1,
    startCount: 2,
  });
  await expectCommandCounts(page, { close: 1, connect: 2 });
});

test("same-path room query replacement closes and starts exactly once", async ({
  page,
}) => {
  await gotoJoin(page);
  await page.getByRole("textbox", { name: "Room name" }).fill("First room");
  await page.getByRole("button", { name: "Join room" }).click();
  await expectSessionState(page, {
    activeRoom: "First room",
    closeCount: 0,
    startCount: 1,
  });
  await expectCommandCounts(page, { close: 0, connect: 1 });

  await page.evaluate(async () => {
    await window.__broadcastTestDriver.navigateToRoom("Second/room?");
  });

  await expect(page).toHaveURL(/\/e2e\/harness\/room\?room=Second%2Froom%3F$/u);
  await expectSessionState(page, {
    activeRoom: "Second/room?",
    closeCount: 1,
    startCount: 2,
  });
  await expectCommandCounts(page, { close: 1, connect: 2 });
});

test("mobile phase updates do not replay or overflow the entrance", async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await gotoJoin(page);
  await page.getByRole("textbox", { name: "Room name" }).fill("Mobile room");
  await page.getByRole("button", { name: "Join room" }).click();
  await publishFixture(page, "playing");
  await expect(page.locator('[data-entrance="line"]')).toBeAttached();

  const update = await page.evaluate(async () => {
    const line = document.querySelector<HTMLElement>('[data-entrance="line"]');
    const brand = document.querySelector<HTMLElement>(
      '[data-entrance="brand"]',
    );
    const body = document.querySelector<HTMLElement>('[data-entrance="body"]');
    if (line === null || brand === null || body === null) {
      throw new Error("Mobile entrance nodes are missing.");
    }
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });
    const scaleBeforeUpdate = new DOMMatrix(getComputedStyle(line).transform).a;
    window.__broadcastTestDriver.publishFixture("revealed");
    let minimumScaleAfterUpdate = 1;
    let contained = true;
    const startedAt = performance.now();
    while (performance.now() - startedAt < 1_300) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
      minimumScaleAfterUpdate = Math.min(
        minimumScaleAfterUpdate,
        new DOMMatrix(getComputedStyle(line).transform).a,
      );
      contained &&=
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth;
      if (Number(getComputedStyle(body).opacity) > 0.98) {
        break;
      }
    }
    const revealedColor = getComputedStyle(line).backgroundColor;
    window.__broadcastTestDriver.publishFixture("playing");
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });
    return {
      bodyOpacity: Number(getComputedStyle(body).opacity),
      brandTransform: getComputedStyle(brand).transform,
      contained,
      minimumScaleAfterUpdate,
      playingColor: getComputedStyle(line).backgroundColor,
      revealedColor,
      sameBody: body === document.querySelector('[data-entrance="body"]'),
      sameBrand: brand === document.querySelector('[data-entrance="brand"]'),
      sameLine: line === document.querySelector('[data-entrance="line"]'),
      scaleBeforeUpdate,
    };
  });

  expect(update.minimumScaleAfterUpdate).toBeGreaterThanOrEqual(
    update.scaleBeforeUpdate - 0.05,
  );
  expect(update.bodyOpacity).toBeGreaterThan(0.98);
  expect(update).toMatchObject({
    brandTransform: "none",
    contained: true,
    playingColor: "rgb(198, 239, 255)",
    revealedColor: "rgb(255, 75, 31)",
    sameBody: true,
    sameBrand: true,
    sameLine: true,
  });
  await expectNoHorizontalOverflow(page);
});

for (const viewport of [
  { height: 844, width: 390 },
  { height: 900, width: 1440 },
] as const) {
  test(`join controls stay contained at ${viewport.width.toString()}x${viewport.height.toString()}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await gotoJoin(page);

    const geometry = await page
      .locator(".join-screen__form")
      .evaluate((form) => {
        const box = form.getBoundingClientRect();
        return {
          bottom: box.bottom,
          left: box.left,
          right: box.right,
          top: box.top,
        };
      });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(viewport.width);
    expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.bottom).toBeLessThanOrEqual(viewport.height);
    await page.getByRole("textbox", { name: "Room name" }).focus();
    await expect(page.locator(".join-screen__form")).toHaveCSS(
      "border-top-color",
      "rgb(255, 75, 31)",
    );
    await expectNoHorizontalOverflow(page);
  });
}

test.describe("reduced motion join", () => {
  test.use({ contextOptions: { reducedMotion: "reduce" } });

  test("preserves the product gate and applies final entrance geometry", async ({
    page,
  }) => {
    await gotoJoin(page);
    const input = page.getByRole("textbox", { name: "Room name" });
    await input.fill("Reduced motion room");
    const confirmedAt = Date.now();
    await page.getByRole("button", { name: "Join room" }).click();
    await publishFixture(page, "playing");

    await expect(page.locator('[data-entrance="line"]')).toBeAttached();
    const revealedAfter = Date.now() - confirmedAt;
    expect(revealedAfter).toBeGreaterThanOrEqual(600);
    expect(revealedAfter).toBeLessThan(1_200);
    expect(
      await page.evaluate(() => {
        const selectors = [
          "line",
          "brand",
          "room",
          "phase",
          "round",
          "observed",
          "live",
          "body",
        ];
        return selectors.every((name) => {
          const element = document.querySelector<HTMLElement>(
            `[data-entrance="${name}"]`,
          );
          if (element === null) {
            return false;
          }
          const style = getComputedStyle(element);
          return style.opacity === "1" && style.transform === "none";
        });
      }),
    ).toBe(true);
  });
});

async function gotoJoin(page: Page): Promise<void> {
  await page.goto("/e2e/harness/?mode=join");
  await expect
    .poll(() =>
      page.evaluate(() => typeof window.__broadcastTestDriver === "object"),
    )
    .toBe(true);
}

async function expectSessionState(
  page: Page,
  expected: {
    readonly activeRoom: string | null;
    readonly closeCount: number;
    readonly startCount: number;
  },
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => window.__broadcastTestDriver.sessionState()),
    )
    .toEqual(expected);
}

async function expectCommandCounts(
  page: Page,
  expected: { readonly close: number; readonly connect: number },
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const { close, connect } = window.__broadcastTestDriver.commandCounts();
        return { close, connect };
      }),
    )
    .toEqual(expected);
}

interface EntranceSample {
  readonly bodyComplete: number | null;
  readonly bodyStarted: number | null;
  readonly brandComplete: number | null;
  readonly brandStarted: number | null;
  readonly finalGeometry: boolean;
  readonly lineComplete: number | null;
  readonly lineStarted: number | null;
  readonly liveComplete: number | null;
  readonly liveStarted: number | null;
  readonly observedStarted: number | null;
  readonly phaseStarted: number | null;
  readonly roomStarted: number | null;
  readonly roundStarted: number | null;
}

async function sampleEntrance(page: Page): Promise<EntranceSample> {
  return page.evaluate(async () => {
    const waitingAt = performance.now();
    while (
      document.querySelector('[data-entrance="line"]') === null &&
      performance.now() - waitingAt < 1_500
    ) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    }
    const startedAt = performance.now();
    const first = {
      bodyComplete: null as number | null,
      bodyStarted: null as number | null,
      brandComplete: null as number | null,
      brandStarted: null as number | null,
      lineComplete: null as number | null,
      lineStarted: null as number | null,
      liveComplete: null as number | null,
      liveStarted: null as number | null,
      observedStarted: null as number | null,
      phaseStarted: null as number | null,
      roomStarted: null as number | null,
      roundStarted: null as number | null,
    };
    const style = (name: string) => {
      const element = document.querySelector<HTMLElement>(
        `[data-entrance="${name}"]`,
      );
      if (element === null) {
        throw new Error(`Entrance element ${name} is missing.`);
      }
      const computed = getComputedStyle(element);
      return {
        matrix: new DOMMatrix(computed.transform),
        opacity: Number(computed.opacity),
      };
    };
    const initialBrandY = style("brand").matrix.m42;

    while (performance.now() - startedAt < 1_400) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
      const elapsed = performance.now() - startedAt;
      const line = style("line");
      const brand = style("brand");
      const room = style("room");
      const phase = style("phase");
      const round = style("round");
      const observed = style("observed");
      const live = style("live");
      const body = style("body");
      first.lineStarted ??= line.matrix.a > 0.02 ? elapsed : null;
      first.lineComplete ??= line.matrix.a > 0.98 ? elapsed : null;
      first.brandStarted ??=
        brand.matrix.m42 > initialBrandY + 1 ? elapsed : null;
      first.brandComplete ??= Math.abs(brand.matrix.m42) < 0.5 ? elapsed : null;
      first.roomStarted ??= room.opacity > 0.05 ? elapsed : null;
      first.phaseStarted ??= phase.opacity > 0.05 ? elapsed : null;
      first.roundStarted ??= round.opacity > 0.05 ? elapsed : null;
      first.observedStarted ??= observed.opacity > 0.05 ? elapsed : null;
      first.liveStarted ??= live.opacity > 0.05 ? elapsed : null;
      first.liveComplete ??=
        live.opacity > 0.98 && Math.abs(live.matrix.m42) < 0.5 ? elapsed : null;
      first.bodyStarted ??= body.opacity > 0.05 ? elapsed : null;
      first.bodyComplete ??= body.opacity > 0.98 ? elapsed : null;
      if (first.bodyComplete !== null) {
        break;
      }
    }

    const finalNames = [
      "line",
      "brand",
      "room",
      "phase",
      "round",
      "observed",
      "live",
      "body",
    ];
    return {
      ...first,
      finalGeometry: finalNames.every((name) => {
        const sample = style(name);
        return (
          sample.opacity > 0.98 &&
          Math.abs(sample.matrix.m41) < 0.5 &&
          Math.abs(sample.matrix.m42) < 0.5 &&
          Math.abs(sample.matrix.a - 1) < 0.02
        );
      }),
    };
  });
}

function expectStageGap(
  later: number | null,
  earlier: number | null,
  maximum: number,
): void {
  expect(later).not.toBeNull();
  expect(earlier).not.toBeNull();
  const gap = (later ?? 0) - (earlier ?? 0);
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThanOrEqual(maximum);
}
