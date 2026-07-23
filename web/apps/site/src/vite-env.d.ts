/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PPOKER_ENDPOINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
