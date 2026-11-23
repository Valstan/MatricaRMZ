import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Блок подписей в печатной форме (владелец 23.11.2026): «блок подписей нужно сделать
// редактируемым, чтобы можно было добавлять другие подписи, с другими людьми, с
// другими профессиями, должностями. Добавлять и удалять подписи… открыли
// производственную программу на печать, и там надо добавить ещё одну подпись, а мы
// не можем, никак».
//
// До правки блок был списком галочек «печатать / не печатать»: убрать подпись можно
// было, а добавить — нет. Сторож держит именно эту разницу и три вещи, на которых
// она держится:
//  1. состав подписей РЕДАКТИРУЕТСЯ в печатной форме (должность, человек, ФИО);
//  2. отбор строк подписей идёт по КЛЮЧУ строки, а не по названию должности
//     (должность меняется при правке — отбор по названию молча терял бы строку);
//  3. состав — это ДАННЫЕ программы: он уходит в программу и в выгрузку файлом.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const EDITOR = src('./SignatureSlotsEditor.tsx');
const PREVIEW = src('./ProductionProgramPrintPreview.tsx');
const PAGE = src('../pages/ProductionProgramPage.tsx');
const PRINT_HTML = src('../utils/productionProgramPrintHtml.ts');
const SHARED_DOMAIN = src('../../../../../../shared/src/domain/productionProgram.ts');

describe('печатная форма — блок подписей редактируемый', () => {
  it('в печатной форме блок подписей правится: должность, человек, ФИО', () => {
    expect(PREVIEW).toContain('SignatureSlotsEditor');
    expect(PREVIEW).toContain('+ Добавить подпись');
    expect(EDITOR).toContain('Должность');
    expect(EDITOR).toContain('EntityReferenceField');
    expect(EDITOR).toContain('ФИО от руки');
  });

  it('строки подписей удаляются, а порядок — общим китом списков', () => {
    expect(EDITOR).toContain('removeRow');
    expect(EDITOR).toContain('Убрать подпись');
    expect(EDITOR).toContain('useListReorder');
    expect(EDITOR).toContain('ListReorderHandle');
    expect(EDITOR, 'строки блока подписей не помечены для кита').toContain('data-list-row-key');
  });

  it('отбор «печатать / не печатать» идёт по ключу строки, а не по должности', () => {
    // Должность — меняемое название; отбор по названию после правки молча терял бы
    // строку (галочка «печать» слетала). Ключ строки живёт рядом с должностью.
    expect(PREVIEW).toContain('printedIds');
    expect(PREVIEW).toContain('togglePrinted');
    expect(PRINT_HTML).not.toContain('signatureCaptions');
  });

  it('состав подписей — данные программы: уходит в программу и в выгрузку', () => {
    expect(PAGE).toContain('productionProgramSignatureSlotsFromRaw');
    expect(PAGE).toContain('onSignatureSlotsChange');
    expect(PAGE).toContain('signatureSlots: programSignatureSlots');
    expect(PAGE, 'состав подписей не уходит в программу — правка потеряется').toContain(
      'setHeader({ signatureSlots: JSON.stringify(slots) })',
    );
  });

  it('домен не режет лишние слоты и не возвращает удалённые', () => {
    // Раньше сохранённое накладывалось на образец: своя должность выбрасывалась, а
    // удалённая строка возвращалась сама — «добавить подпись» было невозможно.
    expect(SHARED_DOMAIN).toContain('export function productionProgramSignatureSlotsFromRaw');
    expect(SHARED_DOMAIN).toContain('if (saved != null) return saved.map((slot) => ({ ...slot }));');
  });
});
