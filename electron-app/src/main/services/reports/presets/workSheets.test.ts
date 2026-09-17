import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';


// Оба скана этого файла ходят по `operations` — таблице, где лежит вся история завода, и
// самая тяжёлая её колонка `meta_json`. Пока тип строки проверялся в цикле, а не в SQL,
// отчёт поднимал ВСЕ операции ради нескольких строк этапов работ (класс GOTCHAS M39), причём
// второй скан идёт при обычном построении отчёта «Двигатели», а не только по требованию.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const SRC = src('./workSheets.ts');

describe('отчёт «Этапы работ» — сканы operations', () => {
  it('тип строки отбирается в SQL, а не в цикле, и колонки проецируются', () => {
    const scans = SRC.split('.from(operations)').length - 1;
    expect(scans, 'скан operations в файле один — и он обязан быть узким').toBe(1);
    expect(
      SRC.split('eq(operations.operationType, REPAIR_HISTORY_OPERATION_TYPE)').length - 1,
      'тип в where у скана',
    ).toBe(1);
    expect(SRC, 'звёздочка по operations поднимает meta_json всей истории').not.toContain('.select()\n    .from(operations)');
    expect(SRC).toContain('metaJson: operations.metaJson');
  });
});
