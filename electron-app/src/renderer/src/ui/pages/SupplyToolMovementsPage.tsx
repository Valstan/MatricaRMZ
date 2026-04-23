import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ToolMovementItem, WarehouseNomenclatureListItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelectWithCreate } from '../components/SearchSelectWithCreate.js';
import { SectionCard } from '../components/SectionCard.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { useWarehouseReferenceData } from '../hooks/useWarehouseReferenceData.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { formatMoscowDate } from '../utils/dateUtils.js';

type Option = { id: string; label: string };

function labelNorm(s: string | null | undefined) {
  return String(s ?? '').trim().toLowerCase();
}

function toInputDate(ms: number | null) {
  if (!ms) return '';
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function fromInputDate(v: string): number | null {
  if (!v) return null;
  const [y, m, d] = v.split('-').map((x) => Number(x));
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  const ms = dt.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isMovementSubjectNomenclatureRow(row: WarehouseNomenclatureListItem): boolean {
  const ref = String(row.directoryRefId ?? '').trim();
  if (!ref) return false;
  const dk = String(row.directoryKind ?? '').trim().toLowerCase();
  const g = labelNorm(row.groupName);
  if (dk === 'tool' && (g === 'инструменты' || g === 'инструмент и оснастка')) return true;
  if ((dk === 'good' || dk === 'product') && (g === 'товары' || g === 'готовая продукция' || g === 'покупные комплектующие')) {
    return true;
  }
  return false;
}

export function SupplyToolMovementsPage(props: {
  canEdit: boolean;
  canViewMasterData: boolean;
  onOpenNomenclature: (id: string) => void;
  onOpenEmployee: (employeeId: string) => void;
  canCreateEmployees?: boolean;
}) {
  const windowWidth = useWindowWidth();
  const compact = windowWidth < 1280;
  const movementPrimaryGridTemplate = compact ? '1fr' : 'minmax(110px, 140px) minmax(140px, 1fr) minmax(140px, 1fr) minmax(180px, 1fr) minmax(200px, 1fr)';
  const movementSecondaryGridTemplate = compact ? '1fr' : 'minmax(110px, 140px) minmax(160px, 1fr) minmax(220px, 1fr)';

  const { confirm: confirmModal } = useConfirm();
  const { nomenclature, loading: nomenclatureLoading, error: nomenclatureHookError, refresh: refreshNomenclature } =
    useWarehouseReferenceData({
      loadNomenclature: true,
    });

  const [status, setStatus] = useState('');
  const [movements, setMovements] = useState<ToolMovementItem[]>([]);
  const [employeeOptions, setEmployeeOptions] = useState<Option[]>([]);
  const [currentDepartmentId, setCurrentDepartmentId] = useState<string | null>(null);

  const [subjectEntityId, setSubjectEntityId] = useState('');
  const [newMoveDate, setNewMoveDate] = useState('');
  const [newMoveMode, setNewMoveMode] = useState<'received' | 'returned'>('received');
  const [newMoveEmployeeId, setNewMoveEmployeeId] = useState('');
  const [newMoveConfirmed, setNewMoveConfirmed] = useState(false);
  const [newMoveConfirmedById, setNewMoveConfirmedById] = useState('');
  const [newMoveComment, setNewMoveComment] = useState('');
  const [editingMovementId, setEditingMovementId] = useState<string | null>(null);
  const [editingSubjectId, setEditingSubjectId] = useState<string | null>(null);

  const subjectOptions = useMemo(() => {
    const rows = (nomenclature ?? []).filter(isMovementSubjectNomenclatureRow);
    const out: Option[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const ref = String(r.directoryRefId ?? '').trim();
      if (!ref || seen.has(ref)) continue;
      seen.add(ref);
      const label = String(r.name ?? '').trim() || ref;
      out.push({ id: ref, label });
    }
    out.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    return out;
  }, [nomenclature]);

  const nomenclatureIdByRefId = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of nomenclature ?? []) {
      const ref = String(r.directoryRefId ?? '').trim();
      if (!ref) continue;
      if (!m.has(ref)) m.set(ref, String(r.id));
    }
    return m;
  }, [nomenclature]);

  const employeeLabelById = useMemo(() => new Map(employeeOptions.map((o) => [o.id, o.label])), [employeeOptions]);

  const refreshMovements = useCallback(async () => {
    try {
      const r = await window.matrica.tools.movements.listAll();
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setMovements((r as { movements?: ToolMovementItem[] }).movements ?? []);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, []);

  const loadEmployees = useCallback(async () => {
    const r = await window.matrica.tools.employees.list({ departmentId: null }).catch(() => null);
    if (r && (r as { ok?: boolean }).ok) {
      const list = (r as { employees?: Array<{ id: string; label?: string; fullName?: string }> }).employees ?? [];
      setEmployeeOptions(
        list.map((e) => ({
          id: String(e.id),
          label: String(e.label ?? e.fullName ?? e.id),
        })),
      );
    }
  }, []);

  useEffect(() => {
    void refreshMovements();
    void loadEmployees();
    void window.matrica.tools
      .scope()
      .then((s: { ok?: boolean; departmentId?: string | null }) => {
        if (s && (s as { ok?: boolean }).ok) setCurrentDepartmentId((s as { departmentId?: string | null }).departmentId ?? null);
      })
      .catch(() => {});
  }, [refreshMovements, loadEmployees]);

  useLiveDataRefresh(
    async () => {
      await refreshMovements();
    },
    { intervalMs: 25_000 },
  );

  async function createEmployeeOption(label: string): Promise<string | null> {
    if (props.canCreateEmployees !== true) return null;
    const clean = label.trim();
    if (!clean) return null;
    const created = await window.matrica.employees.create();
    if (!created?.ok || !created?.id) {
      setStatus(`Ошибка: ${!created?.ok && created ? String((created as { error?: string }).error) : 'не удалось создать сотрудника'}`);
      return null;
    }
    const chunks = clean.split(/\s+/).filter(Boolean);
    const lastName = chunks[0] ?? clean;
    const firstName = chunks[1] ?? '';
    const middleName = chunks.slice(2).join(' ');
    await window.matrica.employees.setAttr(created.id, 'last_name', lastName);
    if (firstName) await window.matrica.employees.setAttr(created.id, 'first_name', firstName);
    if (middleName) await window.matrica.employees.setAttr(created.id, 'middle_name', middleName);
    await window.matrica.employees.setAttr(created.id, 'full_name', clean);
    const dept = currentDepartmentId;
    if (dept) await window.matrica.employees.setAttr(created.id, 'department_id', dept);
    setEmployeeOptions((prev) => [...prev, { id: created.id, label: clean }].sort((a, b) => a.label.localeCompare(b.label, 'ru')));
    return created.id;
  }

  const toolIdForSave = editingMovementId ? editingSubjectId : subjectEntityId;

  async function addMovement() {
    const tid = String(toolIdForSave ?? '').trim();
    if (!tid) {
      setStatus('Выберите позицию из номенклатуры (инструмент или товар).');
      return;
    }
    if (editingMovementId) {
      await updateMovement();
      return;
    }
    const movementAt = fromInputDate(newMoveDate) ?? Date.now();
    const r = await window.matrica.tools.movements.add({
      toolId: tid,
      movementAt,
      mode: newMoveMode,
      employeeId: newMoveEmployeeId || null,
      confirmed: newMoveConfirmed,
      confirmedById: newMoveConfirmed ? newMoveConfirmedById || null : null,
      comment: newMoveComment.trim() || null,
    });
    if (!r.ok) {
      setStatus(`Ошибка: ${r.error}`);
      return;
    }
    setNewMoveDate('');
    setNewMoveMode('received');
    setNewMoveEmployeeId('');
    setNewMoveConfirmed(false);
    setNewMoveConfirmedById('');
    setNewMoveComment('');
    setSubjectEntityId('');
    await refreshMovements();
  }

  async function updateMovement() {
    if (!editingMovementId || !editingSubjectId) return;
    const movementAt = fromInputDate(newMoveDate) ?? Date.now();
    const r = await window.matrica.tools.movements.update({
      id: editingMovementId,
      toolId: editingSubjectId,
      movementAt,
      mode: newMoveMode,
      employeeId: newMoveEmployeeId || null,
      confirmed: newMoveConfirmed,
      confirmedById: newMoveConfirmed ? newMoveConfirmedById || null : null,
      comment: newMoveComment.trim() || null,
    });
    if (!r.ok) {
      setStatus(`Ошибка: ${r.error}`);
      return;
    }
    setEditingMovementId(null);
    setEditingSubjectId(null);
    setNewMoveDate('');
    setNewMoveMode('received');
    setNewMoveEmployeeId('');
    setNewMoveConfirmed(false);
    setNewMoveConfirmedById('');
    setNewMoveComment('');
    await refreshMovements();
  }

  function startEditMovement(m: ToolMovementItem) {
    setEditingMovementId(m.id);
    setEditingSubjectId(m.toolId);
    setNewMoveDate(toInputDate(m.movementAt));
    setNewMoveMode(m.mode);
    setNewMoveEmployeeId(m.employeeId ?? '');
    setNewMoveConfirmed(m.confirmed);
    setNewMoveConfirmedById(m.confirmedById ?? '');
    setNewMoveComment(m.comment ?? '');
  }

  async function deleteMovement(m: ToolMovementItem) {
    const label = m.subjectName?.trim() || m.toolId;
    const ok = await confirmModal({
      detail: `Удалить движение по «${label}» от ${formatMoscowDate(m.movementAt)} (${m.mode === 'returned' ? 'возврат' : 'получение'})?`,
    });
    if (!ok) return;
    const r = await window.matrica.tools.movements.delete({ id: m.id, toolId: m.toolId });
    if (!r.ok) {
      setStatus(`Ошибка: ${r.error}`);
      return;
    }
    if (editingMovementId === m.id) {
      setEditingMovementId(null);
      setEditingSubjectId(null);
      setNewMoveDate('');
      setNewMoveMode('received');
      setNewMoveEmployeeId('');
      setNewMoveConfirmed(false);
      setNewMoveConfirmedById('');
      setNewMoveComment('');
    }
    await refreshMovements();
  }

  const hint =
    subjectOptions.length === 0
      ? 'В номенклатуре склада нет активных позиций в группах «Инструменты» и «Товары» с привязкой к карточке (перенесите справочники производства в складскую номенклатуру).'
      : '';

  return (
    <div style={{ padding: 16, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ marginBottom: 12, display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ flex: '1 1 280px', minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 22 }}>Учёт инструментов и товаров</h1>
          <p style={{ margin: '8px 0 0', color: 'var(--subtle)', fontSize: 13 }}>
            Движения по выдаче и возврату: позиции выбираются из складской номенклатуры (группы «Инструменты» и «Товары»).
          </p>
        </div>
        <Button
          variant="outline"
          tone="neutral"
          disabled={nomenclatureLoading}
          onClick={() => {
            void (async () => {
              setStatus('');
              await refreshNomenclature();
            })();
          }}
        >
          {nomenclatureLoading ? 'Загрузка…' : 'Обновить номенклатуру'}
        </Button>
      </div>

      {(status || nomenclatureHookError) && (
        <div
          style={{
            marginBottom: 12,
            fontSize: 13,
            color: status.startsWith('Ошибка') || nomenclatureHookError ? 'var(--danger)' : 'var(--subtle)',
          }}
        >
          {nomenclatureHookError || status}
        </div>
      )}

      <SectionCard title="Новое движение">
        {!editingMovementId && (
          <div className="card-row" style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : '160px 1fr', gap: 8, padding: '6px 6px' }}>
            <div>Позиция (номенклатура)</div>
            <SearchSelectWithCreate
              value={subjectEntityId}
              options={subjectOptions}
              placeholder="Инструмент или товар из номенклатуры"
              disabled={!props.canEdit}
              canCreate={false}
              createLabel=""
              onChange={(next) => setSubjectEntityId(next ?? '')}
              onCreate={async () => null}
            />
          </div>
        )}
        {editingMovementId && (
          <div className="card-row" style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : '160px 1fr', gap: 8, padding: '6px 6px' }}>
            <div>Позиция</div>
            <div style={{ fontSize: 14, paddingTop: 6 }}>
              {subjectOptions.find((o) => o.id === editingSubjectId)?.label ?? editingSubjectId ?? '—'}
            </div>
          </div>
        )}

        <div className="card-row" style={{ display: 'grid', gridTemplateColumns: movementPrimaryGridTemplate, gap: 8, padding: '4px 6px' }}>
          <div>Дата</div>
          <Input type="date" value={newMoveDate} onChange={(e) => setNewMoveDate(e.target.value)} disabled={!props.canEdit} />
          <select
            value={newMoveMode}
            onChange={(e) => setNewMoveMode(e.target.value as 'received' | 'returned')}
            disabled={!props.canEdit}
            style={{ height: 'var(--ui-input-height, 32px)', width: '100%' }}
          >
            <option value="received">Получил</option>
            <option value="returned">Вернул</option>
          </select>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'start', minWidth: 0 }}>
            <SearchSelectWithCreate
              value={newMoveEmployeeId}
              options={employeeOptions}
              placeholder="Сотрудник"
              disabled={!props.canEdit}
              canCreate={props.canCreateEmployees === true}
              createLabel="Новый сотрудник"
              onChange={(next) => setNewMoveEmployeeId(next ?? '')}
              onCreate={createEmployeeOption}
            />
            {newMoveEmployeeId ? (
              <Button variant="outline" tone="neutral" size="sm" onClick={() => props.onOpenEmployee(newMoveEmployeeId)}>
                Открыть
              </Button>
            ) : null}
          </div>
        </div>
        <div className="card-row" style={{ display: 'grid', gridTemplateColumns: movementSecondaryGridTemplate, gap: 8, padding: '4px 6px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={newMoveConfirmed} onChange={(e) => setNewMoveConfirmed(e.target.checked)} disabled={!props.canEdit} />
            Подтверждено
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'start', minWidth: 0 }}>
            <SearchSelectWithCreate
              value={newMoveConfirmedById}
              options={employeeOptions}
              placeholder="Заведующий"
              disabled={!props.canEdit || !newMoveConfirmed}
              canCreate={props.canCreateEmployees === true}
              createLabel="Новый сотрудник"
              onChange={(next) => setNewMoveConfirmedById(next ?? '')}
              onCreate={createEmployeeOption}
            />
            {newMoveConfirmedById ? (
              <Button variant="outline" tone="neutral" size="sm" onClick={() => props.onOpenEmployee(newMoveConfirmedById)}>
                Открыть
              </Button>
            ) : null}
          </div>
          <Input
            value={newMoveComment}
            onChange={(e) => setNewMoveComment(e.target.value)}
            placeholder="Комментарий (в т.ч. где находится)"
            disabled={!props.canEdit}
          />
        </div>
        {props.canEdit && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
            <Button tone="success" onClick={() => void addMovement()}>
              {editingMovementId ? 'Сохранить движение' : 'Добавить движение'}
            </Button>
            {editingMovementId && (
              <Button
                variant="ghost"
                onClick={() => {
                  setEditingMovementId(null);
                  setEditingSubjectId(null);
                  setNewMoveDate('');
                  setNewMoveMode('received');
                  setNewMoveEmployeeId('');
                  setNewMoveConfirmed(false);
                  setNewMoveConfirmedById('');
                  setNewMoveComment('');
                }}
              >
                Отмена
              </Button>
            )}
          </div>
        )}
        {hint ? <div style={{ marginTop: 10, fontSize: 13, color: 'var(--subtle)' }}>{hint}</div> : null}
      </SectionCard>

      <SectionCard title="Журнал движений" style={{ marginTop: 16 }}>
        <div style={{ border: '1px solid var(--border)', overflow: 'hidden', marginTop: 6 }}>
          <table className="list-table">
            <thead>
              <tr style={{ backgroundColor: 'var(--surface-2)', borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: 'var(--muted)' }}>Позиция</th>
                <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: 'var(--muted)' }}>Дата</th>
                <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: 'var(--muted)' }}>Режим</th>
                <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: 'var(--muted)' }}>Сотрудник</th>
                <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: 'var(--muted)' }}>Подтверждение</th>
                <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, fontSize: 14, color: 'var(--muted)' }}>Комментарий</th>
              </tr>
            </thead>
            <tbody>
              {movements.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ padding: '16px 12px', textAlign: 'center', color: 'var(--subtle)', fontSize: 14 }}>
                    Нет движений
                  </td>
                </tr>
              )}
              {movements.map((m) => {
                const nomId = nomenclatureIdByRefId.get(m.toolId);
                const title = m.subjectName?.trim() || subjectOptions.find((o) => o.id === m.toolId)?.label || m.toolId;
                return (
                  <tr
                    key={m.id}
                    style={{
                      borderBottom: '1px solid var(--border)',
                      cursor: props.canEdit ? 'pointer' : 'default',
                      background: editingMovementId === m.id ? 'var(--card-row-drag-bg)' : undefined,
                    }}
                    onClick={() => {
                      if (!props.canEdit) return;
                      startEditMovement(m);
                    }}
                  >
                    <td style={{ padding: '10px 12px', fontSize: 14, color: 'var(--text)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span>{title}</span>
                        {nomId && props.canViewMasterData ? (
                          <Button
                            variant="outline"
                            tone="neutral"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              props.onOpenNomenclature(nomId);
                            }}
                          >
                            Номенклатура
                          </Button>
                        ) : null}
                      </div>
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: 14, color: 'var(--text)' }}>
                      {m.movementAt ? formatMoscowDate(m.movementAt) : '—'}
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: 14, color: 'var(--text)' }}>{m.mode === 'returned' ? 'Вернул' : 'Получил'}</td>
                    <td style={{ padding: '10px 12px', fontSize: 14, color: 'var(--subtle)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span>{m.employeeId ? employeeLabelById.get(m.employeeId) ?? m.employeeId : '—'}</span>
                        {m.employeeId ? (
                          <Button
                            variant="outline"
                            tone="neutral"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              props.onOpenEmployee(m.employeeId as string);
                            }}
                          >
                            Открыть
                          </Button>
                        ) : null}
                      </div>
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: 14, color: 'var(--subtle)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span>
                          {m.confirmed ? `Да (${m.confirmedById ? employeeLabelById.get(m.confirmedById) ?? m.confirmedById : '—'})` : 'Нет'}
                        </span>
                        {m.confirmedById ? (
                          <Button
                            variant="outline"
                            tone="neutral"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              props.onOpenEmployee(m.confirmedById as string);
                            }}
                          >
                            Открыть
                          </Button>
                        ) : null}
                      </div>
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: 14, color: 'var(--subtle)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ flex: 1 }}>{m.comment || '—'}</span>
                        {props.canEdit && (
                          <Button
                            variant="ghost"
                            onClick={(e) => {
                              e.stopPropagation();
                              void deleteMovement(m);
                            }}
                            style={{ color: 'var(--danger)' }}
                          >
                            Удалить
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
