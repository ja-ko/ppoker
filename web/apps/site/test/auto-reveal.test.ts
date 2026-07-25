import type { ClientSnapshot, Player } from "@ppoker/web-client";
import { describe, expect, it, vi } from "vitest";

import {
  AUTO_REVEAL_DELAY_MS,
  AutoRevealController,
  createCommandIntent,
  createDrawingIntent,
  type MonotonicScheduler,
} from "../src/voting/auto-reveal";
import { makeSnapshot } from "./fake-client";

describe("AutoRevealController", () => {
  it("arms only after a successful first final-vote command", () => {
    const fixture = setup(soleLocalMissing());
    const failure = new Error("vote failed");
    expect(() =>
      fixture.controller.submitVote(createCommandIntent(), () => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(fixture.controller.getState()).toEqual({
      deadline: null,
      status: "idle",
    });

    fixture.controller.submitVote(createCommandIntent(), fixture.sendVote);
    expect(fixture.sendVote).toHaveBeenCalledOnce();
    expect(fixture.controller.getState()).toEqual({
      deadline: AUTO_REVEAL_DELAY_MS,
      status: "counting",
    });
  });

  it("uses exact three-second monotonic boundaries and tolerates an early timer", () => {
    const fixture = setup(soleLocalMissing());
    fixture.controller.submitVote(createCommandIntent(), fixture.sendVote);

    fixture.clock.advance(2_999);
    expect(fixture.sendReveal).not.toHaveBeenCalled();
    fixture.clock.runNextEarly();
    expect(fixture.sendReveal).not.toHaveBeenCalled();
    fixture.clock.advance(1);
    expect(fixture.sendReveal).toHaveBeenCalledOnce();
    expect(fixture.controller.getState().status).toBe("idle");
  });

  it("does not invalidate a non-optimistic command from the same cached revision", () => {
    const fixture = setup(soleLocalMissing());
    fixture.controller.submitVote(createCommandIntent(), fixture.sendVote);
    fixture.controller.observe(fixture.current.value);
    expect(fixture.controller.getState().status).toBe("counting");

    fixture.clock.advance(AUTO_REVEAL_DELAY_MS);
    expect(fixture.sendReveal).toHaveBeenCalledOnce();
  });

  it("cancels on a newer snapshot with any missing voter", () => {
    const fixture = setup(soleLocalMissing());
    fixture.controller.submitVote(createCommandIntent(), fixture.sendVote);
    fixture.publish(
      playingSnapshot(2, [
        player("Local", "hidden", true),
        player("Peer", "missing"),
      ]),
    );

    expect(fixture.controller.getState().status).toBe("idle");
    fixture.clock.advance(AUTO_REVEAL_DELAY_MS);
    expect(fixture.sendReveal).not.toHaveBeenCalled();
  });

  it("revalidates an unobserved latest snapshot at expiry", () => {
    const fixture = setup(soleLocalMissing());
    fixture.controller.submitVote(createCommandIntent(), fixture.sendVote);
    fixture.current.value = playingSnapshot(2, [
      player("Local", "hidden", true),
      player("Peer", "missing"),
    ]);

    fixture.clock.advance(AUTO_REVEAL_DELAY_MS);
    expect(fixture.sendReveal).not.toHaveBeenCalled();
    expect(fixture.controller.getState().status).toBe("idle");
  });

  it.each([
    ["disconnect", disconnectedSnapshot()],
    ["room change", soleLocalMissing({ name: "Another room", revision: 2 })],
    ["round change", soleLocalMissing({ revision: 2, roundNumber: 9 })],
    ["phase change", soleLocalMissing({ phase: "revealed", revision: 2 })],
    [
      "local disappearance",
      playingSnapshot(2, [
        player("Former local", "hidden"),
        player("Peer", "hidden"),
      ]),
    ],
  ])("cancels on %s", (_label, invalidSnapshot) => {
    const fixture = setup(soleLocalMissing());
    fixture.controller.submitVote(createCommandIntent(), fixture.sendVote);
    fixture.publish(invalidSnapshot);
    expect(fixture.controller.getState().status).toBe("idle");
  });

  it("does not arm with fewer than two strict voters", () => {
    const fixture = setup(
      playingSnapshot(1, [
        player("Local", "missing", true),
        player("Observer", "missing", false, "spectator"),
      ]),
    );
    fixture.controller.submitVote(createCommandIntent(), fixture.sendVote);
    fixture.clock.advance(AUTO_REVEAL_DELAY_MS);
    expect(fixture.sendVote).toHaveBeenCalledOnce();
    expect(fixture.sendReveal).not.toHaveBeenCalled();
  });

  it("restarts a full countdown for a replacement vote", () => {
    const fixture = setup(soleLocalMissing());
    fixture.controller.submitVote(createCommandIntent(), fixture.sendVote);
    fixture.publish(allCovered(2));
    fixture.clock.advance(1_250);

    fixture.controller.submitVote(createCommandIntent(), fixture.sendVote);
    expect(fixture.controller.getState()).toEqual({
      deadline: 4_250,
      status: "counting",
    });
    fixture.clock.advance(2_999);
    expect(fixture.sendReveal).not.toHaveBeenCalled();
    fixture.clock.advance(1);
    expect(fixture.sendReveal).toHaveBeenCalledOnce();
  });

  it("leaves a failed replacement command cancelled", () => {
    const fixture = setup(soleLocalMissing());
    fixture.controller.submitVote(createCommandIntent(), fixture.sendVote);
    const failure = new Error("replacement failed");
    expect(() =>
      fixture.controller.submitVote(createCommandIntent(), () => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(fixture.controller.getState().status).toBe("idle");
    fixture.clock.advance(AUTO_REVEAL_DELAY_MS);
    expect(fixture.sendReveal).not.toHaveBeenCalled();
  });

  it("deduplicates command intents without suppressing new replacement intents", () => {
    const fixture = setup(soleLocalMissing());
    const intent = createCommandIntent();
    expect(fixture.controller.submitVote(intent, fixture.sendVote)).toBe(true);
    fixture.clock.advance(500);
    expect(fixture.controller.submitVote(intent, fixture.sendVote)).toBe(false);
    expect(fixture.sendVote).toHaveBeenCalledOnce();
    expect(fixture.controller.getState()).toMatchObject({ deadline: 3_000 });

    fixture.publish(allCovered(2));
    expect(
      fixture.controller.submitVote(createCommandIntent(), fixture.sendVote),
    ).toBe(true);
    expect(fixture.sendVote).toHaveBeenCalledTimes(2);
    expect(fixture.controller.getState()).toMatchObject({ deadline: 3_500 });
  });

  it("drawing immediately hides the countdown and restarts only after a covered number vote", () => {
    const fixture = setup(soleLocalMissing());
    fixture.controller.submitVote(createCommandIntent(), fixture.sendVote);
    fixture.publish(allCovered(2));
    fixture.clock.advance(900);

    const drawing = fixture.controller.startDrawing();
    expect(fixture.controller.getState()).toEqual({
      deadline: null,
      status: "idle",
    });
    fixture.clock.advance(600);
    const submitNumber = vi.fn<(value: number) => void>();
    expect(fixture.controller.submitDrawingVote(drawing, 8, submitNumber)).toBe(
      true,
    );
    expect(submitNumber).toHaveBeenCalledWith(8);
    expect(fixture.controller.getState()).toEqual({
      deadline: 4_500,
      status: "counting",
    });
    expect(fixture.controller.submitDrawingVote(drawing, 8, submitNumber)).toBe(
      false,
    );
    expect(submitNumber).toHaveBeenCalledOnce();
  });

  it("deduplicates repeated starts for the same drawing intent", () => {
    const fixture = setup(soleLocalMissing());
    fixture.controller.submitVote(createCommandIntent(), fixture.sendVote);
    fixture.publish(allCovered(2));
    const drawing = createDrawingIntent();

    fixture.controller.startDrawing(drawing);
    fixture.controller.startDrawing(drawing);
    fixture.clock.advance(500);
    fixture.controller.submitDrawingVote(drawing, 5, vi.fn());
    expect(fixture.controller.getState()).toEqual({
      deadline: 3_500,
      status: "counting",
    });
  });

  it.each([
    ["phase", soleLocalMissing({ phase: "revealed", revision: 2 })],
    ["round", soleLocalMissing({ revision: 2, roundNumber: 5 })],
    ["room", soleLocalMissing({ name: "Other room", revision: 2 })],
    ["status", disconnectedSnapshot()],
    [
      "deck",
      withDeck(soleLocalMissing({ revision: 2 }), ["1", "2", "5", "13"]),
    ],
  ])(
    "revalidates drawing %s context immediately before command handoff",
    (_label, changedSnapshot) => {
      const fixture = setup(soleLocalMissing());
      const drawing = fixture.controller.startDrawing();
      fixture.current.value = changedSnapshot;
      const submit = vi.fn();

      expect(fixture.controller.submitDrawingVote(drawing, 5, submit)).toBe(
        false,
      );
      expect(submit).not.toHaveBeenCalled();
    },
  );

  it("keeps a rejected or failed drawing cancelled", () => {
    const rejected = setup(soleLocalMissing());
    rejected.controller.submitVote(createCommandIntent(), rejected.sendVote);
    rejected.publish(allCovered(2));
    const rejectedDrawing = rejected.controller.startDrawing();
    expect(rejected.controller.rejectDrawing(rejectedDrawing)).toBe(true);
    rejected.clock.advance(AUTO_REVEAL_DELAY_MS * 2);
    expect(rejected.sendReveal).not.toHaveBeenCalled();

    const failed = setup(soleLocalMissing());
    failed.controller.submitVote(createCommandIntent(), failed.sendVote);
    failed.publish(allCovered(2));
    const failedDrawing = failed.controller.startDrawing();
    const failure = new Error("draw vote failed");
    expect(() =>
      failed.controller.submitDrawingVote(failedDrawing, 5, () => {
        throw failure;
      }),
    ).toThrow(failure);
    failed.clock.advance(AUTO_REVEAL_DELAY_MS * 2);
    expect(failed.sendReveal).not.toHaveBeenCalled();
  });

  it("restarts an interrupted drawing on the cached non-optimistic revision", () => {
    const fixture = setup(soleLocalMissing());
    fixture.controller.submitVote(createCommandIntent(), fixture.sendVote);
    const drawing = fixture.controller.startDrawing();

    fixture.controller.submitDrawingVote(drawing, 3, vi.fn());
    expect(fixture.controller.getState()).toEqual({
      deadline: AUTO_REVEAL_DELAY_MS,
      status: "counting",
    });
  });

  it("permanently cancels a drawing restart after a newer missing snapshot", () => {
    const fixture = setup(soleLocalMissing());
    fixture.controller.submitVote(createCommandIntent(), fixture.sendVote);
    fixture.publish(allCovered(2));
    const drawing = fixture.controller.startDrawing();
    fixture.publish(
      playingSnapshot(3, [
        player("Local", "hidden", true),
        player("Peer", "missing"),
      ]),
    );
    fixture.publish(allCovered(4));

    fixture.controller.submitDrawingVote(drawing, 3, vi.fn());
    expect(fixture.controller.getState().status).toBe("idle");
  });

  it("does not reinterpret an invalidated interrupted drawing as a new final vote", () => {
    const fixture = setup(soleLocalMissing());
    fixture.controller.submitVote(createCommandIntent(), fixture.sendVote);
    fixture.publish(allCovered(2));
    const drawing = fixture.controller.startDrawing();
    fixture.publish(
      playingSnapshot(3, [
        player("Local", "missing", true),
        player("Peer", "hidden"),
      ]),
    );

    fixture.controller.submitDrawingVote(drawing, 3, vi.fn());
    expect(fixture.controller.getState().status).toBe("idle");
  });

  it("a retraction intent cancels before handoff and invalidates a drawing", () => {
    const fixture = setup(soleLocalMissing());
    fixture.controller.submitVote(createCommandIntent(), fixture.sendVote);
    const drawing = fixture.controller.startDrawing();
    fixture.publish(allCovered(2));
    const retract = vi.fn(() => {
      expect(fixture.controller.getState().status).toBe("idle");
    });
    const intent = createCommandIntent();

    expect(fixture.controller.retract(intent, retract)).toBe(true);
    expect(fixture.controller.retract(intent, retract)).toBe(false);
    expect(retract).toHaveBeenCalledOnce();
    expect(fixture.controller.submitDrawingVote(drawing, 5, vi.fn())).toBe(
      false,
    );
  });

  it("cancel prevents expiry and clears an interrupted drawing restart", () => {
    const fixture = setup(soleLocalMissing());
    fixture.controller.submitVote(createCommandIntent(), fixture.sendVote);
    fixture.publish(allCovered(2));
    const drawing = fixture.controller.startDrawing();
    fixture.controller.cancel();
    fixture.controller.submitDrawingVote(drawing, 3, vi.fn());
    fixture.clock.advance(AUTO_REVEAL_DELAY_MS);
    expect(fixture.sendReveal).not.toHaveBeenCalled();
  });

  it("latches manual and timer reveal attempts in either order", () => {
    const manualFirst = setup(soleLocalMissing());
    manualFirst.controller.submitVote(
      createCommandIntent(),
      manualFirst.sendVote,
    );
    expect(manualFirst.controller.requestManualReveal()).toEqual({
      status: "sent",
    });
    expect(manualFirst.controller.requestManualReveal()).toEqual({
      status: "ignored",
    });
    manualFirst.clock.advance(AUTO_REVEAL_DELAY_MS);
    expect(manualFirst.sendReveal).toHaveBeenCalledOnce();

    const timerFirst = setup(soleLocalMissing());
    timerFirst.controller.submitVote(
      createCommandIntent(),
      timerFirst.sendVote,
    );
    timerFirst.clock.advance(AUTO_REVEAL_DELAY_MS);
    expect(timerFirst.controller.requestManualReveal()).toEqual({
      status: "ignored",
    });
    expect(timerFirst.sendReveal).toHaveBeenCalledOnce();
  });

  it("keeps the reveal latch through transient phase and connection changes", () => {
    const fixture = setup(soleLocalMissing());
    expect(fixture.controller.requestManualReveal()).toEqual({
      status: "sent",
    });
    fixture.publish(soleLocalMissing({ phase: "revealed", revision: 2 }));
    fixture.publish(disconnectedSnapshot());
    fixture.publish(soleLocalMissing({ revision: 3 }));

    expect(fixture.controller.requestManualReveal()).toEqual({
      status: "ignored",
    });
    expect(fixture.sendReveal).toHaveBeenCalledOnce();
  });

  it("reports a reveal command error and clears the latch for retry", () => {
    const failure = new Error("reveal failed");
    let attempts = 0;
    const fixture = setup(soleLocalMissing(), () => {
      attempts += 1;
      if (attempts === 1) {
        throw failure;
      }
    });
    fixture.controller.submitVote(createCommandIntent(), fixture.sendVote);
    fixture.clock.advance(AUTO_REVEAL_DELAY_MS);

    expect(fixture.onRevealError).toHaveBeenCalledWith(failure);
    expect(fixture.controller.requestManualReveal()).toEqual({
      status: "sent",
    });
    expect(fixture.sendReveal).toHaveBeenCalledTimes(2);
  });

  it("is idempotent under duplicate observations and disposal", () => {
    const fixture = setup(soleLocalMissing());
    const listener = vi.fn();
    fixture.controller.subscribe(listener);
    fixture.controller.submitVote(createCommandIntent(), fixture.sendVote);
    fixture.controller.observe(fixture.current.value);
    fixture.controller.observe(fixture.current.value);
    expect(listener).toHaveBeenCalledOnce();

    fixture.controller.dispose();
    fixture.controller.dispose();
    fixture.clock.advance(AUTO_REVEAL_DELAY_MS);
    expect(fixture.sendReveal).not.toHaveBeenCalled();
  });
});

class FakeClock implements MonotonicScheduler {
  readonly #tasks = new Map<
    number,
    { readonly callback: () => void; readonly due: number }
  >();
  #nextId = 1;
  #now = 0;

  readonly now = (): number => this.#now;

  readonly setTimeout = (callback: () => void, delayMs: number): number => {
    const id = this.#nextId++;
    this.#tasks.set(id, { callback, due: this.#now + delayMs });
    return id;
  };

  readonly clearTimeout = (handle: unknown): void => {
    if (typeof handle === "number") {
      this.#tasks.delete(handle);
    }
  };

  advance(duration: number): void {
    const target = this.#now + duration;
    while (this.#tasks.size > 0) {
      const next = [...this.#tasks.entries()]
        .filter(([, task]) => task.due <= target)
        .toSorted((left, right) => left[1].due - right[1].due)[0];
      if (next === undefined) {
        break;
      }
      const [id, task] = next;
      this.#tasks.delete(id);
      this.#now = task.due;
      task.callback();
    }
    this.#now = target;
  }

  runNextEarly(): void {
    const next = [...this.#tasks.entries()].toSorted(
      (left, right) => left[1].due - right[1].due,
    )[0];
    if (next !== undefined) {
      this.#tasks.delete(next[0]);
      next[1].callback();
    }
  }
}

function setup(initial: ClientSnapshot, reveal: () => void = vi.fn()) {
  const clock = new FakeClock();
  const current = { value: initial };
  const sendReveal = vi.fn(reveal);
  const onRevealError = vi.fn<(error: unknown) => void>();
  const sendVote = vi.fn();
  const controller = new AutoRevealController({
    getSnapshot: () => current.value,
    onRevealError,
    scheduler: clock,
    sendReveal,
  });
  const publish = (snapshot: ClientSnapshot): void => {
    current.value = snapshot;
    controller.observe(snapshot);
  };
  return {
    clock,
    controller,
    current,
    onRevealError,
    publish,
    sendReveal,
    sendVote,
  };
}

interface PlayingOptions {
  readonly name?: string;
  readonly phase?: "playing" | "revealed";
  readonly revision?: number;
  readonly roundNumber?: number;
}

function soleLocalMissing(options: PlayingOptions = {}): ClientSnapshot {
  return playingSnapshot(
    options.revision ?? 1,
    [player("Local", "missing", true), player("Peer", "hidden")],
    options,
  );
}

function allCovered(revision: number): ClientSnapshot {
  return playingSnapshot(revision, [
    player("Local", "hidden", true),
    player("Peer", "hidden"),
  ]);
}

function playingSnapshot(
  revision: number,
  players: readonly Player[],
  options: PlayingOptions = {},
): ClientSnapshot {
  return makeSnapshot({
    revision,
    room: {
      deck: ["1", "2", "3", "5", "8"],
      name: options.name ?? "Planning",
      phase: options.phase ?? "playing",
      players,
    },
    roundNumber: options.roundNumber ?? 4,
    status: "open",
  });
}

function disconnectedSnapshot(): ClientSnapshot {
  return makeSnapshot({ revision: 2, status: "disconnected" });
}

function withDeck(
  snapshot: ClientSnapshot,
  deck: readonly string[],
): ClientSnapshot {
  if (snapshot.room === null) {
    throw new Error("A room snapshot is required.");
  }
  return { ...snapshot, room: { ...snapshot.room, deck } };
}

function player(
  name: string,
  voteState: "hidden" | "missing",
  isYou = false,
  userType: Player["userType"] = "player",
): Player {
  return { isYou, name, userType, vote: { state: voteState } };
}
