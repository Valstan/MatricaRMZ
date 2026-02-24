import React, { useEffect, useMemo, useState } from 'react';

import { listUsers } from '../api/adminUsers.js';
import { dailyAuditSummary, listAudit } from '../api/audit.js';
import { Button } from './components/Button.js';
import { Input } from './components/Input.js';
import { SearchSelect } from './components/SearchSelect.js';

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

type AdminUserDirectoryItem = {
  login: string;
  fullName: string;
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

function toInitials(fullName: string, fallback: string) {
  const normalized = String(fullName ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const cleanFallback = String(fallback ?? '').trim() || '-';
  if (!normalized) return cleanFallback;
  const parts = normalized.split(' ').filter(Boolean);
  if (parts.length === 0) return cleanFallback;
  const surname = parts[0];
  const initials = parts
    .slice(1)
    .map((part) => (String(part ?? '').trim() ? `${String(part).trim().slice(0, 1).toUpperCase()}.` : ''))
    .join('');
  if (!initials) return surname;
  return `${surname} ${initials}`;
}

function formatAuditDate(ms: number) {
  const date = new Date(ms);
  const datePart = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  const timePart = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  return `${datePart.replace(/\s*г\.?$/u, '')}, ${timePart}`;
}

function formatClientId(rawClientId: string | null) {
  const normalized = String(rawClientId ?? '').trim();
  if (!normalized) return '-';
  const short = normalized.split('-')[0];
  return short || '-';
}

function describeAction(row: AuditRow) {
  const action = String(row.action ?? '').trim().toLowerCase();
  const fromText = String(row.actionText ?? '').trim();
  const section = String(row.section ?? '').trim();
  const target = String(row.documentLabel ?? '').trim();
  const normalizedFromText = fromText.toLowerCase();
  const sectionLabel = section ? `«${section}»` : '';
  const sectionLower = section.toLowerCase();
  const targetLabel = target ? `«${target}»` : '';
  const exactActionByCode: Record<string, string> = {
    'engine.create': 'Создал двигатель',
    'engine.update': 'Редактировал двигатель',
    'engine.delete': 'Удалил двигатель',
    'engine.edit_done': 'Редактировал двигатель',
    'ui.engine.edit_done': 'Редактировал двигатель',
    'part.create': 'Создал деталь',
    'part.update': 'Редактировал деталь',
    'part.delete': 'Удалил деталь',
    'supply_request.create': 'Создал заявку',
    'supply_request.update': 'Редактировал заявку',
    'supply_request.delete': 'Удалил заявку',
    'ui.supply_request.edit_done': 'Редактировал заявку',
    'employee.create': 'Создал сотрудника',
    'employee.update': 'Редактировал карточку сотрудника',
    'employee.delete': 'Удалил сотрудника',
    'tool.create': 'Добавил инструмент',
    'tool.update': 'Редактировал инструмент',
    'tool.delete': 'Удалил инструмент',
    'masterdata.create': 'Добавил запись справочника',
    'masterdata.update': 'Редактировал запись справочника',
    'masterdata.delete': 'Удалил запись справочника',
    'sync.create': 'Добавил запись синхронизации',
    'sync.update': 'Редактировал запись синхронизации',
    'sync.delete': 'Удалил запись синхронизации',
    'files.create': 'Добавил файл',
    'files.update': 'Редактировал файл',
    'files.delete': 'Удалил файл',
  };
  const createBySection: Record<string, string> = {
    'заявки': 'Создал заявку',
    'двигатели': 'Добавил двигатель',
    'детали': 'Добавил деталь',
    'сотрудники': 'Создал сотрудника',
    'инструменты': 'Добавил инструмент',
    'справочники': 'Добавил запись справочника',
    'синхронизация': 'Добавил запись синхронизации',
    'файлы': 'Добавил файл',
  };
  const updateBySection: Record<string, string> = {
    'заявки': 'Редактировал заявку',
    'двигатели': 'Редактировал двигатель',
    'детали': 'Редактировал деталь',
    'сотрудники': 'Редактировал карточку сотрудника',
    'инструменты': 'Редактировал инструмент',
    'справочники': 'Редактировал запись справочника',
    'синхронизация': 'Редактировал запись синхронизации',
    'файлы': 'Редактировал файл',
  };
  const deleteBySection: Record<string, string> = {
    'заявки': 'Удалил заявку',
    'двигатели': 'Удалил двигатель',
    'детали': 'Удалил деталь',
    'сотрудники': 'Удалил сотрудника',
    'инструменты': 'Удалил инструмент',
    'справочники': 'Удалил запись справочника',
    'синхронизация': 'Удалил запись синхронизации',
    'файлы': 'Удалил файл',
  };
  const openBySection: Record<string, string> = {
    'сотрудники': 'Открыл карточку сотрудника',
    'заявки': 'Открыл заявку',
    'детали': 'Открыл карточку детали',
    'двигатели': 'Открыл карточку двигателя',
    'инструменты': 'Открыл карточку инструмента',
    'файлы': 'Открыл карточку файла',
    'справочники': 'Открыл запись справочника',
    'синхронизация': 'Открыл запись синхронизации',
  };
  const openCard = openBySection[sectionLower] || 'Открыл карточку';
  const formatBySection = (actionText: string) => {
    if (targetLabel) return `${actionText} ${targetLabel}`;
    if (sectionLabel) return `${actionText} в ${sectionLabel}`;
    return actionText;
  };

  const genericByType = {
    create: new Set([
      'создал запись',
      'создал запись.',
      'создал двигатель',
      'создал деталь',
      'создал заявку',
      'создал заявку.',
      'создал карточку двигателя',
    ]),
    update: new Set([
      'изменил запись',
      'изменил запись.',
      'изменил карточку двигателя',
      'изменил карточку двигателя.',
      'изменил заявку',
      'изменил заявку.',
      'изменил статус заявки',
    ]),
    delete: new Set(['удалил запись', 'удалил запись.', 'удалил деталь', 'удалил деталь.', 'удалил заявку', 'удалил заявку.']),
  };

  if (action === 'app.session.start') return 'Зашел в систему';
  if (action === 'app.session.stop') return 'Вышел из системы';
  if (exactActionByCode[action]) return formatBySection(exactActionByCode[action]!);

  if (action === 'supply_request.transition') {
    const match = /^изменил статус заявки:\s*(.+?)\s*->\s*(.+)$/i.exec(fromText);
    if (match) {
      const from = String(match[1] ?? '').trim();
      const to = String(match[2] ?? '').trim();
      const statusTarget = target || sectionLabel ? `по ${target ? targetLabel : sectionLabel}` : '';
      return `Сменил статус заявки${statusTarget ? ` ${statusTarget}` : ''}: ${from} → ${to}`;
    }
  }
  if (action.endsWith('.edit_done')) {
    const base = formatBySection(updateBySection[sectionLower] || 'Редактировал');
    const summary = fromText.replace(/^изменил [^\.]+\.\s*/i, '').trim();
    return summary ? `${base}. ${summary}` : base;
  }
  if (action.includes('.open') || action.includes('.view') || action.includes('.details')) {
    const actionPhrase = openBySection[sectionLower] || 'Открыл страницу';
    if (targetLabel) return `${actionPhrase} ${targetLabel}${section ? ` в ${sectionLabel}` : ''}`;
    if (sectionLabel) return `${actionPhrase} в ${sectionLabel}`;
    return 'Открыл страницу';
  }

  if (row.actionType === 'create') {
    if (fromText && !genericByType.create.has(normalizedFromText)) return fromText;
    return formatBySection(createBySection[sectionLower] || 'Создал');
  }

  if (row.actionType === 'update') {
    if (fromText && !genericByType.update.has(normalizedFromText)) return fromText;
    return formatBySection(updateBySection[sectionLower] || 'Редактировал');
  }

  if (row.actionType === 'delete') {
    if (fromText && !genericByType.delete.has(normalizedFromText)) return fromText;
    return formatBySection(deleteBySection[sectionLower] || 'Удалил');
  }

  if (targetLabel) return `${openCard} ${targetLabel}${section ? ` в ${sectionLabel}` : ''}`;
  if (sectionLabel) return `Заходил в секцию ${sectionLabel}`;
  if (fromText) return `Выполнил действие: ${fromText}`;
  if (action) return `Выполнил действие: ${action}`;
  return 'Выполнил действие';
}

export function AuditPage() {
  const [fromDate, setFromDate] = useState<string>(todayIsoDate());
  const [toDate, setToDate] = useState<string>(todayIsoDate());
  const [reportDate, setReportDate] = useState<string>(todayIsoDate());
  const [actor, setActor] = useState<string | null>(null);
  const [actionType, setActionType] = useState<string | null>(null);
  const [section, setSection] = useState<string | null>(null);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [dailyRows, setDailyRows] = useState<DailyRow[]>([]);
  const [userDirectory, setUserDirectory] = useState<AdminUserDirectoryItem[]>([]);
  const [status, setStatus] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);

  const actorOptions = useMemo(() => {
    const uniq = Array.from(new Set(rows.map((r) => String(r.actor ?? '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ru'));
    return uniq.map((id) => ({ id, label: id }));
  }, [rows]);
  const sectionOptions = useMemo(() => {
    const uniq = Array.from(new Set(rows.map((r) => String(r.section ?? '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ru'));
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
  const actorFullNameByLogin = useMemo(() => {
    const map = new Map<string, string>();
    for (const user of userDirectory) {
      const login = String(user.login ?? '').trim().toLowerCase();
      if (!login) continue;
      const fullName = String(user.fullName ?? '').trim();
      map.set(login, fullName || user.login || login);
    }
    return map;
  }, [userDirectory]);
  const filteredRows = useMemo(() => {
    if (!section) return rows;
    return rows.filter((r) => String(r.section ?? '') === section);
  }, [rows, section]);

  const getActorInitials = (actor: string) => {
    const key = String(actor ?? '').trim().toLowerCase();
    const fullName = actorFullNameByLogin.get(key);
    return toInitials(fullName || String(actor ?? ''), String(actor ?? '-'));
  };

  async function loadAll() {
    setLoading(true);
    setStatus('');
    try {
      const fromMs = fromDate ? dateStartMs(fromDate) : null;
      const toMs = toDate ? dateEndMs(toDate) : null;
      const [listRes, summaryRes, usersRes] = await Promise.all([
        listAudit({
          limit: 4000,
          ...(fromMs != null ? { fromMs } : {}),
          ...(toMs != null ? { toMs } : {}),
          ...(actor ? { actor } : {}),
          ...(actionType ? { actionType: actionType as ActionType } : {}),
        }),
        dailyAuditSummary({ date: reportDate, cutoffHour: 21 }),
        listUsers(),
      ]);
      if (!listRes?.ok) throw new Error(String((listRes as any)?.error ?? 'list error'));
      if (!summaryRes?.ok) throw new Error(String((summaryRes as any)?.error ?? 'daily summary error'));
      if (usersRes?.ok) {
        setUserDirectory(
          Array.isArray(usersRes.users)
            ? usersRes.users.map((u: { login?: string; username?: string; fullName?: string | null }) => ({
                login: String(u.login ?? u.username ?? '').trim().toLowerCase(),
                fullName: String(u.fullName ?? '').trim(),
              }))
            : [],
        );
      } else {
        setUserDirectory([]);
      }
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
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>с даты</div>
        </div>
        <div style={{ width: 160 }}>
          <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>по дату</div>
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
        <div style={{ marginTop: 8, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>
          {status}
        </div>
      )}

      <div style={{ marginTop: 10, border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ padding: 10, fontWeight: 700, background: '#f8fafc' }}>Сводный отчет по клиентам (21:00)</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#0f172a', color: '#fff' }}>
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
                <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6' }}>{r.login}</td>
                <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6' }}>{r.fullName || '-'}</td>
                <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6' }}>{formatOnlineHours(r.onlineMs)}</td>
                <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6' }}>{r.created}</td>
                <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6' }}>{r.updated}</td>
                <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6' }}>{r.deleted}</td>
                <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6' }}>{r.totalChanged}</td>
              </tr>
            ))}
            {dailyRows.length === 0 && (
              <tr>
                <td style={{ padding: 10, color: '#6b7280' }} colSpan={7}>
                  Нет данных за выбранный день.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 12, border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ padding: 10, fontWeight: 700, background: '#f8fafc' }}>Журнал действий пользователей</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#334155', color: '#fff' }}>
              <th style={{ textAlign: 'left', padding: 8 }}>Время</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Аккаунт</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Имя сотрудника</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Действие</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Раздел/документ</th>
              <th style={{ textAlign: 'left', padding: 8 }}>Клиент</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r) => (
              <tr key={r.id}>
                <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6' }}>{formatAuditDate(r.createdAt)}</td>
                <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6' }}>{r.actor}</td>
                <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6' }}>{getActorInitials(r.actor)}</td>
                <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6' }}>{describeAction(r)}</td>
                <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6' }}>
                  {r.section}
                  {r.documentLabel ? ` / ${r.documentLabel}` : ''}
                </td>
                <td style={{ padding: 8, borderBottom: '1px solid #f3f4f6' }}>{formatClientId(r.clientId)}</td>
              </tr>
            ))}
            {filteredRows.length === 0 && (
              <tr>
                <td style={{ padding: 10, color: '#6b7280' }} colSpan={6}>
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
