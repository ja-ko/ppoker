import type { ClientSnapshot, Player } from "@ppoker/web-client";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { PointerEventHandler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VotingApp } from "../src/voting/VotingApp";
import { numericDeck } from "../src/voting/VotingRoom";
import { VotingStatus } from "../src/voting/VotingStatus";
import type {
  InkPadHandle,
  InkPadProps,
  InkVisualBounds,
  RasterizedInk,
  Recognition,
  RecognitionRuntime,
  RecognizerStatus,
} from "../src/voting/handwriting";
import { PREPROCESSING_CONFIG } from "../src/voting/handwriting";
import { createVoterNameSession } from "../src/voting/voter-session";
import { createFakeClient, makeSnapshot } from "./fake-client";

let testRaster: RasterizedInk | null = null;
let testVisualBounds: InkVisualBounds | null = null;
const getCanonicalInkLocus = vi.fn<InkPadHandle["getCanonicalInkLocus"]>(
  () => null,
);

vi.mock("../src/voting/handwriting/InkPad", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    InkPad: forwardRef<InkPadHandle, InkPadProps>(function FakeInkPad(
      { enabled = true, onPointerAccepted, onStrokeComplete },
      ref,
    ) {
      useImperativeHandle(ref, () => ({
        clear: vi.fn(),
        focus: vi.fn(),
        getCanonicalInkLocus,
        getLatestPointTime: () => Date.now(),
        getStats: () => ({ pointCount: 4, strokeCount: 1 }),
        getStrokes: () => [],
        getVisualBounds: () => testVisualBounds,
        isPointerActive: () => false,
        rasterize: () => testRaster,
        restoreVectorInk: vi.fn(),
      }));
      const pointerDown: PointerEventHandler<HTMLButtonElement> = () => {
        onPointerAccepted?.();
      };
      const pointerUp: PointerEventHandler<HTMLButtonElement> = () => {
        onStrokeComplete?.({ pointCount: 4, strokeCount: 1 });
      };
      return (
        <button
          aria-label="Test drawing surface"
          disabled={!enabled}
          onPointerDown={pointerDown}
          onPointerUp={pointerUp}
          type="button"
        />
      );
    }),
  };
});

const readyStatus: RecognizerStatus = {
  metadataReady: true,
  modelReady: true,
  progress: 1,
  readiness: "ready",
  status: "Recognizer ready",
};

describe("VotingApp status shells", () => {
  it("renders participant-specific connection status", () => {
    renderApp(makeSnapshot({ status: "connecting" }));
    expect(screen.getByRole("status").textContent).toContain(
      "Connecting to room",
    );
    expect(screen.getByText(/accept this participant/i)).toBeTruthy();
  });

  it("keeps an unknown room action visible and disabled", () => {
    renderApp(roomSnapshot({ phase: "unknown", status: "open" }));
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Unavailable" })
        .disabled,
    ).toBe(true);
  });

  it("uses assertive atomic announcements for alert status", () => {
    render(
      <VotingStatus detail="Terminal failure" role="alert" title="Offline" />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(alert.getAttribute("aria-atomic")).toBe("true");
  });
});

describe("VotingApp voting controls", () => {
  it("votes an exact authoritative card, displays it optimistically, and retracts", () => {
    const { client } = renderApp(roomSnapshot());

    fireEvent.click(screen.getByRole("button", { name: "Vote ?" }));
    expect(client.vote).toHaveBeenCalledWith("?");
    expect(screen.getByLabelText("Current vote ?")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Vote ?" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Clear vote" }));
    expect(client.retractVote).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText("Current vote ?")).toBeNull();
  });

  it("does not cover a card vote with the recognizer loading message", () => {
    const status: RecognizerStatus = {
      metadataReady: true,
      modelReady: false,
      progress: 0.4,
      readiness: "loading",
      status: "Loading recognition model",
    };
    const runtime = createRuntime(() => new Promise(() => undefined), status);
    renderAppWithRuntime(roomSnapshot(), () => runtime);

    expect(
      screen.getByText("Recognizer loading. Deck buttons are ready."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Vote 5" }));

    expect(screen.getByLabelText("Current vote 5")).toBeTruthy();
    expect(
      screen.queryByText("Recognizer loading. Deck buttons are ready."),
    ).toBeNull();
    expect(screen.getByText("Recognizer 40%")).toBeTruthy();
  });

  it("keeps an authoritative vote hidden while its retraction is pending", () => {
    const { client } = renderApp(
      roomSnapshot({ localVote: { kind: "number", value: 5 } }),
    );
    expect(screen.getByLabelText("Current vote 5")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear vote" }));
    expect(client.retractVote).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText("Current vote 5")).toBeNull();
  });

  it("treats a pending retract as a missing local response", () => {
    const { client } = renderApp(
      roomSnapshot({
        localVote: { kind: "number", value: 5 },
        players: [player("Local", "hidden", true), player("Peer", "hidden")],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear vote" }));

    expect(client.retractVote).toHaveBeenCalledOnce();
    expect(screen.getByText("1/2")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "1",
    );
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    expect(
      screen.getByRole("dialog", { name: "Reveal with missing votes?" }),
    ).toBeTruthy();
    expect(client.reveal).not.toHaveBeenCalled();
  });

  it("retains a pending retract through an older vote acknowledgement", () => {
    const initial = roomSnapshot({
      players: [player("Local", "missing", true), player("Peer", "hidden")],
    });
    const { publish } = renderApp(initial);
    fireEvent.click(screen.getByRole("button", { name: "Vote 5" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear vote" }));
    expect(screen.queryByLabelText("Current vote 5")).toBeNull();
    act(() => {
      publish(
        roomSnapshot({
          localVote: { kind: "number", value: 5 },
          players: [player("Local", "hidden", true), player("Peer", "hidden")],
          revision: 2,
        }),
      );
    });

    expect(screen.queryByLabelText("Current vote 5")).toBeNull();
    expect(screen.getByText("1/2")).toBeTruthy();
  });

  it("retains the latest pending vote through unrelated and older acknowledgements", () => {
    const { client, publish } = renderApp(
      roomSnapshot({
        players: [player("Local", "missing", true), player("Peer", "hidden")],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Vote 5" }));
    act(() => {
      publish(
        roomSnapshot({
          players: [player("Local", "missing", true), player("Peer", "hidden")],
          revision: 2,
        }),
      );
    });
    expect(screen.getByLabelText("Current vote 5")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Vote 8" }));
    act(() => {
      publish(
        roomSnapshot({
          localVote: { kind: "number", value: 5 },
          players: [player("Local", "hidden", true), player("Peer", "hidden")],
          revision: 3,
        }),
      );
    });
    expect(client.vote.mock.calls.map(([card]) => card)).toEqual(["5", "8"]);
    expect(screen.getByLabelText("Current vote 8")).toBeTruthy();

    act(() => {
      publish(
        roomSnapshot({
          localVote: { kind: "number", value: 8 },
          players: [player("Local", "hidden", true), player("Peer", "hidden")],
          revision: 4,
        }),
      );
    });
    expect(screen.getByLabelText("Current vote 8")).toBeTruthy();
  });

  it("does not resend or restart countdown for the latest effective card", async () => {
    const { client } = renderApp(
      roomSnapshot({
        players: [player("Local", "missing", true), player("Peer", "hidden")],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Vote 5" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    fireEvent.click(screen.getByRole("button", { name: "Vote 5" }));
    expect(client.vote).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_900);
    });
    expect(client.reveal).toHaveBeenCalledOnce();
  });

  it("reports a card command error without displaying a false vote", () => {
    const { client } = renderApp(roomSnapshot());
    vi.mocked(client.vote).mockImplementationOnce(() => {
      throw new Error("vote rejected");
    });
    fireEvent.click(screen.getByRole("button", { name: "Vote 5" }));
    expect(screen.getByRole("alert").textContent).toContain("vote rejected");
    expect(screen.queryByLabelText("Current vote 5")).toBeNull();
  });

  it("only allows canonical 0 through 255 deck labels for recognition", () => {
    expect(numericDeck(["0", "1", "13", "255", "01", "256", "?"])).toEqual([
      0, 1, 13, 255,
    ]);
    renderApp(
      roomSnapshot({ deck: ["0", "1", "13", "255", "01", "256", "?"] }),
    );
    expect(screen.getAllByRole("button", { name: /^Vote /u })).toHaveLength(7);
  });

  it("keeps exact long authoritative labels readable in the card", () => {
    const long = "Needs-another-conversation";
    renderApp(roomSnapshot({ deck: ["Coffee", long] }));
    expect(
      screen.getByRole("button", { name: "Vote Coffee" }).className,
    ).toContain("vote-card--wide");
    const longCard = screen.getByRole("button", { name: `Vote ${long}` });
    expect(longCard.className).toContain("vote-card--textual");
    expect(longCard.textContent).toBe(long);

    fireEvent.click(longCard);
    const result = screen.getByLabelText(`Current vote ${long}`);
    expect(result.className).toContain("vote-result--textual");
    expect(result.textContent).toBe(long);
  });

  it("shows strict player slots with an optimistic local overlay", () => {
    renderApp(
      roomSnapshot({
        players: [
          player("Local", "missing", true),
          player("Peer", "hidden"),
          player("Observer", "missing", false, "spectator"),
        ],
      }),
    );
    expect(screen.getByText("1/2")).toBeTruthy();
    expect(screen.queryByText("Observer")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Vote 5" }));
    expect(screen.getByText("2/2")).toBeTruthy();
    expect(screen.getAllByText("Voted")).toHaveLength(2);
  });

  it("retracts an effective vote after invalid handwriting", async () => {
    const { client } = renderApp(
      roomSnapshot({ localVote: { kind: "number", value: 5 } }),
    );
    const surface = screen.getByRole("button", {
      name: "Test drawing surface",
    });
    fireEvent.pointerDown(surface);
    expect(screen.queryByLabelText("Current vote 5")).toBeNull();
    fireEvent.pointerUp(surface);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    expect(client.retractVote).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText("Current vote 5")).toBeNull();
  });

  it("keeps rejection guidance available after the visual effect", async () => {
    renderApp(roomSnapshot());
    const surface = screen.getByRole("button", {
      name: "Test drawing surface",
    });
    fireEvent.pointerDown(surface);
    fireEvent.pointerUp(surface);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600);
    });
    expect(
      screen.getByText(/recognizer was not confident enough/i),
    ).toBeTruthy();

    fireEvent.pointerDown(surface);
    expect(
      screen.queryByText(/recognizer was not confident enough/i),
    ).toBeNull();
  });
});

describe("VotingApp phase actions", () => {
  it("confirms reveal when a strict player is missing", () => {
    const { client } = renderApp(
      roomSnapshot({
        players: [player("Local", "hidden", true), player("Peer", "missing")],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    const dialog = screen.getByRole<HTMLDialogElement>("dialog", {
      name: "Reveal with missing votes?",
    });
    expect(dialog.tagName).toBe("DIALOG");
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );
    if (typeof dialog.showModal !== "function") {
      expect(document.querySelector<HTMLElement>(".vote-header")?.inert).toBe(
        true,
      );
    }
    expect(client.reveal).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Reveal anyway" }),
    );
    expect(client.reveal).toHaveBeenCalledOnce();
  });

  it("reveals immediately when every strict player is covered", () => {
    const { client } = renderApp(
      roomSnapshot({
        players: [player("Local", "hidden", true), player("Peer", "hidden")],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    expect(client.reveal).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("recomputes missing responses from the live snapshot before reveal", () => {
    const { client } = renderApp(
      roomSnapshot({
        players: [player("Local", "hidden", true), player("Peer", "hidden")],
      }),
    );
    vi.mocked(client.getSnapshot).mockReturnValueOnce(
      roomSnapshot({
        players: [player("Local", "hidden", true), player("Peer", "missing")],
        revision: 2,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    expect(
      screen.getByRole("dialog", { name: "Reveal with missing votes?" }),
    ).toBeTruthy();
    expect(client.reveal).not.toHaveBeenCalled();
  });

  it("always confirms reset", () => {
    const { client } = renderApp(roomSnapshot({ phase: "revealed" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(client.startNewRound).not.toHaveBeenCalled();
    const confirm = screen.getByRole("button", { name: "Start new round" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(client.startNewRound).toHaveBeenCalledOnce();
  });

  it("clears the phase latch when the authoritative phase changes", () => {
    const initial = roomSnapshot({
      players: [player("Local", "hidden", true), player("Peer", "hidden")],
    });
    const { publish } = renderApp(initial);
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Reveal..." })
        .disabled,
    ).toBe(true);

    act(() => {
      publish(
        roomSnapshot({
          phase: "revealed",
          players: initial.room?.players ?? [],
          revision: 2,
        }),
      );
    });
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Reset" }).disabled,
    ).toBe(false);
  });

  it("clears a reveal command latch after an error", () => {
    const { client } = renderApp(
      roomSnapshot({
        players: [player("Local", "hidden", true), player("Peer", "hidden")],
      }),
    );
    vi.mocked(client.reveal).mockImplementationOnce(() => {
      throw new Error("reveal rejected");
    });
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    expect(screen.getByRole("alert").textContent).toContain("reveal rejected");
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Reveal" })
        .disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    expect(client.reveal).toHaveBeenCalledTimes(2);
  });

  it("shows and cancels the automatic countdown, including on drawing start", async () => {
    renderApp(
      roomSnapshot({
        players: [player("Local", "missing", true), player("Peer", "hidden")],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Vote 5" }));
    expect(screen.getByRole("button", { name: "Reveal in 3" })).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByRole("button", { name: "Reveal in 2" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Vote 8" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Test drawing surface" }),
    );
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reveal" })).toBeTruthy();
  });
});

describe("VotingApp handwriting command boundaries", () => {
  it("does not vote when recognition resolves after manual reveal", async () => {
    testRaster = raster();
    const pending = deferred<Recognition>();
    const runtime = createRuntime(() => pending.promise);
    const { client } = renderAppWithRuntime(
      roomSnapshot({
        players: [player("Local", "hidden", true), player("Peer", "hidden")],
      }),
      () => runtime,
    );
    drawStroke();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(675);
    });
    expect(runtime.recognize).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    await act(async () => {
      pending.resolve(recognition("5", 1));
      await Promise.resolve();
    });
    expect(client.reveal).toHaveBeenCalledOnce();
    expect(client.vote).not.toHaveBeenCalled();
  });

  it("does not vote when recognition resolves after reset", async () => {
    testRaster = raster();
    const pending = deferred<Recognition>();
    const runtime = createRuntime(() => pending.promise);
    const initial = roomSnapshot({
      players: [player("Local", "hidden", true), player("Peer", "hidden")],
    });
    const { client, publish } = renderAppWithRuntime(initial, () => runtime);
    drawStroke();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(675);
    });
    act(() => {
      publish(
        roomSnapshot({
          phase: "revealed",
          players: initial.room?.players ?? [],
          revision: 2,
        }),
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByRole("button", { name: "Start new round" }));
    await act(async () => {
      pending.resolve(recognition("5", 1));
      await Promise.resolve();
    });

    expect(client.startNewRound).toHaveBeenCalledOnce();
    expect(client.vote).not.toHaveBeenCalled();
  });

  it("reuses one drawing intent across strokes and preserves restart metadata", async () => {
    testRaster = raster();
    testVisualBounds = {
      centerX: 80,
      centerY: 160,
      height: 80,
      maxX: 120,
      maxY: 200,
      minX: 40,
      minY: 120,
      surfaceHeight: 640,
      surfaceWidth: 320,
      width: 80,
    };
    getCanonicalInkLocus.mockReturnValue({
      center: { x: 80, y: 160 },
      coordinateSpace: { height: 640, width: 320 },
    });
    const runtime = createRuntime((_input, revision) =>
      Promise.resolve(recognition("8", revision)),
    );
    const initial = roomSnapshot({
      players: [player("Local", "missing", true), player("Peer", "hidden")],
    });
    const { client, publish } = renderAppWithRuntime(initial, () => runtime);
    fireEvent.click(screen.getByRole("button", { name: "Vote 5" }));
    act(() => {
      publish(
        roomSnapshot({
          localVote: { kind: "number", value: 5 },
          players: [player("Local", "hidden", true), player("Peer", "hidden")],
          revision: 2,
        }),
      );
    });

    drawStroke();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    drawStroke();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(675);
    });

    expect(runtime.invalidate).toHaveBeenCalledTimes(3);
    expect(runtime.recognize).toHaveBeenCalledOnce();
    expect(client.vote.mock.calls.map(([card]) => card)).toEqual(["5", "8"]);
    expect(screen.getByRole("button", { name: "Reveal in 3" })).toBeTruthy();
    const stage = screen.getByTestId("drawing-stage");
    expect(stage.style.getPropertyValue("--vote-ink-origin-x")).toBe("25%");
    expect(stage.style.getPropertyValue("--vote-ink-translate-x")).toBe("25%");
    expect(getCanonicalInkLocus).toHaveBeenCalled();
  });

  it("hands off an already-effective handwritten vote without duplicate command", async () => {
    testRaster = raster();
    const runtime = createRuntime((_input, revision) =>
      Promise.resolve(recognition("5", revision)),
    );
    const initial = roomSnapshot({
      players: [player("Local", "missing", true), player("Peer", "hidden")],
    });
    const { client, publish } = renderAppWithRuntime(initial, () => runtime);
    fireEvent.click(screen.getByRole("button", { name: "Vote 5" }));
    act(() => {
      publish(
        roomSnapshot({
          localVote: { kind: "number", value: 5 },
          players: [player("Local", "hidden", true), player("Peer", "hidden")],
          revision: 2,
        }),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByRole("button", { name: "Reveal in 2" })).toBeTruthy();

    drawStroke();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(675);
    });
    expect(client.vote).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Reveal in 3" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Vote 5" }).className,
    ).not.toContain("vote-card--pending");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_999);
    });
    expect(client.reveal).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(client.reveal).toHaveBeenCalledOnce();
  });

  it("shows recognizer failure detail and retries the recognizer", () => {
    const status: RecognizerStatus = {
      error: {
        code: "worker_failed",
        message: "Model worker could not start.",
        recoverable: true,
        stage: "worker",
      },
      metadataReady: false,
      modelReady: false,
      progress: 0,
      readiness: "failed",
      status: "Worker failed",
    };
    const runtime = createRuntime(() => new Promise(() => undefined), status);
    renderAppWithRuntime(roomSnapshot(), () => runtime);

    expect(screen.getByText("Model worker could not start.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry recognizer" }));
    expect(runtime.retry).toHaveBeenCalledOnce();
  });
});

describe("VotingApp voter name", () => {
  it("renames through the shared session and persists only after command success", () => {
    const storage = new Map<string, string>();
    const nameSession = createVoterNameSession({
      generateName: () => "Calm Otter",
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
    });
    const { client } = renderApp(roomSnapshot(), nameSession);
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Display name",
    });
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("Calm Otter".length);
    fireEvent.change(input, { target: { value: "Bright Fox" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    expect(client.rename).toHaveBeenCalledWith("Bright Fox");
    expect(storage.get("ppoker.voter-name")).toBe("Bright Fox");
    expect(screen.getByText("Bright Fox")).toBeTruthy();
  });

  it("keeps rename command errors inside an actionable modal", () => {
    const { client } = renderApp(roomSnapshot());
    vi.mocked(client.rename).mockImplementationOnce(() => {
      throw new Error("rename rejected");
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Display name",
    });
    fireEvent.change(input, { target: { value: "Bright Fox" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    const dialog = screen.getByRole("dialog", { name: "Rename voter" });
    expect(within(dialog).getByRole("alert").textContent).toContain(
      "rename rejected",
    );
    expect(document.activeElement).toBe(input);
    expect(
      within(dialog).getByRole("button", { name: "Save name" }),
    ).toBeTruthy();
  });

  it("yields an optimistic rename to a newer authoritative name", () => {
    const { publish } = renderApp(roomSnapshot());
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Display name" }), {
      target: { value: "Bright Fox" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(screen.getByText("Bright Fox")).toBeTruthy();

    act(() => {
      publish(roomSnapshot({ revision: 2, localName: "Server Name" }));
    });
    expect(screen.queryByText("Bright Fox")).toBeNull();
    expect(screen.getByText("Server Name")).toBeTruthy();
  });
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  testRaster = null;
  testVisualBounds = null;
  getCanonicalInkLocus.mockReset();
  getCanonicalInkLocus.mockReturnValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

function renderApp(
  snapshot: ClientSnapshot,
  nameSession = createVoterNameSession({
    generateName: () => "Calm Otter",
    storage: null,
  }),
  createRecognitionRuntime: () => RecognitionRuntime = createReadyRuntime,
) {
  const fake = createFakeClient(snapshot);
  render(
    <VotingApp
      autoRevealScheduler={{
        clearTimeout: (handle) => {
          clearTimeout(handle as ReturnType<typeof setTimeout>);
        },
        now: () => Date.now(),
        setTimeout: (callback, delay) => setTimeout(callback, delay),
      }}
      client={fake.client}
      connectError={null}
      createRecognitionRuntime={createRecognitionRuntime}
      initialName="Calm Otter"
      nameSession={nameSession}
      room="planning"
    />,
  );
  return fake;
}

function renderAppWithRuntime(
  snapshot: ClientSnapshot,
  createRecognitionRuntime: () => RecognitionRuntime,
) {
  return renderApp(
    snapshot,
    createVoterNameSession({
      generateName: () => "Calm Otter",
      storage: null,
    }),
    createRecognitionRuntime,
  );
}

interface RoomSnapshotOptions {
  readonly deck?: readonly string[];
  readonly localVote?: ClientSnapshot["localVote"];
  readonly localName?: string;
  readonly phase?: "playing" | "revealed" | "unknown";
  readonly players?: readonly Player[];
  readonly revision?: number;
  readonly roundNumber?: number;
  readonly status?: ClientSnapshot["status"];
}

function roomSnapshot(options: RoomSnapshotOptions = {}): ClientSnapshot {
  return makeSnapshot({
    localName: options.localName ?? "Calm Otter",
    localVote: options.localVote ?? null,
    revision: options.revision ?? 1,
    room: {
      deck: options.deck ?? ["1", "3", "5", "8", "13", "?"],
      name: "Planning",
      phase: options.phase ?? "playing",
      players: options.players ?? [
        player("Local", "missing", true),
        player("Peer", "missing"),
      ],
    },
    roundNumber: options.roundNumber ?? 4,
    status: options.status ?? "open",
  });
}

function player(
  name: string,
  voteState: "hidden" | "missing" | "revealed",
  isYou = false,
  userType: Player["userType"] = "player",
): Player {
  return {
    isYou,
    name,
    userType,
    vote:
      voteState === "revealed"
        ? { state: "revealed", value: { kind: "number", value: 5 } }
        : { state: voteState },
  };
}

function createReadyRuntime(): RecognitionRuntime {
  return createRuntime(() => new Promise(() => undefined));
}

function createRuntime(
  recognize: RecognitionRuntime["recognize"],
  status: RecognizerStatus = readyStatus,
) {
  let revision = 0;
  const runtime = {
    dispose: vi.fn(),
    get revision() {
      return revision;
    },
    retry: vi.fn<RecognitionRuntime["retry"]>(),
    get status() {
      return status;
    },
    invalidate: vi.fn<RecognitionRuntime["invalidate"]>(
      (next = revision + 1) => {
        revision = next;
        return revision;
      },
    ),
    recognize: vi.fn<RecognitionRuntime["recognize"]>(recognize),
    subscribe: (listener) => {
      listener(status);
      return () => undefined;
    },
  } satisfies RecognitionRuntime;
  return runtime;
}

function drawStroke(): void {
  const surface = screen.getByRole("button", {
    name: "Test drawing surface",
  });
  fireEvent.pointerDown(surface);
  fireEvent.pointerUp(surface);
}

function raster(): RasterizedInk {
  return {
    data: new Float32Array(128 * 32),
    geometry: {
      offsetX: 0,
      offsetY: 0,
      paddedBounds: {
        height: 34,
        maxX: 22,
        maxY: 32,
        minX: -2,
        minY: -2,
        width: 24,
      },
      scale: 1,
      sourceBounds: {
        height: 30,
        maxX: 20,
        maxY: 30,
        minX: 0,
        minY: 0,
        width: 20,
      },
    },
    height: 32,
    preprocessingVersion: PREPROCESSING_CONFIG.version,
    shape: [1, 1, 32, 128],
    width: 128,
  };
}

function recognition(text: string, revision: number): Recognition {
  return {
    alternatives: [{ score: -1, text }],
    confidence: 0.99,
    diagnostics: {
      confidenceThreshold: 0.9,
      greedyText: text,
      margin: 3,
      outputShape: [1, 63, 11],
      rawThreshold: 2,
      secondScore: -4,
      thresholdPassed: true,
      timing: {
        decodeMs: 1,
        inferenceMs: 2,
        rasterizationMs: 0,
        workerMs: 3,
        workerRoundTripMs: 4,
      },
      topScore: -1,
    },
    inferenceMs: 2,
    requestId: 1,
    revision,
    text,
  };
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve: (value) => {
      resolve?.(value);
    },
  };
}
