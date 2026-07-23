import { expect, test } from "@playwright/test";

import {
  expectMotionSettled,
  expectNoCommands,
  expectNoHorizontalOverflow,
  expectPanelsSeparated,
  gotoFixture,
  samplePlayingToRevealed,
  visible,
} from "./helpers";

test.describe("scoreboard phase transitions", () => {
  test("moves the persistent participant panel into a revealed final", async ({
    page,
  }) => {
    await gotoFixture(page, "playing");
    await expectMotionSettled(page, "playing");

    const sample = await samplePlayingToRevealed(page);
    const finalFrame = sample.frames.at(-1);
    expect(sample.frames.length).toBeGreaterThan(5);
    expect(sample.samePanel).toBe(true);
    expect(sample.sameCard).toBe(true);
    expect(finalFrame?.panel).not.toBeNull();
    expect(finalFrame?.final).not.toBeNull();
    if (finalFrame?.panel === null || finalFrame?.panel === undefined) {
      throw new Error("Participant panel did not settle.");
    }
    const finalPanel = finalFrame.panel;
    expect(finalPanel.top).toBeGreaterThan(sample.initialPanel.top + 100);
    expect(
      Math.abs(finalPanel.height - sample.initialPanel.height),
    ).toBeGreaterThan(20);
    const smallerHeight = Math.min(
      sample.initialPanel.height,
      finalPanel.height,
    );
    const largerHeight = Math.max(
      sample.initialPanel.height,
      finalPanel.height,
    );
    expect(
      sample.frames.some(
        ({ panel }) =>
          panel !== null &&
          panel.opacity > 0.98 &&
          panel.transform !== "none" &&
          panel.height > smallerHeight + 2 &&
          panel.height < largerHeight - 2,
      ),
    ).toBe(true);
    expect(
      sample.frames.some(
        ({ panel }) =>
          panel !== null &&
          panel.transform !== "none" &&
          panel.top > sample.initialPanel.top + 5 &&
          panel.top < finalPanel.top - 5,
      ),
    ).toBe(true);

    const firstVisibleFinalIndex = sample.frames.findIndex(({ final }) =>
      visible(final),
    );
    const lastVisiblePreviousIndex = sample.frames.findLastIndex(
      ({ previous }) => visible(previous),
    );
    expect(firstVisibleFinalIndex).toBeGreaterThan(0);
    expect(lastVisiblePreviousIndex).toBeGreaterThanOrEqual(0);
    expect(lastVisiblePreviousIndex).toBeLessThan(firstVisibleFinalIndex);
    expect(
      sample.frames
        .slice(firstVisibleFinalIndex)
        .filter(({ final }) => visible(final))
        .every(({ previous }) => !visible(previous)),
    ).toBe(true);
    expect(
      sample.frames.some(
        ({ previous }) =>
          previous !== null &&
          previous.opacity > 0.05 &&
          previous.opacity < 0.95 &&
          previous.transform !== "none",
      ),
    ).toBe(true);
    expect(
      sample.frames.some(
        ({ final }) =>
          final !== null && final.opacity > 0.05 && final.opacity < 0.95,
      ),
    ).toBe(true);

    const overlapFrame = sample.frames.find(
      ({ final, panel }) =>
        visible(final) &&
        final?.ariaHidden === null &&
        panel !== null &&
        final.bottom > panel.top + 1,
    );
    expect(overlapFrame).toBeUndefined();
    expect(
      sample.frames
        .filter(({ previous }) => visible(previous))
        .every(
          ({ previous }) =>
            previous !== null &&
            previous.left >= 0 &&
            previous.right <= sample.viewportWidth,
        ),
    ).toBe(true);

    expect(
      sample.frames.every((frame) => {
        const exposedPhaseValues = frame.headerPhase.filter(
          ({ ariaHidden }) => ariaHidden !== "true",
        );
        const exposedRoundValues = frame.headerRound.filter(
          ({ ariaHidden }) => ariaHidden !== "true",
        );
        const exposedAverages = frame.resultValues.filter(
          ({ ariaHidden, hiddenByPhasePanel, kind }) =>
            kind === "average" && ariaHidden !== "true" && !hiddenByPhasePanel,
        );
        const exposedMetadata = frame.resultValues.filter(
          ({ ariaHidden, hiddenByPhasePanel, kind }) =>
            kind === "metadata" && ariaHidden !== "true" && !hiddenByPhasePanel,
        );
        if (
          frame.exposedPhasePanels > 1 ||
          frame.liveAnnouncements.length !== 1 ||
          frame.liveAnnouncements[0]?.ariaHidden === "true" ||
          exposedPhaseValues.length > 1 ||
          exposedRoundValues.length > 1 ||
          exposedAverages.length > 1 ||
          exposedMetadata.length > 1
        ) {
          return false;
        }
        if (frame.phase !== "revealed") {
          return (
            frame.liveAnnouncements[0]?.text?.includes("Voting open") === true
          );
        }
        const outgoingPanelsHidden =
          frame.previous === null || frame.previous.ariaHidden === "true";
        const incomingPanelExposed = frame.final?.ariaHidden === null;
        const outgoingHeaderHidden = frame.headerPhase
          .filter(({ text }) => text === "Voting open")
          .every(({ ariaHidden }) => ariaHidden === "true");
        const incomingHeader = frame.headerPhase.filter(
          ({ text }) => text === "Cards revealed",
        );
        const incomingHeaderExposed =
          incomingHeader.length === 1 &&
          incomingHeader.every(({ ariaHidden }) => ariaHidden === null);
        const incomingResultValues = frame.resultValues.filter(
          ({ hiddenByPhasePanel }) => !hiddenByPhasePanel,
        );
        const incomingResultValuesExposed =
          incomingResultValues.length >= 2 &&
          incomingResultValues.every(({ ariaHidden }) => ariaHidden === null);
        return (
          outgoingPanelsHidden &&
          incomingPanelExposed &&
          outgoingHeaderHidden &&
          incomingHeaderExposed &&
          incomingResultValuesExposed &&
          frame.liveAnnouncements[0]?.text?.includes("Cards revealed") === true
        );
      }),
    ).toBe(true);
    expect(
      sample.frames.some(
        ({ final, previous }) => final !== null && previous !== null,
      ),
    ).toBe(true);

    await expectMotionSettled(page, "revealed");
    await expect(
      page.getByRole("region", { name: "Vote distribution" }),
    ).toBeVisible();
    await expect(
      page.locator('[data-motion-key="broadcast:previous-round-panel"]'),
    ).toHaveCount(0);
    await expectPanelsSeparated(
      page.locator('[data-motion-key="broadcast:final-tally-panel"]'),
      page.locator('[data-motion-key="broadcast:participant-panel"]'),
    );
    expect(sample.documentWidth).toBeLessThanOrEqual(sample.viewportWidth);
    await expectNoHorizontalOverflow(page);
    await expectNoCommands(page);
  });

  test("prepends the completed round and removes the displaced fifth row", async ({
    page,
  }) => {
    await gotoFixture(page, "revealed");
    await expectMotionSettled(page, "revealed");

    const sample = await page.evaluate(async () => {
      const newSelector =
        '[data-motion-key="broadcast:history:round:9:source:5"]';
      const existingSelector =
        '[data-motion-key="broadcast:history:round:8:source:4"]';
      const outgoingSelector =
        '[data-motion-key="broadcast:history:round:4:source:0"]';
      const existingNode = document.querySelector(existingSelector);
      const outgoingNode = document.querySelector(outgoingSelector);
      const initialExistingTop = existingNode?.getBoundingClientRect().top;
      const initialOutgoingTop = outgoingNode?.getBoundingClientRect().top;
      if (
        existingNode === null ||
        initialExistingTop === undefined ||
        outgoingNode === null ||
        initialOutgoingTop === undefined
      ) {
        throw new Error("Initial history rows missing.");
      }

      window.__broadcastTestDriver.publishFixture("next-playing");
      const frames: {
        existing: { top: number; transform: string } | null;
        headerRound: readonly {
          ariaHidden: string | null;
          text: string | null;
        }[];
        newRow: { opacity: number; top: number; transform: string } | null;
        outgoing: {
          ariaHidden: string | null;
          opacity: number;
          top: number;
          transform: string;
        } | null;
      }[] = [];
      const startedAt = performance.now();
      let settledFrames = 0;
      while (performance.now() - startedAt < 2_500 && frames.length < 180) {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
        const newRow = document.querySelector<HTMLElement>(newSelector);
        const existing = document.querySelector<HTMLElement>(existingSelector);
        const outgoing = document.querySelector<HTMLElement>(outgoingSelector);
        frames.push({
          existing:
            existing === null
              ? null
              : {
                  top: existing.getBoundingClientRect().top,
                  transform: getComputedStyle(existing).transform,
                },
          headerRound: [
            ...document.querySelectorAll(
              ".broadcast-meta > div:nth-child(2) dd",
            ),
          ].map((element) => ({
            ariaHidden: element.getAttribute("aria-hidden"),
            text: element.textContent,
          })),
          newRow:
            newRow === null
              ? null
              : {
                  opacity: Number(getComputedStyle(newRow).opacity),
                  top: newRow.getBoundingClientRect().top,
                  transform: getComputedStyle(newRow).transform,
                },
          outgoing:
            outgoing === null
              ? null
              : {
                  ariaHidden: outgoing.getAttribute("aria-hidden"),
                  opacity: Number(getComputedStyle(outgoing).opacity),
                  top: outgoing.getBoundingClientRect().top,
                  transform: getComputedStyle(outgoing).transform,
                },
        });
        const settled =
          outgoing === null &&
          newRow !== null &&
          existing !== null &&
          getComputedStyle(newRow).transform === "none" &&
          getComputedStyle(existing).transform === "none";
        settledFrames = settled ? settledFrames + 1 : 0;
        if (settledFrames >= 3) {
          break;
        }
      }
      return {
        frames,
        initialExistingTop,
        initialOutgoingTop,
        sameExistingNode:
          existingNode === document.querySelector(existingSelector),
      };
    });

    const finalNewRow = sample.frames.findLast(
      ({ newRow }) => newRow !== null,
    )?.newRow;
    const finalExisting = sample.frames.findLast(
      ({ existing }) => existing !== null,
    )?.existing;
    expect(sample.sameExistingNode).toBe(true);
    expect(finalNewRow).not.toBeNull();
    expect(finalExisting).not.toBeNull();
    if (finalNewRow === null || finalNewRow === undefined) {
      throw new Error("New history row did not settle.");
    }
    expect(
      Math.min(
        ...sample.frames.flatMap(({ newRow }) =>
          newRow === null || newRow.opacity <= 0.01 ? [] : [newRow.top],
        ),
      ),
    ).toBeLessThan(finalNewRow.top - 3);
    expect(finalExisting?.top).toBeGreaterThan(sample.initialExistingTop + 5);
    expect(
      sample.frames.some(
        ({ existing }) => existing !== null && existing.transform !== "none",
      ),
    ).toBe(true);
    expect(
      sample.frames.filter(({ outgoing }) => outgoing !== null).length,
    ).toBeGreaterThan(0);
    const hiddenOutgoingFrames = sample.frames.flatMap(({ outgoing }) =>
      outgoing?.ariaHidden === "true" ? [outgoing] : [],
    );
    expect(hiddenOutgoingFrames.length).toBeGreaterThan(0);
    expect(
      hiddenOutgoingFrames.some(
        ({ opacity, top, transform }) =>
          (opacity > 0.02 && opacity < 0.98) ||
          (transform !== "none" &&
            Math.abs(top - sample.initialOutgoingTop) > 1),
      ),
    ).toBe(true);
    expect(
      sample.frames
        .filter(({ outgoing }) => outgoing !== null)
        .every(({ outgoing }) => outgoing?.ariaHidden === "true"),
    ).toBe(true);
    expect(
      sample.frames.some(({ headerRound }) =>
        [
          { ariaHidden: "true", text: "09" },
          { ariaHidden: null, text: "10" },
        ].every((expectedValue) =>
          headerRound.some(
            (value) =>
              value.ariaHidden === expectedValue.ariaHidden &&
              value.text === expectedValue.text,
          ),
        ),
      ),
    ).toBe(true);
    expect(
      sample.frames.every(({ headerRound }) => {
        const exposed = headerRound.filter(
          ({ ariaHidden }) => ariaHidden !== "true",
        );
        if (exposed.length > 1) {
          return false;
        }
        const incoming = headerRound.filter(({ text }) => text === "10");
        if (incoming.length === 0) {
          return true;
        }
        return (
          incoming.length === 1 &&
          incoming[0]?.ariaHidden === null &&
          headerRound
            .filter(({ text }) => text === "09")
            .every(({ ariaHidden }) => ariaHidden === "true")
        );
      }),
    ).toBe(true);

    const history = page.getByRole("list", {
      name: "Most recent completed rounds",
    });
    await expect(history.getByRole("listitem")).toHaveCount(5);
    await expect(history.getByRole("listitem")).toContainText([
      "Round 9",
      "Round 8",
      "Round 7",
      "Round 6",
      "Round 5",
    ]);
    await expect(
      page.locator('[data-motion-key="broadcast:history:round:4:source:0"]'),
    ).toHaveCount(0);
    await expectNoCommands(page);
  });

  test("settles a rapid reveal reversal without stale accessible panels", async ({
    page,
  }) => {
    await gotoFixture(page, "playing");
    await expectMotionSettled(page, "playing");

    const reversal = await page.evaluate(async () => {
      const panelSelector = '[data-motion-key="broadcast:participant-panel"]';
      const cardSelector = '[data-participant-id="player:Ada:1"]';
      const panelNode = document.querySelector(panelSelector);
      const cardNode = document.querySelector(cardSelector);
      const initialPanelBox = panelNode?.getBoundingClientRect();
      if (
        !(panelNode instanceof HTMLElement) ||
        initialPanelBox === undefined
      ) {
        throw new Error("Initial participant panel missing.");
      }
      window.__broadcastTestDriver.publishFixture("revealed");

      let interruptedGeometry:
        { height: number; top: number; transform: string } | undefined;
      for (let frame = 0; frame < 90; frame += 1) {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
        const panel = document.querySelector<HTMLElement>(panelSelector);
        if (panel === null) {
          continue;
        }
        const box = panel.getBoundingClientRect();
        const transform = getComputedStyle(panel).transform;
        if (
          transform !== "none" &&
          Math.abs(box.top - initialPanelBox.top) > 5 &&
          Math.abs(box.height - initialPanelBox.height) > 2
        ) {
          interruptedGeometry = {
            height: box.height,
            top: box.top,
            transform,
          };
          break;
        }
      }
      if (interruptedGeometry === undefined) {
        throw new Error(
          "Reveal never reached intermediate participant geometry.",
        );
      }
      window.__broadcastTestDriver.publishFixture("next-playing");
      let settledFrames = 0;
      for (let frame = 0; frame < 180; frame += 1) {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
        const panel = document.querySelector<HTMLElement>(panelSelector);
        const settled =
          document
            .querySelector(".app-shell")
            ?.classList.contains("app-shell--playing") === true &&
          document.querySelectorAll(".phase-panel").length === 1 &&
          document.querySelector(
            '[data-motion-key="broadcast:final-tally-panel"]',
          ) === null &&
          panel !== null &&
          getComputedStyle(panel).transform === "none";
        settledFrames = settled ? settledFrames + 1 : 0;
        if (settledFrames >= 3) {
          break;
        }
      }
      return {
        initialPanel: {
          height: initialPanelBox.height,
          top: initialPanelBox.top,
        },
        interruptedGeometry,
        sameCard: cardNode === document.querySelector(cardSelector),
        samePanel: panelNode === document.querySelector(panelSelector),
      };
    });

    expect(reversal.interruptedGeometry.transform).not.toBe("none");
    expect(
      Math.abs(reversal.interruptedGeometry.top - reversal.initialPanel.top),
    ).toBeGreaterThan(5);
    expect(
      Math.abs(
        reversal.interruptedGeometry.height - reversal.initialPanel.height,
      ),
    ).toBeGreaterThan(2);
    await expectMotionSettled(page, "playing");
    expect(reversal.sameCard).toBe(true);
    expect(reversal.samePanel).toBe(true);
    await expect(page.locator(".phase-panel")).toHaveCount(1);
    await expect(page.locator(".phase-panel[aria-hidden='true']")).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("region", { name: "Cards in play" }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Round 09" })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Participant cards" }),
    ).toHaveCount(0);
    await expect(page.locator(".broadcast-meta dd").nth(1)).toHaveText("10");
    await expect(
      page.getByRole("region", { name: "Vote distribution" }),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-motion-key="broadcast:final-tally-panel"]'),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-motion-key="broadcast:previous-round-panel"]'),
    ).toHaveCount(1);
    await expect(
      page.getByRole("list", { name: "Most recent completed rounds" }),
    ).toContainText("Round 9");
    await expect(page.getByRole("status")).toHaveText(
      "Round 10. Voting open. 6 of 10 responses locked.",
    );
    await expectNoCommands(page);
  });
});
