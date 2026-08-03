// Платформа клиента (Ф2 android-порта, план docs/plans/android-tablet-client-2026-08.md).
// Android-обёртка выставляет window.__MATRICA_PLATFORM__ = 'android' ДО загрузки
// renderer-бандла (рядом с установкой window.matrica); десктоп ничего не выставляет.
// Глобал вместо Vite define: renderer собирают два разных vite-конфига
// (electron-app и android-app), а поведение должно определяться обёрткой, не сборкой.

export type MatricaPlatform = 'desktop' | 'android';

export function matricaPlatform(): MatricaPlatform {
  return (globalThis as { __MATRICA_PLATFORM__?: unknown }).__MATRICA_PLATFORM__ === 'android'
    ? 'android'
    : 'desktop';
}

/** Планшетный Android-клиент: печать, вложения, платежи, чат/AI скрыты (v1). */
export function isAndroidPlatform(): boolean {
  return matricaPlatform() === 'android';
}
