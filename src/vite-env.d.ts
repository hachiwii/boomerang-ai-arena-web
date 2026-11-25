/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ICP_NUMBER?: string;
  readonly VITE_PVP_ENABLED?: string;
  readonly VITE_PVP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __BUILD_ID__: string;
