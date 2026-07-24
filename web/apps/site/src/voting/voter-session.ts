export const VOTER_NAME_STORAGE_KEY = "ppoker.voter-name";

const FRIENDLY_ADJECTIVES = [
  "Bright",
  "Calm",
  "Clever",
  "Curious",
  "Daring",
  "Gentle",
  "Jolly",
  "Kind",
  "Lively",
  "Lucky",
  "Merry",
  "Nimble",
  "Patient",
  "Quiet",
  "Ready",
  "Sunny",
  "Swift",
  "Thoughtful",
] as const;

const FRIENDLY_NOUNS = [
  "Badger",
  "Dolphin",
  "Falcon",
  "Fox",
  "Gecko",
  "Heron",
  "Koala",
  "Lark",
  "Otter",
  "Owl",
  "Panda",
  "Penguin",
  "Robin",
  "Seal",
  "Sparrow",
  "Tiger",
  "Turtle",
  "Wombat",
] as const;

export interface VoterNameStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

export type VoterNameValidation =
  | { readonly name: string; readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "control-character" | "empty";
    };

export type RenameVoterResult =
  | { readonly ok: false; readonly reason: "control-character" | "empty" }
  | { readonly name: string; readonly ok: true; readonly persisted: boolean };

export interface VoterNameSession {
  load(): string;
  rename(input: string, submit: (name: string) => void): RenameVoterResult;
}

export interface VoterNameSessionOptions {
  readonly generateName?: () => string;
  readonly storage?: VoterNameStorage | null;
  readonly storageKey?: string;
}

export function validateVoterName(input: string): VoterNameValidation {
  const name = input.trim();
  if (name.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (/\p{Cc}/u.test(name)) {
    return { ok: false, reason: "control-character" };
  }
  return { name, ok: true };
}

export function generateFriendlyVoterName(
  randomUint32: () => number = secureRandomUint32,
): string {
  const adjective =
    FRIENDLY_ADJECTIVES[randomIndex(FRIENDLY_ADJECTIVES.length, randomUint32)];
  const noun = FRIENDLY_NOUNS[randomIndex(FRIENDLY_NOUNS.length, randomUint32)];
  if (adjective === undefined || noun === undefined) {
    throw new Error("Friendly voter name lists must not be empty.");
  }
  return `${adjective} ${noun}`;
}

export function readPersistedVoterName(
  storage: VoterNameStorage | null = globalVoterNameStorage(),
  storageKey = VOTER_NAME_STORAGE_KEY,
): string | null {
  if (storage === null) {
    return null;
  }
  try {
    const stored = storage.getItem(storageKey);
    if (stored === null) {
      return null;
    }
    const validation = validateVoterName(stored);
    return validation.ok ? validation.name : null;
  } catch {
    return null;
  }
}

export function persistVoterName(
  name: string,
  storage: VoterNameStorage | null = globalVoterNameStorage(),
  storageKey = VOTER_NAME_STORAGE_KEY,
): boolean {
  const validation = validateVoterName(name);
  if (!validation.ok || storage === null) {
    return false;
  }
  try {
    storage.setItem(storageKey, validation.name);
    return true;
  } catch {
    return false;
  }
}

export function renameAndPersistVoterName(
  input: string,
  submit: (name: string) => void,
  storage: VoterNameStorage | null = globalVoterNameStorage(),
  storageKey = VOTER_NAME_STORAGE_KEY,
): RenameVoterResult {
  const validation = validateVoterName(input);
  if (!validation.ok) {
    return validation;
  }
  submit(validation.name);
  return {
    name: validation.name,
    ok: true,
    persisted: persistVoterName(validation.name, storage, storageKey),
  };
}

export function createVoterNameSession(
  options: VoterNameSessionOptions = {},
): VoterNameSession {
  const storage =
    options.storage === undefined ? globalVoterNameStorage() : options.storage;
  const storageKey = options.storageKey ?? VOTER_NAME_STORAGE_KEY;
  const generateName = options.generateName ?? generateFriendlyVoterName;
  let currentName: string | undefined;

  return {
    load(): string {
      if (currentName !== undefined) {
        return currentName;
      }
      const stored = readPersistedVoterName(storage, storageKey);
      if (stored !== null) {
        currentName = stored;
        return stored;
      }

      const generated = validateVoterName(generateName());
      if (!generated.ok) {
        throw new Error("The generated voter name is invalid.");
      }
      currentName = generated.name;
      persistVoterName(currentName, storage, storageKey);
      return currentName;
    },
    rename(input, submit): RenameVoterResult {
      const result = renameAndPersistVoterName(
        input,
        submit,
        storage,
        storageKey,
      );
      if (result.ok) {
        currentName = result.name;
      }
      return result;
    },
  };
}

function globalVoterNameStorage(): VoterNameStorage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function secureRandomUint32(): number {
  try {
    const values = new Uint32Array(1);
    globalThis.crypto.getRandomValues(values);
    return values[0] ?? 0;
  } catch {
    return Math.floor(Math.random() * 0x1_0000_0000);
  }
}

function randomIndex(length: number, randomUint32: () => number): number {
  return Math.abs(Math.trunc(randomUint32())) % length;
}
