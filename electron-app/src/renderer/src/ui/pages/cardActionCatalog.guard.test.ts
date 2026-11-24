import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { OBJECT_CAPABILITIES } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

/**
 * Сторож каталога действий по объекту: кнопки карточки собираются ИЗ КАТАЛОГА
 * (`buildCardActions`), а не руками в разметке.
 *
 * Проблема, которую он лечит: набор кнопок задавался в каждой карточке от руки, и у
 * разных карточек он разъезжался — кнопка, которой у объекта нет, оставалась видимой
 * («мёртвая кнопка»), а подпись одна и та же писалась по-разному. Каталог сделал набор
 * знанием домена (`OBJECT_CAPABILITIES`), но без гейта набор снова расползётся: новая
 * карточка соберёт кнопки руками — и разнобой вернётся тихо.
 *
 * Правила гейта:
 *  1. **ни одной ручной карточки** — список ручных карточек ИСЧЕРПЫВАЮЩИЙ и пуст:
 *     новая карточка «руками» = красный гейт;
 *  2. **тип объекта из домена** — `kind` карточки обязан быть ключом `OBJECT_CAPABILITIES`
 *     (опечатка в типе тихо гасит все кнопки карточки);
 *  3. **каталог не пустеет** — счётчик карточек зафиксирован: новая карточка с панелью
 *     действий обязана быть переведена.
 */

const pagesDir = __dirname;
const read = (file: string) => readFileSync(path.resolve(pagesDir, file), 'utf8');

/**
 * Карточки, которые ещё собирают кнопки руками (legacy-пропы `CardActionBar`).
 *
 * Список ИСЧЕРПЫВАЮЩИЙ: пока он непуст, новая ручная карточка — красный гейт. Карточки
 * из списка работают как раньше (legacy-пропы `CardActionBar` сохранены).
 */
const MANUAL_BUTTON_CARDS: readonly string[] = [];

/** Сколько карточек с панелью действий в проекте (счёт не должен молча разъехаться). */
const EXPECTED_CARD_COUNT = 12;

/** Карточка берёт кнопки из каталога? */
export function usesActionCatalog(src: string): boolean {
  return /actions=\{\s*buildCardActions\(/.test(src);
}

/** Карточка собирает кнопки руками? */
export function isManualButtonCard(src: string): boolean {
  return src.includes('<CardActionBar') && !usesActionCatalog(src);
}

/** Тип объекта, объявленный карточкой в каталоге. */
export function cardObjectKind(src: string): string | null {
  const at = src.indexOf('buildCardActions({');
  if (at === -1) return null;
  // Ищем тип рядом с вызовом каталога: в карточке бывают и другие `kind:` (например,
  // вид черновика «recovery»), и они не имеют отношения к типу объекта.
  const match = /kind:\s*'([a-z_]+)'/.exec(src.slice(at, at + 400));
  return match?.[1] ?? null;
}

const pageFiles = readdirSync(pagesDir).filter((f) => f.endsWith('.tsx'));
const cardFiles = pageFiles.filter((f) => read(f).includes('<CardActionBar'));

describe('каталог действий по объекту: карточки рисуют кнопки из каталога', () => {
  it('в проекте столько же карточек с панелью действий, сколько было', () => {
    expect(cardFiles.length, `карточек с панелью действий: ${cardFiles.join(', ')}`).toBe(
      EXPECTED_CARD_COUNT,
    );
  });

  it('ни одна карточка не собирает кнопки руками', () => {
    const manual = cardFiles.filter((f) => !MANUAL_BUTTON_CARDS.includes(f) && isManualButtonCard(read(f)));
    expect(
      manual,
      `карточки с ручной сборкой кнопок: ${manual.join(', ')} — переведи их на buildCardActions ` +
        '(набор задаёт домен, обработчики — карточка)',
    ).toEqual([]);
  });

  it('счётчик ручных карточек в списке исключений не больше, чем помечено', () => {
    const listed = MANUAL_BUTTON_CARDS.filter((f) => !cardFiles.includes(f));
    expect(listed, `в списке ручных карточек есть несуществующие: ${listed.join(', ')}`).toEqual([]);
  });

  it('тип объекта каждой карточки есть в домене (опечатка тихо гасит все кнопки)', () => {
    const known = Object.keys(OBJECT_CAPABILITIES);
    const bad: string[] = [];
    for (const file of cardFiles) {
      const kind = cardObjectKind(read(file));
      if (!kind) {
        bad.push(`${file}: не объявлен kind`);
        continue;
      }
      if (!known.includes(kind)) bad.push(`${file}: тип «${kind}» нет в OBJECT_CAPABILITIES`);
    }
    expect(bad, `типы объектов разошлись с доменом: ${bad.join('; ')}`).toEqual([]);
  });

  it('каждая карточка на каталоге объявляет, что кнопки приходят из него', () => {
    const withoutCatalog = cardFiles.filter(
      (f) => !MANUAL_BUTTON_CARDS.includes(f) && !usesActionCatalog(read(f)),
    );
    expect(withoutCatalog, `карточки без каталога: ${withoutCatalog.join(', ')}`).toEqual([]);
  });
});

describe('самопроверка гейта (краснеет на заведомо ручной карточке)', () => {
  it('детектор ловит ручную сборку кнопок', () => {
    const manual = `
      export function FakePage() {
        return <CardActionBar canEdit={true} onSave={() => { void save(); }} onDelete={() => {}} />;
      }
    `;
    expect(isManualButtonCard(manual), 'детектор не ловит ручную сборку').toBe(true);
  });

  it('детектор признаёт каталог', () => {
    const catalog = `
      export function FakePage() {
        return <CardActionBar actions={buildCardActions({ kind: 'tool', canEdit: true, handlers: {} })} />;
      }
    `;
    expect(isManualButtonCard(catalog), 'детектор считает каталог ручной сборкой').toBe(false);
    expect(cardObjectKind(catalog)).toBe('tool');
  });

  it('пустой список карточек ломает гейт, а не проходит молча', () => {
    expect(isManualButtonCard(''), 'пустой исходник не должен считаться карточкой').toBe(false);
    expect(cardFiles.length).toBeGreaterThan(0);
  });
});
