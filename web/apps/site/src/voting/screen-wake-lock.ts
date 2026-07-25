import { useEffect, useRef } from "react";

interface HeldWakeLock {
  readonly onRelease: () => void;
  readonly sentinel: WakeLockSentinel;
}

class ScreenWakeLockCoordinator {
  #activation: object | null = null;
  #activeConsumers = 0;
  #held: HeldWakeLock | null = null;
  #requestInFlight = false;
  #visibilityVersion = 0;
  #wakeLock: WakeLock | null = null;

  readonly #handleVisibilityChange = (): void => {
    if (document.visibilityState !== "visible") {
      this.#visibilityVersion += 1;
      return;
    }
    this.#request();
  };

  acquire(activation: object): () => void {
    if (!("wakeLock" in navigator)) {
      return () => undefined;
    }

    this.#activeConsumers += 1;
    if (this.#activeConsumers === 1) {
      this.#activation = activation;
      this.#wakeLock = navigator.wakeLock;
      document.addEventListener(
        "visibilitychange",
        this.#handleVisibilityChange,
      );
      this.#request();
    }

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.#activeConsumers -= 1;
      if (this.#activeConsumers === 0) {
        this.#deactivate();
      }
    };
  }

  #deactivate(): void {
    document.removeEventListener(
      "visibilitychange",
      this.#handleVisibilityChange,
    );
    this.#activation = null;
    this.#wakeLock = null;

    const held = this.#held;
    this.#held = null;
    if (held !== null) {
      held.sentinel.removeEventListener("release", held.onRelease);
      void releaseSilently(held.sentinel);
    }
  }

  #request(): void {
    const activation = this.#activation;
    const wakeLock = this.#wakeLock;
    if (
      activation === null ||
      wakeLock === null ||
      this.#activeConsumers === 0 ||
      document.visibilityState !== "visible" ||
      this.#held !== null ||
      this.#requestInFlight
    ) {
      return;
    }

    const visibilityVersion = this.#visibilityVersion;
    this.#requestInFlight = true;

    let request: Promise<WakeLockSentinel>;
    try {
      request = wakeLock.request("screen");
    } catch {
      this.#requestInFlight = false;
      return;
    }

    void request.then(
      (sentinel) => {
        this.#requestInFlight = false;
        if (
          this.#activeConsumers === 0 ||
          document.visibilityState !== "visible" ||
          activation !== this.#activation ||
          visibilityVersion !== this.#visibilityVersion
        ) {
          void releaseSilently(sentinel).then(() => {
            this.#request();
          });
          return;
        }
        this.#hold(sentinel);
      },
      () => {
        this.#requestInFlight = false;
        if (
          this.#activeConsumers > 0 &&
          document.visibilityState === "visible" &&
          (activation !== this.#activation ||
            visibilityVersion !== this.#visibilityVersion)
        ) {
          this.#request();
        }
      },
    );
  }

  #hold(sentinel: WakeLockSentinel): void {
    const onRelease = (): void => {
      sentinel.removeEventListener("release", onRelease);
      if (this.#held?.sentinel !== sentinel) {
        return;
      }
      this.#held = null;
      this.#request();
    };

    this.#held = { onRelease, sentinel };
    sentinel.addEventListener("release", onRelease);
    if (sentinel.released) {
      onRelease();
    }
  }
}

const screenWakeLock = new ScreenWakeLockCoordinator();

export function useScreenWakeLock(active: boolean): void {
  const activation = useRef<object>({});
  const wasActive = useRef(false);

  useEffect(() => {
    if (!active) {
      wasActive.current = false;
      return;
    }
    if (!wasActive.current) {
      activation.current = {};
      wasActive.current = true;
    }
    return screenWakeLock.acquire(activation.current);
  }, [active]);
}

async function releaseSilently(sentinel: WakeLockSentinel): Promise<void> {
  try {
    await sentinel.release();
  } catch {
    // Wake locks are advisory; release failures need no user-facing recovery.
  }
}
