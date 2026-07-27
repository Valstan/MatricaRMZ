import React, { useEffect, useMemo, useState } from 'react';
import {
  STOCK_1C_IMPORT_SOURCE,
  diff1cSnapshot,
  match1cKey,
  parse1cStockReport,
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

  const api = window.matrica as unknown as {
    warehouseLocations: { list: (a?: { activeOnly?: boolean }) => Promise<unknown> };
    warehouse: {
      nomenclatureList: (a?: Record<string, unknown>) => Promise<unknown>;
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
            all.push({ id: String(row.id ?? ''), name: String(row.name ?? ''), article: String(row.article ?? row.articul ?? '') });
          }
          if (!r.hasMore || rows.length === 0) break;
        }
        if (!alive) return;
        setNoms(all.filter((n) => n.id));
      } catch (e) {
        if (alive) setError(`Не удалось загрузить справочники: ${String(e)}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [props.open]);

  // Прошлый импорт по выбранному складу: последний проведённый stock_inventory
  // с меткой источника 1С в payload (там же лежит снапшот).
  useEffect(() => {
    if (!props.open || !targetLocationId) return;
    let alive = true;
    setPrevLoading(true);
    setPrevImport(null);
    void (async () => {
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

  // Матчинг: артикул → имя (оба compact-нормализованные, дефисы/пробелы не важны).
  const matching = useMemo(() => {
    if (!report || !noms) return null;
    const block = report.warehouses[blockIdx];
    if (!block) return null;
    const byArticle = new Map<string, NomRow[]>();
    const byName = new Map<string, NomRow[]>();
    for (const n of noms) {
      const k = match1cKey(n.article, n.name);
      if (k.articleKey) byArticle.set(k.articleKey, [...(byArticle.get(k.articleKey) ?? []), n]);
      if (k.nameKey) byName.set(k.nameKey, [...(byName.get(k.nameKey) ?? []), n]);
    }
    const matched: Array<{ item: (typeof block.items)[number]; nom: NomRow }> = [];
    const unmatched: typeof block.items = [];
    const ambiguous: typeof block.items = [];
    for (const item of block.items) {
      const k = match1cKey(item.article, item.name);
      const cands = (k.articleKey ? byArticle.get(k.articleKey) : undefined) ?? byName.get(k.nameKey) ?? [];
      if (cands.length === 1) matched.push({ item, nom: cands[0]! });
      else if (cands.length > 1) ambiguous.push(item);
      else unmatched.push(item);
    }
    const snapshot: Stock1cSnapshotEntry[] = matched.map((m) => ({ nomenclatureId: m.nom.id, qty: m.item.qty }));
    const deltas = diff1cSnapshot(prevImport?.snapshot ?? [], snapshot);
    const fractional = matched.filter((m) => m.item.qty % 1 !== 0).length;
    return { block, matched, unmatched, ambiguous, snapshot, deltas, fractional };
  }, [report, blockIdx, noms, prevImport]);

  async function post() {
    if (!matching || !targetLocationId) return;
    setBusy('Проводим импорт...');
    setError('');
    try {
      const now = Date.now();
      const d = new Date(now);
      const pad = (x: number) => String(x).padStart(2, '0');
      const docNo = `1C-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
      const created = await api.warehouse.documentCreate({
        docType: 'stock_inventory',
        docNo,
        docDate: now,
        header: { warehouseId: targetLocationId, reason: `Импорт остатков из 1С (${fileName})` },
        payloadJson: JSON.stringify({ source: STOCK_1C_IMPORT_SOURCE, importSnapshot: matching.snapshot, importFileName: fileName }),
        lines: matching.deltas.map((x) => ({
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
      if (matching.deltas.length > 0) {
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

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--surface, #fff)', borderRadius: 14, width: 'min(880px, 94vw)', maxHeight: '90vh', overflow: 'auto', padding: 18, display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontWeight: 800, fontSize: 16, flex: '1 1 auto' }}>Импорт остатков из 1С</div>
          <Button variant="ghost" onClick={props.onClose}>✕ Закрыть</Button>
        </div>
        <div style={{ color: 'var(--muted, #64748b)', fontSize: 13 }}>
          Файл — отчёт 1С «Остатки и доступность товаров», сохранённый как <b>Текстовый файл (.txt)</b>. Импорт — ревизия «слоя 1С»:
          сравнивается с прошлым импортом; остатки, заведённые нарядами и документами программы, не затрагиваются. Позиции, пропавшие из
          отчёта, обнуляются.
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
              <span style={{ color: matching.unmatched.length ? '#b45309' : undefined }}>❓ Не найдено в программе: <b>{matching.unmatched.length}</b></span>
              {matching.ambiguous.length > 0 && <span style={{ color: '#b45309' }}>⚠ Неоднозначно: <b>{matching.ambiguous.length}</b></span>}
              {matching.fractional > 0 && <span title="Складской учёт целочисленный — дробные округлены">≈ Дробных (округлено): <b>{matching.fractional}</b></span>}
            </div>
            <div style={{ fontSize: 13 }}>
              {prevLoading ? (
                <span style={{ color: 'var(--muted, #64748b)' }}>Ищем прошлый импорт…</span>
              ) : prevImport ? (
                <span>Прошлый импорт: <b>{prevImport.docNo}</b> ({new Date(prevImport.docDate).toLocaleString('ru-RU')}) — сравнение с ним.</span>
              ) : (
                <span>Прошлых импортов на складе «{locName(targetLocationId)}» нет — <b>первый импорт</b>, все позиции лягут приходом слоя 1С.</span>
              )}
            </div>
            <div style={{ fontSize: 13 }}>
              К проводке: <b style={{ color: '#15803d' }}>+{plus.reduce((s, x) => s + x.delta, 0)}</b> по {plus.length} позициям,{' '}
              <b style={{ color: '#b91c1c' }}>{minus.reduce((s, x) => s + x.delta, 0)}</b> по {minus.length} позициям
              {zeroed.length > 0 && <> (из них обнуляется пропавших из отчёта: {zeroed.length})</>}
              {matching.deltas.length === 0 && <b> — изменений нет, проводить нечего.</b>}
            </div>
            {matching.unmatched.length > 0 && (
              <details>
                <summary style={{ cursor: 'pointer', fontSize: 13 }}>Показать ненайденные позиции ({matching.unmatched.length}) — они будут пропущены</summary>
                <div style={{ maxHeight: 180, overflow: 'auto', fontSize: 12, color: 'var(--muted, #64748b)', padding: '6px 0' }}>
                  {matching.unmatched.slice(0, 200).map((x, i) => (
                    <div key={i}>
                      {x.article ? `[${x.article}] ` : ''}{x.name} — {x.qty} {x.unit}
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
          <Button disabled={!matching || !targetLocationId || !!busy || matching.deltas.length === 0} onClick={() => void post()}>
            Провести импорт ({matching?.deltas.length ?? 0} строк)
          </Button>
        </div>
      </div>
    </div>
  );
}
