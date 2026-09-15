import { and, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  ENGINE_INTERNAL_NUMBER_CODE,
  ENGINE_INTERNAL_NUMBER_YEAR_CODE,
  REPAIR_HISTORY_OPERATION_TYPE,
  formatEngineInternalNumber,
  formatWorkSheetValue,
  parseRepairHistoryMeta,
  pickHumanText,
  repairHistoryEntryType,
  type ReportCellValue,
  type ReportColumn,
  type ReportPresetFilters,
  type ReportPresetPreviewResult,
  type WorkSheetField,
} from '@matricarmz/shared';

import { operations } from '../../../database/schema.js';
import { asArray, msToDate, normalizeText, readPeriod } from '../format.js';
import { buildBrandFilterMatcher, getPreset, getWorkshops, loadSnapshot, resolveEngineBrandRef, type ReportBuildContext, type Snapshot } from '../context.js';
import { BRAND_MISSING, UNKNOWN_ENGINE_NUMBER_LABEL, buildOptions, relatedEntityLabel } from '../options.js';

/**
 * Отчёт «Ведомости работ» (15.09.2026): строки всех узлов по дате — те же записи истории
 * ремонта, что видит экран. Колонки = общие ∪ объединение колонок узлов, встретившихся в
 * выборке: новая колонка узла попадает в отчёт сама, потому что строка несёт подписи полей
 * с собой. Подписи человеческие: номер и марка двигателя, имя узла, название цеха.
 */

const HUMAN_DASH = '—';

function engineNumberLabel(attrs: Record<string, unknown>): string {
  return pickHumanText(attrs.engine_number) || UNKNOWN_ENGINE_NUMBER_LABEL;
}

function engineBrandLabel(snapshot: Snapshot, attrs: Record<string, unknown>): string {
  const brandId = normalizeText(attrs.engine_brand_id, '');
  return pickHumanText(relatedEntityLabel(snapshot, brandId), attrs.engine_brand) || BRAND_MISSING;
}

/**
 * Коды узлов из фильтра. Список — штатная форма (фильтр выбирается из справочника), но
 * строка через запятую тоже понимается: так этот фильтр был устроен в первом выпуске, и
 * сохранённые тогда шаблоны отчётов не должны молча перестать отбирать.
 */
function readNodeCodes(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw.map((v) => String(v)) : String(raw ?? '').split(',');
  return list.map((c) => c.trim().toLowerCase()).filter(Boolean);
}

/** Ключ колонки поля узла — префикс, чтобы не пересечься с общими ключами. */
export function workSheetFieldColumnKey(code: string): string {
  return `field_${code}`;
}

export async function buildWorkSheetsReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
  ctx?: ReportBuildContext,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const nodeFilter = readNodeCodes(filters?.nodeCodes);
  const brandFilter = asArray(filters?.brandIds);
  const workshopFilter = asArray(filters?.workshopIds);

  const snapshot = await loadSnapshot(db);
  const brandMatches = buildBrandFilterMatcher(brandFilter, new Map(buildOptions(snapshot, 'engine_brand').map((o) => [o.value, o.label] as const)));
  const workshops = await getWorkshops(ctx);
  const workshopNameById = new Map(workshops.map((w) => [w.id, w.name] as const));

  // Тип — в SQL, а не в цикле: без него скан поднимает ВСЕ операции вместе с их meta_json
  // (класс GOTCHAS M39 — чтение всех актов с meta_json стоило 1168 мс), а индекс
  // `operations(operation_type, deleted_at, updated_at)` не применяется вовсе. Проекция —
  // только читаемые ниже колонки, по образцу `getCompletenessActStartedMap` в `engines.ts`.
  const ops = await db
    .select({
      engineEntityId: operations.engineEntityId,
      metaJson: operations.metaJson,
      performedAt: operations.performedAt,
      performedBy: operations.performedBy,
      updatedAt: operations.updatedAt,
    })
    .from(operations)
    .where(and(eq(operations.operationType, REPAIR_HISTORY_OPERATION_TYPE), isNull(operations.deletedAt)))
    .limit(250_000);

  type Picked = { at: number; engineId: string; typeName: string; typeCode: string; workshopId: string; performedBy: string; note: string; fields: WorkSheetField[] };
  const picked: Picked[] = [];
  for (const row of ops as any[]) {
    const meta = parseRepairHistoryMeta(row.metaJson == null ? null : String(row.metaJson));
    if (!meta?.sheet || repairHistoryEntryType(meta, REPAIR_HISTORY_OPERATION_TYPE) !== 'sheet') continue;
    const at = meta.at ?? Number(row.performedAt ?? row.updatedAt ?? 0);
    if (period.startMs != null && at < period.startMs) continue;
    if (at > period.endMs) continue;
    if (nodeFilter.length > 0 && !nodeFilter.includes(meta.sheet.typeCode)) continue;
    const workshopId = meta.workshopId ?? '';
    if (workshopFilter.length > 0 && !workshopFilter.includes(workshopId)) continue;
    const engineId = String(row.engineEntityId ?? '');
    const attrs = snapshot.attrsByEntity.get(engineId) ?? {};
    if (!brandMatches(resolveEngineBrandRef(attrs))) continue;
    const performedBy = String(row.performedBy ?? '').trim();
    picked.push({
      at,
      engineId,
      typeName: meta.sheet.typeName,
      typeCode: meta.sheet.typeCode,
      workshopId,
      performedBy: performedBy === 'local' ? '' : performedBy,
      note: meta.note ?? '',
      fields: meta.sheet.fields,
    });
  }
  picked.sort((a, b) => b.at - a.at);

  // Динамические колонки — объединение полей узлов в порядке первого появления; подпись из
  // строки (она самоописываема), тип — для выравнивания чисел и дат.
  const fieldColumns = new Map<string, ReportColumn>();
  for (const p of picked) {
    for (const f of p.fields) {
      if (fieldColumns.has(f.code)) continue;
      fieldColumns.set(f.code, {
        key: workSheetFieldColumnKey(f.code),
        label: f.label,
        ...(f.type === 'number' ? { kind: 'number' as const, align: 'right' as const } : {}),
      });
    }
  }

  const rows: Array<Record<string, ReportCellValue>> = picked.map((p) => {
    const attrs = snapshot.attrsByEntity.get(p.engineId) ?? {};
    const row: Record<string, ReportCellValue> = {
      at: p.at,
      engineNumber: engineNumberLabel(attrs),
      engineInternalNumber: formatEngineInternalNumber(normalizeText(attrs[ENGINE_INTERNAL_NUMBER_CODE], ''), attrs[ENGINE_INTERNAL_NUMBER_YEAR_CODE]),
      engineBrand: engineBrandLabel(snapshot, attrs),
      nodeLabel: p.typeName || HUMAN_DASH,
      // Название цеха — по справочнику сервера; без него — прочерк, а не идентификатор.
      workshopLabel: p.workshopId ? workshopNameById.get(p.workshopId) ?? HUMAN_DASH : HUMAN_DASH,
      performedBy: p.performedBy || HUMAN_DASH,
      note: p.note,
    };
    for (const f of p.fields) {
      row[workSheetFieldColumnKey(f.code)] = f.type === 'number' && typeof f.value === 'number' ? f.value : formatWorkSheetValue(f);
    }
    return row;
  });

  const byNode = new Map<string, number>();
  for (const p of picked) byNode.set(p.typeName || HUMAN_DASH, (byNode.get(p.typeName || HUMAN_DASH) ?? 0) + 1);
  const totalsByGroup = Array.from(byNode.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'))
    .map(([group, count]) => ({ group, totals: { workSheetRows: count } }));

  const preset = getPreset('work_sheets');
  return {
    ok: true,
    presetId: 'work_sheets',
    title: preset.title,
    subtitle: `${msToDate(period.startMs)} — ${msToDate(period.endMs)}`,
    columns: [...preset.columns, ...fieldColumns.values()],
    rows,
    totals: { workSheetRows: rows.length, engines: new Set(picked.map((p) => p.engineId)).size },
    totalsByGroup,
    generatedAt: Date.now(),
  };
}

/** Последняя строка ведомости по каждому двигателю — колонки «Узел (последняя ведомость)» отчёта «Двигатели». */
export async function getLastSheetByEngine(db: BetterSQLite3Database): Promise<Map<string, { node: string; at: number }>> {
  const out = new Map<string, { node: string; at: number }>();
  // Этот скан идёт при ОБЫЧНОМ построении отчёта «Двигатели» (needSheet истинен, когда
  // колонки не выбраны), поэтому тип обязан быть в SQL — см. комментарий у скана выше.
  const ops = await db
    .select({
      engineEntityId: operations.engineEntityId,
      metaJson: operations.metaJson,
      performedAt: operations.performedAt,
      updatedAt: operations.updatedAt,
    })
    .from(operations)
    .where(and(eq(operations.operationType, REPAIR_HISTORY_OPERATION_TYPE), isNull(operations.deletedAt)))
    .limit(250_000);
  for (const row of ops as any[]) {
    const meta = parseRepairHistoryMeta(row.metaJson == null ? null : String(row.metaJson));
    if (!meta?.sheet) continue;
    const engineId = String(row.engineEntityId ?? '');
    const at = meta.at ?? Number(row.performedAt ?? row.updatedAt ?? 0);
    const prev = out.get(engineId);
    if (!prev || at > prev.at) out.set(engineId, { node: meta.sheet.typeName || HUMAN_DASH, at });
  }
  return out;
}
