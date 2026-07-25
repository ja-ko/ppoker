const endpoint = process.env.VITE_PPOKER_ENDPOINT?.trim() ?? "";

if (endpoint.length === 0) {
  fail("VITE_PPOKER_ENDPOINT is required and must not be empty");
}

let parsedEndpoint;
try {
  parsedEndpoint = new URL(endpoint);
} catch {
  failInvalid();
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
  failInvalid();
}

function failInvalid() {
  fail(
    "VITE_PPOKER_ENDPOINT must be a valid ws:// or wss:// URL without credentials, query parameters, or fragments",
  );
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}
