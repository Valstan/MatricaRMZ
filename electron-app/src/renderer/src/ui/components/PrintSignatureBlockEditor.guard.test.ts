import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Подписи печатных форм (заказ владельца 23.11.2026): «в печатной форме блок подписей
// нужно сделать редактируемым… добавлять и удалять подписи».
//
// Сторож держит три вещи:
//  1. правило подписей — **общее** (домен + общий редактор), а не копия в ПП;
//  2. ПП этим правилом пользуется: превью правит состав, а правка уходит в документ;
//  3. корень не возвращается: сохранённые слоты не отбрасываются в пользу ролей
//     по умолчанию (иначе добавленная подпись снова исчезнет).

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const DOMAIN = src('../../../../../../shared/src/domain/printSignatures.ts');
const PP_DOMAIN = src('../../../../../../shared/src/domain/productionProgram.ts');
const EDITOR = src('./PrintSignatureBlockEditor.tsx');
const PREVIEW = src('./ProductionProgramPrintPreview.tsx');
const PAGE = src('../pages/ProductionProgramPage.tsx');

describe('подписи печатных форм — общий слой', () => {
  it('правило слотов — одно на программу, а не копия в каждой форме', () => {
    expect(DOMAIN, 'общий домен подписей').toContain('export function resolvePrintSignatureSlots(');
    expect(DOMAIN).toContain('export function addPrintSignatureSlot(');
    expect(DOMAIN).toContain('export function updatePrintSignatureSlot(');
    expect(DOMAIN).toContain('export function removePrintSignatureSlot(');
    // ПП берёт общее правило, а не свою копию.
    expect(PP_DOMAIN).toContain('resolvePrintSignatureSlots');
    expect(PP_DOMAIN, 'у ПП не должно быть своей копии правила').not.toContain(
      'PRODUCTION_PROGRAM_SIGNATURE_SLOTS.map((def) => {\n    const stored',
    );
  });

  it('сохранённые слоты не отбрасываются в пользу ролей по умолчанию', () => {
    // Прежде здесь возвращались ТОЛЬКО роли по умолчанию — добавленная подпись исчезала.
    expect(DOMAIN).toContain('if (saved == null)');
    expect(PP_DOMAIN).toContain('return resolvePrintSignatureSlots(saved, defaults);');
  });

  it('общий редактор умеет добавить, изменить и удалить подпись', () => {
    expect(EDITOR).toContain('+ Добавить подпись');
    expect(EDITOR).toContain('Удалить');
    expect(EDITOR).toContain('EntityReferenceField');
    expect(EDITOR, 'ФИО можно вписать от руки').toContain('ФИО');
  });

  it('ПП печатает через общий редактор, а правка уходит в документ', () => {
    expect(PREVIEW).toContain('PrintSignatureBlockEditor');
    expect(PREVIEW).toContain('onSignatureSlotsChange');
    expect(PAGE, 'состав подписей — данные программы').toContain('serializePrintSignatureSlots');
    expect(PAGE).toContain('onSignatureSlotsChange=');
    // Слоты программы достаются в печатный вход — иначе правка не дошла бы до печати.
    expect(PAGE).toContain('parseProductionProgramSignatureSlots(selected.signatureSlots)');
  });
});
