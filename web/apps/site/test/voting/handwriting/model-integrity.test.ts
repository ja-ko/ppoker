import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import metadata from "../../../public/models/digits-crnn.json";
import { verifyModelBytes } from "../../../src/voting/handwriting/recognition/worker";

const model = await readFile(
  join(process.cwd(), "public/models/digits-crnn.onnx"),
);

describe("committed recognition model integrity", () => {
  it("accepts the artifact against its committed size and SHA-256", () => {
    expect(verifyModelBytes(model, metadata.model)).toHaveLength(
      metadata.model.bytes,
    );
  });

  it("rejects wrong byte lengths and changed bytes", () => {
    expect(() => verifyModelBytes(model.subarray(1), metadata.model)).toThrow(
      "model byte length",
    );

    const changed = Uint8Array.from(model);
    changed[0] = (changed[0] ?? 0) ^ 1;
    expect(() => verifyModelBytes(changed, metadata.model)).toThrow(
      "model SHA-256",
    );
  });
});
