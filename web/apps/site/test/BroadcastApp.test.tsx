import type { ClientSnapshot, Player, PokerClient } from "@ppoker/web-client";
import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

import { BroadcastApp, BroadcastRevealGate } from "../src/BroadcastApp";
import {
  MAX_OBSERVED_AUTO_REVEAL_MS,
  type ObservedAutoRevealScheduler,
} from "../src/observed-auto-reveal";
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

  it("shows only live auto-reveal announcements without issuing commands", () => {
    const clock = new ManualScheduler();
    const fake = createFakeClient(coveredPlayingSnapshot());
    const view = render(
      <BroadcastApp
        autoRevealScheduler={clock}
        client={fake.client}
        connectError={null}
        revealAt={null}
        room="planning"
      />,
    );

    expect(autoRevealOverlay(view.container)).toBeNull();
    act(() => {
      fake.publishRoomEvent(autoRevealAnnouncement(3_000));
    });

    const countdown = getAutoRevealOverlay(view.container);
    expect(countdown.getAttribute("data-remaining-ms")).toBe("3000");
    expect(countdown.textContent).toContain("Auto-reveal");
    expect(countdown.getAttribute("aria-hidden")).toBe("true");
    expect(view.queryByRole("timer")).toBeNull();
    expect(view.getAllByRole("status")).toHaveLength(1);
    expect(view.getByRole("status").textContent).toContain(
      "Auto-reveal countdown active.",
    );
    expect(fake.client.subscribeRoomEvent).toHaveBeenCalledWith(
      "autoRevealAnnounced",
      expect.any(Function),
    );
    expect(fake.client.connect).not.toHaveBeenCalled();
    expect(fake.client.announceAutoReveal).not.toHaveBeenCalled();
    expect(fake.client.vote).not.toHaveBeenCalled();
    expect(fake.client.retractVote).not.toHaveBeenCalled();
    expect(fake.client.reveal).not.toHaveBeenCalled();
    expect(fake.client.startNewRound).not.toHaveBeenCalled();
    expect(fake.client.close).not.toHaveBeenCalled();
  });

  it("does not replay a retained auto-reveal announcement", () => {
    const fake = createFakeClient(
      coveredPlayingSnapshot({
        roomEvents: [autoRevealAnnouncement(3_000)],
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

    expect(autoRevealOverlay(view.container)).toBeNull();
    expect(fake.client.subscribeRoomEvent).toHaveBeenCalledOnce();
    expect(fake.client.reveal).not.toHaveBeenCalled();
  });

  it("does not treat retained history added after subscription as live", () => {
    const fake = createFakeClient(coveredPlayingSnapshot());
    const view = render(
      <BroadcastApp
        client={fake.client}
        connectError={null}
        revealAt={null}
        room="planning"
      />,
    );

    act(() => {
      const snapshot = fake.client.getSnapshot();
      fake.publish({
        ...snapshot,
        revision: snapshot.revision + 1,
        roomEvents: [autoRevealAnnouncement(3_000)],
      });
    });
    expect(autoRevealOverlay(view.container)).toBeNull();
    expect(view.getByRole("status").textContent).not.toContain("Auto-reveal");

    act(() => {
      fake.publishRoomEvent(autoRevealAnnouncement(3_000));
    });
    expect(getAutoRevealOverlay(view.container)).toBeDefined();
  });

  it("models live event subscription start indexes in the site fake", () => {
    const fake = createFakeClient(coveredPlayingSnapshot());
    const existingListener = vi.fn();
    const duringSnapshotListener = vi.fn();
    fake.client.subscribeRoomEvent("autoRevealAnnounced", existingListener);
    let subscribedDuringSnapshot = false;
    fake.client.subscribe(() => {
      if (!subscribedDuringSnapshot) {
        subscribedDuringSnapshot = true;
        fake.client.subscribeRoomEvent(
          "autoRevealAnnounced",
          duringSnapshotListener,
        );
      }
    });

    fake.publishRoomEvent(autoRevealAnnouncement(3_000));
    expect(existingListener).toHaveBeenCalledOnce();
    expect(duringSnapshotListener).not.toHaveBeenCalled();

    fake.publishRoomEvent(autoRevealAnnouncement(2_000));
    expect(existingListener).toHaveBeenCalledTimes(2);
    expect(duringSnapshotListener).toHaveBeenCalledOnce();
    expect(duringSnapshotListener).toHaveBeenCalledWith({ countdownMs: 2_000 });
  });

  it("restarts from a newer announcement and expires without revealing", () => {
    const clock = new ManualScheduler();
    const fake = createFakeClient(coveredPlayingSnapshot());
    const view = render(
      <BroadcastApp
        autoRevealScheduler={clock}
        client={fake.client}
        connectError={null}
        revealAt={null}
        room="planning"
      />,
    );

    act(() => {
      fake.publishRoomEvent(autoRevealAnnouncement(3_000));
    });
    const firstKey = getAutoRevealOverlay(view.container).getAttribute(
      "data-countdown-key",
    );
    act(() => {
      clock.advance(1_200);
      fake.publishRoomEvent(autoRevealAnnouncement(5_000));
    });
    const replacement = getAutoRevealOverlay(view.container);
    expect(replacement.getAttribute("data-remaining-ms")).toBe("5000");
    expect(replacement.getAttribute("data-countdown-key")).not.toBe(firstKey);

    act(() => {
      clock.advance(4_999);
    });
    expect(getAutoRevealOverlay(view.container)).toBeDefined();
    act(() => {
      clock.advance(1);
    });
    expect(autoRevealOverlay(view.container)).toBeNull();
    expect(fake.client.reveal).not.toHaveBeenCalled();
  });

  it("clears on a retraction, round change, and phase change", () => {
    const fake = createFakeClient(coveredPlayingSnapshot());
    const view = render(
      <BroadcastApp
        client={fake.client}
        connectError={null}
        revealAt={null}
        room="planning"
      />,
    );
    const announce = (): void => {
      act(() => {
        fake.publishRoomEvent(autoRevealAnnouncement(20_000));
      });
      expect(getAutoRevealOverlay(view.container)).toBeDefined();
    };

    announce();
    act(() => {
      fake.publish(
        coveredPlayingSnapshot({
          revision: fake.client.getSnapshot().revision + 1,
          room: playingRoom([player("Ada", { state: "missing" })]),
        }),
      );
    });
    expect(autoRevealOverlay(view.container)).toBeNull();

    act(() => {
      fake.publish(
        coveredPlayingSnapshot({
          revision: fake.client.getSnapshot().revision + 1,
          roundNumber: 2,
        }),
      );
    });
    announce();
    act(() => {
      fake.publish(
        coveredPlayingSnapshot({
          revision: fake.client.getSnapshot().revision + 1,
          roundNumber: 3,
        }),
      );
    });
    expect(autoRevealOverlay(view.container)).toBeNull();

    announce();
    act(() => {
      const snapshot = fake.client.getSnapshot();
      fake.publish({
        ...snapshot,
        revision: snapshot.revision + 1,
        room: { ...playingRoom(), phase: "revealed" },
      });
    });
    expect(autoRevealOverlay(view.container)).toBeNull();
    expect(fake.client.reveal).not.toHaveBeenCalled();
  });

  it.each([
    ["disconnect", { status: "disconnected" as const }],
    ["close", { status: "closed" as const }],
    [
      "terminal error",
      {
        terminalError: {
          code: "Transport" as const,
          message: "spectator transport ended",
        },
      },
    ],
  ])("clears on client %s", (_label, overrides) => {
    const fake = createFakeClient(coveredPlayingSnapshot());
    const view = render(
      <BroadcastApp
        client={fake.client}
        connectError={null}
        revealAt={null}
        room="planning"
      />,
    );
    act(() => {
      fake.publishRoomEvent(autoRevealAnnouncement(20_000));
    });
    expect(getAutoRevealOverlay(view.container)).toBeDefined();

    act(() => {
      const snapshot = fake.client.getSnapshot();
      fake.publish({
        ...snapshot,
        ...overrides,
        revision: snapshot.revision + 1,
      });
    });
    expect(autoRevealOverlay(view.container)).toBeNull();
    expect(fake.client.reveal).not.toHaveBeenCalled();
  });

  it("unsubscribes replaced and unmounted clients under Strict Mode", () => {
    const clock = new ManualScheduler();
    const first = createFakeClient(coveredPlayingSnapshot());
    const second = createFakeClient(coveredPlayingSnapshot());
    const app = (client: typeof first.client) => (
      <StrictMode>
        <BroadcastApp
          autoRevealScheduler={clock}
          client={client}
          connectError={null}
          revealAt={null}
          room="planning"
        />
      </StrictMode>
    );
    const view = render(app(first.client));
    expect(first.activeListenerCount()).toBe(2);
    expect(first.activeRoomEventListenerCount()).toBe(1);

    act(() => {
      first.publishRoomEvent(autoRevealAnnouncement(3_000));
    });
    expect(getAutoRevealOverlay(view.container)).toBeDefined();
    const staleAnnouncement = latestAnnouncementListener(first.client);
    const staleSnapshot = latestSnapshotListener(first.client);
    const staleTimer = clock.nextCallback();

    view.rerender(app(second.client));
    expect(first.activeListenerCount()).toBe(0);
    expect(first.activeRoomEventListenerCount()).toBe(0);
    expect(second.activeListenerCount()).toBe(2);
    expect(second.activeRoomEventListenerCount()).toBe(1);
    expect(autoRevealOverlay(view.container)).toBeNull();
    act(() => {
      first.publishRoomEvent(autoRevealAnnouncement(3_000));
      staleAnnouncement({ countdownMs: 3_000 });
      staleSnapshot();
      staleTimer();
    });
    expect(autoRevealOverlay(view.container)).toBeNull();
    act(() => {
      second.publishRoomEvent(autoRevealAnnouncement(3_000));
    });
    expect(getAutoRevealOverlay(view.container)).toBeDefined();
    const disposedAnnouncement = latestAnnouncementListener(second.client);
    const disposedSnapshot = latestSnapshotListener(second.client);
    const disposedTimer = clock.nextCallback();

    view.unmount();
    expect(second.activeListenerCount()).toBe(0);
    expect(second.activeRoomEventListenerCount()).toBe(0);
    act(() => {
      disposedAnnouncement({ countdownMs: 3_000 });
      disposedSnapshot();
      disposedTimer();
    });
    expect(view.container.childElementCount).toBe(0);
    expect(first.client.reveal).not.toHaveBeenCalled();
    expect(second.client.reveal).not.toHaveBeenCalled();
  });

  it("clears and resubscribes when the billboard room context changes", () => {
    const fake = createFakeClient(coveredPlayingSnapshot());
    const app = (room: string) => (
      <BroadcastApp
        client={fake.client}
        connectError={null}
        revealAt={null}
        room={room}
      />
    );
    const view = render(app("planning"));
    act(() => {
      fake.publishRoomEvent(autoRevealAnnouncement(3_000));
    });
    expect(getAutoRevealOverlay(view.container)).toBeDefined();
    const staleAnnouncement = latestAnnouncementListener(fake.client);

    view.rerender(app("another-room"));
    expect(autoRevealOverlay(view.container)).toBeNull();
    expect(fake.activeListenerCount()).toBe(2);
    expect(fake.activeRoomEventListenerCount()).toBe(1);
    act(() => {
      staleAnnouncement({ countdownMs: 3_000 });
    });
    expect(autoRevealOverlay(view.container)).toBeNull();
  });

  it("uses the monotonic deadline when the expiry callback is delayed", () => {
    const clock = new ManualScheduler();
    const fake = createFakeClient(coveredPlayingSnapshot());
    const view = render(
      <BroadcastApp
        autoRevealScheduler={clock}
        client={fake.client}
        connectError={null}
        revealAt={null}
        room="planning"
      />,
    );
    act(() => {
      fake.publishRoomEvent(autoRevealAnnouncement(3_000));
    });

    clock.elapse(4_500);
    expect(getAutoRevealOverlay(view.container)).toBeDefined();
    act(() => {
      clock.runNext();
    });
    expect(autoRevealOverlay(view.container)).toBeNull();
    expect(fake.client.reveal).not.toHaveBeenCalled();
  });

  it("rejects zero durations and caps extreme live announcements", () => {
    const clock = new ManualScheduler();
    const fake = createFakeClient(coveredPlayingSnapshot());
    const view = render(
      <BroadcastApp
        autoRevealScheduler={clock}
        client={fake.client}
        connectError={null}
        revealAt={null}
        room="planning"
      />,
    );

    act(() => {
      fake.publishRoomEvent(autoRevealAnnouncement(1_000));
      fake.publishRoomEvent(autoRevealAnnouncement(0));
    });
    expect(autoRevealOverlay(view.container)).toBeNull();

    act(() => {
      fake.publishRoomEvent(autoRevealAnnouncement(Number.MAX_VALUE));
    });
    expect(
      getAutoRevealOverlay(view.container).getAttribute("data-remaining-ms"),
    ).toBe(MAX_OBSERVED_AUTO_REVEAL_MS.toString());
    act(() => {
      clock.advance(MAX_OBSERVED_AUTO_REVEAL_MS);
    });
    expect(autoRevealOverlay(view.container)).toBeNull();
  });

  it("mounts a pre-gate announcement at its remaining monotonic fraction", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const clock = new ManualScheduler();
    const fake = createFakeClient(coveredPlayingSnapshot());
    const view = render(
      <BroadcastApp
        autoRevealScheduler={clock}
        client={fake.client}
        connectError={null}
        revealAt={1_700}
        room="planning"
      />,
    );

    act(() => {
      clock.advance(280);
      vi.advanceTimersByTime(280);
      fake.publishRoomEvent(autoRevealAnnouncement(2_000));
    });
    expect(autoRevealOverlay(view.container)).toBeNull();

    act(() => {
      clock.advance(420);
      vi.advanceTimersByTime(420);
    });
    const countdown = getAutoRevealOverlay(view.container);
    expect(Number(countdown.dataset["remainingMs"])).toBe(1_580);
    expect(Number(countdown.dataset["initialProgress"])).toBeCloseTo(0.79, 5);
    expect(
      countdown.querySelector<HTMLElement>(".auto-reveal-countdown__fill")
        ?.style.transform,
    ).not.toBe("scaleX(0)");
    expect(fake.client.reveal).not.toHaveBeenCalled();
    vi.useRealTimers();
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

function coveredPlayingSnapshot(
  overrides: Partial<ClientSnapshot> = {},
): ClientSnapshot {
  return openSnapshot({
    room: playingRoom(),
    roundNumber: 1,
    ...overrides,
  });
}

function playingRoom(players: readonly Player[] = coveredPlayers()) {
  return {
    deck: ["1", "5", "?"],
    name: "planning",
    phase: "playing" as const,
    players,
  };
}

function coveredPlayers(): readonly Player[] {
  return [
    player("Ada", { state: "hidden" }),
    player("Ben", { state: "hidden" }),
  ];
}

function autoRevealAnnouncement(countdownMs: number) {
  return {
    kind: "autoRevealAnnounced" as const,
    value: { countdownMs },
  };
}

function autoRevealOverlay(container: HTMLElement): HTMLElement | null {
  return container.querySelector(
    '[data-auto-reveal-countdown="active"][data-present="true"]',
  );
}

function getAutoRevealOverlay(container: HTMLElement): HTMLElement {
  const overlay = autoRevealOverlay(container);
  if (overlay === null) {
    throw new Error("Expected an active auto-reveal overlay.");
  }
  return overlay;
}

function latestAnnouncementListener(
  client: PokerClient,
): (payload: { readonly countdownMs: number }) => void {
  const listener = vi.mocked(client.subscribeRoomEvent).mock.calls.at(-1)?.[1];
  if (listener === undefined) {
    throw new Error("Expected an auto-reveal event subscription.");
  }
  return listener;
}

function latestSnapshotListener(client: PokerClient): () => void {
  const listener = vi.mocked(client.subscribe).mock.calls.at(-1)?.[0];
  if (listener === undefined) {
    throw new Error("Expected a snapshot subscription.");
  }
  return listener;
}

class ManualScheduler implements ObservedAutoRevealScheduler {
  readonly #timers = new Map<
    number,
    { readonly callback: () => void; readonly deadline: number }
  >();
  #nextHandle = 1;
  #now = 100;

  readonly clearTimeout = (handle: unknown): void => {
    if (typeof handle === "number") {
      this.#timers.delete(handle);
    }
  };

  readonly now = (): number => this.#now;

  readonly setTimeout = (callback: () => void, delayMs: number): unknown => {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.#timers.set(handle, {
      callback,
      deadline: this.#now + delayMs,
    });
    return handle;
  };

  elapse(elapsedMs: number): void {
    this.#now += elapsedMs;
  }

  nextCallback(): () => void {
    const next = this.#nextTimer();
    if (next === undefined) {
      throw new Error("Expected a scheduled callback.");
    }
    return next[1].callback;
  }

  runNext(): void {
    const next = this.#nextTimer();
    if (next === undefined) {
      throw new Error("Expected a scheduled callback.");
    }
    this.#timers.delete(next[0]);
    next[1].callback();
  }

  advance(elapsedMs: number): void {
    const target = this.#now + elapsedMs;
    for (;;) {
      const next = [...this.#timers.entries()]
        .filter(([, timer]) => timer.deadline <= target)
        .toSorted((left, right) => left[1].deadline - right[1].deadline)[0];
      if (next === undefined) {
        break;
      }
      const [handle, timer] = next;
      this.#timers.delete(handle);
      this.#now = timer.deadline;
      timer.callback();
    }
    this.#now = target;
  }

  #nextTimer() {
    return [...this.#timers.entries()].toSorted(
      (left, right) => left[1].deadline - right[1].deadline,
    )[0];
  }
}
