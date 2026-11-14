import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { isNull } from 'drizzle-orm';

import {
  childActivityState,
  childAgeYears,
  childGenderLabelRu,
  childTagsLabelRu,
  parseChildTags,
  pickHumanText,
  type ReportCellValue,
  type ReportPresetFilters,
  type ReportPresetPreviewResult,
} from '@matricarmz/shared';

import { erpEmployeeChildren, erpGiftRecords } from '../../../database/schema.js';
import { asNumberOrNull, normalizeText, readPeriod, msToDate } from '../format.js';
import { getIdsByType, getPreset, loadSnapshot } from '../context.js';
import { UNKNOWN_ENTITY_LABEL } from '../options.js';

/**
 * Отчёт «Дети сотрудников»: карточки детей с родителем, возрастом, признаками
 * отбора, состоянием и числом подарков, выданных в этом году.
 *
 * Возраст считается здесь же, от даты рождения: в строке его нет, и хранить его
 * значило бы завести вторую правду, которая разъедется с датой.
 */
export async function buildChildrenRosterReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const stateFilter = normalizeText(filters?.state, 'all');
  const snapshot = await loadSnapshot(db);

  const children = await db.select().from(erpEmployeeChildren).where(isNull(erpEmployeeChildren.deletedAt));
  const gifts = await db.select().from(erpGiftRecords).where(isNull(erpGiftRecords.deletedAt));
  const now = Date.now();
  const year = new Date(now).getFullYear();

  const giftsThisYearByChild = new Map<string, number>();
  for (const gift of gifts) {
    const childId = gift.recipientChildId ? String(gift.recipientChildId) : '';
    if (!childId) continue;
    const at = Number(gift.givenAt ?? 0);
    if (!Number.isFinite(at) || at <= 0) continue;
    if (new Date(at).getFullYear() !== year) continue;
    giftsThisYearByChild.set(childId, (giftsThisYearByChild.get(childId) ?? 0) + 1);
  }

  const rows: Array<Record<string, ReportCellValue>> = [];
  for (const child of children) {
    const birthDate = child.birthDate == null ? null : Number(child.birthDate);
    if (birthDate != null) {
      if (period.startMs != null && birthDate < period.startMs) continue;
      if (birthDate > period.endMs) continue;
    } else if (period.startMs != null) {
      continue;
    }
    const employeeId = child.employeeId ? String(child.employeeId) : '';
    const attrs = employeeId ? (snapshot.attrsByEntity.get(employeeId) ?? {}) : {};
    const parentName = employeeId
      ? pickHumanText(
          attrs.full_name,
          [normalizeText(attrs.last_name, ''), normalizeText(attrs.first_name, ''), normalizeText(attrs.middle_name, '')]
            .filter(Boolean)
            .join(' ')
            .trim(),
        ) || UNKNOWN_ENTITY_LABEL
      : '';
    const state = childActivityState({
      employmentStatus: normalizeText(attrs.employment_status, ''),
      terminationDate: asNumberOrNull(attrs.termination_date),
    });
    if (stateFilter !== 'all' && state !== stateFilter) continue;

    const age = childAgeYears(birthDate, now);
    rows.push({
      fullName: String(child.fullName ?? ''),
      parentName,
      age: age == null ? '' : String(age),
      birthDate,
      gender: childGenderLabelRu(child.gender),
      tags: childTagsLabelRu(parseChildTags(child.tagsJson)),
      state: state === 'silver' ? 'серенький' : 'участвует',
      giftsThisYear: giftsThisYearByChild.get(String(child.id)) ?? 0,
    });
  }

  rows.sort(
    (a, b) =>
      String(a.parentName ?? '').localeCompare(String(b.parentName ?? ''), 'ru') ||
      String(a.fullName ?? '').localeCompare(String(b.fullName ?? ''), 'ru'),
  );

  const preset = getPreset('children_roster');
  return {
    ok: true,
    presetId: 'children_roster',
    title: preset.title,
    subtitle: `${msToDate(period.startMs)} — ${msToDate(period.endMs)}`,
    columns: preset.columns,
    rows,
    totals: {
      children: rows.length,
      active: rows.filter((row) => String(row.state) === 'участвует').length,
      silver: rows.filter((row) => String(row.state) === 'серенький').length,
      gifted: rows.filter((row) => Number(row.giftsThisYear ?? 0) > 0).length,
    },
    generatedAt: Date.now(),
  };
}

/** Идентификаторы сотрудников — для родителей карточек детей. */
export function employeeIdsOfSnapshot(snapshot: Awaited<ReturnType<typeof loadSnapshot>>): string[] {
  return getIdsByType(snapshot, 'employee');
}
