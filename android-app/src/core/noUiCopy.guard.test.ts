// Гейт «в android-app нет своей копии UI» (промт КАРМАНА #142, п.5).
//
// Правило владельца: «версия для компьютера — копия планшетной». Одна кодовая
// база, одна сборка интерфейса, различие — только в мосте и в шимах. Значит
// android-app НЕ ДОЛЖЕН содержать своих экранов и своей вёрстки.
//
// Ломается тихо: разработчик планшетной фичи заводит в android-app свой
// компонент или свой CSS — и на компьютере этой правки нет. Через месяц два
// клиента расходятся, и «планшет — урезанная версия» снова становится правдой
// (ровно тот диагноз, который владелец поставил неверно).
//
// Что проверяем:
//   1. В android-app нет своих .tsx/.jsx-компонентов интерфейса (только main.tsx —
//      точка входа, и bridge/shim.ts — инструмент просмотра в браузере).
//   2. В android-app нет своих CSS-файлов с правилами интерфейса.
//   3. Рендерер у планшета — ТОТ ЖЕ исходник, что у компьютера: vite-root
//      android-app указывает на electron-app/src/renderer, и renderer импортируется
//      через @renderer, а не копируется.
//   4. Различие живёт в мосте и шимах: android-app/src/core/* и android-app/src/shims/*
//      существуют, и мост подключает домены, которых нет на десктопе (filesBridge).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const androidSrc = resolve(repoRoot, 'android-app/src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const allFiles = walk(androidSrc);
const rel = (p: string) => p.slice(androidSrc.length + 1).replace(/\\/g, '/');

/**
 * Точка входа планшета — единственный .tsx в android-app: она грузит общий
 * renderer, а не рисует интерфейс сама.
 */
const ENTRY_POINTS = new Set(['main.tsx']);

/**
 * Инструмент просмотра в браузере (спайк-мост Ф0): ставит window.matrica, чтобы
 * можно было смотреть планшетную раскладку без устройства. Интерфейса не рисует.
 */
const TOOLING = new Set(['bridge/shim.ts']);

describe('в android-app нет своей копии UI', () => {
  it('нет своих компонентов интерфейса (.tsx/.jsx)', () => {
    const uiFiles = allFiles
      .filter((f) => /\.(tsx|jsx)$/.test(f))
      .map(rel)
      .filter((f) => !ENTRY_POINTS.has(f) && !TOOLING.has(f));
    expect(
      uiFiles,
      'в android-app появился свой компонент интерфейса — планшет и компьютер разойдутся; общий интерфейс живёт в electron-app/src/renderer',
    ).toEqual([]);
  });

  it('нет своей вёрстки (.css/.scss)', () => {
    const styleFiles = allFiles.filter((f) => /\.(css|scss|less)$/.test(f)).map(rel);
    expect(
      styleFiles,
      'в android-app появился свой CSS — оформление интерфейса должно быть общим (electron-app/src/renderer)',
    ).toEqual([]);
  });

  it('нет своей копии страниц (Page.tsx / *Page.tsx)', () => {
    const pageFiles = allFiles.filter((f) => /Page\.tsx$/i.test(f)).map(rel);
    expect(pageFiles, 'в android-app появилась своя страница').toEqual([]);
  });

  it('рендерер планшета — ТОТ ЖЕ исходник, что у компьютера', () => {
    const viteConfig = readFileSync(resolve(repoRoot, 'android-app/vite.config.ts'), 'utf8');
    // vite-root указывает на renderer десктопа — копии нет.
    expect(
      viteConfig,
      'vite-root android-app больше не указывает на electron-app/src/renderer — появилась копия интерфейса',
    ).toContain('electron-app/src/renderer');
    expect(
      viteConfig,
      'renderer импортируется через @renderer, а не копируется в android-app',
    ).toContain("'@renderer'");
  });

  it('различие с десктопом живёт в мосте и шимах', () => {
    // Мост планшета — обязателен: без него renderer не получит window.matrica.
    expect(
      allFiles.some((f) => rel(f) === 'core/ipcWiring.ts'),
      'в android-app нет моста (core/ipcWiring.ts) — планшет не сможет работать с сервисами',
    ).toBe(true);
    // Шимы — платформенные края: без них сборка APK падает на непортированном модуле.
    expect(
      allFiles.some((f) => rel(f).startsWith('shims/')),
      'в android-app нет платформенных шимов (src/shims/*)',
    ).toBe(true);
  });

  it('свой код планшета не импортирует страницы десктопа напрямую (общий @renderer)', () => {
    // Прямой импорт страницы десктопа в android-app = копия UI начинается.
    const offenders: string[] = [];
    for (const file of allFiles.filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))) {
      const text = readFileSync(file, 'utf8');
      const imports = text.matchAll(/from\s+['"]([^'"]+)['"]/g);
      for (const m of imports) {
        const spec = m[1] ?? '';
        if (spec.includes('electron-app/src/renderer/src/ui/pages')) {
          offenders.push(rel(file));
        }
      }
    }
    expect(
      offenders,
      'android-app импортирует страницы десктопа напрямую — вместо общего реестра разделов (@renderer)',
    ).toEqual([]);
  });
});
