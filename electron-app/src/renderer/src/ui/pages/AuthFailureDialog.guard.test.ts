import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Владелец 12.09.2026: «если пароль неправильный, надо чтобы модалка появлялась с этим сообщением,
// а то сейчас просто код ошибки выпадает и ничего не понятно». Цепочка рвётся молча в двух местах:
// main может снова вернуть транспортную строку, а экран — снова вывести её жёлтой строчкой под
// формой. Сторож держит оба конца.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const PAGE = src('./AuthPage.tsx');
const SERVICE = src('../../../../main/services/authService.ts');

describe('отказ входа доходит до оператора человеческим текстом', () => {
  it('main разбирает ответ сервера, а не склеивает код с телом', () => {
    expect(SERVICE).toContain('describeAuthFailure({ status: r.status, rawBody: t })');
    expect(SERVICE, 'сетевой обрыв — отдельный случай, не «неверный пароль»').toContain('describeAuthNetworkFailure(e)');
    expect(SERVICE, 'сырой транспортный текст оператору больше не отдаём').not.toContain('`login HTTP ${r.status}');
    expect(SERVICE).not.toContain('`register HTTP ${r.status}');
  });

  it('экран решает по коду, показать модалку или строку', () => {
    expect(PAGE).toContain('authFailureNeedsModal(r.code ?? \'unknown\')');
    expect(PAGE, 'старый формат «Ошибка: <транспорт>» убран').not.toContain('setMsg(`Ошибка: ${r.error}`)');
  });

  it('модалка есть в разметке и закрывается', () => {
    expect(PAGE).toContain('data-auth-failure');
    expect(PAGE).toContain("role=\"alertdialog\"");
    expect(PAGE).toContain('data-auth-failure-close');
    expect(PAGE).toContain('function closeFailure()');
  });

  it('после отказа пароль очищен, а фокус возвращается в поле', () => {
    expect(PAGE).toContain('passwordRef.current?.focus()');
    const submit = PAGE.slice(PAGE.indexOf('async function submitLogin'), PAGE.indexOf('async function submitRegister'));
    expect(submit, 'набранный неверно пароль не должен оставаться в поле').toContain('setPassword(\'\');');
  });
});
