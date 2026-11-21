/**
 * Мутирующие IPC-каналы производственной программы обязаны стоять в списке
 * write-гейта, а все каналы модуля — гейтиться своим разделом.
 *
 * Образец — сторож СИЗ (`sectionGateWriteChannels.guard.test.ts`): список ведётся
 * руками, а новый канал проскочить может молча. План ведут трое (уровень editor
 * раздела `production_program`), наблюдатель читает — границу держит и уровень
 * раздела, и серверное право `production_program.edit`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { isWriteGatedChannel, matchPrefixRule } from './sectionGate.js';

const here = dirname(fileURLToPath(import.meta.url));
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Прямая запись в локальную базу: такая мутация не видна по HTTP-методу. */
const LOCAL_WRITE = /\.(insert|update|delete)\(|setEntityAttribute\(|writeSyncChanges\(/;

/** Каналы модуля ПП, HTTP-методы (если есть) и тело обработчика. */
function registeredProgramChannels(): Array<{ channel: string; methods: string[]; body: string }> {
  const text = readFileSync(join(here, 'register', 'productionProgram.ts'), 'utf8');
  const starts = [...text.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)];
  return starts.map((m, i) => {
    const body = text.slice((m.index ?? 0) + String(m[0]).length, starts[i + 1]?.index ?? text.length);
    const methods = [...body.matchAll(/method:\s*'(GET|POST|PUT|PATCH|DELETE)'/g)].map((x) => String(x[1]));
    return { channel: String(m[1]), methods, body };
  });
}

describe('write-гейт разделов: каналы производственной программы', () => {
  const channels = registeredProgramChannels();

  it('регистрация читается: каналы найдены', () => {
    expect(channels.length).toBeGreaterThan(4);
  });

  it('каждый мутирующий канал стоит в списке write-гейта', () => {
    const missing = channels
      .filter((c) => c.methods.some((m) => MUTATING_METHODS.has(m)))
      .filter((c) => !isWriteGatedChannel(c.channel))
      .map((c) => c.channel);
    expect(missing).toEqual([]);
  });

  it('чтения наблюдателю не режут: read-каналов в write-списке нет', () => {
    const wrong = channels
      .filter((c) => c.methods.length > 0 && c.methods.every((m) => m === 'GET'))
      .filter((c) => isWriteGatedChannel(c.channel))
      .map((c) => c.channel);
    expect(wrong).toEqual([]);
  });

  it('канал без HTTP-метода не пишет в базу сам', () => {
    const locals = channels
      .filter((c) => c.methods.length === 0)
      .filter((c) => LOCAL_WRITE.test(c.body))
      .map((c) => c.channel);
    expect(locals).toEqual([]);
  });

  it('все каналы модуля гейтятся разделом производственной программы', () => {
    const wrong = channels.filter((c) => matchPrefixRule(c.channel) !== 'production_program').map((c) => c.channel);
    expect(wrong).toEqual([]);
  });
});
