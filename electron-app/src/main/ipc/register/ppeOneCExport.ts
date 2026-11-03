/**
 * Выгрузка СИЗ для 1С: XLSX/CSV по фиксированной структуре (приложение №3).
 *
 * Файл читает бухгалтер и загружает в свою 1С. Структура колонок фиксирована
 * (см. `ppeOneCExportService`), в данных нет служебных идентификаторов — только
 * человекочитаемые названия.
 *
 * Данные берём из клиентской реплики (`ppe_*` и `erp_employee_cards`) тем же
 * источником, что и отчёты СИЗ: имя в выгрузке и в отчёте — одно и то же.
 */
import { ipcMain } from 'electron';
import { and, eq, isNull } from 'drizzle-orm';

import { requirePermOrResult } from '../ipcContext.js';
import {
  erpEmployeeCards,
  erpNomenclature,
  ppeCardNorms,
  ppeEmployeeCards,
  ppeIssueCards,
  ppeIssueEntries,
  ppeNormLineSpecs,
  ppeNormLines,
  ppeNormSets,
} from '../../database/schema.js';
import {
  buildPpeOneCIssuesCsv,
  buildPpeOneCIssuesWorkbook,
  buildPpeOneCNormsCsv,
  buildPpeOneCNormsWorkbook,
  type PpeOneCIssueRow,
  type PpeOneCNormRow,
} from '../../services/ppeOneCExportService.js';
import { saveExportFile } from './exports.js';
import type { IpcContext } from '../ipcContext.js';

type Err = { ok: false; error: string };

/**
 * Папка автосохранения для смоук-шоу: когда переменная задана, файл пишется прямо
 * в неё и ни одного нативного окна не показывается (иначе диалог «Сохранить как»
 * из CDP не нажать — вызов висит). В обычной работе переменной нет, и путь выбирает
 * оператор.
 */
function autoSaveDir(): string | null {
  const dir = String(process.env.MATRICA_EXPORT_AUTOSAVE_DIR ?? '').trim();
  return dir === '' ? null : dir;
}

export type PpeOneCExportKind = 'norms' | 'issues';

type EmployeeInfo = {
  personnelNo: string;
  fullName: string;
  postTitle: string;
  departmentName: string;
};

/** Размер позиции вытаскиваем из названия: «Костюм зимний, р. 52» → «52». */
function sizeOf(name: string): string {
  const m = String(name ?? '').match(/р\.\s*([\dA-Za-z]+)/);
  return m ? m[1] ?? '' : '';
}

export function registerPpeOneCExportIpc(ctx: IpcContext) {
  ipcMain.handle(
    'ppe:onec:export',
    async (
      _e,
      args: {
        kind: PpeOneCExportKind;
        format: 'xlsx' | 'csv';
        fromMs?: number;
        toMs?: number;
        period?: string;
        who?: string;
      },
    ) => {
      const gate = await requirePermOrResult(ctx, 'erp.dictionary.view');
      if (!gate.ok) return gate as Err;
      try {
        const db = ctx.dataDb();
        const kind: PpeOneCExportKind = args?.kind === 'issues' ? 'issues' : 'norms';
        const format: 'xlsx' | 'csv' = args?.format === 'csv' ? 'csv' : 'xlsx';
        const period = String(args?.period ?? '').trim();
        const who = String(args?.who ?? '').trim();

        // Сотрудники СИЗ: ФИО, табельный, должность.
        const empRows = await db
          .select({
            id: erpEmployeeCards.id,
            personnelNo: erpEmployeeCards.personnelNo,
            fullName: erpEmployeeCards.fullName,
            roleCode: erpEmployeeCards.roleCode,
          })
          .from(erpEmployeeCards)
          .where(isNull(erpEmployeeCards.deletedAt));
        const employees = new Map<string, EmployeeInfo>();
        for (const e of empRows) {
          employees.set(String(e.id), {
            personnelNo: String(e.personnelNo ?? ''),
            fullName: String(e.fullName ?? ''),
            postTitle: String(e.roleCode ?? ''),
            departmentName: '',
          });
        }

        // Подразделение и должность — из личной карточки СИЗ (снимок на момент).
        const cardRows = await db
          .select({
            employeeId: ppeEmployeeCards.employeeId,
            departmentName: ppeEmployeeCards.departmentName,
            postTitle: ppeEmployeeCards.postTitle,
            sizeClothes: ppeEmployeeCards.sizeClothes,
            sizeShoes: ppeEmployeeCards.sizeShoes,
            sizeGloves: ppeEmployeeCards.sizeGloves,
          })
          .from(ppeEmployeeCards)
          .where(isNull(ppeEmployeeCards.deletedAt));
        for (const c of cardRows) {
          const info = employees.get(String(c.employeeId));
          if (!info) continue;
          if (c.departmentName) info.departmentName = String(c.departmentName);
          if (c.postTitle) info.postTitle = String(c.postTitle);
        }

        // Названия позиций номенклатуры.
        const nomRows = await db
          .select({ id: erpNomenclature.id, name: erpNomenclature.name })
          .from(erpNomenclature);
        const nomName = new Map(nomRows.map((r) => [String(r.id), String(r.name ?? '')]));

        let rows: PpeOneCNormRow[] = [];
        let issueRows: PpeOneCIssueRow[] = [];
        let fileTitle = 'Нормы выдачи СИЗ';

        if (kind === 'norms') {
          // Справочник: что положено сотруднику. Связь: карточка выдачи → назначенные
          // наборы норм (ppe_card_norms) → строки набора (ppe_norm_lines).
          const assigned = await db
            .select({
              employeeId: ppeIssueCards.employeeId,
              normSetId: ppeCardNorms.normSetId,
            })
            .from(ppeCardNorms)
            .innerJoin(ppeIssueCards, eq(ppeCardNorms.cardId, ppeIssueCards.id))
            .where(and(isNull(ppeCardNorms.deletedAt), isNull(ppeIssueCards.deletedAt)));
          const byEmployee = new Map<string, Set<string>>();
          for (const a of assigned) {
            const key = String(a.employeeId);
            const set = byEmployee.get(key) ?? new Set<string>();
            set.add(String(a.normSetId));
            byEmployee.set(key, set);
          }
          const normRows = await db
            .select({
              normSetId: ppeNormLines.normSetId,
              nomenclatureId: ppeNormLines.nomenclatureId,
              qty: ppeNormLines.qty,
              wearMonths: ppeNormLines.wearMonths,
              wearKind: ppeNormLines.wearKind,
              unit: ppeNormLines.unit,
              sourceLabel: ppeNormLineSpecs.sourceLabel,
              ppeType: ppeNormLineSpecs.ppeType,
              itemName: ppeNormLineSpecs.name,
              setSourceLabel: ppeNormSets.sourceLabel,
            })
            .from(ppeNormLines)
            .leftJoin(ppeNormLineSpecs, eq(ppeNormLines.specId, ppeNormLineSpecs.id))
            .leftJoin(ppeNormSets, eq(ppeNormLines.normSetId, ppeNormSets.id))
            .where(isNull(ppeNormLines.deletedAt));
          const linesBySet = new Map<string, typeof normRows>();
          for (const row of normRows) {
            const key = String(row.normSetId);
            const list = linesBySet.get(key) ?? [];
            list.push(row);
            linesBySet.set(key, list);
          }
          for (const [employeeId, setIds] of byEmployee) {
            const info = employees.get(employeeId);
            if (!info) continue;
            for (const setId of setIds) {
              for (const row of linesBySet.get(setId) ?? []) {
                const itemName = row.itemName || nomName.get(String(row.nomenclatureId)) || '';
                const wearPeriod =
                  row.wearKind === 'until_wearout'
                    ? 'до износа'
                    : row.wearKind === 'by_manufacturer'
                      ? 'по документам изготовителя'
                      : row.wearMonths != null
                        ? `${row.wearMonths} мес.`
                        : '';
                rows.push({
                  personnelNo: info.personnelNo,
                  fullName: info.fullName,
                  postTitle: info.postTitle,
                  departmentName: info.departmentName,
                  itemName,
                  sourceLabel: row.sourceLabel ?? row.setSourceLabel ?? '',
                  ppeType: row.ppeType ?? '',
                  unit: row.unit ?? 'шт.',
                  qty: Number(row.qty),
                  wearPeriod,
                  size: sizeOf(nomName.get(String(row.nomenclatureId)) ?? ''),
                });
              }
            }
          }
        } else {
          fileTitle = 'Выдача СИЗ за период';
          const from = Number(args?.fromMs ?? 0);
          const to = Number(args?.toMs ?? Number.MAX_SAFE_INTEGER);
          const entries = await db
            .select({
              cardId: ppeIssueEntries.cardId,
              nomenclatureId: ppeIssueEntries.nomenclatureId,
              qty: ppeIssueEntries.qty,
              issuedAt: ppeIssueEntries.issuedAt,
              employeeId: ppeIssueCards.employeeId,
            })
            .from(ppeIssueEntries)
            .innerJoin(ppeIssueCards, eq(ppeIssueEntries.cardId, ppeIssueCards.id))
            .where(and(isNull(ppeIssueEntries.deletedAt), isNull(ppeIssueCards.deletedAt)));
          for (const e of entries) {
            if (e.issuedAt < from || e.issuedAt > to) continue;
            const info = employees.get(String(e.employeeId));
            if (!info) continue;
            const name = nomName.get(String(e.nomenclatureId)) ?? '';
            issueRows.push({
              personnelNo: info.personnelNo,
              fullName: info.fullName,
              postTitle: info.postTitle,
              departmentName: info.departmentName,
              itemName: name,
              size: sizeOf(name),
              qty: Number(e.qty),
              issuedAt: Number(e.issuedAt),
              documentNo: '',
              wearPeriod: '',
            });
          }
        }

        const build =
          kind === 'norms'
            ? format === 'csv'
              ? async () => buildPpeOneCNormsCsv({ rows })
              : async () => buildPpeOneCNormsWorkbook({ period, who, rows })
            : format === 'csv'
              ? async () => buildPpeOneCIssuesCsv({ rows: issueRows })
              : async () => buildPpeOneCIssuesWorkbook({ period, who, rows: issueRows });

        const rowCount = kind === 'norms' ? rows.length : issueRows.length;

        const result = await saveExportFile({
          ctx,
          autoDir: autoSaveDir(),
          dialogTitle: format === 'csv' ? 'Сохранить выгрузку для 1С (CSV)' : 'Сохранить выгрузку для 1С (Excel)',
          baseName: `${fileTitle}${period ? ` ${period}` : ''}`,
          ext: format === 'csv' ? '.csv' : '.xlsx',
          filterName: format === 'csv' ? 'CSV (разделитель ;)' : 'Книга Excel',
          build,
        });
        if (result.ok) ctx.logToFile(`[ppe:onec] ${kind}/${format} → ${result.name} (${rowCount} строк)`);
        return result;
      } catch (e) {
        const message = String(e);
        ctx.logToFile(`[ppe:onec] ошибка: ${message}`);
        return { ok: false as const, error: message };
      }
    },
  );
}
