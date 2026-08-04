// Порядок важен: полифилы → мост (renderer жёстко требует window.matrica на
// старте) → сам renderer. Всё внутри async-IIFE, а не top-level await: TLA
// esbuild не пропускает под дефолтным browser-таргетом, а поднимать планку
// WebView ради одного оператора смысла нет.
import './boot/polyfills';

import { Capacitor } from '@capacitor/core';

// Платформенный флаг ДО загрузки renderer-бандла: ANDROID_TABS-пресет меню и
// скрытия (печать/вложения/платежи/чат/AI) читают его через ui/platform.ts.
(globalThis as Record<string, unknown>).__MATRICA_PLATFORM__ = 'android';

function reportBootFailure(e: unknown): void {
  console.error('[android-boot] старт не удался:', e);
  // Белый экран на планшете неотличим от зависания — показываем причину.
  const root = document.getElementById('root') ?? document.body;
  root.textContent = `Не удалось запустить приложение: ${e instanceof Error ? e.message : String(e)}`;
}

void (async () => {
  try {
    if (Capacitor.isNativePlatform()) {
      // На устройстве — настоящее ядро: SQLCipher-реплика, синк, мост Ф2/Ф3.
      const { bootCapacitorClient } = await import('./platform/bootCapacitor.js');
      await bootCapacitorClient();
    } else {
      // В обычном браузере плагина SQLite нет: остаётся спайк-мост Ф0, чтобы
      // renderer можно было собирать и смотреть без планшета.
      await import('./bridge/shim.js');
    }
    await import('@renderer/main');
  } catch (e) {
    reportBootFailure(e);
  }
})();
