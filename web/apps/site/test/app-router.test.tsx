import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { bindSessionToRouter, createSiteRoutes } from "../src/app-router";
import {
  createBroadcastSessionManager,
  type BroadcastSessionManager,
  type BroadcastSessionSnapshot,
} from "../src/broadcast-session";
import type { PokerClientLifecycle } from "../src/client-lifecycle";
import type { BroadcastConfig } from "../src/config";

const endpoint = "wss://example.test/socket";

describe("site routing", () => {
  it.each(["/", "/?room=legacy"])(
    "keeps %s on the join-only route without connecting",
    async (entry) => {
      const sessions = fakeSessions();
      const router = createMemoryRouter(
        createSiteRoutes({ endpoint, sessions }),
        { initialEntries: [entry] },
      );
      const unbind = bindSessionToRouter(router, sessions);
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
    const router = createMemoryRouter(
      createSiteRoutes({ endpoint, sessions }),
      { initialEntries: [`/room?room=${encodeURIComponent(room)}`] },
    );
    const unbind = bindSessionToRouter(router, sessions);
    render(<RouterProvider router={router} />);

    expect(sessions.start).toHaveBeenCalledOnce();
    expect(sessions.start).toHaveBeenCalledWith({ endpoint, room });

    unbind();
    router.dispose();
  });

  it("uses a real GET form to navigate and start the room session", async () => {
    const sessions = fakeSessions();
    const router = createMemoryRouter(
      createSiteRoutes({ endpoint, sessions }),
      { initialEntries: ["/"] },
    );
    const unbind = bindSessionToRouter(router, sessions);
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
    const router = createMemoryRouter(
      createSiteRoutes({ endpoint, sessions }),
      { initialEntries: ["/"] },
    );
    const unbind = bindSessionToRouter(router, sessions);
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
    const router = createMemoryRouter(
      createSiteRoutes({ endpoint, sessions }),
      { initialEntries: ["/room?room=planning"] },
    );
    const unbind = bindSessionToRouter(router, sessions);
    render(<RouterProvider router={router} />);

    await router.navigate("/");

    expect(sessions.close).toHaveBeenCalledOnce();
    unbind();
    router.dispose();
  });

  it.each(["/room/", "/ROOM"])(
    "preserves the session for matched room URL %s and closes after leaving",
    async (path) => {
      const sessions = fakeSessions();
      const router = createMemoryRouter(
        createSiteRoutes({ endpoint, sessions }),
        { initialEntries: [`${path}?room=planning`] },
      );
      const unbind = bindSessionToRouter(router, sessions);
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
      const router = createMemoryRouter(
        createSiteRoutes({ endpoint, sessions }),
        { initialEntries: [entry] },
      );
      const unbind = bindSessionToRouter(router, sessions);
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
    const router = createMemoryRouter(
      createSiteRoutes({ endpoint, sessions }),
      { initialEntries: ["/room?room=planning"] },
    );
    const unbind = bindSessionToRouter(router, sessions);
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
});

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
