#!/usr/bin/env bash

set -Eeuo pipefail

container_engine="${CONTAINER_ENGINE:-docker}"
container_command=("${container_engine}")
image="${IMAGE:-ppoker-site:smoke}"
container="ppoker-site-smoke-$$"
endpoint="${SMOKE_ENDPOINT:-wss://container-smoke.example.invalid}"
prebuilt="${SMOKE_PREBUILT:-0}"
temporary_directory="$(mktemp -d)"

cleanup() {
  "${container_command[@]}" rm --force "${container}" >/dev/null 2>&1 || true
  rm -rf "${temporary_directory}"
}
trap cleanup EXIT INT TERM

fail() {
  printf 'container smoke test failed: %s\n' "$1" >&2
  exit 1
}

if [[ ! -f Cargo.toml || ! -f web/apps/site/Dockerfile ]]; then
  fail "run this script from the repository root"
fi
if ! command -v "${container_engine}" >/dev/null 2>&1; then
  fail "container engine not found: ${container_engine}"
fi
if [[ "${prebuilt}" != 0 && "${prebuilt}" != 1 ]]; then
  fail "SMOKE_PREBUILT must be 0 or 1"
fi

podman=false
if "${container_command[@]}" --version | grep -qi podman; then
  podman=true
  container_command[${#container_command[@]}]="--cgroup-manager=cgroupfs"
fi

container_build() {
  if [[ "${podman}" == true ]]; then
    "${container_command[@]}" build --format docker "$@"
  else
    "${container_command[@]}" build "$@"
  fi
}

container_run() {
  if [[ "${podman}" == true ]]; then
    "${container_command[@]}" run --no-healthcheck "$@"
  else
    "${container_command[@]}" run "$@"
  fi
}

expect_invalid_endpoint() {
  local label="$1"
  local argument_mode="$2"
  local value="$3"
  local expected_error="$4"
  local sensitive_marker="${5:-}"
  local log="${temporary_directory}/invalid-${label}.log"

  if [[ "${argument_mode}" == omit ]]; then
    if container_build \
      --file web/apps/site/Dockerfile \
      --target endpoint-validation \
      . >"${log}" 2>&1; then
      fail "${label} endpoint build unexpectedly succeeded"
    fi
  else
    if container_build \
      --file web/apps/site/Dockerfile \
      --target endpoint-validation \
      --build-arg "VITE_PPOKER_ENDPOINT=${value}" \
      . >"${log}" 2>&1; then
      fail "${label} endpoint build unexpectedly succeeded"
    fi
  fi

  if ! grep -Fq "ERROR: ${expected_error}" "${log}"; then
    cat "${log}" >&2
    fail "${label} endpoint build did not produce the expected error"
  fi
  if [[ -n "${sensitive_marker}" ]] && grep -Fq "${sensitive_marker}" "${log}"; then
    fail "${label} endpoint credentials leaked into build output"
  fi
}

required_error="VITE_PPOKER_ENDPOINT is required and must not be empty"
invalid_error="VITE_PPOKER_ENDPOINT must be a valid ws:// or wss:// URL without credentials, query parameters, or fragments"
expect_invalid_endpoint missing omit "" "${required_error}"
expect_invalid_endpoint empty set "" "${required_error}"
expect_invalid_endpoint scheme set "https://example.invalid" "${invalid_error}"
expect_invalid_endpoint hostname set "wss://" "${invalid_error}"
expect_invalid_endpoint credentials set "wss://user:placeholder@example.invalid" "${invalid_error}" "user:placeholder"
expect_invalid_endpoint bare-at set "wss://@example.invalid" "${invalid_error}"
expect_invalid_endpoint query set "wss://example.invalid?room=planning" "${invalid_error}"
expect_invalid_endpoint fragment set "wss://example.invalid#planning" "${invalid_error}"

if [[ "${prebuilt}" == 0 ]]; then
  container_build \
    --file web/apps/site/Dockerfile \
    --build-arg "VITE_PPOKER_ENDPOINT=${endpoint}" \
    --tag "${image}" \
    .
elif ! "${container_command[@]}" image inspect "${image}" >/dev/null 2>&1; then
  fail "prebuilt image not found: ${image}"
fi

container_run --rm "${image}" nginx -t

healthcheck="$("${container_command[@]}" image inspect --format '{{json .Config.Healthcheck}}' "${image}")"
if [[ "${healthcheck}" != *wget* || "${healthcheck}" != *127.0.0.1:8080/healthz* ]]; then
  fail "image does not contain the expected healthcheck command"
fi
exposed_ports="$("${container_command[@]}" image inspect --format '{{json .Config.ExposedPorts}}' "${image}")"
[[ "${exposed_ports}" == *'8080/tcp'* ]] || fail "image does not expose port 8080"
configured_user="$("${container_command[@]}" image inspect --format '{{.Config.User}}' "${image}")"
case "${configured_user}" in
  "" | 0 | 0:* | root | root:*)
    fail "image is configured to run as root"
    ;;
esac

container_run \
  --detach \
  --name "${container}" \
  --publish 127.0.0.1::8080 \
  "${image}" >/dev/null

published_address="$("${container_command[@]}" port "${container}" 8080/tcp)"
published_port="${published_address##*:}"
base_url="http://127.0.0.1:${published_port}"

ready=false
for _ in {1..30}; do
  if curl --fail --silent --show-error "${base_url}/healthz" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "${ready}" != true ]]; then
  "${container_command[@]}" logs "${container}" >&2
  fail "nginx did not become ready"
fi

runtime_uid="$("${container_command[@]}" exec "${container}" id -u)"
[[ "${runtime_uid}" != 0 ]] || fail "nginx is running as root"
"${container_command[@]}" exec "${container}" wget -q -O /dev/null http://127.0.0.1:8080/healthz

fetch() {
  local path="$1"
  local name="$2"
  curl --silent --show-error \
    --dump-header "${temporary_directory}/${name}.headers" \
    --output "${temporary_directory}/${name}.body" \
    --write-out '%{http_code}' \
    "${base_url}${path}"
}

require_no_cache() {
  local headers="$1"
  grep -Eiq '^cache-control: .*no-cache' "${headers}" || fail "app shell response is missing no-cache headers"
}

root_status="$(fetch / root)"
[[ "${root_status}" == 200 ]] || fail "/ returned HTTP ${root_status}"
grep -Fq '<div id="root"></div>' "${temporary_directory}/root.body" || fail "/ did not return the app shell"
require_no_cache "${temporary_directory}/root.headers"

room_status="$(fetch '/room?room=planning' room)"
[[ "${room_status}" == 200 ]] || fail "/room?room=planning returned HTTP ${room_status}"
cmp -s "${temporary_directory}/root.body" "${temporary_directory}/room.body" || fail "direct room route did not return the app shell"
require_no_cache "${temporary_directory}/room.headers"

fallback_status="$(fetch /container-smoke-fallback fallback)"
[[ "${fallback_status}" == 200 ]] || fail "SPA fallback returned HTTP ${fallback_status}"
cmp -s "${temporary_directory}/root.body" "${temporary_directory}/fallback.body" || fail "SPA fallback content differs from index.html"
require_no_cache "${temporary_directory}/fallback.headers"

assets=()
while IFS= read -r asset; do
  assets[${#assets[@]}]="${asset}"
done < <(grep -oE '(src|href)="(/assets/[^"]+)"' "${temporary_directory}/root.body" | cut -d'"' -f2)
(( ${#assets[@]} >= 2 )) || fail "app shell did not reference the expected static assets"

endpoint_found=false
asset_number=0
for asset in "${assets[@]}"; do
  asset_number=$((asset_number + 1))
  asset_status="$(fetch "${asset}" "asset-${asset_number}")"
  [[ "${asset_status}" == 200 ]] || fail "${asset} returned HTTP ${asset_status}"
  grep -Eiq '^cache-control: public, max-age=31536000, immutable' "${temporary_directory}/asset-${asset_number}.headers" || fail "${asset} is missing immutable cache headers"

  case "${asset}" in
    *.css)
      grep -Eiq '^content-type: text/css' "${temporary_directory}/asset-${asset_number}.headers" || fail "${asset} has the wrong MIME type"
      ;;
    *.js)
      grep -Eiq '^content-type: (application|text)/javascript' "${temporary_directory}/asset-${asset_number}.headers" || fail "${asset} has the wrong MIME type"
      if grep -Fq "${endpoint}" "${temporary_directory}/asset-${asset_number}.body"; then
        endpoint_found=true
      fi
      ;;
  esac
done
[[ "${endpoint_found}" == true ]] || fail "VITE_PPOKER_ENDPOINT was not embedded in the JavaScript bundle"

wasm_file="$("${container_command[@]}" exec "${container}" sh -c 'set -- /usr/share/nginx/html/assets/*.wasm; test -f "$1" && basename "$1"')"
[[ -n "${wasm_file}" ]] || fail "built image does not contain a WASM asset"
wasm_status="$(fetch "/assets/${wasm_file}" wasm)"
[[ "${wasm_status}" == 200 ]] || fail "WASM asset returned HTTP ${wasm_status}"
grep -Eiq '^content-type: application/wasm' "${temporary_directory}/wasm.headers" || fail "WASM asset has the wrong MIME type"
grep -Eiq '^cache-control: public, max-age=31536000, immutable' "${temporary_directory}/wasm.headers" || fail "WASM asset is missing immutable cache headers"

mime_directory="${temporary_directory}/mime"
mkdir -p "${mime_directory}"
mime_files=(probe.mjs probe.map probe.webmanifest probe.otf probe.ttf probe.woff2 probe.txt)
mime_types=(application/javascript application/json application/manifest+json font/otf font/ttf font/woff2 text/plain)
for mime_file in "${mime_files[@]}"; do
  printf 'container MIME probe\n' >"${mime_directory}/${mime_file}"
done
"${container_command[@]}" cp "${mime_directory}/." "${container}:/usr/share/nginx/html/assets/"

mime_index=0
for mime_file in "${mime_files[@]}"; do
  mime_status="$(fetch "/assets/${mime_file}" "mime-${mime_index}")"
  [[ "${mime_status}" == 200 ]] || fail "MIME probe ${mime_file} returned HTTP ${mime_status}"
  grep -Fiq "content-type: ${mime_types[${mime_index}]}" "${temporary_directory}/mime-${mime_index}.headers" || fail "${mime_file} has the wrong MIME type"
  grep -Eiq '^cache-control: public, max-age=31536000, immutable' "${temporary_directory}/mime-${mime_index}.headers" || fail "${mime_file} is missing immutable cache headers"
  mime_index=$((mime_index + 1))
done

missing_assets=(
  /assets/container-smoke-missing.js
  /container-smoke-missing.txt
  /container-smoke-missing.mjs
  /container-smoke-missing.map
  /container-smoke-missing.webmanifest
  /container-smoke-missing.woff2
)
missing_index=0
for missing_asset in "${missing_assets[@]}"; do
  missing_status="$(fetch "${missing_asset}" "missing-${missing_index}")"
  [[ "${missing_status}" == 404 ]] || fail "${missing_asset} returned HTTP ${missing_status} instead of 404"
  if grep -Eiq '^cache-control:.*(public|immutable|max-age=[1-9])' "${temporary_directory}/missing-${missing_index}.headers"; then
    fail "${missing_asset} has a long-lived public cache directive"
  fi
  if cmp -s "${temporary_directory}/root.body" "${temporary_directory}/missing-${missing_index}.body"; then
    fail "${missing_asset} silently returned the SPA shell"
  fi
  missing_index=$((missing_index + 1))
done

printf 'Container smoke test passed for %s (prebuilt=%s, uid=%s)\n' "${image}" "${prebuilt}" "${runtime_uid}"
