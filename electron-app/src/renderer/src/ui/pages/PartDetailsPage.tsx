import React, { useEffect, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';

type Attribute = {
  id: string;
  code: string;
  name: string;
  dataType: string;
  value: unknown;
  isRequired: boolean;
  sortOrder: number;
  metaJson?: unknown;
};

type Part = {
  id: string;
  createdAt: number;
  updatedAt: number;
  attributes: Attribute[];
};

export function PartDetailsPage(props: {
  partId: string;
  canEdit: boolean;
  canDelete: boolean;
  onBack: () => void;
}) {
  const [part, setPart] = useState<Part | null>(null);
  const [status, setStatus] = useState<string>('');
  const [editingAttr, setEditingAttr] = useState<Record<string, unknown>>({});

  async function load() {
    try {
      setStatus('Загрузка…');
      const r = await window.matrica.parts.get(props.partId);
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setPart(r.part);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  useEffect(() => {
    void load();
  }, [props.partId]);

  async function saveAttribute(code: string, value: unknown) {
    if (!props.canEdit) return;
    try {
      setStatus('Сохранение…');
      const r = await window.matrica.parts.updateAttribute({ partId: props.partId, attributeCode: code, value });
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setStatus('Сохранено');
      setTimeout(() => setStatus(''), 2000);
      void load();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function handleDelete() {
    if (!props.canDelete) return;
    if (!confirm('Удалить деталь?')) return;
    try {
      setStatus('Удаление…');
      const r = await window.matrica.parts.delete(props.partId);
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      props.onBack();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  if (!part) {
    return (
      <div>
        <Button variant="ghost" onClick={props.onBack}>
          ← Назад
        </Button>
        {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}
      </div>
    );
  }

  const sortedAttrs = [...part.attributes].sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16 }}>
        <Button variant="ghost" onClick={props.onBack}>
          ← Назад
        </Button>
        <h2 style={{ margin: 0, flex: 1 }}>Карточка детали</h2>
        {props.canDelete && (
          <Button variant="ghost" onClick={() => void handleDelete()} style={{ color: '#b91c1c' }}>
            Удалить
          </Button>
        )}
      </div>

      {status && <div style={{ marginBottom: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}

      <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
        <div style={{ display: 'grid', gap: 16 }}>
          {sortedAttrs.map((attr) => {
            const value = editingAttr[attr.code] !== undefined ? editingAttr[attr.code] : attr.value;
            const isEditing = editingAttr[attr.code] !== undefined;

            return (
              <div key={attr.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ fontWeight: 600, fontSize: 14, color: '#374151' }}>
                  {attr.name}
                  {attr.isRequired && <span style={{ color: '#b91c1c' }}> *</span>}
                </label>
                {!props.canEdit || !isEditing ? (
                  <div
                    style={{
                      padding: '10px 12px',
                      border: '1px solid #e5e7eb',
                      borderRadius: 8,
                      backgroundColor: props.canEdit ? '#f9fafb' : '#ffffff',
                      fontSize: 14,
                      color: '#111827',
                      cursor: props.canEdit ? 'pointer' : 'default',
                    }}
                    onClick={() => {
                      if (props.canEdit) setEditingAttr({ ...editingAttr, [attr.code]: attr.value });
                    }}
                  >
                    {value === null || value === undefined ? (
                      <span style={{ color: '#9ca3af' }}>—</span>
                    ) : typeof value === 'string' ? (
                      value
                    ) : typeof value === 'number' ? (
                      String(value)
                    ) : typeof value === 'boolean' ? (
                      value ? 'Да' : 'Нет'
                    ) : (
                      JSON.stringify(value)
                    )}
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 8 }}>
                    {attr.dataType === 'text' || attr.dataType === 'link' ? (
                      <Input
                        value={String(value ?? '')}
                        onChange={(e) => setEditingAttr({ ...editingAttr, [attr.code]: e.target.value })}
                        style={{ flex: 1 }}
                      />
                    ) : attr.dataType === 'number' ? (
                      <Input
                        type="number"
                        value={String(value ?? '')}
                        onChange={(e) => setEditingAttr({ ...editingAttr, [attr.code]: Number(e.target.value) || 0 })}
                        style={{ flex: 1 }}
                      />
                    ) : attr.dataType === 'boolean' ? (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={!!value}
                          onChange={(e) => setEditingAttr({ ...editingAttr, [attr.code]: e.target.checked })}
                        />
                        <span>{value ? 'Да' : 'Нет'}</span>
                      </label>
                    ) : attr.dataType === 'date' ? (
                      <Input
                        type="date"
                        value={value && typeof value === 'number' ? new Date(value).toISOString().split('T')[0] : ''}
                        onChange={(e) => {
                          const d = e.target.value ? new Date(e.target.value).getTime() : null;
                          setEditingAttr({ ...editingAttr, [attr.code]: d });
                        }}
                        style={{ flex: 1 }}
                      />
                    ) : (
                      <Input
                        value={JSON.stringify(value ?? '')}
                        onChange={(e) => {
                          try {
                            const parsed = JSON.parse(e.target.value);
                            setEditingAttr({ ...editingAttr, [attr.code]: parsed });
                          } catch {
                            // ignore
                          }
                        }}
                        style={{ flex: 1 }}
                      />
                    )}
                    <Button
                      onClick={() => {
                        void saveAttribute(attr.code, value);
                        const newEditing = { ...editingAttr };
                        delete newEditing[attr.code];
                        setEditingAttr(newEditing);
                      }}
                    >
                      Сохранить
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        const newEditing = { ...editingAttr };
                        delete newEditing[attr.code];
                        setEditingAttr(newEditing);
                      }}
                    >
                      Отмена
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

