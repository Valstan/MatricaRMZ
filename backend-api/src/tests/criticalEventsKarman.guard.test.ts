import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Сторож контракта «критические сообщения → корзина промтов КАРМАНА»
// (промт КАРМАНА #183).
//
// Что тут стережётся:
//  1. сборщик вообще включён — иначе запись просто не уходит;
//  2. сборщик ПИШЕТ в корзину и НИКОГДА не читает раздел промтов: оттуда
//     приехала бы внутренняя переписка программы (она не критическая ошибка);
//  3. окно повторов — четыре часа, и повтор считается по содержанию;
//  4. журнал критических событий жив: администратор видит события и удаляет их.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const SERVICE = src('../services/criticalEventsKarmanService.ts');
const INDEX = src('../index.ts');
const EVENTS = src('../services/criticalEventsService.ts');

describe('сборщик критических событий включён', () => {
  it('сервер запускает сборщик при старте', () => {
    expect(INDEX).toContain("import { startCriticalEventsKarmanService } from './services/criticalEventsKarmanService.js';");
    expect(INDEX).toContain('startCriticalEventsKarmanService();');
  });
});

describe('сборщик только пишет в корзину', () => {
  it('раздел промтов он не читает — внутренняя переписка туда не попадёт', () => {
    expect(SERVICE).toContain("const PROMPTS_PATH = '/api/prompts';");
    expect(SERVICE).not.toContain('/api/prompts/section');
    expect(SERVICE).not.toContain("method: 'GET'");
  });

  it('пишет в раздел «Матрица РМЗ» и размечает потребителя для аудита', () => {
    expect(SERVICE).toContain("export const KARMAN_PROMPTS_PROJECT = 'MatricaRMZ';");
    expect(SERVICE).toContain('X-Matricarmz-Project');
    expect(SERVICE).toContain('X-Matricarmz-Area');
  });
});

describe('защита от повторов настроена как заказано', () => {
  it('окно — четыре часа', () => {
    expect(SERVICE).toContain('export const BASKET_DEDUP_WINDOW_MS = 4 * 60 * 60_000;');
  });

  it('повтор считается по содержанию: отпечаток берётся из журнала, где он устроен как «машина + суть»', () => {
    expect(SERVICE).toContain('export function basketFingerprint(event: CriticalEventRecord): string {');
    expect(SERVICE).toContain('const fingerprint = String(event.fingerprint ?? \'\').trim();');
  });
});

describe('журнал критических событий не сломан', () => {
  it('события по-прежнему пишутся, читаются и удаляются', () => {
    expect(EVENTS).toContain('export function listCriticalEvents(');
    expect(EVENTS).toContain('export function deleteCriticalEventById(');
    expect(EVENTS).toContain('export function deleteAllCriticalEvents(');
    expect(EVENTS).toContain('export function ingestClientCriticalEvent(');
    expect(EVENTS).toContain('export function ingestServerCriticalEvent(');
  });
});
