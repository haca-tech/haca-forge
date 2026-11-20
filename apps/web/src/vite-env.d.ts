/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_SOCKET_URL?: string;
  readonly VITE_QUICK_LOGINS?: string;
  /** "true" keeps quick sign in in a production build. Temporary: remove before hosting. */
  readonly VITE_QUICK_LOGIN_IN_BUILD?: string;
  /** "production" for the hosted build: quick sign in is then refused (the build fails). */
  readonly VITE_DEPLOY_TARGET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module 'mammoth' {
  export function convertToHtml(input: { arrayBuffer: ArrayBuffer } | { buffer: Buffer } | { path: string }, options?: any): Promise<{ value: string; messages: any[] }>;
  export function extractRawText(input: { arrayBuffer: ArrayBuffer } | { buffer: Buffer } | { path: string }): Promise<{ value: string; messages: any[] }>;
}
