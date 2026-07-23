import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  PARTICIPANT_CARD_LIMIT,
  ParticipantGrid,
} from "../src/components/ParticipantGrid";
import {
  RECENT_HISTORY_LIMIT,
  RoundHistory,
} from "../src/components/RoundHistory";
import {
  VoteDistribution,
  compactLabel,
} from "../src/components/VoteDistribution";
import type {
  DistributionVote,
  HistoryEntry,
  RevealedParticipant,
} from "../src/scoreboard-model";

describe("variable scoreboard collections", () => {
  it.each([
    ["1", "1"],
    ["13", "13"],
    ["?", "?"],
    ["Option 11", "O11"],
    ["Extra large", "EL"],
    ["Fibonacci", "Fii"],
  ])("compacts the label %s as %s", (label, expected) => {
    expect(compactLabel(label)).toBe(expected);
  });

  it("renders more than ten participant cards using stable IDs", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const participants = Array.from(
      { length: 12 },
      (_, index): RevealedParticipant => ({
        id: `participant-${index.toString()}`,
        name:
          index < 2
            ? "Same display name"
            : `Participant ${(index + 1).toString()}`,
        vote: "5",
      }),
    );
    const view = render(
      <ParticipantGrid participants={participants} phase="revealed" />,
    );
    const list = view.getByRole("list");

    expect(view.getAllByRole("listitem")).toHaveLength(12);
    expect(list.style.getPropertyValue("--participant-columns")).toBe("4");
    expect(list.style.getPropertyValue("--participant-rows")).toBe("3");
    expect(list.style.getPropertyValue("--participant-mobile-columns")).toBe(
      "2",
    );
    expect(list.style.getPropertyValue("--participant-mobile-rows")).toBe("6");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("summarizes participants beyond the visible card limit", () => {
    const participants = Array.from(
      { length: 18 },
      (_, index): RevealedParticipant => ({
        id: `overflow-${index.toString()}`,
        name: `Participant ${(index + 1).toString()}`,
        vote: "5",
      }),
    );
    const view = render(
      <ParticipantGrid participants={participants} phase="revealed" />,
    );
    const list = view.getByRole("list");

    expect(view.getAllByRole("listitem")).toHaveLength(PARTICIPANT_CARD_LIMIT);
    expect(
      view.getByRole("listitem", { name: "7 more participants" }),
    ).toBeDefined();
    expect(view.getByText("+7")).toBeDefined();
    expect(view.getByText("Participant 11")).toBeDefined();
    expect(view.queryByText("Participant 12")).toBeNull();
    expect(list.style.getPropertyValue("--participant-columns")).toBe("4");
    expect(list.style.getPropertyValue("--participant-rows")).toBe("3");
  });

  it("renders a distribution whose option count differs from the fixture", () => {
    const distribution = Array.from(
      { length: 11 },
      (_, index): DistributionVote => ({
        count: index,
        id: `option-${index.toString()}`,
        label: `Option ${(index + 1).toString()}`,
      }),
    );
    const view = render(
      <VoteDistribution
        distribution={distribution}
        meta="11 options"
        title="Variable distribution"
        titleId="variable-distribution-title"
      />,
    );

    expect(view.container.querySelectorAll(".bar-slot")).toHaveLength(11);
    expect(
      view.container
        .querySelector(".vote-distribution")
        ?.getAttribute("data-density"),
    ).toBe("dense");
    const labels = view.container.querySelectorAll<HTMLElement>(".bar-label");
    expect(labels[10]?.title).toBe("Option 11");
    expect(labels[10]?.getAttribute("data-compact-label")).toBe("O11");
    expect(
      view.getByRole("img", {
        name: /Variable distribution:.*Option 11 10/,
      }),
    ).toBeDefined();
  });

  it("shows only the intentional recent-history window", () => {
    const history = Array.from({ length: 7 }, (_, index): HistoryEntry => ({
      age: `${(index + 1).toString()} min ago`,
      average: "5.0",
      id: `round-${(7 - index).toString()}`,
      round: 7 - index,
    }));
    const view = render(<RoundHistory history={history} />);

    expect(view.getAllByRole("listitem")).toHaveLength(RECENT_HISTORY_LIMIT);
    expect(view.getByText("Round 3")).toBeDefined();
    expect(view.queryByText("Round 2")).toBeNull();
    expect(view.queryByText("Round 1")).toBeNull();
  });
});
