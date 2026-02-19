import React, { useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';

type ActionType = 'create' | 'update' | 'delete' | 'session' | 'other';

type AuditRow = {
  id: string;
  createdAt: number;
  actor: string;
  action: string;
  actionType: ActionType;
  section: string;
  actionText: string;
  documentLabel: string;
  clientId: string | null;
  tableName: string | null;
};

type DailyRow = {
  login: string;
  fullName: string;
  onlineMs: number;
  onlineHours: number;
  created: number;
  updated: number;
  deleted: number;
  totalChanged: number;
};

function todayIsoDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dateStartMs(localDate: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(localDate ?? '').trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime();
}

function dateEndMs(localDate: string): number | null {
  const start = dateStartMs(localDate);
  if (start == null) return null;
  return start + 24 * 60 * 60 * 1000 - 1;
}

function formatOnlineHours(ms: number) {
  const totalMin = Math.round(Math.max(0, Number(ms ?? 0)) / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h} ч ${String(m).padStart(2, '0')} мин`;
}

export function SuperadminAuditPage() {
  const [fromDate, setFromDate] = useState<string>(todayIsoDate());
  const [toDate, setToDate] = useState<string>(todayIsoDate());
  const [reportDate, setReportDate] = useState<string>(todayIsoDate());
  const [actor, setActor] = useState<string | null>(null);
  const [actionType, setActionType] = useState<string | null>(null);
  const [section, setSection] = useState<string | null>(null);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [dailyRows, setDailyRows] = useState<DailyRow[]>([]);
  const [status, setStatus] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);

  const actorOptions = useMemo(() => {
    const uniq = Array.from(new Set(rows.map((r) => String(r.actor ?? '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ru'));
    return uniq.map((id) => ({ id, label: id }));
  }, [rows]);

  const actionTypeOptions = useMemo(
    () => [
      { id: 'session', label: 'Сессии (включил/выключил)' },
      { id: 'create', label: 'Создание' },
      { id: 'update', label: 'Изменение' },
      { id: 'delete', label: 'Удаление' },
      { id: 'other', label: 'Прочее' },
    ],
    [],
  );
  const sectionOptions = useMemo(() => {
    const uniq = Array.from(new Set(rows.map((r) => String(r.section ?? '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ru'));
    return uniq.map((id) => ({ id, label: id }));
  }, [rows]);

  const filteredRows = useMemo(() => {
    if (!section) return rows;
    return rows.filter((r) => String(r.section ?? '') === section);
  }, [rows, section]);

  async function loadAll() {
    setLoading(true);
    setStatus('');
    try {
      const fromMs = fromDate ? dateStartMs(fromDate) : null;
      const toMs = toDate ? dateEndMs(toDate) : null;
      const [listRes, summaryRes] = await Promise.all([
        window.matrica.admin.audit.list({
          limit: 4000,
          ...(fromMs != null ? { fromMs } : {}),
          ...(toMs != null ? { toMs } : {}),
          ...(actor ? { actor } : {}),
          ...(actionType ? { actionType: actionType as ActionType } : {}),
        }),
        window.matrica.admin.audit.dailySummary({ date: reportDate, cutoffHour: 21 }),
      ]);
      if (!listRes?.ok) throw new Error(String((listRes as any)?.error ?? 'list error'));
      if (!summaryRes?.ok) throw new Error(String((summaryRes as any)?.error ?? 'daily summary error'));
      setRows(Array.isArray((listRes as any).rows) ? ((listRes as any).rows as AuditRow[]) : []);
      setDailyRows(Array.isArray((summaryRes as any).rows) ? ((summaryRes as any).rows as DailyRow[]) : []);
      setStatus('Журнал и сводка обновлены.');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <div style={{ marginBottom: 8, color: 'var(--muted)' }}>
        Раздел доступен только суперадминистратору. Здесь видно кто, где и что изменил, а также сводка по всем клиентам на 21:00.
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Button onClick={loadAll} disabled={loading}>
          {loading ? 'Обновление...' : 'Обновить'}
        </Button>
        <div style={{ width: 160 }}>
          <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          <div style={{ fontSize: 12, color: 'var(--subtle)', marginTop: 2 }}>с даты</div>
        </div>
        <div style={{ width: 160 }}>
          <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          <div style={{ fontSize: 12, color: 'var(--subtle)', marginTop: 2 }}>по дату</div>
        </div>
        <div style={{ width: 260 }}>
          <SearchSelect value={actor} options={actorOptions} placeholder="Аккаунт" onChange={setActor} />
        </div>
        <div style={{ width: 260 }}>
          <SearchSelect value={actionType} options={actionTypeOptions} placeholder="Тип действия" onChange={setActionType} />
        </div>
        <div style={{ width: 220 }}>
          <SearchSelect value={section} options={sectionOptions} placeholder="Раздел" onChange={setSection} />
        </div>
        {(actor || actionType || section) && (
          <Button
            variant="ghost"
            onClick={() => {
              setActor(null);
              setActionType(null);
              setSection(null);
            }}
          >
            Сбросить фильтры
          </Button>
        )}
      </div>

      <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ width: 160 }}>
          <Input type="date" value={reportDate} onChange={(e) => setReportDate(e.target.value)} />
        </div>
        <div style={{ color: 'var(--muted)', fontSize: 12 }}>Сводка на 21:00</div>
      </div>

      {status && (
        <div style={{ marginTop: 8, color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--muted)' }}>
          {status}
        </div>
      )}

      <div style={{ marginTop: 10, border: '1px solid var(--border)', overflow: 'hidden' }}>
        <div style={{ padding: 10, fontWeight: 700, background: 'var(--surface2)' }}>Сводный отчет по клиентам (21:00)</div>
        <table className="list-table">
          <thead>
            <tr style={{ background: 'var(--button-primary-bg)', color: 'var(--button-primary-text)' }}>
              <th style={{ textAlign: 'left', padding: 8 }}>Аккаунт</th>
              <th style={{ textAlign: 'left', padding: 8 }}>ФИО</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Онлайн</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Создано</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Изменено</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Удалено</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Всего изменений</th>
            </tr>
          </thead>
          <tbody>
            {dailyRows.map((r) => (
              <tr key={r.login}>
                <td style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>{r.login}</td>
                <td style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>{r.fullName || '-'}</td>
                <td style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>{formatOnlineHours(r.onlineMs)}</td>
                <td style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>{r.created}</td>
                <td style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>{r.updated}</td>
                <td style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>{r.deleted}</td>
                <td style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>{r.totalChanged}</td>
              </tr>
            ))}
            {dailyRows.length === 0 && (
              <tr>
                <td style={{ padding: 10, color: 'var(--muted)' }} colSpan={7}>
                  Нет данных за выбранный день.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 12, border: '1px solid var(--border)', overflow: 'hidden' }}>
        <div style={{ padding: 10, fontWeight: 700, background: 'var(--surface2)' }}>Журнал действий пользователей</div>
        <table className="list-table">
          <thead>
            <tr style={{ background: 'var(--surface-2)', color: 'var(--text)' }}>
              <th style={{ textAlign: 'left', padding: 8 }}>Время</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Аккаунт</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Действие</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Раздел/документ</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Клиент</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r) => (
              <tr key={r.id}>
                <td style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>{new Date(r.createdAt).toLocaleString('ru-RU')}</td>
                <td style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>{r.actor}</td>
                <td style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>{r.actionText}</td>
                <td style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
                  {r.section}
                  {r.documentLabel ? ` / ${r.documentLabel}` : ''}
                </td>
                <td style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>{r.clientId ?? '-'}</td>
              </tr>
            ))}
            {filteredRows.length === 0 && (
              <tr>
                <td style={{ padding: 10, color: 'var(--muted)' }} colSpan={5}>
                  Действий не найдено.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

