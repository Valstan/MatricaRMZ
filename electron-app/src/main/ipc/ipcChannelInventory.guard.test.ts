import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Инвентаризация IPC-каналов (метод M42, `docs/gotchas/M42.md`).
//
// IPC идёт по строковому каналу: компилятор, линтер и тесты его не видят. Уже
// было — после чистки «мёртвого» `erp.ts` клиенты писали в лог `Error invoking
// remote method 'warehouse:nomenclature:list': No handler registered`, и отваливался
// весь контур. Владелец 23.11.2026 увидел то же самое в поле «Цех» карточки
// («Error invoking remote method 'workshop'»).
//
// Сторож сравнивает ВСЕ `ipcRenderer.invoke('X')` в preload со ВСЕМИ
// `ipcMain.handle('X')` в main и падает на расхождении. Белый список — только
// осознанные случаи, и он не должен расти молча.
function src(rel: string): string {
  return readFileSync(resolve(__dirname, rel), 'utf8').replace(/\r\n/g, '\n');
}

const MAIN_DIR = resolve(__dirname, '..');

/** Все .ts файлы main-процесса (без тестов). */
function mainFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...mainFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    out.push(full);
  }
  return out;
}

/**
 * Каналы, которые preload зовёт, а main не обслуживает — осознанно.
 *
 * `files:uploadBlob` обслуживает Android-мост (`android-app/src/core/ipcWiring.ts`),
 * в desktop-main такого канала нет. Всё остальное — дефект.
 */
const ALLOWED_WITHOUT_DESKTOP_HANDLER = new Set(['files:uploadBlob']);

function channelsIn(text: string, pattern: RegExp): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(pattern)) {
    const ch = m[1];
    if (ch) out.add(ch);
  }
  return out;
}

const PRELOAD_CHANNELS = channelsIn(src('../../preload/index.ts'), /invoke\(\s*'([^']+)'/g);

const MAIN_CHANNELS = new Set<string>();
for (const file of mainFiles(MAIN_DIR)) {
  for (const ch of channelsIn(readFileSync(file, 'utf8'), /ipcMain\.handle\(\s*'([^']+)'/g)) {
    MAIN_CHANNELS.add(ch);
  }
}

describe('инвентаризация IPC-каналов (M42)', () => {
  it('preload зовёт каналы, которые main обслуживает', () => {
    const missing = [...PRELOAD_CHANNELS].filter((ch) => !MAIN_CHANNELS.has(ch) && !ALLOWED_WITHOUT_DESKTOP_HANDLER.has(ch));
    expect(missing).toEqual([]);
  });

  it('белый список не растёт молча', () => {
    // Каждый канал в белом списке обязан реально отсутствовать в desktop-main:
    // иначе запись в списке — просто забытая уборка.
    const stale = [...ALLOWED_WITHOUT_DESKTOP_HANDLER].filter((ch) => MAIN_CHANNELS.has(ch));
    expect(stale).toEqual([]);
  });

  it('инвентаризация не пустая: каналы действительно считаются', () => {
    // Сторож, который считает 0 каналов, «зелёный» всегда — это не гейт.
    expect(PRELOAD_CHANNELS.size).toBeGreaterThan(400);
    expect(MAIN_CHANNELS.size).toBeGreaterThan(400);
  });
});
