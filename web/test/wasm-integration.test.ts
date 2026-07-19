// @vitest-environment node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  WasmPokerClient,
  initializePpokerWasm,
  type ClientOptions,
} from "../src/index.js";

function captureError(operation: () => void): unknown {
  try {
    operation();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("operation did not throw");
}

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
    await initializePpokerWasm(
      new DataView(paddedWasm.buffer, offset, wasmBytes.byteLength),
    );

    const invalidOptions: ClientOptions = {
      endpoint: "https://example.test",
      room: "invalid",
      name: "Invalid",
      role: "participant",
    };
    const invalid = captureError(() => {
      new WasmPokerClient(invalidOptions);
    });
    expect(invalid).toBeInstanceOf(Error);
    expect(invalid).toMatchObject({
      code: "InvalidOptions",
      details: {
        field: "endpoint",
      },
    });

    for (const role of ["participant", "spectator"] as const) {
      const client = new WasmPokerClient({
        endpoint: "wss://example.test/base",
        room: `typed ${role}`,
        name: role,
        role,
      });
      expect(client.snapshot()).toEqual({
        revision: 0,
        status: "disconnected",
        terminalError: null,
        room: null,
        localName: role,
        localVote: null,
        log: [],
        roundNumber: 0,
        roundStartedAtMs: null,
        history: [],
        average: null,
      });

      const notReady = captureError(() => {
        client.vote("5");
      });
      expect(notReady).toBeInstanceOf(Error);
      expect(notReady).toMatchObject({ code: "NotReady" });
      client.close();
      expect(client.snapshot()).toMatchObject({
        revision: 1,
        status: "closed",
      });
      expect(client.poll()).toBe(false);
      expect(
        captureError(() => {
          client.chat("closed");
        }),
      ).toMatchObject({
        code: "Closed",
      });
    }

    expect(fetch).not.toHaveBeenCalled();
    expect(WebSocket).not.toHaveBeenCalled();
  });
});
