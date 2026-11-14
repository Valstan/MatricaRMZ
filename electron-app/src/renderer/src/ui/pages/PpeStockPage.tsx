import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PPE_STOCK_WAREHOUSE_CODE, PPE_STOCK_WAREHOUSE_NAME, type WarehouseStockListItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { Input } from '../components/Input.js';
import { ListCount } from '../components/ListCount.js';
import { RowNumberCell, RowNumberHeaderCell } from '../components/RowNumberCell.js';
import { SectionCard } from '../components/SectionCard.js';
import { fetchWarehouseStockAllPagesEx } from '../utils/warehousePagedFetch.js';

const ROWNUM_STYLE: React.CSSProperties = { width: '1%', whiteSpace: 'nowrap', textAlign: 'right', color: '#6b7280' };

type PreviewRow = {
  line: number;
  name: string;
  unit: string | null;
  reportQty: number;
  currentQty: number;
  delta: number;
  action: 'create' | 'match' | 'unchanged';
  nomenclatureId: string | null;
  note: string | null;
};

type Preview = {
  previewId: string;
  expiresAt: number;
  preview: {
    reportDate: number | null;
    title: string[];
    warehouse: { code: string; name: string; exists: boolean };
    rows: PreviewRow[];
    summary: { total: number; create: number; match: number; unchanged: number; changed: number };
  };
};

type ApplyReport = {
  docNo: string | null;
  documentId: string | null;
  created: number;
  matched: number;
  unchanged: number;
  posted: number;
};

const ACTION_RU: Record<PreviewRow['action'], string> = {
  create: 'заведём',
  match: 'обновим',
  unchanged: 'совпадает',
};

function fileToBase64(file: File): Promise<string> {
  return file.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  });
}

function formatReportDate(ts: number | null): string {
  if (!ts) return 'дата отчёта не указана';
  const d = new Date(ts);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/**
 * Склад СИЗ: отдельная локация склада (`workwear`), а не фильтр по категории
 * в общем списке остатков — кладовщику не нужны чужие запчасти.
 *
 * Остатки приходят отчётом (выгрузка 1С «Остатки товаров»): файл → проверка →
 * план построчно → применение. Импорт — корректировка остатка, поэтому повтор
 * того же отчёта остаток не удваивает.
 */
export function PpeStockPage(props: { canPost?: boolean }) {
  const [rows, setRows] = useState<WarehouseStockListItem[]>([]);
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [file, setFile] = useState<{ name: string; size: number; base64: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [report, setReport] = useState<ApplyReport | null>(null);
  const [busy, setBusy] = useState(false);
  const canPost = props.canPost ?? true;

  const { confirm } = useConfirm();

  const refresh = useCallback(async () => {
    try {
      setStatus('Загрузка остатков...');
      const fetched = await fetchWarehouseStockAllPagesEx({
        warehouseId: PPE_STOCK_WAREHOUSE_CODE,
        ...(query.trim() ? { search: query.trim() } : {}),
      });
      setRows(fetched.rows);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sorted = useMemo(
    () =>
      [...rows].sort(
        (a, b) =>
          String(a.nomenclatureName ?? '').localeCompare(String(b.nomenclatureName ?? ''), 'ru') ||
          String(a.warehouseName ?? a.warehouseId ?? '').localeCompare(String(b.warehouseName ?? b.warehouseId ?? ''), 'ru'),
      ),
    [rows],
  );

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    e.target.value = '';
    if (!picked) return;
    if (picked.size > 10 * 1024 * 1024) return setStatus('Ошибка: файл больше 10 МБ — сохраните выгрузку компактнее');
    setBusy(true);
    try {
      const base64 = await fileToBase64(picked);
      setFile({ name: picked.name, size: picked.size, base64 });
      setPreview(null);
      setReport(null);
      setStatus('');
    } catch (err) {
      setStatus(`Ошибка чтения файла: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function runPreview() {
    if (!file) return;
    setBusy(true);
    try {
      const res = await window.matrica.ppe.stockImport.preview({ filename: file.name, contentBase64: file.base64 });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        setPreview(null);
        return;
      }
      setPreview({ previewId: res.previewId, expiresAt: res.expiresAt, preview: res.preview });
      setReport(null);
      setStatus('');
    } finally {
      setBusy(false);
    }
  }

  async function runApply() {
    if (!file || !preview) return;
    const s = preview.preview.summary;
    const ok = await confirm({
      title: 'Загрузить остатки на склад СИЗ?',
      detail: `Позиций в отчёте: ${s.total}. Новых: ${s.create}. Обновится: ${s.match}. Без изменений: ${s.unchanged}. Изменений к проведению: ${s.changed}. Склад: ${preview.preview.warehouse.name}.`,
      confirmLabel: 'Загрузить',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await window.matrica.ppe.stockImport.apply({ previewId: preview.previewId, contentBase64: file.base64 });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      setReport(res.report);
      setPreview(null);
      setStatus(res.report.posted > 0 ? 'Остатки загружены' : 'Остатки уже совпадают с отчётом — склад не менялся');
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <SectionCard title="Склад СИЗ">
        <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 8 }}>
          Отдельный склад спецодежды — чужие запчасти кладовщику не видны. Остатки приходят отчётом (выгрузка 1С
          «Остатки товаров»): загрузка правит остаток до значения отчёта, поэтому повтор того же отчёта остаток не
          удваивает.
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по названию" style={{ flex: 1 }} />
          {canPost ? (
            <>
              <input type="file" accept=".xlsx" onChange={(e) => void onPick(e)} disabled={busy} />
              <Button variant="primary" onClick={() => void runPreview()} disabled={busy || !file}>
                Проверить файл
              </Button>
              {preview ? (
                <Button variant="primary" onClick={() => void runApply()} disabled={busy}>
                  Загрузить остатки
                </Button>
              ) : null}
            </>
          ) : (
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>
              Загрузка отчёта доступна с правом проведения складских документов.
            </span>
          )}
          {file ? (
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>
              {file.name} · {Math.round(file.size / 1024)} КБ
            </span>
          ) : null}
        </div>
        {status ? (
          <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger, #b00)' : 'var(--muted)' }}>{status}</div>
        ) : null}
        {sorted.length === 0 && status === '' ? (
          <div style={{ color: 'var(--muted)' }}>
            Остатков на складе СИЗ нет. Загрузите отчёт об остатках — и кладовщик увидит, что можно выдавать.
          </div>
        ) : (
          <>
            <ListCount total={sorted.length} shown={sorted.length} />
            <table className="table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <RowNumberHeaderCell style={ROWNUM_STYLE} />
                  <th>Позиция</th>
                  <th>Склад</th>
                  <th style={{ textAlign: 'right' }}>Остаток</th>
                  <th style={{ textAlign: 'right' }}>Резерв</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r, i) => (
                  <tr key={r.id}>
                    <RowNumberCell n={i + 1} style={ROWNUM_STYLE} />
                    <td>{r.nomenclatureName || '—'}</td>
                    <td>{r.warehouseName || r.warehouseId || PPE_STOCK_WAREHOUSE_NAME}</td>
                    <td style={{ textAlign: 'right' }}>{r.qty}</td>
                    <td style={{ textAlign: 'right' }}>{r.reservedQty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </SectionCard>

      {preview ? (
        <SectionCard title="План загрузки остатков">
          <div style={{ fontSize: 13, marginBottom: 8 }}>
            Отчёт: {formatReportDate(preview.preview.reportDate)} · склад «{preview.preview.warehouse.name}» · позиций{' '}
            {preview.preview.summary.total} · изменится {preview.preview.summary.changed}.
            {preview.preview.warehouse.exists ? '' : ' Склад будет заведён при загрузке.'}
          </div>
          <ListCount total={preview.preview.rows.length} shown={preview.preview.rows.length} />
          <div style={{ maxHeight: 420, overflow: 'auto' }}>
            <table className="table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <RowNumberHeaderCell style={ROWNUM_STYLE} />
                  <th>Позиция</th>
                  <th>Ед.</th>
                  <th style={{ textAlign: 'right' }}>По отчёту</th>
                  <th style={{ textAlign: 'right' }}>На складе</th>
                  <th style={{ textAlign: 'right' }}>Изменение</th>
                  <th>Действие</th>
                </tr>
              </thead>
              <tbody>
                {preview.preview.rows.map((r) => (
                  <tr key={r.line}>
                    <RowNumberCell n={r.line} style={ROWNUM_STYLE} />
                    <td>{r.name}</td>
                    <td>{r.unit ?? '—'}</td>
                    <td style={{ textAlign: 'right' }}>{r.reportQty}</td>
                    <td style={{ textAlign: 'right' }}>{r.currentQty}</td>
                    <td style={{ textAlign: 'right' }}>{r.delta > 0 ? `+${r.delta}` : r.delta < 0 ? r.delta : '—'}</td>
                    <td>{ACTION_RU[r.action]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ) : null}

      {report ? (
        <SectionCard title="Итог загрузки">
          <div style={{ fontSize: 13 }}>
            {report.posted > 0
              ? `Проведён документ ${report.docNo}: строк — ${report.posted}. Заведено позиций — ${report.created}, найдено — ${report.matched}, без изменений — ${report.unchanged}.`
              : `Остатки совпали с отчётом — склад не менялся. Заведено позиций — ${report.created}, найдено — ${report.matched}.`}
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
