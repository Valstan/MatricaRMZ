import { describe, expect, it } from 'vitest';

import { httpFailureLine, httpFailureText, looksLikeHtmlPage } from './httpFailureText.js';

// Инцидент 23.11.2026: кнопка «сообщить администратору» вернула «Не отправилось:
// <170 КБ страницы Kaspersky>», и оператор отправил эту страницу в чат владельцу.
// Правило текста неудачи проверяем здесь — чтобы класс «сырое тело ответа в сообщении
// оператору» не вернулся ни в одном модуле.

describe('текст неудачи для оператора', () => {
  it('страница вместо ответа: причину называем, страницу не показываем', () => {
    const page = '<!DOCTYPE html><html lang="ru"><head><title>Kaspersky Plus</title></head><body>…</body></html>';
    const text = httpFailureText({ status: 403, text: page });
    expect(text).toContain('веб-страниц');
    expect(text).toContain('антивирус');
    // Страницы в тексте быть не должно — ни начала, ни куска разметки.
    expect(text).not.toContain('<');
    expect(text).not.toContain('Kaspersky');
    expect(text.length).toBeLessThan(300);
  });

  it('страница распознаётся и по doctype, и по <head>, и по <body>', () => {
    expect(looksLikeHtmlPage('<!DOCTYPE html><html></html>')).toBe(true);
    expect(looksLikeHtmlPage('<head><title>proxy</title></head>')).toBe(true);
    expect(looksLikeHtmlPage('<body>nginx</body>')).toBe(true);
    // Обычный текст ошибки страницей не считается.
    expect(looksLikeHtmlPage('не удалось сохранить: нет прав')).toBe(false);
    expect(looksLikeHtmlPage('{"error":"нет прав"}')).toBe(false);
    expect(looksLikeHtmlPage('')).toBe(false);
  });

  it('ошибка нашего сервера — как есть', () => {
    expect(httpFailureText({ status: 400, json: { error: 'не хватает прав' } })).toBe('не хватает прав');
  });

  it('длинный текст режется до читаемого размера', () => {
    const long = 'ошибка '.repeat(200);
    const text = httpFailureText({ status: 500, text: long });
    expect(text.length).toBeLessThanOrEqual(301);
    expect(text.endsWith('…')).toBe(true);
  });

  it('пустой ответ — только статус', () => {
    expect(httpFailureText({ status: 502 })).toBe('HTTP 502');
    expect(httpFailureLine({ status: 502 })).toBe('HTTP 502');
  });

  it('со статусом — строка вида «HTTP 502: причина»', () => {
    expect(httpFailureLine({ status: 502, json: { error: 'сервер занят' } })).toBe('HTTP 502: сервер занят');
    const page = '<html><head><title>blocked</title></head></html>';
    const line = httpFailureLine({ status: 403, text: page });
    expect(line.startsWith('HTTP 403: ')).toBe(true);
    expect(line).not.toContain('<title>');
  });
});
