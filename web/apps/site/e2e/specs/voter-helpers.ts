import { expect, type Page } from "@playwright/test";

import type { VoterCommandRecord } from "../voter-harness/fake-poker-client";
import type { VoterFixtureName } from "../voter-harness/fixtures";
import type {} from "../voter-harness/driver";

export const MODEL_READY_TIMEOUT_MS = 20_000;

export interface RelativePoint {
  readonly x: number;
  readonly y: number;
}

export type StrokeTemplate = readonly (readonly RelativePoint[])[];

// These pointer templates are the stable real-model corpus from the digit POC.
export const CARD_STROKES = {
  "1": [
    [
      { x: 0.4, y: 0.44 },
      { x: 0.5, y: 0.35 },
      { x: 0.5, y: 0.68 },
    ],
  ],
  "2": [
    [
      { x: 0.38, y: 0.4 },
      { x: 0.46, y: 0.35 },
      { x: 0.57, y: 0.37 },
      { x: 0.6, y: 0.44 },
      { x: 0.55, y: 0.5 },
      { x: 0.38, y: 0.67 },
      { x: 0.61, y: 0.67 },
    ],
  ],
  "3": [
    [
      { x: 0.39, y: 0.38 },
      { x: 0.49, y: 0.35 },
      { x: 0.59, y: 0.39 },
      { x: 0.55, y: 0.5 },
      { x: 0.47, y: 0.52 },
      { x: 0.56, y: 0.54 },
      { x: 0.6, y: 0.64 },
      { x: 0.51, y: 0.69 },
      { x: 0.39, y: 0.66 },
    ],
  ],
  "5": [
    [
      { x: 0.6, y: 0.36 },
      { x: 0.4, y: 0.36 },
      { x: 0.39, y: 0.5 },
      { x: 0.51, y: 0.49 },
      { x: 0.6, y: 0.54 },
      { x: 0.59, y: 0.64 },
      { x: 0.5, y: 0.69 },
      { x: 0.39, y: 0.65 },
    ],
  ],
  "8": [
    [
      { x: 0.5, y: 0.52 },
      { x: 0.4, y: 0.45 },
      { x: 0.42, y: 0.36 },
      { x: 0.5, y: 0.33 },
      { x: 0.58, y: 0.37 },
      { x: 0.6, y: 0.45 },
      { x: 0.5, y: 0.52 },
      { x: 0.4, y: 0.59 },
      { x: 0.41, y: 0.68 },
      { x: 0.5, y: 0.72 },
      { x: 0.59, y: 0.67 },
      { x: 0.6, y: 0.59 },
      { x: 0.5, y: 0.52 },
    ],
  ],
  "13": [
    [
      { x: 0.22, y: 0.44 },
      { x: 0.3, y: 0.35 },
      { x: 0.3, y: 0.68 },
    ],
    [
      { x: 0.52, y: 0.38 },
      { x: 0.62, y: 0.35 },
      { x: 0.72, y: 0.39 },
      { x: 0.68, y: 0.5 },
      { x: 0.59, y: 0.52 },
      { x: 0.68, y: 0.54 },
      { x: 0.73, y: 0.64 },
      { x: 0.63, y: 0.69 },
      { x: 0.52, y: 0.66 },
    ],
  ],
} as const satisfies Readonly<Record<string, StrokeTemplate>>;

interface GotoVoterOptions {
  readonly waitForRecognizer?: boolean;
}

export async function gotoVoterFixture(
  page: Page,
  fixture: VoterFixtureName,
  options: GotoVoterOptions = {},
): Promise<void> {
  await page.goto(`/e2e/voter-harness/?fixture=${fixture}`);
  await expect
    .poll(() =>
      page.evaluate(() => typeof window.__voterTestDriver === "object"),
    )
    .toBe(true);
  if (options.waitForRecognizer !== false) {
    await expect(page.locator(".vote-recognizer")).toHaveText(
      "Recognizer ready",
      { timeout: MODEL_READY_TIMEOUT_MS },
    );
    await expect(
      page.getByRole("region", { name: /Handwriting surface/u }),
    ).toHaveAttribute("aria-disabled", "false");
  }
}

export async function publishVoterFixture(
  page: Page,
  fixture: VoterFixtureName,
): Promise<void> {
  await page.evaluate((name) => {
    window.__voterTestDriver.publishFixture(name);
  }, fixture);
}

export async function voterCommands(
  page: Page,
): Promise<readonly VoterCommandRecord[]> {
  return page.evaluate(() => window.__voterTestDriver.commands());
}

export async function commandSummary(
  page: Page,
): Promise<
  readonly { readonly args: readonly string[]; readonly name: string }[]
> {
  const commands = await voterCommands(page);
  return commands.map(({ args, name }) => ({ args, name }));
}

export async function expectCommandSummary(
  page: Page,
  expected: readonly {
    readonly args: readonly string[];
    readonly name: string;
  }[],
): Promise<void> {
  await expect.poll(() => commandSummary(page)).toEqual(expected);
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        body: document.body.scrollWidth <= window.innerWidth,
        document:
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      })),
    )
    .toEqual({ body: true, document: true });
}

async function viewportPoints(
  page: Page,
  points: readonly RelativePoint[],
): Promise<RelativePoint[]> {
  const bounds = await page
    .getByRole("region", { name: /Handwriting surface/u })
    .boundingBox();
  if (bounds === null) {
    throw new Error("Handwriting surface has no browser bounds.");
  }
  return points.map((point) => ({
    x: bounds.x + point.x * bounds.width,
    y: bounds.y + point.y * bounds.height,
  }));
}

export async function drawMouseStroke(
  page: Page,
  points: readonly RelativePoint[],
): Promise<void> {
  const absolute = await viewportPoints(page, points);
  const first = absolute[0];
  if (first === undefined) {
    throw new Error("A stroke needs at least one point.");
  }
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const point of absolute.slice(1)) {
    await page.mouse.move(point.x, point.y, { steps: 2 });
  }
  await page.mouse.up();
}

export async function startMouseStroke(
  page: Page,
  points: readonly RelativePoint[],
): Promise<void> {
  const absolute = await viewportPoints(page, points);
  const first = absolute[0];
  if (first === undefined) {
    throw new Error("A stroke needs at least one point.");
  }
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const point of absolute.slice(1)) {
    await page.mouse.move(point.x, point.y, { steps: 2 });
  }
}

export async function drawTouchStroke(
  page: Page,
  points: readonly RelativePoint[],
): Promise<void> {
  const absolute = await viewportPoints(page, points);
  const first = absolute[0];
  if (first === undefined) {
    throw new Error("A stroke needs at least one point.");
  }
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ ...first, force: 0.5, id: 1 }],
    });
    for (const point of absolute.slice(1)) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ ...point, force: 0.5, id: 1 }],
      });
    }
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await session.detach();
  }
}

export async function drawTemplate(
  page: Page,
  template: StrokeTemplate,
  firstStrokeAsTouch = false,
): Promise<void> {
  for (const [index, stroke] of template.entries()) {
    if (index === 0 && firstStrokeAsTouch) {
      await drawTouchStroke(page, stroke);
    } else {
      await drawMouseStroke(page, stroke);
    }
  }
}

export async function drawCard(
  page: Page,
  value: keyof typeof CARD_STROKES,
  firstStrokeAsTouch = false,
): Promise<void> {
  await drawTemplate(page, CARD_STROKES[value], firstStrokeAsTouch);
}

export async function settlePaint(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );
}

export async function canvasInkCenter(page: Page): Promise<{
  readonly alphaPixels: number;
  readonly x: number;
  readonly y: number;
}> {
  return page
    .locator("canvas.vote-ink")
    .evaluate((canvas: HTMLCanvasElement) => {
      const context = canvas.getContext("2d");
      if (context === null) {
        throw new Error("Ink canvas has no 2D context.");
      }
      const pixels = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ).data;
      let alphaPixels = 0;
      let minX = canvas.width;
      let minY = canvas.height;
      let maxX = -1;
      let maxY = -1;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (pixels[offset + 3] === 0) {
          continue;
        }
        const pixel = offset / 4;
        const x = pixel % canvas.width;
        const y = Math.floor(pixel / canvas.width);
        alphaPixels += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      if (alphaPixels === 0) {
        throw new Error("Ink canvas is empty.");
      }
      return {
        alphaPixels,
        x: ((minX + maxX) / 2) * (canvas.clientWidth / canvas.width),
        y: ((minY + maxY) / 2) * (canvas.clientHeight / canvas.height),
      };
    });
}
