import React, { useEffect, useMemo, useState } from 'react';
import type { EmployeeListItem, SectionAccessLevel, SectionMembership } from '@matricarmz/shared';
import {
  ACCESS_SECTION_CATALOG,
  accessSectionMeta,
  dependentsOfSection,
  membershipIssues,
  missingSectionDependencies,
  operatorRolePermissions,
  parseSectionMembership,
  sectionEditorRoleWarning,
} from '@matricarmz/shared';
import type { AccessSection } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { useConfirm } from '../components/ConfirmContext.js';

type Row = {
  id: string;
  login: string;
  name: string;
  role: string;
  membership: SectionMembership;
};

/**
 * «Доступы по разделам» (план docs/plans/section-access-2026-07.md, Ф1): строка =
 * раздел программы, две колонки людей — наблюдатели (видят, не меняют) и редакторы
 * (полный CRUD). Не в списке = раздела для человека не существует. Правка пишет
 * EAV-атрибут `section_access` сотрудника — карточка пользователя показывает то же
 * зеркально (источник один). Энфорс меню — по membership (Ф1), сервер — Ф2/Ф3.
 */
export function AccessSectionsPage(props: { onOpenEmployee?: (id: string) => void }) {
  const { confirm } = useConfirm();
  const [rows, setRows] = useState<Row[]>([]);
  const [godLogins, setGodLogins] = useState<string[]>([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pickerFor, setPickerFor] = useState<{ sectionId: string; level: SectionAccessLevel } | null>(null);
  const [view, setView] = useState<'sections' | 'matrix'>('sections');

  async function reload() {
    setLoading(true);
    try {
      const list = (await window.matrica.employees.list()) as EmployeeListItem[];
      const withLogin = (Array.isArray(list) ? list : []).filter((e) => String(e.login ?? '').trim());
      withLogin.sort((a, b) => String(a.login).localeCompare(String(b.login), 'ru'));
      const all = withLogin.map((e) => ({
        id: String(e.id),
        login: String(e.login),
        name: String(e.fullName ?? e.displayName ?? '').trim(),
        role: String(e.systemRole ?? '').trim().toLowerCase(),
        membership: parseSectionMembership(e.sectionAccess),
      }));
      // Суперадмин в таблице не участвует: роль и так обходит разделы везде, поэтому строка
      // ему ничего не даёт — а «редактор» в «Нарядах закрытых» молча делал ЕГО наряды
      // невидимыми для всех остальных (инцидент 2026-07-28, 54 наряда). Права бога — по роли.
      setRows(all.filter((r) => r.role !== 'superadmin'));
      setGodLogins(all.filter((r) => r.role === 'superadmin').map((r) => (r.name ? `${r.login} — ${r.name}` : r.login)));
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка загрузки: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  const byLogin = useMemo(() => new Map(rows.map((r) => [r.login, r])), [rows]);

  async function setLevel(row: Row, sectionId: string, level: SectionAccessLevel | null) {
    // Разделы с нестандартной семантикой уровней (напр. «Наряды закрытые»: editor =
    // ограниченный владелец, видит ТОЛЬКО свои) — явное подтверждение до записи
    // (инцидент 2026-07-10: editor выдан как «расширение доступа»).
    const hint = level ? accessSectionMeta(sectionId)?.levelHintsRu?.[level] : undefined;
    if (hint && hint.includes('⚠️')) {
      const ok = await confirm({
        title: `Выдать «${accessSectionMeta(sectionId)?.titleRu ?? sectionId}» (${level === 'editor' ? 'редактор' : 'наблюдатель'}) — ${row.login}?`,
        detail: hint,
        confirmLabel: 'Выдать',
        confirmTone: 'warn',
      });
      if (!ok) return;
    }
    // При СНЯТИИ раздела — предупредить, каким выданным разделам он нужен (обратная ниточка).
    if (!level) {
      const dependents = dependentsOfSection(row.membership, sectionId as AccessSection);
      if (dependents.length > 0) {
        const list = dependents
          .map((d) => `• «${accessSectionMeta(d.section)?.titleRu ?? d.section}» — ${d.reasonRu}`)
          .join('\n');
        const ok = await confirm({
          title: `Снять «${accessSectionMeta(sectionId)?.titleRu ?? sectionId}» у ${row.login}?`,
          detail:
            `Этот раздел нужен другим выданным разделам пользователя:\n\n${list}\n\n` +
            'После снятия перечисленные разделы останутся, но поиск/подстановка этих данных в них перестанут работать. Снять всё равно?',
          confirmLabel: 'Снять всё равно',
          confirmTone: 'warn',
        });
        if (!ok) return;
      }
    }

    // При выдаче editor — сверка с ролью: сервер проверяет и раздел, и права роли.
    if (level === 'editor') {
      const roleWarn = sectionEditorRoleWarning({
        role: row.role,
        sectionId: sectionId as AccessSection,
        rolePermissions: operatorRolePermissions(row.role),
      });
      if (roleWarn) {
        const ok = await confirm({
          title: `Редактор «${accessSectionMeta(sectionId)?.titleRu ?? sectionId}» для ${row.login}?`,
          detail: roleWarn,
          confirmLabel: 'Выдать всё равно',
          confirmTone: 'warn',
        });
        if (!ok) return;
      }
    }

    // Правки уходят по одной (дельта-дверь), поэтому копим их списком. Набор
    // `membership` остаётся только для подсказок и как запасной показ.
    const edits: Array<{ sectionId: string; level: SectionAccessLevel | null }> = [{ sectionId, level: level ?? null }];
    const membership: SectionMembership = { ...row.membership };
    if (level) (membership as Record<string, SectionAccessLevel>)[sectionId] = level;
    else delete (membership as Record<string, SectionAccessLevel>)[sectionId];

    // Тема H: при ВЫДАЧЕ раздела подсказать недостающие связанные разделы (напр. Производство
    // без Договоров → в карточке двигателя не ищется контракт). Решение за оператором.
    if (level) {
      const missing = missingSectionDependencies(membership, sectionId as AccessSection);
      if (missing.length > 0) {
        const list = missing
          .map((d) => `• «${accessSectionMeta(d.section)?.titleRu ?? d.section}» (${d.level === 'editor' ? 'редактор' : 'наблюдатель'}) — ${d.reasonRu}`)
          .join('\n');
        const add = await confirm({
          title: `Добавить связанные доступы для ${row.login}?`,
          detail:
            `Для полноценной работы с разделом «${accessSectionMeta(sectionId)?.titleRu ?? sectionId}» обычно нужны ещё:\n\n${list}\n\n` +
            'Добавить их сейчас? (Если этому пользователю такие данные заполнять не нужно — можно отказаться.)',
          confirmLabel: 'Добавить связанные',
          cancelLabel: 'Только этот раздел',
          confirmTone: 'info',
        });
        if (add) {
          for (const d of missing) {
            (membership as Record<string, SectionAccessLevel>)[d.section] = d.level;
            edits.push({ sectionId: d.section, level: d.level });
          }
        }
      }
    }

    setSaving(true);
    try {
      // B3/R4a: шлём ПРАВКУ, а не весь набор. Базу считает сервер по строгой
      // таблице — иначе эта страница, читающая локальный EAV, после cutover
      // молча возвращала бы матрицу к состоянию на день заморозки и отбирала
      // всё, что выдали с другой машины. Ответ по-прежнему нормализованный
      // набор, его и показываем, чтобы экран не разошёлся с сохранённым.
      // Правки применяются по одной, поэтому отказ на середине оставляет часть
      // уже сохранённой. Держим набор ПОСЛЕДНЕЙ удачной правки: перечитать
      // локальную базу тут нельзя — серверная запись приедет на машину только
      // следующим синком (до пяти минут), и reload() показал бы состояние ДО
      // всей пачки, то есть спрятал бы сохранённое. Вдобавок reload() гасит
      // строку состояния, и сообщение об отказе исчезло бы не прочитанным.
      let lastOk: SectionMembership | null = null;
      for (const edit of edits) {
        const res = await window.matrica.admin.users.sectionAccessSetOne(row.id, edit.sectionId, edit.level);
        if (res && (res as { ok?: boolean }).ok === false) {
          setStatus(`Не сохранилось (${row.login}): ${(res as { error?: string }).error ?? 'ошибка'}`);
          if (lastOk) setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, membership: lastOk as SectionMembership } : r)));
          return;
        }
        lastOk = ((res as { membership?: SectionMembership } | null)?.membership ?? lastOk) as SectionMembership | null;
      }
      const saved = (lastOk ?? membership) as SectionMembership;
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, membership: saved } : r)));
      setStatus('');
    } finally {
      setSaving(false);
    }
  }

  function chip(row: Row, sectionId: string, level: SectionAccessLevel) {
    const title = row.name ? `${row.login} — ${row.name}` : row.login;
    return (
      <span
        key={row.id}
        title={title}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 8px',
          borderRadius: 12,
          background: level === 'editor' ? 'var(--accent-soft, rgba(37,99,235,.12))' : 'var(--surface-2, rgba(120,120,120,.12))',
          border: '1px solid var(--border)',
          fontSize: 12,
          cursor: props.onOpenEmployee ? 'pointer' : 'default',
        }}
        onClick={() => props.onOpenEmployee?.(row.id)}
      >
        {row.login}
        <button
          title="Убрать из раздела"
          disabled={saving}
          onClick={(e) => {
            e.stopPropagation();
            void setLevel(row, sectionId, null);
          }}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--muted)', padding: 0, lineHeight: 1 }}
        >
          ✕
        </button>
      </span>
    );
  }

  function picker(sectionId: string, level: SectionAccessLevel, present: Set<string>) {
    const candidates = rows.filter((r) => !present.has(r.login));
    return (
      <select
        autoFocus
        disabled={saving}
        defaultValue=""
        onBlur={() => setPickerFor(null)}
        onChange={(e) => {
          const login = e.target.value;
          setPickerFor(null);
          const row = byLogin.get(login);
          if (row) void setLevel(row, sectionId, level);
        }}
        style={{ fontSize: 12, maxWidth: 220 }}
      >
        <option value="" disabled>
          — выбрать пользователя —
        </option>
        {candidates.map((r) => (
          <option key={r.id} value={r.login}>
            {r.login}
            {r.name ? ` — ${r.name}` : ''}
          </option>
        ))}
      </select>
    );
  }

  function cell(sectionId: string, level: SectionAccessLevel) {
    const members = rows.filter((r) => r.membership[sectionId as keyof SectionMembership] === level);
    const present = new Set(
      rows.filter((r) => r.membership[sectionId as keyof SectionMembership] != null).map((r) => r.login),
    );
    const pickerOpen = pickerFor?.sectionId === sectionId && pickerFor.level === level;
    return (
      <td style={{ padding: '8px 10px', verticalAlign: 'top', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {members.map((r) => chip(r, sectionId, level))}
          {pickerOpen ? (
            picker(sectionId, level, present)
          ) : (
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setPickerFor({ sectionId, level })}>
              + добавить
            </Button>
          )}
        </div>
      </td>
    );
  }

  // «Матрица»: строка = пользователь, столбец = раздел, ячейка = светофор
  // (🔴 нет доступа / 🟢 наблюдатель / 🔵 редактор). Клик — переключение уровня,
  // пишет через тот же setLevel (с теми же подтверждениями и связанными разделами).
  const LIGHTS: Array<{ level: SectionAccessLevel | null; color: string; label: string }> = [
    { level: null, color: '#dc2626', label: 'Запрещён (раздел не виден)' },
    { level: 'viewer', color: '#16a34a', label: 'Наблюдатель (видит, не меняет)' },
    { level: 'editor', color: '#2563eb', label: 'Редактор (полный доступ)' },
  ];

  function matrixCell(row: Row, sectionId: string) {
    const current = (row.membership[sectionId as keyof SectionMembership] ?? null) as SectionAccessLevel | null;
    return (
      <td
        key={sectionId}
        style={{ padding: '4px 4px', borderBottom: '1px solid var(--border)', borderLeft: '1px solid var(--border)', textAlign: 'center' }}
      >
        <div style={{ display: 'inline-flex', gap: 3 }}>
          {LIGHTS.map((l) => {
            const active = current === l.level;
            return (
              <button
                key={String(l.level)}
                title={`${accessSectionMeta(sectionId)?.titleRu ?? sectionId} — ${row.login}: ${l.label}`}
                disabled={saving || active}
                onClick={() => void setLevel(row, sectionId, l.level)}
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: '50%',
                  padding: 0,
                  cursor: active ? 'default' : 'pointer',
                  border: active ? `2px solid ${l.color}` : '1px solid var(--border)',
                  background: active ? l.color : 'transparent',
                  opacity: active ? 1 : 0.45,
                }}
              />
            );
          })}
        </div>
      </td>
    );
  }

  const matrixView = (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '2px solid var(--border)', position: 'sticky', left: 0, background: 'var(--bg, inherit)', zIndex: 1 }}>
              Пользователь
            </th>
            {ACCESS_SECTION_CATALOG.map((section) => (
              <th
                key={section.id}
                title={section.titleRu}
                style={{ padding: '6px 4px', borderBottom: '2px solid var(--border)', borderLeft: '1px solid var(--border)', verticalAlign: 'bottom' }}
              >
                <div
                  style={{
                    writingMode: 'vertical-rl',
                    transform: 'rotate(180deg)',
                    maxHeight: 150,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: 12,
                    fontWeight: 600,
                    margin: '0 auto',
                  }}
                >
                  {section.titleRu}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td
                title={row.name || row.login}
                onClick={() => props.onOpenEmployee?.(row.id)}
                style={{
                  padding: '4px 10px',
                  borderBottom: '1px solid var(--border)',
                  whiteSpace: 'nowrap',
                  cursor: props.onOpenEmployee ? 'pointer' : 'default',
                  position: 'sticky',
                  left: 0,
                  background: 'var(--bg, inherit)',
                  zIndex: 1,
                }}
              >
                <b>{row.login}</b>
                {row.name ? <span style={{ color: 'var(--muted)', fontSize: 12 }}> {row.name}</span> : null}
                {(() => {
                  const issues = membershipIssues(row.membership);
                  if (issues.length === 0) return null;
                  const text = issues
                    .map(
                      (i) =>
                        `«${accessSectionMeta(i.section)?.titleRu ?? i.section}» не хватает «${accessSectionMeta(i.missing.section)?.titleRu ?? i.missing.section}»: ${i.missing.reasonRu}`,
                    )
                    .join('\n');
                  return (
                    <span title={`Несвязный набор доступов:\n${text}`} style={{ marginLeft: 4, cursor: 'help' }}>
                      ⚠️
                    </span>
                  );
                })()}
              </td>
              {ACCESS_SECTION_CATALOG.map((section) => matrixCell(row, section.id))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Доступы по разделам</h2>
        <div style={{ display: 'inline-flex', gap: 4 }}>
          <Button size="sm" variant={view === 'sections' ? 'primary' : 'ghost'} onClick={() => setView('sections')}>
            По разделам
          </Button>
          <Button size="sm" variant={view === 'matrix' ? 'primary' : 'ghost'} onClick={() => setView('matrix')}>
            Матрица
          </Button>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void reload()} disabled={loading}>
          {loading ? 'Обновляю…' : 'Обновить'}
        </Button>
        {status ? <span style={{ color: 'var(--danger, #dc2626)' }}>{status}</span> : null}
      </div>
      <div style={{ color: 'var(--muted)', fontSize: 13, maxWidth: 900 }}>
        {view === 'matrix' ? (
          <>
            Светофор: <span style={{ color: '#dc2626' }}>●</span> запрещён (раздела не видит),{' '}
            <span style={{ color: '#16a34a' }}>●</span> наблюдатель (видит, не меняет),{' '}
            <span style={{ color: '#2563eb' }}>●</span> редактор (полный доступ). Клик по кружку меняет уровень.
            Суперадминистратор всегда имеет полный доступ независимо от матрицы.
          </>
        ) : (
          <>
            <b>Наблюдатель</b> — видит всё в разделе, ничего не меняет. <b>Редактор</b> — видит и меняет. Кто не добавлен —
            раздела не видит вовсе. То же самое видно и правится в карточке пользователя (Персонал → Сотрудники).
          </>
        )}
      </div>
      {godLogins.length > 0 ? (
        <div style={{ color: 'var(--muted)', fontSize: 13, maxWidth: 900 }}>
          👑 <b>Полный доступ по роли</b> (в таблице не участвует и настройки не требует):{' '}
          {godLogins.join(', ')}.
        </div>
      ) : null}
      {view === 'matrix' ? matrixView : (
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 760 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '2px solid var(--border)', width: 260 }}>Раздел</th>
              <th style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '2px solid var(--border)' }}>👁 Наблюдатели</th>
              <th style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '2px solid var(--border)' }}>✏️ Редакторы</th>
            </tr>
          </thead>
          <tbody>
            {ACCESS_SECTION_CATALOG.map((section) => (
              <tr key={section.id}>
                <td style={{ padding: '8px 10px', verticalAlign: 'top', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ fontWeight: 600 }}>{section.titleRu}</div>
                  {section.restrictedAssign ? (
                    <div style={{ color: 'var(--muted)', fontSize: 12 }}>ограниченный раздел</div>
                  ) : null}
                  {section.levelHintsRu ? (
                    <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4, maxWidth: 240 }}>
                      <div>👁 {section.levelHintsRu.viewer}</div>
                      <div style={{ marginTop: 2 }}>✏️ {section.levelHintsRu.editor}</div>
                    </div>
                  ) : null}
                </td>
                {cell(section.id, 'viewer')}
                {cell(section.id, 'editor')}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}
