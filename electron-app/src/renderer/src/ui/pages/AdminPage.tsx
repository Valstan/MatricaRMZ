import React, { useEffect, useMemo, useState } from 'react';

import type { IncomingLinkInfo } from '@matricarmz/shared';

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

export function AdminPage(props: {
  permissions: Record<string, boolean>;
  canViewMasterData: boolean;
  canEditMasterData: boolean;
  canManageUsers: boolean;
}) {
  const canManageUsers = props.canManageUsers;

  const [types, setTypes] = useState<EntityTypeRow[]>([]);
  const [selectedTypeId, setSelectedTypeId] = useState<string>('');
  const [typeQuery, setTypeQuery] = useState<string>('');
  const [defs, setDefs] = useState<AttrDefRow[]>([]);
  const [entities, setEntities] = useState<EntityRow[]>([]);
  const [selectedEntityId, setSelectedEntityId] = useState<string>('');
  const [entityQuery, setEntityQuery] = useState<string>('');
  const [entityAttrs, setEntityAttrs] = useState<Record<string, unknown>>({});
  const [status, setStatus] = useState<string>('');

  const [deleteDialog, setDeleteDialog] = useState<
    | {
        open: true;
        entityId: string;
        entityLabel: string;
        loading: boolean;
        error: string | null;
        links: IncomingLinkInfo[] | null;
      }
    | { open: false }
  >({ open: false });

  const [incomingLinks, setIncomingLinks] = useState<{ loading: boolean; error: string | null; links: IncomingLinkInfo[] }>({
    loading: false,
    error: null,
    links: [],
  });

  // Users admin state
  const [users, setUsers] = useState<{ id: string; username: string; role: string; isActive: boolean }[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [userPerms, setUserPerms] = useState<{ base: Record<string, boolean>; overrides: Record<string, boolean>; effective: Record<string, boolean> } | null>(
    null,
  );
  const [delegations, setDelegations] = useState<
    {
      id: string;
      fromUserId: string;
      toUserId: string;
      permCode: string;
      startsAt: number;
      endsAt: number;
      note: string | null;
      createdAt: number;
      createdByUserId: string;
      revokedAt: number | null;
      revokedByUserId: string | null;
      revokeNote: string | null;
    }[]
  >([]);
  const [newDelegation, setNewDelegation] = useState<{ fromUserId: string; permCode: string; endsAt: string; note: string }>({
    fromUserId: '',
    permCode: 'supply_requests.sign',
    endsAt: '',
    note: '',
  });
  const [newUser, setNewUser] = useState<{ username: string; password: string; role: string }>({ username: '', password: '', role: 'user' });
  const [resetPassword, setResetPassword] = useState<string>('');

  const selectedType = useMemo(() => types.find((t) => t.id === selectedTypeId) ?? null, [types, selectedTypeId]);
  const selectedEntity = useMemo(() => entities.find((e) => e.id === selectedEntityId) ?? null, [entities, selectedEntityId]);

  const filteredTypes = useMemo(() => {
    const q = typeQuery.trim().toLowerCase();
    if (!q) return types;
    return types.filter((t) => `${t.name} ${t.code}`.toLowerCase().includes(q));
  }, [types, typeQuery]);

  const filteredEntities = useMemo(() => {
    const q = entityQuery.trim().toLowerCase();
    if (!q) return entities;
    return entities.filter((e) => {
      const label = (e.displayName ? `${e.displayName} ` : '') + e.id;
      return label.toLowerCase().includes(q);
    });
  }, [entities, entityQuery]);

  const linkTargetByCode: Record<string, string> = {
    customer_id: 'customer',
    contract_id: 'contract',
    work_order_id: 'work_order',
    workshop_id: 'workshop',
    section_id: 'section',
  };

  function safeParseMetaJson(metaJson: string | null): any | null {
    if (!metaJson) return null;
    try {
      return JSON.parse(metaJson);
    } catch {
      return null;
    }
  }

  function getLinkTargetTypeCode(def: AttrDefRow): string | null {
    const meta = safeParseMetaJson(def.metaJson);
    const fromMeta = meta?.linkTargetTypeCode;
    if (typeof fromMeta === 'string' && fromMeta.trim()) return fromMeta.trim();
    return linkTargetByCode[def.code] ?? null;
  }

  function formatDefDataType(def: AttrDefRow): string {
    if (def.dataType !== 'link') return def.dataType;
    const targetCode = getLinkTargetTypeCode(def);
    if (!targetCode) return 'link';
    const t = types.find((x) => x.code === targetCode);
    return `link → ${t ? t.name : targetCode}`;
  }

  const [linkOptions, setLinkOptions] = useState<Record<string, { id: string; label: string }[]>>({});

  const outgoingLinks = useMemo(() => {
    const linkDefs = defs.filter((d) => d.dataType === 'link');
    return linkDefs.map((d) => {
      const targetTypeCode = getLinkTargetTypeCode(d);
      const targetType = targetTypeCode ? types.find((t) => t.code === targetTypeCode) ?? null : null;
      const targetTypeName = targetType?.name ?? (targetTypeCode ?? '—');
      const raw = entityAttrs[d.code];
      const targetEntityId = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
      const opt = targetEntityId ? (linkOptions[d.code] ?? []).find((x) => x.id === targetEntityId) ?? null : null;
      return {
        defId: d.id,
        attributeCode: d.code,
        attributeName: d.name,
        targetTypeId: targetType?.id ?? null,
        targetTypeName,
        targetEntityId,
        targetEntityLabel: opt?.label ?? null,
      };
    });
  }, [defs, entityAttrs, linkOptions, types]);

  async function refreshTypes() {
    const rows = await window.matrica.admin.entityTypes.list();
    setTypes(rows);
    if (!selectedTypeId && rows[0]) setSelectedTypeId(rows[0].id);
  }

  async function refreshDefs(typeId: string) {
    const rows = await window.matrica.admin.attributeDefs.listByEntityType(typeId);
    setDefs(rows);
  }

  async function refreshEntities(typeId: string, opts?: { selectId?: string }) {
    const rows = await window.matrica.admin.entities.listByEntityType(typeId);
    setEntities(rows as any);
    const desired = opts?.selectId ?? selectedEntityId;
    if (desired && rows.find((r) => r.id === desired)) setSelectedEntityId(desired);
    else setSelectedEntityId(rows[0]?.id ?? '');
  }

  function closeDeleteDialog() {
    setDeleteDialog({ open: false });
  }

  async function openDeleteDialog(entityId: string) {
    const label =
      entities.find((e) => e.id === entityId)?.displayName ??
      (entityId ? entityId.slice(0, 8) : '');

    setDeleteDialog({ open: true, entityId, entityLabel: label, loading: true, error: null, links: null });
    const r = await window.matrica.admin.entities.deleteInfo(entityId).catch((e) => ({ ok: false as const, error: String(e) }));
    if (!r.ok) {
      setDeleteDialog({ open: true, entityId, entityLabel: label, loading: false, error: r.error ?? 'unknown', links: [] });
      return;
    }
    setDeleteDialog({ open: true, entityId, entityLabel: label, loading: false, error: null, links: r.links ?? [] });
  }

  async function doSoftDelete(entityId: string) {
    setDeleteDialog((p) => (p.open ? { ...p, loading: true, error: null } : p));
    setStatus('Удаление...');
    const r = await window.matrica.admin.entities.softDelete(entityId);
    if (!r.ok) {
      setDeleteDialog((p) => (p.open ? { ...p, error: r.error ?? 'unknown' } : p));
      setStatus(`Ошибка: ${r.error ?? 'unknown'}`);
      setDeleteDialog((p) => (p.open ? { ...p, loading: false } : p));
      return;
    }
    setStatus('Удалено');
    if (selectedTypeId) await refreshEntities(selectedTypeId);
    setSelectedEntityId('');
    setEntityAttrs({});
    closeDeleteDialog();
  }

  async function doDetachAndDelete(entityId: string) {
    setDeleteDialog((p) => (p.open ? { ...p, loading: true, error: null } : p));
    setStatus('Удаление (отвязываем связи)...');
    const r = await window.matrica.admin.entities.detachLinksAndDelete(entityId);
    if (!r.ok) {
      setDeleteDialog((p) => (p.open ? { ...p, error: r.error ?? 'unknown' } : p));
      setStatus(`Ошибка: ${r.error ?? 'unknown'}`);
      setDeleteDialog((p) => (p.open ? { ...p, loading: false } : p));
      return;
    }
    setStatus(`Удалено (отвязано: ${r.detached ?? 0})`);
    if (selectedTypeId) await refreshEntities(selectedTypeId);
    setSelectedEntityId('');
    setEntityAttrs({});
    closeDeleteDialog();
  }

  async function loadEntity(id: string) {
    const d = await window.matrica.admin.entities.get(id);
    setEntityAttrs(d.attributes ?? {});
  }

  async function refreshIncomingLinks(entityId: string) {
    setIncomingLinks((p) => ({ ...p, loading: true, error: null }));
    const r = await window.matrica.admin.entities.deleteInfo(entityId).catch((e) => ({ ok: false as const, error: String(e) }));
    if (!r.ok) {
      setIncomingLinks({ loading: false, error: r.error ?? 'unknown', links: [] });
      return;
    }
    setIncomingLinks({ loading: false, error: null, links: r.links ?? [] });
  }

  async function jumpToEntity(typeId: string, entityId: string) {
    setSelectedTypeId(typeId);
    await refreshDefs(typeId);
    await refreshEntities(typeId, { selectId: entityId });
    setSelectedEntityId(entityId);
  }

  async function refreshLinkOptions(defsForType: AttrDefRow[]) {
    // Для link полей подгружаем списки записей целевого типа.
    const map: Record<string, { id: string; label: string }[]> = {};
    for (const d of defsForType) {
      if (d.dataType !== 'link') continue;
      const targetCode = getLinkTargetTypeCode(d);
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
    void loadEntity(selectedEntityId);
    void refreshIncomingLinks(selectedEntityId);
  }, [selectedEntityId]);

  useEffect(() => {
    if (!selectedTypeId) return;
    void refreshLinkOptions(defs);
  }, [selectedTypeId, defs, types]);

  async function refreshUsers() {
    const r = await window.matrica.admin.users.list();
    if (!r.ok) {
      setStatus(`Ошибка users.list: ${r.error}`);
      return;
    }
    setUsers(r.users);
    if (!selectedUserId && r.users[0]) setSelectedUserId(r.users[0].id);
  }

  async function openUser(userId: string) {
    setSelectedUserId(userId);
    const r = await window.matrica.admin.users.permissionsGet(userId);
    if (!r.ok) {
      setStatus(`Ошибка perms.get: ${r.error}`);
      setUserPerms(null);
      return;
    }
    setUserPerms({ base: r.base, overrides: r.overrides, effective: r.effective });

    const d = await window.matrica.admin.users.delegationsList(userId);
    if (d.ok) setDelegations(d.delegations);
    else setDelegations([]);
  }

  useEffect(() => {
    if (!canManageUsers) return;
    void refreshUsers();
  }, [canManageUsers]);

  useEffect(() => {
    if (!canManageUsers || !selectedUserId) return;
    void openUser(selectedUserId);
  }, [canManageUsers, selectedUserId]);

  return (
    <div>
      <h2 style={{ margin: '8px 0' }}>Справочники</h2>
      <div style={{ color: '#6b7280', marginBottom: 12 }}>
        {props.canViewMasterData
          ? 'Здесь можно настраивать номенклатуру и свойства (для расширения системы без миграций).'
          : 'У вас нет доступа к мастер-данным. Доступен только раздел управления пользователями/правами (если есть права).'}
      </div>

      {props.canViewMasterData && (
      <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr 1fr', gap: 12 }}>
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <strong>Номенклатура</strong>
            <span style={{ flex: 1 }} />
            <Button variant="ghost" onClick={() => void refreshTypes()}>
              Обновить
            </Button>
          </div>

          <div style={{ marginTop: 10 }}>
            <Input value={typeQuery} onChange={(e) => setTypeQuery(e.target.value)} placeholder="Поиск номенклатуры…" />

            <div
              style={{
                marginTop: 8,
                border: '1px solid #f3f4f6',
                borderRadius: 12,
                overflow: 'hidden',
              }}
            >
              <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                {filteredTypes.map((t) => {
                  const active = t.id === selectedTypeId;
                  return (
                    <div
                      key={t.id}
                      onClick={() => setSelectedTypeId(t.id)}
                      style={{
                        padding: '10px 12px',
                        cursor: 'pointer',
                        borderBottom: '1px solid #f3f4f6',
                        background: active ? '#eef2ff' : '#fff',
                      }}
                      title={t.code}
                    >
                      <div style={{ fontWeight: 800, color: '#111827', lineHeight: 1.2 }}>{t.name}</div>
                    </div>
                  );
                })}

                {filteredTypes.length === 0 && <div style={{ padding: 12, color: '#6b7280' }}>(пусто)</div>}
              </div>
            </div>
          </div>

          {props.canEditMasterData && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>Добавить раздел</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
              <NewEntityTypeForm
                existingCodes={types.map((t) => t.code)}
                onSubmit={async (code, name) => {
                  setStatus('Сохранение раздела...');
                  const r = await window.matrica.admin.entityTypes.upsert({ code, name });
                  setStatus(r.ok ? 'Раздел сохранён' : `Ошибка: ${r.error ?? 'unknown'}`);
                  await refreshTypes();
                  if (r.ok && r.id) setSelectedTypeId(String(r.id));
                }}
              />
            </div>
          </div>
          )}
        </div>

        <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <strong>{selectedType ? `Свойства ${selectedType.name}` : 'Свойства'}</strong>
            <span style={{ flex: 1 }} />
            <Button variant="ghost" onClick={() => selectedTypeId && void refreshDefs(selectedTypeId)}>
              Обновить
            </Button>
          </div>

          <div style={{ marginTop: 12 }}>
            {selectedTypeId ? (
              <>
                {props.canEditMasterData && (
                <NewAttrDefForm
                  entityTypeId={selectedTypeId}
                  types={types}
                  onSubmit={async (payload) => {
                    setStatus('Сохранение свойства...');
                    const r = await window.matrica.admin.attributeDefs.upsert(payload);
                    setStatus(r.ok ? 'Свойство сохранено' : `Ошибка: ${r.error ?? 'unknown'}`);
                    await refreshDefs(selectedTypeId);
                  }}
                />
                )}
                <div style={{ marginTop: 12, border: '1px solid #f3f4f6', borderRadius: 12, overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: 'linear-gradient(135deg, #db2777 0%, #9d174d 120%)', color: '#fff' }}>
                        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Код</th>
                        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Название</th>
                        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Тип</th>
                        <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Обяз.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {defs.map((d) => (
                        <tr key={d.id}>
                          <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{d.code}</td>
                          <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{d.name}</td>
                          <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{formatDefDataType(d)}</td>
                          <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{d.isRequired ? 'да' : 'нет'}</td>
                        </tr>
                      ))}
                      {defs.length === 0 && (
                        <tr>
                          <td style={{ padding: 12, color: '#6b7280' }} colSpan={4}>
                            Свойств нет
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <div style={{ color: '#6b7280' }}>Выберите раздел номенклатуры</div>
            )}
          </div>
        </div>

        <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <strong>{selectedType ? `Список ${selectedType.name}` : 'Список'}</strong>
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
            <div style={{ marginTop: 12, color: '#6b7280' }}>Выберите раздел номенклатуры</div>
          ) : (
            <>
              <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
                {props.canEditMasterData && (
                  <>
                <Button
                  onClick={async () => {
                    setStatus('Создание записи...');
                    const r = await window.matrica.admin.entities.create(selectedTypeId);
                    if (!r.ok) {
                      setStatus(`Ошибка: ${r.error}`);
                      return;
                    }
                    setStatus('Запись создана');
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
                    await openDeleteDialog(selectedEntityId);
                  }}
                >
                  Удалить
                </Button>
                  </>
                )}
                <span style={{ flex: 1 }} />
                <div style={{ color: '#6b7280', fontSize: 12 }}>
                  {selectedEntity ? 'Выбрано' : 'Всего'}: {selectedEntity ? selectedEntity.displayName ?? selectedEntity.id.slice(0, 8) : entities.length}
                </div>
              </div>

              <div style={{ marginTop: 10 }}>
                <Input value={entityQuery} onChange={(e) => setEntityQuery(e.target.value)} placeholder="Поиск записей…" />

                <div style={{ marginTop: 8, border: '1px solid #f3f4f6', borderRadius: 12, overflow: 'hidden' }}>
                  <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                    {filteredEntities.map((e) => {
                      const active = e.id === selectedEntityId;
                      return (
                        <div
                          key={e.id}
                          onClick={() => setSelectedEntityId(e.id)}
                          style={{
                            padding: '10px 12px',
                            cursor: 'pointer',
                            borderBottom: '1px solid #f3f4f6',
                            background: active ? '#ecfeff' : '#fff',
                          }}
                          title={e.id}
                        >
                          <div style={{ fontWeight: 700, color: '#111827', lineHeight: 1.2 }}>
                            {e.displayName ?? e.id.slice(0, 8)}
                          </div>
                          <div style={{ marginTop: 2, fontSize: 12, color: '#6b7280' }}>
                            <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{e.id.slice(0, 8)}</span>
                            {'  '}| sync: <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{e.syncStatus}</span>
                          </div>
                        </div>
                      );
                    })}

                    {filteredEntities.length === 0 && <div style={{ padding: 12, color: '#6b7280' }}>(пусто)</div>}
                  </div>
                </div>
              </div>

              {selectedEntity ? (
                <div style={{ marginTop: 12, border: '1px solid #f3f4f6', borderRadius: 12, padding: 12 }}>
                  <div style={{ color: '#6b7280', fontSize: 12, marginBottom: 8 }}>
                    {props.canEditMasterData ? 'Редактирование свойств' : 'Свойства (только просмотр)'}
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 10, alignItems: 'center' }}>
                    {defs.map((d) => (
                      <React.Fragment key={d.id}>
                        <div style={{ color: '#6b7280' }}>{d.name}</div>
                        <FieldEditor
                          def={d}
                          canEdit={props.canEditMasterData}
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

                  <div style={{ marginTop: 14, borderTop: '1px solid #f3f4f6', paddingTop: 12 }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <strong>Связи</strong>
                      <span style={{ flex: 1 }} />
                      <Button
                        variant="ghost"
                        onClick={() => {
                          if (selectedEntityId) void refreshIncomingLinks(selectedEntityId);
                        }}
                      >
                        Обновить
                      </Button>
                    </div>

                    <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                      <div style={{ border: '1px solid #f3f4f6', borderRadius: 12, padding: 12 }}>
                        <div style={{ fontWeight: 800, marginBottom: 8 }}>Исходящие</div>
                        {outgoingLinks.length === 0 ? (
                          <div style={{ color: '#6b7280' }}>В этом разделе нет связанных полей.</div>
                        ) : (
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
                            {outgoingLinks.map((l) => (
                              <div key={l.defId} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                                <div style={{ flex: 1 }}>
                                  <div style={{ color: '#111827', fontWeight: 700 }}>{l.attributeName}</div>
                                  <div style={{ fontSize: 12, color: '#6b7280' }}>
                                    → {l.targetTypeName}
                                    {l.targetEntityId ? (
                                      <>
                                        {' '}
                                        | <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{l.targetEntityId.slice(0, 8)}</span>
                                        {l.targetEntityLabel ? ` — ${l.targetEntityLabel}` : ''}
                                      </>
                                    ) : (
                                      ' | (не выбрано)'
                                    )}
                                  </div>
                                </div>
                                <Button
                                  variant="ghost"
                                  disabled={!l.targetTypeId || !l.targetEntityId}
                                  onClick={() => {
                                    if (!l.targetTypeId || !l.targetEntityId) return;
                                    void jumpToEntity(l.targetTypeId, l.targetEntityId);
                                  }}
                                >
                                  Перейти
                                </Button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <div style={{ border: '1px solid #f3f4f6', borderRadius: 12, padding: 12 }}>
                        <div style={{ fontWeight: 800, marginBottom: 8 }}>Входящие</div>
                        {incomingLinks.loading ? (
                          <div style={{ color: '#6b7280' }}>Загрузка…</div>
                        ) : incomingLinks.error ? (
                          <div style={{ color: '#b91c1c' }}>Ошибка: {incomingLinks.error}</div>
                        ) : incomingLinks.links.length === 0 ? (
                          <div style={{ color: '#6b7280' }}>Никто не ссылается на эту запись.</div>
                        ) : (
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
                            {incomingLinks.links.map((l, idx) => (
                              <div key={`${l.fromEntityId}:${l.attributeDefId}:${idx}`} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                                <div style={{ flex: 1 }}>
                                  <div style={{ fontWeight: 700, color: '#111827' }}>
                                    {l.fromEntityTypeName}: {l.fromEntityDisplayName ?? l.fromEntityId.slice(0, 8)}
                                  </div>
                                  <div style={{ fontSize: 12, color: '#6b7280' }}>
                                    по свойству “{l.attributeName}” |{' '}
                                    <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{l.fromEntityId.slice(0, 8)}</span>
                                  </div>
                                </div>
                                <Button
                                  variant="ghost"
                                  onClick={() => {
                                    void jumpToEntity(l.fromEntityTypeId, l.fromEntityId);
                                  }}
                                >
                                  Перейти
                                </Button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ marginTop: 12, color: '#6b7280' }}>Выберите запись</div>
              )}
            </>
          )}
        </div>
      </div>
      )}

      {canManageUsers && (
        <div style={{ marginTop: 12, border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <strong>Пользователи и права доступа</strong>
            <span style={{ flex: 1 }} />
            <Button variant="ghost" onClick={() => void refreshUsers()}>
              Обновить
            </Button>
          </div>

          <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '360px 1fr', gap: 12 }}>
            <div style={{ border: '1px solid #f3f4f6', borderRadius: 12, padding: 12 }}>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>Создать пользователя</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <Input value={newUser.username} onChange={(e) => setNewUser((p) => ({ ...p, username: e.target.value }))} placeholder="логин" />
                <Input
                  value={newUser.password}
                  onChange={(e) => setNewUser((p) => ({ ...p, password: e.target.value }))}
                  placeholder="пароль"
                />
                <select
                  value={newUser.role}
                  onChange={(e) => setNewUser((p) => ({ ...p, role: e.target.value }))}
                  style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
                >
                  <option value="user">user</option>
                  <option value="admin">admin</option>
                </select>
                <Button
                  onClick={async () => {
                    setStatus('Создание пользователя...');
                    const r = await window.matrica.admin.users.create(newUser);
                    setStatus(r.ok ? 'Пользователь создан' : `Ошибка: ${r.error ?? 'unknown'}`);
                    if (r.ok) {
                      setNewUser({ username: '', password: '', role: 'user' });
                      await refreshUsers();
                      setSelectedUserId(r.id);
                    }
                  }}
                >
                  Создать
                </Button>
              </div>

              <div style={{ marginTop: 12, fontSize: 12, color: '#6b7280', marginBottom: 6 }}>Выбрать пользователя</div>
              <select
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
              >
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.username} ({u.role}) {u.isActive ? '' : '[disabled]'}
                  </option>
                ))}
                {users.length === 0 && <option value="">(пусто)</option>}
              </select>
            </div>

            <div style={{ border: '1px solid #f3f4f6', borderRadius: 12, padding: 12 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <strong>Права</strong>
                <span style={{ flex: 1 }} />
                <Button
                  variant="ghost"
                  onClick={() => {
                    if (selectedUserId) void openUser(selectedUserId);
                  }}
                >
                  Обновить
                </Button>
              </div>

              {selectedUserId && (
                <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center' }}>
                  <select
                    value={users.find((u) => u.id === selectedUserId)?.role ?? 'user'}
                    onChange={async (e) => {
                      const role = e.target.value;
                      setStatus('Обновление роли...');
                      const r = await window.matrica.admin.users.update(selectedUserId, { role });
                      setStatus(r.ok ? 'Роль обновлена' : `Ошибка: ${r.error ?? 'unknown'}`);
                      await refreshUsers();
                      await openUser(selectedUserId);
                    }}
                    style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
                  >
                    <option value="user">user</option>
                    <option value="admin">admin</option>
                  </select>

                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: '#111827', fontSize: 14 }}>
                    <input
                      type="checkbox"
                      checked={users.find((u) => u.id === selectedUserId)?.isActive ?? true}
                      onChange={async (e) => {
                        setStatus('Обновление активности...');
                        const r = await window.matrica.admin.users.update(selectedUserId, { isActive: e.target.checked });
                        setStatus(r.ok ? 'Активность обновлена' : `Ошибка: ${r.error ?? 'unknown'}`);
                        await refreshUsers();
                      }}
                    />
                    активен
                  </label>

                  <Input
                    value={resetPassword}
                    onChange={(e) => setResetPassword(e.target.value)}
                    placeholder="новый пароль (опц.)"
                  />
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      if (!resetPassword.trim()) return;
                      setStatus('Смена пароля...');
                      const r = await window.matrica.admin.users.update(selectedUserId, { password: resetPassword });
                      setStatus(r.ok ? 'Пароль обновлён' : `Ошибка: ${r.error ?? 'unknown'}`);
                      setResetPassword('');
                    }}
                  >
                    Сменить пароль
                  </Button>
                </div>
              )}

              {!userPerms ? (
                <div style={{ marginTop: 12, color: '#6b7280' }}>Выберите пользователя</div>
              ) : (
                <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 120px', gap: 10, alignItems: 'center' }}>
                  {Object.keys(userPerms.effective)
                    .sort()
                    .map((code) => {
                      const effective = userPerms.effective[code] === true;
                      const override = code in userPerms.overrides ? userPerms.overrides[code] : null;
                      return (
                        <React.Fragment key={code}>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}>{code}</span>
                            {override !== null && (
                              <span style={{ fontSize: 12, color: '#6b7280' }}>(override)</span>
                            )}
                          </div>
                          <label style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end' }}>
                            <input
                              type="checkbox"
                              checked={effective}
                              onChange={async (e) => {
                                const next = e.target.checked;
                                setStatus('Сохранение права...');
                                const r = await window.matrica.admin.users.permissionsSet(selectedUserId, { [code]: next });
                                setStatus(r.ok ? 'Сохранено' : `Ошибка: ${r.error ?? 'unknown'}`);
                                await openUser(selectedUserId);
                              }}
                            />
                            <span style={{ fontSize: 12, color: '#6b7280' }}>{effective ? 'on' : 'off'}</span>
                          </label>
                        </React.Fragment>
                      );
                    })}
                </div>
              )}

              {selectedUserId && (
                <div style={{ marginTop: 18 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <strong>Делегирование прав (временно)</strong>
                    <span style={{ flex: 1 }} />
                    <Button
                      variant="ghost"
                      onClick={() => {
                        if (selectedUserId) void openUser(selectedUserId);
                      }}
                    >
                      Обновить
                    </Button>
                  </div>

                  <div style={{ marginTop: 10, border: '1px solid #f3f4f6', borderRadius: 12, padding: 12 }}>
                    <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>
                      Делегировать право выбранному пользователю до даты (делегат увидит это право автоматически).
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                      <select
                        value={newDelegation.fromUserId}
                        onChange={(e) => setNewDelegation((p) => ({ ...p, fromUserId: e.target.value }))}
                        style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
                      >
                        <option value="">делегирует (пользователь)</option>
                        {users.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.username}
                          </option>
                        ))}
                      </select>
                      <Input
                        value={newDelegation.permCode}
                        onChange={(e) => setNewDelegation((p) => ({ ...p, permCode: e.target.value }))}
                        placeholder="permCode (например: supply_requests.sign)"
                      />
                      <Input
                        type="date"
                        value={newDelegation.endsAt}
                        onChange={(e) => setNewDelegation((p) => ({ ...p, endsAt: e.target.value }))}
                        placeholder="до даты"
                      />
                      <Input
                        value={newDelegation.note}
                        onChange={(e) => setNewDelegation((p) => ({ ...p, note: e.target.value }))}
                        placeholder="примечание (опц.)"
                        style={{ gridColumn: '1 / -1' }}
                      />
                      <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 10 }}>
                        <Button
                          onClick={async () => {
                            if (!selectedUserId) return;
                            if (!newDelegation.fromUserId) {
                              setStatus('Ошибка: выберите кто делегирует');
                              return;
                            }
                            if (!newDelegation.permCode.trim()) {
                              setStatus('Ошибка: permCode пустой');
                              return;
                            }
                            if (!newDelegation.endsAt) {
                              setStatus('Ошибка: укажите дату окончания');
                              return;
                            }
                            const [ys, ms, ds] = newDelegation.endsAt.split('-');
                            const y = Number(ys);
                            const m = Number(ms);
                            const d = Number(ds);
                            if (!y || !m || !d) {
                              setStatus('Ошибка: некорректная дата окончания');
                              return;
                            }
                            const endMs = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
                            setStatus('Создание делегирования...');
                            const note = newDelegation.note.trim();
                            const r = await window.matrica.admin.users.delegationCreate({
                              fromUserId: newDelegation.fromUserId,
                              toUserId: selectedUserId,
                              permCode: newDelegation.permCode.trim(),
                              endsAt: endMs,
                              ...(note ? { note } : {}),
                            });
                            setStatus(r.ok ? 'Делегирование создано' : `Ошибка: ${r.error ?? 'unknown'}`);
                            if (r.ok) {
                              setNewDelegation((p) => ({ ...p, note: '' }));
                              await openUser(selectedUserId);
                            }
                          }}
                        >
                          Делегировать
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div style={{ marginTop: 10, border: '1px solid #f3f4f6', borderRadius: 12, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ background: 'linear-gradient(135deg, #0891b2 0%, #0e7490 120%)', color: '#fff' }}>
                          <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>perm</th>
                          <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>кто → кому</th>
                          <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>срок</th>
                          <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>статус</th>
                          <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }} />
                        </tr>
                      </thead>
                      <tbody>
                        {delegations
                          .slice()
                          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
                          .map((d) => {
                            const now = Date.now();
                            const active = !d.revokedAt && d.startsAt <= now && d.endsAt > now;
                            const state = d.revokedAt ? 'отозвано' : active ? 'активно' : d.endsAt <= now ? 'истекло' : 'ожидает';
                            const fromU = users.find((u) => u.id === d.fromUserId)?.username ?? d.fromUserId;
                            const toU = users.find((u) => u.id === d.toUserId)?.username ?? d.toUserId;
                            return (
                              <tr key={d.id}>
                                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}>
                                  {d.permCode}
                                </td>
                                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{fromU} → {toU}</td>
                                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>
                                  {new Date(d.startsAt).toLocaleDateString('ru-RU')} — {new Date(d.endsAt).toLocaleDateString('ru-RU')}
                                </td>
                                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{state}</td>
                                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10, width: 140 }}>
                                  {active ? (
                                    <Button
                                      variant="ghost"
                                      onClick={async () => {
                                        setStatus('Отзыв делегирования...');
                                        const r = await window.matrica.admin.users.delegationRevoke({ id: d.id });
                                        setStatus(r.ok ? 'Отозвано' : `Ошибка: ${r.error ?? 'unknown'}`);
                                        await openUser(selectedUserId);
                                      }}
                                    >
                                      Отозвать
                                    </Button>
                                  ) : (
                                    <span style={{ color: '#6b7280', fontSize: 12 }}>—</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        {delegations.length === 0 && (
                          <tr>
                            <td style={{ padding: 12, color: '#6b7280' }} colSpan={5}>
                              Делегирований нет
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {deleteDialog.open && (
        <div
          onClick={() => {
            if (!deleteDialog.loading) closeDeleteDialog();
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            zIndex: 9999,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 760,
              maxWidth: '100%',
              maxHeight: '90vh',
              overflow: 'auto',
              background: '#fff',
              borderRadius: 16,
              border: '1px solid rgba(255,255,255,0.25)',
              boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
              padding: 16,
            }}
          >
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <div style={{ fontWeight: 800, fontSize: 16, color: '#111827' }}>Удалить запись</div>
              <span style={{ flex: 1 }} />
              <Button variant="ghost" onClick={closeDeleteDialog} disabled={deleteDialog.loading}>
                Закрыть
              </Button>
            </div>

            <div style={{ marginTop: 8, color: '#6b7280', fontSize: 12 }}>
              Запись: <span style={{ fontWeight: 700, color: '#111827' }}>{deleteDialog.entityLabel}</span>{' '}
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>({deleteDialog.entityId.slice(0, 8)})</span>
            </div>

            {deleteDialog.loading ? (
              <div style={{ marginTop: 12, color: '#6b7280' }}>Проверяем связи…</div>
            ) : (
              <>
                {deleteDialog.links && deleteDialog.links.length > 0 ? (
                  <>
                    <div style={{ marginTop: 12, padding: 10, borderRadius: 12, background: '#fff7ed', color: '#9a3412' }}>
                      Нельзя удалить без действий: запись связана с другими. Можно <strong>отвязать связи</strong> и удалить.
                    </div>

                    <div style={{ marginTop: 12, border: '1px solid #f3f4f6', borderRadius: 12, overflow: 'hidden' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr style={{ background: 'linear-gradient(135deg, #f97316 0%, #ea580c 120%)', color: '#fff' }}>
                            <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)' }}>Тип</th>
                            <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)' }}>Запись</th>
                            <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid rgba(255,255,255,0.25)' }}>Свойство</th>
                          </tr>
                        </thead>
                        <tbody>
                          {deleteDialog.links.map((l, idx) => (
                            <tr key={`${l.fromEntityId}:${l.attributeDefId}:${idx}`}>
                              <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{l.fromEntityTypeName}</td>
                              <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>
                                <div style={{ fontWeight: 700, color: '#111827' }}>{l.fromEntityDisplayName ?? l.fromEntityId.slice(0, 8)}</div>
                                <div style={{ fontSize: 12, color: '#6b7280', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                                  {l.fromEntityId.slice(0, 8)}
                                </div>
                              </td>
                              <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{l.attributeName}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : (
                  <div style={{ marginTop: 12, padding: 10, borderRadius: 12, background: '#ecfeff', color: '#155e75' }}>
                    Связей не найдено. Можно удалить запись.
                  </div>
                )}

                {deleteDialog.error && (
                  <div style={{ marginTop: 12, padding: 10, borderRadius: 12, background: '#fee2e2', color: '#991b1b' }}>
                    Ошибка: {deleteDialog.error}
                  </div>
                )}

                <div style={{ marginTop: 12, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <Button variant="ghost" onClick={closeDeleteDialog} disabled={deleteDialog.loading}>
                    Отмена
                  </Button>
                  {deleteDialog.links && deleteDialog.links.length > 0 ? (
                    <Button
                      onClick={() => void doDetachAndDelete(deleteDialog.entityId)}
                      disabled={deleteDialog.loading}
                      style={{ background: '#b91c1c', border: '1px solid #991b1b' }}
                    >
                      Отвязать и удалить
                    </Button>
                  ) : (
                    <Button
                      onClick={() => void doSoftDelete(deleteDialog.entityId)}
                      disabled={deleteDialog.loading}
                      style={{ background: '#b91c1c', border: '1px solid #991b1b' }}
                    >
                      Удалить
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {status && <div style={{ marginTop: 12, color: '#6b7280' }}>{status}</div>}
    </div>
  );
}

function NewEntityTypeForm(props: { existingCodes: string[]; onSubmit: (code: string, name: string) => Promise<void> }) {
  const [name, setName] = useState('');

  function normalizeForMatch(s: string) {
    return String(s ?? '').trim().toLowerCase();
  }

  function translitRuToLat(s: string): string {
    const map: Record<string, string> = {
      а: 'a',
      б: 'b',
      в: 'v',
      г: 'g',
      д: 'd',
      е: 'e',
      ё: 'e',
      ж: 'zh',
      з: 'z',
      и: 'i',
      й: 'y',
      к: 'k',
      л: 'l',
      м: 'm',
      н: 'n',
      о: 'o',
      п: 'p',
      р: 'r',
      с: 's',
      т: 't',
      у: 'u',
      ф: 'f',
      х: 'h',
      ц: 'ts',
      ч: 'ch',
      ш: 'sh',
      щ: 'sch',
      ъ: '',
      ы: 'y',
      ь: '',
      э: 'e',
      ю: 'yu',
      я: 'ya',
    };
    const src = normalizeForMatch(s);
    let out = '';
    for (const ch of src) out += map[ch] ?? ch;
    return out;
  }

  function slugifyCode(s: string): string {
    let out = translitRuToLat(s);
    out = out.replace(/&/g, ' and ');
    out = out.replace(/[^a-z0-9]+/g, '_');
    out = out.replace(/_+/g, '_').replace(/^_+/, '').replace(/_+$/, '');
    if (!out) out = 'type';
    if (/^[0-9]/.test(out)) out = `t_${out}`;
    return out;
  }

  function suggestCode(name: string): string {
    const dict: Record<string, string> = {
      услуга: 'service',
      услуги: 'services',
      товар: 'product',
      товары: 'products',
      деталь: 'part',
      детали: 'parts',
      заказчик: 'customer',
      заказчики: 'customers',
    };
    const key = normalizeForMatch(name);
    const base = dict[key] ?? slugifyCode(name);
    const taken = new Set(props.existingCodes.map((c) => normalizeForMatch(c)));
    if (!taken.has(base)) return base;
    let i = 2;
    while (taken.has(`${base}_${i}`)) i += 1;
    return `${base}_${i}`;
  }

  const computedCode = useMemo(() => (name.trim() ? suggestCode(name) : ''), [name, props.existingCodes.join('|')]);
  return (
    <>
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="название (например: Услуга)" />
      <div style={{ gridColumn: '1 / -1', fontSize: 12, color: '#6b7280' }}>
        {computedCode ? (
          <>
            Код будет создан автоматически: <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{computedCode}</span>
          </>
        ) : (
          'Код будет создан автоматически.'
        )}
      </div>
      <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 10 }}>
        <Button
          onClick={() => {
            if (!name.trim()) return;
            const code = suggestCode(name);
            void props.onSubmit(code, name.trim());
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
  types: EntityTypeRow[];
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
  const [linkTargetTypeCode, setLinkTargetTypeCode] = useState('');

  useEffect(() => {
    if (dataType !== 'link') setLinkTargetTypeCode('');
  }, [dataType]);

  return (
    <div style={{ border: '1px solid #f3f4f6', borderRadius: 12, padding: 12 }}>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>Добавить свойство</div>
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
        {dataType === 'link' && (
          <select
            value={linkTargetTypeCode}
            onChange={(e) => setLinkTargetTypeCode(e.target.value)}
            style={{ gridColumn: '1 / -1', padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
          >
            <option value="">связь с (раздел)…</option>
            {props.types.map((t) => (
              <option key={t.id} value={t.code}>
                {t.name}
              </option>
            ))}
          </select>
        )}
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: '#111827', fontSize: 14 }}>
          <input type="checkbox" checked={isRequired} onChange={(e) => setIsRequired(e.target.checked)} />
          обязательное
        </label>
        {dataType === 'link' ? (
          <div style={{ display: 'flex', alignItems: 'center', color: '#6b7280', fontSize: 12 }}>
            target будет сохранён в metaJson как <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{`{"linkTargetTypeCode":"${linkTargetTypeCode || '...'}"}`}</span>
          </div>
        ) : (
          <Input value={metaJson} onChange={(e) => setMetaJson(e.target.value)} placeholder="metaJson (опц., JSON строка)" />
        )}
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 10 }}>
          <Button
            onClick={() => {
              if (!code.trim() || !name.trim()) return;
              if (dataType === 'link' && !linkTargetTypeCode) return;
              void props.onSubmit({
                entityTypeId: props.entityTypeId,
                code,
                name,
                dataType,
                isRequired,
                sortOrder: Number(sortOrder) || 0,
                metaJson: dataType === 'link' ? JSON.stringify({ linkTargetTypeCode }) : metaJson.trim() ? metaJson : null,
              });
              setCode('');
              setName('');
              setMetaJson('');
              setLinkTargetTypeCode('');
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
  canEdit: boolean;
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
          disabled={!props.canEdit}
          onChange={(e) => {
            if (!props.canEdit) return;
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
        disabled={!props.canEdit}
        onChange={(e) => {
          if (!props.canEdit) return;
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
        disabled={!props.canEdit}
        onChange={(e) => {
          if (!props.canEdit) return;
          props.onChange(e.target.value === '' ? null : Number(e.target.value));
        }}
        onBlur={() => {
          if (!props.canEdit) return;
          void props.onSave(props.value == null || props.value === '' ? null : Number(props.value));
        }}
        placeholder="число"
      />
    );
  }

  if (dt === 'json') {
    const s = props.value == null ? '' : JSON.stringify(props.value);
    return (
      <Input
        value={s}
        disabled={!props.canEdit}
        onChange={(e) => {
          if (!props.canEdit) return;
          props.onChange(e.target.value);
        }}
        onBlur={() => {
          if (!props.canEdit) return;
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
        disabled={!props.canEdit}
        onChange={(e) => {
          if (!props.canEdit) return;
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
      disabled={!props.canEdit}
      onChange={(e) => {
        if (!props.canEdit) return;
        props.onChange(e.target.value);
      }}
      onBlur={() => {
        if (!props.canEdit) return;
        void props.onSave(text);
      }}
      placeholder={props.def.code}
    />
  );
}


