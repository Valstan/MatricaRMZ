import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Воркер чтения (`utilityProcess`) — как синк-воркер — не имеет доступа к `app`,
// `safeStorage`, `dialog`, `BrowserWindow` из Electron. Любой прямой импорт
// платформенного из этого процесса ломает канал: ошибка проявляется не на
// старте, а в момент первого вызова списка (в поле, у оператора).
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const DATA_FILES = [
  '../workers/dataWorker.ts',
  '../workers/dataWorkerProtocol.ts',
];

describe('воркер чтений живёт без приложения', () => {
  it.each(DATA_FILES)('%s не импортирует app/safeStorage/dialog из electron', (file) => {
    const text = src(file);
    expect(text, 'воркер чтений снова тянет платформенное из electron напрямую').not.toMatch(
      /import\s*\{[^}]*\b(app|safeStorage|dialog|BrowserWindow)\b[^}]*\}\s*from\s*'electron'/,
    );
  });

  it('воркер читает базу через openSqlite с PRAGMA query_only', () => {
    const text = src('../workers/dataWorker.ts');
    expect(text).toContain("openSqlite(");
    expect(text).toContain('query_only');
  });

  it('протокол несёт строки, фазы и время — как в замере плана', () => {
    const text = src('../workers/dataWorkerProtocol.ts');
    expect(text).toContain('EngineListItem');
    expect(text).toContain('phases:');
    expect(text).toContain('ms:');
  });

  it('порт асимметричен: воркер читает event.data, main читает само сообщение', () => {
    const workerText = src('../workers/dataWorker.ts');
    const proxyText = src('./dataProxy.ts');
    // Воркер: `parentPort.on('message', (event: ...) => handleMessage(event.data))`
    expect(workerText).toContain('event.data');
    // Main: `child.on('message', (message: ...) => this.handleMessage(message))`
    // (без `.data` — UtilityProcess отдаёт само сообщение)
    expect(proxyText).not.toContain('event.data');
  });
});
