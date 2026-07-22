// @vitest-environment node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPokerClient, type ClientOptions } from "../src/index.js";
import { captureError } from "./fake-client.js";

describe("generated WASM integration", () => {
  it("validates options in Rust and constructs both roles without network", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const WebSocket = vi.fn();
    class TestWindow {
      readonly performance = globalThis.performance;
    }
    vi.stubGlobal("WebSocket", WebSocket);
    vi.stubGlobal("Window", TestWindow);
    vi.stubGlobal("window", new TestWindow());
    const wasmBytes = Uint8Array.from(
      await readFile(
        join(process.cwd(), "src/generated/ppoker-wasm/ppoker_wasm_bg.wasm"),
      ),
    );
    const offset = 11;
    const paddedWasm = new Uint8Array(wasmBytes.byteLength + offset + 7);
    paddedWasm.set(wasmBytes, offset);
    const wasm = new DataView(paddedWasm.buffer, offset, wasmBytes.byteLength);

    const invalidOptions: ClientOptions = {
      endpoint: "https://example.test",
      room: "invalid",
      name: "Invalid",
      role: "participant",
    };
    const invalid = await createPokerClient(invalidOptions, { wasm }).catch(
      (error: unknown) => error,
    );
    expect(invalid).toBeInstanceOf(Error);
    expect(invalid).toMatchObject({
      code: "InvalidOptions",
      details: {
        field: "endpoint",
      },
    });

    for (const role of ["participant", "spectator"] as const) {
      const client = await createPokerClient({
        endpoint: "wss://example.test/base",
        room: `typed ${role}`,
        name: role,
        role,
      });
      expect(client.getSnapshot()).toEqual({
        revision: 0,
        status: "disconnected",
        terminalError: null,
        room: null,
        localName: role,
        localVote: null,
        log: [],
        roundNumber: 0,
        history: [],
        average: null,
      });

      const notReady = captureError(client.vote.bind(client, "5"));
      expect(notReady).toBeInstanceOf(Error);
      expect(notReady).toMatchObject({ code: "NotReady" });
      client.close();
      expect(client.getSnapshot()).toMatchObject({
        revision: 1,
        status: "closed",
      });
      expect(client.poll()).toBe(false);
      expect(captureError(client.chat.bind(client, "closed"))).toMatchObject({
        code: "Closed",
      });
    }

    expect(fetch).not.toHaveBeenCalled();
    expect(WebSocket).not.toHaveBeenCalled();
  });
});
