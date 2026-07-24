import type { ClientOptions } from "@ppoker/web-client";
import { describe, expect, it, vi } from "vitest";

import type {
  ClientStartResult,
  PokerClientLifecycle,
} from "../src/client-lifecycle";
import type { VotingConfig } from "../src/config";
import type { VoterNameSession } from "../src/voting/voter-session";
import { createVotingSessionManager } from "../src/voting-session";
import { createFakeClient } from "./fake-client";

const planning = {
  endpoint: "wss://example.test/",
  room: "planning",
} as const satisfies VotingConfig;

describe("voting session manager", () => {
  it("loads the name before creating one participant lifecycle per endpoint and room", async () => {
    const events: string[] = [];
    const pending = deferred<ClientStartResult>();
    const lifecycle = fakeLifecycle(pending.promise);
    const nameSession = fakeNameSession(() => {
      events.push("name");
      return "Calm Otter";
    });
    const createLifecycle = vi.fn((options: ClientOptions) => {
      events.push("client");
      expect(options).toEqual({
        endpoint: planning.endpoint,
        name: "Calm Otter",
        role: "participant",
        room: planning.room,
      });
      return lifecycle;
    });
    const sessions = createManager({
      createLifecycle,
      createNameSession: () => nameSession,
    });

    expect(Object.isFrozen(sessions.getSnapshot())).toBe(true);
    sessions.start(planning);
    sessions.start(planning);

    const starting = sessions.getSnapshot();
    expect(events).toEqual(["name", "client"]);
    expect(createLifecycle).toHaveBeenCalledOnce();
    expect(starting).toMatchObject({
      initialName: "Calm Otter",
      nameSession,
      room: planning.room,
      status: "starting",
    });
    expect(Object.isFrozen(starting)).toBe(true);
    expect(sessions.getSnapshot()).toBe(starting);

    const client = createFakeClient().client;
    pending.resolve({ client, connectError: null });
    await settle();

    const ready = sessions.getSnapshot();
    expect(ready).toMatchObject({
      client,
      connectError: null,
      initialName: "Calm Otter",
      nameSession,
      room: planning.room,
      status: "ready",
    });
    expect(Object.isFrozen(ready)).toBe(true);
    sessions.dispose();
  });

  it("replaces sessions when either endpoint or room changes and cleans each once", () => {
    const first = fakeLifecycle(new Promise(() => undefined));
    const second = fakeLifecycle(new Promise(() => undefined));
    const third = fakeLifecycle(new Promise(() => undefined));
    const lifecycles = [first, second, third];
    const firstUnbind = vi.fn<() => void>();
    const secondUnbind = vi.fn<() => void>();
    const thirdUnbind = vi.fn<() => void>();
    const unbinds = [firstUnbind, secondUnbind, thirdUnbind];
    const nameSession = fakeNameSession(() => "Calm Otter");
    const sessions = createManager({
      bindLifecycle: () => unbinds.shift() as () => void,
      createLifecycle: () => lifecycles.shift() as PokerClientLifecycle,
      createNameSession: () => nameSession,
    });

    sessions.start(planning);
    sessions.start({ ...planning, room: "delivery" });
    sessions.start({ endpoint: "wss://other.test/", room: "delivery" });

    expect(first.close).toHaveBeenCalledOnce();
    expect(firstUnbind).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
    expect(secondUnbind).toHaveBeenCalledOnce();
    expect(third.close).not.toHaveBeenCalled();
    expect(nameSession.load).toHaveBeenCalledTimes(3);

    sessions.close();
    sessions.close();
    expect(third.close).toHaveBeenCalledOnce();
    expect(thirdUnbind).toHaveBeenCalledOnce();
    expect(sessions.getSnapshot()).toEqual({ status: "idle" });
  });

  it("ignores late success and failure from replaced or closed sessions", async () => {
    const first = deferred<ClientStartResult>();
    const second = deferred<ClientStartResult>();
    const third = deferred<ClientStartResult>();
    const firstLifecycle = fakeLifecycle(first.promise);
    const secondLifecycle = fakeLifecycle(second.promise);
    const thirdLifecycle = fakeLifecycle(third.promise);
    const lifecycles = [firstLifecycle, secondLifecycle, thirdLifecycle];
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
    expect(current).toMatchObject({ room: "current", status: "ready" });

    first.resolve({ client: staleClient, connectError: null });
    await settle();
    expect(sessions.getSnapshot()).toBe(current);
    expect(firstLifecycle.close).toHaveBeenCalledOnce();

    sessions.start({ ...planning, room: "third" });
    third.reject(new Error("late failure"));
    sessions.close();
    await settle();
    expect(sessions.getSnapshot()).toEqual({ status: "idle" });
    expect(thirdLifecycle.close).toHaveBeenCalledOnce();
    sessions.dispose();
  });

  it("publishes preparation and asynchronous initialization errors", async () => {
    const loadError = new Error("name generation failed");
    const createLifecycle =
      vi.fn<(options: ClientOptions) => PokerClientLifecycle>();
    const nameFailure = createManager({
      createLifecycle,
      createNameSession: () =>
        fakeNameSession(() => {
          throw loadError;
        }),
    });

    nameFailure.start(planning);
    expect(nameFailure.getSnapshot()).toEqual({
      error: loadError,
      room: planning.room,
      status: "error",
    });
    expect(Object.isFrozen(nameFailure.getSnapshot())).toBe(true);
    expect(createLifecycle).not.toHaveBeenCalled();

    const startError = new Error("participant WASM failed");
    const startFailure = createManager({
      createLifecycle: () => fakeLifecycle(Promise.reject(startError)),
    });
    startFailure.start(planning);
    await settle();
    expect(startFailure.getSnapshot()).toEqual({
      error: startError,
      room: planning.room,
      status: "error",
    });

    nameFailure.dispose();
    startFailure.dispose();
  });

  it("tears down and permits retry when page lifecycle binding throws", () => {
    const first = fakeLifecycle(new Promise(() => undefined));
    const second = fakeLifecycle(new Promise(() => undefined));
    const lifecycles = [first, second];
    const bindError = new Error("page lifecycle binding failed");
    const secondUnbind = vi.fn<() => void>();
    let bindCount = 0;
    const bindLifecycle = vi.fn(() => {
      bindCount += 1;
      if (bindCount === 1) {
        throw bindError;
      }
      return secondUnbind;
    });
    const createLifecycle = vi.fn(
      () => lifecycles.shift() as PokerClientLifecycle,
    );
    const sessions = createManager({ bindLifecycle, createLifecycle });

    sessions.start(planning);

    expect(sessions.getSnapshot()).toEqual({
      error: bindError,
      room: planning.room,
      status: "error",
    });
    expect(first.close).toHaveBeenCalledOnce();

    sessions.start(planning);

    expect(createLifecycle).toHaveBeenCalledTimes(2);
    expect(bindLifecycle).toHaveBeenCalledTimes(2);
    expect(sessions.getSnapshot()).toMatchObject({
      room: planning.room,
      status: "starting",
    });
    sessions.dispose();
    expect(second.close).toHaveBeenCalledOnce();
    expect(secondUnbind).toHaveBeenCalledOnce();
  });

  it("tears down and permits retry when lifecycle start throws", () => {
    const startError = new Error("synchronous start failed");
    const firstClose = vi.fn<() => void>();
    const first: PokerClientLifecycle = {
      close: firstClose,
      start: () => {
        throw startError;
      },
    };
    const second = fakeLifecycle(new Promise(() => undefined));
    const lifecycles = [first, second];
    const firstUnbind = vi.fn<() => void>();
    const secondUnbind = vi.fn<() => void>();
    const unbinds = [firstUnbind, secondUnbind];
    const createLifecycle = vi.fn(() => {
      const lifecycle = lifecycles.shift();
      if (lifecycle === undefined) {
        throw new Error("Test lifecycle queue exhausted.");
      }
      return lifecycle;
    });
    const sessions = createManager({
      bindLifecycle: () => {
        const unbind = unbinds.shift();
        if (unbind === undefined) {
          throw new Error("Test unbind queue exhausted.");
        }
        return unbind;
      },
      createLifecycle,
    });

    sessions.start(planning);

    expect(sessions.getSnapshot()).toEqual({
      error: startError,
      room: planning.room,
      status: "error",
    });
    expect(firstClose).toHaveBeenCalledOnce();
    expect(firstUnbind).toHaveBeenCalledOnce();

    sessions.start(planning);

    expect(createLifecycle).toHaveBeenCalledTimes(2);
    expect(sessions.getSnapshot()).toMatchObject({
      room: planning.room,
      status: "starting",
    });
    sessions.dispose();
    expect(second.close).toHaveBeenCalledOnce();
    expect(secondUnbind).toHaveBeenCalledOnce();
  });

  it("continues teardown when unbinding and closing throw", () => {
    const closeError = new Error("close failed");
    const close = vi.fn(() => {
      throw closeError;
    });
    const lifecycle: PokerClientLifecycle = {
      close,
      start: vi.fn(() => new Promise<ClientStartResult>(() => undefined)),
    };
    const unbind = vi.fn(() => {
      throw new Error("unbind failed");
    });
    const sessions = createManager({
      bindLifecycle: () => unbind,
      createLifecycle: () => lifecycle,
    });
    const listener = vi.fn<() => void>();
    sessions.subscribe(listener);
    sessions.start(planning);

    expect(() => {
      sessions.close();
    }).not.toThrow();
    expect(() => {
      sessions.close();
    }).not.toThrow();
    expect(unbind).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(sessions.getSnapshot()).toEqual({ status: "idle" });
  });

  it("binds page lifecycle behavior and removes it when closed", () => {
    const pageTarget = new EventTarget();
    const reload = vi.fn<() => void>();
    const lifecycle = fakeLifecycle(new Promise(() => undefined));
    const sessions = createManager({
      createLifecycle: () => lifecycle,
      pageTarget,
      reload,
    });
    sessions.start(planning);

    pageTarget.dispatchEvent(pageTransition("pagehide", false));
    pageTarget.dispatchEvent(pageTransition("pageshow", true));
    expect(lifecycle.close).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();

    sessions.close();
    pageTarget.dispatchEvent(pageTransition("pageshow", true));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("disposes once, suppresses pending completion, and rejects later starts", async () => {
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
  readonly createNameSession?: () => VoterNameSession;
  readonly pageTarget?: Pick<
    EventTarget,
    "addEventListener" | "removeEventListener"
  >;
  readonly reload?: () => void;
}) {
  return createVotingSessionManager({
    ...(overrides.bindLifecycle === undefined
      ? {}
      : { bindLifecycle: overrides.bindLifecycle }),
    createLifecycle: overrides.createLifecycle,
    ...(overrides.createNameSession === undefined
      ? { createNameSession: () => fakeNameSession(() => "Calm Otter") }
      : { createNameSession: overrides.createNameSession }),
    pageTarget: overrides.pageTarget ?? new EventTarget(),
    reload: overrides.reload ?? vi.fn<() => void>(),
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

function fakeNameSession(load: () => string): VoterNameSession & {
  readonly load: ReturnType<typeof vi.fn<() => string>>;
} {
  return {
    load: vi.fn(load),
    rename: vi.fn(
      () =>
        ({
          name: "Renamed Voter",
          ok: true,
          persisted: true,
        }) as const,
    ),
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

function pageTransition(type: string, persisted: boolean): Event {
  const event = new Event(type);
  Object.defineProperty(event, "persisted", { value: persisted });
  return event;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
