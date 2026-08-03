import type { MatricaApi } from '@matricarmz/shared';

// Мост целиком описан контрактом MatricaApi (shared/src/ipc/types.ts) — он и есть источник
// правды по форме window.matrica. Локальных «доклеек» тут быть не должно: любой новый метод
// preload'а идёт в MatricaApi, иначе тип снова разъедется с реальным мостом (2026-08-03).
declare global {
  interface Window {
    matrica: MatricaApi;
  }
}

export {};
