/**
 * Мутирующие IPC-каналы раздела обязаны стоять в списке write-гейта.
 *
 * Список ведётся руками, а модуль растёт половинами: каналы фазы 2 «Кладовщика»
 * (отпуска, группы, коллективные, импорт) в него не дописали, и наблюдатель
 * раздела «Склад» правил её данные мимо гейта — фаза 1 при этом была закрыта.
 * Тот же шов, что M135: право раздаётся по одной двери, а вторая остаётся
 * открытой, и по каждому PR порознь это не видно.
 *
 * Сторож читает регистрацию, где канал — тонкая обёртка REST-вызова, и берёт
 * метод HTTP: мутирующий = POST/PUT/PATCH/DELETE. Это надёжнее эвристики по
 * имени («ppe:employees:normSets» — чтение, хотя «set» в имени есть) и не даёт
 * новому каналу проскочить молча.
 *
 * У части каналов метода нет вовсе — они читают локальную реплику, не REST
 * (`ppe:employees:list`). Для них проверяется вторая дверь: канал без метода
 * не имеет права писать в базу сам, минуя гейт и журнал.
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

/** Каналы модуля СИЗ, HTTP-методы (если есть) и тело обработчика. */
function registeredPpeChannels(): Array<{ channel: string; methods: string[]; body: string }> {
  const text = readFileSync(join(here, 'register', 'ppe.ts'), 'utf8');
  const starts = [...text.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)];
  return starts.map((m, i) => {
    const body = text.slice((m.index ?? 0) + String(m[0]).length, starts[i + 1]?.index ?? text.length);
    // Часть записей уходит локальному помощнику `postJson(path, body, method = 'POST')`.
    const posts = [...body.matchAll(/\bpostJson\(/g)].length;
    const puts = [...body.matchAll(/'PUT'/g)].length;
    const methods = [
      ...[...body.matchAll(/method:\s*'(GET|POST|PUT|PATCH|DELETE)'/g)].map((x) => String(x[1])),
      ...Array.from({ length: posts - puts }, () => 'POST'),
      ...Array.from({ length: puts }, () => 'PUT'),
    ];
    return { channel: String(m[1]), methods, body };
  });
}

describe('write-гейт разделов: каналы СИЗ', () => {
  const channels = registeredPpeChannels();

  it('регистрация читается: каналы найдены', () => {
    expect(channels.length).toBeGreaterThan(20);
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
      .filter((c) => c.methods.every((m) => m === 'GET'))
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

  it('все каналы модуля гейтятся разделом склада', () => {
    const wrong = channels.filter((c) => matchPrefixRule(c.channel) !== 'warehouse').map((c) => c.channel);
    expect(wrong).toEqual([]);
  });
});
