import React, { useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { SearchSelectWithCreate } from '../components/SearchSelectWithCreate.js';
import { AttachmentsPanel } from '../components/AttachmentsPanel.js';
import { SectionCard } from '../components/SectionCard.js';
import { SuggestInput } from '../components/SuggestInput.js';
import { escapeHtml, openPrintPreview } from '../utils/printPreview.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';

type Option = { id: string; label: string };
type EmployeeOption = Option & { departmentId: string | null };

type ToolPropertyRow = { propertyId: string; value?: string };

type MovementRow = {
  id: string;
  movementAt: number;
  mode: 'received' | 'returned';
  employeeId?: string | null;
  confirmed: boolean;
  confirmedById?: string | null;
  comment?: string | null;
};

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

function keyValueTable(rows: Array<[string, string]>) {
  const body = rows
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value || '—')}</td></tr>`)
    .join('\n');
  return `<table><tbody>${body}</tbody></table>`;
}

function fileListHtml(list: unknown) {
  const items = Array.isArray(list)
    ? list.filter((x) => x && typeof x === 'object' && typeof (x as any).name === 'string')
    : [];
  if (items.length === 0) return '<div class="muted">Нет файлов</div>';
  return `<ul>${items.map((f) => `<li>${escapeHtml(String((f as any).name))}</li>`).join('')}</ul>`;
}

export function ToolDetailsPage(props: {
  toolId: string;
  canEdit: boolean;
  canViewFiles: boolean;
  canUploadFiles: boolean;
  onBack: () => void;
}) {
  const [status, setStatus] = useState<string>('');
  const [toolNumber, setToolNumber] = useState('');
  const [name, setName] = useState('');
  const [toolCatalogId, setToolCatalogId] = useState<string>('');
  const [serialNumber, setSerialNumber] = useState('');
  const [description, setDescription] = useState('');
  const [departmentId, setDepartmentId] = useState<string>('');
  const [receivedAt, setReceivedAt] = useState('');
  const [retiredAt, setRetiredAt] = useState('');
  const [retireReason, setRetireReason] = useState('');
  const [photos, setPhotos] = useState<unknown>([]);
  const [properties, setProperties] = useState<ToolPropertyRow[]>([]);
  const [movements, setMovements] = useState<MovementRow[]>([]);

  const [propertyOptions, setPropertyOptions] = useState<Option[]>([]);
  const [propertyValueHints, setPropertyValueHints] = useState<Record<string, string[]>>({});
  const [toolCatalogOptions, setToolCatalogOptions] = useState<Option[]>([]);
  const [employeeOptionsAll, setEmployeeOptionsAll] = useState<EmployeeOption[]>([]);
  const [employeeOptions, setEmployeeOptions] = useState<Option[]>([]);
  const [departmentOptions, setDepartmentOptions] = useState<Option[]>([]);
  const [currentDepartmentId, setCurrentDepartmentId] = useState<string | null>(null);

  const [newMoveDate, setNewMoveDate] = useState<string>('');
  const [newMoveMode, setNewMoveMode] = useState<'received' | 'returned'>('received');
  const [newMoveEmployeeId, setNewMoveEmployeeId] = useState<string>('');
  const [newMoveConfirmed, setNewMoveConfirmed] = useState<boolean>(false);
  const [newMoveConfirmedById, setNewMoveConfirmedById] = useState<string>('');
  const [newMoveComment, setNewMoveComment] = useState<string>('');
  const [editingMovementId, setEditingMovementId] = useState<string | null>(null);

  const employeeLabelById = useMemo(() => new Map(employeeOptions.map((o) => [o.id, o.label])), [employeeOptions]);
  const departmentLabelById = useMemo(() => new Map(departmentOptions.map((o) => [o.id, o.label])), [departmentOptions]);

  async function refresh() {
    try {
      setStatus('Загрузка...');
      const r = await window.matrica.tools.get(props.toolId);
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      const attrs = (r as any).tool?.attributes ?? {};
      setToolNumber(String(attrs.tool_number ?? ''));
      setName(String(attrs.name ?? ''));
      setToolCatalogId(attrs.tool_catalog_id ? String(attrs.tool_catalog_id) : '');
      setSerialNumber(String(attrs.serial_number ?? ''));
      setDescription(String(attrs.description ?? ''));
      setDepartmentId(attrs.department_id ? String(attrs.department_id) : '');
      const receivedMs = attrs.received_at ? Number(attrs.received_at) : null;
      const retiredMs = attrs.retired_at ? Number(attrs.retired_at) : null;
      setReceivedAt(toInputDate(receivedMs));
      setRetiredAt(toInputDate(retiredMs));
      setRetireReason(String(attrs.retire_reason ?? ''));
      setPhotos(attrs.photos ?? []);
      const propsList = Array.isArray(attrs.properties) ? attrs.properties : [];
      const normalized: ToolPropertyRow[] = propsList
        .map((p: any) =>
          p && typeof p === 'object' ? { propertyId: String(p.propertyId ?? ''), value: p.value != null ? String(p.value) : '' } : null,
        )
        .filter(Boolean) as ToolPropertyRow[];
      setProperties(normalized);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function refreshMovements() {
    try {
      const r = await window.matrica.tools.movements.list(props.toolId);
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setMovements((r as any).movements ?? []);
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function loadOptions() {
    const [propsRes, catalogRes, employeesRes, typeRes, scopeRes] = await Promise.all([
      window.matrica.tools.properties.list().catch(() => null),
      window.matrica.tools.catalog.list().catch(() => null),
      window.matrica.tools.employees.list({ departmentId: departmentId || null }).catch(() => null),
      window.matrica.admin.entityTypes.list().catch(() => null),
      window.matrica.tools.scope().catch(() => null),
    ]);
    if (propsRes && (propsRes as any).ok) {
      const list = (propsRes as any).items ?? [];
      setPropertyOptions(list.map((p: any) => ({ id: String(p.id), label: String(p.name ?? '(без названия)') })));
    }
    if (catalogRes && (catalogRes as any).ok) {
      const list = (catalogRes as any).items ?? [];
      setToolCatalogOptions(list.map((p: any) => ({ id: String(p.id), label: String(p.name ?? '(без названия)') })));
    }
    if (employeesRes && (employeesRes as any).ok) {
      const list = (employeesRes as any).employees ?? [];
      setEmployeeOptionsAll(
        list.map((e: any) => ({
          id: String(e.id),
          label: String(e.label ?? e.fullName ?? e.displayName ?? e.name ?? e.id),
          departmentId: e.departmentId ? String(e.departmentId) : null,
        })),
      );
    }
    if (scopeRes && (scopeRes as any).ok) {
      setCurrentDepartmentId((scopeRes as any).departmentId ?? null);
    }
    if (typeRes) {
      const types = (typeRes as any) ?? [];
      const departmentType = types.find((t: any) => String(t.code) === 'department');
      if (departmentType?.id) {
        const deps = await window.matrica.admin.entities.listByEntityType(String(departmentType.id));
        const list = (deps as any) ?? [];
        setDepartmentOptions(
          list.map((d: any) => ({ id: String(d.id), label: String(d.displayName ?? d.name ?? d.id) })),
        );
      }
    }
  }

  useEffect(() => {
    void refresh();
    void refreshMovements();
    void loadOptions();
  }, [props.toolId]);

  useEffect(() => {
    const dept = departmentId || currentDepartmentId || null;
    void window.matrica.tools.employees.list({ departmentId: dept }).then((r: any) => {
      if (!r?.ok) return;
      const list = (r as any).employees ?? [];
      setEmployeeOptionsAll(
        list.map((e: any) => ({
          id: String(e.id),
          label: String(e.label ?? e.fullName ?? e.displayName ?? e.name ?? e.id),
          departmentId: e.departmentId ? String(e.departmentId) : null,
        })),
      );
      setEmployeeOptions(list.map((e: any) => ({ id: String(e.id), label: String(e.label ?? e.fullName ?? e.displayName ?? e.name ?? e.id) })));
    });
  }, [departmentId, currentDepartmentId]);

  useLiveDataRefresh(
    async () => {
      await refresh();
      await refreshMovements();
    },
    { intervalMs: 20000 },
  );

  useEffect(() => {
    if (employeeOptions.length > 0) return;
    const filtered = employeeOptionsAll.map((e) => ({ id: e.id, label: e.label }));
    setEmployeeOptions(filtered);
  }, [employeeOptionsAll]);

  async function saveAttribute(code: string, value: unknown) {
    if (!props.canEdit) return;
    const r = await window.matrica.tools.setAttr({ toolId: props.toolId, code, value });
    if (!r.ok) setStatus(`Ошибка: ${r.error}`);
    else setStatus('');
  }

  async function updateProperties(next: ToolPropertyRow[]) {
    setProperties(next);
    await saveAttribute('properties', next);
  }

  async function createDepartment(label: string): Promise<string | null> {
    if (!props.canEdit) return null;
    const clean = label.trim();
    if (!clean) return null;
    const types = await window.matrica.admin.entityTypes.list().catch(() => []);
    const departmentTypeId = (types as any[]).find((t) => String(t.code) === 'department')?.id;
    if (!departmentTypeId) {
      setStatus('Ошибка: не найден справочник подразделений');
      return null;
    }
    const created = await window.matrica.admin.entities.create(String(departmentTypeId));
    if (!created.ok || !created.id) {
      setStatus(`Ошибка: ${(created as any).error ?? 'не удалось создать подразделение'}`);
      return null;
    }
    await window.matrica.admin.entities.setAttr(created.id, 'name', clean);
    setDepartmentOptions((prev) => [...prev, { id: created.id, label: clean }].sort((a, b) => a.label.localeCompare(b.label, 'ru')));
    return created.id;
  }

  async function ensureValueHints(propertyId: string) {
    if (!propertyId || propertyValueHints[propertyId]) return;
    const r = await window.matrica.tools.properties.valueHints(propertyId).catch(() => null);
    if (!r || !(r as any).ok) return;
    setPropertyValueHints((prev) => ({ ...prev, [propertyId]: (r as any).values ?? [] }));
  }

  useEffect(() => {
    const ids = Array.from(new Set(properties.map((p) => p.propertyId).filter(Boolean)));
    ids.forEach((id) => void ensureValueHints(id));
  }, [properties.map((p) => p.propertyId).join('|')]);

  async function addMovement() {
    if (editingMovementId) {
      await updateMovement();
      return;
    }
    const movementAt = fromInputDate(newMoveDate) ?? Date.now();
    const r = await window.matrica.tools.movements.add({
      toolId: props.toolId,
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
    await refreshMovements();
  }

  async function updateMovement() {
    if (!editingMovementId) return;
    const movementAt = fromInputDate(newMoveDate) ?? Date.now();
    const r = await window.matrica.tools.movements.update({
      id: editingMovementId,
      toolId: props.toolId,
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
    setNewMoveDate('');
    setNewMoveMode('received');
    setNewMoveEmployeeId('');
    setNewMoveConfirmed(false);
    setNewMoveConfirmedById('');
    setNewMoveComment('');
    await refreshMovements();
  }

  function startEditMovement(m: MovementRow) {
    setEditingMovementId(m.id);
    setNewMoveDate(toInputDate(m.movementAt));
    setNewMoveMode(m.mode);
    setNewMoveEmployeeId(m.employeeId ?? '');
    setNewMoveConfirmed(m.confirmed);
    setNewMoveConfirmedById(m.confirmedById ?? '');
    setNewMoveComment(m.comment ?? '');
  }

  async function deleteMovement(m: MovementRow) {
    if (!confirm('Удалить движение инструмента?')) return;
    const r = await window.matrica.tools.movements.delete({ id: m.id, toolId: props.toolId });
    if (!r.ok) {
      setStatus(`Ошибка: ${r.error}`);
      return;
    }
    if (editingMovementId === m.id) {
      setEditingMovementId(null);
      setNewMoveDate('');
      setNewMoveMode('received');
      setNewMoveEmployeeId('');
      setNewMoveConfirmed(false);
      setNewMoveConfirmedById('');
      setNewMoveComment('');
    }
    await refreshMovements();
  }

  function printToolCard() {
    const mainRows: Array<[string, string]> = [
      ['Табельный номер', toolNumber],
      ['Наименование', name],
      ['Серийный номер', serialNumber],
      ['Описание', description],
      ['Подразделение', departmentLabelById.get(departmentId) ?? departmentId ?? '—'],
      ['Дата поступления', receivedAt || '—'],
      ['Дата снятия', retiredAt || '—'],
      ['Причина снятия', retireReason || '—'],
    ];
    const propRows: Array<[string, string]> = properties.map((p) => {
      const label = propertyOptions.find((o) => o.id === p.propertyId)?.label ?? p.propertyId;
      const val = p.value?.trim() || '—';
      return [label || '—', val];
    });
    const movRows: Array<[string, string]> = movements.map((m) => {
      const who = m.employeeId ? employeeLabelById.get(m.employeeId) ?? m.employeeId : '—';
      const confirmedBy = m.confirmedById ? employeeLabelById.get(m.confirmedById) ?? m.confirmedById : '—';
      return [
        new Date(m.movementAt).toLocaleDateString('ru-RU'),
        `${m.mode === 'returned' ? 'Вернул' : 'Получил'}; сотрудник: ${who}; подтверждение: ${
          m.confirmed ? `да (${confirmedBy})` : 'нет'
        }; комментарий: ${m.comment ?? ''}`,
      ];
    });
    openPrintPreview({
      title: 'Карточка инструмента',
      ...(name ? { subtitle: `Наименование: ${name}` } : {}),
      sections: [
        { id: 'main', title: 'Основные данные', html: keyValueTable(mainRows) },
        { id: 'props', title: 'Свойства инструмента', html: propRows.length ? keyValueTable(propRows) : '<div class="muted">Нет данных</div>' },
        { id: 'moves', title: 'Движение инструмента', html: movRows.length ? keyValueTable(movRows) : '<div class="muted">Нет данных</div>' },
        { id: 'files', title: 'Фото', html: fileListHtml(photos) },
      ],
    });
  }

  async function exportPdf() {
    setStatus('Генерация PDF...');
    const r = await window.matrica.tools.exportPdf(props.toolId).catch(() => null);
    if (!r || !(r as any).ok) {
      setStatus(`Ошибка: ${(r as any)?.error ?? 'не удалось создать PDF'}`);
      return;
    }
    const contentBase64 = (r as any).contentBase64;
    const fileName = (r as any).fileName;
    const mime = (r as any).mime;
    const bytes = Uint8Array.from(atob(contentBase64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
    setStatus('Готово.');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button variant="ghost" onClick={props.onBack}>
          Назад
        </Button>
        <strong>Карточка инструмента</strong>
        <span style={{ flex: 1 }} />
        <Button tone="info" onClick={printToolCard}>
          Распечатать карточку
        </Button>
        <Button tone="neutral" onClick={() => void exportPdf()}>
          Экспорт в PDF
        </Button>
      </div>

      {status && <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div>}

      <SectionCard>
        <div className="card-row" style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 220px) minmax(0, 1fr)', gap: 8, padding: '4px 6px' }}>
          <div>Табельный номер</div>
          <Input
            value={toolNumber}
            onChange={(e) => setToolNumber(e.target.value)}
            onBlur={() => void saveAttribute('tool_number', toolNumber.trim())}
            disabled={!props.canEdit}
          />
        </div>
        <div className="card-row" style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 220px) minmax(0, 1fr)', gap: 8, padding: '4px 6px' }}>
          <div>Наименование</div>
          <SearchSelectWithCreate
            value={toolCatalogId || null}
            options={toolCatalogOptions}
            disabled={!props.canEdit}
            canCreate={props.canEdit}
            createLabel="+Добавить инструмент"
            onChange={(next) => {
              const label = toolCatalogOptions.find((o) => o.id === next)?.label ?? '';
              setToolCatalogId(next ?? '');
              if (label) setName(label);
              void saveAttribute('tool_catalog_id', next || null);
              if (label) void saveAttribute('name', label);
            }}
            onCreate={async (label) => {
              const r = await window.matrica.tools.catalog.create({ name: label.trim() });
              if (!r.ok) {
                setStatus(`Ошибка: ${r.error}`);
                return null;
              }
              const id = (r as any).id as string;
              setToolCatalogOptions((prev) => [...prev, { id, label }]);
              setToolCatalogId(id);
              setName(label);
              void saveAttribute('tool_catalog_id', id);
              void saveAttribute('name', label);
              return id;
            }}
          />
        </div>
        <div className="card-row" style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 220px) minmax(0, 1fr)', gap: 8, padding: '4px 6px' }}>
          <div>Серийный номер</div>
          <Input
            value={serialNumber}
            onChange={(e) => setSerialNumber(e.target.value)}
            onBlur={() => void saveAttribute('serial_number', serialNumber.trim())}
            disabled={!props.canEdit}
          />
        </div>
        <div className="card-row" style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 220px) minmax(0, 1fr)', gap: 8, padding: '4px 6px' }}>
          <div>Описание</div>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => void saveAttribute('description', description.trim())}
            disabled={!props.canEdit}
          />
        </div>
        <div className="card-row" style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 220px) minmax(0, 1fr)', gap: 8, padding: '4px 6px' }}>
          <div>Подразделение</div>
          <SearchSelectWithCreate
            value={departmentId}
            options={departmentOptions}
            placeholder="Выберите подразделение"
            disabled={!props.canEdit}
            canCreate={props.canEdit}
            createLabel="Новое подразделение"
            onChange={(next) => {
              setDepartmentId(next ?? '');
              void saveAttribute('department_id', next || null);
            }}
            onCreate={async (label) => {
              const id = await createDepartment(label);
              if (!id) return null;
              setDepartmentId(id);
              void saveAttribute('department_id', id);
              return id;
            }}
          />
        </div>
        <div className="card-row" style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 220px) minmax(0, 1fr)', gap: 8, padding: '4px 6px' }}>
          <div>Дата поступления</div>
          <Input
            type="date"
            value={receivedAt}
            onChange={(e) => setReceivedAt(e.target.value)}
            onBlur={() => void saveAttribute('received_at', fromInputDate(receivedAt))}
            disabled={!props.canEdit}
          />
        </div>
        <div className="card-row" style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 220px) minmax(0, 1fr)', gap: 8, padding: '4px 6px' }}>
          <div>Дата снятия</div>
          <Input
            type="date"
            value={retiredAt}
            onChange={(e) => setRetiredAt(e.target.value)}
            onBlur={() => void saveAttribute('retired_at', fromInputDate(retiredAt))}
            disabled={!props.canEdit}
          />
        </div>
        <div className="card-row" style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 220px) minmax(0, 1fr)', gap: 8, padding: '4px 6px' }}>
          <div>Причина снятия</div>
          <Input
            value={retireReason}
            onChange={(e) => setRetireReason(e.target.value)}
            onBlur={() => void saveAttribute('retire_reason', retireReason.trim())}
            disabled={!props.canEdit}
          />
        </div>
      </SectionCard>

      <SectionCard
        title="Свойства инструмента"
        actions={
          props.canEdit ? (
            <Button
              variant="ghost"
              onClick={() => {
                const next = [...properties, { propertyId: '', value: '' }];
                void updateProperties(next);
              }}
            >
              Добавить свойство
            </Button>
          ) : undefined
        }
      >
        {properties.length === 0 && <div style={{ color: 'var(--subtle)' }}>Нет свойств.</div>}
        {properties.map((row, idx) => {
          const hints = row.propertyId ? propertyValueHints[row.propertyId] ?? [] : [];
          return (
            <div key={`${row.propertyId}-${idx}`} className="card-row" style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 180px) minmax(220px, 1fr) minmax(220px, 1fr) 80px', gap: 8, padding: '4px 6px' }}>
              <div>Свойство</div>
              <SearchSelectWithCreate
                value={row.propertyId}
                options={propertyOptions}
                disabled={!props.canEdit}
                canCreate={props.canEdit}
                createLabel="+Добавить новое свойство"
                onChange={(next) => {
                  const nextRows = properties.map((p, i) => (i === idx ? { ...p, propertyId: next ?? '', value: p.value ?? '' } : p));
                  void updateProperties(nextRows);
                  if (next) void ensureValueHints(next);
                }}
                onCreate={async (label) => {
                  const r = await window.matrica.tools.properties.create();
                  if (!r.ok) {
                    setStatus(`Ошибка: ${(r as any).error}`);
                    return null;
                  }
                  const id = (r as any).id as string;
                  await window.matrica.tools.properties.setAttr({ id, code: 'name', value: label.trim() });
                  setPropertyOptions((prev) => [...prev, { id, label }]);
                  return id;
                }}
              />
              <div>
                <SuggestInput
                  value={row.value ?? ''}
                  onChange={(nextValue) => {
                    const nextRows = properties.map((p, i) => (i === idx ? { ...p, value: nextValue } : p));
                    void updateProperties(nextRows);
                  }}
                  options={hints.map((h) => ({ value: h }))}
                  disabled={!props.canEdit}
                  placeholder="Значение свойства"
                  onCreate={async (label) => label.trim() || null}
                />
              </div>
              {props.canEdit ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    const nextRows = properties.filter((_p, i) => i !== idx);
                    void updateProperties(nextRows);
                  }}
                  style={{ color: 'var(--danger)' }}
                >
                  Удалить
                </Button>
              ) : (
                <div />
              )}
            </div>
          );
        })}
      </SectionCard>

      <SectionCard title="Движение инструмента">
        <div className="card-row" style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, 140px) minmax(140px, 1fr) minmax(140px, 1fr) minmax(180px, 1fr)', gap: 8, padding: '4px 6px' }}>
          <div>Дата</div>
          <Input type="date" value={newMoveDate} onChange={(e) => setNewMoveDate(e.target.value)} disabled={!props.canEdit} />
          <select
            value={newMoveMode}
            onChange={(e) => setNewMoveMode(e.target.value as 'received' | 'returned')}
            disabled={!props.canEdit}
            style={{ height: 'var(--ui-input-height, 32px)' }}
          >
            <option value="received">Получил</option>
            <option value="returned">Вернул</option>
          </select>
          <SearchSelect
            value={newMoveEmployeeId}
            options={employeeOptions}
            placeholder="Сотрудник"
            disabled={!props.canEdit}
            onChange={(next) => setNewMoveEmployeeId(next ?? '')}
          />
        </div>
        <div className="card-row" style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, 140px) minmax(160px, 1fr) minmax(220px, 1fr)', gap: 8, padding: '4px 6px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={newMoveConfirmed} onChange={(e) => setNewMoveConfirmed(e.target.checked)} disabled={!props.canEdit} />
            Подтверждено
          </label>
          <SearchSelect
            value={newMoveConfirmedById}
            options={employeeOptions}
            placeholder="Заведующий"
            disabled={!props.canEdit || !newMoveConfirmed}
            onChange={(next) => setNewMoveConfirmedById(next ?? '')}
          />
          <Input
            value={newMoveComment}
            onChange={(e) => setNewMoveComment(e.target.value)}
            placeholder="Комментарий"
            disabled={!props.canEdit}
          />
        </div>
        {props.canEdit && (
          <div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Button tone="success" onClick={() => void addMovement()}>
                {editingMovementId ? 'Сохранить движение' : 'Добавить движение'}
              </Button>
              {editingMovementId && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEditingMovementId(null);
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
          </div>
        )}

        <div style={{ border: '1px solid var(--border)', overflow: 'hidden', marginTop: 6 }}>
          <table className="list-table">
            <thead>
              <tr style={{ backgroundColor: 'var(--surface-2)', borderBottom: '1px solid var(--border)' }}>
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
                  <td colSpan={5} style={{ padding: '16px 12px', textAlign: 'center', color: 'var(--subtle)', fontSize: 14 }}>
                    Нет движений
                  </td>
                </tr>
              )}
              {movements.map((m) => (
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
                    {m.movementAt ? new Date(m.movementAt).toLocaleDateString('ru-RU') : '—'}
                  </td>
                  <td style={{ padding: '10px 12px', fontSize: 14, color: 'var(--text)' }}>{m.mode === 'returned' ? 'Вернул' : 'Получил'}</td>
                  <td style={{ padding: '10px 12px', fontSize: 14, color: 'var(--subtle)' }}>
                    {m.employeeId ? employeeLabelById.get(m.employeeId) ?? m.employeeId : '—'}
                  </td>
                  <td style={{ padding: '10px 12px', fontSize: 14, color: 'var(--subtle)' }}>
                    {m.confirmed ? `Да (${m.confirmedById ? employeeLabelById.get(m.confirmedById) ?? m.confirmedById : '—'})` : 'Нет'}
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
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <AttachmentsPanel
        title="Фото инструмента"
        value={photos}
        canView={props.canViewFiles}
        canUpload={props.canUploadFiles && props.canEdit}
        scope={{ ownerType: 'tool', ownerId: props.toolId, category: 'photos' }}
        onChange={async (next) => {
          setPhotos(next);
          const r = await window.matrica.tools.setAttr({ toolId: props.toolId, code: 'photos', value: next });
          if (!r.ok) return { ok: false as const, error: r.error };
          return { ok: true as const };
        }}
      />
    </div>
  );
}
