import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  CHILD_FACETS,
  applyChildFacets,
  childActivityLabelRu,
  childActivityState,
  childAgeYears,
  childBirthdayWithinDays,
  childDaysToBirthday,
  childFacetIsActive,
  childGenderLabelRu,
  childGiftCategoryByAge,
  childNextBirthday,
  childTagsLabelRu,
  parseChildTags,
  sanitizeChildFacetSelection,
  type ChildDto,
  type ChildFacetRow,
  type ChildFacetSelection,
  type FacetDescriptor,
  type FacetSelection,
  type GiftRecordDto,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { FacetFilter } from '../components/FacetFilter.js';
import { FacetPanelToggle } from '../components/FacetPanelToggle.js';
import { ListCount } from '../components/ListCount.js';
import { RowNumberCell, RowNumberHeaderCell } from '../components/RowNumberCell.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { useListUiState } from '../hooks/useListBehavior.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { ChildCardDialog } from '../components/ChildCardDialog.js';

/** Сколько дней вперёд смотрим дни рождения — «кому и что дарить». */
const BIRTHDAY_AHEAD_DAYS = 14;

type EmployeeRow = {
  id: string;
  displayName?: string | null;
  departmentName?: string | null;
  employmentStatus?: string | null;
  terminationDate?: number | null;
};

type Row = ChildFacetRow & {
  id: string;
  fullName: string;
  birthDate: number | null;
  gender: string;
  tags: string[];
  note: string;
  employeeId: string | null;
  ageYears: number | null;
};

type ChildrenListUiState = {
  query: string;
  facetFields?: string[];
  facets?: ChildFacetSelection;
};

function toDateInput(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDate(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/**
 * Детский модуль — список детей сотрудников.
 *
 * Список собирается из трёх источников: карточки детей (реплика), сотрудники
 * (родитель и его статус занятости) и журнал выдачи (сколько подарков в этом году).
 * «Серенькие» — дети уволенных, ушедших в декрет или на лечение — в списке видны
 * отдельной меткой и уходят из отборов и напоминалок (правило одно, в домене).
 */
export function ChildrenPage(props: { canEdit: boolean; refreshKey?: number }) {
  const { confirm } = useConfirm();
  const { state: listState, patchState } = useListUiState<ChildrenListUiState>('list:children', {
    query: '',
  });
  const [children, setChildren] = useState<ChildDto[]>([]);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [gifts, setGifts] = useState<GiftRecordDto[]>([]);
  const [status, setStatus] = useState('');
  const [dialogChild, setDialogChild] = useState<ChildDto | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const now = Date.now();

  const facets = useMemo<ChildFacetSelection>(
    () => sanitizeChildFacetSelection(listState.facets),
    [listState.facets],
  );
  const facetFields = useMemo<string[]>(() => {
    const raw = Array.isArray(listState.facetFields) ? listState.facetFields : [];
    const known = raw.filter((id: string) => CHILD_FACETS.some((f) => f.id === id));
    const active = CHILD_FACETS.filter((f) => childFacetIsActive(facets, f.id)).map((f) => f.id);
    return Array.from(new Set([...known, ...active]));
  }, [listState.facetFields, facets]);

  const refresh = useCallback(async () => {
    try {
      const [childRes, employeeRes, orgRes] = await Promise.all([
        window.matrica.children.list(),
        window.matrica.employees.list(),
        window.matrica.organization.list(),
      ]);
      if (childRes.ok) setChildren(childRes.rows);
      const employeeRows = Array.isArray(employeeRes) ? (employeeRes as EmployeeRow[]) : [];
      setEmployees(employeeRows);
      if (orgRes.ok) setGifts(orgRes.gifts);
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, props.refreshKey]);

  // Данные приезжают синком: без живого перечитывания список показывал бы пустоту,
  // пока строка не доехала (реплика — pull-only, запись идёт серверной дверью).
  useLiveDataRefresh(refresh, { domains: ['children', 'organization'] });

  const employeeById = useMemo(() => {
    const map = new Map<string, EmployeeRow>();
    for (const e of employees) map.set(String(e.id), e);
    return map;
  }, [employees]);

  const giftsThisYear = useMemo(() => {
    const year = new Date(now).getFullYear();
    const map = new Map<string, number>();
    for (const g of gifts) {
      const childId = g.recipientChildId;
      if (!childId) continue;
      const at = Number(g.givenAt ?? 0);
      if (!Number.isFinite(at) || at <= 0) continue;
      if (new Date(at).getFullYear() !== year) continue;
      map.set(childId, (map.get(childId) ?? 0) + 1);
    }
    return map;
  }, [gifts, now]);

  const rows = useMemo<Row[]>(
    () =>
      children.map((c) => {
        const parent = c.employeeId ? employeeById.get(String(c.employeeId)) : undefined;
        const state = childActivityState({
          employmentStatus: parent?.employmentStatus ?? null,
          terminationDate: parent?.terminationDate ?? null,
        });
        const ageYears = childAgeYears(c.birthDate, now);
        return {
          id: c.id,
          parentId: c.employeeId,
          parentFullName: parent?.displayName ?? null,
          parentDepartmentName: parent?.departmentName ?? null,
          parentStatus: parent?.employmentStatus ?? null,
          parentTerminationDate: parent?.terminationDate ?? null,
          ageYears,
          birthDate: c.birthDate,
          gender: c.gender,
          tags: parseChildTags(c.tagsJson),
          giftsThisYear: giftsThisYear.get(c.id) ?? 0,
          activityState: state,
          fullName: c.fullName,
          note: c.note,
          employeeId: c.employeeId,
        };
      }),
    [children, employeeById, giftsThisYear, now],
  );

  const query = String(listState.query ?? '').trim().toLowerCase();
  const searched = useMemo<Row[]>(
    () =>
      query.length === 0
        ? rows
        : rows.filter((r) =>
            [r.fullName, r.parentFullName ?? '', r.parentDepartmentName ?? '', childTagsLabelRu(r.tags)]
              .join(' ')
              .toLowerCase()
              .includes(query),
          ),
    [rows, query],
  );
  const shown = useMemo(() => applyChildFacets(searched, facets), [searched, facets]);

  const birthdaysSoon = useMemo(
    () =>
      shown.filter(
        (r) => r.activityState === 'active' && childBirthdayWithinDays(r.birthDate, now, BIRTHDAY_AHEAD_DAYS),
      ),
    [shown, now],
  );

  /**
   * Напомнить о дне рождения: заметка со сроком и точками напоминания.
   *
   * Напоминание живёт в общем механизме заметок (никакого своего таймера): срок —
   * день рождения, точки — за три дня и в сам день. «Сереньким» детям напоминание
   * не заводится: они не участвуют в отборах (правило одно — из статуса родителя).
   */
  async function remind(row: Row) {
    const child = children.find((c) => c.id === row.id);
    if (!child) return;
    const birthday = childNextBirthday(row.birthDate, now);
    if (birthday == null) {
      setStatus('У ребёнка не задана дата рождения — напоминание не создать');
      return;
    }
    const age = row.ageYears;
    const suggestion = childGiftCategoryByAge(age);
    const body = [
      { id: `b1-${child.id}`, kind: 'text' as const, text: `Родитель: ${row.parentFullName ?? 'не указан'}` },
      { id: `b2-${child.id}`, kind: 'text' as const, text: suggestion ? `Подсказка подарка: ${suggestion}` : '' },
    ].filter((b) => b.text.length > 0);
    const res = await window.matrica.notes.upsert({
      title: `День рождения: ${child.fullName}`,
      body,
      importance: 'important',
      dueAt: birthday,
      reminders: [birthday - 3 * 86_400_000, birthday],
    });
    if (!res.ok) {
      setStatus(`Ошибка: ${res.error}`);
      return;
    }
    setStatus(`Напоминание заведено: ${child.fullName}`);
  }

  async function remove(child: ChildDto) {
    const ok = await confirm({ detail: `Удалить карточку ребёнка «${child.fullName}»? Действие необратимо.` });
    if (!ok) return;
    const res = await window.matrica.children.remove(child.id);
    if (!res.ok) {
      setStatus(`Ошибка: ${res.error}`);
      return;
    }
    await refresh();
  }

  return (
    <div style={{ padding: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Дети сотрудников</h2>
        {/* Панель фильтров открывается и сворачивается этой кнопкой (владелец 25.11.2026,
            промт КАРМАНА #151). У этого экрана нет верхней панели управляющих кнопок, поэтому
            кнопка — здесь: свёрнутая панель исчезает с экрана целиком. */}
        <FacetPanelToggle usageKey="list:children" />
        {props.canEdit && (
          <Button
            variant="primary"
            onClick={() => {
              setDialogChild(null);
              setDialogOpen(true);
            }}
          >
            Добавить ребёнка
          </Button>
        )}
        {status && <span style={{ color: status.startsWith('Ошибка') ? '#b91c1c' : '#64748b', fontSize: 13 }}>{status}</span>}
      </div>

      <div style={{ marginBottom: 8, fontSize: 13, color: '#475569' }}>
        Дней рождения в ближайшие {BIRTHDAY_AHEAD_DAYS} дней: <b>{birthdaysSoon.length}</b>
        {birthdaysSoon.length > 0 && (
          <span>
            {' '}
            — {birthdaysSoon
              .slice(0, 5)
              .map((r) => `${r.fullName} (${childDaysToBirthday(r.birthDate, now)} дн.)`)
              .join(', ')}
            {birthdaysSoon.length > 5 ? '…' : ''}
          </span>
        )}
      </div>

      {birthdaysSoon.length > 0 && (
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 12, marginBottom: 12, background: '#f8fafc' }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Кого поздравить</div>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>
            Напоминание заводится заметкой: срок — день рождения, сигнал — за три дня и в сам день.
            «Серенькие» дети в список не попадают.
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {birthdaysSoon.map((r) => (
              <div
                key={r.id}
                style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid var(--border)', borderRadius: 8, padding: '4px 8px', background: '#fff' }}
              >
                <span style={{ fontSize: 13 }}>
                  {r.fullName} — {childDaysToBirthday(r.birthDate, now)} дн.
                </span>
                <Button variant="ghost" onClick={() => void remind(r)}>
                  Напомнить
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      <FacetFilter<Row>
        facets={CHILD_FACETS as readonly FacetDescriptor<Row>[]}
        rows={searched}
        selection={facets as FacetSelection}
        fields={facetFields}
        usageKey="list:children"
        onChangeSelection={(next) => patchState({ facets: next as ChildFacetSelection })}
        onChangeFields={(next) => patchState({ facetFields: next })}
        onReset={() => patchState({ facets: {}, facetFields: [] })}
      />

      <ListCount total={rows.length} shown={shown.length} />

      <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'clip' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'linear-gradient(135deg, #0f766e 0%, #14b8a6 120%)', color: '#fff' }}>
              <RowNumberHeaderCell style={{ ...thStyle, ...ROWNUM_STYLE, color: 'inherit' }} />
              <th style={thStyle}>ФИО ребёнка</th>
              <th style={thStyle}>Родитель</th>
              <th style={thStyle}>Возраст</th>
              <th style={thStyle}>Дата рождения</th>
              <th style={thStyle}>Пол</th>
              <th style={thStyle}>Признаки</th>
              <th style={thStyle}>Состояние</th>
              <th style={thStyle}>Подарки в этом году</th>
              <th style={{ ...thStyle, width: 190 }}>Действия</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => {
              const child = children.find((c) => c.id === r.id);
              const giftCount = r.giftsThisYear;
              return (
                <tr
                  key={r.id}
                  style={{ cursor: 'pointer', background: r.activityState === 'silver' ? '#f8fafc' : undefined }}
                  onClick={() => {
                    if (!child) return;
                    setDialogChild(child);
                    setDialogOpen(true);
                  }}
                >
                  <RowNumberCell n={i + 1} style={{ ...tdStyle, ...ROWNUM_STYLE }} />
                  <td style={tdStyle}>{r.fullName}</td>
                  <td style={tdStyle}>{r.parentFullName ?? '—'}</td>
                  <td style={tdStyle}>{r.ageYears == null ? '—' : `${r.ageYears} лет`}</td>
                  <td style={tdStyle}>{formatDate(r.birthDate)}</td>
                  <td style={tdStyle}>{childGenderLabelRu(r.gender)}</td>
                  <td style={tdStyle}>{childTagsLabelRu(r.tags) || '—'}</td>
                  <td style={tdStyle}>
                    {childActivityLabelRu(r.activityState)}
                    {r.activityState === 'silver' && (
                      <div style={{ fontSize: 12, color: '#94a3b8' }}>в отборы и напоминалки не попадает</div>
                    )}
                  </td>
                  <td style={tdStyle}>
                    {giftCount > 0 ? `${giftCount} шт.` : '—'}
                    {giftCount === 0 && <div style={{ fontSize: 12, color: '#94a3b8' }}>пора дарить</div>}
                  </td>
                  <td style={tdStyle} onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          if (!child) return;
                          setDialogChild(child);
                          setDialogOpen(true);
                        }}
                      >
                        Карточка
                      </Button>
                      {props.canEdit && child && (
                        <Button variant="ghost" onClick={() => void remove(child)}>
                          Удалить
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={9} style={{ padding: 14, color: '#6b7280' }}>
                  {rows.length === 0
                    ? 'Карточек детей пока нет.'
                    : 'Ни один ребёнок не проходит выбранные условия отбора.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {dialogOpen && (
        <ChildCardDialog
          child={dialogChild}
          employees={employees}
          gifts={gifts}
          canEdit={props.canEdit}
          onClose={() => setDialogOpen(false)}
          onChanged={async () => {
            await refresh();
          }}
        />
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = { textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)' };
const tdStyle: React.CSSProperties = { padding: 10, borderBottom: '1px solid #f3f4f6', fontSize: 14 };
const ROWNUM_STYLE: React.CSSProperties = { width: '1%', whiteSpace: 'nowrap', textAlign: 'right', color: '#6b7280' };

/** Дата рождения для поля ввода `YYYY-MM-DD`. */
export function childBirthDateInputValue(ms: number | null): string {
  return toDateInput(ms);
}

/** Подсказка подарка по возрасту — стартовое правило модуля. */
export function childGiftHint(ageYears: number | null): string {
  return childGiftCategoryByAge(ageYears);
}
