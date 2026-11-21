/**
 * Мутирующие IPC-каналы «Детей» и организационного отдела обязаны стоять в списке
 * write-гейта, а сами каналы — гейтиться своими разделами.
 *
 * Образец — сторож ПП (`sectionGateProductionProgram.guard.test.ts`) и сторож СИЗ
 * (`sectionGateWriteChannels.guard.test.ts`). До 21.11.2026 каналов этих двух модулей
 * в гейте не было вовсе: данные о детях читались мимо разделов.
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

type Channel = { channel: string; methods: string[]; body: string };

function registeredChannels(file: string): Channel[] {
  const text = readFileSync(join(here, 'register', file), 'utf8');
  const starts = [...text.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)];
  return starts.map((m, i) => {
    const body = text.slice((m.index ?? 0) + String(m[0]).length, starts[i + 1]?.index ?? text.length);
    const methods = [...body.matchAll(/method:\s*'(GET|POST|PUT|PATCH|DELETE)'/g)].map((x) => String(x[1]));
    return { channel: String(m[1]), methods, body };
  });
}

describe('write-гейт разделов: каналы «Детей» и организационного отдела', () => {
  const children = registeredChannels('children.ts');
  const organization = registeredChannels('organization.ts');

  it('регистрация читается: каналы найдены', () => {
    expect(children.length).toBeGreaterThan(2);
    expect(organization.length).toBeGreaterThan(4);
  });

  it('каждый мутирующий канал стоит в списке write-гейта', () => {
    const missing = [...children, ...organization]
      .filter((c) => c.methods.some((m) => MUTATING_METHODS.has(m)))
      .filter((c) => !isWriteGatedChannel(c.channel))
      .map((c) => c.channel);
    expect(missing).toEqual([]);
  });

  it('чтения наблюдателю не режут: read-каналов в write-списке нет', () => {
    const wrong = [...children, ...organization]
      .filter((c) => c.methods.length > 0 && c.methods.every((m) => m === 'GET'))
      .filter((c) => isWriteGatedChannel(c.channel))
      .map((c) => c.channel);
    expect(wrong).toEqual([]);
  });

  it('канал без HTTP-метода не пишет в базу сам', () => {
    const locals = [...children, ...organization]
      .filter((c) => c.methods.length === 0)
      .filter((c) => LOCAL_WRITE.test(c.body))
      .map((c) => c.channel);
    expect(locals).toEqual([]);
  });

  it('каналы «Детей» гейтятся разделом детей, организационного отдела — своим', () => {
    const wrongChildren = children.filter((c) => matchPrefixRule(c.channel) !== 'children').map((c) => c.channel);
    const wrongOrg = organization.filter((c) => matchPrefixRule(c.channel) !== 'organization').map((c) => c.channel);
    expect(wrongChildren).toEqual([]);
    expect(wrongOrg).toEqual([]);
  });
});
