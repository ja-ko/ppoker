import { act, cleanup, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useScreenWakeLock } from "../src/voting/screen-wake-lock";

const originalVisibilityState = Object.getOwnPropertyDescriptor(
  document,
  "visibilityState",
);
const originalWakeLock = Object.getOwnPropertyDescriptor(navigator, "wakeLock");
let visibilityState: DocumentVisibilityState;

function WakeLockProbe({ active = true }: { readonly active?: boolean }) {
  useScreenWakeLock(active);
  return null;
}

describe("useScreenWakeLock", () => {
  beforeEach(() => {
    visibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });
  });

  afterEach(() => {
    cleanup();
    restoreProperty(document, "visibilityState", originalVisibilityState);
    restoreProperty(navigator, "wakeLock", originalWakeLock);
  });

  it("acquires a screen wake lock while initially visible", async () => {
    const sentinel = new FakeWakeLockSentinel();
    const request = wakeLockRequest();
    request.mockResolvedValue(asSentinel(sentinel));
    installWakeLock(request);

    const view = render(<WakeLockProbe />);

    await waitFor(() => {
      expect(sentinel.listenerCount).toBe(1);
    });
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("screen");

    view.unmount();
  });

  it("reacquires after a hidden page loses its sentinel and becomes visible", async () => {
    const first = new FakeWakeLockSentinel();
    const second = new FakeWakeLockSentinel();
    const request = wakeLockRequest();
    request
      .mockResolvedValueOnce(asSentinel(first))
      .mockResolvedValueOnce(asSentinel(second));
    installWakeLock(request);
    const view = render(<WakeLockProbe />);
    await waitFor(() => {
      expect(first.listenerCount).toBe(1);
    });

    act(() => {
      setVisibility("hidden");
      first.releaseFromPlatform();
    });
    expect(request).toHaveBeenCalledOnce();

    act(() => {
      setVisibility("visible");
    });
    await waitFor(() => {
      expect(second.listenerCount).toBe(1);
    });
    expect(request).toHaveBeenCalledTimes(2);

    view.unmount();
  });

  it("releases its sentinel and removes visibility handling on cleanup", async () => {
    const sentinel = new FakeWakeLockSentinel();
    const request = wakeLockRequest();
    request.mockResolvedValue(asSentinel(sentinel));
    installWakeLock(request);
    const addEventListener = vi.spyOn(document, "addEventListener");
    const removeEventListener = vi.spyOn(document, "removeEventListener");
    const view = render(<WakeLockProbe />);
    await waitFor(() => {
      expect(sentinel.listenerCount).toBe(1);
    });
    const visibilityRegistration = addEventListener.mock.calls.find(
      ([type]) => type === "visibilitychange",
    );
    if (visibilityRegistration === undefined) {
      throw new Error("Expected a visibilitychange registration.");
    }

    view.unmount();

    expect(removeEventListener).toHaveBeenCalledWith(
      "visibilitychange",
      visibilityRegistration[1],
    );
    expect(sentinel.release).toHaveBeenCalledOnce();
    expect(sentinel.listenerCount).toBe(0);
    act(() => {
      setVisibility("visible");
      sentinel.releaseFromPlatform();
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("releases immediately when its route is no longer present", async () => {
    const first = new FakeWakeLockSentinel();
    const second = new FakeWakeLockSentinel();
    const request = wakeLockRequest();
    request
      .mockResolvedValueOnce(asSentinel(first))
      .mockResolvedValueOnce(asSentinel(second));
    installWakeLock(request);
    const view = render(<WakeLockProbe />);
    await waitFor(() => {
      expect(first.listenerCount).toBe(1);
    });

    view.rerender(<WakeLockProbe active={false} />);

    expect(first.release).toHaveBeenCalledOnce();
    expect(first.listenerCount).toBe(0);
    expect(request).toHaveBeenCalledOnce();

    view.rerender(<WakeLockProbe />);
    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(2);
      expect(second.listenerCount).toBe(1);
    });

    view.unmount();
  });

  it("does nothing when the wake lock API is unsupported", () => {
    Reflect.deleteProperty(navigator, "wakeLock");
    const addEventListener = vi.spyOn(document, "addEventListener");

    const view = render(<WakeLockProbe />);

    expect(
      addEventListener.mock.calls.some(([type]) => type === "visibilitychange"),
    ).toBe(false);
    view.unmount();
  });

  it("silently tolerates a rejected request", async () => {
    const request = wakeLockRequest();
    request.mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    installWakeLock(request);
    const view = render(<WakeLockProbe />);

    await waitFor(() => {
      expect(request).toHaveBeenCalledOnce();
    });
    await act(() => Promise.resolve());

    act(() => {
      setVisibility("visible");
    });
    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(2);
    });

    view.unmount();
  });

  it("does not duplicate an in-flight request under Strict Mode or visibility events", async () => {
    const pending = deferred<WakeLockSentinel>();
    const sentinel = new FakeWakeLockSentinel();
    const request = wakeLockRequest();
    request.mockReturnValue(pending.promise);
    installWakeLock(request);
    const view = render(
      <StrictMode>
        <WakeLockProbe />
      </StrictMode>,
    );
    await waitFor(() => {
      expect(request).toHaveBeenCalledOnce();
    });

    act(() => {
      setVisibility("visible");
      setVisibility("visible");
    });
    expect(request).toHaveBeenCalledOnce();

    await act(async () => {
      pending.resolve(asSentinel(sentinel));
      await pending.promise;
    });
    await waitFor(() => {
      expect(sentinel.listenerCount).toBe(1);
    });

    view.unmount();
  });

  it("does not retry a pending rejection after Strict Mode reactivation", async () => {
    const pending = deferred<WakeLockSentinel>();
    const denial = new DOMException("Denied", "NotAllowedError");
    const request = wakeLockRequest();
    request.mockReturnValue(pending.promise);
    installWakeLock(request);
    const view = render(
      <StrictMode>
        <WakeLockProbe />
      </StrictMode>,
    );
    await waitFor(() => {
      expect(request).toHaveBeenCalledOnce();
    });

    await act(async () => {
      pending.reject(denial);
      await expect(pending.promise).rejects.toBe(denial);
    });

    expect(request).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("requests fresh after a stale request rejects following real reactivation", async () => {
    const pending = deferred<WakeLockSentinel>();
    const denial = new DOMException("Denied", "NotAllowedError");
    const fresh = new FakeWakeLockSentinel();
    const request = wakeLockRequest();
    request
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(asSentinel(fresh));
    installWakeLock(request);
    const view = render(<WakeLockProbe />);
    await waitFor(() => {
      expect(request).toHaveBeenCalledOnce();
    });

    view.rerender(<WakeLockProbe active={false} />);
    view.rerender(<WakeLockProbe />);
    expect(request).toHaveBeenCalledOnce();

    await act(async () => {
      pending.reject(denial);
      await expect(pending.promise).rejects.toBe(denial);
    });
    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(2);
      expect(fresh.listenerCount).toBe(1);
    });

    view.unmount();
  });

  it("releases a request that resolves after unmount without reacquiring", async () => {
    const pending = deferred<WakeLockSentinel>();
    const sentinel = new FakeWakeLockSentinel();
    const request = wakeLockRequest();
    request.mockReturnValue(pending.promise);
    installWakeLock(request);
    const view = render(<WakeLockProbe />);
    await waitFor(() => {
      expect(request).toHaveBeenCalledOnce();
    });

    view.unmount();
    await act(async () => {
      pending.resolve(asSentinel(sentinel));
      await pending.promise;
    });
    await waitFor(() => {
      expect(sentinel.release).toHaveBeenCalledOnce();
    });

    act(() => {
      setVisibility("visible");
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("replaces an in-flight request invalidated by a hidden-visible race", async () => {
    const pending = deferred<WakeLockSentinel>();
    const stale = new FakeWakeLockSentinel();
    const fresh = new FakeWakeLockSentinel();
    const request = wakeLockRequest();
    request
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(asSentinel(fresh));
    installWakeLock(request);
    const view = render(<WakeLockProbe />);
    await waitFor(() => {
      expect(request).toHaveBeenCalledOnce();
    });

    act(() => {
      setVisibility("hidden");
      setVisibility("visible");
    });
    expect(request).toHaveBeenCalledOnce();

    await act(async () => {
      pending.resolve(asSentinel(stale));
      await pending.promise;
    });
    await waitFor(() => {
      expect(stale.release).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledTimes(2);
      expect(fresh.listenerCount).toBe(1);
    });

    view.unmount();
  });
});

class FakeWakeLockSentinel {
  readonly #listeners = new Set<EventListenerOrEventListenerObject>();
  #released = false;

  readonly addEventListener = vi.fn(
    (type: string, listener: EventListenerOrEventListenerObject): void => {
      if (type === "release") {
        this.#listeners.add(listener);
      }
    },
  );

  readonly release = vi.fn((): Promise<void> => {
    this.releaseFromPlatform();
    return Promise.resolve();
  });

  readonly removeEventListener = vi.fn(
    (type: string, listener: EventListenerOrEventListenerObject): void => {
      if (type === "release") {
        this.#listeners.delete(listener);
      }
    },
  );

  get listenerCount(): number {
    return this.#listeners.size;
  }

  get released(): boolean {
    return this.#released;
  }

  releaseFromPlatform(): void {
    if (this.#released) {
      return;
    }
    this.#released = true;
    const event = new Event("release");
    for (const listener of [...this.#listeners]) {
      if (typeof listener === "function") {
        listener(event);
      } else {
        listener.handleEvent(event);
      }
    }
  }
}

type WakeLockRequest = (type: "screen") => Promise<WakeLockSentinel>;

function asSentinel(sentinel: FakeWakeLockSentinel): WakeLockSentinel {
  return sentinel as unknown as WakeLockSentinel;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: T) => void;
} {
  let reject: ((reason?: unknown) => void) | undefined;
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  if (reject === undefined || resolve === undefined) {
    throw new Error("Expected the Promise executor to run synchronously.");
  }
  return { promise, reject, resolve };
}

function installWakeLock(
  request: ReturnType<typeof vi.fn<WakeLockRequest>>,
): void {
  Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    value: { request },
  });
}

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, key);
    return;
  }
  Object.defineProperty(target, key, descriptor);
}

function setVisibility(state: DocumentVisibilityState): void {
  visibilityState = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

function wakeLockRequest() {
  return vi.fn<WakeLockRequest>();
}
