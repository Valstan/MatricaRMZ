import React, { useEffect, useState } from 'react';

import type { TimesheetHeader } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { useConfirm } from '../components/ConfirmContext.js';

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

type WorkshopOpt = { id: string; name: string };

export function TimesheetsPage(props: { canEdit: boolean; onOpen: (id: string) => void }) {
  const { confirm } = useConfirm();
  const now = new Date();
  const [workshops, setWorkshops] = useState<WorkshopOpt[]>([]);
  const [departments, setDepartments] = useState<WorkshopOpt[]>([]);
  const [rows, setRows] = useState<TimesheetHeader[]>([]);
  // Область табеля закодирована как "w:<id>" (цех) или "d:<id>" (подразделение).
  const [scopeKey, setScopeKey] = useState('');
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [weekMode, setWeekMode] = useState<5 | 6>(6);
  const [busy, setBusy] = useState('');

  async function load() {
    const [w, d, t] = await Promise.all([
      window.matrica.workshops.list({ activeOnly: true }),
      window.matrica.timesheets.departments(),
      window.matrica.timesheets.list(),
    ]);
    const wOpts: WorkshopOpt[] = w.ok ? w.rows.map((r) => ({ id: r.id, name: r.name })) : [];
    const dOpts: WorkshopOpt[] = d?.ok ? (d.rows as WorkshopOpt[]).map((r) => ({ id: String(r.id), name: String(r.name) })) : [];
    setWorkshops(wOpts);
    setDepartments(dOpts);
    setScopeKey((prev) => prev || (wOpts[0] ? `w:${wOpts[0].id}` : dOpts[0] ? `d:${dOpts[0].id}` : ''));
    if (t.ok) setRows(t.rows);
  }
  useEffect(() => {
    void load();
  }, []);

  async function create() {
    if (!scopeKey) {
      setBusy('Выберите цех или подразделение');
      setTimeout(() => setBusy(''), 2000);
      return;
    }
    setBusy('Создание…');
    const scope = scopeKey.startsWith('d:') ? { departmentId: scopeKey.slice(2) } : { workshopId: scopeKey.slice(2) };
    const r = await window.matrica.timesheets.create({ ...scope, year, month, weekMode });
    if (!r.ok) {
      setBusy(`Ошибка: ${r.error}`);
      setTimeout(() => setBusy(''), 3500);
      return;
    }
    setBusy('');
    props.onOpen(r.id);
  }

  async function remove(id: string, label: string) {
    const ok = await confirm({ detail: `Удалить табель «${label}»? Действие необратимо.` });
    if (!ok) return;
    const r = await window.matrica.timesheets.delete(id);
    if (!r.ok) {
      setBusy(`Ошибка: ${r.error}`);
      setTimeout(() => setBusy(''), 3000);
      return;
    }
    void load();
  }

  return (
    <div style={{ padding: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Табель учёта рабочего времени</h2>
        {busy && <span style={{ color: busy.startsWith('Ошибка') ? '#b91c1c' : '#64748b', fontSize: 13 }}>{busy}</span>}
      </div>

      {props.canEdit && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 10, padding: 12, border: '1px solid #e5e7eb', borderRadius: 12, marginBottom: 14, background: '#f8fafc' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, color: '#64748b' }}>
            Цех / подразделение
            <select value={scopeKey} onChange={(e) => setScopeKey(e.target.value)} style={selStyle}>
              {workshops.length === 0 && departments.length === 0 && <option value="">— нет цехов и подразделений —</option>}
              {workshops.length > 0 && (
                <optgroup label="Цеха">
                  {workshops.map((w) => (
                    <option key={`w:${w.id}`} value={`w:${w.id}`}>{w.name}</option>
                  ))}
                </optgroup>
              )}
              {departments.length > 0 && (
                <optgroup label="Подразделения">
                  {departments.map((d) => (
                    <option key={`d:${d.id}`} value={`d:${d.id}`}>{d.name}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, color: '#64748b' }}>
            Месяц
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))} style={selStyle}>
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>{m}</option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, color: '#64748b' }}>
            Год
            <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ ...selStyle, width: 90 }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, color: '#64748b' }}>
            Режим недели
            <select value={weekMode} onChange={(e) => setWeekMode(Number(e.target.value) === 5 ? 5 : 6)} style={selStyle}>
              <option value={6}>6-дневка (вс — выходной)</option>
              <option value={5}>5-дневка (сб, вс — выходные)</option>
            </select>
          </label>
          <Button variant="primary" onClick={() => void create()}>Создать табель</Button>
        </div>
      )}

      <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'linear-gradient(135deg, #0f766e 0%, #14b8a6 120%)', color: '#fff' }}>
              <th style={thStyle}>Цех / подразделение</th>
              <th style={thStyle}>Период</th>
              <th style={thStyle}>Режим</th>
              <th style={thStyle}>Норма, ч</th>
              <th style={thStyle}>Статус</th>
              <th style={{ ...thStyle, width: 200 }}>Действия</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const period = `${MONTHS[r.month - 1] ?? r.month} ${r.year}`;
              return (
                <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => props.onOpen(r.id)}>
                  <td style={tdStyle}>{r.scopeName || r.workshopName}</td>
                  <td style={tdStyle}>{period}</td>
                  <td style={tdStyle}>{r.weekMode}-дн.</td>
                  <td style={tdStyle}>{r.normHours ?? '—'}</td>
                  <td style={tdStyle}>{r.status === 'closed' ? 'Закрыт' : 'Черновик'}</td>
                  <td style={tdStyle} onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Button variant="ghost" onClick={() => props.onOpen(r.id)}>Открыть</Button>
                      {props.canEdit && (
                        <Button variant="ghost" onClick={() => void remove(r.id, `${r.scopeName || r.workshopName} · ${period}`)}>Удалить</Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} style={{ padding: 14, color: '#6b7280' }}>
                  Табелей пока нет. {props.canEdit ? 'Выберите цех и месяц, затем «Создать табель».' : ''}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const selStyle: React.CSSProperties = { height: 32, padding: '4px 8px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#0b1220' };
const thStyle: React.CSSProperties = { textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)' };
const tdStyle: React.CSSProperties = { padding: 10, borderBottom: '1px solid #f3f4f6', fontSize: 14 };
