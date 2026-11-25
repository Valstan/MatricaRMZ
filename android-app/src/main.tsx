// Порядок важен: полифилы → мост (renderer жёстко требует window.matrica на
// старте) → сам renderer. Всё внутри async-IIFE, а не top-level await: TLA
// esbuild не пропускает под дефолтным browser-таргетом, а поднимать планку
// WebView ради одного оператора смысла нет.
import './boot/polyfills';

import { Capacitor } from '@capacitor/core';

// Платформенный признак ДО загрузки renderer-бандла.
//
// Что читает его теперь (промт КАРМАНА #142):
//   - `ui/platform.ts` — печать/PDF (считаются в скрытом окне Electron, у WebView
//     такого окна нет) и выгрузка в файл (у планшета нет файловой системы);
//   - `ui/shellV2/v2ButtonCatalog.ts` — кнопки, которых на планшете физически нет
//     (скрипты обслуживания Windows-машины, «Правка программы» — письмо файлом).
//
// Чего он НЕ читает: набора разделов. Рамки `ANDROID_TABS` больше нет — разделы
// режет только право и членство в разделе, те же, что на компьютере. Операторский
// пресет меню — отдельная явная настройка (не по платформе), см.
// `ui/hooks/useOperatorMenuPreset.ts`.
(globalThis as Record<string, unknown>).__MATRICA_PLATFORM__ = 'android';
// Тот же признак — в разметке :root: стили могут скрыть то, что на планшете
// не работает (печать панели ПП: в WebView window.print не печатает).
try {
  document.documentElement.dataset.platform = 'android';
} catch {
  // ignore — renderer всё равно читает признак через ui/platform.ts
}

declare const __MATRICA_APP_VERSION__: string;

function reportBootFailure(e: unknown): void {
  console.error('[android-boot] старт не удался:', e);
  // Белый экран на планшете неотличим от зависания — показываем причину.
  // Версия в тексте обязательна: без неё отчёт «та же ошибка» не различает
  // 3.47 и 3.48 (M145), а текст SQL из адаптера показывает, какой оператор упал.
  const root = document.getElementById('root') ?? document.body;
  root.textContent =
    `Не удалось запустить приложение (версия ${__MATRICA_APP_VERSION__}): ` +
    `${e instanceof Error ? e.message : String(e)}`;
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
