import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { bindSessionsToRouter, createSiteRoutes } from "../src/app-router";
import {
  createBroadcastSessionManager,
  type BroadcastSessionManager,
  type BroadcastSessionSnapshot,
} from "../src/broadcast-session";
import type { PokerClientLifecycle } from "../src/client-lifecycle";
import type { BroadcastConfig, VotingConfig } from "../src/config";
import type { VoterNameSession } from "../src/voting/voter-session";
import {
  createVotingSessionManager,
  type VotingSessionManager,
  type VotingSessionSnapshot,
} from "../src/voting-session";
import { createFakeClient, makeSnapshot } from "./fake-client";

const endpoint = "wss://example.test/socket";

describe("site routing", () => {
  it.each(["/", "/?room=legacy"])(
    "keeps %s on the join-only route without connecting",
    async (entry) => {
      const sessions = fakeSessions();
      const router = createMemoryRouter(createRoutes(sessions), {
        initialEntries: [entry],
      });
      const unbind = bindRouter(router, sessions);
      render(<RouterProvider router={router} />);

      expect(
        await screen.findByRole("heading", {
          name: "Planning Poker Live Desk",
        }),
      ).toBeDefined();
      expect(screen.getByPlaceholderText("Enter room name")).toBeDefined();
      expect(document.activeElement).toBe(
        screen.getByRole("textbox", { name: "Room name" }),
      );
      expect(
        screen.queryByText("Planning poker", { selector: "p" }),
      ).toBeNull();
      expect(sessions.start).not.toHaveBeenCalled();
      expect(router.state.location.pathname).toBe("/");

      unbind();
      router.dispose();
    },
  );

  it("starts a direct room route with the decoded query room", () => {
    const sessions = fakeSessions();
    const room = "Roadmap/API? v2";
    const router = createMemoryRouter(createRoutes(sessions), {
      initialEntries: [`/room?room=${encodeURIComponent(room)}`],
    });
    const unbind = bindRouter(router, sessions);
    render(<RouterProvider router={router} />);

    expect(sessions.start).toHaveBeenCalledOnce();
    expect(sessions.start).toHaveBeenCalledWith({ endpoint, room });

    unbind();
    router.dispose();
  });

  it("uses a real GET form to navigate and start the room session", async () => {
    const sessions = fakeSessions();
    const router = createMemoryRouter(createRoutes(sessions), {
      initialEntries: ["/"],
    });
    const unbind = bindRouter(router, sessions);
    render(<RouterProvider router={router} />);
    const input = await screen.findByRole("textbox", { name: "Room name" });
    const button = screen.getByRole("button", { name: "Join room" });
    const form = input.closest("form");

    expect(form?.method).toBe("get");
    expect(button.getAttribute("type")).toBe("submit");
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    fireEvent.change(input, { target: { value: "API/estimates?" } });
    fireEvent.click(button);

    await waitFor(() => {
      expect(sessions.start).toHaveBeenCalledOnce();
    });
    expect(router.state.location.pathname).toBe("/room");
    expect(new URLSearchParams(router.state.location.search).get("room")).toBe(
      "API/estimates?",
    );

    unbind();
    router.dispose();
  });

  it("keeps the required empty form on the join route", async () => {
    const sessions = fakeSessions();
    const router = createMemoryRouter(createRoutes(sessions), {
      initialEntries: ["/"],
    });
    const unbind = bindRouter(router, sessions);
    render(<RouterProvider router={router} />);

    fireEvent.click(await screen.findByRole("button", { name: "Join room" }));

    expect(router.state.location.pathname).toBe("/");
    expect(sessions.start).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "Planning Poker Live Desk" }),
    ).toBeDefined();

    unbind();
    router.dispose();
  });

  it("closes the active session when navigation leaves the room route", async () => {
    const sessions = fakeSessions();
    const router = createMemoryRouter(createRoutes(sessions), {
      initialEntries: ["/room?room=planning"],
    });
    const unbind = bindRouter(router, sessions);
    render(<RouterProvider router={router} />);

    await router.navigate("/");

    expect(sessions.close).toHaveBeenCalledOnce();
    unbind();
    router.dispose();
  });

  it("closes a voter session started by an immediately superseded navigation", async () => {
    const broadcastSessions = fakeSessions();
    const votingSessions = fakeVotingSessions();
    const router = createMemoryRouter(
      createRoutes(broadcastSessions, votingSessions),
      { initialEntries: ["/"] },
    );
    const unbind = bindRouter(router, broadcastSessions, votingSessions);
    render(<RouterProvider router={router} />);

    const superseded = router.navigate("/vote?room=transient-vote");
    const settled = router.navigate("/");
    await Promise.all([superseded, settled]);

    expect(votingSessions.start).toHaveBeenCalledOnce();
    expect(votingSessions.start).toHaveBeenCalledWith({
      endpoint,
      room: "transient-vote",
    });
    expect(votingSessions.close).toHaveBeenCalledOnce();
    expect(router.state.location.pathname).toBe("/");

    unbind();
    router.dispose();
  });

  it("closes a broadcast session started by an immediately superseded navigation", async () => {
    const broadcastSessions = fakeSessions();
    const votingSessions = fakeVotingSessions();
    const router = createMemoryRouter(
      createRoutes(broadcastSessions, votingSessions),
      { initialEntries: ["/"] },
    );
    const unbind = bindRouter(router, broadcastSessions, votingSessions);
    render(<RouterProvider router={router} />);

    const superseded = router.navigate("/room?room=transient-room");
    const settled = router.navigate("/");
    await Promise.all([superseded, settled]);

    expect(broadcastSessions.start).toHaveBeenCalledOnce();
    expect(broadcastSessions.start).toHaveBeenCalledWith({
      endpoint,
      room: "transient-room",
    });
    expect(broadcastSessions.close).toHaveBeenCalledOnce();
    expect(router.state.location.pathname).toBe("/");

    unbind();
    router.dispose();
  });

  it.each(["/room/", "/ROOM"])(
    "preserves the session for matched room URL %s and closes after leaving",
    async (path) => {
      const sessions = fakeSessions();
      const router = createMemoryRouter(createRoutes(sessions), {
        initialEntries: [`${path}?room=planning`],
      });
      const unbind = bindRouter(router, sessions);
      render(<RouterProvider router={router} />);

      await waitFor(() => {
        expect(router.state.initialized).toBe(true);
      });
      expect(sessions.start).toHaveBeenCalledOnce();
      expect(sessions.close).not.toHaveBeenCalled();

      await router.navigate("/");

      expect(sessions.close).toHaveBeenCalledOnce();
      unbind();
      router.dispose();
    },
  );

  it.each([
    ["/room", "No room selected"],
    ["/room?room=..", "Invalid scoreboard configuration"],
  ])(
    "renders the existing error page for invalid URL %s",
    async (entry, title) => {
      const sessions = fakeSessions();
      const router = createMemoryRouter(createRoutes(sessions), {
        initialEntries: [entry],
      });
      const unbind = bindRouter(router, sessions);
      render(<RouterProvider router={router} />);

      expect(await screen.findByRole("heading", { name: title })).toBeDefined();
      expect(screen.getByRole("alert")).toBeDefined();
      expect(sessions.start).not.toHaveBeenCalled();

      unbind();
      router.dispose();
    },
  );

  it("renders initialization failure without an initializing status", async () => {
    const initializationError = new Error("WASM initialization failed");
    const lifecycle: PokerClientLifecycle = {
      close: vi.fn<() => void>(),
      start: vi.fn<() => Promise<never>>(() =>
        Promise.reject(initializationError),
      ),
    };
    const sessions = createBroadcastSessionManager({
      bindLifecycle: () => vi.fn<() => void>(),
      createLifecycle: () => lifecycle,
      pageTarget: new EventTarget(),
      reload: vi.fn<() => void>(),
    });
    const router = createMemoryRouter(createRoutes(sessions), {
      initialEntries: ["/room?room=planning"],
    });
    const unbind = bindRouter(router, sessions);
    render(<RouterProvider router={router} />);

    expect(screen.queryByText(/initializing/iu)).toBeNull();
    await waitFor(() => {
      expect(router.state.initialized).toBe(true);
    });
    expect(router.state.errors).toBeNull();
    expect(router.state.matches).toHaveLength(2);
    expect(
      await screen.findByRole("heading", {
        name: "Scoreboard initialization failed",
      }),
    ).toBeDefined();
    expect(screen.getByText("WASM initialization failed")).toBeDefined();

    unbind();
    sessions.dispose();
    router.dispose();
  });

  it("starts a direct voter route and renders its starting status", async () => {
    const broadcastSessions = fakeSessions();
    const votingSessions = fakeVotingSessions();
    const room = "Roadmap/API? v2";
    const router = createMemoryRouter(
      createRoutes(broadcastSessions, votingSessions),
      { initialEntries: [`/vote?room=${encodeURIComponent(room)}`] },
    );
    const unbind = bindRouter(router, broadcastSessions, votingSessions);
    render(<RouterProvider router={router} />);

    expect(votingSessions.start).toHaveBeenCalledOnce();
    expect(votingSessions.start).toHaveBeenCalledWith({ endpoint, room });
    expect(
      await screen.findByRole("heading", { name: "Starting voter console" }),
    ).toBeDefined();
    expect(screen.getByText(`Room / ${room}`)).toBeDefined();

    unbind();
    router.dispose();
  });

  it.each(["/vote/", "/VOTE"])(
    "matches voter URL %s using router conventions",
    async (path) => {
      const broadcastSessions = fakeSessions();
      const votingSessions = fakeVotingSessions();
      const router = createMemoryRouter(
        createRoutes(broadcastSessions, votingSessions),
        { initialEntries: [`${path}?room=planning`] },
      );
      const unbind = bindRouter(router, broadcastSessions, votingSessions);
      render(<RouterProvider router={router} />);

      expect(votingSessions.start).toHaveBeenCalledOnce();
      expect(
        await screen.findByRole("heading", { name: "Starting voter console" }),
      ).toBeDefined();
      expect(votingSessions.close).not.toHaveBeenCalled();

      await router.navigate("/");

      expect(votingSessions.close).toHaveBeenCalledOnce();
      unbind();
      router.dispose();
    },
  );

  it.each([
    ["/vote", "No room selected", /voter URL/u],
    ["/vote?room=..", "Invalid voter configuration", /must not be/u],
  ])(
    "renders a participant-specific error for invalid voter URL %s",
    async (entry, title, detail) => {
      const broadcastSessions = fakeSessions();
      const votingSessions = fakeVotingSessions();
      const router = createMemoryRouter(
        createRoutes(broadcastSessions, votingSessions),
        { initialEntries: [entry] },
      );
      const unbind = bindRouter(router, broadcastSessions, votingSessions);
      render(<RouterProvider router={router} />);

      expect(await screen.findByRole("heading", { name: title })).toBeDefined();
      expect(screen.getByRole("alert").textContent).toMatch(detail);
      expect(votingSessions.start).not.toHaveBeenCalled();
      expect(votingSessions.close).toHaveBeenCalledOnce();

      unbind();
      router.dispose();
    },
  );

  it("renders VotingApp when the voter session is ready", async () => {
    const broadcastSessions = fakeSessions();
    const fake = createFakeClient(
      makeSnapshot({ localName: "Calm Otter", status: "connecting" }),
    );
    const nameSession = fakeNameSession("Calm Otter");
    const votingSessions = fakeVotingSessions({
      client: fake.client,
      connectError: null,
      initialName: "Calm Otter",
      nameSession,
      room: "planning",
      status: "ready",
    });
    const router = createMemoryRouter(
      createRoutes(broadcastSessions, votingSessions),
      { initialEntries: ["/vote?room=planning"] },
    );
    const unbind = bindRouter(router, broadcastSessions, votingSessions);
    render(<RouterProvider router={router} />);

    expect(
      await screen.findByRole("heading", { name: "Connecting to room" }),
    ).toBeDefined();

    unbind();
    router.dispose();
  });

  it("preserves the voter manager across settled search-param navigation", async () => {
    const broadcastSessions = fakeSessions();
    const votingSessions = fakeVotingSessions();
    const router = createMemoryRouter(
      createRoutes(broadcastSessions, votingSessions),
      { initialEntries: ["/vote?room=first"] },
    );
    const unbind = bindRouter(router, broadcastSessions, votingSessions);
    render(<RouterProvider router={router} />);

    await router.navigate("/vote?room=second");

    expect(votingSessions.start).toHaveBeenCalledTimes(2);
    expect(votingSessions.start).toHaveBeenLastCalledWith({
      endpoint,
      room: "second",
    });
    expect(votingSessions.close).not.toHaveBeenCalled();

    unbind();
    router.dispose();
  });

  it("reconciles unmatched sessions on every settled route", async () => {
    const broadcastSessions = fakeSessions();
    const votingSessions = fakeVotingSessions();
    const router = createMemoryRouter(
      createRoutes(broadcastSessions, votingSessions),
      { initialEntries: ["/"] },
    );
    const unbind = bindRouter(router, broadcastSessions, votingSessions);
    render(<RouterProvider router={router} />);

    await router.navigate("/room?room=billboard");
    expect(broadcastSessions.start).toHaveBeenLastCalledWith({
      endpoint,
      room: "billboard",
    });
    expect(votingSessions.close).toHaveBeenCalledOnce();

    await router.navigate("/vote?room=participant");
    expect(votingSessions.start).toHaveBeenLastCalledWith({
      endpoint,
      room: "participant",
    });
    expect(broadcastSessions.close).toHaveBeenCalledOnce();
    expect(votingSessions.close).toHaveBeenCalledOnce();

    await router.navigate("/room?room=second-billboard");
    expect(broadcastSessions.start).toHaveBeenLastCalledWith({
      endpoint,
      room: "second-billboard",
    });
    expect(votingSessions.close).toHaveBeenCalledTimes(2);

    await router.navigate("/");
    expect(broadcastSessions.close).toHaveBeenCalledTimes(2);
    expect(votingSessions.close).toHaveBeenCalledTimes(3);

    unbind();
    router.dispose();
  });

  it("renders voter initialization failure through the session snapshot", async () => {
    const initializationError = new Error("Participant WASM failed");
    const lifecycle: PokerClientLifecycle = {
      close: vi.fn<() => void>(),
      start: vi.fn<() => Promise<never>>(() =>
        Promise.reject(initializationError),
      ),
    };
    const votingSessions = createVotingSessionManager({
      bindLifecycle: () => vi.fn<() => void>(),
      createLifecycle: () => lifecycle,
      createNameSession: () => fakeNameSession("Calm Otter"),
      pageTarget: new EventTarget(),
      reload: vi.fn<() => void>(),
    });
    const broadcastSessions = fakeSessions();
    const router = createMemoryRouter(
      createRoutes(broadcastSessions, votingSessions),
      { initialEntries: ["/vote?room=planning"] },
    );
    const unbind = bindRouter(router, broadcastSessions, votingSessions);
    render(<RouterProvider router={router} />);

    expect(
      await screen.findByRole("heading", {
        name: "Voter initialization failed",
      }),
    ).toBeDefined();
    expect(screen.getByRole("alert").textContent).toContain(
      "Participant WASM failed",
    );
    expect(router.state.errors).toBeNull();

    unbind();
    votingSessions.dispose();
    router.dispose();
  });
});

function createRoutes(
  broadcastSessions: BroadcastSessionManager,
  votingSessions: VotingSessionManager = fakeVotingSessions(),
) {
  return createSiteRoutes({ broadcastSessions, endpoint, votingSessions });
}

function bindRouter(
  router: Parameters<typeof bindSessionsToRouter>[0],
  broadcastSessions: BroadcastSessionManager,
  votingSessions: VotingSessionManager = fakeVotingSessions(),
): () => void {
  return bindSessionsToRouter(router, {
    broadcast: broadcastSessions,
    voting: votingSessions,
  });
}

function fakeSessions(): BroadcastSessionManager & {
  readonly close: ReturnType<typeof vi.fn<() => void>>;
  readonly start: ReturnType<typeof vi.fn<(config: BroadcastConfig) => void>>;
} {
  const listeners = new Set<() => void>();
  const snapshot: BroadcastSessionSnapshot = { status: "idle" };
  return {
    close: vi.fn<() => void>(),
    dispose: vi.fn<() => void>(),
    getSnapshot: () => snapshot,
    start: vi.fn<(config: BroadcastConfig) => void>(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function fakeVotingSessions(
  snapshot: VotingSessionSnapshot = { status: "idle" },
): VotingSessionManager & {
  readonly close: ReturnType<typeof vi.fn<() => void>>;
  readonly start: ReturnType<typeof vi.fn<(config: VotingConfig) => void>>;
} {
  const listeners = new Set<() => void>();
  return {
    close: vi.fn<() => void>(),
    dispose: vi.fn<() => void>(),
    getSnapshot: () => snapshot,
    start: vi.fn<(config: VotingConfig) => void>(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function fakeNameSession(name: string): VoterNameSession {
  return {
    load: vi.fn(() => name),
    rename: vi.fn(() => ({ name, ok: true, persisted: true }) as const),
  };
}
