import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const pagesDir = __dirname;
const read = (file: string) => readFileSync(path.resolve(pagesDir, file), 'utf8');

/**
 * «Сохранить и выйти» на карточке обязана закрывать карточку ТОЛЬКО после того, как
 * внесённое легло в базу. Иначе кнопка уносит правки оператора вместе с карточкой
 * (жалоба владельца 01.11.2026: «просто выходит, закрывает, без сохранения»).
 *
 * Проверка идёт по ВСЕМ карточкам с такой кнопкой — список исчерпывающий: новая
 * карточка добавляется сюда же, иначе кнопка в ней останется без защиты.
 */

/** Карточки, где сохранение возвращает результат, и закрытие стоит под ним. */
const GATED_ON_RESULT: Array<[string, string]> = [
  ['ContractDetailsPage.tsx', 'if (ok) props.onClose()'],
  ['CounterpartyDetailsPage.tsx', 'if (ok) props.onClose()'],
  ['EmployeeDetailsPage.tsx', 'if (ok) props.onClose()'],
  ['EngineAssemblyBomDetailsPage.tsx', 'if (await saveBom()) props.onClose()'],
  ['EngineBrandDetailsPage.tsx', 'if (ok) props.onClose()'],
  ['SupplyRequestDetailsPage.tsx', 'if (ok) props.onClose()'],
  ['ToolDetailsPage.tsx', 'if (ok) props.onBack()'],
  ['ToolPropertyDetailsPage.tsx', 'if (!(await saveAll())) return;'],
  ['NomenclatureDetailsPage.tsx', 'if (ok) props.onClose();'],
  ['StockDocumentDetailsPage.tsx', 'if (ok) props.onClose();'],
];

/** Карточки, где сохранение бросает исключение при неудаче — закрытия тогда не будет. */
const GATED_BY_THROW: Array<[string, string]> = [
  // Двигатель: saveAllAndClose бросает при неудаче, а платежи сбрасываются до сохранения.
  ['EngineDetailsPage.tsx', 'catch(() => undefined)'],
  // Группа марок: закрытие внутри try, после успешной записи.
  ['EngineBrandGroupDetailsPage.tsx', 'if (thenClose) {'],
];

describe('Карточки: «Сохранить и выйти» закрывает только после успешного сохранения', () => {
  it('список карточек в стороже не пуст и покрывает все кнопки', () => {
    const files = readdirSync(pagesDir).filter((f) => f.endsWith('.tsx'));
    const withButton = files.filter((f) => read(f).includes('Сохранить и выйти'));
    // Наряд и простые справочники проверяются отдельными тестами ниже.
    const covered = new Set([
      ...GATED_ON_RESULT.map(([f]) => f),
      ...GATED_BY_THROW.map(([f]) => f),
      'WorkOrderDetailsPage.tsx',
      'SimpleMasterdataDetailsPage.tsx',
    ]);
    const missed = withButton.filter((f) => !covered.has(f));
    expect(missed, `карточки с кнопкой «Сохранить и выйти» вне сторожа: ${missed.join(', ')}`).toEqual([]);
  });

  for (const [file, marker] of GATED_ON_RESULT) {
    it(`${file}: закрытие под успехом сохранения`, () => {
      expect(read(file), `${file}: не найдено «${marker}»`).toContain(marker);
    });
  }

  for (const [file, marker] of GATED_BY_THROW) {
    it(`${file}: неудача сохранения оставляет карточку открытой`, () => {
      expect(read(file), `${file}: не найдено «${marker}»`).toContain(marker);
    });
  }

  it('WorkOrderDetailsPage: неуспех сохранения оставляет карточку открытой', () => {
    const src = read('WorkOrderDetailsPage.tsx');
    const at = src.indexOf('onSaveAndClose={');
    expect(at, 'нет обработчика «Сохранить и выйти»').toBeGreaterThan(-1);
    const block = src.slice(at, at + 700);
    expect(block, 'результат сохранения наряда не проверяется — карточка закроется и унесёт правки').toContain(
      'const ok = await flushSave(payload);',
    );
    expect(block, 'при неудаче наряда карточка всё равно закрывается').toContain('if (!ok) return;');
  });

  it('SimpleMasterdataDetailsPage: без рекурсии и закрытие после успешной записи', () => {
    const src = read('SimpleMasterdataDetailsPage.tsx');
    const checkStart = src.indexOf('async function checkDuplicatesBeforeSave');
    const saveAllStart = src.indexOf('async function saveAll()');
    expect(checkStart, 'не найдена проверка дублей').toBeGreaterThan(-1);
    expect(saveAllStart, 'не найдена запись карточки').toBeGreaterThan(-1);
    const checkBody = src.slice(checkStart, saveAllStart);
    expect(
      checkBody,
      'проверка дублей зовёт saveAllAndClose, а тот зовёт её же — бесконечная рекурсия (кнопка ничего не делает)',
    ).not.toContain('saveAllAndClose()');
    expect(checkBody, 'после проверки дублей карточка должна писать и закрываться сама').toContain(
      "if (action === 'saveAndClose') props.onClose();",
    );
    const at = src.indexOf('onSaveAndClose={');
    const block = src.slice(at, at + 400);
    expect(block, 'кнопка закрывает карточку безусловно — неудача записи унесёт правки').not.toContain(
      '.then(() => props.onClose())',
    );
  });
});
