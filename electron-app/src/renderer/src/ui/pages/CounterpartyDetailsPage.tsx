import React, { useEffect, useRef, useState } from 'react';

import { CardActionBar } from '../components/CardActionBar.js';
import type { CardCloseActions } from '../cardCloseTypes.js';
import { Input } from '../components/Input.js';
import { AttachmentsPanel } from '../components/AttachmentsPanel.js';
import { DraggableFieldList } from '../components/DraggableFieldList.js';
import { SectionCard } from '../components/SectionCard.js';
import { ensureAttributeDefs, orderFieldsByDefs, persistFieldOrder, type AttributeDefRow } from '../utils/fieldOrder.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';

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
  onClose: () => void;
  registerCardCloseActions?: (actions: CardCloseActions | null) => void;
  requestClose?: () => void;
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
  const dirtyRef = useRef(false);

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
      dirtyRef.current = false;
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  useEffect(() => {
    void load();
  }, [props.counterpartyId]);

  useLiveDataRefresh(
    async () => {
      if (dirtyRef.current) return;
      await load();
    },
    { intervalMs: 20000 },
  );

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
    dirtyRef.current = false;
  }, [entity?.id, entity?.updatedAt]);

  useEffect(() => {
    if (!props.registerCardCloseActions) return;
    props.registerCardCloseActions({
      isDirty: () => dirtyRef.current,
      saveAndClose: async () => {
        await saveAllAndClose();
      },
      reset: async () => {
        await load();
        dirtyRef.current = false;
      },
      closeWithoutSave: () => {
        dirtyRef.current = false;
      },
      copyToNew: async () => {
        if (!typeId) return;
        const created = await window.matrica.admin.entities.create(typeId);
        if (created?.ok && 'id' in created) {
          await window.matrica.admin.entities.setAttr(created.id, 'name', name.trim() + ' (копия)');
          await window.matrica.admin.entities.setAttr(created.id, 'inn', inn.trim() || null);
          await window.matrica.admin.entities.setAttr(created.id, 'kpp', kpp.trim() || null);
          await window.matrica.admin.entities.setAttr(created.id, 'address', address.trim() || null);
          await window.matrica.admin.entities.setAttr(created.id, 'phone', phone.trim() || null);
          await window.matrica.admin.entities.setAttr(created.id, 'email', email.trim() || null);
        }
      },
    });
    return () => { props.registerCardCloseActions?.(null); };
  }, [name, inn, kpp, address, phone, email, typeId, props.registerCardCloseActions]);

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

  async function saveAllAndClose() {
    if (props.canEdit) {
      await saveAttr('name', name.trim());
      await saveAttr('inn', inn.trim() || null);
      await saveAttr('kpp', kpp.trim() || null);
      await saveAttr('address', address.trim() || null);
      await saveAttr('phone', phone.trim() || null);
      await saveAttr('email', email.trim() || null);
      await saveAttr('attachments', attachments);
    }
    dirtyRef.current = false;
  }

  async function handleDelete() {
    if (!props.canEdit) return;
    if (!confirm('Удалить контрагента?')) return;
    try {
      setStatus('Удаление…');
      const r = await window.matrica.admin.entities.softDelete(props.counterpartyId);
      if (!r?.ok) {
        setStatus(`Ошибка: ${r?.error ?? 'unknown'}`);
        return;
      }
      setStatus('Удалено');
      setTimeout(() => setStatus(''), 900);
      props.onClose();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  if (!entity) {
    return <div>{status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div>}</div>;
  }

  const mainFields = orderFieldsByDefs(
    [
      {
        code: 'name',
        defaultOrder: 10,
        label: 'Название',
        value: name,
        render: (
          <Input value={name} disabled={!props.canEdit} onChange={(e) => { setName(e.target.value); dirtyRef.current = true; }} />
        ),
      },
      {
        code: 'inn',
        defaultOrder: 20,
        label: 'ИНН',
        value: inn,
        render: (
          <Input value={inn} disabled={!props.canEdit} onChange={(e) => { setInn(e.target.value); dirtyRef.current = true; }} />
        ),
      },
      {
        code: 'kpp',
        defaultOrder: 30,
        label: 'КПП',
        value: kpp,
        render: (
          <Input value={kpp} disabled={!props.canEdit} onChange={(e) => { setKpp(e.target.value); dirtyRef.current = true; }} />
        ),
      },
      {
        code: 'address',
        defaultOrder: 40,
        label: 'Адрес',
        value: address,
        render: (
          <Input value={address} disabled={!props.canEdit} onChange={(e) => { setAddress(e.target.value); dirtyRef.current = true; }} />
        ),
      },
      {
        code: 'phone',
        defaultOrder: 50,
        label: 'Телефон',
        value: phone,
        render: (
          <Input value={phone} disabled={!props.canEdit} onChange={(e) => { setPhone(e.target.value); dirtyRef.current = true; }} />
        ),
      },
      {
        code: 'email',
        defaultOrder: 60,
        label: 'Email',
        value: email,
        render: (
          <Input value={email} disabled={!props.canEdit} onChange={(e) => { setEmail(e.target.value); dirtyRef.current = true; }} />
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
            onChange={(next) => {
              dirtyRef.current = true;
              setAttachments(next);
              return Promise.resolve({ ok: true as const });
            }}
          />
        ),
      },
    ],
    defs,
  );

  const headerTitle = name.trim() ? name.trim() : 'Карточка контрагента';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ flexShrink: 0, borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
        <CardActionBar
          canEdit={props.canEdit}
          onCopyToNew={() => {
            void (async () => {
              if (!typeId) return;
              const created = await window.matrica.admin.entities.create(typeId);
              if (created?.ok && 'id' in created) {
                await window.matrica.admin.entities.setAttr(created.id, 'name', name.trim() + ' (копия)');
                await window.matrica.admin.entities.setAttr(created.id, 'inn', inn.trim() || null);
                await window.matrica.admin.entities.setAttr(created.id, 'kpp', kpp.trim() || null);
                await window.matrica.admin.entities.setAttr(created.id, 'address', address.trim() || null);
                await window.matrica.admin.entities.setAttr(created.id, 'phone', phone.trim() || null);
                await window.matrica.admin.entities.setAttr(created.id, 'email', email.trim() || null);
              }
            })();
          }}
          onSaveAndClose={() => { void saveAllAndClose().then(() => props.onClose()); }}
          onReset={() => {
            void load().then(() => {
              dirtyRef.current = false;
            });
          }}
          onCloseWithoutSave={() => { dirtyRef.current = false; props.onClose(); }}
          onDelete={() => void handleDelete()}
          onClose={() => props.requestClose?.()}
        />
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: 20, fontWeight: 800 }}>{headerTitle}</div>
        <div style={{ flex: 1 }} />
        {status && <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)', fontSize: 12 }}>{status}</div>}
      </div>

      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', paddingTop: 12 }}>
        <SectionCard style={{ padding: 12 }}>
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
            renderItem={(field, itemProps, _dragHandleProps, state) => (
              <div
                {...itemProps}
                className="card-row"
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(160px, 200px) 1fr',
                  gap: 8,
                  alignItems: 'center',
                  padding: '4px 6px',
                  border: state.isOver ? '1px dashed var(--input-border-focus)' : '1px solid var(--card-row-border)',
                  background: state.isDragging ? 'var(--card-row-drag-bg)' : undefined,
                }}
              >
                <div style={{ color: 'var(--subtle)' }}>{field.label}</div>
                {field.render}
              </div>
            )}
          />
        </SectionCard>
      </div>
    </div>
  );
}
