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

export function AdminPage() {
  const [types, setTypes] = useState<EntityTypeRow[]>([]);
  const [selectedTypeId, setSelectedTypeId] = useState<string>('');
  const [defs, setDefs] = useState<AttrDefRow[]>([]);
  const [status, setStatus] = useState<string>('');

  const selectedType = useMemo(() => types.find((t) => t.id === selectedTypeId) ?? null, [types, selectedTypeId]);

  async function refreshTypes() {
    const rows = await window.matrica.admin.entityTypes.list();
    setTypes(rows);
    if (!selectedTypeId && rows[0]) setSelectedTypeId(rows[0].id);
  }

  async function refreshDefs(typeId: string) {
    const rows = await window.matrica.admin.attributeDefs.listByEntityType(typeId);
    setDefs(rows);
  }

  useEffect(() => {
    void refreshTypes();
  }, []);

  useEffect(() => {
    if (selectedTypeId) void refreshDefs(selectedTypeId);
  }, [selectedTypeId]);

  return (
    <div>
      <h2 style={{ margin: '8px 0' }}>Справочники (MVP)</h2>
      <div style={{ color: '#6b7280', marginBottom: 12 }}>
        Здесь можно создавать типы сущностей и атрибуты (для модульного расширения без миграций).
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 12 }}>
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


