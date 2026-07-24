import type { ClientOptions } from "@ppoker/web-client";
import { describe, expect, it, vi } from "vitest";

import { createBroadcastSessionManager } from "../src/broadcast-session";
import {
  createClientLifecycle,
  type ClientStartResult,
  type PokerClientLifecycle,
} from "../src/client-lifecycle";
import type { BroadcastConfig } from "../src/config";
import { createFakeClient, makeSnapshot } from "./fake-client";

const planning = {
  endpoint: "wss://example.test/",
  room: "planning",
} as const satisfies BroadcastConfig;

describe("broadcast session manager", () => {
  it("connects only once for repeated starts of one room", async () => {
    const fake = createFakeClient();
    const createLifecycle = vi.fn((options: ClientOptions) =>
      createClientLifecycle(options, () => Promise.resolve(fake.client)),
    );
    const sessions = createManager({ createLifecycle });

    sessions.start(planning);
    sessions.start(planning);
    await settle();

    expect(createLifecycle).toHaveBeenCalledOnce();
    expect(createLifecycle).toHaveBeenCalledWith({
      endpoint: planning.endpoint,
      name: "Planning Poker Billboard",
      role: "spectator",
      room: planning.room,
    });
    expect(fake.client.connect).toHaveBeenCalledOnce();
    sessions.dispose();
  });

  it("replaces the prior room and cleans up each lifecycle once", () => {
    const first = fakeLifecycle(new Promise(() => undefined));
    const second = fakeLifecycle(new Promise(() => undefined));
    const lifecycles = [first, second];
    const firstUnbind = vi.fn<() => void>();
    const secondUnbind = vi.fn<() => void>();
    const unbinds = [firstUnbind, secondUnbind];
    const createLifecycle = vi.fn(
      () => lifecycles.shift() as PokerClientLifecycle,
    );
    const bindLifecycle = vi.fn(() => unbinds.shift() as () => void);
    const sessions = createManager({ bindLifecycle, createLifecycle });

    sessions.start(planning);
    sessions.start({ ...planning, room: "delivery/2026" });

    expect(first.close).toHaveBeenCalledOnce();
    expect(firstUnbind).toHaveBeenCalledOnce();
    expect(secondUnbind).not.toHaveBeenCalled();
    sessions.close();
    sessions.close();
    expect(second.close).toHaveBeenCalledOnce();
    expect(secondUnbind).toHaveBeenCalledOnce();
    expect(bindLifecycle).toHaveBeenCalledTimes(2);
  });

  it("ignores late success and failure from replaced sessions", async () => {
    const first = deferred<ClientStartResult>();
    const second = deferred<ClientStartResult>();
    const third = deferred<ClientStartResult>();
    const fourth = deferred<ClientStartResult>();
    const firstLifecycle = fakeLifecycle(first.promise);
    const secondLifecycle = fakeLifecycle(second.promise);
    const thirdLifecycle = fakeLifecycle(third.promise);
    const fourthLifecycle = fakeLifecycle(fourth.promise);
    const lifecycles = [
      firstLifecycle,
      secondLifecycle,
      thirdLifecycle,
      fourthLifecycle,
    ];
    const sessions = createManager({
      createLifecycle: () => lifecycles.shift() as PokerClientLifecycle,
    });
    const currentClient = createFakeClient().client;
    const staleClient = createFakeClient().client;

    sessions.start(planning);
    sessions.start({ ...planning, room: "current" });
    second.resolve({ client: currentClient, connectError: null });
    await settle();
    const current = sessions.getSnapshot();
    expect(current.status).toBe("ready");

    first.resolve({ client: staleClient, connectError: null });
    await settle();
    expect(sessions.getSnapshot()).toBe(current);
    expect(firstLifecycle.close).toHaveBeenCalledOnce();

    sessions.start({ ...planning, room: "third" });
    sessions.start({ ...planning, room: "fourth" });
    third.reject(new Error("late third failure"));
    await settle();
    expect(sessions.getSnapshot()).toMatchObject({
      room: "fourth",
      status: "starting",
    });
    expect(thirdLifecycle.close).toHaveBeenCalledOnce();

    sessions.close();
    fourth.resolve({ client: staleClient, connectError: null });
    await settle();
    expect(sessions.getSnapshot()).toEqual({ status: "idle" });
    expect(fourthLifecycle.close).toHaveBeenCalledOnce();
    sessions.dispose();
  });

  it("keeps revealAt anchored to session start when the snapshot arrives late", async () => {
    const fake = createFakeClient(
      makeSnapshot({ revision: 1, status: "connecting" }),
    );
    let currentTime = 1_000;
    const now = vi.fn(() => currentTime);
    const sessions = createManager({
      createLifecycle: () =>
        fakeLifecycle(
          Promise.resolve({ client: fake.client, connectError: null }),
        ),
      now,
      revealDelayMs: 325,
    });

    sessions.start(planning);
    currentTime = 2_000;
    await settle();
    expect(sessions.getSnapshot()).toMatchObject({
      revealAt: 1_325,
      status: "ready",
    });

    fake.publish(
      makeSnapshot({
        revision: 2,
        room: {
          deck: [],
          name: "planning",
          phase: "playing",
          players: [],
        },
        status: "open",
      }),
    );

    expect(sessions.getSnapshot()).toMatchObject({
      revealAt: 1_325,
      status: "ready",
    });
    expect(now).toHaveBeenCalledOnce();
    sessions.dispose();
  });

  it("disposes an active controller once and suppresses pending completion", async () => {
    const pending = deferred<ClientStartResult>();
    const lifecycle = fakeLifecycle(pending.promise);
    const unbind = vi.fn<() => void>();
    const createLifecycle = vi.fn(() => lifecycle);
    const sessions = createManager({
      bindLifecycle: () => unbind,
      createLifecycle,
    });
    const listener = vi.fn<() => void>();

    sessions.start(planning);
    sessions.subscribe(listener);
    sessions.dispose();
    sessions.dispose();
    pending.resolve({
      client: createFakeClient().client,
      connectError: null,
    });
    await settle();
    sessions.start({ ...planning, room: "after-disposal" });

    expect(lifecycle.close).toHaveBeenCalledOnce();
    expect(unbind).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    expect(createLifecycle).toHaveBeenCalledOnce();
    expect(sessions.getSnapshot()).toEqual({ status: "idle" });
  });
});

function createManager(overrides: {
  readonly bindLifecycle?: () => () => void;
  readonly createLifecycle: (options: ClientOptions) => PokerClientLifecycle;
  readonly now?: () => number;
  readonly revealDelayMs?: number;
}) {
  return createBroadcastSessionManager({
    ...(overrides.bindLifecycle === undefined
      ? {}
      : { bindLifecycle: overrides.bindLifecycle }),
    createLifecycle: overrides.createLifecycle,
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    pageTarget: new EventTarget(),
    reload: vi.fn<() => void>(),
    ...(overrides.revealDelayMs === undefined
      ? {}
      : { revealDelayMs: overrides.revealDelayMs }),
  });
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
  let rejectPromise: ((error: unknown) => void) | undefined;
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve, reject) => {
    rejectPromise = reject;
    resolvePromise = resolve;
  });
  return {
    promise,
    reject: (error) => rejectPromise?.(error),
    resolve: (value) => resolvePromise?.(value),
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
