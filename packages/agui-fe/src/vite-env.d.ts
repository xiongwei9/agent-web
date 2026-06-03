/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AGUI_URL?: string;
  readonly VITE_AGUI_TARGET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
