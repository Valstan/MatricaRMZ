import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Сторож D-042: контакт техподдержки приезжает из настроек экземпляра, и номер
// телефона не должен вернуться в код литералом. Репозиторий публичен с 2026-08-17;
// правило — AGENTS.md §«Персональные данные сотрудников». Возврат вероятен не по
// злому умыслу, а по образцу: рядом лежит соседний JSX, и вписать номер «как было»
// проще, чем вспомнить про канал настроек.
//
// Тексты ПРОШЛЫХ релизов (`shared/src/domain/releaseWelcome.ts`) сторож намеренно не
// проверяет: это закрытые записи по D-038, их не переписывают, и вычистка ничего не
// отзывает — номер остаётся в git-истории независимо от правки.
const HERE = dirname(fileURLToPath(import.meta.url));
const APP_TSX = join(HERE, 'App.tsx');

// +7 / 8, код 9NN, затем 7 цифр в любой разбивке пробелами, дефисами, скобками.
const RU_MOBILE = /(?:\+7|\b8)[\s(-]*9\d{2}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/;

describe('окно приветствия: контакт техподдержки не зашит в код', () => {
  it('в App.tsx нет литерала мобильного телефона', () => {
    const source = readFileSync(APP_TSX, 'utf8');
    const match = source.match(RU_MOBILE);
    expect(
      match?.[0] ?? null,
      'Похоже, номер снова вписан литералом. Значение живёт в настройках экземпляра: ' +
        'backend `GET /auth/support-contact`, заполняется `pnpm -F @matricarmz/backend-api support:contact`.',
    ).toBeNull();
  });

  it('регулярка сторожа действительно ловит номер в таком блоке', () => {
    const shapes = [
      '<div className="release-welcome-support-phone">+7 (900) 000-00-00</div>',
      '<div>8 900 000-00-00</div>',
      '<div>89000000000</div>',
      '<div>+7-900-000-00-00</div>',
    ];
    for (const shape of shapes) {
      expect(RU_MOBILE.test(shape), shape).toBe(true);
    }
  });

  it('не срабатывает на обычных числах в коде', () => {
    const innocent = [
      'const timeout = 8_000;',
      'expect(size).toBe(136503458);',
      'version: 2026.814.1503',
      'const port = 3001;',
    ];
    for (const line of innocent) {
      expect(RU_MOBILE.test(line), line).toBe(false);
    }
  });
});
