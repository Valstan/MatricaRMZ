import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Класс, который закрыт 23.11.2026: тело ответа сервера уезжало в текст ошибки
// оператору целиком. На парке это выглядело как «Не отправилось: <170 КБ страницы
// Kaspersky>» (жалоба в чат владельцу), а в других модулях — так же, только без
// заметного повода.
//
// Правило: текст неудачи — из общего помощника (`services/httpFailureText.ts`).
// Сторож ловит возврат класса в любом файле главного процесса: сырой `text`/`res.text`
// в поле `error` больше не годится.

const MAIN = fileURLToPath(new URL('.', import.meta.url));
const SERVICES = join(MAIN);
const SCAN_DIRS = [join(MAIN, '..', 'ipc', 'register'), join(MAIN, '..', 'ipc'), join(MAIN)];

function filesIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

const SCANNED = SCAN_DIRS.flatMap(filesIn).filter((f) => !f.endsWith('httpFailureText.ts'));

/** Сырое тело ответа, отданное оператору: `error: ... r.text` / `error: ... res.text`. */
const RAW_BODY_IN_ERROR = /error:\s*[^;\n]*\b(?:r|res|result)\.text\b/;

describe('текст неудачи в главном процессе — из общего источника', () => {
  it('сырое тело ответа не уходит в поле error', () => {
    const offenders = SCANNED.filter((f) => RAW_BODY_IN_ERROR.test(readFileSync(f, 'utf8')));
    expect(
      offenders.map((f) => f.replace(MAIN, '')),
      'тело ответа сервера в тексте оператору: нужна httpFailureText/httpFailureLine',
    ).toEqual([]);
  });

  it('общий помощник один — и он знает про страницу антивируса', () => {
    const helper = readFileSync(join(SERVICES, 'httpFailureText.ts'), 'utf8');
    expect(helper).toContain('export function httpFailureText(');
    expect(helper).toContain('export function httpFailureLine(');
    expect(helper).toContain('looksLikeHtmlPage');
    // Страницу показывать нельзя — это и был инцидент.
    expect(helper).toContain('антивирус');
  });
});
