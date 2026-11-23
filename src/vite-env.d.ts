/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ICP_NUMBER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __BUILD_ID__: string;
