import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { hasBlockingDuplicate } from './DuplicateWarningDialog.js';

// Владелец 22.09.2026: «нельзя позволять создать дубль… предлагать перейти в существующий
// объект». Дыра была не в поиске дублей, а в кнопке «Всё равно сохранить как новую»: окно
// честно предупреждало и тут же давало создать вторую запись. Сторож держит две вещи —
// что кнопка исчезает при жёстком дубле и что переход из окна никуда не упирается.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const DIALOG = src('./DuplicateWarningDialog.tsx');
const APP = src('../App.tsx');

describe('окно дублей не даёт создать жёсткий дубль', () => {
  it('кандидат с причиной блокировки делает окно блокирующим', () => {
    const plain = { id: 'a', displayName: 'Вал', score: 720, attributes: {} };
    const blocking = { id: 'b', displayName: 'Вал', score: 980, attributes: {}, blockReason: 'same-article' as const };
    expect(hasBlockingDuplicate([plain])).toBe(false);
    expect(hasBlockingDuplicate([plain, blocking])).toBe(true);
    expect(hasBlockingDuplicate([])).toBe(false);
  });

  it('«Всё равно сохранить как новую» нарисована только когда блокировки нет', () => {
    // Кнопку именно НЕ рисуем, а не гасим: видимая неработающая кнопка читается
    // оператором как сбой программы, а не как запрет.
    expect(DIALOG).toMatch(/\{!blocked && \(/);
    expect(DIALOG).toContain('Всё равно сохранить как новую');
  });

  it('у заблокированного кандидата есть ход вперёд — открыть существующую', () => {
    expect(DIALOG).toContain('Открыть существующую');
    expect(DIALOG).toMatch(/onAction\('open', c\.id\)/);
  });

  it('каждая карточка справочника умеет выполнить этот переход', () => {
    // Кнопка без прокинутого onOpenEntity молча ничего не делает, а сохранение при этом
    // уже отменено — оператор оказывается в тупике. Все точки монтирования обязаны его дать.
    const mounts = APP.split('<SimpleMasterdataDetailsPage').slice(1);
    expect(mounts.length).toBeGreaterThanOrEqual(4);
    for (const [i, mount] of mounts.entries()) {
      const props = mount.slice(0, mount.indexOf('/>'));
      expect(props, `монтирование #${i + 1} карточки справочника без onOpenEntity`).toContain('onOpenEntity');
    }
  });
});
