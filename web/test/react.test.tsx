import { StrictMode, type ReactNode } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PokerClientProvider,
  usePokerClient,
  usePokerClientSnapshot,
  type ClientSnapshot,
  type PokerClient,
} from "../src/react.js";
import { createFakeClient, makeSnapshot } from "./fake-client.js";

afterEach(() => {
  cleanup();
});

function SnapshotView({
  capture,
}: {
  readonly capture?: (snapshot: ClientSnapshot) => void;
} = {}): ReactNode {
  const snapshot = usePokerClientSnapshot();
  capture?.(snapshot);
  return `${snapshot.localName}:${snapshot.status}:${snapshot.revision.toString()}`;
}

function provide(client: PokerClient, children: ReactNode = <SnapshotView />) {
  return <PokerClientProvider client={client}>{children}</PokerClientProvider>;
}

function renderClient(client: PokerClient) {
  return render(provide(client));
}

describe("poker client hooks", () => {
  it("throws a deterministic error when either hook lacks a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const expected =
      "Poker client hooks must be used within a PokerClientProvider.";

    expect(() => renderHook(() => usePokerClient())).toThrow(expected);
    expect(() => renderHook(() => usePokerClientSnapshot())).toThrow(expected);
  });

  it("returns the provided client and updates snapshots", () => {
    const { client, publish } = createFakeClient();
    const wrapper = ({ children }: { readonly children: ReactNode }) =>
      provide(client, children);
    const clientHook = renderHook(() => usePokerClient(), { wrapper });
    const snapshotHook = renderHook(() => usePokerClientSnapshot(), {
      wrapper,
    });

    expect(clientHook.result.current).toBe(client);
    expect(snapshotHook.result.current.revision).toBe(0);
    act(() => {
      publish(makeSnapshot(1, "connecting", "Tester"));
    });
    expect(snapshotHook.result.current).toBe(client.getSnapshot());
    expect(snapshotHook.result.current).toMatchObject({
      revision: 1,
      status: "connecting",
    });
  });

  it("balances subscriptions when the provider client changes", () => {
    const first = createFakeClient(makeSnapshot(1, "open", "First"));
    const second = createFakeClient(makeSnapshot(5, "open", "Second"));
    const view = renderClient(first.client);

    expect(view.container.textContent).toBe("First:open:1");
    expect(first.client.subscribe).toHaveBeenCalledOnce();
    expect(first.activeListenerCount()).toBe(1);
    view.rerender(provide(second.client));
    expect(view.container.textContent).toBe("Second:open:5");
    expect(second.client.subscribe).toHaveBeenCalledOnce();
    expect(first.activeListenerCount()).toBe(0);
    expect(second.activeListenerCount()).toBe(1);

    act(() => {
      first.publish(makeSnapshot(2, "open", "Stale"));
    });
    expect(view.container.textContent).toBe("Second:open:5");
    act(() => {
      second.publish(makeSnapshot(6, "open", "Second updated"));
    });
    expect(view.container.textContent).toBe("Second updated:open:6");
    view.unmount();
    expect(second.activeListenerCount()).toBe(0);
    expect(first.client.close).not.toHaveBeenCalled();
    expect(second.client.close).not.toHaveBeenCalled();
  });

  it("isolates multiple providers", () => {
    const first = createFakeClient(makeSnapshot(0, "open", "First"));
    const second = createFakeClient(makeSnapshot(4, "open", "Second"));
    const firstView = renderClient(first.client);
    const secondView = renderClient(second.client);

    act(() => {
      first.publish(makeSnapshot(1, "open", "First updated"));
    });
    expect(firstView.container.textContent).toBe("First updated:open:1");
    expect(secondView.container.textContent).toBe("Second:open:4");

    firstView.unmount();
    secondView.unmount();
    expect(first.client.close).not.toHaveBeenCalled();
    expect(second.client.close).not.toHaveBeenCalled();
  });

  it("unmounts without closing or connecting the client", () => {
    const { client } = createFakeClient();
    const view = renderClient(client);

    view.unmount();
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
    expect(client.getSnapshot().status).toBe("disconnected");
  });

  it("balances client subscriptions through Strict Mode cycling", () => {
    const { activeListenerCount, client } = createFakeClient();
    const view = render(<StrictMode>{provide(client)}</StrictMode>);

    expect(client.subscribe).toHaveBeenCalledTimes(2);
    expect(activeListenerCount()).toBe(1);
    view.unmount();
    expect(client.subscribe).toHaveBeenCalledTimes(2);
    expect(activeListenerCount()).toBe(0);
    expect(client.close).not.toHaveBeenCalled();
  });

  it("hydrates the stable server snapshot before reading the client", () => {
    const { activeListenerCount, client } = createFakeClient(
      makeSnapshot(9, "open", "Browser"),
    );
    const element = provide(client);
    const container = document.createElement("div");
    container.innerHTML = renderToString(element);
    document.body.append(container);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    let root: ReturnType<typeof hydrateRoot> | undefined;

    try {
      act(() => {
        root = hydrateRoot(container, element);
      });

      expect(container.textContent).toBe("Browser:open:9");
      expect(activeListenerCount()).toBe(1);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      const hydratedRoot = root;
      if (hydratedRoot !== undefined) {
        act(() => {
          hydratedRoot.unmount();
        });
      }
      container.remove();
    }
    expect(activeListenerCount()).toBe(0);
  });

  it("uses one immutable disconnected server snapshot during SSR", () => {
    const first = createFakeClient(makeSnapshot(9, "open", "Browser"));
    const second = createFakeClient(makeSnapshot(4, "open", "Other"));
    const serverSnapshots: ClientSnapshot[] = [];
    const capture = (snapshot: ClientSnapshot): void => {
      serverSnapshots.push(snapshot);
    };

    const firstHtml = renderToString(
      provide(first.client, <SnapshotView capture={capture} />),
    );
    const secondHtml = renderToString(
      provide(second.client, <SnapshotView capture={capture} />),
    );

    expect(firstHtml).toContain(":disconnected:0");
    expect(secondHtml).toBe(firstHtml);
    expect(serverSnapshots).toHaveLength(2);
    expect(serverSnapshots[1]).toBe(serverSnapshots[0]);
    expect(Object.isFrozen(serverSnapshots[0])).toBe(true);
    expect(Object.isFrozen(serverSnapshots[0]?.log)).toBe(true);
    expect(Object.isFrozen(serverSnapshots[0]?.history)).toBe(true);
    expect(first.client.getSnapshot).not.toHaveBeenCalled();
    expect(second.client.getSnapshot).not.toHaveBeenCalled();
    expect(first.client.poll).not.toHaveBeenCalled();
    expect(first.client.connect).not.toHaveBeenCalled();
  });
});
