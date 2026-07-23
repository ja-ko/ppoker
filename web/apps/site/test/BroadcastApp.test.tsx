import type { ClientSnapshot, Player } from "@ppoker/web-client";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BroadcastApp } from "../src/BroadcastApp";
import {
  createFakeClient,
  makeSnapshot,
  snapshotWithStatus,
} from "./fake-client";

describe("spectator broadcast app", () => {
  it("renders connecting, no-room, unknown-phase and terminal states", () => {
    const fake = createFakeClient(snapshotWithStatus("connecting"));
    const view = render(
      <BroadcastApp client={fake.client} connectError={null} room="planning" />,
    );
    expect(view.getByText("Connecting to room")).toBeDefined();
    expect(view.getAllByRole("status")).toHaveLength(1);

    act(() => {
      fake.publish(makeSnapshot({ revision: 2, status: "open" }));
    });
    expect(view.getByText("Waiting for room state")).toBeDefined();
    expect(view.getAllByRole("status")).toHaveLength(1);

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
      <BroadcastApp client={fake.client} connectError={null} room="planning" />,
    );
    expect(view.getByRole("heading", { name: "Cards in play" })).toBeDefined();

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

  it("renders a synchronous connection failure before a snapshot opens", () => {
    const fake = createFakeClient(snapshotWithStatus("disconnected"));
    const view = render(
      <BroadcastApp
        client={fake.client}
        connectError={new Error("constructor refused connection")}
        room="planning"
      />,
    );
    expect(view.getByText("Connection failed")).toBeDefined();
    expect(view.getByText("constructor refused connection")).toBeDefined();
    expect(view.getAllByRole("alert")).toHaveLength(1);
  });
});

function openSnapshot(overrides: Partial<ClientSnapshot>): ClientSnapshot {
  return makeSnapshot({ revision: 1, status: "open", ...overrides });
}

function player(name: string, vote: Player["vote"]): Player {
  return { isYou: false, name, userType: "player", vote };
}
