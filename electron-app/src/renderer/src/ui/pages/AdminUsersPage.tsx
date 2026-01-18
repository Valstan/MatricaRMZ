import React, { useEffect, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { permAdminOnly, permGroupRu, permTitleRu } from '../auth/permissionCatalog.js';

export function AdminUsersPage(props: { canManageUsers: boolean; me?: { id: string; role: string; username: string } | null }) {
  const canManageUsers = props.canManageUsers;
  const me = props.me ?? null;
  const meRole = String(me?.role ?? '').toLowerCase();
  const [status, setStatus] = useState<string>('');

  const [users, setUsers] = useState<
    { id: string; username: string; login?: string; fullName?: string; role: string; isActive: boolean }[]
  >([]);
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [userPerms, setUserPerms] = useState<{
    user: { id: string; username: string; login?: string; role: string; isActive?: boolean };
    allCodes: string[];
    base: Record<string, boolean>;
    overrides: Record<string, boolean>;
    effective: Record<string, boolean>;
  } | null>(null);
  const [permQuery, setPermQuery] = useState<string>('');
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
  const [newUser, setNewUser] = useState<{ login: string; fullName: string; password: string; role: string; accessEnabled: boolean }>({
    login: '',
    fullName: '',
    password: '',
    role: 'user',
    accessEnabled: true,
  });
  const [resetPassword, setResetPassword] = useState<string>('');

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
    setUserPerms({
      user: r.user,
      allCodes: Array.isArray(r.allCodes) ? r.allCodes : Object.keys(r.effective ?? {}),
      base: r.base ?? {},
      overrides: r.overrides ?? {},
      effective: r.effective ?? {},
    });

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

  const selectedUser = users.find((u) => u.id === selectedUserId) ?? null;
  const selectedRole = String(selectedUser?.role ?? 'user').toLowerCase();
  const selectedIsSelf = !!me && selectedUserId === me.id;
  const adminLocked = meRole === 'admin' && (selectedRole === 'admin' || selectedRole === 'superadmin');
  const canEditRoleOrAccess = !selectedIsSelf && !adminLocked;
  const canEditPermissions = !selectedIsSelf && !adminLocked;
  const canEditPassword = !adminLocked;
  const canCreateAdmin = meRole === 'superadmin';

  return (
    <div>
      <h2 style={{ margin: '8px 0' }}>Админ</h2>
      <div style={{ color: '#6b7280', marginBottom: 12 }}>
        Раздел для управления пользователями, правами и доступом.
      </div>

      {!canManageUsers && (
        <div style={{ color: '#6b7280' }}>У вас нет доступа к управлению пользователями и правами.</div>
      )}

      {canManageUsers && (
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <strong>Пользователи и права доступа</strong>
            <span style={{ flex: 1 }} />
            <Button variant="ghost" onClick={() => void refreshUsers()}>
              Обновить
            </Button>
          </div>

          <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 10 }}>
            <div style={{ border: '1px solid #f3f4f6', borderRadius: 12, padding: 12 }}>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>Создать пользователя</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <Input value={newUser.login} onChange={(e) => setNewUser((p) => ({ ...p, login: e.target.value }))} placeholder="логин" />
                <Input value={newUser.fullName} onChange={(e) => setNewUser((p) => ({ ...p, fullName: e.target.value }))} placeholder="ФИО (опц.)" />
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
                  <option value="admin" disabled={!canCreateAdmin}>
                    admin
                  </option>
                </select>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: '#111827', fontSize: 14 }}>
                  <input
                    type="checkbox"
                    checked={newUser.accessEnabled}
                    onChange={(e) => setNewUser((p) => ({ ...p, accessEnabled: e.target.checked }))}
                  />
                  доступ включен
                </label>
                <Button
                  onClick={async () => {
                    setStatus('Создание пользователя...');
                    const r = await window.matrica.admin.users.create({
                      login: newUser.login,
                      fullName: newUser.fullName,
                      password: newUser.password,
                      role: newUser.role,
                      accessEnabled: newUser.accessEnabled,
                    });
                    setStatus(r.ok ? 'Пользователь создан' : `Ошибка: ${r.error ?? 'unknown'}`);
                    if (r.ok) {
                      setNewUser({ login: '', fullName: '', password: '', role: 'user', accessEnabled: true });
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
                    value={selectedUser?.role ?? 'user'}
                    onChange={async (e) => {
                      const role = e.target.value;
                      setStatus('Обновление роли...');
                      const r = await window.matrica.admin.users.update(selectedUserId, { role });
                      setStatus(r.ok ? 'Роль обновлена' : `Ошибка: ${r.error ?? 'unknown'}`);
                      await refreshUsers();
                      await openUser(selectedUserId);
                    }}
                    disabled={!canEditRoleOrAccess}
                    style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
                  >
                    <option value="user">user</option>
                    <option value="admin" disabled={!canCreateAdmin}>
                      admin
                    </option>
                  </select>

                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: '#111827', fontSize: 14 }}>
                    <input
                      type="checkbox"
                      checked={selectedUser?.isActive ?? true}
                      onChange={async (e) => {
                        setStatus('Обновление активности...');
                        const r = await window.matrica.admin.users.update(selectedUserId, { accessEnabled: e.target.checked });
                        setStatus(r.ok ? 'Активность обновлена' : `Ошибка: ${r.error ?? 'unknown'}`);
                        await refreshUsers();
                      }}
                      disabled={!canEditRoleOrAccess}
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
                    disabled={!canEditPassword}
                  >
                    Сменить пароль
                  </Button>
                </div>
              )}

              {!userPerms ? (
                <div style={{ marginTop: 12, color: '#6b7280' }}>Выберите пользователя</div>
              ) : (
                <>
                  <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center' }}>
                    <Input value={permQuery} onChange={(e) => setPermQuery(e.target.value)} placeholder="Поиск прав…" />
                    <div style={{ color: '#6b7280', fontSize: 12, whiteSpace: 'nowrap' }}>
                      Пользователь: <span style={{ fontWeight: 800, color: '#111827' }}>{userPerms.user.username}</span> ({userPerms.user.role})
                    </div>
                  </div>

                  <div style={{ marginTop: 12, border: '1px solid #f3f4f6', borderRadius: 12, overflow: 'hidden' }}>
                    <div style={{ maxHeight: 520, overflowY: 'auto', padding: 12 }}>
                      {Object.entries(
                        (userPerms.allCodes ?? [])
                          .slice()
                          .sort((a, b) => (permGroupRu(a) + permTitleRu(a)).localeCompare(permGroupRu(b) + permTitleRu(b), 'ru'))
                          .reduce((acc: Record<string, string[]>, code: string) => {
                            const q = permQuery.trim().toLowerCase();
                            const hay = `${permGroupRu(code)} ${permTitleRu(code)} ${code}`.toLowerCase();
                            if (q && !hay.includes(q)) return acc;
                            const g = permGroupRu(code);
                            if (!acc[g]) acc[g] = [];
                            acc[g].push(code);
                            return acc;
                          }, {}),
                      ).map(([group, codes]) => (
                        <div key={group} style={{ marginBottom: 14 }}>
                          <div style={{ fontWeight: 900, color: '#111827', marginBottom: 8 }}>{group}</div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
                            {codes.map((code) => {
                              const effective = userPerms.effective?.[code] === true;
                              const override = code in (userPerms.overrides ?? {}) ? userPerms.overrides[code] : null;
                              const adminOnly = permAdminOnly(code);
                              const selectedRole = String(userPerms.user.role ?? '').toLowerCase();
                              const selectedIsAdmin = selectedRole === 'admin' || selectedRole === 'superadmin';
                              const disabled = adminOnly && !selectedIsAdmin;
                              const locked = disabled || !canEditPermissions;

                              return (
                                <div
                                  key={code}
                                  style={{
                                    display: 'grid',
                                    gridTemplateColumns: '1fr 140px',
                                    gap: 10,
                                    alignItems: 'center',
                                    border: '1px solid #f3f4f6',
                                    borderRadius: 12,
                                    padding: 10,
                                    background: locked ? '#f9fafb' : '#fff',
                                  }}
                                >
                                  <div>
                                    <div style={{ fontWeight: 800, color: '#111827', lineHeight: 1.2 }}>
                                      {permTitleRu(code)}
                                      {adminOnly && (
                                        <span style={{ marginLeft: 8, fontSize: 12, color: '#b91c1c', fontWeight: 800 }}>
                                          только admin
                                        </span>
                                      )}
                                      {override !== null && (
                                        <span style={{ marginLeft: 8, fontSize: 12, color: '#6b7280' }}>(настроено вручную)</span>
                                      )}
                                    </div>
                                    <div style={{ marginTop: 2, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, color: '#6b7280' }}>
                                      {code}
                                    </div>
                                  </div>

                                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end' }}>
                                    <input
                                      type="checkbox"
                                      checked={locked ? false : effective}
                                      disabled={locked}
                                      onChange={async (e) => {
                                        const next = e.target.checked;
                                        setStatus('Сохранение права...');
                                        const r = await window.matrica.admin.users.permissionsSet(selectedUserId, { [code]: next });
                                        setStatus(r.ok ? 'Сохранено' : `Ошибка: ${r.error ?? 'unknown'}`);
                                        await openUser(selectedUserId);
                                      }}
                                    />
                                    <span style={{ fontSize: 12, color: '#6b7280' }}>{(locked ? false : effective) ? 'вкл' : 'выкл'}</span>
                                  </label>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}

                      {userPerms.allCodes.length === 0 && <div style={{ color: '#6b7280' }}>(права не загружены)</div>}
                    </div>
                  </div>
                </>
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
                          disabled={!canEditPermissions}
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
                                      disabled={!canEditPermissions}
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

      {status && <div style={{ marginTop: 12, color: '#6b7280' }}>{status}</div>}
    </div>
  );
}
