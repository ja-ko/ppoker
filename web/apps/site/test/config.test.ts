import { describe, expect, it } from "vitest";

import {
  BILLBOARD_SPECTATOR_NAME,
  parseBroadcastConfig,
  spectatorClientOptions,
} from "../src/config";

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

  it("always creates spectator-only billboard client options", () => {
    expect(
      spectatorClientOptions({
        endpoint: "wss://example.test/",
        room: "planning",
      }),
    ).toEqual({
      endpoint: "wss://example.test/",
      name: BILLBOARD_SPECTATOR_NAME,
      role: "spectator",
      room: "planning",
    });
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
