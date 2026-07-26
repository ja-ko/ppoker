import { useEffect, useRef, useSyncExternalStore } from "react";

export type ScreenWakeLockStatus =
  | "held"
  | "inactive"
  | "needs-activation"
  | "requesting"
  | "unavailable"
  | "unsupported";

export interface ScreenWakeLockControl {
  readonly request: () => void;
  readonly status: ScreenWakeLockStatus;
}

interface HeldWakeLock {
  readonly onRelease: () => void;
  readonly sentinel: WakeLockSentinel;
}

class ScreenWakeLockCoordinator {
  #activation: object | null = null;
  #activeConsumers = 0;
  #held: HeldWakeLock | null = null;
  readonly #listeners = new Set<() => void>();
  #requestInFlight = false;
  #status: ScreenWakeLockStatus = "inactive";
  #userActivationArmed = false;
  #visibilityVersion = 0;
  #wakeLock: WakeLock | null = null;

  readonly getStatus = (): ScreenWakeLockStatus => this.#status;

  readonly requestFromUserActivation = (): void => {
    const userActivation = (
      navigator as unknown as { readonly userActivation?: UserActivation }
    ).userActivation;
    if (userActivation !== undefined && !userActivation.isActive) {
      return;
    }
    this.#disarmUserActivation();
    this.#request(true);
  };

  readonly #handlePointerUp = (event: Event): void => {
    const interactiveTarget =
      event.target instanceof Element
        ? event.target.closest(
            "a, button, input, select, textarea, [role='button'], [role='link']",
          )
        : null;
    if (interactiveTarget === null) {
      this.requestFromUserActivation();
    }
  };

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly #handleVisibilityChange = (): void => {
    if (document.visibilityState !== "visible") {
      this.#visibilityVersion += 1;
      this.#disarmUserActivation();
      this.#releaseHeld();
      this.#setStatus("inactive");
      return;
    }
    this.#request();
  };

  acquire(activation: object): () => void {
    this.#activeConsumers += 1;
    if (this.#activeConsumers === 1) {
      this.#activation = activation;
      if (!("wakeLock" in navigator)) {
        this.#setStatus("unsupported");
      } else {
        this.#wakeLock = navigator.wakeLock;
        document.addEventListener(
          "visibilitychange",
          this.#handleVisibilityChange,
        );
        this.#request();
      }
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
    this.#disarmUserActivation();
    this.#activation = null;
    this.#wakeLock = null;
    this.#releaseHeld();
    this.#setStatus("inactive");
  }

  #request(fromUserActivation = false): void {
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
    this.#disarmUserActivation();
    this.#requestInFlight = true;
    if (!fromUserActivation) {
      this.#setStatus("requesting");
    }

    let request: Promise<WakeLockSentinel>;
    try {
      request = wakeLock.request("screen");
    } catch {
      this.#requestInFlight = false;
      this.#handleRequestFailure(fromUserActivation);
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
        const activeAndVisible =
          this.#activeConsumers > 0 && document.visibilityState === "visible";
        if (
          activeAndVisible &&
          (activation !== this.#activation ||
            visibilityVersion !== this.#visibilityVersion)
        ) {
          this.#request();
        } else if (activeAndVisible) {
          this.#handleRequestFailure(fromUserActivation);
        }
      },
    );
  }

  #hold(sentinel: WakeLockSentinel): void {
    this.#disarmUserActivation();
    const onRelease = (): void => {
      sentinel.removeEventListener("release", onRelease);
      if (this.#held?.sentinel !== sentinel) {
        return;
      }
      this.#held = null;
      this.#request();
    };

    this.#held = { onRelease, sentinel };
    this.#setStatus("held");
    sentinel.addEventListener("release", onRelease);
    if (sentinel.released) {
      onRelease();
    }
  }

  #releaseHeld(): void {
    const held = this.#held;
    this.#held = null;
    if (held === null) {
      return;
    }
    held.sentinel.removeEventListener("release", held.onRelease);
    void releaseSilently(held.sentinel);
  }

  #armUserActivation(): void {
    if (
      this.#userActivationArmed ||
      this.#activeConsumers === 0 ||
      document.visibilityState !== "visible" ||
      this.#held !== null ||
      this.#requestInFlight
    ) {
      return;
    }
    this.#userActivationArmed = true;
    document.addEventListener("click", this.requestFromUserActivation, true);
    document.addEventListener("keydown", this.requestFromUserActivation, true);
    document.addEventListener("pointerup", this.#handlePointerUp, true);
  }

  #disarmUserActivation(): void {
    if (!this.#userActivationArmed) {
      return;
    }
    this.#userActivationArmed = false;
    document.removeEventListener("click", this.requestFromUserActivation, true);
    document.removeEventListener(
      "keydown",
      this.requestFromUserActivation,
      true,
    );
    document.removeEventListener("pointerup", this.#handlePointerUp, true);
  }

  #handleRequestFailure(fromUserActivation: boolean): void {
    if (fromUserActivation) {
      this.#setStatus("unavailable");
      return;
    }
    this.#setStatus("needs-activation");
    this.#armUserActivation();
  }

  #setStatus(status: ScreenWakeLockStatus): void {
    if (this.#status === status) {
      return;
    }
    this.#status = status;
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

const screenWakeLock = new ScreenWakeLockCoordinator();

export function useScreenWakeLock(active: boolean): ScreenWakeLockControl {
  const activation = useRef<object>({});
  const wasActive = useRef(false);
  const status = useSyncExternalStore(
    screenWakeLock.subscribe,
    screenWakeLock.getStatus,
    screenWakeLock.getStatus,
  );

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

  return { request: screenWakeLock.requestFromUserActivation, status };
}

async function releaseSilently(sentinel: WakeLockSentinel): Promise<void> {
  try {
    await sentinel.release();
  } catch {
    // Wake locks are advisory; release failures need no user-facing recovery.
  }
}
