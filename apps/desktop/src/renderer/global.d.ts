import type { ContentOsDesktopApi } from '../shared/dto.ts';

declare global {
  interface Window {
    /** Preload が contextBridge で公開するAPI。これ以外は触れない。 */
    readonly contentOs: ContentOsDesktopApi;
  }
}

export {};
