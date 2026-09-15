import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Ведомости работ (15.09.2026) рвутся молча в четырёх местах: вкладка исчезает из меню
// (реестр разделов), строка уходит не в main-сервис (и «Отремонтирован» не ставится),
// скрытая панель остаётся на экране (M78), список теряет счётчик и «№».
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('./WorkSheetsPage.tsx');
const ROW_DIALOG = src('../components/WorkSheetRowDialog.tsx');
const TYPE_DIALOG = src('../components/WorkSheetTypeEditorDialog.tsx');
const APP = src('../App.tsx');
const SECTIONS = src('../../../../../../shared/src/domain/uiSections.ts');
const ACCESS = src('../../../../../../shared/src/domain/sectionAccess.ts');
const GATE = src('../../../../main/ipc/sectionGate.ts');
const SERVICE = src('../../../../main/services/workSheetService.ts');
const IPC = src('../../../../main/ipc/register/workSheets.ts');
const ANDROID_WIRING = src('../../../../../../android-app/src/core/ipcWiring.ts');
const CACHE = src('../utils/workSheetTypesCache.ts');

describe('ведомости работ — экран', () => {
  it('вкладка заведена в реестре разделов, меню и приложении под правом на операции', () => {
    expect(SECTIONS).toContain("work_sheets: 'Ведомости работ'");
    expect(SECTIONS).toContain("production: ['engines', 'work_sheets'");
    expect(ACCESS).toContain("menuTabs: ['engines', 'work_sheets'");
    expect(APP).toContain("...(caps.canViewOperations ? (['work_sheets'] as const) : [])");
    expect(APP).toContain("{t === 'work_sheets' && (");
    expect(GATE, 'IPC ведомостей гейтится разделом «Производство»').toContain("['workSheets:', 'production']");
  });

  it('запись в ведомости — отдельное право, и раздельный уровень у секционного гейта', () => {
    expect(APP, 'строки и узлы — одно право, кнопка не врёт про доступ').toContain(
      'canEdit={caps.canEditWorkSheets} canManageTypes={caps.canEditWorkSheets}',
    );
    expect(IPC, 'запись — work_sheets.edit, а не operations.edit мастеров').toContain(
      "requirePermOrResult(ctx, 'work_sheets.edit')",
    );
    expect(IPC, 'чтение остаётся правом истории').toContain("requirePermOrResult(ctx, 'operations.view')");
    expect(IPC, 'erp.dictionary.edit больше не при чём').not.toContain('erp.dictionary.edit');
    for (const ch of ['workSheets:rows:save', 'workSheets:rows:delete', 'workSheets:types:upsert']) {
      expect(GATE, `наблюдателю раздела запись ${ch} закрыта`).toContain(`'${ch}'`);
    }
  });

  it('домен ведомостей подключён и на планшете — плитка без IPC открывалась и молчала', () => {
    expect(ANDROID_WIRING).toContain('registerWorkSheetsIpc(ctx);');
  });

  it('вкладки узлов на CardTabs, панели смонтированы и скрыты hidden без инлайнового display', () => {
    expect(PAGE).toContain('<CardTabs');
    expect(PAGE).toContain('hidden={activeTab !== tab.key}');
    expect(PAGE).toContain("...(activeTab === tab.key ? { display: 'flex', flexDirection: 'column' } : {})");
  });

  it('список — на общей обвязке: счётчик, «№», ступени по колонкам узла', () => {
    expect(PAGE).toContain('<ListCount');
    expect(PAGE).toContain('<RowNumberHeaderCell');
    expect(PAGE).toContain('rowNumbers');
    expect(PAGE).toContain('workSheetFacets(type?.columns ?? [])');
  });

  it('строка пишется через main-сервис, id даёт клиент — правка бьёт в ту же запись', () => {
    expect(ROW_DIALOG).toContain('window.matrica.workSheets.rows.save(');
    expect(ROW_DIALOG).toContain('const id = props.row?.id ?? crypto.randomUUID();');
    expect(ROW_DIALOG, 'строка не переезжает на другой двигатель').toContain('disabled={editing}');
  });

  it('завершение ремонта — один раз при добавлении, той же формой автозаписи, что у карточки', () => {
    expect(SERVICE).toContain("if (created && input.type.completesRepair === true)");
    expect(SERVICE).toContain("advanceEngineStatusForWorkOrder(db, engineId, 'status_repaired', atMs, actor)");
    expect(SERVICE).toContain("repairHistoryMetaForStatus('status_repaired', atMs)");
    expect(SERVICE).toContain("if (current.status_repaired) return { applied: false, reason: 'already-repaired' };");
  });

  // Идентификатор не заменяет подпись: огрызок uuid в колонке «Двигатель» и голый uuid в
  // колонке «Цех» читаются как испорченные данные, а не как «подписи нет».
  it('на экран не уходит идентификатор: ни огрызок uuid двигателя, ни uuid цеха', () => {
    expect(PAGE, 'огрызок uuid двигателя убран').not.toContain('engineId.slice(0, 8)');
    expect(PAGE).toContain('return r.engineNumber || HUMAN_LABEL_NO_NUMBER;');
    expect(PAGE, 'цех: справочник → снимок строки → прочерк').toContain(
      "return fromDirectory(r.workshopId) || r.workshopName || HUMAN_LABEL_DASH;",
    );
    expect(SERVICE, 'снимок имени цеха отдаётся из самой строки').toContain("workshopName: meta.workshopName ?? ''");
  });

  it('справочник узлов недоступен — экран говорит это вслух, а не показывает пустоту', () => {
    expect(PAGE).toContain("typesSource === 'none'");
    expect(PAGE).toContain('data-work-sheet-types-unavailable');
    expect(CACHE, 'три состояния источника, а не флаг «из кэша»').toContain("source: (cached.length > 0 ? 'cache' : 'none')");
  });

  it('правка строки без справочника узлов: колонки восстанавливаются из полей самой строки', () => {
    expect(ROW_DIALOG).toContain('const rowColumns = useMemo<WorkSheetColumn[]>(');
    expect(ROW_DIALOG, 'форма рисует восстановленный набор, а не только колонки узла').toContain('{columns.map((col) => (');
    expect(ROW_DIALOG, 'статус при правке не ставится — подставлять чужой completesRepair нельзя').toContain(
      'completesRepair: false',
    );
    expect(ROW_DIALOG, 'имя цеха уезжает снимком вместе со строкой').toContain(
      'workshopName: props.workshops.find((w) => w.id === workshopId)?.label ?? null,',
    );
  });

  it('код узла и код колонки после создания заморожены — на них ссылаются строки', () => {
    expect(TYPE_DIALOG).toContain('Код заморожен');
    expect(TYPE_DIALOG).toContain('workSheetCodeFromName(label)');
  });
});
