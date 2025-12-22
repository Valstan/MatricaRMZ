import type { MatricaApi } from '@matricarmz/shared';

declare global {
  interface Window {
    matrica: MatricaApi;
  }
}

export {};


