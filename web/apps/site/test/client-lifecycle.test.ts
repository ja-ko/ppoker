import type { ClientOptions, PokerClient } from "@ppoker/web-client";
import { describe, expect, it, vi } from "vitest";

import {
  bindPageLifecycle,
  createClientLifecycle,
} from "../src/client-lifecycle";
import { createFakeClient } from "./fake-client";

const options = {
  endpoint: "wss://example.test/",
  name: "Planning Poker Billboard",
  role: "spectator",
  room: "planning",
} as const satisfies ClientOptions;

describe("production client lifecycle", () => {
  it("creates and connects one client for repeated starts", async () => {
    const { client } = createFakeClient();
    const factory = vi.fn<(value: ClientOptions) => Promise<PokerClient>>(() =>
      Promise.resolve(client),
    );
    const lifecycle = createClientLifecycle(options, factory);

    const [first, second] = await Promise.all([
      lifecycle.start(),
      lifecycle.start(),
    ]);

    expect(first.client).toBe(client);
    expect(second.client).toBe(client);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(options);
    expect(client.connect).toHaveBeenCalledOnce();
    lifecycle.close();
    lifecycle.close();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("retains a client when connect reports a synchronous failure", async () => {
    const { client } = createFakeClient();
    const error = new Error("connect failed");
    vi.mocked(client.connect).mockImplementation(() => {
      throw error;
    });
    const lifecycle = createClientLifecycle(options, () =>
      Promise.resolve(client),
    );

    const result = await lifecycle.start();
    expect(result.client).toBe(client);
    expect(result.connectError).toBe(error);
    lifecycle.close();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("closes once for page lifecycle and explicit teardown", async () => {
    const { client } = createFakeClient();
    const lifecycle = createClientLifecycle(options, () =>
      Promise.resolve(client),
    );
    const target = new EventTarget();
    const reload = vi.fn<() => void>();
    const unbind = bindPageLifecycle(lifecycle, target, reload);
    await lifecycle.start();

    target.dispatchEvent(new Event("pagehide"));
    lifecycle.close();
    unbind();
    expect(client.close).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
  });

  it("keeps BFCache pages alive and reloads when a persisted page returns", async () => {
    const { client } = createFakeClient();
    const lifecycle = createClientLifecycle(options, () =>
      Promise.resolve(client),
    );
    const target = new EventTarget();
    const reload = vi.fn<() => void>();
    const unbind = bindPageLifecycle(lifecycle, target, reload);
    await lifecycle.start();

    target.dispatchEvent(pageTransition("pagehide", true));
    expect(client.close).not.toHaveBeenCalled();
    target.dispatchEvent(pageTransition("pageshow", true));
    expect(reload).toHaveBeenCalledOnce();
    unbind();
    target.dispatchEvent(pageTransition("pageshow", true));
    expect(reload).toHaveBeenCalledOnce();
    lifecycle.close();
  });

  it("does not leak close errors from page lifecycle callbacks", async () => {
    const { client } = createFakeClient();
    vi.mocked(client.close).mockImplementation(() => {
      throw new Error("close failed");
    });
    const lifecycle = createClientLifecycle(options, () =>
      Promise.resolve(client),
    );
    const target = new EventTarget();
    bindPageLifecycle(lifecycle, target, vi.fn());
    await lifecycle.start();

    expect(() =>
      target.dispatchEvent(pageTransition("pagehide", false)),
    ).not.toThrow();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("closes a client created after teardown without connecting it", async () => {
    const { client } = createFakeClient();
    let resolveFactory: ((value: PokerClient) => void) | undefined;
    const factory = (): Promise<PokerClient> =>
      new Promise((resolve) => {
        resolveFactory = resolve;
      });
    const lifecycle = createClientLifecycle(options, factory);
    const start = lifecycle.start();

    lifecycle.close();
    resolveFactory?.(client);
    await expect(start).rejects.toThrow("closed during initialization");
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("surfaces initialization failures without retrying creation", async () => {
    const error = new Error("WASM initialization failed");
    const factory = vi.fn<() => Promise<PokerClient>>(() =>
      Promise.reject(error),
    );
    const lifecycle = createClientLifecycle(options, factory);

    await expect(lifecycle.start()).rejects.toBe(error);
    await expect(lifecycle.start()).rejects.toBe(error);
    expect(factory).toHaveBeenCalledOnce();
  });
});

function pageTransition(type: string, persisted: boolean): Event {
  const event = new Event(type);
  Object.defineProperty(event, "persisted", { value: persisted });
  return event;
}
