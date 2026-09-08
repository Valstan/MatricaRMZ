import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// История ремонта рвётся молча в трёх местах, и ни одно из них не видят типы:
//  1) автозапись стадии не доходит до `operations` — история просто не пополняется;
//  2) дата, введённая задним числом, теряется: `operations.add` даты не принимает, и без
//     переноса в meta событие ложится сегодняшним днём;
//  3) список перестаёт читать историю — ступени «Последнее событие» и «Цех» показывают
//     карточку вместо фактического движения.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const PANEL = src('./EngineRepairHistoryPanel.tsx');
const CARD = src('../pages/EngineDetailsPage.tsx');
const SERVICE = src('../../../../main/services/engineService.ts');
const APP = src('../App.tsx');

describe('история ремонта пишется', () => {
  it('панель заводит ручную запись через operations', () => {
    expect(PANEL).toContain('window.matrica.operations.add(');
    expect(PANEL).toContain('REPAIR_HISTORY_OPERATION_TYPE');
  });

  it('дата события уезжает в meta — иначе запись задним числом ляжет сегодняшним днём', () => {
    expect(PANEL).toContain('...(Number.isFinite(typed) ? { at: typed } : {})');
  });

  it('действие вводится свободно, а не выбирается из закрытого списка', () => {
    expect(PANEL).toContain('list="repair-history-actions"');
    expect(PANEL).toContain('<datalist id="repair-history-actions">');
  });

  it('карточка пишет автозапись при взведённой стадии — и только при взведённой', () => {
    expect(CARD).toContain('repairHistoryMetaForStatus(code as StatusCode)');
    expect(CARD, 'снятая галочка — это исправление ошибки, а не событие истории').toContain(
      "if (value !== true || !STATUS_CODES.includes(code as StatusCode)) continue;",
    );
  });

  it('автоматические записи помечены — оператор не должен принимать их за свои', () => {
    expect(PANEL).toContain("entry.source === 'auto'");
    expect(PANEL).toContain('data-repair-history-row={entry.source}');
  });
});

describe('история доезжает до списка', () => {
  it('сервис списка собирает историю по двигателям', () => {
    expect(SERVICE).toContain('const historyByEngineId = await getEngineRepairHistoryMap(db, engineIds);');
    expect(SERVICE, 'читаем только строки истории и переезды — прочих операций у двигателя больше всего').toContain(
      "inArray(operations.operationType, [REPAIR_HISTORY_OPERATION_TYPE, 'workshop_transfer'])",
    );
  });

  it('цех истории важнее атрибута карточки', () => {
    expect(SERVICE).toContain("...(history?.workshopId || workshopId ? { workshopId: history?.workshopId || workshopId } : {})");
  });

  it('последнее событие и его дата попадают в строку списка', () => {
    expect(SERVICE).toContain('lastHistoryAction: history.lastAction');
    expect(SERVICE).toContain('lastHistoryAt: history.lastAt');
  });

  // M118: список заменяется только если подпись строки изменилась. Поля, которые меняются БЕЗ
  // правки самой сущности (операции!), обязаны быть в подписи — иначе свежий список признаётся
  // тем же самым и отбрасывается, а оператор видит «событий нет» сразу после записи события.
  it('поля ступеней входят в подпись строки списка', () => {
    for (const field of ['e.hasDefectAct', 'e.defectDate', 'e.workshopId', 'e.lastHistoryAction', 'e.lastHistoryAt']) {
      expect(APP, `${field} нет в engineRowSignature — свежий список будет отброшен`).toContain(field);
    }
  });
});
