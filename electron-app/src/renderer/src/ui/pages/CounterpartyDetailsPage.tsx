import React, { useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { AttachmentsPanel } from '../components/AttachmentsPanel.js';
import { DraggableFieldList } from '../components/DraggableFieldList.js';
import { ensureAttributeDefs, orderFieldsByDefs, persistFieldOrder, type AttributeDefRow } from '../utils/fieldOrder.js';

type CounterpartyEntity = {
  id: string;
  typeId: string;
  createdAt: number;
  updatedAt: number;
  attributes: Record<string, unknown>;
};

export function CounterpartyDetailsPage(props: {
  counterpartyId: string;
  canEdit: boolean;
  canViewFiles: boolean;
  canUploadFiles: boolean;
}) {
  const [entity, setEntity] = useState<CounterpartyEntity | null>(null);
  const [defs, setDefs] = useState<AttributeDefRow[]>([]);
  const [status, setStatus] = useState<string>('');
  const [typeId, setTypeId] = useState<string>('');
  const [coreDefsReady, setCoreDefsReady] = useState(false);

  const [name, setName] = useState<string>('');
  const [inn, setInn] = useState<string>('');
  const [kpp, setKpp] = useState<string>('');
  const [address, setAddress] = useState<string>('');
  const [phone, setPhone] = useState<string>('');
  const [email, setEmail] = useState<string>('');
  const [attachments, setAttachments] = useState<unknown>([]);

  async function load() {
    try {
      setStatus('Загрузка…');
      const types = await window.matrica.admin.entityTypes.list();
      const type = (types as any[]).find((t) => String(t.code) === 'customer') ?? null;
      if (!type?.id) {
        setEntity(null);
        setStatus('Справочник «Контрагенты» не найден (customer).');
        return;
      }
      setTypeId(String(type.id));
      const details = await window.matrica.admin.entities.get(props.counterpartyId);
      setEntity(details as any);
      const defsList = await window.matrica.admin.attributeDefs.listByEntityType(String(type.id));
      setDefs(defsList as AttributeDefRow[]);
      setCoreDefsReady(false);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  useEffect(() => {
    void load();
  }, [props.counterpartyId]);

  useEffect(() => {
    if (!props.canEdit || !typeId || defs.length === 0 || coreDefsReady) return;
    const desired = [
      { code: 'name', name: 'Название', dataType: 'text', sortOrder: 10 },
      { code: 'inn', name: 'ИНН', dataType: 'text', sortOrder: 20 },
      { code: 'kpp', name: 'КПП', dataType: 'text', sortOrder: 30 },
      { code: 'address', name: 'Адрес', dataType: 'text', sortOrder: 40 },
      { code: 'phone', name: 'Телефон', dataType: 'text', sortOrder: 50 },
      { code: 'email', name: 'Email', dataType: 'text', sortOrder: 60 },
      { code: 'attachments', name: 'Вложения', dataType: 'json', sortOrder: 300 },
    ];
    void ensureAttributeDefs(typeId, desired, defs).then((next) => {
      if (next.length !== defs.length) setDefs(next);
      setCoreDefsReady(true);
    });
  }, [props.canEdit, typeId, defs.length, coreDefsReady]);

  useEffect(() => {
    if (!entity) return;
    const attrs = entity.attributes ?? {};
    setName(String(attrs.name ?? ''));
    setInn(String(attrs.inn ?? ''));
    setKpp(String(attrs.kpp ?? ''));
    setAddress(String(attrs.address ?? ''));
    setPhone(String(attrs.phone ?? ''));
    setEmail(String(attrs.email ?? ''));
    setAttachments(attrs.attachments ?? []);
  }, [entity?.id, entity?.updatedAt]);

  async function saveAttr(code: string, value: unknown) {
    if (!props.canEdit) return;
    try {
      setStatus('Сохранение…');
      const r = await window.matrica.admin.entities.setAttr(props.counterpartyId, code, value);
      if (!r?.ok) {
        setStatus(`Ошибка: ${r?.error ?? 'unknown'}`);
        return;
      }
      setStatus('Сохранено');
      setTimeout(() => setStatus(''), 900);
      void load();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  if (!entity) {
    return <div>{status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}</div>;
  }

  const mainFields = orderFieldsByDefs(
    [
      {
        code: 'name',
        defaultOrder: 10,
        label: 'Название',
        value: name,
        render: (
          <Input value={name} disabled={!props.canEdit} onChange={(e) => setName(e.target.value)} onBlur={() => void saveAttr('name', name.trim())} />
        ),
      },
      {
        code: 'inn',
        defaultOrder: 20,
        label: 'ИНН',
        value: inn,
        render: (
          <Input value={inn} disabled={!props.canEdit} onChange={(e) => setInn(e.target.value)} onBlur={() => void saveAttr('inn', inn.trim() || null)} />
        ),
      },
      {
        code: 'kpp',
        defaultOrder: 30,
        label: 'КПП',
        value: kpp,
        render: (
          <Input value={kpp} disabled={!props.canEdit} onChange={(e) => setKpp(e.target.value)} onBlur={() => void saveAttr('kpp', kpp.trim() || null)} />
        ),
      },
      {
        code: 'address',
        defaultOrder: 40,
        label: 'Адрес',
        value: address,
        render: (
          <Input value={address} disabled={!props.canEdit} onChange={(e) => setAddress(e.target.value)} onBlur={() => void saveAttr('address', address.trim() || null)} />
        ),
      },
      {
        code: 'phone',
        defaultOrder: 50,
        label: 'Телефон',
        value: phone,
        render: (
          <Input value={phone} disabled={!props.canEdit} onChange={(e) => setPhone(e.target.value)} onBlur={() => void saveAttr('phone', phone.trim() || null)} />
        ),
      },
      {
        code: 'email',
        defaultOrder: 60,
        label: 'Email',
        value: email,
        render: (
          <Input value={email} disabled={!props.canEdit} onChange={(e) => setEmail(e.target.value)} onBlur={() => void saveAttr('email', email.trim() || null)} />
        ),
      },
      {
        code: 'attachments',
        defaultOrder: 300,
        label: 'Вложения',
        value: Array.isArray(attachments) ? attachments.length : 0,
        render: (
          <AttachmentsPanel
            title="Вложения"
            value={attachments}
            canView={props.canViewFiles}
            canUpload={props.canUploadFiles && props.canEdit}
            scope={{ ownerType: 'customer', ownerId: entity.id, category: 'attachments' }}
            onChange={(next) => saveAttr('attachments', next)}
          />
        ),
      },
    ],
    defs,
  );

  const headerTitle = name.trim() ? name.trim() : 'Карточка контрагента';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', paddingBottom: 8, borderBottom: '1px solid #e5e7eb' }}>
        <div style={{ fontSize: 20, fontWeight: 800 }}>{headerTitle}</div>
        <div style={{ flex: 1 }} />
        {status && <div style={{ color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280', fontSize: 12 }}>{status}</div>}
        <Button variant="ghost" onClick={() => void load()}>
          Обновить
        </Button>
      </div>

      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', paddingTop: 12 }}>
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
          <DraggableFieldList
            items={mainFields}
            getKey={(f) => f.code}
            canDrag={props.canEdit}
            onReorder={(next) => {
              if (!typeId) return;
              void persistFieldOrder(
                next.map((f) => f.code),
                defs,
                { entityTypeId: typeId },
              ).then(() => setDefs([...defs]));
            }}
            renderItem={(field, dragHandleProps, state) => (
              <div
                {...dragHandleProps}
                style={{
                  ...dragHandleProps.style,
                  display: 'grid',
                  gridTemplateColumns: 'minmax(160px, 200px) 1fr',
                  gap: 10,
                  alignItems: 'center',
                  padding: '6px 8px',
                  borderRadius: 8,
                  border: state.isOver ? '1px dashed #93c5fd' : '1px solid transparent',
                  background: state.isDragging ? 'rgba(59, 130, 246, 0.08)' : 'transparent',
                }}
              >
                <div style={{ color: '#6b7280' }}>{field.label}</div>
                {field.render}
              </div>
            )}
          />
        </div>
      </div>
    </div>
  );
}
