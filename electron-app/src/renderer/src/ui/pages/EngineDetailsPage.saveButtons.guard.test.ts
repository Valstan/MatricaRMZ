import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const src = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

const CARD = src('EngineDetailsPage.tsx');
const PAYMENTS = src('../components/EnginePaymentsTab.tsx');

/**
 * Жалоба владельца 01.11.2026: «Сохранить и выйти» в карточке двигателя закрывает карточку,
 * не сохраняя внесённое. Проверяем, что обе кнопки шапки сохраняют ВСЁ, а «Сохранить и
 * выйти» после этого ещё и закрывает карточку.
 *
 * Правая часть истории: платежи живут по своей схеме (своя кнопка «Сохранить платежи» и
 * свой флаг несохранённых правок). Кнопки шапки про них не знали — карточка сохраняла своё
 * и закрывалась, а несохранённые платежи исчезали вместе с вкладкой. Теперь карточка
 * сбрасывает их в базу ДО закрытия.
 */
describe('Карточка двигателя: обе кнопки шапки сохраняют всё', () => {
  it('«Сохранить и выйти» сбрасывает несохранённые платежи ДО сохранения карточки', () => {
    // Ищем внутри самой saveAllAndClose: вызовов сохранения карточки в файле больше одного.
    const fnStart = CARD.indexOf('async function saveAllAndClose()');
    expect(fnStart, 'не найдена функция saveAllAndClose').toBeGreaterThan(-1);
    const fn = CARD.slice(fnStart, CARD.indexOf('\n  async function ', fnStart + 10) > 0 ? CARD.indexOf('\n  async function ', fnStart + 10) : CARD.length);
    const flushAt = fn.indexOf('paymentsTabHandleRef.current?.flush()');
    const saveAt = fn.indexOf('card?.save?.(');
    expect(flushAt, 'карточка не сбрасывает несохранённые платежи перед закрытием — они теряются').toBeGreaterThan(-1);
    expect(saveAt, 'в saveAllAndClose не найден вызов сохранения карточки').toBeGreaterThan(-1);
    expect(flushAt, 'платежи сбрасываются ПОСЛЕ сохранения карточки — окно потери остаётся').toBeLessThan(saveAt);
  });

  it('не удалось сохранить платежи — карточка не закрывается', () => {
    expect(CARD, 'карточка закрывается даже при неудачном сохранении платежей').toContain(
      'Платежи не сохранены — карточка не закрыта',
    );
    expect(CARD, 'при неудаче платежей сохранение должно прерываться, а не идти дальше').toContain(
      'paymentsFlushed === false',
    );
  });

  it('карточка закрывается только после успешного сохранения', () => {
    // Закрытие живёт в `onSaveAndClose` и вызывается лишь по успеху промиса сохранения:
    // неуспех сохранения бросает исключение, и `.then(...)` не выполняется.
    expect(CARD, 'кнопка «Сохранить и выйти» не ждёт результата сохранения').toContain(
      'saveAllAndClose().then(',
    );
    expect(CARD, 'неуспех сохранения должен прерывать цепочку').toContain('catch(() => undefined)');
    expect(CARD, 'сохранение обязано бросать ошибку при неудаче — иначе карточка закроется').toContain(
      'throw new Error(msg);',
    );
  });

  it('вкладка платежей отдаёт результат сохранения и регистрирует ручку для карточки', () => {
    expect(PAYMENTS, 'сохранение платежей не возвращает результат — карточка не узнает об отказе').toContain(
      'async function save(): Promise<boolean>',
    );
    expect(PAYMENTS, 'вкладка не отдаёт карточке ручку сброса').toContain('registerHandle');
    expect(PAYMENTS, 'ручка не сбрасывает несохранённые платежи').toContain('flush: async () =>');
    expect(CARD, 'карточка не передаёт вкладке платежей ручку').toContain('registerHandle={(handle) => {');
  });
});
