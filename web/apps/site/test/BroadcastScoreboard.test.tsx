import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BroadcastScoreboard } from "../src/BroadcastScoreboard";
import type {
  PlayingBroadcast,
  RevealedBroadcast,
} from "../src/scoreboard-model";
import {
  overflowFixture,
  playingFixture,
  revealedFixture,
} from "./scoreboard-fixtures";

describe("BroadcastScoreboard", () => {
  it("renders the hidden-card playing phase", () => {
    const view = render(<BroadcastScoreboard scoreboard={playingFixture} />);
    const participantGrid =
      view.container.querySelector<HTMLElement>(".participant-grid");

    expect(view.getByRole("heading", { name: "Cards in play" })).toBeDefined();
    expect(
      participantGrid?.style.getPropertyValue("--participant-columns"),
    ).toBe("5");
    expect(participantGrid?.style.getPropertyValue("--participant-rows")).toBe(
      "2",
    );
    expect(view.getAllByText("Locked")).toHaveLength(6);
    expect(view.getAllByText("Thinking")).toHaveLength(4);
    expect(view.queryByText("Participant cards")).toBeNull();

    expect(
      view.getByRole("heading", { level: 1, name: "Planning Poker Room" }),
    ).toBeDefined();
    expect(view.getByText(/Checkout Redesign \/ PX-082/)).toBeDefined();
    const roomAccess = view.getByRole("region", {
      name: "Room access preview",
    });
    expect(within(roomAccess).getByText("Preview")).toBeDefined();
    expect(within(roomAccess).getByText("Checkout Redesign")).toBeDefined();
    expect(within(roomAccess).getByText(/Join code coming soon/)).toBeDefined();
    expect(within(roomAccess).queryByRole("img")).toBeNull();
    expect(
      roomAccess.querySelector(".qr-code")?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(
      [...view.container.querySelectorAll(".panel")].every((panel) =>
        panel.firstElementChild?.classList.contains("panel-header"),
      ),
    ).toBe(true);
  });

  it("adds entrance choreography only when requested and keeps it mounted", () => {
    const view = render(<BroadcastScoreboard scoreboard={playingFixture} />);
    expect(view.container.querySelector('[data-entrance="line"]')).toBeNull();
    expect(view.container.querySelector(".scorebug")?.children).toHaveLength(4);

    view.rerender(<BroadcastScoreboard entrance scoreboard={playingFixture} />);
    const line = view.container.querySelector('[data-entrance="line"]');
    const body = view.container.querySelector('[data-entrance="body"]');
    expect(line).not.toBeNull();
    expect(view.container.querySelector(".scorebug")?.children).toHaveLength(5);

    view.rerender(
      <BroadcastScoreboard entrance scoreboard={revealedFixture} />,
    );
    expect(view.container.querySelector('[data-entrance="line"]')).toBe(line);
    expect(view.container.querySelector('[data-entrance="body"]')).toBe(body);
  });

  it("renders the revealed votes and final distribution", () => {
    const view = render(<BroadcastScoreboard scoreboard={revealedFixture} />);

    expect(
      view.getByRole("heading", { name: "Participant cards" }),
    ).toBeDefined();
    expect(view.getByText("Vote distribution")).toBeDefined();
    expect(
      view
        .getByRole("region", { name: "Vote distribution" })
        .getAttribute("aria-labelledby"),
    ).toBe("distribution-title");
    expect(view.getByText("Vote distribution").id).toBe("distribution-title");
    expect(view.getAllByText("5").length).toBeGreaterThan(1);
    expect(view.queryByText("Cards in play")).toBeNull();
  });

  it("renders a smaller first round without inventing previous results", () => {
    const firstRound = {
      displayTitle: "Planning Poker Room",
      history: [],
      observed: "00:12",
      participants: playingFixture.participants.slice(0, 3),
      phase: "playing",
      roomCode: "PX-082",
      roomName: "Checkout Redesign",
      round: 1,
    } satisfies PlayingBroadcast;
    const view = render(<BroadcastScoreboard scoreboard={firstRound} />);
    const responseTrack = view.getByRole("progressbar");

    expect(responseTrack.children).toHaveLength(3);
    expect(view.getAllByRole("listitem")).toHaveLength(3);
    expect(view.container.querySelector(".phase-panel")).toBeNull();
    expect(view.queryByText("Awaiting first result")).toBeNull();
    expect(view.getByRole("region", { name: "Round history" })).toBeDefined();
    expect(view.getByText("No completed rounds yet.")).toBeDefined();
    expect(view.queryByText("Final distribution")).toBeNull();
  });

  it("labels observer-local ages without claiming completion time", () => {
    const view = render(<BroadcastScoreboard scoreboard={playingFixture} />);

    expect(view.getAllByLabelText("Observed 1 min ago").length).toBeGreaterThan(
      0,
    );
    expect(view.queryByText(/Completed /)).toBeNull();
  });

  it("uses one polite live announcement for phase, round and responses", () => {
    const view = render(<BroadcastScoreboard scoreboard={playingFixture} />);
    const announcement = view.getByRole("status");

    expect(announcement.textContent).toBe(
      "Round 9. Voting open. 6 of 10 responses locked.",
    );
    view.rerender(
      <BroadcastScoreboard
        scoreboard={{ ...playingFixture, observed: "00:48" }}
      />,
    );
    expect(view.getByRole("status")).toBe(announcement);
    expect(announcement.textContent).toBe(
      "Round 9. Voting open. 6 of 10 responses locked.",
    );

    view.rerender(
      <BroadcastScoreboard
        scoreboard={{
          ...playingFixture,
          participants: playingFixture.participants.map((participant) =>
            participant.name === "Diego"
              ? { ...participant, locked: true }
              : participant,
          ),
        }}
      />,
    );
    expect(view.getAllByRole("status")).toHaveLength(1);
    expect(announcement.textContent).toBe(
      "Round 9. Voting open. 7 of 10 responses locked.",
    );

    view.rerender(<BroadcastScoreboard scoreboard={revealedFixture} />);
    expect(view.getAllByRole("status")).toHaveLength(1);
    expect(view.getByRole("status")).toBe(announcement);
    expect(announcement.textContent).toBe(
      "Round 8. Cards revealed. 10 responses revealed.",
    );
  });

  it("keeps full response totals when participant cards overflow", () => {
    const view = render(<BroadcastScoreboard scoreboard={overflowFixture} />);
    const responseTrack = view.getByRole("progressbar");

    expect(responseTrack.getAttribute("aria-valuemax")).toBe("18");
    expect(responseTrack.children).toHaveLength(18);
    expect(
      view.getByRole("listitem", { name: "7 more participants" }),
    ).toBeDefined();
  });

  it("preserves participant panel and card nodes across phase transitions", () => {
    const view = render(<BroadcastScoreboard scoreboard={playingFixture} />);
    const playingPanel = view.container.querySelector<HTMLElement>(
      '[data-motion-key="broadcast:participant-panel"]',
    );
    const playingCard = view.container.querySelector<HTMLElement>(
      '[data-participant-id="ada"]',
    );

    view.rerender(<BroadcastScoreboard scoreboard={revealedFixture} />);

    const revealedPanel = view.container.querySelector<HTMLElement>(
      '[data-motion-key="broadcast:participant-panel"]',
    );
    const revealedCard = view.container.querySelector<HTMLElement>(
      '[data-participant-id="ada"]',
    );
    expect(revealedPanel).toBe(playingPanel);
    expect(revealedPanel?.classList.contains("lineup-panel")).toBe(true);
    expect(revealedCard).toBe(playingCard);
    expect(revealedCard?.dataset["motionKey"]).toBe(
      "broadcast:participant:ada",
    );
    expect(revealedCard?.getAttribute("aria-label")).toBe("Ada: 5");
  });

  it("hides outgoing header values while exposing incoming definition values", () => {
    const view = render(<BroadcastScoreboard scoreboard={playingFixture} />);

    view.rerender(<BroadcastScoreboard scoreboard={revealedFixture} />);

    const phaseValues = view.container.querySelectorAll<HTMLElement>(
      ".broadcast-meta > div:first-child dd",
    );
    const roundValues = view.container.querySelectorAll<HTMLElement>(
      ".broadcast-meta > div:nth-child(2) dd",
    );
    expect(textElement(phaseValues, "Voting open").ariaHidden).toBe("true");
    expect(textElement(phaseValues, "Cards revealed").ariaHidden).toBeNull();
    expect(textElement(roundValues, "09").ariaHidden).toBe("true");
    expect(textElement(roundValues, "08").ariaHidden).toBeNull();
    expect(textElement(phaseValues, "Cards revealed").tagName).toBe("DD");
  });

  it("hides outgoing repeated result values and distribution metadata", () => {
    const updated = {
      ...revealedFixture,
      result: {
        ...revealedFixture.result,
        average: "8.0",
        numericResponses: 7,
        specialResponses: 3,
      },
    } satisfies RevealedBroadcast;
    const view = render(<BroadcastScoreboard scoreboard={revealedFixture} />);

    view.rerender(<BroadcastScoreboard scoreboard={updated} />);

    const averages = view.container.querySelectorAll<HTMLElement>(
      ".result-panel .average-value",
    );
    const metadata = view.container.querySelectorAll<HTMLElement>(
      ".result-panel figcaption small",
    );
    expect(textElement(averages, "5.3").ariaHidden).toBe("true");
    expect(textElement(averages, "8.0").ariaHidden).toBeNull();
    expect(textElement(metadata, "8 numeric / 2 special").ariaHidden).toBe(
      "true",
    );
    expect(
      textElement(metadata, "7 numeric / 3 special").ariaHidden,
    ).toBeNull();
    expect(textElement(metadata, "7 numeric / 3 special").tagName).toBe(
      "SMALL",
    );
  });
});

function textElement(elements: NodeListOf<HTMLElement>, text: string) {
  const element = [...elements].find(
    (candidate) => candidate.textContent === text,
  );
  if (element === undefined) {
    throw new Error(`Expected an element containing exactly "${text}".`);
  }
  return element;
}
