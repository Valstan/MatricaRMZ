// Шим модуля 'electron' для android-бандла (подставляется vite-плагином
// androidShims). Портированные main-сервисы Electron-клиента используют из
// 'electron' узкую поверхность — только её и реализуем; обращение к
// чему-то ещё должно упасть громко на этапе бандла/теста, а не тихо в проде.
//
// БЕЗОПАСНОСТЬ (safeStorage): на десктопе сессия шифруется ОС (DPAPI/Keychain)
// поверх шифрованной БД. На Android слой один — SQLCipher-реплика с ключом в
// Keystore; когда platform-хук encryptionAvailable()=true, «шифрование» здесь —
// identity (сессия хранится внутри уже шифрованной БД). Когда Keystore/ключа
// нет — false, и authService сам уходит в fail-closed (сессия только в памяти,
// перелогин после рестарта) — правило то же, что на десктопе без keyring.

import { getAndroidPlatformHooks } from './platform.js';

export const net = {
  fetch: (input: string | URL | Request, init?: RequestInit): Promise<Response> => globalThis.fetch(input, init),
  isOnline: (): boolean => (typeof navigator !== 'undefined' ? navigator.onLine : true),
};

export const safeStorage = {
  isEncryptionAvailable(): boolean {
    return getAndroidPlatformHooks().encryptionAvailable();
  },
  // authService: encryptString(json).toString('hex') → в БД; при чтении
  // Buffer.from(hex,'hex') → decryptString(buf). Identity-режим = честная
  // hex-кодировка UTF-8 без шифра (см. шапку файла). Buffer в WebView даёт
  // полифилл (vite alias 'buffer'); в vitest на Node он нативный.
  encryptString(value: string): { toString(encoding?: string): string } {
    const bytes = new TextEncoder().encode(value);
    const hex = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return { toString: () => hex };
  },
  decryptString(buf: unknown): string {
    return new TextDecoder().decode(buf as Uint8Array);
  },
};

export const app = {
  relaunch(): void {
    getAndroidPlatformHooks().relaunch();
  },
  exit(_code?: number): void {
    // На Android процесс не завершаем — relaunch-хук решает сам.
  },
  getVersion(): string {
    return getAndroidPlatformHooks().appVersion();
  },
};
