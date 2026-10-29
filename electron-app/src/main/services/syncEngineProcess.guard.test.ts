import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Движок синка переехал в отдельный процесс (`utilityProcess`), и там из Electron
// доступны только `net` и `systemPreferences` — `app`, `safeStorage`, `dialog` нет
// вовсе (проверено вживую на Electron 43). Статический `import { app } from 'electron'`
// в воркере не падает при загрузке, поэтому ошибка была бы НЕ на старте, а в момент,
// когда понадобится путь к userData — то есть в поле, у оператора. Сторож держит
// границу: код движка платформенное берёт через `syncHost`/`syncSession`.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const ENGINE_FILES = [
  './syncService.ts',
  './syncManager.ts',
  './syncSession.ts',
  './syncHost.ts',
  '../workers/syncWorker.ts',
  '../workers/syncWorkerProtocol.ts',
];

describe('движок синка живёт без приложения', () => {
  it.each(ENGINE_FILES)('%s не импортирует app/safeStorage из electron', (file) => {
    const text = src(file);
    expect(text, 'движок снова тянет платформенное из electron напрямую').not.toMatch(
      /import\s*\{[^}]*\b(app|safeStorage|dialog|BrowserWindow)\b[^}]*\}\s*from\s*'electron'/,
    );
  });

  it('воркер берёт каталог, версию и лог через хост', () => {
    const text = src('../workers/syncWorker.ts');
    expect(text).toContain('setSyncHost(');
    expect(text).toContain('setSyncSessionProvider(');
  });

  it('сессию расшифровывает процесс с ключом ОС, а не воркер', () => {
    // В utility-процессе `safeStorage` нет: копия кольца ключей там разошлась бы с
    // ротацией, поэтому воркер спрашивает main через порт.
    expect(src('./syncSession.ts')).toContain('export async function readSyncSession');
    expect(src('../workers/syncWorker.ts')).toContain("type: 'session:read'");
  });
});
