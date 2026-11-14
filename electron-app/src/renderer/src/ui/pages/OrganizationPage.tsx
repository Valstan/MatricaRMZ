import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  CHILD_FACETS,
  applyChildFacets,
  childActivityState,
  childAgeYears,
  childAgeBandOf,
  giftKindLabelRu,
  giftRecipientKindLabelRu,
  orgEventKindLabelRu,
  parseEventSelections,
  type ChildDto,
  type ChildFacetRow,
  type ChildFacetSelection,
  type EventSelection,
  type FacetDescriptor,
  type FacetSelection,
  type GiftRecordDto,
  type OrgEventDto,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { FacetFilter } from '../components/FacetFilter.js';
import { Input } from '../components/Input.js';
import { ListCount } from '../components/ListCount.js';
import { RowNumberCell, RowNumberHeaderCell } from '../components/RowNumberCell.js';
import { useConfirm } from '../components/ConfirmContext.js';

type EmployeeRow = {
  id: string;
  displayName?: string | null;
  employmentStatus?: string | null;
  terminationDate?: number | null;
};

type EventKind = 'holiday' | 'competition' | 'birthday' | 'other';
type GiftKind = 'gift' | 'prize' | 'certificate' | 'money';

const EVENT_KINDS: Array<{ id: EventKind; label: string }> = [
  { id: 'holiday', label: 'праздник' },
  { id: 'competition', label: 'соревнование' },
  { id: 'birthday', label: 'день рождения' },
  { id: 'other', label: 'прочее' },
];

const GIFT_KINDS: Array<{ id: GiftKind; label: string }> = [
  { id: 'gift', label: 'подарок' },
  { id: 'prize', label: 'приз' },
  { id: 'certificate', label: 'грамота' },
  { id: 'money', label: 'деньги' },
];

function toDateInput(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fromDateInput(value: string): number | null {
  const clean = value.trim();
  if (!clean) return null;
  const ms = Date.parse(`${clean}T00:00:00`);
  return Number.isFinite(ms) ? ms : null;
}

function formatDate(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/**
 * Организационный модуль: мероприятия и журнал выдачи подарков, призов и грамот.
 *
 * Отбор под мероприятие — фильтр по годам, полу и признакам, а решение оператора
 * (приглашён / не приглашён и почему) сохраняется в мероприятии. Результат фильтра
 * не сохраняется: он зависит от состава и каждый раз считается заново.
 */
export function OrganizationPage(props: { canEdit: boolean; refreshKey?: number }) {
  const { confirm } = useConfirm();
  const [events, setEvents] = useState<OrgEventDto[]>([]);
  const [gifts, setGifts] = useState<GiftRecordDto[]>([]);
  const [children, setChildren] = useState<ChildDto[]>([]);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [status, setStatus] = useState('');
  const [eventDraft, setEventDraft] = useState<OrgEventDto | null>(null);
  const [eventOpen, setEventOpen] = useState(false);
  const [giftDraft, setGiftDraft] = useState<GiftRecordDto | null>(null);
  const [giftOpen, setGiftOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [orgRes, childRes, employeeRes] = await Promise.all([
        window.matrica.organization.list(),
        window.matrica.children.list(),
        window.matrica.employees.list(),
      ]);
      if (orgRes.ok) {
        setEvents(orgRes.events);
        setGifts(orgRes.gifts);
      }
      if (childRes.ok) setChildren(childRes.rows);
      setEmployees(Array.isArray(employeeRes) ? (employeeRes as EmployeeRow[]) : []);
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, props.refreshKey]);

  const childById = useMemo(() => {
    const map = new Map<string, ChildDto>();
    for (const c of children) map.set(c.id, c);
    return map;
  }, [children]);
  const employeeById = useMemo(() => {
    const map = new Map<string, EmployeeRow>();
    for (const e of employees) map.set(String(e.id), e);
    return map;
  }, [employees]);
  const eventById = useMemo(() => {
    const map = new Map<string, OrgEventDto>();
    for (const e of events) map.set(e.id, e);
    return map;
  }, [events]);

  async function removeEvent(event: OrgEventDto) {
    const ok = await confirm({ detail: `Удалить мероприятие «${event.title}»? Действие необратимо.` });
    if (!ok) return;
    const res = await window.matrica.organization.removeEvent(event.id);
    if (!res.ok) {
      setStatus(`Ошибка: ${res.error}`);
      return;
    }
    await refresh();
  }

  async function removeGift(gift: GiftRecordDto) {
    const ok = await confirm({ detail: `Удалить запись о выдаче «${gift.title || giftKindLabelRu(gift.kind)}»?` });
    if (!ok) return;
    const res = await window.matrica.organization.removeGift(gift.id);
    if (!res.ok) {
      setStatus(`Ошибка: ${res.error}`);
      return;
    }
    await refresh();
  }

  return (
    <div style={{ padding: 4, display: 'grid', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Организационный модуль</h2>
        {props.canEdit && (
          <>
            <Button
              variant="primary"
              onClick={() => {
                setEventDraft(null);
                setEventOpen(true);
              }}
            >
              Новое мероприятие
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setGiftDraft(null);
                setGiftOpen(true);
              }}
            >
              Записать выдачу
            </Button>
          </>
        )}
        {status && <span style={{ color: status.startsWith('Ошибка') ? '#b91c1c' : '#64748b', fontSize: 13 }}>{status}</span>}
      </div>

      <section>
        <h3 style={{ margin: '0 0 8px' }}>Мероприятия</h3>
        <ListCount total={events.length} shown={events.length} />
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'clip' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'linear-gradient(135deg, #0f766e 0%, #14b8a6 120%)', color: '#fff' }}>
                <RowNumberHeaderCell style={{ ...thStyle, ...ROWNUM_STYLE, color: 'inherit' }} />
                <th style={thStyle}>Название</th>
                <th style={thStyle}>Вид</th>
                <th style={thStyle}>Дата</th>
                <th style={thStyle}>Отобрано</th>
                <th style={{ ...thStyle, width: 190 }}>Действия</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => {
                const selections = parseEventSelections(e.selectionsJson);
                const invited = selections.filter((s) => s.invited).length;
                return (
                  <tr key={e.id} style={{ cursor: 'pointer' }} onClick={() => { setEventDraft(e); setEventOpen(true); }}>
                    <RowNumberCell n={i + 1} style={{ ...tdStyle, ...ROWNUM_STYLE }} />
                    <td style={tdStyle}>{e.title}</td>
                    <td style={tdStyle}>{orgEventKindLabelRu(e.kind)}</td>
                    <td style={tdStyle}>{formatDate(e.eventDate)}</td>
                    <td style={tdStyle}>{invited > 0 ? `приглашено ${invited}` : '—'}</td>
                    <td style={tdStyle} onClick={(ev) => ev.stopPropagation()}>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <Button variant="ghost" onClick={() => { setEventDraft(e); setEventOpen(true); }}>
                          Открыть
                        </Button>
                        {props.canEdit && (
                          <Button variant="ghost" onClick={() => void removeEvent(e)}>
                            Удалить
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {events.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: 14, color: '#6b7280' }}>
                    Мероприятий пока нет.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h3 style={{ margin: '0 0 8px' }}>Журнал выдачи: подарки, призы, грамоты</h3>
        <ListCount total={gifts.length} shown={gifts.length} />
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'clip' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'linear-gradient(135deg, #0f766e 0%, #14b8a6 120%)', color: '#fff' }}>
                <RowNumberHeaderCell style={{ ...thStyle, ...ROWNUM_STYLE, color: 'inherit' }} />
                <th style={thStyle}>Дата</th>
                <th style={thStyle}>Кому</th>
                <th style={thStyle}>Вид</th>
                <th style={thStyle}>Что</th>
                <th style={thStyle}>Место</th>
                <th style={thStyle}>Мероприятие</th>
                <th style={{ ...thStyle, width: 150 }}>Действия</th>
              </tr>
            </thead>
            <tbody>
              {gifts.map((g, i) => {
                const child = g.recipientChildId ? childById.get(g.recipientChildId) : null;
                const employee = g.recipientEmployeeId ? employeeById.get(g.recipientEmployeeId) : null;
                const event = g.eventId ? eventById.get(g.eventId) : null;
                return (
                  <tr key={g.id} style={{ cursor: 'pointer' }} onClick={() => { setGiftDraft(g); setGiftOpen(true); }}>
                    <RowNumberCell n={i + 1} style={{ ...tdStyle, ...ROWNUM_STYLE }} />
                    <td style={tdStyle}>{formatDate(g.givenAt)}</td>
                    <td style={tdStyle}>
                      {child ? child.fullName : employee?.displayName ?? '—'}
                      <div style={{ fontSize: 12, color: '#94a3b8' }}>{giftRecipientKindLabelRu(g.recipientKind)}</div>
                    </td>
                    <td style={tdStyle}>{giftKindLabelRu(g.kind)}</td>
                    <td style={tdStyle}>{g.title || '—'}</td>
                    <td style={tdStyle}>{g.place || '—'}</td>
                    <td style={tdStyle}>{event?.title ?? '—'}</td>
                    <td style={tdStyle} onClick={(ev) => ev.stopPropagation()}>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <Button variant="ghost" onClick={() => { setGiftDraft(g); setGiftOpen(true); }}>
                          Открыть
                        </Button>
                        {props.canEdit && (
                          <Button variant="ghost" onClick={() => void removeGift(g)}>
                            Удалить
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {gifts.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: 14, color: '#6b7280' }}>
                    Выдач пока нет.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {eventOpen && (
        <EventDialog
          event={eventDraft}
          children={children}
          employees={employees}
          canEdit={props.canEdit}
          onClose={() => setEventOpen(false)}
          onChanged={async () => {
            await refresh();
          }}
        />
      )}
      {giftOpen && (
        <GiftDialog
          gift={giftDraft}
          children={children}
          employees={employees}
          events={events}
          canEdit={props.canEdit}
          onClose={() => setGiftOpen(false)}
          onChanged={async () => {
            await refresh();
          }}
        />
      )}
    </div>
  );
}

/**
 * Мероприятие: название, вид, дата и ОТБОР. Отбор — фильтр по годам, полу и признакам;
 * сохраняется только решение оператора по каждому ребёнку.
 */
function EventDialog(props: {
  event: OrgEventDto | null;
  children: ChildDto[];
  employees: EmployeeRow[];
  canEdit: boolean;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const { event } = props;
  const [title, setTitle] = useState(event?.title ?? '');
  const [kind, setKind] = useState<string>(event?.kind ?? 'holiday');
  const [eventDate, setEventDate] = useState(toDateInput(event?.eventDate ?? null));
  const [description, setDescription] = useState(event?.description ?? '');
  const [selections, setSelections] = useState<EventSelection[]>(parseEventSelections(event?.selectionsJson));
  const [facets, setFacets] = useState<ChildFacetSelection>({});
  const [facetFields, setFacetFields] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const now = Date.now();

  const employeeById = useMemo(() => {
    const map = new Map<string, EmployeeRow>();
    for (const e of props.employees) map.set(String(e.id), e);
    return map;
  }, [props.employees]);

  const rows = useMemo<ChildFacetRow[]>(
    () =>
      props.children.map((c) => {
        const parent = c.employeeId ? employeeById.get(String(c.employeeId)) : undefined;
        return {
          id: c.id,
          parentId: c.employeeId,
          parentFullName: parent?.displayName ?? null,
          parentDepartmentName: null,
          parentStatus: parent?.employmentStatus ?? null,
          parentTerminationDate: parent?.terminationDate ?? null,
          ageYears: childAgeYears(c.birthDate, now),
          birthDate: c.birthDate,
          gender: c.gender,
          tags: [],
          giftsThisYear: 0,
          activityState: childActivityState({
            employmentStatus: parent?.employmentStatus ?? null,
            terminationDate: parent?.terminationDate ?? null,
          }),
        };
      }),
    [props.children, employeeById, now],
  );

  const filtered = useMemo(() => applyChildFacets(rows, facets), [rows, facets]);

  function decide(childId: string, invited: boolean) {
    setSelections((prev) => {
      const rest = prev.filter((s) => s.childId !== childId);
      return [...rest, { childId, invited, reason: prev.find((s) => s.childId === childId)?.reason ?? '' }];
    });
  }

  async function save() {
    const name = title.trim();
    if (!name) {
      setStatus('Название мероприятия обязательно');
      return;
    }
    setBusy(true);
    setStatus('');
    try {
      const res = await window.matrica.organization.saveEvent({
        id: event?.id ?? null,
        title: name,
        kind,
        eventDate: fromDateInput(eventDate),
        description: description.trim() || null,
        selections: selections.map((s) => ({ childId: s.childId, invited: s.invited, reason: s.reason })),
      });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      await props.onChanged();
      props.onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="presentation"
      style={{ position: 'fixed', inset: 0, zIndex: 4100, background: 'rgba(15,23,42,.45)', display: 'grid', placeItems: 'center', padding: 16 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) props.onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Мероприятие"
        style={{ width: 'min(860px, 100%)', maxHeight: '90vh', overflow: 'auto', borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)', padding: 18, display: 'grid', gap: 12 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 800, fontSize: 17 }}>{event ? event.title : 'Новое мероприятие'}</div>
          <Button variant="ghost" onClick={() => props.onClose()}>
            Закрыть
          </Button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Название</span>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy || !props.canEdit} />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Вид</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)} disabled={busy || !props.canEdit} style={selStyle}>
              {EVENT_KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Дата</span>
            <Input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} disabled={busy || !props.canEdit} />
          </label>
        </div>

        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Описание</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={busy || !props.canEdit}
            rows={2}
            style={{ ...selStyle, height: 'auto', padding: 8 }}
          />
        </label>

        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ fontWeight: 700 }}>Отбор: кого зовём</div>
          <FacetFilter<ChildFacetRow>
            facets={CHILD_FACETS as readonly FacetDescriptor<ChildFacetRow>[]}
            rows={rows}
            selection={facets as FacetSelection}
            fields={facetFields}
            usageKey="organization:event-selection"
            onChangeSelection={(next) => setFacets(next as ChildFacetSelection)}
            onChangeFields={(next) => setFacetFields(next)}
            onReset={() => setFacets({})}
          />
          <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'clip', maxHeight: 280, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...thStyle, color: 'inherit', background: '#f1f5f9' }}>Ребёнок</th>
                  <th style={{ ...thStyle, color: 'inherit', background: '#f1f5f9' }}>Возраст</th>
                  <th style={{ ...thStyle, color: 'inherit', background: '#f1f5f9' }}>Приглашён</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const child = props.children.find((c) => c.id === r.id);
                  const decision = selections.find((s) => s.childId === r.id);
                  const silver = r.activityState === 'silver';
                  return (
                    <tr key={r.id}>
                      <td style={tdStyle}>
                        {child?.fullName ?? r.id}
                        {silver && <div style={{ fontSize: 12, color: '#94a3b8' }}>серенький — в отбор не попадает</div>}
                      </td>
                      <td style={tdStyle}>{childAgeBandOf(r.ageYears) ?? '—'}</td>
                      <td style={tdStyle}>
                        <input
                          type="checkbox"
                          checked={decision?.invited === true}
                          disabled={busy || !props.canEdit || silver}
                          onChange={(e) => decide(r.id, e.target.checked)}
                        />
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={3} style={{ padding: 12, color: '#6b7280' }}>
                      Под условия отбора никто не попал.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 12, color: 'var(--subtle)' }}>
            «Серенькие» (дети уволенных, в декрете и на лечении) в отбор не попадают — правило одно,
            из статуса занятости родителя.
          </div>
        </div>

        {status && <div style={{ color: status.startsWith('Ошибка') ? '#b91c1c' : 'var(--subtle)', fontSize: 13 }}>{status}</div>}

        {props.canEdit && (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => props.onClose()} disabled={busy}>
              Отмена
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={busy}>
              Сохранить
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Запись журнала выдачи: кому, что, когда и по какому мероприятию. */
function GiftDialog(props: {
  gift: GiftRecordDto | null;
  children: ChildDto[];
  employees: EmployeeRow[];
  events: OrgEventDto[];
  canEdit: boolean;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const { gift } = props;
  const [recipientKind, setRecipientKind] = useState<string>(gift?.recipientKind ?? 'child');
  const [childId, setChildId] = useState(gift?.recipientChildId ?? '');
  const [employeeId, setEmployeeId] = useState(gift?.recipientEmployeeId ?? '');
  const [eventId, setEventId] = useState(gift?.eventId ?? '');
  const [kind, setKind] = useState<string>(gift?.kind ?? 'gift');
  const [title, setTitle] = useState(gift?.title ?? '');
  const [place, setPlace] = useState(gift?.place ?? '');
  const [givenAt, setGivenAt] = useState(toDateInput(gift?.givenAt ?? null));
  const [note, setNote] = useState(gift?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  async function save() {
    if (recipientKind === 'child' && !childId) {
      setStatus('Выберите ребёнка');
      return;
    }
    if (recipientKind === 'employee' && !employeeId) {
      setStatus('Выберите сотрудника');
      return;
    }
    setBusy(true);
    setStatus('');
    try {
      const res = await window.matrica.organization.saveGift({
        id: gift?.id ?? null,
        eventId: eventId || null,
        recipientKind,
        recipientChildId: recipientKind === 'child' ? childId : null,
        recipientEmployeeId: recipientKind === 'employee' ? employeeId : null,
        kind,
        title: title.trim(),
        place: place.trim(),
        givenAt: fromDateInput(givenAt),
        note: note.trim() || null,
      });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      await props.onChanged();
      props.onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="presentation"
      style={{ position: 'fixed', inset: 0, zIndex: 4100, background: 'rgba(15,23,42,.45)', display: 'grid', placeItems: 'center', padding: 16 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) props.onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Выдача подарка"
        style={{ width: 'min(620px, 100%)', maxHeight: '90vh', overflow: 'auto', borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)', padding: 18, display: 'grid', gap: 12 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 800, fontSize: 17 }}>Выдача: подарок, приз, грамота</div>
          <Button variant="ghost" onClick={() => props.onClose()}>
            Закрыть
          </Button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Кому</span>
            <select
              value={recipientKind}
              onChange={(e) => setRecipientKind(e.target.value)}
              disabled={busy || !props.canEdit}
              style={selStyle}
            >
              <option value="child">ребёнку</option>
              <option value="employee">сотруднику</option>
            </select>
          </label>
          {recipientKind === 'child' ? (
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Ребёнок</span>
              <select value={childId} onChange={(e) => setChildId(e.target.value)} disabled={busy || !props.canEdit} style={selStyle}>
                <option value="">— выберите —</option>
                {props.children.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.fullName}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Сотрудник</span>
              <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} disabled={busy || !props.canEdit} style={selStyle}>
                <option value="">— выберите —</option>
                {props.employees.map((e) => (
                  <option key={String(e.id)} value={String(e.id)}>
                    {e.displayName ?? String(e.id)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Вид</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)} disabled={busy || !props.canEdit} style={selStyle}>
              {GIFT_KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Мероприятие</span>
            <select value={eventId} onChange={(e) => setEventId(e.target.value)} disabled={busy || !props.canEdit} style={selStyle}>
              <option value="">— вне мероприятия —</option>
              {props.events.map((ev) => (
                <option key={ev.id} value={ev.id}>
                  {ev.title}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Что подарили</span>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy || !props.canEdit} />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Место / ранг</span>
            <Input value={place} onChange={(e) => setPlace(e.target.value)} disabled={busy || !props.canEdit} placeholder="1 место" />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Дата выдачи</span>
            <Input type="date" value={givenAt} onChange={(e) => setGivenAt(e.target.value)} disabled={busy || !props.canEdit} />
          </label>
        </div>

        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Примечание</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy || !props.canEdit}
            rows={2}
            style={{ ...selStyle, height: 'auto', padding: 8 }}
          />
        </label>

        {status && <div style={{ color: status.startsWith('Ошибка') ? '#b91c1c' : 'var(--subtle)', fontSize: 13 }}>{status}</div>}

        {props.canEdit && (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => props.onClose()} disabled={busy}>
              Отмена
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={busy}>
              Сохранить
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = { textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)' };
const tdStyle: React.CSSProperties = { padding: 10, borderBottom: '1px solid #f3f4f6', fontSize: 14 };
const ROWNUM_STYLE: React.CSSProperties = { width: '1%', whiteSpace: 'nowrap', textAlign: 'right', color: '#6b7280' };
const selStyle: React.CSSProperties = {
  height: 32,
  padding: '4px 8px',
  borderRadius: 8,
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  color: 'var(--text, #0b1220)',
};
