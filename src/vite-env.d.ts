/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GOOGLE_SHEETS_SERVER_URL?: string;
  readonly VITE_RUSHES_STORAGE_BUCKET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
