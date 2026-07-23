import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { startBroadcastClient, type BroadcastRoot } from "../src/bootstrap";
import type {
  ClientStartResult,
  PokerClientLifecycle,
} from "../src/client-lifecycle";
import { createFakeClient } from "./fake-client";

const config = { endpoint: "wss://example.test/", room: "planning" };

describe("broadcast bootstrap disposal", () => {
  it("does not render delayed client success after disposal", async () => {
    const pending = deferred<ClientStartResult>();
    const lifecycle = fakeLifecycle(pending.promise);
    const root = fakeRoot();
    const bootstrap = startBroadcastClient(root, config, {
      createLifecycle: () => lifecycle,
      pageTarget: new EventTarget(),
      reload: vi.fn(),
    });
    expect(root.render).toHaveBeenCalledOnce();

    bootstrap.dispose();
    pending.resolve({
      client: createFakeClient().client,
      connectError: null,
    });
    await pending.promise;
    await Promise.resolve();

    expect(root.render).toHaveBeenCalledOnce();
    expect(root.unmount).toHaveBeenCalledOnce();
    expect(lifecycle.close).toHaveBeenCalledOnce();
  });

  it("does not render delayed initialization failure after disposal", async () => {
    const pending = deferred<ClientStartResult>();
    const lifecycle = fakeLifecycle(pending.promise);
    const root = fakeRoot();
    const bootstrap = startBroadcastClient(root, config, {
      createLifecycle: () => lifecycle,
      pageTarget: new EventTarget(),
      reload: vi.fn(),
    });

    bootstrap.dispose();
    pending.reject(new Error("late failure"));
    await expect(pending.promise).rejects.toThrow("late failure");
    await Promise.resolve();

    expect(root.render).toHaveBeenCalledOnce();
    expect(root.unmount).toHaveBeenCalledOnce();
  });

  it("always unmounts when lifecycle close throws", () => {
    const lifecycle = fakeLifecycle(new Promise(() => undefined));
    vi.mocked(lifecycle.close).mockImplementation(() => {
      throw new Error("close failed");
    });
    const root = fakeRoot();
    const bootstrap = startBroadcastClient(root, config, {
      createLifecycle: () => lifecycle,
      pageTarget: new EventTarget(),
      reload: vi.fn(),
    });

    expect(() => {
      bootstrap.dispose();
    }).not.toThrow();
    expect(root.unmount).toHaveBeenCalledOnce();
    bootstrap.dispose();
    expect(root.unmount).toHaveBeenCalledOnce();
  });
});

function fakeRoot(): BroadcastRoot & {
  readonly render: ReturnType<typeof vi.fn<(children: ReactNode) => void>>;
  readonly unmount: ReturnType<typeof vi.fn<() => void>>;
} {
  return {
    render: vi.fn<(children: ReactNode) => void>(),
    unmount: vi.fn<() => void>(),
  };
}

function fakeLifecycle(
  start: Promise<ClientStartResult>,
): PokerClientLifecycle & {
  readonly close: ReturnType<typeof vi.fn<() => void>>;
} {
  return {
    close: vi.fn<() => void>(),
    start: vi.fn<() => Promise<ClientStartResult>>(() => start),
  };
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: Value) => void;
} {
  let resolve: ((value: Value) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    reject: (error) => reject?.(error),
    resolve: (value) => resolve?.(value),
  };
}
