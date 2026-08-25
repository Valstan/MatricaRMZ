import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SHELL_NOTICE_MS } from './shellNotice.js';

// Сторож канала сообщений оператору.
//
// Канал уже был мёртв однажды и никто этого не замечал полгода: `setPostLoginSyncMsg`
// звался из десятка мест, но единственный потребитель — `_headerInlineStatusText` — был
// вычислен и никуда не вставлен. Код при этом компилировался, линт молчал (имя с
// подчёркиванием разрешено), тесты были зелёными. Нашлось это только смоуком, который
// ждал в DOM обещанное подтверждение.
//
// Отсюда проверка не «функция существует», а «сообщение доезжает до разметки»: цепочка
// состояние → проп → JSX → CSS держится только строками, и любое звено рвётся молча.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const APP = src('../App.tsx');
const SHELL = src('../shellV3/V3TabShell.tsx');
const CSS = src('../shellV3/shellV3.css');

/** Текст вызова `notifyOperator(...)` целиком — до закрывающей скобки со точкой с запятой. */
function notifyCalls(text: string): string[] {
  const calls: string[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf('notifyOperator(', from);
    if (start < 0) break;
    const end = text.indexOf(');', start);
    if (end < 0) break;
    if (text.slice(start - 9, start) !== 'function ') calls.push(text.slice(start, end + 2));
    from = end + 2;
  }
  return calls;
}

describe('сообщение оператору доезжает до разметки', () => {
  it('App.tsx отдаёт состояние плашки в оболочку', () => {
    expect(APP, 'проп notice больше не передаётся в V3TabShell').toContain('notice={shellNotice}');
  });

  it('оболочка рендерит переданное, а не вычисляет в пустоту', () => {
    expect(SHELL, 'проп notice объявлен').toContain('notice?: ShellNotice');
    expect(SHELL, 'текст сообщения не вставлен в JSX').toContain('{props.notice.text}');
    expect(SHELL, 'плашка потеряла класс').toContain('v3-shell-notice');
  });

  it('у плашки есть стили обоих тонов', () => {
    expect(CSS).toContain('.v3-shell-notice {');
    expect(CSS).toContain('.v3-shell-notice-error {');
  });
});

describe('второго, мёртвого канала нет', () => {
  it('postLoginSyncMsg не воскрес', () => {
    // Комментарий про снятый канал остаться может — код не должен.
    expect(APP).not.toContain('setPostLoginSyncMsg(');
    expect(APP).not.toContain('const _headerInlineStatusText');
  });

  it('тон не угадывается по тексту сообщения', () => {
    // Прежний канал отбирал тревожные сообщения регуляркой по готовой строке: любая
    // новая формулировка молча теряла тревожный вид.
    expect(APP).not.toMatch(/ошиб\|не удалось\|недостаточно/);
  });
});

describe('тон сообщения назван явно', () => {
  const ALARM = /Ошибк|Не удалось|Нельзя|Недостаточно|с ошибкой|не выбран/i;

  it('каждое тревожное сообщение помечено tone=error', () => {
    const calls = notifyCalls(APP);
    expect(calls.length, 'вызовы notifyOperator не найдены — сторож смотрит не туда').toBeGreaterThan(5);
    for (const call of calls) {
      if (!ALARM.test(call)) continue;
      expect(call, `тревожное сообщение без тона: ${call.slice(0, 90)}`).toContain("'error'");
    }
  });

  it('ошибку показывают дольше подтверждения', () => {
    expect(SHELL_NOTICE_MS.error).toBeGreaterThan(SHELL_NOTICE_MS.info);
  });
});
