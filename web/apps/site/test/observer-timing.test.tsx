import type { ClientSnapshot, HistoryEntry } from "@ppoker/web-client";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ObserverTimingTracker,
  historyObservationKey,
  useObserverTiming,
} from "../src/observer-timing";
import { makeSnapshot } from "./fake-client";

function TimingProbe({ snapshot }: { readonly snapshot: ClientSnapshot }) {
  const timing = useObserverTiming(snapshot);
  return (
    <>
      <span data-testid="elapsed">{timing.phaseElapsed}</span>
      <span data-testid="age">
        {timing.historyAges.get(historyObservationKey(1, 0)) ?? "absent"}
      </span>
    </>
  );
}

describe("observer-local timing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks phase elapsed time and ages history from first local observation", () => {
    const playing = roomSnapshot("playing", []);
    const view = render(<TimingProbe snapshot={playing} />);
    expect(view.getByTestId("elapsed").textContent).toBe("00:00");
    expect(view.getByTestId("age").textContent).toBe("absent");

    act(() => {
      vi.advanceTimersByTime(65_000);
    });
    expect(view.getByTestId("elapsed").textContent).toBe("01:05");

    view.rerender(
      <TimingProbe snapshot={roomSnapshot("playing", [history()])} />,
    );
    expect(view.getByTestId("age").textContent).toBe("just now");
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(view.getByTestId("age").textContent).toBe("1 min ago");

    view.rerender(
      <TimingProbe snapshot={roomSnapshot("revealed", [history()])} />,
    );
    expect(view.getByTestId("elapsed").textContent).toBe("00:00");
  });

  it("resets all observer timing when the hook remounts", () => {
    const snapshot = roomSnapshot("playing", [history()]);
    const first = render(<TimingProbe snapshot={snapshot} />);
    act(() => {
      vi.advanceTimersByTime(90_000);
    });
    expect(first.getByTestId("age").textContent).toBe("1 min ago");
    first.unmount();

    const reloaded = render(<TimingProbe snapshot={snapshot} />);
    expect(reloaded.getByTestId("elapsed").textContent).toBe("00:00");
    expect(reloaded.getByTestId("age").textContent).toBe("just now");
  });

  it("timestamps off-boundary observations with the injected current clock", () => {
    const view = render(<TimingProbe snapshot={roomSnapshot("playing", [])} />);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    view.rerender(
      <TimingProbe snapshot={roomSnapshot("playing", [history()])} />,
    );

    act(() => {
      vi.advanceTimersByTime(9500);
    });
    expect(view.getByTestId("age").textContent).toBe("just now");
  });

  it("tracks duplicate round numbers as distinct history occurrences", () => {
    const duplicate = history();
    const observed = new ObserverTimingTracker().observe(
      roomSnapshot("revealed", [duplicate, duplicate]),
      Date.now(),
    );

    expect([...observed.historyAges.keys()]).toEqual([
      historyObservationKey(1, 0),
      historyObservationKey(1, 1),
    ]);
  });
});

function roomSnapshot(
  phase: "playing" | "revealed",
  historyEntries: readonly HistoryEntry[],
): ClientSnapshot {
  return makeSnapshot({
    history: historyEntries,
    revision: phase === "playing" ? 1 : 2,
    room: { deck: ["1", "2"], name: "planning", phase, players: [] },
    roundNumber: 1,
    status: "open",
  });
}

function history(): HistoryEntry {
  return {
    average: 5,
    deck: ["1", "2"],
    ownVote: null,
    roundNumber: 1,
    votes: [],
  };
}
