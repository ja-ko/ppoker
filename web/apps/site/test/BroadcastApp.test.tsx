import type { ClientSnapshot, Player } from "@ppoker/web-client";
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BroadcastApp, BroadcastRevealGate } from "../src/BroadcastApp";
import {
  createFakeClient,
  makeSnapshot,
  snapshotWithStatus,
} from "./fake-client";
import { playingFixture } from "./scoreboard-fixtures";

describe("spectator broadcast app", () => {
  it("hides pending synchronization states but renders unsupported phases and terminal errors", () => {
    const fake = createFakeClient(snapshotWithStatus("connecting"));
    const view = render(
      <BroadcastApp
        client={fake.client}
        connectError={null}
        revealAt={null}
        room="planning"
      />,
    );
    expect(view.container.textContent).toBe("");

    act(() => {
      fake.publish(makeSnapshot({ revision: 2, status: "open" }));
    });
    expect(view.container.textContent).toBe("");
    expect(view.queryByRole("status")).toBeNull();

    act(() => {
      fake.publish(
        openSnapshot({
          revision: 3,
          room: {
            deck: [],
            name: "planning",
            phase: "unknown",
            players: [],
          },
        }),
      );
    });
    expect(view.getByText("Unknown room phase")).toBeDefined();
    expect(view.getAllByRole("alert")).toHaveLength(1);

    act(() => {
      fake.publish(
        makeSnapshot({
          revision: 4,
          status: "closed",
          terminalError: { code: "Transport", message: "socket lost" },
        }),
      );
    });
    expect(view.getByText("Connection ended")).toBeDefined();
    expect(view.getByText(/socket lost/)).toBeDefined();
    expect(view.getAllByRole("alert")).toHaveLength(1);
  });

  it("renders playing and revealed snapshots without issuing commands", () => {
    const fake = createFakeClient(
      openSnapshot({
        room: {
          deck: ["1", "5", "?"],
          name: "planning",
          phase: "playing",
          players: [player("Ada", { state: "hidden" })],
        },
      }),
    );
    const view = render(
      <BroadcastApp
        client={fake.client}
        connectError={null}
        revealAt={null}
        room="planning"
      />,
    );
    expect(view.getByRole("heading", { name: "Cards in play" })).toBeDefined();
    expect(
      view.container
        .querySelector(".scorebug")
        ?.classList.contains("scorebug--status"),
    ).toBe(false);
    expect(view.container.querySelector(".scorebug")?.children).toHaveLength(4);

    act(() => {
      fake.publish(
        openSnapshot({
          average: 5,
          revision: 2,
          room: {
            deck: ["1", "5", "?"],
            name: "planning",
            phase: "revealed",
            players: [
              player("Ada", {
                state: "revealed",
                value: { kind: "number", value: 5 },
              }),
            ],
          },
        }),
      );
    });
    expect(
      view.getByRole("heading", { name: "Participant cards" }),
    ).toBeDefined();

    expect(fake.client.connect).not.toHaveBeenCalled();
    expect(fake.client.vote).not.toHaveBeenCalled();
    expect(fake.client.retractVote).not.toHaveBeenCalled();
    expect(fake.client.reveal).not.toHaveBeenCalled();
    expect(fake.client.startNewRound).not.toHaveBeenCalled();
    expect(fake.client.chat).not.toHaveBeenCalled();
    expect(fake.client.rename).not.toHaveBeenCalled();
    expect(fake.client[Symbol.dispose]).not.toHaveBeenCalled();
    view.unmount();
    expect(fake.client.close).not.toHaveBeenCalled();
  });

  it("replaces an established scoreboard with terminal and closed status headers", () => {
    const fake = createFakeClient(
      openSnapshot({
        room: {
          deck: ["1", "5"],
          name: "Established room",
          phase: "playing",
          players: [player("Ada", { state: "hidden" })],
        },
        roundNumber: 4,
      }),
    );
    const view = render(
      <BroadcastApp
        client={fake.client}
        connectError={null}
        revealAt={null}
        room="planning"
      />,
    );

    expect(view.getByRole("heading", { name: "Cards in play" })).toBeDefined();
    expect(view.container.querySelector(".broadcast-meta")).not.toBeNull();
    expect(view.container.querySelector(".live-flag")).not.toBeNull();

    act(() => {
      fake.publish(
        makeSnapshot({
          revision: 2,
          status: "closed",
          terminalError: { code: "Transport", message: "terminal fixture" },
        }),
      );
    });
    expect(view.getByRole("alert")).toBeDefined();
    expect(view.getByText("Connection ended")).toBeDefined();
    expect(view.queryByText("Cards in play")).toBeNull();
    expect(view.container.querySelector(".broadcast-main")).toBeNull();
    expect(view.container.querySelector(".broadcast-meta")).toBeNull();
    expect(view.container.querySelector(".live-flag")).toBeNull();
    expect(view.container.querySelector(".scorebug")?.classList).toContain(
      "scorebug--status",
    );
    expect(view.container.querySelector(".scorebug")?.children).toHaveLength(2);
    expect(
      view.container.querySelector(".status-panel")?.firstElementChild
        ?.classList,
    ).toContain("panel-header");

    act(() => {
      fake.publish(makeSnapshot({ revision: 3, status: "closed" }));
    });
    expect(view.getByRole("alert")).toBeDefined();
    expect(view.getByText("Connection closed")).toBeDefined();
    expect(view.container.querySelector(".broadcast-meta")).toBeNull();
    expect(view.container.querySelector(".live-flag")).toBeNull();
    expect(fake.client.connect).not.toHaveBeenCalled();
  });

  it("renders a synchronous connection failure before a snapshot opens", () => {
    const fake = createFakeClient(snapshotWithStatus("disconnected"));
    const view = render(
      <BroadcastApp
        client={fake.client}
        connectError={new Error("constructor refused connection")}
        revealAt={null}
        room="planning"
      />,
    );
    expect(view.getByText("Connection failed")).toBeDefined();
    expect(view.getByText("constructor refused connection")).toBeDefined();
    expect(view.getAllByRole("alert")).toHaveLength(1);
  });

  it("waits out the reveal deadline when a displayable model arrives early", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const view = render(
      <BroadcastRevealGate revealAt={1_700} scoreboard={playingFixture}>
        {() => <p>Scoreboard ready</p>}
      </BroadcastRevealGate>,
    );

    expect(view.queryByText("Scoreboard ready")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(699);
    });
    expect(view.queryByText("Scoreboard ready")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(view.getByText("Scoreboard ready")).toBeDefined();
    vi.useRealTimers();
  });

  it("reveals immediately when the displayable model arrives after the deadline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const view = render(
      <BroadcastRevealGate revealAt={1_700} scoreboard={null}>
        {() => <p>Late scoreboard ready</p>}
      </BroadcastRevealGate>,
    );

    act(() => {
      vi.advanceTimersByTime(900);
    });
    view.rerender(
      <BroadcastRevealGate revealAt={1_700} scoreboard={playingFixture}>
        {() => <p>Late scoreboard ready</p>}
      </BroadcastRevealGate>,
    );

    expect(view.getByText("Late scoreboard ready")).toBeDefined();
    vi.useRealTimers();
  });

  it("does not wait for a throttled timer callback after the deadline passes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const view = render(
      <BroadcastRevealGate revealAt={1_700} scoreboard={null}>
        {() => <p>Snapshot rendered after deadline</p>}
      </BroadcastRevealGate>,
    );

    vi.setSystemTime(1_900);
    view.rerender(
      <BroadcastRevealGate revealAt={1_700} scoreboard={playingFixture}>
        {() => <p>Snapshot rendered after deadline</p>}
      </BroadcastRevealGate>,
    );

    expect(view.getByText("Snapshot rendered after deadline")).toBeDefined();
    vi.useRealTimers();
  });
});

function openSnapshot(overrides: Partial<ClientSnapshot>): ClientSnapshot {
  return makeSnapshot({ revision: 1, status: "open", ...overrides });
}

function player(name: string, vote: Player["vote"]): Player {
  return { isYou: false, name, userType: "player", vote };
}
