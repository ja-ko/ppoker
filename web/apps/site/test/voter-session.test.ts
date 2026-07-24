import { describe, expect, it, vi } from "vitest";

import {
  VOTER_NAME_STORAGE_KEY,
  createVoterNameSession,
  generateFriendlyVoterName,
  persistVoterName,
  readPersistedVoterName,
  renameAndPersistVoterName,
  validateVoterName,
  type VoterNameStorage,
} from "../src/voting/voter-session";

describe("friendly voter names", () => {
  it("selects an adjective and noun from injected random values", () => {
    const values = [0, 0];
    expect(generateFriendlyVoterName(() => values.shift() ?? 0)).toBe(
      "Bright Badger",
    );
  });

  it("uses crypto random values when available", () => {
    const getRandomValues = vi.fn((values: Uint32Array) => {
      values[0] = 0;
      return values;
    });
    vi.stubGlobal("crypto", { getRandomValues });

    expect(generateFriendlyVoterName()).toBe("Bright Badger");
    expect(getRandomValues).toHaveBeenCalledTimes(2);
  });

  it("falls back when crypto access fails", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: () => {
        throw new Error("crypto unavailable");
      },
    });
    vi.spyOn(Math, "random").mockReturnValue(0);

    expect(generateFriendlyVoterName()).toBe("Bright Badger");
  });
});

describe("voter-name validation", () => {
  it("trims valid names and rejects empty or embedded control characters", () => {
    expect(validateVoterName("  Ada Lovelace  ")).toEqual({
      name: "Ada Lovelace",
      ok: true,
    });
    expect(validateVoterName(" \t\n ")).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(validateVoterName("Ada\nLovelace")).toEqual({
      ok: false,
      reason: "control-character",
    });
    expect(validateVoterName("Ada\u007fLovelace")).toEqual({
      ok: false,
      reason: "control-character",
    });
  });
});

describe("voter-name persistence", () => {
  it("loads a valid persisted name without generating a replacement", () => {
    const storage = memoryStorage([[VOTER_NAME_STORAGE_KEY, "  Saved Otter "]]);
    const generateName = vi.fn(() => "Generated Owl");
    const session = createVoterNameSession({ generateName, storage });

    expect(session.load()).toBe("Saved Otter");
    expect(session.load()).toBe("Saved Otter");
    expect(generateName).not.toHaveBeenCalled();
  });

  it("generates and globally persists a name for later sessions", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);

    const first = createVoterNameSession({
      generateName: () => "Sunny Lark",
    });
    expect(first.load()).toBe("Sunny Lark");
    expect(storage.setItem).toHaveBeenCalledWith(
      VOTER_NAME_STORAGE_KEY,
      "Sunny Lark",
    );

    const second = createVoterNameSession({
      generateName: () => "Unused Name",
    });
    expect(second.load()).toBe("Sunny Lark");
  });

  it("falls back to a stable in-session name when storage throws", () => {
    const storage: VoterNameStorage = {
      getItem: vi.fn(() => {
        throw new Error("read denied");
      }),
      setItem: vi.fn(() => {
        throw new Error("write denied");
      }),
    };
    const generateName = vi.fn(() => "Calm Heron");
    const session = createVoterNameSession({ generateName, storage });

    expect(session.load()).toBe("Calm Heron");
    expect(session.load()).toBe("Calm Heron");
    expect(generateName).toHaveBeenCalledOnce();
    expect(readPersistedVoterName(storage)).toBeNull();
    expect(persistVoterName("Calm Heron", storage)).toBe(false);
  });

  it("submits the trimmed rename before persisting it", () => {
    const storage = memoryStorage();
    const events: string[] = [];
    storage.setItem.mockImplementation((key, value) => {
      events.push(`store:${key}:${value}`);
    });

    expect(
      renameAndPersistVoterName(
        "  Ready Robin ",
        (name) => events.push(`rename:${name}`),
        storage,
      ),
    ).toEqual({ name: "Ready Robin", ok: true, persisted: true });
    expect(events).toEqual([
      "rename:Ready Robin",
      `store:${VOTER_NAME_STORAGE_KEY}:Ready Robin`,
    ]);
  });

  it("does not submit or persist an invalid rename", () => {
    const storage = memoryStorage();
    const submit = vi.fn();
    expect(renameAndPersistVoterName("Bad\nName", submit, storage)).toEqual({
      ok: false,
      reason: "control-character",
    });
    expect(submit).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("does not persist when the rename command fails", () => {
    const storage = memoryStorage();
    const failure = new Error("rename rejected");
    expect(() =>
      renameAndPersistVoterName(
        "Clever Fox",
        () => {
          throw failure;
        },
        storage,
      ),
    ).toThrow(failure);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("keeps a successful rename in session memory when persistence fails", () => {
    const storage: VoterNameStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new Error("quota exceeded");
      }),
    };
    const session = createVoterNameSession({
      generateName: () => "Initial Owl",
      storage,
    });
    expect(session.rename("  Kind Koala ", vi.fn())).toEqual({
      name: "Kind Koala",
      ok: true,
      persisted: false,
    });
    expect(session.load()).toBe("Kind Koala");
  });
});

function memoryStorage(initial: readonly (readonly [string, string])[] = []) {
  const values = new Map(initial);
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  } satisfies VoterNameStorage;
}
