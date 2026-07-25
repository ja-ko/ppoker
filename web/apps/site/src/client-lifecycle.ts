import {
  createPokerClient,
  type ClientOptions,
  type PokerClient,
} from "@ppoker/web-client";

export interface ClientStartResult {
  readonly client: PokerClient;
  readonly connectError: unknown;
}

export interface PokerClientLifecycle {
  close(): void;
  start(): Promise<ClientStartResult>;
}

export type PokerClientFactory = (
  options: ClientOptions,
) => Promise<PokerClient>;

export function createClientLifecycle(
  options: ClientOptions,
  factory: PokerClientFactory = createPokerClient,
): PokerClientLifecycle {
  let client: PokerClient | undefined;
  let closed = false;
  let startPromise: Promise<ClientStartResult> | undefined;

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    client?.close();
  };

  const start = (): Promise<ClientStartResult> => {
    startPromise ??= factory(options).then((createdClient) => {
      client = createdClient;
      if (closed) {
        createdClient.close();
        throw new Error("Poker client lifecycle closed during initialization.");
      }

      let connectError: unknown = null;
      try {
        createdClient.connect();
      } catch (error: unknown) {
        connectError = error;
      }
      return { client: createdClient, connectError };
    });
    return startPromise;
  };

  return { close, start };
}

export function bindPageLifecycle(
  lifecycle: PokerClientLifecycle,
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  reload: () => void,
): () => void {
  const pagehide = (event: Event): void => {
    if (isPersistedPageTransition(event)) {
      return;
    }
    try {
      lifecycle.close();
    } catch {
      // Page teardown cannot recover from close errors.
    }
  };
  const pageshow = (event: Event): void => {
    if (isPersistedPageTransition(event)) {
      reload();
    }
  };
  target.addEventListener("pagehide", pagehide);
  target.addEventListener("pageshow", pageshow);
  return () => {
    target.removeEventListener("pagehide", pagehide);
    target.removeEventListener("pageshow", pageshow);
  };
}

function isPersistedPageTransition(
  event: Event,
): event is Event & { readonly persisted: boolean } {
  return "persisted" in event && event.persisted === true;
}
