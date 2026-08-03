// Order matters: polyfills first, then the bridge shim must exist before the
// renderer bundle evaluates (main.tsx hard-gates on window.matrica presence).
import './boot/polyfills';
import './bridge/shim';

// Платформенный флаг ДО загрузки renderer-бандла: ANDROID_TABS-пресет меню и
// скрытия (печать/вложения/платежи/чат/AI) читают его через ui/platform.ts.
(globalThis as Record<string, unknown>).__MATRICA_PLATFORM__ = 'android';
import '../../electron-app/src/renderer/src/main.tsx';
