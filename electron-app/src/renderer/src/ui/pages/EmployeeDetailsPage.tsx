import React, { useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { AttachmentsPanel } from '../components/AttachmentsPanel.js';
import { permAdminOnly, permGroupRu, permTitleRu } from '../auth/permissionCatalog.js';

type EmployeeAccount = {
  id: string;
  username: string;
  login?: string;
  role: string;
  isActive: boolean;
};

type Employee = {
  id: string;
  attributes: Record<string, unknown>;
};

type Option = { id: string; label: string };

function buildFullName(lastName: string, firstName: string, middleName: string) {
  return [lastName, firstName, middleName].map((p) => p.trim()).filter(Boolean).join(' ').trim();
}

export function EmployeeDetailsPage(props: {
  employeeId: string;
  canEdit: boolean;
  canViewFiles: boolean;
  canUploadFiles: boolean;
  canManageUsers: boolean;
  me?: { id: string; role: string; username: string } | null;
}) {
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [status, setStatus] = useState('');

  const [lastName, setLastName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [middleName, setMiddleName] = useState('');
  const [position, setPosition] = useState('');
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<unknown>([]);

  const [departments, setDepartments] = useState<Option[]>([]);
  const [departmentsStatus, setDepartmentsStatus] = useState('');

  const [accountPerms, setAccountPerms] = useState<{
    user: { id: string; username: string; login?: string; role: string; isActive?: boolean };
    allCodes: string[];
    base: Record<string, boolean>;
    overrides: Record<string, boolean>;
    effective: Record<string, boolean>;
  } | null>(null);
  const [accountStatus, setAccountStatus] = useState('');
  const [permQuery, setPermQuery] = useState('');
  const [accountLogin, setAccountLogin] = useState('');
  const [accountPassword, setAccountPassword] = useState('');
  const [accountRole, setAccountRole] = useState('user');
  const [accountActive, setAccountActive] = useState(true);

  const [createLogin, setCreateLogin] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [createRole, setCreateRole] = useState('user');
  const [createActive, setCreateActive] = useState(true);

  const meRole = String(props.me?.role ?? '').toLowerCase();
  const canCreateAdmin = meRole === 'superadmin';
  const canCreateEmployee = meRole === 'superadmin';

  const accountUser = useMemo<EmployeeAccount | null>(() => {
    if (!accountPerms?.user) return null;
    return {
      id: accountPerms.user.id,
      username: accountPerms.user.username,
      login: accountPerms.user.login,
      role: accountPerms.user.role,
      isActive: !!accountPerms.user.isActive,
    };
  }, [accountPerms?.user]);
  const canEditAccount =
    props.canManageUsers && (meRole === 'superadmin' || (meRole === 'admin' && String(accountUser?.role ?? '') === 'user'));
  const canEditPermissions = canEditAccount;

  useEffect(() => {
    void loadEmployee();
  }, [props.employeeId]);

  useEffect(() => {
    void loadDepartments();
  }, []);

  useEffect(() => {
    void loadAccountPerms();
  }, [props.employeeId]);

  useEffect(() => {
    if (!accountUser) return;
    setAccountLogin(accountUser.login ?? '');
    setAccountRole(String(accountUser.role ?? 'user'));
    setAccountActive(!!accountUser.isActive);
  }, [accountUser?.id, accountUser?.login, accountUser?.role, accountUser?.isActive]);

  async function loadEmployee() {
    try {
      setStatus('Загрузка…');
      const data = await window.matrica.employees.get(props.employeeId);
      setEmployee({ id: data.id, attributes: data.attributes ?? {} });
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function loadDepartments() {
    try {
      setDepartmentsStatus('Загрузка списка подразделений…');
      const list = await window.matrica.employees.departmentsList();
      const opts = (list as any[]).map((r) => ({
        id: String(r.id),
        label: r.displayName ? String(r.displayName) : String(r.id).slice(0, 8),
      }));
      opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      setDepartments(opts);
      setDepartmentsStatus('');
    } catch (e) {
      setDepartmentsStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function loadAccountPerms() {
    const r = await window.matrica.employees.permissionsGet(props.employeeId);
    if (!r.ok) {
      const err = r.error ?? 'unknown';
      setAccountPerms(null);
      if (err.includes('employee not found') || err.includes('HTTP 404')) {
        setAccountStatus('Учётной записи нет.');
      } else {
        setAccountStatus(`Ошибка: ${err}`);
      }
      return;
    }
    setAccountPerms(r);
    setAccountStatus('');
  }

  async function saveAttr(code: string, value: unknown) {
    if (!props.canEdit) return;
    setStatus('Сохранение…');
    const r = await window.matrica.employees.setAttr(props.employeeId, code, value);
    if (!r.ok) {
      setStatus(`Ошибка: ${r.error ?? 'unknown'}`);
      return;
    }
    setStatus('Сохранено');
    setTimeout(() => setStatus(''), 1200);
  }

  useEffect(() => {
    if (!employee) return;
    const attrs = employee.attributes ?? {};
    const vLast = attrs.last_name;
    const vFirst = attrs.first_name;
    const vMiddle = attrs.middle_name;
    const vPos = attrs.role;
    const vDept = attrs.department_id;
    const vAttach = attrs.attachments;

    setLastName(vLast == null ? '' : String(vLast));
    setFirstName(vFirst == null ? '' : String(vFirst));
    setMiddleName(vMiddle == null ? '' : String(vMiddle));
    setPosition(vPos == null ? '' : String(vPos));
    setDepartmentId(typeof vDept === 'string' && vDept.trim() ? vDept : null);
    setAttachments(Array.isArray(vAttach) ? vAttach : []);
  }, [employee?.id, employee?.attributes]);

  const computedFullName = buildFullName(lastName, firstName, middleName);
  const departmentOptions = departments;
  const departmentLabel = departmentOptions.find((d) => d.id === departmentId)?.label ?? null;

  async function saveNameField(code: 'last_name' | 'first_name' | 'middle_name', value: string) {
    await saveAttr(code, value.trim() || null);
    const nextFull = buildFullName(
      code === 'last_name' ? value : lastName,
      code === 'first_name' ? value : firstName,
      code === 'middle_name' ? value : middleName,
    );
    await saveAttr('full_name', nextFull || null);
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
        <strong style={{ fontSize: 18 }}>{computedFullName || 'Карточка сотрудника'}</strong>
        {departmentLabel && <span style={{ color: '#6b7280' }}>• {departmentLabel}</span>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 10, alignItems: 'center', maxWidth: 820 }}>
        <div style={{ color: '#6b7280' }}>Фамилия</div>
        <Input
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
          onBlur={() => void saveNameField('last_name', lastName)}
          disabled={!props.canEdit}
          placeholder="Фамилия"
        />
        <div style={{ color: '#6b7280' }}>Имя</div>
        <Input
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          onBlur={() => void saveNameField('first_name', firstName)}
          disabled={!props.canEdit}
          placeholder="Имя"
        />
        <div style={{ color: '#6b7280' }}>Отчество</div>
        <Input
          value={middleName}
          onChange={(e) => setMiddleName(e.target.value)}
          onBlur={() => void saveNameField('middle_name', middleName)}
          disabled={!props.canEdit}
          placeholder="Отчество"
        />
        <div style={{ color: '#6b7280' }}>Должность</div>
        <Input
          value={position}
          onChange={(e) => setPosition(e.target.value)}
          onBlur={() => void saveAttr('role', position.trim() || null)}
          disabled={!props.canEdit}
          placeholder="Должность"
        />
        <div style={{ color: '#6b7280' }}>Подразделение</div>
        <div>
          <SearchSelect
            value={departmentId}
            options={departmentOptions}
            disabled={!props.canEdit}
            placeholder={departmentsStatus || 'Выберите подразделение'}
            onChange={(next) => {
              setDepartmentId(next);
              void saveAttr('department_id', next || null);
            }}
          />
        </div>
      </div>

      <AttachmentsPanel
        title="Вложения сотрудника"
        value={attachments}
        canView={props.canViewFiles}
        canUpload={props.canUploadFiles}
        scope={{ ownerType: 'employee', ownerId: props.employeeId, category: 'attachments' }}
        onChange={async (next) => {
          setAttachments(next);
          return window.matrica.employees.setAttr(props.employeeId, 'attachments', next);
        }}
      />

      <div style={{ marginTop: 18, border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <strong>Пользователи и права доступа</strong>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" onClick={() => void loadAccountPerms()}>
            Обновить
          </Button>
        </div>

          {accountUser ? (
            <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr 140px', gap: 10, alignItems: 'center' }}>
                <div style={{ color: '#6b7280', fontSize: 12 }}>Логин</div>
                <Input value={accountLogin} onChange={(e) => setAccountLogin(e.target.value)} placeholder="логин" disabled={!canEditAccount} />
                <Button
                  variant="ghost"
                  onClick={async () => {
                    const next = accountLogin.trim().toLowerCase();
                    if (!next) return;
                    setAccountStatus('Сохранение...');
                    const r = await window.matrica.admin.users.update(props.employeeId, { login: next });
                    setAccountStatus(r.ok ? 'Логин обновлён' : `Ошибка: ${r.error ?? 'unknown'}`);
                    await loadAccountPerms();
                  }}
                  disabled={!canEditAccount || !accountLogin.trim()}
                >
                  Сохранить
                </Button>
              </div>

              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: '#111827', fontSize: 14 }}>
                  Роль
                  <select
                    value={accountRole}
                    onChange={async (e) => {
                      const nextRole = e.target.value;
                      setAccountStatus('Обновление роли...');
                      const r = await window.matrica.admin.users.update(props.employeeId, { role: nextRole });
                      setAccountStatus(r.ok ? 'Роль обновлена' : `Ошибка: ${r.error ?? 'unknown'}`);
                      await loadAccountPerms();
                    }}
                    disabled={!canEditAccount}
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
                    checked={accountActive}
                    onChange={async (e) => {
                      const next = e.target.checked;
                      setAccountStatus('Обновление активности...');
                      const r = await window.matrica.admin.users.update(props.employeeId, { accessEnabled: next });
                      setAccountStatus(r.ok ? 'Активность обновлена' : `Ошибка: ${r.error ?? 'unknown'}`);
                      await loadAccountPerms();
                    }}
                    disabled={!canEditAccount}
                  />
                  активен
                </label>
              </div>

              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <Input
                  value={accountPassword}
                  onChange={(e) => setAccountPassword(e.target.value)}
                  placeholder="новый пароль"
                  disabled={!canEditAccount}
                />
                <Button
                  variant="ghost"
                  onClick={async () => {
                    if (!accountPassword.trim()) return;
                    setAccountStatus('Смена пароля...');
                    const r = await window.matrica.admin.users.update(props.employeeId, { password: accountPassword });
                    setAccountStatus(r.ok ? 'Пароль обновлён' : `Ошибка: ${r.error ?? 'unknown'}`);
                    setAccountPassword('');
                  }}
                  disabled={!canEditAccount}
                >
                  Сменить пароль
                </Button>
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
              <div style={{ color: '#6b7280' }}>Учётной записи нет.</div>
              <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 10, alignItems: 'center' }}>
                <div style={{ color: '#6b7280' }}>Логин</div>
                <Input value={createLogin} onChange={(e) => setCreateLogin(e.target.value)} placeholder="логин" disabled={!canEditAccount} />
                <div style={{ color: '#6b7280' }}>Пароль</div>
                <Input
                  type="password"
                  value={createPassword}
                  onChange={(e) => setCreatePassword(e.target.value)}
                  placeholder="пароль"
                  disabled={!canEditAccount}
                />
                <div style={{ color: '#6b7280' }}>Роль</div>
                <select
                  value={createRole}
                  onChange={(e) => setCreateRole(e.target.value)}
                  style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
                  disabled={!canEditAccount}
                >
                  <option value="user">user</option>
                  <option value="employee" disabled={!canCreateEmployee}>
                    employee
                  </option>
                  <option value="admin" disabled={!canCreateAdmin}>
                    admin
                  </option>
                </select>
                <div style={{ color: '#6b7280' }}>Активность</div>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="checkbox" checked={createActive} onChange={(e) => setCreateActive(e.target.checked)} disabled={!canEditAccount} />
                  активен
                </label>
              </div>
              <div>
                <Button
                  onClick={async () => {
                    const login = createLogin.trim().toLowerCase();
                    const password = createPassword.trim();
                    if (!login || !password) {
                      setAccountStatus('Заполните логин и пароль.');
                      return;
                    }
                    setAccountStatus('Создание учётной записи...');
                    const r = await window.matrica.admin.users.create({
                      employeeId: props.employeeId,
                      login,
                      password,
                      role: createRole,
                      accessEnabled: createActive,
                    });
                    setAccountStatus(r.ok ? 'Учётная запись создана' : `Ошибка: ${r.error ?? 'unknown'}`);
                    if (r.ok) {
                      setCreateLogin('');
                      setCreatePassword('');
                      await loadAccountPerms();
                    }
                  }}
                  disabled={!canEditAccount}
                >
                  Создать учётную запись
                </Button>
              </div>
            </div>
          )}

          {accountPerms && (
            <div style={{ marginTop: 14, borderTop: '1px solid #f3f4f6', paddingTop: 12 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <strong>Права</strong>
                <span style={{ flex: 1 }} />
                <Button variant="ghost" onClick={() => void loadAccountPerms()}>
                  Обновить
                </Button>
              </div>

              <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center' }}>
                <Input value={permQuery} onChange={(e) => setPermQuery(e.target.value)} placeholder="Поиск прав…" />
                <div style={{ color: '#6b7280', fontSize: 12, whiteSpace: 'nowrap' }}>
                  Пользователь:{' '}
                  <span style={{ fontWeight: 800, color: '#111827' }}>{accountPerms.user.username}</span> ({accountPerms.user.role})
                </div>
              </div>

              <div style={{ marginTop: 12, border: '1px solid #f3f4f6', borderRadius: 12, overflow: 'hidden' }}>
                <div style={{ maxHeight: 520, overflowY: 'auto', padding: 12 }}>
                  {Object.entries(
                    (accountPerms.allCodes ?? [])
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
                          const effective = accountPerms.effective?.[code] === true;
                          const override = code in (accountPerms.overrides ?? {}) ? accountPerms.overrides[code] : null;
                          const adminOnly = permAdminOnly(code);
                          const selectedRole = String(accountPerms.user.role ?? '').toLowerCase();
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
                                  checked={effective}
                                  disabled={locked}
                                  onChange={async (e) => {
                                    if (locked) return;
                                    const next = e.target.checked;
                                    setAccountStatus('Сохранение права...');
                                    const r = await window.matrica.admin.users.permissionsSet(props.employeeId, { [code]: next });
                                    setAccountStatus(r.ok ? 'Сохранено' : `Ошибка: ${r.error ?? 'unknown'}`);
                                    await loadAccountPerms();
                                  }}
                                />
                                <span style={{ fontSize: 12, color: '#6b7280' }}>{effective ? 'вкл' : 'выкл'}</span>
                              </label>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}

                  {accountPerms.allCodes.length === 0 && <div style={{ color: '#6b7280' }}>(права не загружены)</div>}
                </div>
              </div>
            </div>
          )}

          {accountStatus && <div style={{ marginTop: 10, color: accountStatus.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{accountStatus}</div>}
        </div>
      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}
    </div>
  );
}
