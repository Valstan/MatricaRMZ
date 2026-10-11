import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Отправка ссылки в чат молчала об исходе: отказы («чат закрыт»,
// «админ-режим») назывались, а результат самой отправки — нет.
// Канал уже есть (`notifyOperator`) — подтверждение идёт в ту же плашку.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const APP = src('./App.tsx');

function sendBlock(): string {
  const start = APP.indexOf('async function sendCurrentPositionToChat()');
  if (start < 0) throw new Error('sendCurrentPositionToChat не найдена — сторож устарел');
  const end = APP.indexOf('async function submitProgramFeedback');
  return APP.slice(start, end < 0 ? undefined : end);
}

describe('ссылка в чат говорит об исходе', () => {
  it('успех подтверждается, отказ называется с причиной', () => {
    const block = sendBlock();
    expect(block).toContain("notifyOperator('Ссылка на текущий раздел отправлена в чат.');");
    expect(block).toContain('Не удалось отправить ссылку:');
  });
});
