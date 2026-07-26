import React, { useEffect, useMemo, useState } from 'react';
import type { EmployeeListItem, SectionAccessLevel, SectionMembership } from '@matricarmz/shared';
import { ACCESS_SECTION_CATALOG, SECTION_ACCESS_ATTR, accessSectionMeta, missingSectionDependencies, parseSectionMembership, serializeSectionMembership } from '@matricarmz/shared';
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
      setRows(
        withLogin.map((e) => ({
          id: String(e.id),
          login: String(e.login),
          name: String(e.fullName ?? e.displayName ?? '').trim(),
          role: String(e.systemRole ?? '').trim().toLowerCase(),
          membership: parseSectionMembership(e.sectionAccess),
        })),
      );
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
    // (инцидент fatyhova 2026-07-10: editor выдан как «расширение доступа»).
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
          for (const d of missing) (membership as Record<string, SectionAccessLevel>)[d.section] = d.level;
        }
      }
    }

    setSaving(true);
    try {
      const res = await window.matrica.employees.setAttr(row.id, SECTION_ACCESS_ATTR, serializeSectionMembership(membership));
      if (res && (res as { ok?: boolean }).ok === false) {
        setStatus(`Не сохранилось (${row.login}): ${(res as { error?: string }).error ?? 'ошибка'}`);
        return;
      }
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, membership } : r)));
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
            раздела не видит вовсе. Суперадминистратор всегда имеет полный доступ и в списках не нуждается. То же самое
            видно и правится в карточке пользователя (Персонал → Сотрудники).
          </>
        )}
      </div>
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
