import React, { useEffect, useMemo, useState } from 'react';
import {
  STOCK_1C_IMPORT_SOURCE,
  canonical1cNomenclature,
  classify1cGroup,
  match1cNomenclature,
  normalizeLookupCompact,
  parse1cStockReport,
  resolve1cUnit,
  revise1cAgainstBalances,
  type Stock1cReport,
  type Stock1cSnapshotEntry,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { Spinner } from './LoadingOverlay.js';
import { pickWarehouseNomenclatureGroupId } from '../utils/createWarehouseNomenclatureFromDirectory.js';

type NomRow = { id: string; name: string; article: string };
type Location = { id: string; name: string; type?: string };
type PrevImport = { docId: string; docNo: string; docDate: number; snapshot: Stock1cSnapshotEntry[] } | null;
type LocState = { balances: Stock1cSnapshotEntry[]; prev: PrevImport };

const CREATE_LOCATION_OPTION = '__create__';

// Позиции из 1С — покупные; заводим их видами БЕЗ карточки-источника
// (component/material/consumable), иначе нужен directoryRefId на каждую.
function directoryKindForGroup(group: string | null): 'component' | 'material' | 'consumable' {
  if (group === 'Закупка · Расходные материалы') return 'consumable';
  if (group === 'Закупка · Материалы и сырьё') return 'material';
  return 'component';
}

// Сопоставление склада файла со складом программы по имени: «Склад цех №3» ↔ «Цех №3».
function guessLocationId(warehouseName: string, locations: Location[]): string {
  const norm = (s: string) => String(s ?? '').toLowerCase().replace(/склад/g, '').replace(/[^a-zа-яё0-9№]+/g, '');
  const wn = norm(warehouseName);
  if (!wn) return '';
  const exact = locations.find((l) => norm(l.name) === wn);
  if (exact) return String(exact.id);
  const partial = locations.find((l) => {
    const ln = norm(l.name);
    return ln.length >= 3 && (wn.includes(ln) || ln.includes(wn));
  });
  if (partial) return String(partial.id);
  if (/основ/i.test(warehouseName)) {
    const main = locations.find((l) => /основ/i.test(String(l.name ?? ''))) ?? locations.find((l) => String(l.type ?? '') !== 'workshop');
    if (main) return String(main.id);
  }
  return '';
}

/**
 * Импорт остатков из 1С (docs/plans/import-1c-stock-2026-07.md).
 * Файл-источник — отчёт 1С «Остатки и доступность товаров», сохранённый в 1С как
 * «Текстовый файл» (TSV). Семантика — ревизия против текущего остатка программы
 * (revise1cAgainstBalances): живой учёт не трогаем, пропавшие из отчёта обнуляются.
 * Все склады файла сопоставляются таблицей и проводятся по порядку одним заходом;
 * проводка каждого — документ «Инвентаризация» (stock_inventory) с adjustmentQty.
 */
export function Stock1cImportDialog(props: { open: boolean; onClose: () => void; onPosted: (docId: string) => void }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [report, setReport] = useState<Stock1cReport | null>(null);
  const [fileName, setFileName] = useState('');
  const [locations, setLocations] = useState<Location[]>([]);
  const [mapping, setMapping] = useState<Record<number, string>>({});
  const [noms, setNoms] = useState<NomRow[] | null>(null);
  const [locState, setLocState] = useState<Record<string, LocState>>({});
  const [units, setUnits] = useState<Array<{ id: string; label: string }>>([]);
  const [groups, setGroups] = useState<Array<{ id: string; label: string }>>([]);
  const [createMissing, setCreateMissing] = useState(true);
  const [creatingFor, setCreatingFor] = useState<number | null>(null);
  const [newWhName, setNewWhName] = useState('');

  const api = window.matrica as unknown as {
    warehouseLocations: {
      list: (a?: { activeOnly?: boolean }) => Promise<unknown>;
      upsert: (a: Record<string, unknown>) => Promise<{ ok: boolean; id?: string; error?: string }>;
    };
    warehouse: {
      lookupsGet: () => Promise<{
        ok?: boolean;
        lookups?: { units?: Array<{ id: string; label: string }>; nomenclatureGroups?: Array<{ id: string; label: string }> };
      }>;
      nomenclatureList: (a?: Record<string, unknown>) => Promise<unknown>;
      nomenclatureUpsert: (a: Record<string, unknown>) => Promise<{ ok: boolean; id?: string; error?: string }>;
      nomenclatureTemplatesList: () => Promise<{ ok?: boolean; rows?: Array<Record<string, unknown>>; error?: string }>;
      stockList: (a?: Record<string, unknown>) => Promise<unknown>;
      documentsList: (a?: Record<string, unknown>) => Promise<unknown>;
      documentGet: (id: string) => Promise<unknown>;
      documentCreate: (a: Record<string, unknown>) => Promise<{ ok: boolean; id?: string; error?: string }>;
      documentPost: (id: string) => Promise<{ ok: boolean; error?: string }>;
    };
  };

  // Справочники при открытии: склады программы + вся номенклатура (для матчинга).
  useEffect(() => {
    if (!props.open) return;
    let alive = true;
    setError('');
    setNotice('');
    void (async () => {
      try {
        const locRaw = (await api.warehouseLocations.list({ activeOnly: true })) as { ok?: boolean; rows?: Location[]; items?: Location[] } | Location[];
        const locs = Array.isArray(locRaw) ? locRaw : (locRaw.rows ?? locRaw.items ?? []);
        if (!alive) return;
        setLocations(locs);

        const all: NomRow[] = [];
        for (let offset = 0; offset < 50_000; offset += 1000) {
          const r = (await api.warehouse.nomenclatureList({ limit: 1000, offset })) as { ok?: boolean; rows?: Array<Record<string, unknown>>; hasMore?: boolean };
          const rows = r.rows ?? [];
          for (const row of rows) {
            // Артикул в erp_nomenclature живёт в code/sku (поля article там нет).
            all.push({ id: String(row.id ?? ''), name: String(row.name ?? ''), article: String(row.code ?? row.sku ?? '') });
          }
          if (!r.hasMore || rows.length === 0) break;
        }
        if (!alive) return;
        setNoms(all.filter((n) => n.id));

        const lk = await api.warehouse.lookupsGet();
        if (alive && lk?.ok) {
          setUnits(lk.lookups?.units ?? []);
          setGroups(lk.lookups?.nomenclatureGroups ?? []);
        }
      } catch (e) {
        if (alive) setError(`Не удалось загрузить справочники: ${String(e)}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [props.open]);

  // Остатки + прошлый 1С-импорт по каждому сопоставленному складу программы
  // (снапшот прошлого импорта — в payload документа; по нему обнуляются пропавшие).
  useEffect(() => {
    if (!props.open) return;
    const need = [...new Set(Object.values(mapping).filter(Boolean))].filter((id) => !(id in locState));
    if (need.length === 0) return;
    let alive = true;
    void (async () => {
      for (const locId of need) {
        const bal: Stock1cSnapshotEntry[] = [];
        try {
          for (let offset = 0; offset < 100_000; offset += 1000) {
            const r = (await api.warehouse.stockList({ warehouseId: locId, limit: 1000, offset })) as {
              ok?: boolean;
              rows?: Array<{ nomenclatureId?: string; qty?: number }>;
              hasMore?: boolean;
            };
            const rows = r.rows ?? [];
            for (const row of rows) {
              if (row.nomenclatureId) bal.push({ nomenclatureId: String(row.nomenclatureId), qty: Number(row.qty ?? 0) });
            }
            if (!r.hasMore || rows.length === 0) break;
          }
        } catch {
          /* пустой склад / ошибка чтения — считаем без остатков */
        }
        let prev: PrevImport = null;
        try {
          const listRaw = (await api.warehouse.documentsList({ docType: 'stock_inventory', statusIn: ['posted'], warehouseId: locId, limit: 60 })) as {
            rows?: Array<{ id: string; docNo?: string; docDate?: number }>;
            items?: Array<{ id: string; docNo?: string; docDate?: number }>;
          };
          const rows = (listRaw.rows ?? listRaw.items ?? []).slice().sort((a, b) => Number(b.docDate ?? 0) - Number(a.docDate ?? 0));
          for (const row of rows) {
            const d = (await api.warehouse.documentGet(String(row.id))) as {
              document?: { header?: { payloadJson?: string | null } };
              header?: { payloadJson?: string | null };
            };
            const rawPayload = d.document?.header?.payloadJson ?? d.header?.payloadJson ?? null;
            if (!rawPayload) continue;
            try {
              const p = JSON.parse(String(rawPayload)) as { source?: string; importSnapshot?: Stock1cSnapshotEntry[] };
              if (p.source === STOCK_1C_IMPORT_SOURCE && Array.isArray(p.importSnapshot)) {
                prev = { docId: String(row.id), docNo: String(row.docNo ?? ''), docDate: Number(row.docDate ?? 0), snapshot: p.importSnapshot };
                break;
              }
            } catch {
              /* не наш payload */
            }
          }
        } catch {
          /* нет истории — первый импорт */
        }
        if (!alive) return;
        setLocState((prevState) => ({ ...prevState, [locId]: { balances: bal, prev } }));
      }
    })();
    return () => {
      alive = false;
    };
  }, [props.open, mapping]);

  async function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    setError('');
    setNotice('');
    setReport(null);
    setMapping({});
    setLocState({});
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);
    const text = await f.text();
    const r = parse1cStockReport(text);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setReport(r.report);
    const guessed: Record<number, string> = {};
    r.report.warehouses.forEach((w, i) => {
      guessed[i] = guessLocationId(w.warehouseName, locations);
    });
    setMapping(guessed);
  }

  async function createLocation(blockIdx: number) {
    const name = newWhName.trim();
    if (!name) return;
    setBusy('Заводим склад...');
    setError('');
    try {
      const maxOrder = locations.length * 10;
      const code = `wh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const res = await api.warehouseLocations.upsert({ type: 'regular', code, name, isActive: true, sortOrder: maxOrder + 10 });
      if (!res.ok || !res.id) {
        setError(`Не удалось завести склад «${name}»: ${res.error ?? 'неизвестная ошибка'}`);
        return;
      }
      const loc: Location = { id: String(res.id), name, type: 'regular' };
      setLocations((prev) => [...prev, loc]);
      setMapping((prev) => ({ ...prev, [blockIdx]: loc.id }));
      setCreatingFor(null);
      setNewWhName('');
    } finally {
      setBusy('');
    }
  }

  // Матчинг по каждому сопоставленному складу файла: артикул → имя → «имя+артикул»
  // (compact-ключи; логика в shared/import1cStock). Ненайденные группируются к
  // заведению: имя без артикула, артикул отдельным полем (правило владельца).
  const plans = useMemo(() => {
    if (!report || !noms) return null;
    return report.warehouses.map((block, idx) => {
      const locId = mapping[idx] ?? '';
      if (!locId) return { idx, block, locId: '', ready: false, matched: [], ambiguous: [], toCreate: [], fileEntries: [], deltas: [], createQty: 0, fractional: 0 };
      const { matched, unmatched, ambiguous } = match1cNomenclature(block.items, noms);
      const toCreateBy = new Map<string, { key: string; article: string; name: string; unit: string; qty: number; group: string | null }>();
      for (const item of unmatched) {
        const c = canonical1cNomenclature(item.article, item.name);
        const key = normalizeLookupCompact(c.article) || normalizeLookupCompact(c.name);
        if (!key) continue;
        const prev = toCreateBy.get(key);
        if (prev) prev.qty += item.qty;
        else toCreateBy.set(key, { key, article: c.article, name: c.name, unit: item.unit, qty: item.qty, group: classify1cGroup(item.name) });
      }
      const toCreate = [...toCreateBy.values()];
      const st = locState[locId];
      const fileEntries: Stock1cSnapshotEntry[] = matched.map((m) => ({ nomenclatureId: m.nom.id, qty: m.item.qty }));
      const deltas = st ? revise1cAgainstBalances({ file: fileEntries, prevSnapshot: st.prev?.snapshot ?? [], balances: st.balances }) : [];
      const createQty = toCreate.reduce((s, x) => s + Math.round(x.qty), 0);
      const fractional = matched.filter((m) => m.item.qty % 1 !== 0).length;
      return { idx, block, locId, ready: !!st, matched, ambiguous, toCreate, fileEntries, deltas, createQty, fractional };
    });
  }, [report, noms, mapping, locState]);

  const activePlans = (plans ?? []).filter((p) => p.locId);
  const allReady = activePlans.length > 0 && activePlans.every((p) => p.ready);
  const duplicateTarget = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of activePlans) {
      const prev = seen.get(p.locId);
      if (prev) return { a: prev, b: p.block.warehouseName };
      seen.set(p.locId, p.block.warehouseName);
    }
    return null;
  }, [activePlans]);

  // Дедуп заведения между складами: одна позиция может лежать в нескольких блоках файла.
  const uniqueCreateCount = useMemo(() => {
    const keys = new Set<string>();
    for (const p of activePlans) for (const c of p.toCreate) keys.add(c.key);
    return keys.size;
  }, [activePlans]);

  async function post() {
    if (!plans || !allReady || duplicateTarget) return;
    setError('');
    setNotice('');
    const postedDocs: string[] = [];
    try {
      // Шаблоны номенклатуры — один раз на весь заход.
      const createdByKey = new Map<string, string>();
      let templateFor: ((kind: string) => string | null) | null = null;
      if (createMissing && uniqueCreateCount > 0) {
        const templatesRes = await api.warehouse.nomenclatureTemplatesList();
        if (!templatesRes?.ok) {
          setError(`Не удалось загрузить шаблоны номенклатуры: ${templatesRes?.error ?? 'неизвестная ошибка'}. Импорт не начат.`);
          return;
        }
        const templates = (templatesRes.rows ?? []).map((row) => ({
          id: String(row.id ?? ''),
          code: String(row.code ?? '').trim().toLowerCase(),
          itemTypeCode: String(row.itemTypeCode ?? '').trim().toLowerCase(),
          directoryKind: String(row.directoryKind ?? '').trim().toLowerCase(),
        }));
        templateFor = (kind: string) =>
          (templates.find((t) => t.id && t.code === `default_${kind}`) ??
            templates.find((t) => t.id && t.itemTypeCode === kind && t.directoryKind === kind) ??
            templates.find((t) => t.id && t.itemTypeCode === kind && !t.directoryKind) ??
            templates.find((t) => t.id && !t.itemTypeCode && (t.directoryKind === kind || !t.directoryKind)) ??
            null)?.id ?? null;
      }
      const unitByKey = new Map(units.map((u) => [normalizeLookupCompact(u.label), u.id]));
      const groupByKey = new Map(groups.map((g) => [normalizeLookupCompact(g.label), g.id]));
      const fallbackUnitId = String(units[0]?.id ?? '').trim();

      const active = plans.filter((p) => p.locId);
      let blockNo = 0;
      for (const p of active) {
        blockNo += 1;
        const whLabel = `«${p.block.warehouseName || '(без названия)'}» (${blockNo} из ${active.length})`;
        const st = locState[p.locId]!;

        // 1. Заведение ненайденных позиций (если включено); уже заведённые в этом
        // заходе (другим складом) переиспользуются по ключу.
        const createdEntries: Stock1cSnapshotEntry[] = [];
        if (createMissing && p.toCreate.length > 0) {
          let done = 0;
          for (const c of p.toCreate) {
            setBusy(`${whLabel}: заводим номенклатуру ${++done} из ${p.toCreate.length}...`);
            let id = createdByKey.get(c.key);
            if (!id) {
              const kind = directoryKindForGroup(c.group);
              const templateId = templateFor ? templateFor(kind) : null;
              if (!templateId) {
                setError(`Не найден шаблон номенклатуры для вида «${kind}» (Склад → Номенклатура). ${postedDocs.length > 0 ? `Уже проведено складов: ${postedDocs.length}.` : 'Импорт не проведён.'}`);
                return;
              }
              const unitId = unitByKey.get(normalizeLookupCompact(resolve1cUnit(c.unit))) ?? fallbackUnitId;
              const groupId =
                (c.group ? groupByKey.get(normalizeLookupCompact(c.group)) : undefined) ??
                pickWarehouseNomenclatureGroupId(groups.map((g) => ({ ...g, code: '' })), kind) ??
                String(groups[0]?.id ?? '').trim();
              if (!unitId || !groupId) {
                setError(`Не найдены единица измерения или группа номенклатуры по умолчанию (Склад → Номенклатура). ${postedDocs.length > 0 ? `Уже проведено складов: ${postedDocs.length}.` : 'Импорт не проведён.'}`);
                return;
              }
              const r = await api.warehouse.nomenclatureUpsert({
                code: c.article,
                name: c.name,
                itemType: kind,
                directoryKind: kind,
                groupId,
                unitId,
                specJson: JSON.stringify({ templateId, propertyValues: {} }),
                isActive: true,
              });
              if (!r.ok || !r.id) {
                setError(`${whLabel}: не удалось завести «${c.name}»: ${r.error ?? 'неизвестная ошибка'}. ${postedDocs.length > 0 ? `Уже проведено складов: ${postedDocs.length}, остальные не тронуты.` : 'Импорт не проведён.'}`);
                return;
              }
              id = String(r.id);
              createdByKey.set(c.key, id);
            }
            createdEntries.push({ nomenclatureId: id, qty: c.qty });
          }
        }

        // 2. Ревизия и проводка документа по складу.
        setBusy(`${whLabel}: проводим импорт...`);
        const fileEntries = [...p.fileEntries, ...createdEntries];
        const deltas = revise1cAgainstBalances({ file: fileEntries, prevSnapshot: st.prev?.snapshot ?? [], balances: st.balances });
        if (deltas.length === 0) continue;
        const now = Date.now();
        const d = new Date(now);
        const pad = (x: number) => String(x).padStart(2, '0');
        const docNo = `1C-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${active.length > 1 ? `-${blockNo}` : ''}`;
        const created = await api.warehouse.documentCreate({
          docType: 'stock_inventory',
          docNo,
          docDate: now,
          header: { warehouseId: p.locId, reason: `Импорт остатков из 1С (${fileName}, ${p.block.warehouseName})` },
          payloadJson: JSON.stringify({ source: STOCK_1C_IMPORT_SOURCE, importSnapshot: fileEntries, importFileName: fileName }),
          lines: deltas.map((x) => ({
            nomenclatureId: x.nomenclatureId,
            qty: Math.abs(x.delta),
            adjustmentQty: x.delta,
            warehouseId: p.locId,
          })),
        });
        if (!created.ok || !created.id) {
          setError(`${whLabel}: не удалось создать документ: ${created.error ?? 'неизвестная ошибка'}. ${postedDocs.length > 0 ? `Уже проведено складов: ${postedDocs.length}.` : ''}`);
          return;
        }
        const posted = await api.warehouse.documentPost(created.id);
        if (!posted.ok) {
          setError(`${whLabel}: документ ${docNo} создан, но не проведён: ${posted.error ?? 'неизвестная ошибка'}. ${postedDocs.length > 0 ? `Уже проведено складов: ${postedDocs.length}.` : ''}`);
          return;
        }
        postedDocs.push(created.id);
      }
      if (postedDocs.length === 0) {
        setNotice('Изменений нет — проводить было нечего.');
        return;
      }
      props.onPosted(postedDocs[postedDocs.length - 1]!);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy('');
    }
  }

  if (!props.open) return null;
  const totals = activePlans.reduce(
    (acc, p) => {
      acc.matched += p.matched.length;
      acc.ambiguous += p.ambiguous.length;
      acc.fractional += p.fractional;
      acc.plus += p.deltas.filter((x) => x.delta > 0).reduce((s, x) => s + x.delta, 0);
      acc.plusN += p.deltas.filter((x) => x.delta > 0).length;
      acc.minus += p.deltas.filter((x) => x.delta < 0).reduce((s, x) => s + x.delta, 0);
      acc.minusN += p.deltas.filter((x) => x.delta < 0).length;
      acc.zeroed += p.deltas.filter((x) => x.zeroed).length;
      acc.lines += p.deltas.length;
      if (createMissing) {
        acc.createQty += p.createQty;
        acc.lines += p.toCreate.length;
      }
      return acc;
    },
    { matched: 0, ambiguous: 0, fractional: 0, plus: 0, plusN: 0, minus: 0, minusN: 0, zeroed: 0, createQty: 0, lines: 0 },
  );
  const willCreate = createMissing ? uniqueCreateCount : 0;
  const allToCreate = useMemo(() => {
    const byKey = new Map<string, { article: string; name: string; unit: string; qty: number; group: string | null }>();
    for (const p of activePlans) {
      for (const c of p.toCreate) {
        const prev = byKey.get(c.key);
        if (prev) prev.qty += c.qty;
        else byKey.set(c.key, { article: c.article, name: c.name, unit: c.unit, qty: c.qty, group: c.group });
      }
    }
    return [...byKey.values()];
  }, [activePlans]);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--surface, #fff)', borderRadius: 14, width: 'min(920px, 94vw)', maxHeight: '90vh', overflow: 'auto', padding: 18, display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontWeight: 800, fontSize: 16, flex: '1 1 auto' }}>Импорт остатков из 1С</div>
          <Button variant="ghost" onClick={props.onClose}>✕ Закрыть</Button>
        </div>
        <div style={{ color: 'var(--muted, #64748b)', fontSize: 13 }}>
          Файл — отчёт 1С «Остатки и доступность товаров», сохранённый как <b>Текстовый файл (.txt)</b>. Импорт — ревизия: остаток
          склада приводится к числам из файла (файл показывает реальный физический остаток, поэтому расход нарядами не списывается
          дважды). Позиции, которых 1С не знает (например, детали от разборки), не затрагиваются; пропавшие из отчёта — обнуляются.
          Сопоставьте склады файла со складами программы — импорт пройдёт по всем по порядку.
        </div>

        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--muted, #64748b)' }}>Файл отчёта (.txt из 1С)</span>
          <input type="file" accept=".txt,text/plain" onChange={(e) => void pickFile(e)} />
        </label>

        {report && noms == null && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--muted, #64748b)' }}>
            <Spinner size={20} /> Загрузка номенклатуры для сопоставления...
          </div>
        )}

        {report && plans && (
          <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--muted, #64748b)', fontSize: 12 }}>
                <th style={{ padding: '4px 8px 4px 0' }}>Склад из файла 1С</th>
                <th style={{ padding: '4px 8px' }}>→ Склад программы</th>
                <th style={{ padding: '4px 0' }}>Сопоставление</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.idx} style={{ borderTop: '1px solid var(--border, #e2e8f0)' }}>
                  <td style={{ padding: '6px 8px 6px 0', whiteSpace: 'nowrap' }}>
                    {p.block.warehouseName || '(без названия)'} <span style={{ color: 'var(--muted, #64748b)' }}>— {p.block.items.length} строк</span>
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    {creatingFor === p.idx ? (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <input
                          value={newWhName}
                          onChange={(e) => setNewWhName(e.target.value)}
                          placeholder="Название нового склада"
                          style={{ padding: '4px 8px', borderRadius: 8, border: '1px solid var(--border, #cbd5e1)', minWidth: 200 }}
                          autoFocus
                        />
                        <Button disabled={!newWhName.trim() || !!busy} onClick={() => void createLocation(p.idx)}>Завести</Button>
                        <Button variant="ghost" onClick={() => { setCreatingFor(null); setNewWhName(''); }}>✕</Button>
                      </span>
                    ) : (
                      <select
                        value={p.locId}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === CREATE_LOCATION_OPTION) {
                            setCreatingFor(p.idx);
                            setNewWhName(p.block.warehouseName.replace(/^склад\s+/i, '').trim());
                            return;
                          }
                          setMapping((prev) => ({ ...prev, [p.idx]: v }));
                        }}
                        style={{ padding: '6px 8px', borderRadius: 8, minWidth: 200 }}
                      >
                        <option value="">— пропустить —</option>
                        {locations.map((l) => (
                          <option key={String(l.id)} value={String(l.id)}>
                            {l.name}
                          </option>
                        ))}
                        <option value={CREATE_LOCATION_OPTION}>➕ Завести новый склад…</option>
                      </select>
                    )}
                  </td>
                  <td style={{ padding: '6px 0', fontSize: 12, whiteSpace: 'nowrap' }}>
                    {!p.locId ? (
                      <span style={{ color: 'var(--muted, #64748b)' }}>пропускается</span>
                    ) : !p.ready ? (
                      <span style={{ color: 'var(--muted, #64748b)', display: 'inline-flex', gap: 6, alignItems: 'center' }}><Spinner size={14} /> читаем остатки…</span>
                    ) : (
                      <span>
                        ✅ {p.matched.length} · 🆕 {p.toCreate.length}
                        {p.ambiguous.length > 0 && <span style={{ color: '#b45309' }}> · ⚠ {p.ambiguous.length}</span>}
                        {locState[p.locId]?.prev
                          ? <span style={{ color: 'var(--muted, #64748b)' }}> · был импорт {new Date(locState[p.locId]!.prev!.docDate).toLocaleDateString('ru-RU')}</span>
                          : <span style={{ color: '#0369a1' }}> · первый импорт</span>}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {duplicateTarget && (
          <div style={{ color: '#b45309', fontSize: 13 }}>
            ⚠ Один и тот же склад программы выбран для «{duplicateTarget.a}» и «{duplicateTarget.b}» — так остатки перезатрут друг друга. Разведите по разным складам.
          </div>
        )}

        {activePlans.length > 0 && allReady && !duplicateTarget && (
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13 }}>
              <span>✅ Сопоставлено: <b>{totals.matched}</b></span>
              <span style={{ color: uniqueCreateCount ? '#0369a1' : undefined }}>🆕 Новых (нет в программе): <b>{uniqueCreateCount}</b></span>
              {totals.ambiguous > 0 && <span style={{ color: '#b45309' }}>⚠ Неоднозначно (пропускаются): <b>{totals.ambiguous}</b></span>}
              {totals.fractional > 0 && <span title="Складской учёт целочисленный — дробные округлены">≈ Дробных (округлено): <b>{totals.fractional}</b></span>}
            </div>
            {uniqueCreateCount > 0 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)} />
                <span>
                  Завести новые позиции в номенклатуре ({uniqueCreateCount}) — имя без артикула, артикул отдельным полем, вид и группа по названию
                </span>
              </label>
            )}
            <div style={{ fontSize: 13 }}>
              К проводке по {activePlans.length} склад{activePlans.length === 1 ? 'у' : 'ам'}:{' '}
              <b style={{ color: '#15803d' }}>+{totals.plus}</b> по {totals.plusN} позициям,{' '}
              <b style={{ color: '#b91c1c' }}>{totals.minus}</b> по {totals.minusN} позициям
              {willCreate > 0 && <>, приход по новым: <b style={{ color: '#0369a1' }}>+{totals.createQty}</b></>}
              {totals.zeroed > 0 && <> (обнуляется пропавших из отчёта: {totals.zeroed})</>}
              {totals.lines === 0 && <b> — изменений нет, проводить нечего.</b>}
            </div>
            {allToCreate.length > 0 && (
              <details>
                <summary style={{ cursor: 'pointer', fontSize: 13 }}>
                  Показать новые позиции ({allToCreate.length}){createMissing ? ' — будут заведены' : ' — будут пропущены'}
                </summary>
                <div style={{ maxHeight: 180, overflow: 'auto', fontSize: 12, color: 'var(--muted, #64748b)', padding: '6px 0' }}>
                  {allToCreate.slice(0, 700).map((x, i) => (
                    <div key={i}>
                      {x.name}{x.article ? ` — арт. ${x.article}` : ''} — {x.qty} {x.unit}
                      {x.group ? <span style={{ color: '#0369a1' }}> → {x.group}</span> : <span> → без группы</span>}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        {error && <div style={{ color: '#b91c1c', fontWeight: 600 }}>{error}</div>}
        {notice && <div style={{ color: 'var(--muted, #64748b)', fontWeight: 600 }}>{notice}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          {busy && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--muted, #64748b)' }}>
              <Spinner size={18} /> {busy}
            </span>
          )}
          <Button variant="ghost" onClick={props.onClose}>Отмена</Button>
          <Button disabled={activePlans.length === 0 || !allReady || !!duplicateTarget || !!busy || totals.lines === 0} onClick={() => void post()}>
            Провести импорт ({totals.lines} строк, {activePlans.length} склад{activePlans.length === 1 ? '' : activePlans.length < 5 ? 'а' : 'ов'})
          </Button>
        </div>
      </div>
    </div>
  );
}
