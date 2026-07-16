
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  STATUS_CODES,
  computeObjectProgress,
  effectiveContractDueAt,
  parseContractSections,
  type ReportCellValue,
  type ReportPresetFilters,
  type ReportPresetPreviewResult,
  } from '@matricarmz/shared';







import { resolveContractLabel, toNumber, normalizeText, asArray, asNumberOrNull, hasText, readPeriod, msToDate, matchesDueState, matchesPresenceFilter, classifyContractRisk, matchesProgressState } from '../format.js';
import { getPreset, loadSnapshot, getIdsByType } from '../context.js';
import { buildOptions, buildCounterpartyOptions, resolveCounterpartyLabel } from '../options.js';

export function collectContractTotals(attrs: Record<string, unknown>) {
  const sections = parseContractSections(attrs);
  let totalQty = 0;
  let totalAmountRub = 0;
  const sectionList = [sections.primary, ...sections.addons];
  for (const section of sectionList) {
    for (const item of section.engineBrands ?? []) {
      const qty = Math.max(0, toNumber(item.qty));
      const unitPrice = Math.max(0, toNumber(item.unitPrice));
      totalQty += qty;
      totalAmountRub += qty * unitPrice;
    }
    for (const item of section.parts ?? []) {
      const qty = Math.max(0, toNumber(item.qty));
      const unitPrice = Math.max(0, toNumber(item.unitPrice));
      totalQty += qty;
      totalAmountRub += qty * unitPrice;
    }
  }
  return { sections, totalQty, totalAmountRub };
}

export function collectContractEngineQty(attrs: Record<string, unknown>): number {
  const sections = parseContractSections(attrs);
  const sectionList = [sections.primary, ...sections.addons];
  let total = 0;
  for (const section of sectionList) {
    for (const item of section.engineBrands ?? []) {
      total += Math.max(0, toNumber(item.qty));
    }
  }
  if (total > 0) return total;
  return Math.max(0, toNumber(attrs.engine_count_total));
}

export async function buildContractsFinanceReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const counterpartyFilter = asArray(filters?.counterpartyIds);
  const contractFilter = asArray(filters?.contractIds);
  const statusFilter = normalizeText(filters?.status, 'all');
  const dueState = normalizeText(filters?.dueState, 'all');
  const igkState = normalizeText(filters?.igkState, 'all');
  const separateAccountState = normalizeText(filters?.separateAccountState, 'all');
  const snapshot = await loadSnapshot(db);
  const contractOptions = new Map(buildOptions(snapshot, 'contract').map((o) => [o.value, o.label] as const));
  const counterpartyOptions = new Map(buildCounterpartyOptions(snapshot).map((o) => [o.value, o.label] as const));
  const progressByContract = new Map<string, { count: number; sum: number }>();
  for (const engineId of getIdsByType(snapshot, 'engine')) {
    const attrs = snapshot.attrsByEntity.get(engineId) ?? {};
    const contractId = normalizeText(attrs.contract_id, '');
    if (!contractId) continue;
    const statusFlags: Partial<Record<(typeof STATUS_CODES)[number], boolean>> = {};
    for (const code of STATUS_CODES) statusFlags[code] = Boolean(attrs[code]);
    const progress = computeObjectProgress(statusFlags);
    const g = progressByContract.get(contractId) ?? { count: 0, sum: 0 };
    g.count += 1;
    g.sum += progress;
    progressByContract.set(contractId, g);
  }
  const rows: Array<Record<string, ReportCellValue>> = [];
  const now = Date.now();
  for (const contractId of getIdsByType(snapshot, 'contract')) {
    if (contractFilter.length > 0 && !contractFilter.includes(contractId)) continue;
    const attrs = snapshot.attrsByEntity.get(contractId) ?? {};
    const { sections, totalQty, totalAmountRub } = collectContractTotals(attrs);
    const signedAt = sections.primary.signedAt ?? asNumberOrNull(attrs.date);
    const dueAt = effectiveContractDueAt(sections) ?? asNumberOrNull(attrs.due_date);
    if (signedAt != null) {
      if (period.startMs != null && signedAt < period.startMs) continue;
      if (signedAt > period.endMs) continue;
    }
    const counterpartyId = normalizeText(sections.primary.customerId ?? attrs.customer_id, '');
    if (counterpartyFilter.length > 0 && (!counterpartyId || !counterpartyFilter.includes(counterpartyId))) continue;
    const progressData = progressByContract.get(contractId);
    const progressPct = progressData && progressData.count > 0 ? progressData.sum / progressData.count : 0;
    const state = progressPct >= 100 ? 'completed' : dueAt && dueAt < now ? 'overdue' : 'active';
    if (statusFilter !== 'all' && statusFilter !== state) continue;
    if (!matchesDueState(dueAt, now, dueState)) continue;
    const igk = normalizeText(attrs.igk ?? attrs.goz_igk, '');
    const separateAccount = normalizeText(attrs.separate_account ?? attrs.separate_account_number, '');
    if (!matchesPresenceFilter(igk, igkState)) continue;
    if (!matchesPresenceFilter(separateAccount, separateAccountState)) continue;
    const daysLeft = dueAt ? Math.ceil((dueAt - now) / (24 * 60 * 60 * 1000)) : null;
    rows.push({
      contractLabel: resolveContractLabel(contractId, contractOptions),
      internalNumber: normalizeText(sections.primary.internalNumber ?? attrs.internal_number, ''),
      counterpartyLabel: resolveCounterpartyLabel(snapshot, counterpartyOptions, counterpartyId),
      signedAt,
      dueAt,
      totalQty,
      totalAmountRub,
      progressPct,
      daysLeft,
      igk,
      separateAccount,
    });
  }
  rows.sort((a, b) => String(a.contractLabel ?? '').localeCompare(String(b.contractLabel ?? ''), 'ru'));
  const totals = {
    contracts: rows.length,
    totalQty: rows.reduce((acc, row) => acc + toNumber(row.totalQty), 0),
    totalAmountRub: rows.reduce((acc, row) => acc + toNumber(row.totalAmountRub), 0),
    progressPct: rows.length ? rows.reduce((acc, row) => acc + toNumber(row.progressPct), 0) / rows.length : 0,
    withIgk: rows.filter((row) => hasText(row.igk)).length,
    withoutIgk: rows.filter((row) => !hasText(row.igk)).length,
    withSeparateAccount: rows.filter((row) => hasText(row.separateAccount)).length,
    withoutSeparateAccount: rows.filter((row) => !hasText(row.separateAccount)).length,
  };
  const preset = getPreset('contracts_finance');
  return {
    ok: true,
    presetId: 'contracts_finance',
    title: preset.title,
    subtitle: `${msToDate(period.startMs)} — ${msToDate(period.endMs)}`,
    columns: preset.columns,
    rows,
    totals,
    generatedAt: Date.now(),
  };
}

export async function buildContractsDeadlinesReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const counterpartyFilter = asArray(filters?.counterpartyIds);
  const contractFilter = asArray(filters?.contractIds);
  const dueState = normalizeText(filters?.dueState, 'all');
  const progressState = normalizeText(filters?.progressState, 'all');
  const snapshot = await loadSnapshot(db);
  const contractOptions = new Map(buildOptions(snapshot, 'contract').map((o) => [o.value, o.label] as const));
  const counterpartyOptions = new Map(buildCounterpartyOptions(snapshot).map((o) => [o.value, o.label] as const));
  const progressByContract = new Map<string, { count: number; sum: number }>();
  for (const engineId of getIdsByType(snapshot, 'engine')) {
    const attrs = snapshot.attrsByEntity.get(engineId) ?? {};
    const contractId = normalizeText(attrs.contract_id, '');
    if (!contractId) continue;
    const statusFlags: Partial<Record<(typeof STATUS_CODES)[number], boolean>> = {};
    for (const code of STATUS_CODES) statusFlags[code] = Boolean(attrs[code]);
    const progress = computeObjectProgress(statusFlags);
    const g = progressByContract.get(contractId) ?? { count: 0, sum: 0 };
    g.count += 1;
    g.sum += progress;
    progressByContract.set(contractId, g);
  }

  const now = Date.now();
  const rows: Array<Record<string, ReportCellValue>> = [];
  for (const contractId of getIdsByType(snapshot, 'contract')) {
    if (contractFilter.length > 0 && !contractFilter.includes(contractId)) continue;
    const attrs = snapshot.attrsByEntity.get(contractId) ?? {};
    const { sections, totalAmountRub } = collectContractTotals(attrs);
    const signedAt = sections.primary.signedAt ?? asNumberOrNull(attrs.date);
    const dueAt = effectiveContractDueAt(sections) ?? asNumberOrNull(attrs.due_date);
    if (signedAt != null) {
      if (period.startMs != null && signedAt < period.startMs) continue;
      if (signedAt > period.endMs) continue;
    }
    if (!matchesDueState(dueAt, now, dueState)) continue;
    const counterpartyId = normalizeText(sections.primary.customerId ?? attrs.customer_id, '');
    if (counterpartyFilter.length > 0 && (!counterpartyId || !counterpartyFilter.includes(counterpartyId))) continue;
    const progressData = progressByContract.get(contractId);
    const progressPct = progressData && progressData.count > 0 ? progressData.sum / progressData.count : 0;
    if (!matchesProgressState(progressPct, progressState)) continue;
    const daysLeft = dueAt ? Math.ceil((dueAt - now) / (24 * 60 * 60 * 1000)) : null;
    rows.push({
      contractLabel: resolveContractLabel(contractId, contractOptions),
      counterpartyLabel: resolveCounterpartyLabel(snapshot, counterpartyOptions, counterpartyId),
      signedAt,
      dueAt,
      daysLeft,
      riskLabel: classifyContractRisk(dueAt, now),
      progressPct,
      totalAmountRub,
    });
  }
  rows.sort(
    (a, b) =>
      toNumber(a.daysLeft) - toNumber(b.daysLeft) ||
      String(a.contractLabel ?? '').localeCompare(String(b.contractLabel ?? ''), 'ru'),
  );
  const totals = {
    contracts: rows.length,
    overdueContracts: rows.filter((row) => toNumber(row.daysLeft) < 0).length,
    dueSoonContracts: rows.filter((row) => {
      const days = toNumber(row.daysLeft);
      return days >= 0 && days <= 30;
    }).length,
    totalAmountRub: rows.reduce((acc, row) => acc + toNumber(row.totalAmountRub), 0),
    progressPct: rows.length ? rows.reduce((acc, row) => acc + toNumber(row.progressPct), 0) / rows.length : 0,
  };
  const preset = getPreset('contracts_deadlines');
  return {
    ok: true,
    presetId: 'contracts_deadlines',
    title: preset.title,
    subtitle: `${msToDate(period.startMs)} — ${msToDate(period.endMs)}`,
    columns: preset.columns,
    rows,
    totals,
    generatedAt: Date.now(),
  };
}

export async function buildContractsRequisitesReport(
  db: BetterSQLite3Database,
  filters: ReportPresetFilters | undefined,
): Promise<ReportPresetPreviewResult> {
  const period = readPeriod(filters);
  const counterpartyFilter = asArray(filters?.counterpartyIds);
  const contractFilter = asArray(filters?.contractIds);
  const igkState = normalizeText(filters?.igkState, 'all');
  const separateAccountState = normalizeText(filters?.separateAccountState, 'all');
  const snapshot = await loadSnapshot(db);
  const contractOptions = new Map(buildOptions(snapshot, 'contract').map((o) => [o.value, o.label] as const));
  const counterpartyOptions = new Map(buildCounterpartyOptions(snapshot).map((o) => [o.value, o.label] as const));
  const rows: Array<Record<string, ReportCellValue>> = [];
  for (const contractId of getIdsByType(snapshot, 'contract')) {
    if (contractFilter.length > 0 && !contractFilter.includes(contractId)) continue;
    const attrs = snapshot.attrsByEntity.get(contractId) ?? {};
    const { sections, totalAmountRub } = collectContractTotals(attrs);
    const signedAt = sections.primary.signedAt ?? asNumberOrNull(attrs.date);
    const dueAt = effectiveContractDueAt(sections) ?? asNumberOrNull(attrs.due_date);
    if (signedAt != null) {
      if (period.startMs != null && signedAt < period.startMs) continue;
      if (signedAt > period.endMs) continue;
    }
    const counterpartyId = normalizeText(sections.primary.customerId ?? attrs.customer_id, '');
    if (counterpartyFilter.length > 0 && (!counterpartyId || !counterpartyFilter.includes(counterpartyId))) continue;
    const igk = normalizeText(attrs.igk ?? attrs.goz_igk, '');
    const separateAccount = normalizeText(attrs.separate_account ?? attrs.separate_account_number, '');
    if (!matchesPresenceFilter(igk, igkState)) continue;
    if (!matchesPresenceFilter(separateAccount, separateAccountState)) continue;
    const requisitesState = hasText(igk) && hasText(separateAccount) ? 'Полные' : 'Неполные';
    rows.push({
      contractLabel: resolveContractLabel(contractId, contractOptions),
      internalNumber: normalizeText(sections.primary.internalNumber ?? attrs.internal_number, ''),
      counterpartyLabel: resolveCounterpartyLabel(snapshot, counterpartyOptions, counterpartyId),
      signedAt,
      dueAt,
      igk,
      separateAccount,
      requisitesState,
      totalAmountRub,
    });
  }
  rows.sort((a, b) => String(a.contractLabel ?? '').localeCompare(String(b.contractLabel ?? ''), 'ru'));
  const totals = {
    contracts: rows.length,
    withIgk: rows.filter((row) => hasText(row.igk)).length,
    withoutIgk: rows.filter((row) => !hasText(row.igk)).length,
    withSeparateAccount: rows.filter((row) => hasText(row.separateAccount)).length,
    withoutSeparateAccount: rows.filter((row) => !hasText(row.separateAccount)).length,
    totalAmountRub: rows.reduce((acc, row) => acc + toNumber(row.totalAmountRub), 0),
  };
  const preset = getPreset('contracts_requisites');
  return {
    ok: true,
    presetId: 'contracts_requisites',
    title: preset.title,
    subtitle: `${msToDate(period.startMs)} — ${msToDate(period.endMs)}`,
    columns: preset.columns,
    rows,
    totals,
    generatedAt: Date.now(),
  };
}

