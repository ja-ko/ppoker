import type { ClientOptions } from "@ppoker/web-client";

export const BILLBOARD_SPECTATOR_NAME = "Planning Poker Billboard";
export const BILLBOARD_TITLE_PLACEHOLDER = "Planning Poker Room";

export interface BroadcastConfig {
  readonly endpoint: string;
  readonly room: string;
}

export type VotingConfig = BroadcastConfig;

export type ConfigErrorCode =
  "invalid-endpoint" | "invalid-room" | "missing-endpoint" | "missing-room";

export interface ConfigError {
  readonly code: ConfigErrorCode;
  readonly message: string;
}

export type ConfigResult =
  | { readonly config: BroadcastConfig; readonly ok: true }
  | { readonly error: ConfigError; readonly ok: false };

export function spectatorClientOptions(config: BroadcastConfig): ClientOptions {
  return {
    endpoint: config.endpoint,
    name: BILLBOARD_SPECTATOR_NAME,
    role: "spectator",
    room: config.room,
  };
}

export function participantClientOptions(
  config: VotingConfig,
  name: string,
): ClientOptions {
  return {
    endpoint: config.endpoint,
    name,
    role: "participant",
    room: config.room,
  };
}

export function parseVotingConfig(
  endpointValue: string | undefined,
  search: string,
): ConfigResult {
  const result = parseBroadcastConfig(endpointValue, search);
  if (!result.ok && result.error.code === "missing-room") {
    return {
      error: {
        ...result.error,
        message: "Add ?room=<room name> to this voter URL.",
      },
      ok: false,
    };
  }
  return result;
}

export function parseBroadcastConfig(
  endpointValue: string | undefined,
  search: string,
): ConfigResult {
  const room = new URLSearchParams(search).get("room")?.trim() ?? "";
  if (room.length === 0) {
    return {
      error: {
        code: "missing-room",
        message: "Add ?room=<room name> to this scoreboard URL.",
      },
      ok: false,
    };
  }
  if (room === "." || room === "..") {
    return {
      error: {
        code: "invalid-room",
        message: "Room must not be `.` or `..`.",
      },
      ok: false,
    };
  }

  const endpoint = endpointValue?.trim() ?? "";
  if (endpoint.length === 0) {
    return {
      error: {
        code: "missing-endpoint",
        message: "VITE_PPOKER_ENDPOINT was not configured for this build.",
      },
      ok: false,
    };
  }

  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    return invalidEndpoint();
  }
  const authority = endpoint.split("://", 2)[1]?.split(/[/?#]/u, 1)[0] ?? "";
  if (
    (parsedEndpoint.protocol !== "ws:" && parsedEndpoint.protocol !== "wss:") ||
    parsedEndpoint.hostname.length === 0 ||
    authority.includes("@") ||
    parsedEndpoint.username.length > 0 ||
    parsedEndpoint.password.length > 0 ||
    endpoint.includes("?") ||
    endpoint.includes("#") ||
    parsedEndpoint.search.length > 0 ||
    parsedEndpoint.hash.length > 0
  ) {
    return invalidEndpoint();
  }

  return {
    config: { endpoint: parsedEndpoint.toString(), room },
    ok: true,
  };
}

function invalidEndpoint(): ConfigResult {
  return {
    error: {
      code: "invalid-endpoint",
      message: "VITE_PPOKER_ENDPOINT must be a valid ws:// or wss:// URL.",
    },
    ok: false,
  };
}
