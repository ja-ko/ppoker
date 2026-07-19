import { StrictMode, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPokerClientStore } from "../src/client-store.js";
import {
  PokerClientProvider,
  usePokerClientSnapshot,
  usePokerClientStore,
} from "../src/react.js";
import { createFakeClient, makeSnapshot } from "./fake-client.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function SnapshotView(): ReactNode {
  const snapshot = usePokerClientSnapshot();
  return `${snapshot.localName}:${snapshot.status}:${snapshot.revision.toString()}`;
}

describe("poker client hooks", () => {
  it("throws a deterministic error when either hook lacks a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const expected =
      "Poker client hooks must be used within a PokerClientProvider.";

    expect(() => renderHook(() => usePokerClientStore())).toThrow(expected);
    expect(() => renderHook(() => usePokerClientSnapshot())).toThrow(expected);
  });

  it("returns the provided store and updates snapshots", () => {
    const { client, state } = createFakeClient();
    client.connect.mockImplementation(() => {
      state.value = makeSnapshot(1, "connecting", "Tester");
    });
    const store = createPokerClientStore(client);
    const wrapper = ({ children }: { readonly children: ReactNode }) => (
      <PokerClientProvider store={store}>{children}</PokerClientProvider>
    );
    const storeHook = renderHook(() => usePokerClientStore(), { wrapper });
    const snapshotHook = renderHook(() => usePokerClientSnapshot(), {
      wrapper,
    });

    expect(storeHook.result.current).toBe(store);
    expect(snapshotHook.result.current.revision).toBe(0);
    act(() => {
      store.connect();
    });
    expect(snapshotHook.result.current).toBe(store.getSnapshot());
    expect(snapshotHook.result.current).toMatchObject({
      revision: 1,
      status: "connecting",
    });
  });

  it("balances subscriptions when the provider store changes", () => {
    vi.useFakeTimers();
    const first = createFakeClient(makeSnapshot(1, "open", "First"));
    const second = createFakeClient(makeSnapshot(5, "open", "Second"));
    const firstStore = createPokerClientStore(first.client);
    const secondStore = createPokerClientStore(second.client);
    const view = render(
      <PokerClientProvider store={firstStore}>
        <SnapshotView />
      </PokerClientProvider>,
    );

    expect(view.container.textContent).toBe("First:open:1");
    expect(vi.getTimerCount()).toBe(1);
    view.rerender(
      <PokerClientProvider store={secondStore}>
        <SnapshotView />
      </PokerClientProvider>,
    );
    expect(view.container.textContent).toBe("Second:open:5");
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(50);
    expect(first.client.poll).not.toHaveBeenCalled();
    expect(second.client.poll).toHaveBeenCalledOnce();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(first.client.close).not.toHaveBeenCalled();
    expect(second.client.close).not.toHaveBeenCalled();
  });

  it("isolates multiple providers and their polling lifecycles", () => {
    vi.useFakeTimers();
    const first = createFakeClient(makeSnapshot(0, "open", "First"));
    const second = createFakeClient(makeSnapshot(4, "open", "Second"));
    first.client.connect.mockImplementation(() => {
      first.state.value = makeSnapshot(1, "open", "First updated");
    });
    const firstStore = createPokerClientStore(first.client);
    const secondStore = createPokerClientStore(second.client);
    const firstView = render(
      <PokerClientProvider store={firstStore}>
        <SnapshotView />
      </PokerClientProvider>,
    );
    const secondView = render(
      <PokerClientProvider store={secondStore}>
        <SnapshotView />
      </PokerClientProvider>,
    );

    expect(vi.getTimerCount()).toBe(2);
    act(() => {
      firstStore.connect();
    });
    expect(firstView.container.textContent).toBe("First updated:open:1");
    expect(secondView.container.textContent).toBe("Second:open:4");

    firstView.unmount();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(50);
    expect(first.client.poll).not.toHaveBeenCalled();
    expect(second.client.poll).toHaveBeenCalledOnce();
    secondView.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(first.client.close).not.toHaveBeenCalled();
    expect(second.client.close).not.toHaveBeenCalled();
  });

  it("unmounts without disposing, closing, or connecting the store", () => {
    vi.useFakeTimers();
    const { client } = createFakeClient();
    const store = createPokerClientStore(client);
    const view = render(
      <PokerClientProvider store={store}>
        <SnapshotView />
      </PokerClientProvider>,
    );

    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
    expect(store.getSnapshot().status).toBe("disconnected");
  });

  it("leaves exactly one interval mounted through Strict Mode cycling", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const { client } = createFakeClient();
    const store = createPokerClientStore(client, { pollIntervalMs: 25 });
    const view = render(
      <StrictMode>
        <PokerClientProvider store={store}>
          <SnapshotView />
        </PokerClientProvider>
      </StrictMode>,
    );

    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(25);
    expect(client.poll).toHaveBeenCalledOnce();

    view.unmount();
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(client.close).not.toHaveBeenCalled();
  });

  it("uses the immutable disconnected server snapshot during SSR", () => {
    vi.useFakeTimers();
    const { client } = createFakeClient(makeSnapshot(9, "open", "Browser"));
    const store = createPokerClientStore(client);

    const html = renderToString(
      <PokerClientProvider store={store}>
        <SnapshotView />
      </PokerClientProvider>,
    );

    expect(html).toContain(":disconnected:0");
    expect(client.snapshot).toHaveBeenCalledOnce();
    expect(client.poll).not.toHaveBeenCalled();
    expect(client.connect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(Object.isFrozen(store.getServerSnapshot())).toBe(true);
  });
});
