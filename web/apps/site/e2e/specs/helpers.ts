import { expect, type Locator, type Page } from "@playwright/test";

import type { SnapshotFixtureName } from "../harness/fixtures";
import type {} from "../harness/driver";

export interface SampledElement {
  readonly ariaHidden: string | null;
  readonly bottom: number;
  readonly height: number;
  readonly left: number;
  readonly opacity: number;
  readonly right: number;
  readonly top: number;
  readonly transform: string;
  readonly width: number;
}

interface PhaseFrame {
  readonly documentWidth: number;
  readonly exposedPhasePanels: number;
  readonly final: SampledElement | null;
  readonly headerPhase: readonly {
    readonly ariaHidden: string | null;
    readonly text: string | null;
  }[];
  readonly headerRound: readonly {
    readonly ariaHidden: string | null;
    readonly text: string | null;
  }[];
  readonly liveAnnouncements: readonly {
    readonly ariaHidden: string | null;
    readonly text: string | null;
  }[];
  readonly panel: SampledElement | null;
  readonly participantCards: readonly SampledElement[];
  readonly participantCardsContained: boolean;
  readonly phase: "playing" | "revealed" | null;
  readonly previous: SampledElement | null;
  readonly resultValues: readonly {
    readonly ariaHidden: string | null;
    readonly hiddenByPhasePanel: boolean;
    readonly kind: "average" | "metadata";
    readonly text: string | null;
  }[];
  readonly viewportWidth: number;
}

export interface PhaseTransitionSample {
  readonly documentWidth: number;
  readonly frames: readonly PhaseFrame[];
  readonly initialCard: SampledElement;
  readonly initialPanel: SampledElement;
  readonly sameCard: boolean;
  readonly samePanel: boolean;
  readonly viewportWidth: number;
}

export async function gotoFixture(
  page: Page,
  fixture: SnapshotFixtureName,
): Promise<void> {
  await page.goto(`/e2e/harness/?fixture=${fixture}`);
  await expect
    .poll(() =>
      page.evaluate(() => typeof window.__broadcastTestDriver === "object"),
    )
    .toBe(true);
}

export async function publishFixture(
  page: Page,
  fixture: SnapshotFixtureName,
): Promise<void> {
  await page.evaluate((name) => {
    window.__broadcastTestDriver.publishFixture(name);
  }, fixture);
}

export async function expectMotionSettled(
  page: Page,
  phase: "playing" | "revealed",
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((expectedPhase) => {
          const shell = document.querySelector(".app-shell");
          const animated = document.querySelectorAll<HTMLElement>(
            '[data-motion-key="broadcast:participant-panel"], .phase-panel, .participant-card, .history-list > li',
          );
          return (
            shell?.classList.contains(`app-shell--${expectedPhase}`) === true &&
            document.querySelectorAll(".phase-panel").length === 1 &&
            [...animated].every(
              (element) => getComputedStyle(element).transform === "none",
            )
          );
        }, phase),
      { timeout: 7_000 },
    )
    .toBe(true);
}

export async function expectNoCommands(page: Page): Promise<void> {
  const counts = await page.evaluate(() =>
    window.__broadcastTestDriver.commandCounts(),
  );
  expect(counts).toEqual({
    chat: 0,
    close: 0,
    connect: 0,
    dispose: 0,
    rename: 0,
    retractVote: 0,
    reveal: 0,
    startNewRound: 0,
    vote: 0,
  });
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
}

export async function expectPanelsSeparated(
  upper: Locator,
  lower: Locator,
): Promise<void> {
  const upperBox = await upper.boundingBox();
  const lowerBox = await lower.boundingBox();
  expect(upperBox).not.toBeNull();
  expect(lowerBox).not.toBeNull();
  if (upperBox === null || lowerBox === null) {
    return;
  }
  expect(upperBox.y + upperBox.height).toBeLessThanOrEqual(lowerBox.y + 1);
}

export async function expectParticipantCardsContained(
  page: Page,
): Promise<void> {
  const outsideCards = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(
      '[data-motion-key="broadcast:participant-panel"]',
    );
    if (panel === null) {
      return ["participant panel missing"];
    }
    const panelBox = panel.getBoundingClientRect();
    return [...panel.querySelectorAll<HTMLElement>(".participant-card")]
      .filter((card) => {
        const box = card.getBoundingClientRect();
        return (
          box.left < panelBox.left - 1 ||
          box.right > panelBox.right + 1 ||
          box.top < panelBox.top - 1 ||
          box.bottom > panelBox.bottom + 1
        );
      })
      .map((card) => card.dataset["participantId"] ?? card.textContent);
  });
  expect(outsideCards).toEqual([]);
}

export async function samplePlayingToRevealed(
  page: Page,
): Promise<PhaseTransitionSample> {
  return page.evaluate(async () => {
    const elementSample = (element: Element | null): SampledElement | null => {
      if (!(element instanceof HTMLElement)) {
        return null;
      }
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        ariaHidden: element.getAttribute("aria-hidden"),
        bottom: box.bottom,
        height: box.height,
        left: box.left,
        opacity: Number(style.opacity),
        right: box.right,
        top: box.top,
        transform: style.transform,
        width: box.width,
      };
    };
    const panelSelector = '[data-motion-key="broadcast:participant-panel"]';
    const cardSelector = '[data-participant-id="player:Ada:1"]';
    const panelNode = document.querySelector(panelSelector);
    const cardNode = document.querySelector(cardSelector);
    const initialPanel = elementSample(panelNode);
    const initialCard = elementSample(cardNode);
    if (initialPanel === null || initialCard === null) {
      throw new Error("Playing transition targets were not rendered.");
    }

    window.__broadcastTestDriver.publishFixture("revealed");
    const frames: PhaseFrame[] = [];
    const startedAt = performance.now();
    let settledFrames = 0;
    while (performance.now() - startedAt < 2_500 && frames.length < 180) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
      const panel = elementSample(document.querySelector(panelSelector));
      const previous = elementSample(
        document.querySelector(
          '[data-motion-key="broadcast:previous-round-panel"]',
        ),
      );
      const final = elementSample(
        document.querySelector(
          '[data-motion-key="broadcast:final-tally-panel"]',
        ),
      );
      const participantCards = [
        ...document.querySelectorAll(".participant-card"),
      ].flatMap((element) => {
        const sample = elementSample(element);
        return sample === null ? [] : [sample];
      });
      const participantCardsContained =
        panel !== null &&
        participantCards.length > 0 &&
        participantCards.every(
          (card) =>
            card.left >= panel.left - 1 &&
            card.right <= panel.right + 1 &&
            card.top >= panel.top - 1 &&
            card.bottom <= panel.bottom + 1,
        );
      const shell = document.querySelector(".app-shell");
      const phase =
        shell?.classList.contains("app-shell--playing") === true
          ? "playing"
          : shell?.classList.contains("app-shell--revealed") === true
            ? "revealed"
            : null;
      frames.push({
        documentWidth: document.documentElement.scrollWidth,
        exposedPhasePanels: document.querySelectorAll(
          ".phase-panel:not([aria-hidden='true'])",
        ).length,
        final,
        headerPhase: [
          ...document.querySelectorAll(".broadcast-meta > div:first-child dd"),
        ].map((element) => ({
          ariaHidden: element.getAttribute("aria-hidden"),
          text: element.textContent,
        })),
        headerRound: [
          ...document.querySelectorAll(".broadcast-meta > div:nth-child(2) dd"),
        ].map((element) => ({
          ariaHidden: element.getAttribute("aria-hidden"),
          text: element.textContent,
        })),
        liveAnnouncements: [
          ...document.querySelectorAll(".live-announcement[role='status']"),
        ].map((element) => ({
          ariaHidden: element.getAttribute("aria-hidden"),
          text: element.textContent,
        })),
        panel,
        participantCards,
        participantCardsContained,
        phase,
        previous,
        resultValues: [
          ...document.querySelectorAll(
            ".phase-panel .average-value, .phase-panel .previous-average > strong, .phase-panel figcaption small",
          ),
        ].map((element) => ({
          ariaHidden: element.getAttribute("aria-hidden"),
          hiddenByPhasePanel:
            element.closest(".phase-panel")?.getAttribute("aria-hidden") ===
            "true",
          kind: element.matches("figcaption small") ? "metadata" : "average",
          text: element.textContent,
        })),
        viewportWidth: document.documentElement.clientWidth,
      });

      const settled =
        panel?.transform === "none" &&
        final?.transform === "none" &&
        previous === null &&
        document
          .querySelector(".app-shell")
          ?.classList.contains("app-shell--revealed") === true;
      settledFrames = settled ? settledFrames + 1 : 0;
      if (settledFrames >= 3) {
        break;
      }
    }

    return {
      documentWidth: document.documentElement.scrollWidth,
      frames,
      initialCard,
      initialPanel,
      sameCard: cardNode === document.querySelector(cardSelector),
      samePanel: panelNode === document.querySelector(panelSelector),
      viewportWidth: document.documentElement.clientWidth,
    };
  });
}

export function visible(element: SampledElement | null): boolean {
  return element !== null && element.opacity > 0.02;
}
