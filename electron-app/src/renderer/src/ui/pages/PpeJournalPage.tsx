import React, { useCallback, useEffect, useMemo, useState } from 'react';

import type { PpeJournalRow, PpeUndeliveredRow } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { FormField } from '../components/FormField.js';
import { Input } from '../components/Input.js';
import { ListCount } from '../components/ListCount.js';
import { RowNumberCell, RowNumberHeaderCell } from '../components/RowNumberCell.js';
import { SectionCard } from '../components/SectionCard.js';
import { escapeHtml, formatMomentLabel, openPrintPreview, type PrintSection } from '../utils/printPreview.js';

const ROWNUM_STYLE: React.CSSProperties = { width: '1%', whiteSpace: 'nowrap', textAlign: 'right', color: '#6b7280' };
const DAY_MS = 86_400_000;

function fmtDate(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function toDateInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fromDateInput(value: string, endOfDay: boolean): number | null {
  if (!value) return null;
  const [y, m, d] = value.split('-').map((x) => Number(x));
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, 0).getTime();
}

/**
 * Журнал приёмки СИЗ: факты выдачи + контекст нормы, и отчёт «невыданное».
 *
 * Главное в этом экране — что «количество на год» и «срок носки» стоят РАЗНЫМИ
 * колонками (решение владельца от 05.11). Это разные величины: смешанные в одну,
 * они читаются как «норма не выполнена», хотя не выполнено другое. Поэтому и в отчёте
 * невыданное количество и просроченный срок показываются рядом, а не слитым статусом.
 */
export function PpeJournalPage() {
  const now = Date.now();
  const [from, setFrom] = useState(toDateInput(now - 30 * DAY_MS));
  const [to, setTo] = useState(toDateInput(now));
  const [rows, setRows] = useState<PpeJournalRow[]>([]);
  const [undelivered, setUndelivered] = useState<PpeUndeliveredRow[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const fromMs = fromDateInput(from, false);
    const toMs = fromDateInput(to, true);
    if (fromMs == null || toMs == null) {
      setStatus('Задайте период');
      return;
    }
    setBusy(true);
    try {
      const res = await window.matrica.ppe.journal.list({ fromMs, toMs });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      setRows(res.rows);
      setUndelivered(res.undelivered);
      setStatus('');
    } finally {
      setBusy(false);
    }
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const journalHtml = useMemo(() => {
    const body = rows
      .map(
        (r, i) =>
          `<tr><td style="text-align:right;">${i + 1}</td><td>${escapeHtml(fmtDate(r.issuedAt))}</td>` +
          `<td>${escapeHtml(r.personnelNo ?? '')}</td><td>${escapeHtml(r.fullName)}</td>` +
          `<td>${escapeHtml(r.postTitle ?? '')}</td><td>${escapeHtml(r.itemName)}</td>` +
          `<td>${escapeHtml(r.size ?? '')}</td><td style="text-align:right;">${r.qty}</td>` +
          `<td style="text-align:right;">${r.normQty == null ? '—' : r.normQty}</td>` +
          `<td>${escapeHtml(r.wearText)}</td></tr>`,
      )
      .join('');
    return (
      `<table><thead><tr><th>№</th><th style="text-align:left;">Дата выдачи</th>` +
      `<th style="text-align:left;">Таб. номер</th><th style="text-align:left;">ФИО</th>` +
      `<th style="text-align:left;">Должность</th><th style="text-align:left;">Позиция СИЗ</th>` +
      `<th style="text-align:left;">Размер</th><th style="text-align:right;">Выдано</th>` +
      `<th style="text-align:right;">Кол-во на год</th><th style="text-align:left;">Срок носки</th></tr></thead>` +
      `<tbody>${body}</tbody></table>`
    );
  }, [rows]);

  const undeliveredHtml = useMemo(() => {
    const body = undelivered
      .filter((r) => r.qtyShort > 0 || r.periodOverdue)
      .map(
        (r, i) =>
          `<tr><td style="text-align:right;">${i + 1}</td><td>${escapeHtml(r.fullName)}</td>` +
          `<td>${escapeHtml(r.itemName)}</td>` +
          `<td style="text-align:right;">${r.normQty}</td><td style="text-align:right;">${r.issuedQty}</td>` +
          `<td style="text-align:right;">${r.qtyShort}</td>` +
          `<td>${escapeHtml(r.wearText)}</td>` +
          `<td>${escapeHtml(fmtDate(r.nextDueAt))}</td></tr>`,
      )
      .join('');
    return (
      `<table><thead><tr><th>№</th><th style="text-align:left;">Сотрудник</th>` +
      `<th style="text-align:left;">Позиция СИЗ</th><th style="text-align:right;">Кол-во на год</th>` +
      `<th style="text-align:right;">Выдано</th><th style="text-align:right;">Невыдано</th>` +
      `<th style="text-align:left;">Срок носки</th><th style="text-align:left;">По сроку</th></tr></thead>` +
      `<tbody>${body}</tbody></table>`
    );
  }, [undelivered]);

  function print() {
    const title = `Журнал приёмки СИЗ за период ${fmtDate(fromDateInput(from, false))} — ${fmtDate(fromDateInput(to, true))}`;
    const sections: PrintSection[] = [
      {
        id: 'journal',
        title: 'Журнал приёмки',
        html: `<div style="font-size:12px;">Количество на год и срок носки — разные величины и стоят разными колонками.</div>${journalHtml}`,
      },
      {
        id: 'undelivered',
        title: 'Невыданное за период',
        html: `<div style="font-size:12px;">Невыданное количество и просроченный срок — тоже разные вещи: одни строки не сливаются.</div>${undeliveredHtml}`,
      },
    ];
    openPrintPreview({
      title,
      sections,
      printHeader: { title, meta: `Напечатано: ${formatMomentLabel(new Date())}` },
    });
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <SectionCard title="Период">
        <div style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
          <FormField label="С">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </FormField>
          <FormField label="По">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </FormField>
          <Button variant="primary" onClick={() => void load()} disabled={busy}>
            Показать
          </Button>
          <Button onClick={print} disabled={busy || rows.length === 0}>
            Печать
          </Button>
          {status ? <span style={{ color: 'var(--muted)' }}>{status}</span> : null}
        </div>
      </SectionCard>

      <SectionCard title="Журнал приёмки">
        <ListCount total={rows.length} shown={rows.length} />
        {rows.length === 0 ? (
          <div style={{ color: 'var(--muted)' }}>За период выдачи не было.</div>
        ) : (
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <RowNumberHeaderCell style={ROWNUM_STYLE} />
                <th>Дата выдачи</th>
                <th>Таб. номер</th>
                <th>ФИО</th>
                <th>Должность</th>
                <th>Позиция СИЗ</th>
                <th>Размер</th>
                <th style={{ textAlign: 'right' }}>Выдано</th>
                <th style={{ textAlign: 'right' }}>Кол-во на год</th>
                <th>Срок носки</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.issuedAt}-${r.employeeId}-${r.nomenclatureId}-${i}`}>
                  <RowNumberCell n={i + 1} style={ROWNUM_STYLE} />
                  <td>{fmtDate(r.issuedAt)}</td>
                  <td>{r.personnelNo ?? '—'}</td>
                  <td>{r.fullName}</td>
                  <td>{r.postTitle ?? '—'}</td>
                  <td>{r.itemName}</td>
                  <td>{r.size ?? '—'}</td>
                  <td style={{ textAlign: 'right' }}>{r.qty}</td>
                  <td style={{ textAlign: 'right' }}>{r.normQty ?? '—'}</td>
                  <td>{r.wearText}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>

      <SectionCard title="Невыданное за период">
        <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 8 }}>
          Невыданное количество и просроченный срок — разные вещи: их нельзя сливать в один статус,
          иначе невыданное количество читается как «норма не выполнена».
        </div>
        <ListCount
          total={undelivered.length}
          shown={undelivered.filter((r) => r.qtyShort > 0 || r.periodOverdue).length}
        />
        <table className="table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <RowNumberHeaderCell style={ROWNUM_STYLE} />
              <th>Сотрудник</th>
              <th>Позиция СИЗ</th>
              <th style={{ textAlign: 'right' }}>Кол-во на год</th>
              <th style={{ textAlign: 'right' }}>Выдано</th>
              <th style={{ textAlign: 'right' }}>Невыдано</th>
              <th>Срок носки</th>
              <th>По сроку</th>
            </tr>
          </thead>
          <tbody>
            {undelivered
              .filter((r) => r.qtyShort > 0 || r.periodOverdue)
              .map((r, i) => (
                <tr key={`${r.employeeId}-${r.nomenclatureId}`}>
                  <RowNumberCell n={i + 1} style={ROWNUM_STYLE} />
                  <td>{r.fullName}</td>
                  <td>{r.itemName}</td>
                  <td style={{ textAlign: 'right' }}>{r.normQty}</td>
                  <td style={{ textAlign: 'right' }}>{r.issuedQty}</td>
                  <td style={{ textAlign: 'right' }}>{r.qtyShort}</td>
                  <td>{r.wearText}</td>
                  <td style={r.periodOverdue ? { color: 'var(--danger, #b91c1c)' } : undefined}>
                    {fmtDate(r.nextDueAt)}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </SectionCard>
    </div>
  );
}
