import React, { useMemo, useState } from 'react';

import {
  CHILD_TAG_CATALOG,
  childActivityLabelRu,
  childActivityState,
  childAgeYears,
  childGiftDueThisYear,
  childGenderLabelRu,
  childTagsLabelRu,
  giftKindLabelRu,
  parseChildTags,
  type ChildDto,
  type GiftRecordDto,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';

type EmployeeRow = {
  id: string;
  displayName?: string | null;
  departmentName?: string | null;
  employmentStatus?: string | null;
  terminationDate?: number | null;
};

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
 * Карточка ребёнка: кто родился когда, чей это ребёнок, что получал и что «надо получить».
 *
 * Возраст не хранится — он считается от даты рождения, поэтому смена ДР меняет возраст
 * везде сразу. «Серенький» статус тоже выводится: у ребёнка нет своего флага, он берётся
 * из статуса занятости родителя.
 */
export function ChildCardDialog(props: {
  child: ChildDto | null;
  employees: EmployeeRow[];
  gifts: GiftRecordDto[];
  canEdit: boolean;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const { child } = props;
  const [editing, setEditing] = useState(false);
  const [fullName, setFullName] = useState(child?.fullName ?? '');
  const [employeeId, setEmployeeId] = useState(child?.employeeId ?? '');
  const [birthDate, setBirthDate] = useState(toDateInput(child?.birthDate ?? null));
  const [gender, setGender] = useState(child?.gender ?? '');
  const [tags, setTags] = useState<string[]>(parseChildTags(child?.tagsJson));
  const [customTag, setCustomTag] = useState('');
  const [note, setNote] = useState(child?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const now = Date.now();

  const parent = useMemo(
    () => props.employees.find((e) => String(e.id) === String(employeeId)) ?? null,
    [props.employees, employeeId],
  );
  const activity = childActivityState({
    employmentStatus: parent?.employmentStatus ?? null,
    terminationDate: parent?.terminationDate ?? null,
  });
  const age = childAgeYears(child?.birthDate ?? null, now);
  const due = childGiftDueThisYear({
    gifts: props.gifts,
    childId: child?.id ?? '',
    birthDate: child?.birthDate ?? null,
    nowMs: now,
  });
  const history = props.gifts.filter((g) => g.recipientChildId === child?.id);

  function toggleTag(id: string) {
    setTags((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));
  }

  async function save() {
    const name = fullName.trim();
    if (!name) {
      setStatus('ФИО ребёнка обязательно');
      return;
    }
    setBusy(true);
    setStatus('');
    try {
      const res = await window.matrica.children.save({
        id: child?.id ?? null,
        fullName: name,
        employeeId: employeeId ? String(employeeId) : null,
        birthDate: fromDateInput(birthDate),
        gender: gender || null,
        tags,
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
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) props.onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Карточка ребёнка"
        style={{ width: 'min(720px, 100%)', maxHeight: '90vh', overflow: 'auto', borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)', padding: 18, display: 'grid', gap: 12 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ fontWeight: 800, fontSize: 17 }}>{child ? child.fullName : 'Новый ребёнок'}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {props.canEdit && !editing && (
              <Button variant="ghost" onClick={() => setEditing(true)}>
                Править
              </Button>
            )}
            <Button variant="ghost" onClick={() => props.onClose()}>
              Закрыть
            </Button>
          </div>
        </div>

        {!editing ? (
          <div style={{ display: 'grid', gap: 8, fontSize: 14 }}>
            <Row label="Родитель" value={parent?.displayName ?? '—'} />
            <Row label="Подразделение родителя" value={parent?.departmentName ?? '—'} />
            <Row label="Дата рождения" value={formatDate(child?.birthDate ?? null)} />
            <Row label="Возраст" value={age == null ? '—' : `${age} лет`} />
            <Row label="Пол" value={childGenderLabelRu(child?.gender ?? '')} />
            <Row label="Признаки" value={childTagsLabelRu(parseChildTags(child?.tagsJson)) || '—'} />
            <Row label="Состояние" value={childActivityLabelRu(activity)} />
            <Row label="Подарки в этом году" value={due.due ? 'пора дарить' : `${due.received} шт.`} />
            {due.category && <Row label="Подсказка подарка" value={due.category} />}
            {child?.note ? <Row label="Примечание" value={child.note} /> : null}
            <div style={{ marginTop: 4 }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>История подарков</div>
              {history.length === 0 ? (
                <div style={{ color: 'var(--subtle)' }}>Подарков ещё не было.</div>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {history.map((g) => (
                    <li key={g.id}>
                      {formatDate(g.givenAt)} — {giftKindLabelRu(g.kind)}: {g.title || '—'}
                      {g.place ? ` (${g.place})` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--subtle)' }}>ФИО ребёнка</span>
              <Input value={fullName} autoFocus onChange={(e) => setFullName(e.target.value)} disabled={busy} />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Родитель (сотрудник)</span>
              <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} disabled={busy} style={selStyle}>
                <option value="">— не указан —</option>
                {props.employees.map((e) => (
                  <option key={String(e.id)} value={String(e.id)}>
                    {e.displayName ?? String(e.id)}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Дата рождения</span>
              <Input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} disabled={busy} />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Пол</span>
              <select value={gender} onChange={(e) => setGender(e.target.value)} disabled={busy} style={selStyle}>
                <option value="">— не указан —</option>
                <option value="male">мальчик</option>
                <option value="female">девочка</option>
              </select>
            </label>
            <div style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Признаки отбора</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {CHILD_TAG_CATALOG.map((t) => (
                  <label key={t.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                    <input type="checkbox" checked={tags.includes(t.id)} onChange={() => toggleTag(t.id)} disabled={busy} />
                    {t.label}
                  </label>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Input
                  value={customTag}
                  placeholder="Свой признак"
                  onChange={(e) => setCustomTag(e.target.value)}
                  disabled={busy}
                />
                <Button
                  variant="ghost"
                  onClick={() => {
                    const value = customTag.trim();
                    if (!value) return;
                    setTags((prev) => (prev.includes(value) ? prev : [...prev, value]));
                    setCustomTag('');
                  }}
                  disabled={busy}
                >
                  Добавить
                </Button>
              </div>
              {tags.filter((t) => !CHILD_TAG_CATALOG.some((k) => k.id === t)).length > 0 && (
                <div style={{ fontSize: 12, color: 'var(--subtle)' }}>
                  Свои признаки: {tags.filter((t) => !CHILD_TAG_CATALOG.some((k) => k.id === t)).join(', ')}
                </div>
              )}
            </div>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Примечание</span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={busy}
                rows={2}
                style={{ ...selStyle, height: 'auto', padding: 8 }}
              />
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
                Отмена
              </Button>
              <Button variant="primary" onClick={() => void save()} disabled={busy}>
                Сохранить
              </Button>
            </div>
          </div>
        )}

        {status && <div style={{ color: status.startsWith('Ошибка') ? '#b91c1c' : 'var(--subtle)', fontSize: 13 }}>{status}</div>}
      </div>
    </div>
  );
}

function Row(props: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '190px 1fr', gap: 8 }}>
      <span style={{ color: 'var(--subtle)' }}>{props.label}</span>
      <span>{props.value}</span>
    </div>
  );
}

const selStyle: React.CSSProperties = {
  height: 32,
  padding: '4px 8px',
  borderRadius: 8,
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  color: 'var(--text, #0b1220)',
};
