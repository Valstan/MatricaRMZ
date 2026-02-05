import React, { useEffect, useState } from 'react';

import type { AdminUserPermissionsPayload, AdminUserSummary, PermissionDelegation } from '@matricarmz/shared';
import { permAdminOnly, permGroupRu, permTitleRu } from '@matricarmz/shared';
import { Button } from './components/Button.js';
import { Input } from './components/Input.js';
import * as adminUsers from '../api/adminUsers.js';
import * as authApi from '../api/auth.js';
import * as ledger from '../api/ledger.js';
import * as updatesApi from '../api/updates.js';

export function AdminUsersPage(props: { canManageUsers: boolean; me?: { id: string; role: string; username: string } | null }) {
  const canManageUsers = props.canManageUsers;
  const me = props.me ?? null;
  const meRole = String(me?.role ?? '').toLowerCase();
  const [status, setStatus] = useState<string>('');

  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [userPerms, setUserPerms] = useState<AdminUserPermissionsPayload | null>(null);
  const [permQuery, setPermQuery] = useState<string>('');
  const [delegations, setDelegations] = useState<PermissionDelegation[]>([]);
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
  const [editLogin, setEditLogin] = useState<string>('');
  const [pendingMergeTargets, setPendingMergeTargets] = useState<Record<string, string>>({});
  const [pendingRoles, setPendingRoles] = useState<Record<string, 'user' | 'admin'>>({});
  const [releaseVersion, setReleaseVersion] = useState<string>('');
  const [releaseNotes, setReleaseNotes] = useState<string>('');
  const [releaseMeta, setReleaseMeta] = useState<string>('');
  const [releaseSha, setReleaseSha] = useState<string>('');
  const [releaseFileName, setReleaseFileName] = useState<string>('');
  const [releaseSize, setReleaseSize] = useState<string>('');
  const [releaseStatus, setReleaseStatus] = useState<string>('');
  const [latestRelease, setLatestRelease] = useState<{ version: string; createdAt: number; createdBy: string } | null>(null);
  const [releaseTokenTtlHours, setReleaseTokenTtlHours] = useState<string>('168');
  const [releaseTokenValue, setReleaseTokenValue] = useState<string>('');
  const [releaseTokenExpiresAt, setReleaseTokenExpiresAt] = useState<number | null>(null);
  const [releaseTokenStatus, setReleaseTokenStatus] = useState<string>('');
  const [releaseAutoStatus, setReleaseAutoStatus] = useState<string>('');
  const [accessReportStatus, setAccessReportStatus] = useState<string>('');

  function formatAccessLabel(role: string | null | undefined, isActive?: boolean) {
    if (!isActive) return 'запрещено';
    const normalized = String(role ?? '').trim().toLowerCase();
    if (!normalized) return 'Пользователь';
    if (normalized === 'superadmin') return 'Суперадминистратор';
    if (normalized === 'admin') return 'Администратор';
    if (normalized === 'employee') return 'Сотрудник';
    if (normalized === 'pending') return 'Ожидает подтверждения';
    if (normalized === 'user') return 'Пользователь';
    return normalized;
  }

  async function refreshUsers() {
    const r = await adminUsers.listUsers();
    if (!r.ok) {
      setStatus(`Ошибка users.list: ${r.error}`);
      return;
    }
    setUsers(r.users ?? []);
    if (!selectedUserId && r.users?.[0]) setSelectedUserId(r.users[0].id);
  }

  async function openUser(userId: string) {
    setSelectedUserId(userId);
    const r = await adminUsers.getUserPermissions(userId);
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
    const d = await adminUsers.listUserDelegations(userId);
    if (d.ok) setDelegations(d.delegations ?? []);
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
  const canEditRoleOrAccess = meRole === 'superadmin' && !selectedIsSelf;
  const canEditPermissions = !selectedIsSelf && !adminLocked;
  const canEditPassword = !adminLocked;
  const canCreateAdmin = meRole === 'superadmin';
  const canCreateEmployee = meRole === 'superadmin';
  const canEditRole = canEditRoleOrAccess;
  const canEditLogin = !selectedIsSelf && !adminLocked && !(meRole === 'admin' && selectedRole === 'employee');

  useEffect(() => {
    setEditLogin(selectedUser?.login ?? '');
  }, [selectedUser?.id, selectedUser?.login]);

  useEffect(() => {
    if (meRole !== 'superadmin') {
      setNewUser((p) => ({ ...p, role: 'user', accessEnabled: false }));
    }
  }, [meRole]);

  useEffect(() => {
    void (async () => {
      const r = await ledger.getLatestRelease();
      if (r?.ok && r.release) {
        setLatestRelease({
          version: String(r.release.version ?? ''),
          createdAt: Number(r.release.created_at ?? 0),
          createdBy: String(r.release.created_by_username ?? ''),
        });
      } else {
        setLatestRelease(null);
      }
    })();
  }, []);

  async function fillReleaseFromUpdates() {
    setReleaseAutoStatus('Загружаем данные обновления...');
    const meta = await updatesApi.getLatestUpdateMeta();
    if (!meta?.ok) {
      setReleaseAutoStatus(`Не удалось получить обновление: ${meta?.error ?? 'unknown'}`);
      return null;
    }
    const version = String(meta.version ?? '').trim();
    const fileName = String(meta.fileName ?? '').trim();
    const size = Number(meta.size ?? 0);
    const sha256 = String(meta.sha256 ?? '').trim();
    if (version) setReleaseVersion(version);
    if (fileName) setReleaseFileName(fileName);
    if (Number.isFinite(size) && size > 0) setReleaseSize(String(size));
    if (sha256) setReleaseSha(sha256);
    if (!releaseNotes.trim() && version) setReleaseNotes(`Автопубликация ${version}`);
    setReleaseAutoStatus('Данные обновления подставлены.');
    return { version, fileName, size, sha256 };
  }

  async function ensureReleaseToken() {
    if (releaseTokenValue.trim()) return true;
    const ttl = Number(releaseTokenTtlHours.trim());
    if (!Number.isFinite(ttl) || ttl <= 0) {
      setReleaseTokenStatus('Укажите TTL в часах (1..720).');
      return false;
    }
    setReleaseTokenStatus('Генерация токена...');
    const r = await authApi.generateReleaseToken(ttl);
    if (r?.ok && r.accessToken) {
      setReleaseTokenValue(String(r.accessToken));
      setReleaseTokenExpiresAt(Number(r.expiresAt ?? 0) || null);
      setReleaseTokenStatus('Токен сгенерирован.');
      return true;
    }
    setReleaseTokenStatus(`Ошибка: ${r?.error ?? 'unknown'}`);
    return false;
  }

  function csvEscape(value: string) {
    const s = String(value ?? '');
    if (s.includes('"') || s.includes(',') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  async function downloadAccessReport() {
    setAccessReportStatus('Формируем отчёт...');
    const r = await adminUsers.getAccessReport();
    if (!r?.ok || !Array.isArray(r.rows)) {
      setAccessReportStatus(`Ошибка отчёта: ${r?.error ?? 'unknown'}`);
      return;
    }
    const header = ['ФИО', 'роль', 'логин'];
    const lines = [header.join(',')];
    for (const row of r.rows as any[]) {
      const fullName = String(row.fullName ?? row.username ?? '').trim();
      const role = String(row.role ?? '').trim();
      const login = String(row.login ?? '').trim();
      lines.push([fullName, role, login].map(csvEscape).join(','));
    }
    const csv = '\uFEFF' + lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `access-report-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setAccessReportStatus(`Готово: ${r.rows.length}`);
    setTimeout(() => setAccessReportStatus(''), 2000);
  }

  return (
    <div>
      <h2 style={{ margin: '8px 0' }}>Админ</h2>
      <div className="muted" style={{ marginBottom: 12 }}>
        Раздел для управления пользователями, правами и доступом.
      </div>

      {!canManageUsers && <div className="muted">У вас нет доступа к управлению пользователями и правами.</div>}

      {canManageUsers && (
        <>
          <div className="card" style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <strong>Ledger: публикация релиза</strong>
              <span style={{ flex: 1 }} />
              {latestRelease && (
                <div className="muted" style={{ fontSize: 12 }}>
                  Последний: {latestRelease.version} • {latestRelease.createdBy || '—'}
                </div>
              )}
            </div>
            <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Input value={releaseVersion} onChange={(e) => setReleaseVersion(e.target.value)} placeholder="версия (X.Y.Z)" />
              <Input value={releaseNotes} onChange={(e) => setReleaseNotes(e.target.value)} placeholder="краткие заметки" />
              <Input value={releaseFileName} onChange={(e) => setReleaseFileName(e.target.value)} placeholder="имя инсталлятора (Setup.exe)" />
              <Input value={releaseSha} onChange={(e) => setReleaseSha(e.target.value)} placeholder="SHA256 (64 hex)" />
              <Input value={releaseSize} onChange={(e) => setReleaseSize(e.target.value)} placeholder="размер (bytes)" />
              <Input
                value={releaseMeta}
                onChange={(e) => setReleaseMeta(e.target.value)}
                placeholder='metadata JSON (опционально, например {"build":"win"})'
              />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Button
                  variant="ghost"
                  onClick={async () => {
                    await fillReleaseFromUpdates();
                  }}
                >
                  Заполнить из обновления
                </Button>
                {releaseAutoStatus && <div className="muted">{releaseAutoStatus}</div>}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Button
                  onClick={async () => {
                    if (!releaseVersion.trim()) {
                      const meta = await fillReleaseFromUpdates();
                      if (!meta?.version) {
                        setReleaseStatus('Укажите версию.');
                        return;
                      }
                    }
                    const tokenOk = await ensureReleaseToken();
                    if (!tokenOk) {
                      setReleaseStatus('Не удалось сгенерировать токен.');
                      return;
                    }
                    let metadata: Record<string, unknown> | undefined;
                    if (releaseMeta.trim()) {
                      try {
                        metadata = JSON.parse(releaseMeta);
                      } catch {
                        setReleaseStatus('metadata JSON некорректен.');
                        return;
                      }
                    }
                    setReleaseStatus('Публикация...');
                    const r = await ledger.publishRelease({
                      version: releaseVersion.trim(),
                      notes: releaseNotes.trim() || undefined,
                      fileName: releaseFileName.trim() || undefined,
                      sha256: releaseSha.trim() || undefined,
                      size: releaseSize.trim() ? Number(releaseSize.trim()) : undefined,
                      metadata,
                    });
                    if (r?.ok) {
                      setReleaseStatus('Релиз опубликован.');
                      setReleaseVersion('');
                      setReleaseNotes('');
                      setReleaseMeta('');
                      setReleaseFileName('');
                      setReleaseSha('');
                      setReleaseSize('');
                      const latest = await ledger.getLatestRelease();
                      if (latest?.ok && latest.release) {
                        setLatestRelease({
                          version: String(latest.release.version ?? ''),
                          createdAt: Number(latest.release.created_at ?? 0),
                          createdBy: String(latest.release.created_by_username ?? ''),
                        });
                      }
                    } else {
                      setReleaseStatus(`Ошибка: ${r?.error ?? 'unknown'}`);
                    }
                  }}
                >
                  Опубликовать
                </Button>
                {releaseStatus && <div className="muted">{releaseStatus}</div>}
              </div>
            </div>
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #f3f4f6' }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <strong>Токен для релиза</strong>
                <span style={{ flex: 1 }} />
                {releaseTokenExpiresAt && (
                  <div className="muted" style={{ fontSize: 12 }}>
                    Истекает: {new Date(releaseTokenExpiresAt).toLocaleString('ru-RU')}
                  </div>
                )}
              </div>
              <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 200px', gap: 8, alignItems: 'center' }}>
                <Input
                  value={releaseTokenTtlHours}
                  onChange={(e) => setReleaseTokenTtlHours(e.target.value)}
                  placeholder="TTL, часы (например 168)"
                />
                <Button
                  variant="ghost"
                  onClick={async () => {
                    const ttl = Number(releaseTokenTtlHours.trim());
                    if (!Number.isFinite(ttl) || ttl <= 0) {
                      setReleaseTokenStatus('Укажите TTL в часах (1..720).');
                      return;
                    }
                    setReleaseTokenStatus('Генерация токена...');
                    const r = await authApi.generateReleaseToken(ttl);
                    if (r?.ok && r.accessToken) {
                      setReleaseTokenValue(String(r.accessToken));
                      setReleaseTokenExpiresAt(Number(r.expiresAt ?? 0) || null);
                      setReleaseTokenStatus('Токен сгенерирован.');
                    } else {
                      setReleaseTokenStatus(`Ошибка: ${r?.error ?? 'unknown'}`);
                    }
                  }}
                >
                  Сгенерировать
                </Button>
              </div>
              <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
                <textarea
                  value={releaseTokenValue}
                  readOnly
                  rows={3}
                  placeholder="Здесь появится токен для публикации релиза"
                  style={{
                    width: '100%',
                    padding: 10,
                    borderRadius: 10,
                    border: '1px solid #d1d5db',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: 12,
                  }}
                />
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      if (!releaseTokenValue) return;
                      try {
                        await navigator.clipboard.writeText(releaseTokenValue);
                        setReleaseTokenStatus('Токен скопирован.');
                      } catch {
                        setReleaseTokenStatus('Не удалось скопировать токен.');
                      }
                    }}
                    disabled={!releaseTokenValue}
                  >
                    Скопировать
                  </Button>
                  {releaseTokenStatus && <div className="muted">{releaseTokenStatus}</div>}
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <strong>Пользователи и права доступа</strong>
              <span style={{ flex: 1 }} />
              <Button variant="ghost" onClick={() => void downloadAccessReport()}>
                Отчёт по доступам
              </Button>
              {accessReportStatus && <div className="muted" style={{ fontSize: 12 }}>{accessReportStatus}</div>}
              <Button
                variant="ghost"
                onClick={async () => {
                  if (!confirm('Переснять всех сотрудников в синхронизацию? Клиентам потребуется выполнить синк.')) return;
                  setStatus('Формируем синк-снимок сотрудников…');
                  const r = await adminUsers.resyncEmployees();
                  if (r.ok) {
                    const failed = Number((r as any).failed ?? 0);
                    setStatus(
                      failed > 0
                        ? `Готово: ${r.count ?? 0} сотрудников, ошибок: ${failed}. Запустите синхронизацию на клиентах.`
                        : `Готово: ${r.count ?? 0} сотрудников. Запустите синхронизацию на клиентах.`,
                    );
                  } else {
                    setStatus(`Ошибка пересинхронизации: ${r.error ?? 'unknown'}`);
                  }
                }}
              >
                Пересинхронизировать сотрудников
              </Button>
              <Button variant="ghost" onClick={() => void refreshUsers()}>
                Обновить
              </Button>
            </div>

          {users.some((u) => String(u.role).toLowerCase() === 'pending') && (
            <div style={{ marginTop: 12, border: '1px solid #f3f4f6', borderRadius: 12, padding: 12 }}>
              <strong>Ожидают одобрения</strong>
              <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
                {users
                  .filter((u) => String(u.role).toLowerCase() === 'pending')
                  .map((u) => {
                    const mergeTarget = pendingMergeTargets[u.id] ?? '';
                    const pendingRole = pendingRoles[u.id] ?? 'user';
                    return (
                      <div key={u.id} style={{ border: '1px solid #eef2f7', borderRadius: 10, padding: 10 }}>
                        <div style={{ fontWeight: 700, display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span>{u.username}</span>
                          {u.deleteRequestedAt && (
                            <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 999, background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>
                              на удаление
                            </span>
                          )}
                        </div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          login: {u.login ?? u.id}
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                          {canCreateAdmin && (
                            <select
                              value={pendingRole}
                              onChange={(e) =>
                                setPendingRoles((p) => ({ ...p, [u.id]: e.target.value === 'admin' ? 'admin' : 'user' }))
                              }
                              disabled={!canApprovePending}
                            >
                              <option value="user">user</option>
                              <option value="admin">admin</option>
                            </select>
                          )}
                          <Button
                            onClick={async () => {
                              setStatus('Одобрение...');
                              const r = await adminUsers.pendingApprove({
                                pendingUserId: u.id,
                                action: 'approve',
                                role: pendingRole,
                              });
                              setStatus(r.ok ? 'Пользователь одобрен' : `Ошибка: ${r.error ?? 'unknown'}`);
                              await refreshUsers();
                            }}
                            disabled={!canApprovePending}
                          >
                            Одобрить
                          </Button>
                          <select
                            value={mergeTarget}
                            onChange={(e) => setPendingMergeTargets((p) => ({ ...p, [u.id]: e.target.value }))}
                            disabled={!canApprovePending}
                          >
                            <option value="">Слить с существующим…</option>
                            {users
                              .filter((x) => String(x.role).toLowerCase() !== 'pending')
                              .map((x) => (
                                <option key={x.id} value={x.id}>
                                  {x.username} ({x.role})
                                </option>
                              ))}
                          </select>
                          <Button
                            variant="ghost"
                            onClick={async () => {
                              if (!mergeTarget) {
                                setStatus('Выберите пользователя для слияния');
                                return;
                              }
                              setStatus('Слияние...');
                              const r = await adminUsers.pendingApprove({
                                pendingUserId: u.id,
                                action: 'merge',
                                targetUserId: mergeTarget,
                              });
                              setStatus(r.ok ? 'Пользователь слит' : `Ошибка: ${r.error ?? 'unknown'}`);
                              await refreshUsers();
                            }}
                            disabled={!canApprovePending}
                          >
                            Слить
                          </Button>
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}

          <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 10 }}>
            <div style={{ border: '1px solid #f3f4f6', borderRadius: 12, padding: 12 }}>
              <div className="muted" style={{ marginBottom: 6 }}>
                Создать пользователя
              </div>
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
                  <option value="employee" disabled={!canCreateEmployee}>
                    employee
                  </option>
                  <option value="admin" disabled={!canCreateAdmin}>
                    admin
                  </option>
                </select>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: '#111827', fontSize: 14 }}>
                  <input
                    type="checkbox"
                    checked={newUser.accessEnabled}
                    onChange={(e) => setNewUser((p) => ({ ...p, accessEnabled: e.target.checked }))}
                    disabled={!canEditRoleOrAccess}
                  />
                  доступ включен
                </label>
                <Button
                  onClick={async () => {
                    setStatus('Создание пользователя...');
                    const r = await adminUsers.createUser({
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

              <div className="muted" style={{ marginTop: 12, marginBottom: 6 }}>
                Выбрать пользователя
              </div>
              <select
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
              >
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.username} ({formatAccessLabel(u.role, u.isActive)}) {u.isActive ? '' : '[disabled]'}{' '}
                    {u.deleteRequestedAt ? '[на удаление]' : ''}
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
                <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr 140px', gap: 10, alignItems: 'center' }}>
                    <div className="muted" style={{ fontSize: 12 }}>
                      Логин
                    </div>
                    <Input value={editLogin} onChange={(e) => setEditLogin(e.target.value)} placeholder="логин" />
                    <Button
                      variant="ghost"
                      onClick={async () => {
                        const next = editLogin.trim().toLowerCase();
                        if (!next) return;
                        setStatus('Смена логина...');
                        const r = await adminUsers.updateUser(selectedUserId, { login: next });
                        setStatus(r.ok ? 'Логин обновлён' : `Ошибка: ${r.error ?? 'unknown'}`);
                        await refreshUsers();
                        await openUser(selectedUserId);
                      }}
                      disabled={!canEditLogin || !editLogin.trim()}
                    >
                      Сохранить
                    </Button>
                  </div>

                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: '#111827', fontSize: 14 }}>
                      Роль
                      <select
                        value={selectedRole}
                        onChange={async (e) => {
                          const role = e.target.value;
                          setStatus('Обновление роли...');
                          const r = await adminUsers.updateUser(selectedUserId, { role });
                          setStatus(r.ok ? 'Роль обновлена' : `Ошибка: ${r.error ?? 'unknown'}`);
                          await refreshUsers();
                          await openUser(selectedUserId);
                        }}
                        disabled={!canEditRole}
                        style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
                      >
                        <option value="user">user</option>
                        <option value="employee" disabled={!canCreateEmployee}>
                          employee
                        </option>
                        <option value="admin" disabled={!canCreateAdmin}>
                          admin
                        </option>
                        <option value="superadmin" disabled>
                          superadmin
                        </option>
                      </select>
                    </label>

                    <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: '#111827', fontSize: 14 }}>
                      <input
                        type="checkbox"
                        checked={selectedUser?.isActive ?? true}
                        onChange={async (e) => {
                          setStatus('Обновление активности...');
                          const r = await adminUsers.updateUser(selectedUserId, { accessEnabled: e.target.checked });
                          setStatus(r.ok ? 'Активность обновлена' : `Ошибка: ${r.error ?? 'unknown'}`);
                          await refreshUsers();
                        }}
                        disabled={!canEditRoleOrAccess}
                      />
                      активен
                    </label>
                  </div>

                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Input value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} placeholder="новый пароль (опц.)" />
                    <Button
                      variant="ghost"
                      onClick={async () => {
                        if (!resetPassword.trim()) return;
                        setStatus('Смена пароля...');
                        const r = await adminUsers.updateUser(selectedUserId, { password: resetPassword });
                        setStatus(r.ok ? 'Пароль обновлён' : `Ошибка: ${r.error ?? 'unknown'}`);
                        setResetPassword('');
                      }}
                      disabled={!canEditPassword}
                    >
                      Сменить пароль
                    </Button>
                  </div>

                  {selectedUser && (
                    <div style={{ marginTop: 12, borderTop: '1px solid #f3f4f6', paddingTop: 10 }}>
                      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>Удаление пользователя</div>
                      {selectedUser.deleteRequestedAt ? (
                        <div style={{ display: 'grid', gap: 8 }}>
                          <div style={{ color: '#6b7280', fontSize: 12 }}>
                            Запрос на удаление: {new Date(selectedUser.deleteRequestedAt).toLocaleString('ru-RU')}
                            {selectedUser.deleteRequestedByUsername ? ` • ${selectedUser.deleteRequestedByUsername}` : ''}
                          </div>
                          {meRole === 'superadmin' && !selectedIsSelf && (
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                              <Button
                                onClick={async () => {
                                  if (!confirm('Подтвердить удаление пользователя?')) return;
                                  setStatus('Удаление...');
                                  const r = await adminUsers.confirmUserDelete(selectedUserId);
                                  setStatus(r.ok ? 'Пользователь удалён' : `Ошибка: ${r.error ?? 'unknown'}`);
                                  await refreshUsers();
                                }}
                              >
                                Подтвердить удаление
                              </Button>
                              <Button
                                variant="ghost"
                                onClick={async () => {
                                  setStatus('Отмена удаления...');
                                  const r = await adminUsers.cancelUserDelete(selectedUserId);
                                  setStatus(r.ok ? 'Удаление отменено' : `Ошибка: ${r.error ?? 'unknown'}`);
                                  await refreshUsers();
                                }}
                              >
                                Отменить удаление
                              </Button>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          {meRole === 'superadmin' && !selectedIsSelf && (
                            <Button
                              onClick={async () => {
                                if (!confirm('Удалить пользователя? Это действие нельзя отменить.')) return;
                                setStatus('Удаление...');
                                const r = await adminUsers.confirmUserDelete(selectedUserId);
                                setStatus(r.ok ? 'Пользователь удалён' : `Ошибка: ${r.error ?? 'unknown'}`);
                                await refreshUsers();
                              }}
                            >
                              Удалить
                            </Button>
                          )}
                          {meRole === 'admin' && !selectedIsSelf && (
                            <Button
                              variant="ghost"
                              onClick={async () => {
                                if (!confirm('Запросить удаление пользователя?')) return;
                                setStatus('Запрос на удаление...');
                                const r = await adminUsers.requestUserDelete(selectedUserId);
                                setStatus(r.ok ? 'Запрос отправлен' : `Ошибка: ${r.error ?? 'unknown'}`);
                                await refreshUsers();
                              }}
                            >
                              Запросить удаление
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {!userPerms ? (
                <div style={{ marginTop: 12 }} className="muted">
                  Выберите пользователя
                </div>
              ) : (
                <>
                  <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center' }}>
                    <Input value={permQuery} onChange={(e) => setPermQuery(e.target.value)} placeholder="Поиск прав…" />
                    <div className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap', display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span>
                        Пользователь:{' '}
                        <span style={{ fontWeight: 800, color: '#111827' }}>{userPerms.user.username}</span>{' '}
                        ({formatAccessLabel(userPerms.user.role, userPerms.user.isActive)})
                      </span>
                      {selectedUser?.deleteRequestedAt && (
                        <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 999, background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>
                          на удаление
                        </span>
                      )}
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
                                        <span style={{ marginLeft: 8, fontSize: 12, color: '#b91c1c', fontWeight: 800 }}>только admin</span>
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
                                        const r = await adminUsers.setUserPermissions(selectedUserId, { [code]: next });
                                        setStatus(r.ok ? 'Сохранено' : `Ошибка: ${r.error ?? 'unknown'}`);
                                        await openUser(selectedUserId);
                                      }}
                                    />
                                    <span className="muted" style={{ fontSize: 12 }}>
                                      {(locked ? false : effective) ? 'вкл' : 'выкл'}
                                    </span>
                                  </label>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}

                      {userPerms.allCodes.length === 0 && <div className="muted">(права не загружены)</div>}
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
                    <div className="muted" style={{ marginBottom: 6 }}>
                      Делегировать право выбранному пользователю до даты.
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
                            const r = await adminUsers.createDelegation({
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
                                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>
                                  {fromU} → {toU}
                                </td>
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
                                        const r = await adminUsers.revokeDelegation(d.id);
                                        setStatus(r.ok ? 'Отозвано' : `Ошибка: ${r.error ?? 'unknown'}`);
                                        await openUser(selectedUserId);
                                      }}
                                      disabled={!canEditPermissions}
                                    >
                                      Отозвать
                                    </Button>
                                  ) : (
                                    <span className="muted" style={{ fontSize: 12 }}>
                                      —
                                    </span>
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
        </>
      )}

      {status && <div style={{ marginTop: 12, color: '#6b7280' }}>{status}</div>}
    </div>
  );
}
