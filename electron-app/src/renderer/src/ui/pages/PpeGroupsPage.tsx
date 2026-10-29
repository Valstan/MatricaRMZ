import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { Input } from '../components/Input.js';
import { ListCount } from '../components/ListCount.js';
import { MultiSearchSelect, type MultiSearchSelectOption } from '../components/MultiSearchSelect.js';
import { RowNumberCell, RowNumberHeaderCell } from '../components/RowNumberCell.js';
import { SectionCard } from '../components/SectionCard.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';

type GroupRow = { id: string; name: string; membersCount: number; normsCount: number };

const ROWNUM_STYLE: React.CSSProperties = { width: '1%', whiteSpace: 'nowrap', textAlign: 'right', color: '#6b7280' };

/**
 * Группы должностей/бригад СИЗ: состав + нормы группы. Нормы группы транзитивно
 * видны людям группы — карточка сотрудника считает их наравне с личными
 * (ядро сливает с дедупом и минимальным сроком). Данные — на сервере (REST /ppe).
 */
export function PpeGroupsPage(props: { canEdit: boolean }) {
  const [rows, setRows] = useState<GroupRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [normIds, setNormIds] = useState<string[]>([]);
  const [employees, setEmployees] = useState<MultiSearchSelectOption[]>([]);
  const [norms, setNorms] = useState<MultiSearchSelectOption[]>([]);
  const [newName, setNewName] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const { confirm } = useConfirm();
  const canEdit = props.canEdit;

  const refresh = useCallback(async () => {
    const res = await window.matrica.ppe.groups.list();
    if (!res.ok) {
      setStatus(`Ошибка: ${res.error}`);
      return;
    }
    setRows(res.rows);
  }, []);

  // Пикер — из реплики СИЗ (`erp_employee_cards`), не из EAV-списка: состав группы
  // сервер принимает только по этим id (см. ppe:employees:list).
  const loadEmployees = useCallback(async () => {
    const emp = await window.matrica.ppe.employees.list().catch(() => null);
    setEmployees(
      (emp?.ok ? emp.employees : []).map((e) => ({
        id: e.id,
        label: e.fullName.trim() || e.id,
        ...(e.isActive === false ? { disabled: true, hintText: 'уволен' } : e.roleCode ? { hintText: e.roleCode } : {}),
        searchText: `${e.fullName} ${e.personnelNo ?? ''} ${e.roleCode ?? ''}${e.isActive === false ? ' уволен' : ''}`,
      })),
    );
  }, []);

  // Вкладка в keep-alive: без импульса люди, приехавшие импортом/зеркалом, не попали бы
  // в состав группы до перезапуска клиента.
  useLiveDataRefresh(loadEmployees, { intervalMs: 60_000, domains: ['ppe', 'employees'] });

  useEffect(() => {
    void (async () => {
      setStatus('Загрузка...');
      await refresh();
      setStatus('');
      await loadEmployees();
      const nrm = await window.matrica.ppe.norms.list().catch(() => null);
      if (nrm?.ok) {
        setNorms(
          nrm.rows.map((r) => ({
            id: r.id,
            label: r.name,
            ...(r.postTitle ? { hintText: r.postTitle } : {}),
            searchText: `${r.name} ${r.postTitle ?? ''}`,
          })),
        );
      }
    })();
  }, [refresh, loadEmployees]);

  const selected = useMemo(() => rows.find((r) => r.id === selectedId) ?? null, [rows, selectedId]);

  async function select(row: GroupRow) {
    setSelectedId(row.id);
    setStatus('');
    const [m, n] = await Promise.all([
      window.matrica.ppe.groups.members.get(row.id).catch(() => null),
      window.matrica.ppe.groups.norms.get(row.id).catch(() => null),
    ]);
    setMemberIds(m?.ok ? m.employeeIds : []);
    setNormIds(n?.ok ? n.normSetIds : []);
  }

  async function createGroup() {
    if (!newName.trim()) return setStatus('Укажите название группы');
    setBusy(true);
    try {
      const res = await window.matrica.ppe.groups.create({ name: newName.trim() });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      setNewName('');
      await refresh();
      setSelectedId(res.id);
      setMemberIds([]);
      setNormIds([]);
      setStatus('Группа создана');
    } finally {
      setBusy(false);
    }
  }

  async function removeGroup() {
    if (!selected) return;
    const ok = await confirm({
      title: 'Удалить группу?',
      detail: `«${selected.name}»: состав и нормы группы перестанут действовать. Личные нормы людей не тронуты.`,
      confirmLabel: 'Удалить',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await window.matrica.ppe.groups.delete(selected.id);
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      setSelectedId(null);
      setMemberIds([]);
      setNormIds([]);
      await refresh();
      setStatus('Группа удалена');
    } finally {
      setBusy(false);
    }
  }

  async function saveMembers() {
    if (!selected) return;
    setBusy(true);
    try {
      const res = await window.matrica.ppe.groups.members.set({ groupId: selected.id, employeeIds: memberIds });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      await refresh();
      setStatus(`Состав сохранён: ${res.members}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveNorms() {
    if (!selected) return;
    setBusy(true);
    try {
      const res = await window.matrica.ppe.groups.norms.set({ groupId: selected.id, normSetIds: normIds });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      await refresh();
      setStatus(`Нормы группы сохранены: ${res.norms}`);
    } finally {
      setBusy(false);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(q));
  }, [rows, query]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 380px) 1fr', gap: 16, alignItems: 'start' }}>
      <SectionCard title="Группы">
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по названию" style={{ flex: 1 }} />
        </div>
        {canEdit ? (
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Новая группа: бригада, участок…" style={{ flex: 1 }} />
            <Button variant="primary" onClick={() => void createGroup()} disabled={busy}>
              Создать
            </Button>
          </div>
        ) : null}
        {filtered.length === 0 ? (
          <div style={{ color: 'var(--muted)' }}>{rows.length === 0 ? 'Групп пока нет.' : 'Ничего не найдено.'}</div>
        ) : (
          <>
            <ListCount total={rows.length} shown={filtered.length} />
            <table className="table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <RowNumberHeaderCell style={ROWNUM_STYLE} />
                  <th>Группа</th>
                  <th style={{ textAlign: 'right' }}>Людей</th>
                  <th style={{ textAlign: 'right' }}>Норм</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => (
                  <tr
                    key={r.id}
                    onClick={() => void select(r)}
                    style={{ cursor: 'pointer', background: r.id === selectedId ? 'var(--accent-soft, rgba(0,0,0,0.06))' : undefined }}
                  >
                    <RowNumberCell n={i + 1} style={ROWNUM_STYLE} />
                    <td>{r.name}</td>
                    <td style={{ textAlign: 'right' }}>{r.membersCount}</td>
                    <td style={{ textAlign: 'right' }}>{r.normsCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </SectionCard>

      <div style={{ display: 'grid', gap: 16 }}>
        {!selected ? (
          <SectionCard title="Группы СИЗ">
            <div style={{ color: 'var(--muted)' }}>
              Выберите группу слева{canEdit ? ' или создайте новую' : ''}. Группа — это состав (люди) и нормы: нормы группы получают все её
              участники, как личные.
            </div>
          </SectionCard>
        ) : (
          <>
            <SectionCard title={`Состав группы «${selected.name}»`}>
              <MultiSearchSelect
                values={memberIds}
                options={employees}
                disabled={!canEdit || busy}
                placeholder="Выберите сотрудников"
                onChange={setMemberIds}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>Выбрано: {memberIds.length}</span>
                {canEdit ? (
                  <>
                    <Button variant="primary" onClick={() => void saveMembers()} disabled={busy}>
                      Сохранить состав
                    </Button>
                    <Button variant="ghost" tone="danger" onClick={() => void removeGroup()} disabled={busy}>
                      Удалить группу
                    </Button>
                  </>
                ) : null}
              </div>
            </SectionCard>

            <SectionCard title="Нормы группы">
              <MultiSearchSelect
                values={normIds}
                options={norms}
                disabled={!canEdit || busy}
                placeholder="Выберите наборы норм"
                onChange={setNormIds}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                  Выбрано: {normIds.length}. Нормы группы видны её людям в карточках и учитываются в сроках.
                </span>
                {canEdit ? (
                  <Button variant="primary" onClick={() => void saveNorms()} disabled={busy}>
                    Сохранить нормы
                  </Button>
                ) : null}
              </div>
            </SectionCard>
          </>
        )}

        {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger, #b00)' : 'var(--muted)' }}>{status}</div> : null}
      </div>
    </div>
  );
}
