import { describe, expect, it, vi } from "vitest";

import { parseBroadcastConfig, spectatorClientOptions } from "../src/config";

describe("broadcast configuration", () => {
  it("accepts a static websocket endpoint and decoded room query", () => {
    expect(
      parseBroadcastConfig(
        " wss://example.test/socket ",
        "?room=Checkout%20Redesign",
      ),
    ).toEqual({
      config: {
        endpoint: "wss://example.test/socket",
        room: "Checkout Redesign",
      },
      ok: true,
    });
  });

  it("creates spectator-only billboard options with a fresh random name", () => {
    const randomValues = [0, 0, 1, 1];
    vi.stubGlobal("crypto", {
      getRandomValues: (values: Uint32Array) => {
        values[0] = randomValues.shift() ?? 0;
        return values;
      },
    });
    const localStorage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
    };
    vi.stubGlobal("localStorage", localStorage);
    const config = {
      endpoint: "wss://example.test/",
      room: "planning",
    };

    expect(spectatorClientOptions(config)).toEqual({
      endpoint: "wss://example.test/",
      name: "Bright Badger",
      role: "spectator",
      room: "planning",
    });
    expect(spectatorClientOptions(config).name).toBe("Calm Dolphin");
    expect(localStorage.getItem).not.toHaveBeenCalled();
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });

  it.each(["", "?room=", "?other=room"])(
    "rejects a missing room in %s",
    (search) => {
      const result = parseBroadcastConfig("wss://example.test", search);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("missing-room");
      }
    },
  );

  it("rejects a missing compile-time endpoint", () => {
    const result = parseBroadcastConfig(undefined, "?room=planning");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("missing-endpoint");
    }
  });

  it.each([".", ".."])('rejects exact dot room "%s"', (room) => {
    const result = parseBroadcastConfig(
      "wss://example.test",
      `?room=${encodeURIComponent(room)}`,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid-room");
    }
  });

  it.each([".planning", "planning.", "..."])(
    'accepts embedded dot room "%s"',
    (room) => {
      expect(
        parseBroadcastConfig("wss://example.test", `?room=${room}`),
      ).toMatchObject({
        config: { room },
        ok: true,
      });
    },
  );

  it.each([
    "https://example.test",
    "not a URL",
    "wss://user@example.test",
    "wss://@example.test",
    "wss://example.test?query=1",
    "wss://example.test?",
    "wss://example.test#",
    "wss://example.test/#fragment",
  ])("rejects invalid endpoint %s", (endpoint) => {
    const result = parseBroadcastConfig(endpoint, "?room=planning");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid-endpoint");
    }
  });
});
