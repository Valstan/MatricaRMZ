import React, { useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';

type EntityTypeRow = { id: string; code: string; name: string; updatedAt: number; deletedAt: number | null };
type AttrDefRow = {
  id: string;
  entityTypeId: string;
  code: string;
  name: string;
  dataType: string;
  isRequired: boolean;
  sortOrder: number;
  metaJson: string | null;
  updatedAt: number;
  deletedAt: number | null;
};

type EntityRow = { id: string; typeId: string; updatedAt: number; syncStatus: string; displayName?: string };

export function AdminPage() {
  const [types, setTypes] = useState<EntityTypeRow[]>([]);
  const [selectedTypeId, setSelectedTypeId] = useState<string>('');
  const [defs, setDefs] = useState<AttrDefRow[]>([]);
  const [entities, setEntities] = useState<EntityRow[]>([]);
  const [selectedEntityId, setSelectedEntityId] = useState<string>('');
  const [entityAttrs, setEntityAttrs] = useState<Record<string, unknown>>({});
  const [status, setStatus] = useState<string>('');

  const selectedType = useMemo(() => types.find((t) => t.id === selectedTypeId) ?? null, [types, selectedTypeId]);
  const selectedEntity = useMemo(() => entities.find((e) => e.id === selectedEntityId) ?? null, [entities, selectedEntityId]);

  const linkTargetByCode: Record<string, string> = {
    customer_id: 'customer',
    contract_id: 'contract',
    work_order_id: 'work_order',
    workshop_id: 'workshop',
    section_id: 'section',
  };

  const [linkOptions, setLinkOptions] = useState<Record<string, { id: string; label: string }[]>>({});

  async function refreshTypes() {
    const rows = await window.matrica.admin.entityTypes.list();
    setTypes(rows);
    if (!selectedTypeId && rows[0]) setSelectedTypeId(rows[0].id);
  }

  async function refreshDefs(typeId: string) {
    const rows = await window.matrica.admin.attributeDefs.listByEntityType(typeId);
    setDefs(rows);
  }

  async function refreshEntities(typeId: string) {
    const rows = await window.matrica.admin.entities.listByEntityType(typeId);
    setEntities(rows as any);
    if (!rows.find((r) => r.id === selectedEntityId)) setSelectedEntityId(rows[0]?.id ?? '');
  }

  async function openEntity(id: string) {
    setSelectedEntityId(id);
    const d = await window.matrica.admin.entities.get(id);
    setEntityAttrs(d.attributes ?? {});
  }

  async function refreshLinkOptions(defsForType: AttrDefRow[]) {
    // Для link полей подгружаем списки сущностей целевого типа.
    const map: Record<string, { id: string; label: string }[]> = {};
    for (const d of defsForType) {
      if (d.dataType !== 'link') continue;
      const targetCode = linkTargetByCode[d.code];
      if (!targetCode) continue;
      const targetType = types.find((t) => t.code === targetCode);
      if (!targetType) continue;
      const list = await window.matrica.admin.entities.listByEntityType(targetType.id);
      map[d.code] = list.map((x) => ({ id: x.id, label: x.displayName ? `${x.displayName}` : x.id }));
    }
    setLinkOptions(map);
  }

  useEffect(() => {
    void refreshTypes();
  }, []);

  useEffect(() => {
    if (!selectedTypeId) return;
    void (async () => {
      await refreshDefs(selectedTypeId);
      await refreshEntities(selectedTypeId);
    })();
  }, [selectedTypeId]);

  useEffect(() => {
    if (!selectedEntityId) return;
    void openEntity(selectedEntityId);
  }, [selectedEntityId]);

  useEffect(() => {
    if (!selectedTypeId) return;
    void refreshLinkOptions(defs);
  }, [selectedTypeId, defs, types]);

  return (
    <div>
      <h2 style={{ margin: '8px 0' }}>Справочники (MVP)</h2>
      <div style={{ color: '#6b7280', marginBottom: 12 }}>
        Здесь можно создавать типы сущностей и атрибуты (для модульного расширения без миграций).
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr 1fr', gap: 12 }}>
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <strong>Типы сущностей</strong>
            <span style={{ flex: 1 }} />
            <Button variant="ghost" onClick={() => void refreshTypes()}>
              Обновить
            </Button>
          </div>

          <div style={{ marginTop: 10 }}>
            <select
              value={selectedTypeId}
              onChange={(e) => setSelectedTypeId(e.target.value)}
              style={{ width: '100%', padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
            >
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.code} — {t.name}
                </option>
              ))}
              {types.length === 0 && <option value="">(пусто)</option>}
            </select>
          </div>

          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>Добавить тип</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <NewEntityTypeForm
                onSubmit={async (code, name) => {
                  setStatus('Сохранение типа...');
                  const r = await window.matrica.admin.entityTypes.upsert({ code, name });
                  setStatus(r.ok ? 'Тип сохранён' : `Ошибка: ${r.error ?? 'unknown'}`);
                  await refreshTypes();
                }}
              />
            </div>
          </div>
        </div>

        <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <strong>Атрибуты</strong>
            <span style={{ color: '#6b7280' }}>{selectedType ? `для ${selectedType.code}` : ''}</span>
            <span style={{ flex: 1 }} />
            <Button variant="ghost" onClick={() => selectedTypeId && void refreshDefs(selectedTypeId)}>
              Обновить
            </Button>
          </div>

          <div style={{ marginTop: 12 }}>
            {selectedTypeId ? (
              <>
                <NewAttrDefForm
                  entityTypeId={selectedTypeId}
                  onSubmit={async (payload) => {
                    setStatus('Сохранение атрибута...');
                    const r = await window.matrica.admin.attributeDefs.upsert(payload);
                    setStatus(r.ok ? 'Атрибут сохранён' : `Ошибка: ${r.error ?? 'unknown'}`);
                    await refreshDefs(selectedTypeId);
                  }}
                />
                <div style={{ marginTop: 12, border: '1px solid #f3f4f6', borderRadius: 12, overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: '#f9fafb' }}>
                        <th style={{ textAlign: 'left', borderBottom: '1px solid #e5e7eb', padding: 10 }}>code</th>
                        <th style={{ textAlign: 'left', borderBottom: '1px solid #e5e7eb', padding: 10 }}>name</th>
                        <th style={{ textAlign: 'left', borderBottom: '1px solid #e5e7eb', padding: 10 }}>type</th>
                        <th style={{ textAlign: 'left', borderBottom: '1px solid #e5e7eb', padding: 10 }}>required</th>
                      </tr>
                    </thead>
                    <tbody>
                      {defs.map((d) => (
                        <tr key={d.id}>
                          <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{d.code}</td>
                          <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{d.name}</td>
                          <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{d.dataType}</td>
                          <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{d.isRequired ? 'да' : 'нет'}</td>
                        </tr>
                      ))}
                      {defs.length === 0 && (
                        <tr>
                          <td style={{ padding: 12, color: '#6b7280' }} colSpan={4}>
                            Атрибутов нет
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <div style={{ color: '#6b7280' }}>Выберите тип сущности</div>
            )}
          </div>
        </div>

        <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <strong>Сущности</strong>
            <span style={{ color: '#6b7280' }}>{selectedType ? `для ${selectedType.code}` : ''}</span>
            <span style={{ flex: 1 }} />
            <Button
              variant="ghost"
              onClick={() => {
                if (selectedTypeId) void refreshEntities(selectedTypeId);
              }}
            >
              Обновить
            </Button>
          </div>

          {!selectedTypeId ? (
            <div style={{ marginTop: 12, color: '#6b7280' }}>Выберите тип сущности</div>
          ) : (
            <>
              <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
                <Button
                  onClick={async () => {
                    setStatus('Создание сущности...');
                    const r = await window.matrica.admin.entities.create(selectedTypeId);
                    if (!r.ok) {
                      setStatus(`Ошибка: ${r.error}`);
                      return;
                    }
                    setStatus('Сущность создана');
                    await refreshEntities(selectedTypeId);
                    setSelectedEntityId(r.id);
                  }}
                >
                  Создать
                </Button>
                <Button
                  variant="ghost"
                  onClick={async () => {
                    if (!selectedEntityId) return;
                    setStatus('Удаление...');
                    const r = await window.matrica.admin.entities.softDelete(selectedEntityId);
                    setStatus(r.ok ? 'Удалено' : `Ошибка: ${r.error ?? 'unknown'}`);
                    await refreshEntities(selectedTypeId);
                    setSelectedEntityId('');
                    setEntityAttrs({});
                  }}
                >
                  Удалить
                </Button>
                <span style={{ flex: 1 }} />
                <select
                  value={selectedEntityId}
                  onChange={(e) => setSelectedEntityId(e.target.value)}
                  style={{ maxWidth: 260, padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
                >
                  {entities.map((e) => (
                    <option key={e.id} value={e.id}>
                      {(e.displayName ? `${e.displayName} — ` : '') + e.id.slice(0, 8)}
                    </option>
                  ))}
                  {entities.length === 0 && <option value="">(пусто)</option>}
                </select>
              </div>

              {selectedEntity ? (
                <div style={{ marginTop: 12, border: '1px solid #f3f4f6', borderRadius: 12, padding: 12 }}>
                  <div style={{ color: '#6b7280', fontSize: 12, marginBottom: 8 }}>Редактирование атрибутов</div>

                  <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 10, alignItems: 'center' }}>
                    {defs.map((d) => (
                      <React.Fragment key={d.id}>
                        <div style={{ color: '#6b7280' }}>{d.name}</div>
                        <FieldEditor
                          def={d}
                          value={entityAttrs[d.code]}
                          linkOptions={linkOptions[d.code] ?? []}
                          onChange={(v) => setEntityAttrs((p) => ({ ...p, [d.code]: v }))}
                          onSave={async (v) => {
                            const r = await window.matrica.admin.entities.setAttr(selectedEntityId, d.code, v);
                            if (!r.ok) setStatus(`Ошибка: ${r.error ?? 'unknown'}`);
                            else setStatus('Сохранено');
                            await refreshEntities(selectedTypeId);
                          }}
                        />
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              ) : (
                <div style={{ marginTop: 12, color: '#6b7280' }}>Выберите сущность</div>
              )}
            </>
          )}
        </div>
      </div>

      {status && <div style={{ marginTop: 12, color: '#6b7280' }}>{status}</div>}
    </div>
  );
}

function NewEntityTypeForm(props: { onSubmit: (code: string, name: string) => Promise<void> }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  return (
    <>
      <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="code (например: engine)" />
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="название (например: Двигатель)" />
      <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 10 }}>
        <Button
          onClick={() => {
            if (!code.trim() || !name.trim()) return;
            void props.onSubmit(code, name);
            setCode('');
            setName('');
          }}
        >
          Добавить
        </Button>
      </div>
    </>
  );
}

function NewAttrDefForm(props: {
  entityTypeId: string;
  onSubmit: (payload: {
    entityTypeId: string;
    code: string;
    name: string;
    dataType: string;
    isRequired?: boolean;
    sortOrder?: number;
    metaJson?: string | null;
  }) => Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [dataType, setDataType] = useState('text');
  const [isRequired, setIsRequired] = useState(false);
  const [sortOrder, setSortOrder] = useState('0');
  const [metaJson, setMetaJson] = useState('');

  return (
    <div style={{ border: '1px solid #f3f4f6', borderRadius: 12, padding: 12 }}>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>Добавить атрибут</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="code (например: passport_details)" />
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="название (например: Паспорт)" />
        <select
          value={dataType}
          onChange={(e) => setDataType(e.target.value)}
          style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
        >
          <option value="text">text</option>
          <option value="number">number</option>
          <option value="boolean">boolean</option>
          <option value="date">date</option>
          <option value="json">json</option>
          <option value="link">link</option>
        </select>
        <Input value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} placeholder="sortOrder" />
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: '#111827', fontSize: 14 }}>
          <input type="checkbox" checked={isRequired} onChange={(e) => setIsRequired(e.target.checked)} />
          обязательное
        </label>
        <Input value={metaJson} onChange={(e) => setMetaJson(e.target.value)} placeholder="metaJson (опц., JSON строка)" />
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 10 }}>
          <Button
            onClick={() => {
              if (!code.trim() || !name.trim()) return;
              void props.onSubmit({
                entityTypeId: props.entityTypeId,
                code,
                name,
                dataType,
                isRequired,
                sortOrder: Number(sortOrder) || 0,
                metaJson: metaJson.trim() ? metaJson : null,
              });
              setCode('');
              setName('');
              setMetaJson('');
            }}
          >
            Добавить
          </Button>
        </div>
      </div>
    </div>
  );
}

function FieldEditor(props: {
  def: AttrDefRow;
  value: unknown;
  linkOptions: { id: string; label: string }[];
  onChange: (v: unknown) => void;
  onSave: (v: unknown) => Promise<void>;
}) {
  const dt = props.def.dataType;

  // date хранится как ms number (unix ms).
  const toInputDate = (ms: number) => {
    const d = new Date(ms);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };
  const fromInputDate = (v: string): number | null => {
    if (!v) return null;
    const [y, m, d] = v.split('-').map((x) => Number(x));
    if (!y || !m || !d) return null;
    const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
    const ms = dt.getTime();
    return Number.isFinite(ms) ? ms : null;
  };

  if (dt === 'boolean') {
    const checked = Boolean(props.value);
    return (
      <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => {
            props.onChange(e.target.checked);
            void props.onSave(e.target.checked);
          }}
        />
        <span style={{ color: '#6b7280', fontSize: 12 }}>{checked ? 'да' : 'нет'}</span>
      </label>
    );
  }

  if (dt === 'date') {
    const ms = typeof props.value === 'number' ? props.value : null;
    return (
      <Input
        type="date"
        value={ms ? toInputDate(ms) : ''}
        onChange={(e) => {
          const next = fromInputDate(e.target.value);
          props.onChange(next);
          void props.onSave(next);
        }}
      />
    );
  }

  if (dt === 'number') {
    const s = props.value == null ? '' : String(props.value);
    return (
      <Input
        value={s}
        onChange={(e) => props.onChange(e.target.value === '' ? null : Number(e.target.value))}
        onBlur={() => void props.onSave(props.value == null || props.value === '' ? null : Number(props.value))}
        placeholder="число"
      />
    );
  }

  if (dt === 'json') {
    const s = props.value == null ? '' : JSON.stringify(props.value);
    return (
      <Input
        value={s}
        onChange={(e) => props.onChange(e.target.value)}
        onBlur={() => {
          try {
            const v = s ? JSON.parse(s) : null;
            void props.onSave(v);
          } catch {
            // оставим как есть
          }
        }}
        placeholder="json"
      />
    );
  }

  if (dt === 'link') {
    const current = typeof props.value === 'string' ? props.value : '';
    return (
      <select
        value={current}
        onChange={(e) => {
          const v = e.target.value || null;
          props.onChange(v);
          void props.onSave(v);
        }}
        style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
      >
        <option value="">(не выбрано)</option>
        {props.linkOptions.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }

  // text / fallback
  const text = props.value == null ? '' : String(props.value);
  return (
    <Input
      value={text}
      onChange={(e) => props.onChange(e.target.value)}
      onBlur={() => void props.onSave(text)}
      placeholder={props.def.code}
    />
  );
}


