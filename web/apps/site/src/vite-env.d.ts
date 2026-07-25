/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PPOKER_ENDPOINT?: string;
  readonly VITE_PPOKER_ROUTER_MODE?: "browser" | "hash";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
