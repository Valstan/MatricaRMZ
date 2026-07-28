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

type NomRow = { id: string; name: string; article: string };
type Location = { id: string; name: string; type?: string };
type PrevImport = { docId: string; docNo: string; docDate: number; snapshot: Stock1cSnapshotEntry[] } | null;

/**
 * Импорт остатков из 1С (docs/plans/import-1c-stock-2026-07.md).
 * Файл-источник — отчёт «Остатки и доступность товаров», сохранённый в 1С как
 * «Текстовый файл» (TSV). Семантика — ревизия слоя 1С: дельты против прошлого
 * импорта (снапшот хранится в payload документа), живой учёт программы не трогаем.
 * Проводка — документ «Инвентаризация» (stock_inventory) с adjustmentQty-строками.
 */
export function Stock1cImportDialog(props: { open: boolean; onClose: () => void; onPosted: (docId: string) => void }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [report, setReport] = useState<Stock1cReport | null>(null);
  const [fileName, setFileName] = useState('');
  const [blockIdx, setBlockIdx] = useState(0);
  const [locations, setLocations] = useState<Location[]>([]);
  const [targetLocationId, setTargetLocationId] = useState('');
  const [noms, setNoms] = useState<NomRow[] | null>(null);
  const [prevImport, setPrevImport] = useState<PrevImport>(null);
  const [prevLoading, setPrevLoading] = useState(false);
  const [balances, setBalances] = useState<Stock1cSnapshotEntry[] | null>(null);
  const [units, setUnits] = useState<Array<{ id: string; label: string }>>([]);
  const [groups, setGroups] = useState<Array<{ id: string; label: string }>>([]);
  const [createMissing, setCreateMissing] = useState(true);

  const api = window.matrica as unknown as {
    warehouseLocations: { list: (a?: { activeOnly?: boolean }) => Promise<unknown> };
    warehouse: {
      lookupsGet: () => Promise<{
        ok?: boolean;
        lookups?: { units?: Array<{ id: string; label: string }>; nomenclatureGroups?: Array<{ id: string; label: string }> };
      }>;
      nomenclatureList: (a?: Record<string, unknown>) => Promise<unknown>;
      nomenclatureUpsert: (a: Record<string, unknown>) => Promise<{ ok: boolean; id?: string; error?: string }>;
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
    void (async () => {
      try {
        const locRaw = (await api.warehouseLocations.list({ activeOnly: true })) as { ok?: boolean; rows?: Location[]; items?: Location[] } | Location[];
        const locs = Array.isArray(locRaw) ? locRaw : (locRaw.rows ?? locRaw.items ?? []);
        if (!alive) return;
        setLocations(locs);
        // Дефолт — общезаводской «основной» склад (по имени), иначе первый обычный.
        const main = locs.find((l) => /основ/i.test(String(l.name ?? ''))) ?? locs.find((l) => String(l.type ?? '') !== 'workshop') ?? locs[0];
        if (main) setTargetLocationId((prev) => prev || String(main.id));

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

  // Прошлый импорт по выбранному складу: последний проведённый stock_inventory
  // с меткой источника 1С в payload (там же лежит снапшот — по нему обнуляются
  // пропавшие из нового отчёта позиции). Плюс текущие остатки склада — против
  // них считается ревизия.
  useEffect(() => {
    if (!props.open || !targetLocationId) return;
    let alive = true;
    setPrevLoading(true);
    setPrevImport(null);
    setBalances(null);
    void (async () => {
      try {
        const bal: Stock1cSnapshotEntry[] = [];
        for (let offset = 0; offset < 100_000; offset += 1000) {
          const r = (await api.warehouse.stockList({ warehouseId: targetLocationId, limit: 1000, offset })) as {
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
        if (alive) setBalances(bal);
      } catch {
        if (alive) setBalances([]);
      }
      try {
        const listRaw = (await api.warehouse.documentsList({ docType: 'stock_inventory', statusIn: ['posted'], warehouseId: targetLocationId, limit: 60 })) as {
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
              if (alive) setPrevImport({ docId: String(row.id), docNo: String(row.docNo ?? ''), docDate: Number(row.docDate ?? 0), snapshot: p.importSnapshot });
              return;
            }
          } catch {
            /* не наш payload */
          }
        }
      } catch {
        /* нет истории — первый импорт */
      } finally {
        if (alive) setPrevLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [props.open, targetLocationId]);

  async function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    setError('');
    setReport(null);
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
    const mainIdx = r.report.warehouses.findIndex((w) => /основ/i.test(w.warehouseName));
    setBlockIdx(mainIdx >= 0 ? mainIdx : 0);
  }

  // Матчинг: артикул → имя → «имя+артикул» (compact-ключи; логика в shared/import1cStock).
  // Ненайденные позиции группируются к заведению: имя без артикула, артикул — в поле
  // артикула (правило владельца; дедуп новых — по артикулу, без него — по имени).
  const matching = useMemo(() => {
    if (!report || !noms) return null;
    const block = report.warehouses[blockIdx];
    if (!block) return null;
    const { matched, unmatched, ambiguous } = match1cNomenclature(block.items, noms);
    const toCreateBy = new Map<string, { article: string; name: string; unit: string; qty: number; group: string | null }>();
    for (const item of unmatched) {
      const c = canonical1cNomenclature(item.article, item.name);
      const key = normalizeLookupCompact(c.article) || normalizeLookupCompact(c.name);
      if (!key) continue;
      const prev = toCreateBy.get(key);
      if (prev) prev.qty += item.qty;
      else toCreateBy.set(key, { article: c.article, name: c.name, unit: item.unit, qty: item.qty, group: classify1cGroup(item.name) });
    }
    const toCreate = [...toCreateBy.values()];
    // Ревизия против текущего остатка склада; прошлый снапшот — только для обнуления
    // пропавших. Новые (заводимые) позиции лягут приходом с нуля.
    const fileEntries: Stock1cSnapshotEntry[] = matched.map((m) => ({ nomenclatureId: m.nom.id, qty: m.item.qty }));
    const deltas = revise1cAgainstBalances({ file: fileEntries, prevSnapshot: prevImport?.snapshot ?? [], balances: balances ?? [] });
    const createQty = toCreate.reduce((s, x) => s + Math.round(x.qty), 0);
    const fractional = matched.filter((m) => m.item.qty % 1 !== 0).length;
    return { block, matched, unmatched, ambiguous, toCreate, fileEntries, deltas, createQty, fractional };
  }, [report, blockIdx, noms, prevImport, balances]);

  async function post() {
    if (!matching || !targetLocationId) return;
    setError('');
    try {
      // 1. Заведение ненайденных позиций (если включено).
      const createdEntries: Stock1cSnapshotEntry[] = [];
      if (createMissing && matching.toCreate.length > 0) {
        const unitByKey = new Map(units.map((u) => [normalizeLookupCompact(u.label), u.id]));
        const groupByKey = new Map(groups.map((g) => [normalizeLookupCompact(g.label), g.id]));
        let done = 0;
        for (const c of matching.toCreate) {
          setBusy(`Заводим номенклатуру... ${++done} из ${matching.toCreate.length}`);
          const unitId = unitByKey.get(normalizeLookupCompact(resolve1cUnit(c.unit)));
          const groupId = c.group ? groupByKey.get(normalizeLookupCompact(c.group)) : undefined;
          const r = await api.warehouse.nomenclatureUpsert({
            code: c.article,
            name: c.name,
            ...(unitId ? { unitId } : {}),
            ...(groupId ? { groupId } : {}),
            isActive: true,
          });
          if (!r.ok || !r.id) {
            setError(`Не удалось завести «${c.name}»: ${r.error ?? 'неизвестная ошибка'}. Импорт не проведён.`);
            return;
          }
          createdEntries.push({ nomenclatureId: String(r.id), qty: c.qty });
        }
      }
      setBusy('Проводим импорт...');
      const fileEntries = [...matching.fileEntries, ...createdEntries];
      const deltas = revise1cAgainstBalances({ file: fileEntries, prevSnapshot: prevImport?.snapshot ?? [], balances: balances ?? [] });
      const now = Date.now();
      const d = new Date(now);
      const pad = (x: number) => String(x).padStart(2, '0');
      const docNo = `1C-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
      const created = await api.warehouse.documentCreate({
        docType: 'stock_inventory',
        docNo,
        docDate: now,
        header: { warehouseId: targetLocationId, reason: `Импорт остатков из 1С (${fileName})` },
        payloadJson: JSON.stringify({ source: STOCK_1C_IMPORT_SOURCE, importSnapshot: fileEntries, importFileName: fileName }),
        lines: deltas.map((x) => ({
          nomenclatureId: x.nomenclatureId,
          qty: Math.abs(x.delta),
          adjustmentQty: x.delta,
          warehouseId: targetLocationId,
        })),
      });
      if (!created.ok || !created.id) {
        setError(`Не удалось создать документ: ${created.error ?? 'неизвестная ошибка'}`);
        return;
      }
      if (deltas.length > 0) {
        const posted = await api.warehouse.documentPost(created.id);
        if (!posted.ok) {
          setError(`Документ ${docNo} создан, но не проведён: ${posted.error ?? 'неизвестная ошибка'}`);
          return;
        }
      }
      props.onPosted(created.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy('');
    }
  }

  if (!props.open) return null;
  const locName = (id: string) => locations.find((l) => String(l.id) === id)?.name ?? id;
  const plus = matching?.deltas.filter((x) => x.delta > 0) ?? [];
  const minus = matching?.deltas.filter((x) => x.delta < 0) ?? [];
  const zeroed = matching?.deltas.filter((x) => x.zeroed) ?? [];
  const willCreate = createMissing ? (matching?.toCreate.length ?? 0) : 0;
  const totalLines = (matching?.deltas.length ?? 0) + willCreate;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--surface, #fff)', borderRadius: 14, width: 'min(880px, 94vw)', maxHeight: '90vh', overflow: 'auto', padding: 18, display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontWeight: 800, fontSize: 16, flex: '1 1 auto' }}>Импорт остатков из 1С</div>
          <Button variant="ghost" onClick={props.onClose}>✕ Закрыть</Button>
        </div>
        <div style={{ color: 'var(--muted, #64748b)', fontSize: 13 }}>
          Файл — отчёт 1С «Остатки и доступность товаров», сохранённый как <b>Текстовый файл (.txt)</b>. Импорт — ревизия: остаток
          склада приводится к числам из файла (файл показывает реальный физический остаток, поэтому расход нарядами не списывается
          дважды). Позиции, которых 1С не знает (например, детали от разборки), не затрагиваются; пропавшие из отчёта — обнуляются.
        </div>

        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--muted, #64748b)' }}>Файл отчёта (.txt из 1С)</span>
          <input type="file" accept=".txt,text/plain" onChange={(e) => void pickFile(e)} />
        </label>

        {report && (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--muted, #64748b)' }}>Склад из файла 1С</span>
              <select value={blockIdx} onChange={(e) => setBlockIdx(Number(e.target.value))} style={{ padding: '6px 8px', borderRadius: 8 }}>
                {report.warehouses.map((w, i) => (
                  <option key={i} value={i}>
                    {w.warehouseName || '(без названия)'} — {w.items.length} строк
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--muted, #64748b)' }}>Склад программы (куда применить)</span>
              <select value={targetLocationId} onChange={(e) => setTargetLocationId(e.target.value)} style={{ padding: '6px 8px', borderRadius: 8 }}>
                {locations.map((l) => (
                  <option key={String(l.id)} value={String(l.id)}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {report && noms == null && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--muted, #64748b)' }}>
            <Spinner size={20} /> Загрузка номенклатуры для сопоставления...
          </div>
        )}

        {matching && (
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13 }}>
              <span>✅ Сопоставлено: <b>{matching.matched.length}</b></span>
              <span style={{ color: matching.toCreate.length ? '#0369a1' : undefined }}>🆕 Новых (нет в программе): <b>{matching.toCreate.length}</b></span>
              {matching.ambiguous.length > 0 && <span style={{ color: '#b45309' }}>⚠ Неоднозначно (пропускаются): <b>{matching.ambiguous.length}</b></span>}
              {matching.fractional > 0 && <span title="Складской учёт целочисленный — дробные округлены">≈ Дробных (округлено): <b>{matching.fractional}</b></span>}
            </div>
            <div style={{ fontSize: 13 }}>
              {balances == null || prevLoading ? (
                <span style={{ color: 'var(--muted, #64748b)' }}>Читаем остатки склада и прошлый импорт…</span>
              ) : prevImport ? (
                <span>Прошлый импорт: <b>{prevImport.docNo}</b> ({new Date(prevImport.docDate).toLocaleString('ru-RU')}). Ревизия — к текущему остатку склада «{locName(targetLocationId)}».</span>
              ) : (
                <span><b>Первый импорт</b> на складе «{locName(targetLocationId)}» — остатки будут приведены к числам из файла.</span>
              )}
            </div>
            {matching.toCreate.length > 0 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)} />
                <span>
                  Завести новые позиции в номенклатуре ({matching.toCreate.length}) — имя без артикула, артикул отдельным полем
                </span>
              </label>
            )}
            <div style={{ fontSize: 13 }}>
              К проводке: <b style={{ color: '#15803d' }}>+{plus.reduce((s, x) => s + x.delta, 0)}</b> по {plus.length} позициям,{' '}
              <b style={{ color: '#b91c1c' }}>{minus.reduce((s, x) => s + x.delta, 0)}</b> по {minus.length} позициям
              {willCreate > 0 && <>, приход по новым: <b style={{ color: '#0369a1' }}>+{matching.createQty}</b> по {willCreate} позициям</>}
              {zeroed.length > 0 && <> (обнуляется пропавших из отчёта: {zeroed.length})</>}
              {totalLines === 0 && <b> — изменений нет, проводить нечего.</b>}
            </div>
            {matching.toCreate.length > 0 && (
              <details>
                <summary style={{ cursor: 'pointer', fontSize: 13 }}>
                  Показать новые позиции ({matching.toCreate.length}){createMissing ? ' — будут заведены' : ' — будут пропущены'}
                </summary>
                <div style={{ maxHeight: 180, overflow: 'auto', fontSize: 12, color: 'var(--muted, #64748b)', padding: '6px 0' }}>
                  {matching.toCreate.slice(0, 700).map((x, i) => (
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

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          {busy && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--muted, #64748b)' }}>
              <Spinner size={18} /> {busy}
            </span>
          )}
          <Button variant="ghost" onClick={props.onClose}>Отмена</Button>
          <Button disabled={!matching || !targetLocationId || !!busy || balances == null || totalLines === 0} onClick={() => void post()}>
            Провести импорт ({totalLines} строк)
          </Button>
        </div>
      </div>
    </div>
  );
}
