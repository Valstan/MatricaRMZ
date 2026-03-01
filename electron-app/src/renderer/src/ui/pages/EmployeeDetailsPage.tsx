import React, { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../components/Button.js';
import { CardActionBar } from '../components/CardActionBar.js';
import type { CardCloseActions } from '../cardCloseTypes.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { SearchSelectWithCreate } from '../components/SearchSelectWithCreate.js';
import { DraggableFieldList } from '../components/DraggableFieldList.js';
import { AttachmentsPanel } from '../components/AttachmentsPanel.js';
import { EntityCardShell } from '../components/EntityCardShell.js';
import { RowActions } from '../components/RowActions.js';
import { SectionCard } from '../components/SectionCard.js';
import { permAdminOnly, permGroupRu, permTitleRu } from '@matricarmz/shared';
import { buildLinkTypeOptions, normalizeForMatch, suggestLinkTargetCodeWithRules, type LinkRule } from '@matricarmz/shared';
import { escapeHtml, openPrintPreview } from '../utils/printPreview.js';
import { formatMoscowDate } from '../utils/dateUtils.js';
import { ensureAttributeDefs, orderFieldsByDefs, persistFieldOrder, type AttributeDefRow } from '../utils/fieldOrder.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';

type EmployeeAccount = {
  id: string;
  username: string;
  login?: string | undefined;
  role: string;
  isActive: boolean;
};

type Employee = {
  id: string;
  attributes: Record<string, unknown>;
};

type Option = { id: string; label: string };

type AttrDef = {
  id: string;
  entityTypeId: string;
  code: string;
  name: string;
  dataType: string;
  isRequired: boolean;
  sortOrder: number;
  metaJson: string | null;
};

type EntityTypeRow = { id: string; code: string; name: string };
function buildFullName(lastName: string, firstName: string, middleName: string) {
  return [lastName, firstName, middleName].map((p) => p.trim()).filter(Boolean).join(' ').trim();
}

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
  if (!out) out = 'field';
  if (/^[0-9]/.test(out)) out = `f_${out}`;
  return out;
}

function getLinkTargetTypeCode(def: AttrDef): string | null {
  if (def.dataType !== 'link') return null;
  if (!def.metaJson) return null;
  try {
    const json = JSON.parse(def.metaJson);
    return typeof json?.linkTargetTypeCode === 'string' ? json.linkTargetTypeCode : null;
  } catch {
    return null;
  }
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
  return `<ul>${items
    .map((f) => {
      const entry = f as { name: string; isObsolete?: boolean };
      const obsoleteBadge =
        entry.isObsolete === true
          ? ' <span style="display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:700;color:#991b1b;background:#fee2e2;border:1px solid #fecaca;">Устаревшая версия</span>'
          : '';
      return `<li>${escapeHtml(String(entry.name))}${obsoleteBadge}</li>`;
    })
    .join('')}</ul>`;
}

function formatValue(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map((x) => formatValue(x)).filter(Boolean).join(', ');
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

 

export function EmployeeDetailsPage(props: {
  employeeId: string;
  canEdit: boolean;
  canViewFiles: boolean;
  canUploadFiles: boolean;
  canManageUsers: boolean;
  onAccessChanged?: () => void;
  onOpenEmployee?: (employeeId: string) => void;
  onOpenCounterparty?: (counterpartyId: string) => void;
  onOpenContract?: (contractId: string) => void;
  onOpenByCode?: Record<string, ((id: string) => void) | undefined>;
  me?: { id: string; role: string; username: string } | null;
  onClose: () => void;
  registerCardCloseActions?: (actions: CardCloseActions | null) => void;
  requestClose?: () => void;
}) {
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [status, setStatus] = useState('');

  const [lastName, setLastName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [middleName, setMiddleName] = useState('');
  const [position, setPosition] = useState('');
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<unknown>([]);
  const [personnelNumber, setPersonnelNumber] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [employmentStatus, setEmploymentStatus] = useState('working');
  const [hireDate, setHireDate] = useState('');
  const [terminationDate, setTerminationDate] = useState('');
  const [transfers, setTransfers] = useState<Array<{ id: string; kind: string; date: number | null; value: string }>>([]);
  const [transferKind, setTransferKind] = useState('position');
  const [transferDate, setTransferDate] = useState('');
  const [transferValue, setTransferValue] = useState('');

  const [customDefs, setCustomDefs] = useState<AttrDef[]>([]);
  const [customStatus, setCustomStatus] = useState('');
  const [customName, setCustomName] = useState('');
  const [customDataType, setCustomDataType] = useState('text');
  const [customLinkTargetCode, setCustomLinkTargetCode] = useState('');
  const [customLinkTouched, setCustomLinkTouched] = useState(false);
  const [customDraftValues, setCustomDraftValues] = useState<Record<string, unknown>>({});
  const [entityTypes, setEntityTypes] = useState<EntityTypeRow[]>([]);
  const [employeeTypeId, setEmployeeTypeId] = useState<string>('');
  const [employeeDefs, setEmployeeDefs] = useState<AttrDef[]>([]);
  const [coreDefsReady, setCoreDefsReady] = useState(false);
  const [linkOptionsByDefId, setLinkOptionsByDefId] = useState<Record<string, { id: string; label: string }[]>>({});
  const [linkLoadingByDefId, setLinkLoadingByDefId] = useState<Record<string, boolean>>({});
  const [linkRules, setLinkRules] = useState<LinkRule[]>([]);

  const dirtyRef = useRef(false);

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
  const canEditLoginPassword =
    props.canManageUsers && (meRole === 'superadmin' || (meRole === 'admin' && String(accountUser?.role ?? '') === 'user'));
  const canEditRole = props.canManageUsers && meRole === 'superadmin';
  const canToggleAccess = props.canManageUsers && meRole === 'superadmin';
  const canEditPermissions = canEditLoginPassword;

  useEffect(() => {
    void loadEmployee();
  }, [props.employeeId]);

  useEffect(() => {
    void loadDepartments();
  }, []);

  useEffect(() => {
    void loadCustomDefs();
  }, []);

  useEffect(() => {
    if (!props.canEdit || !employeeTypeId || employeeDefs.length === 0 || coreDefsReady) return;
    const desired = [
      { code: 'last_name', name: 'Фамилия', dataType: 'text', sortOrder: 10 },
      { code: 'first_name', name: 'Имя', dataType: 'text', sortOrder: 20 },
      { code: 'middle_name', name: 'Отчество', dataType: 'text', sortOrder: 30 },
      { code: 'personnel_number', name: 'Табельный номер', dataType: 'text', sortOrder: 40 },
      { code: 'birth_date', name: 'Дата рождения', dataType: 'date', sortOrder: 50 },
      { code: 'role', name: 'Должность', dataType: 'text', sortOrder: 60 },
      { code: 'employment_status', name: 'Статус', dataType: 'text', sortOrder: 70 },
      { code: 'hire_date', name: 'Дата приема', dataType: 'date', sortOrder: 80 },
      { code: 'termination_date', name: 'Дата увольнения', dataType: 'date', sortOrder: 90 },
      { code: 'department_id', name: 'Подразделение', dataType: 'link', sortOrder: 100, metaJson: JSON.stringify({ linkTargetTypeCode: 'department' }) },
    ];
    void ensureAttributeDefs(employeeTypeId, desired, employeeDefs as unknown as AttributeDefRow[]).then((next) => {
      if (next.length !== employeeDefs.length) setEmployeeDefs(next as AttrDef[]);
      setCoreDefsReady(true);
    });
  }, [props.canEdit, employeeTypeId, employeeDefs.length, coreDefsReady]);

  useEffect(() => {
    if (customDataType !== 'link') setCustomLinkTargetCode('');
    if (customDataType !== 'link') setCustomLinkTouched(false);
  }, [customDataType]);

  const recommendedLinkCode = useMemo(
    () => suggestLinkTargetCodeWithRules(customName, linkRules),
    [customName, linkRules],
  );

  useEffect(() => {
    if (customDataType !== 'link') return;
    if (customLinkTouched) return;
    if (recommendedLinkCode) setCustomLinkTargetCode(recommendedLinkCode);
  }, [customDataType, customLinkTouched, recommendedLinkCode]);

  useEffect(() => {
    void loadEntityTypes();
  }, []);

  useEffect(() => {
    if (entityTypes.length === 0) return;
    void loadLinkRules();
  }, [entityTypes]);

  useEffect(() => {
    for (const def of customDefs) {
      if (def.dataType === 'link') void ensureLinkOptions(def);
    }
  }, [customDefs, entityTypes]);

  useEffect(() => {
    void loadAccountPerms();
  }, [props.employeeId]);

  useEffect(() => {
    if (!accountUser) return;
    setAccountLogin(accountUser.login ?? '');
    setAccountRole(String(accountUser.role ?? 'user'));
    setAccountActive(!!accountUser.isActive);
  }, [accountUser?.id, accountUser?.login, accountUser?.role, accountUser?.isActive]);

  useLiveDataRefresh(
    async () => {
      if (dirtyRef.current) return;
      await loadEmployee();
      await loadAccountPerms();
    },
    { intervalMs: 20000 },
  );

  useEffect(() => {
    if (meRole !== 'superadmin') {
      setCreateRole('user');
      setCreateActive(false);
    }
  }, [meRole]);

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

  async function createDepartment(label: string): Promise<string | null> {
    if (!props.canEdit) return null;
    const clean = label.trim();
    if (!clean) return null;
    const departmentType = entityTypes.find((t) => t.code === 'department');
    if (!departmentType) {
      setDepartmentsStatus('Ошибка: тип "department" не найден');
      return null;
    }
    const created = await window.matrica.admin.entities.create(String(departmentType.id));
    if (!created.ok || !created.id) {
      setDepartmentsStatus(`Ошибка: ${(created as any).error ?? 'не удалось создать подразделение'}`);
      return null;
    }
    await window.matrica.admin.entities.setAttr(created.id, 'name', clean);
    await loadDepartments();
    return created.id;
  }

  async function saveAllAndClose() {
    if (props.canEdit) {
      await saveAttr('last_name', lastName.trim() || null);
      await saveAttr('first_name', firstName.trim() || null);
      await saveAttr('middle_name', middleName.trim() || null);
      await saveAttr('full_name', computedFullName || null);
      await saveAttr('personnel_number', personnelNumber.trim() || null);
      await saveAttr('birth_date', fromInputDate(birthDate));
      await saveAttr('role', position.trim() || null);
      await saveAttr('employment_status', employmentStatus);
      await saveAttr('hire_date', fromInputDate(hireDate));
      await saveAttr('termination_date', fromInputDate(terminationDate));
      await saveAttr('department_id', departmentId || null);
      await saveAttr('transfers', transfers);
      await saveAttr('attachments', attachments);
      for (const def of customDefs) {
        await saveAttr(def.code, (customDraftValues as any)[def.code] ?? null);
      }
      if (employmentStatus === 'fired' && canToggleAccess) {
        const r = await window.matrica.admin.users.update(props.employeeId, { accessEnabled: false });
        setAccountStatus(r.ok ? 'Доступ отключён (уволен)' : `Ошибка: ${r.error ?? 'unknown'}`);
        if (r.ok) props.onAccessChanged?.();
      }
    }
    dirtyRef.current = false;
  }

  async function handleDelete() {
    if (!props.canEdit) return;
    const isSuper = meRole === 'superadmin';
    if (!confirm(isSuper ? 'Удалить сотрудника? Это действие нельзя отменить.' : 'Запросить удаление сотрудника?')) return;
    try {
      setStatus(isSuper ? 'Удаление…' : 'Запрос на удаление…');
      const r = await window.matrica.employees.delete(props.employeeId);
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error ?? 'unknown'}`);
        return;
      }
      if ((r as any).mode === 'deleted') {
        setStatus('Удалено');
        setTimeout(() => setStatus(''), 900);
        props.onClose();
      } else {
        setStatus('Запрос на удаление отправлен');
        setTimeout(() => setStatus(''), 1500);
      }
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function loadCustomDefs() {
    try {
      const defs = await window.matrica.employees.defs();
      setEmployeeDefs(defs as AttrDef[]);
      const base = new Set([
        'last_name',
        'first_name',
        'middle_name',
        'full_name',
        'role',
        'department_id',
        'section_id',
        'attachments',
        'personnel_number',
        'birth_date',
        'employment_status',
        'hire_date',
        'termination_date',
        'transfers',
        'login',
        'password_hash',
        'system_role',
        'access_enabled',
        'chat_display_name',
      ]);
      const filtered = (defs as AttrDef[]).filter((d) => !base.has(String(d.code)));
      setCustomDefs(filtered);
    } catch (e) {
      setCustomStatus(`Ошибка загрузки доп. полей: ${String(e)}`);
    }
  }

  async function loadEntityTypes() {
    try {
      const rows = await window.matrica.admin.entityTypes.list();
      const list = (rows as any[]).map((t) => ({ id: String(t.id), code: String(t.code), name: String(t.name) }));
      list.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      setEntityTypes(list);
      const employeeType = list.find((t) => t.code === 'employee');
      setEmployeeTypeId(employeeType?.id ?? '');
    } catch {
      // ignore
    }
  }

  async function loadLinkRules() {
    try {
      const ruleType = entityTypes.find((t) => t.code === 'link_field_rule');
      if (!ruleType) {
        setLinkRules([]);
        return;
      }
      const list = await window.matrica.admin.entities.listByEntityType(ruleType.id);
      const rules: LinkRule[] = [];
      for (const row of list as any[]) {
        const details = await window.matrica.admin.entities.get(String(row.id));
        const attrs = details.attributes ?? {};
        const fieldName = String(attrs.field_name ?? '').trim();
        const targetTypeCode = String(attrs.target_type_code ?? '').trim();
        const priority = Number(attrs.priority ?? 0) || 0;
        if (fieldName && targetTypeCode) {
          rules.push({ fieldName, targetTypeCode, priority });
        }
      }
      setLinkRules(rules);
    } catch {
      setLinkRules([]);
    }
  }

  async function upsertLinkRule(fieldName: string, targetTypeCode: string) {
    const ruleType = entityTypes.find((t) => t.code === 'link_field_rule');
    if (!ruleType) return;
    const list = await window.matrica.admin.entities.listByEntityType(ruleType.id);
    const normalized = normalizeForMatch(fieldName);
    for (const row of list as any[]) {
      const details = await window.matrica.admin.entities.get(String(row.id));
      const attrs = details.attributes ?? {};
      const existingName = normalizeForMatch(String(attrs.field_name ?? ''));
      if (existingName && existingName === normalized) {
        await window.matrica.admin.entities.setAttr(String(row.id), 'target_type_code', targetTypeCode);
        if (!attrs.priority) await window.matrica.admin.entities.setAttr(String(row.id), 'priority', 100);
        return;
      }
    }
    const created = await window.matrica.admin.entities.create(ruleType.id);
    if (!created.ok || !created.id) return;
    await window.matrica.admin.entities.setAttr(created.id, 'field_name', fieldName);
    await window.matrica.admin.entities.setAttr(created.id, 'target_type_code', targetTypeCode);
    await window.matrica.admin.entities.setAttr(created.id, 'priority', 100);
  }

  async function ensureLinkOptions(def: AttrDef) {
    if (def.dataType !== 'link') return;
    if (linkOptionsByDefId[def.id]) return;
    if (linkLoadingByDefId[def.id]) return;
    const targetCode = getLinkTargetTypeCode(def);
    if (!targetCode) return;
    const targetType = entityTypes.find((t) => t.code === targetCode);
    if (!targetType) return;
    setLinkLoadingByDefId((p) => ({ ...p, [def.id]: true }));
    try {
      const list = await window.matrica.admin.entities.listByEntityType(targetType.id);
      const opts = (list as any[]).map((x) => ({
        id: String(x.id),
        label: x.displayName ? String(x.displayName) : String(x.id).slice(0, 8),
      }));
      opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      setLinkOptionsByDefId((p) => ({ ...p, [def.id]: opts }));
    } finally {
      setLinkLoadingByDefId((p) => ({ ...p, [def.id]: false }));
    }
  }

  async function createLinkedEntity(def: AttrDef, label: string): Promise<string | null> {
    const targetCode = getLinkTargetTypeCode(def);
    if (!targetCode) return null;
    const targetType = entityTypes.find((t) => t.code === targetCode);
    if (!targetType?.id) return null;
    const created = await window.matrica.admin.entities.create(targetType.id);
    if (!created.ok || !created.id) return null;
    const defs = await window.matrica.admin.attributeDefs.listByEntityType(targetType.id);
    const labelKeys = ['name', 'number', 'engine_number', 'full_name'];
    const labelDef = (defs as any[]).find((d) => labelKeys.includes(String(d.code))) ?? null;
    if (labelDef?.code) {
      await window.matrica.admin.entities.setAttr(created.id, String(labelDef.code), label);
    }
    const next = linkOptionsByDefId[def.id] ?? [];
    setLinkOptionsByDefId((p) => ({ ...p, [def.id]: [...next, { id: created.id, label }] }));
    return created.id;
  }

  async function createCustomField() {
    const name = customName.trim();
    if (!name) {
      setCustomStatus('Укажите название поля.');
      return;
    }
    if (customDataType === 'link' && !customLinkTargetCode) {
      setCustomStatus('Выберите справочник для link‑поля.');
      return;
    }
    setCustomStatus('Создание поля...');
    try {
      const types = await window.matrica.admin.entityTypes.list();
      const employeeType = (types as any[]).find((t) => String(t.code) === 'employee') ?? null;
      if (!employeeType?.id) {
        setCustomStatus('Не найден раздел "Сотрудник".');
        return;
      }
      const code = slugifyCode(name);
      const metaJson =
        customDataType === 'link' ? JSON.stringify({ linkTargetTypeCode: customLinkTargetCode }) : null;
      const r = await window.matrica.admin.attributeDefs.upsert({
        entityTypeId: String(employeeType.id),
        code,
        name,
        dataType: customDataType,
        sortOrder: 500,
        metaJson,
      });
      if (!r.ok) {
        setCustomStatus(`Ошибка: ${r.error ?? 'unknown'}`);
        return;
      }
      if (customDataType === 'link' && customLinkTouched && customLinkTargetCode) {
        await upsertLinkRule(name, customLinkTargetCode);
        await loadLinkRules();
      }
      setCustomName('');
      await loadCustomDefs();
      setCustomStatus('Поле добавлено');
    } catch (e) {
      setCustomStatus(`Ошибка: ${String(e)}`);
    }
  }

  function renderCustomField(def: AttrDef) {
    const value = Object.prototype.hasOwnProperty.call(customDraftValues, def.code)
      ? customDraftValues[def.code]
      : employee?.attributes?.[def.code];
    if (def.dataType === 'boolean') {
      return (
        <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={value === true}
            disabled={!props.canEdit}
            onChange={(e) => {
              if (!props.canEdit) return;
              dirtyRef.current = true;
              setCustomDraftValues((prev) => ({ ...prev, [def.code]: e.target.checked }));
            }}
          />
          <span style={{ color: 'var(--subtle)', fontSize: 12 }}>{value === true ? 'да' : 'нет'}</span>
        </label>
      );
    }
    if (def.dataType === 'date') {
      const ms = typeof value === 'number' ? value : value != null ? Number(value) : null;
      const dateValue = toInputDate(Number.isFinite(ms as number) ? (ms as number) : null);
      return (
        <Input
          type="date"
          value={dateValue}
          disabled={!props.canEdit}
          onChange={(e) => {
            if (!props.canEdit) return;
            dirtyRef.current = true;
            setCustomDraftValues((prev) => ({ ...prev, [def.code]: fromInputDate(e.target.value) }));
          }}
        />
      );
    }
    if (def.dataType === 'number') {
      const s = value == null ? '' : String(value);
      return (
        <Input
          value={s}
          disabled={!props.canEdit}
          onChange={(e) => {
            if (!props.canEdit) return;
            const next = e.target.value === '' ? null : Number(e.target.value);
            dirtyRef.current = true;
            setCustomDraftValues((prev) => ({ ...prev, [def.code]: Number.isFinite(next as number) ? next : null }));
          }}
          placeholder="число"
        />
      );
    }
    if (def.dataType === 'json') {
      const s = value == null ? '' : JSON.stringify(value);
      return (
        <Input
          value={s}
          disabled={!props.canEdit}
          onChange={(e) => {
            if (!props.canEdit) return;
            try {
              const next = e.target.value ? JSON.parse(e.target.value) : null;
              dirtyRef.current = true;
              setCustomDraftValues((prev) => ({ ...prev, [def.code]: next }));
            } catch {
              // ignore parse errors while typing
            }
          }}
          placeholder="json"
        />
      );
    }
    if (def.dataType === 'link') {
      const current = typeof value === 'string' ? value : null;
      const options = linkOptionsByDefId[def.id] ?? [];
      const loading = linkLoadingByDefId[def.id] === true;
      const targetCode = getLinkTargetTypeCode(def);
      const openByTarget =
        targetCode && !['department', 'unit'].includes(targetCode) ? props.onOpenByCode?.[targetCode] : undefined;
      const createHandler =
        props.canEdit && targetCode
          ? async (label: string) => {
              const id = await createLinkedEntity(def, label);
              if (!id) return null;
              await ensureLinkOptions(def);
              dirtyRef.current = true;
              setCustomDraftValues((prev) => ({ ...prev, [def.code]: id }));
              return id;
            }
          : null;
      return (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'start' }}>
          <SearchSelect
            value={current}
            disabled={!props.canEdit}
            options={options}
            placeholder={loading ? 'Загрузка…' : '(не выбрано)'}
            onChange={(next) => {
              if (!props.canEdit) return;
              dirtyRef.current = true;
              setCustomDraftValues((prev) => ({ ...prev, [def.code]: next || null }));
            }}
            {...(createHandler ? { onCreate: createHandler, createLabel: `Новая запись (${targetCode})` } : {})}
          />
          {current && openByTarget ? (
            <Button variant="outline" tone="neutral" size="sm" onClick={() => openByTarget?.(current)}>
              Открыть
            </Button>
          ) : null}
        </div>
      );
    }
    const text = value == null ? '' : String(value);
    return (
      <Input
        value={text}
        disabled={!props.canEdit}
        onChange={(e) => {
          if (!props.canEdit) return;
          dirtyRef.current = true;
          setCustomDraftValues((prev) => ({ ...prev, [def.code]: e.target.value }));
        }}
        placeholder={def.code}
      />
    );
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
    const vPersonnel = attrs.personnel_number;
    const vBirth = attrs.birth_date;
    const vStatus = attrs.employment_status;
    const vHire = attrs.hire_date;
    const vTermination = attrs.termination_date;
    const vTransfers = attrs.transfers;

    setLastName(vLast == null ? '' : String(vLast));
    setFirstName(vFirst == null ? '' : String(vFirst));
    setMiddleName(vMiddle == null ? '' : String(vMiddle));
    setPosition(vPos == null ? '' : String(vPos));
    setDepartmentId(typeof vDept === 'string' && vDept.trim() ? vDept : null);
    setAttachments(Array.isArray(vAttach) ? vAttach : []);
    setPersonnelNumber(vPersonnel == null ? '' : String(vPersonnel));
    const birthMs = typeof vBirth === 'number' ? vBirth : vBirth != null ? Number(vBirth) : null;
    setBirthDate(toInputDate(Number.isFinite(birthMs as number) ? (birthMs as number) : null));
    const status = String(vStatus ?? '').toLowerCase();
    setEmploymentStatus(status === 'fired' ? 'fired' : 'working');
    const hireMs = typeof vHire === 'number' ? vHire : vHire != null ? Number(vHire) : null;
    setHireDate(toInputDate(Number.isFinite(hireMs as number) ? (hireMs as number) : null));
    const termMs = typeof vTermination === 'number' ? vTermination : vTermination != null ? Number(vTermination) : null;
    setTerminationDate(toInputDate(Number.isFinite(termMs as number) ? (termMs as number) : null));
    setTransfers(Array.isArray(vTransfers) ? vTransfers : []);
    const draft: Record<string, unknown> = {};
    for (const def of customDefs) draft[def.code] = (attrs as any)?.[def.code];
    setCustomDraftValues(draft);
    dirtyRef.current = false;
  }, [employee?.id, employee?.attributes, customDefs]);

  useEffect(() => {
    if (!props.registerCardCloseActions) return;
    props.registerCardCloseActions({
      isDirty: () => dirtyRef.current,
      saveAndClose: async () => {
        await saveAllAndClose();
      },
      reset: async () => {
        await loadEmployee();
        await loadAccountPerms();
        dirtyRef.current = false;
      },
      closeWithoutSave: () => {
        dirtyRef.current = false;
      },
      copyToNew: async () => {
        const r = await window.matrica.employees.create();
        if (!r?.ok || !r?.id) return;
        if (lastName.trim()) await window.matrica.employees.setAttr(r.id, 'last_name', lastName.trim());
        if (firstName.trim()) await window.matrica.employees.setAttr(r.id, 'first_name', firstName.trim());
        if (middleName.trim()) await window.matrica.employees.setAttr(r.id, 'middle_name', middleName.trim());
        const full = buildFullName(lastName, firstName, middleName);
        if (full) await window.matrica.employees.setAttr(r.id, 'full_name', full);
        if (position.trim()) await window.matrica.employees.setAttr(r.id, 'role', position.trim());
        if (personnelNumber.trim()) await window.matrica.employees.setAttr(r.id, 'personnel_number', personnelNumber.trim());
        if (departmentId) await window.matrica.employees.setAttr(r.id, 'department_id', departmentId);
        dirtyRef.current = false;
      },
    });
    return () => {
      props.registerCardCloseActions?.(null);
    };
  }, [lastName, firstName, middleName, position, personnelNumber, departmentId, props.registerCardCloseActions, customDefs, customDraftValues]);

  const computedFullName = buildFullName(lastName, firstName, middleName);
  const departmentOptions = departments;
  const departmentLabel = departmentOptions.find((d) => d.id === departmentId)?.label ?? null;
  const standardType = useMemo(
    () => (customLinkTouched ? entityTypes.find((t) => t.code === customLinkTargetCode) ?? null : null),
    [customLinkTouched, customLinkTargetCode, entityTypes],
  );
  const recommendedType = useMemo(
    () => entityTypes.find((t) => t.code === recommendedLinkCode) ?? null,
    [entityTypes, recommendedLinkCode],
  );
  const linkTypeOptions = useMemo(
    () => buildLinkTypeOptions(entityTypes, standardType?.code ?? null, recommendedType?.code ?? null),
    [entityTypes, standardType?.code, recommendedType?.code],
  );

  const mainFields = orderFieldsByDefs(
    [
      {
        code: 'last_name',
        defaultOrder: 10,
        label: 'Фамилия',
        value: lastName,
        render: (
          <Input
            value={lastName}
            onChange={(e) => {
              dirtyRef.current = true;
              setLastName(e.target.value);
            }}
            disabled={!props.canEdit}
            placeholder="Фамилия"
          />
        ),
      },
      {
        code: 'first_name',
        defaultOrder: 20,
        label: 'Имя',
        value: firstName,
        render: (
          <Input
            value={firstName}
            onChange={(e) => {
              dirtyRef.current = true;
              setFirstName(e.target.value);
            }}
            disabled={!props.canEdit}
            placeholder="Имя"
          />
        ),
      },
      {
        code: 'middle_name',
        defaultOrder: 30,
        label: 'Отчество',
        value: middleName,
        render: (
          <Input
            value={middleName}
            onChange={(e) => {
              dirtyRef.current = true;
              setMiddleName(e.target.value);
            }}
            disabled={!props.canEdit}
            placeholder="Отчество"
          />
        ),
      },
      {
        code: 'personnel_number',
        defaultOrder: 40,
        label: 'Табельный номер',
        value: personnelNumber,
        render: (
          <Input
            value={personnelNumber}
            onChange={(e) => {
              dirtyRef.current = true;
              setPersonnelNumber(e.target.value);
            }}
            disabled={!props.canEdit}
            placeholder="Табельный номер"
          />
        ),
      },
      {
        code: 'birth_date',
        defaultOrder: 50,
        label: 'Дата рождения',
        value: birthDate || '',
        render: (
          <Input
            type="date"
            value={birthDate}
            onChange={(e) => {
              dirtyRef.current = true;
              setBirthDate(e.target.value);
            }}
            disabled={!props.canEdit}
          />
        ),
      },
      {
        code: 'role',
        defaultOrder: 60,
        label: 'Должность',
        value: position,
        render: (
          <Input
            value={position}
            onChange={(e) => {
              dirtyRef.current = true;
              setPosition(e.target.value);
            }}
            disabled={!props.canEdit}
            placeholder="Должность"
          />
        ),
      },
      {
        code: 'employment_status',
        defaultOrder: 70,
        label: 'Статус',
        value: employmentStatus === 'fired' ? 'уволен' : 'работает',
        render: (
          <select
            value={employmentStatus}
            onChange={(e) => {
              const next = e.target.value === 'fired' ? 'fired' : 'working';
              dirtyRef.current = true;
              setEmploymentStatus(next);
            }}
            disabled={!props.canEdit}
            style={{ padding: '8px 10px', borderRadius: 0, border: '1px solid var(--border)' }}
          >
            <option value="working">работает</option>
            <option value="fired">уволен</option>
          </select>
        ),
      },
      {
        code: 'hire_date',
        defaultOrder: 80,
        label: 'Дата приема',
        value: hireDate || '',
        render: (
          <Input
            type="date"
            value={hireDate}
            onChange={(e) => {
              dirtyRef.current = true;
              setHireDate(e.target.value);
            }}
            disabled={!props.canEdit}
          />
        ),
      },
      {
        code: 'termination_date',
        defaultOrder: 90,
        label: 'Дата увольнения',
        value: terminationDate || '',
        render: (
          <Input
            type="date"
            value={terminationDate}
            onChange={(e) => {
              dirtyRef.current = true;
              setTerminationDate(e.target.value);
            }}
            disabled={!props.canEdit}
          />
        ),
      },
      {
        code: 'department_id',
        defaultOrder: 100,
        label: 'Подразделение',
        value: departmentLabel || '',
        render: (
          <SearchSelectWithCreate
            value={departmentId}
            options={departmentOptions}
            disabled={!props.canEdit}
            placeholder={departmentsStatus || 'Выберите подразделение'}
            canCreate={props.canEdit}
            createLabel="Новое подразделение"
            onChange={(next) => {
              dirtyRef.current = true;
              setDepartmentId(next);
            }}
            onCreate={async (label) => {
              const id = await createDepartment(label);
              if (!id) return null;
              dirtyRef.current = true;
              setDepartmentId(id);
              return id;
            }}
          />
        ),
      },
    ],
    employeeDefs as unknown as AttributeDefRow[],
  );

  function printEmployeeCard() {
    const attrs = employee?.attributes ?? {};
    const mainRows: Array<[string, string]> = mainFields.map((f) => [f.label, String(f.value ?? '')]);
    const transfersHtml =
      transfers.length === 0
        ? '<div class="muted">Нет данных</div>'
        : `<ul>${transfers
            .map((t) => {
              const dt = t.date ? formatMoscowDate(t.date) : '';
              return `<li>${escapeHtml(dt)}: ${escapeHtml(String(t.kind ?? ''))} — ${escapeHtml(String(t.value ?? ''))}</li>`;
            })
            .join('')}</ul>`;
    const extraRows = orderFieldsByDefs(customDefs, employeeDefs as unknown as AttributeDefRow[]).map((d) => [
      d.name || d.code,
      formatValue((attrs as any)[d.code]),
    ]);

    openPrintPreview({
      title: 'Карточка сотрудника',
      ...(computedFullName ? { subtitle: `Сотрудник: ${computedFullName}` } : {}),
      sections: [
        { id: 'main', title: 'Основное', html: keyValueTable(mainRows) },
        { id: 'transfers', title: 'Кадровые перемещения', html: transfersHtml },
        {
          id: 'extra',
          title: 'Дополнительные поля',
          html: extraRows.length > 0 ? keyValueTable(extraRows as Array<[string, string]>) : '<div class="muted">Нет данных</div>',
        },
        { id: 'files', title: 'Вложения', html: fileListHtml(attachments) },
      ],
    });
  }

  const headerTitle = computedFullName ? `Сотрудник: ${computedFullName}` : 'Карточка сотрудника';

  return (
    <EntityCardShell
      title={headerTitle}
      layout="two-column"
      cardActions={
        <CardActionBar
          canEdit={props.canEdit}
          onCopyToNew={
            props.canEdit
              ? async () => {
                  const r = await window.matrica.employees.create();
                  if (!r?.ok || !r?.id) return;
                  if (lastName.trim()) await window.matrica.employees.setAttr(r.id, 'last_name', lastName.trim());
                  if (firstName.trim()) await window.matrica.employees.setAttr(r.id, 'first_name', firstName.trim());
                  if (middleName.trim()) await window.matrica.employees.setAttr(r.id, 'middle_name', middleName.trim());
                  const full = buildFullName(lastName, firstName, middleName);
                  if (full) await window.matrica.employees.setAttr(r.id, 'full_name', full);
                  if (position.trim()) await window.matrica.employees.setAttr(r.id, 'role', position.trim());
                  if (personnelNumber.trim()) await window.matrica.employees.setAttr(r.id, 'personnel_number', personnelNumber.trim());
                  if (departmentId) await window.matrica.employees.setAttr(r.id, 'department_id', departmentId);
                  dirtyRef.current = false;
                }
              : undefined
          }
          onSaveAndClose={
            props.canEdit
              ? () => void saveAllAndClose().then(() => props.onClose())
              : undefined
          }
          onReset={
            props.canEdit
              ? () =>
                  void (async () => {
                    await loadEmployee();
                    await loadAccountPerms();
                    dirtyRef.current = false;
                  })()
              : undefined
          }
          onDelete={props.canEdit ? () => void handleDelete() : undefined}
          onClose={props.requestClose ? () => props.requestClose?.() : undefined}
        />
      }
      actions={
        <RowActions>
          <Button variant="ghost" tone="info" onClick={printEmployeeCard}>
            Распечатать
          </Button>
        </RowActions>
      }
      status={departmentLabel ? <span style={{ color: 'var(--subtle)' }}>{departmentLabel}</span> : null}
    >
      <SectionCard style={{ padding: 12 }}>
      <DraggableFieldList
        items={mainFields}
        getKey={(f) => f.code}
        canDrag={props.canEdit}
        onReorder={(next) => {
          if (!employeeTypeId) return;
          void persistFieldOrder(
            next.map((f) => f.code),
            employeeDefs as unknown as AttributeDefRow[],
            { entityTypeId: employeeTypeId },
          ).then(() => setEmployeeDefs([...employeeDefs]));
        }}
        renderItem={(field, itemProps, _dragHandleProps, state) => (
          <div
            {...itemProps}
            className="card-row"
            style={{
              display: 'grid',
              gridTemplateColumns: '220px 1fr',
              gap: 8,
              alignItems: 'center',
              maxWidth: 820,
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

      <SectionCard title="Переводы" style={{ border: '1px solid var(--border)' }}>
        <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
          {transfers.length === 0 && <div style={{ color: 'var(--subtle)' }}>Переводов нет</div>}
          {transfers.map((t) => (
            <div key={t.id} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))', gap: 8, alignItems: 'center' }}>
              <div style={{ color: 'var(--text)' }}>{t.kind === 'department' ? 'Подразделение' : 'Должность'}</div>
              <div style={{ color: 'var(--subtle)' }}>{t.date ? formatMoscowDate(t.date) : '—'}</div>
              <div style={{ color: 'var(--text)' }}>{t.value || '—'}</div>
              <Button
                variant="ghost"
                onClick={async () => {
                  if (!props.canEdit) return;
                  const next = transfers.filter((x) => x.id !== t.id);
                  dirtyRef.current = true;
                  setTransfers(next);
                }}
                disabled={!props.canEdit}
              >
                Удалить
              </Button>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))', gap: 8, alignItems: 'center' }}>
          <select
            value={transferKind}
            onChange={(e) => setTransferKind(e.target.value)}
            disabled={!props.canEdit}
            style={{ padding: '8px 10px', borderRadius: 0, border: '1px solid var(--border)' }}
          >
            <option value="position">Перевод на должность</option>
            <option value="department">Перевод в подразделение</option>
          </select>
          <Input type="date" value={transferDate} onChange={(e) => setTransferDate(e.target.value)} disabled={!props.canEdit} />
          <Input value={transferValue} onChange={(e) => setTransferValue(e.target.value)} placeholder="Описание / новое значение" disabled={!props.canEdit} />
          <Button
            onClick={async () => {
              if (!props.canEdit) return;
              const value = transferValue.trim();
              const date = fromInputDate(transferDate);
              if (!value || !date) {
                setStatus('Заполните дату и описание перевода.');
                return;
              }
              const next = [
                ...transfers,
                { id: String(Date.now()), kind: transferKind, date, value },
              ];
              dirtyRef.current = true;
              setTransfers(next);
              setTransferValue('');
              setTransferDate('');
            }}
            disabled={!props.canEdit}
          >
            Добавить
          </Button>
        </div>
      </SectionCard>

      <div className="entity-card-span-full">
        <AttachmentsPanel
          title="Вложения сотрудника"
          value={attachments}
          canView={props.canViewFiles}
          canUpload={props.canUploadFiles}
          scope={{ ownerType: 'employee', ownerId: props.employeeId, category: 'attachments' }}
          onChange={async (next) => {
            dirtyRef.current = true;
            setAttachments(next);
            return { ok: true as const };
          }}
        />
      </div>

      <SectionCard
        className="entity-card-span-full"
        title="Дополнительные поля"
        style={{ border: '1px solid var(--border)' }}
        actions={undefined}
      >

        <div style={{ marginTop: 10 }}>
          {customDefs.length === 0 ? (
            <div style={{ color: 'var(--subtle)' }}>(доп. полей нет)</div>
          ) : (
            <DraggableFieldList
              items={orderFieldsByDefs(customDefs, employeeDefs as unknown as AttributeDefRow[])}
              getKey={(def) => def.id}
              canDrag={props.canEdit}
              onReorder={(next) => {
                if (!employeeTypeId) return;
                void persistFieldOrder(
                  next.map((d) => d.code),
                  employeeDefs as unknown as AttributeDefRow[],
                  { entityTypeId: employeeTypeId, startAt: 300 },
                ).then(() => setEmployeeDefs([...employeeDefs]));
              }}
              renderItem={(def, itemProps, _dragHandleProps, state) => (
                <div
                  {...itemProps}
                  className="card-row"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '200px 1fr',
                    gap: 8,
                    alignItems: 'center',
                    maxWidth: 820,
                    padding: '4px 6px',
                    border: state.isOver ? '1px dashed var(--input-border-focus)' : '1px solid var(--card-row-border)',
                    background: state.isDragging ? 'var(--card-row-drag-bg)' : undefined,
                  }}
                >
                  <div style={{ color: 'var(--subtle)' }}>{def.name}</div>
                  {renderCustomField(def)}
                </div>
              )}
            />
          )}
        </div>

        {props.canEdit && (
          <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--subtle)', marginBottom: 6 }}>Добавить поле</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 180px 200px 140px', gap: 8, alignItems: 'center' }}>
              <Input value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder="Название поля" />
              <select
                value={customDataType}
                onChange={(e) => setCustomDataType(e.target.value)}
                style={{ padding: '8px 10px', borderRadius: 0, border: '1px solid var(--border)' }}
              >
                <option value="text">Текст</option>
                <option value="number">Число</option>
                <option value="boolean">Да/нет</option>
                <option value="date">Дата</option>
                <option value="json">JSON</option>
                <option value="link">Ссылка на справочник</option>
              </select>
              {customDataType === 'link' ? (
                <div style={{ display: 'grid', gap: 6 }}>
                  <select
                    value={customLinkTargetCode}
                    onChange={(e) => {
                      setCustomLinkTargetCode(e.target.value);
                      setCustomLinkTouched(true);
                    }}
                    style={{ padding: '8px 10px', borderRadius: 0, border: '1px solid var(--border)' }}
                  >
                    <option value="">выберите справочник…</option>
                    {linkTypeOptions.map((opt) => (
                      <option key={opt.type.id} value={opt.type.code}>
                        {opt.tag === 'standard'
                          ? `${opt.type.name} (стандартный)`
                          : opt.tag === 'recommended'
                            ? `${opt.type.name} (рекомендуется)`
                            : opt.type.name}
                      </option>
                    ))}
                  </select>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setCustomLinkTouched(false);
                        if (recommendedLinkCode) setCustomLinkTargetCode(recommendedLinkCode);
                      }}
                      disabled={!recommendedLinkCode}
                    >
                      Сбросить к рекомендуемому
                    </Button>
                    {!recommendedLinkCode && <span style={{ color: 'var(--subtle)', fontSize: 12 }}>Нет рекомендации</span>}
                  </div>
                  {(standardType || recommendedType) && (
                    <div style={{ color: 'var(--subtle)', fontSize: 12 }}>
                      {standardType && (
                        <>
                          Стандартный: <strong>{standardType.name}</strong>
                        </>
                      )}
                      {standardType && recommendedType && recommendedType.code !== standardType.code && ' • '}
                      {recommendedType && recommendedType.code !== standardType?.code && (
                        <>
                          Рекомендуется: <strong>{recommendedType.name}</strong>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ color: 'var(--subtle)', fontSize: 12 }}>Тип данных</div>
              )}
              <Button onClick={async () => void createCustomField()} disabled={!customName.trim()}>
                Добавить
              </Button>
            </div>
            {customStatus && <div style={{ marginTop: 8, color: customStatus.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{customStatus}</div>}
          </div>
        )}
      </SectionCard>

      <div style={{ marginTop: 18, border: '1px solid var(--border)', borderRadius: 0, padding: 12 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <strong>Пользователи и права доступа</strong>
          <span style={{ flex: 1 }} />
        </div>

          {accountUser ? (
            <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr 140px', gap: 10, alignItems: 'center' }}>
                <div style={{ color: 'var(--subtle)', fontSize: 12 }}>Логин</div>
                <Input value={accountLogin} onChange={(e) => setAccountLogin(e.target.value)} placeholder="логин" disabled={!canEditLoginPassword} />
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
                  disabled={!canEditLoginPassword || !accountLogin.trim()}
                >
                  Сохранить
                </Button>
              </div>

              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text)', fontSize: 14 }}>
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
                    disabled={!canEditRole}
                    style={{ padding: '8px 10px', borderRadius: 0, border: '1px solid var(--border)' }}
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

                <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text)', fontSize: 14 }}>
                  <input
                    type="checkbox"
                    checked={accountActive}
                    onChange={async (e) => {
                      if (!canToggleAccess) return;
                      const next = e.target.checked;
                      setAccountStatus('Обновление активности...');
                      const r = await window.matrica.admin.users.update(props.employeeId, { accessEnabled: next });
                      setAccountStatus(r.ok ? 'Активность обновлена' : `Ошибка: ${r.error ?? 'unknown'}`);
                      await loadAccountPerms();
                      if (r.ok) props.onAccessChanged?.();
                    }}
                    disabled={!canToggleAccess}
                  />
                  доступ к программе
                </label>
              </div>

              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <Input
                  value={accountPassword}
                  onChange={(e) => setAccountPassword(e.target.value)}
                  placeholder="новый пароль"
                  disabled={!canEditLoginPassword}
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
                  disabled={!canEditLoginPassword}
                >
                  Сменить пароль
                </Button>
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
              <div style={{ color: 'var(--subtle)' }}>Учётной записи нет.</div>
              <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 10, alignItems: 'center' }}>
                <div style={{ color: 'var(--subtle)' }}>Логин</div>
                <Input value={createLogin} onChange={(e) => setCreateLogin(e.target.value)} placeholder="логин" disabled={!canEditLoginPassword} />
                <div style={{ color: 'var(--subtle)' }}>Пароль</div>
                <Input
                  type="password"
                  value={createPassword}
                  onChange={(e) => setCreatePassword(e.target.value)}
                  placeholder="пароль"
                  disabled={!canEditLoginPassword}
                />
                <div style={{ color: 'var(--subtle)' }}>Роль</div>
                <select
                  value={createRole}
                  onChange={(e) => setCreateRole(e.target.value)}
                  style={{ padding: '8px 10px', borderRadius: 0, border: '1px solid var(--border)' }}
                  disabled={!canEditRole}
                >
                  <option value="user">user</option>
                  <option value="employee" disabled={!canCreateEmployee}>
                    employee
                  </option>
                  <option value="admin" disabled={!canCreateAdmin}>
                    admin
                  </option>
                </select>
                <div style={{ color: 'var(--subtle)' }}>Активность</div>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="checkbox" checked={createActive} onChange={(e) => setCreateActive(e.target.checked)} disabled={!canToggleAccess} />
                  доступ к программе
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
                      props.onAccessChanged?.();
                    }
                  }}
                  disabled={!canEditLoginPassword}
                >
                  Создать учётную запись
                </Button>
              </div>
            </div>
          )}

          {accountPerms && (
            <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <strong>Права</strong>
                <span style={{ flex: 1 }} />
              </div>

              <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center' }}>
                <Input value={permQuery} onChange={(e) => setPermQuery(e.target.value)} placeholder="Поиск прав…" />
                <div style={{ color: 'var(--subtle)', fontSize: 12, whiteSpace: 'nowrap' }}>
                  Пользователь:{' '}
                  <span style={{ fontWeight: 800, color: 'var(--text)' }}>{accountPerms.user.username}</span> ({accountPerms.user.role})
                </div>
              </div>

              <div style={{ marginTop: 12, border: '1px solid var(--border)', borderRadius: 0, overflow: 'hidden' }}>
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
                      <div style={{ fontWeight: 900, color: 'var(--text)', marginBottom: 8 }}>{group}</div>
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
                                border: '1px solid var(--border)',
                                borderRadius: 0,
                                padding: 10,
                                background: locked ? 'var(--surface-2)' : 'var(--surface)',
                              }}
                            >
                              <div>
                                <div style={{ fontWeight: 800, color: 'var(--text)', lineHeight: 1.2 }}>
                                  {permTitleRu(code)}
                                  {adminOnly && (
                                    <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--danger)', fontWeight: 800 }}>
                                      только admin
                                    </span>
                                  )}
                                  {override !== null && (
                                    <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--subtle)' }}>(настроено вручную)</span>
                                  )}
                                </div>
                                <div style={{ marginTop: 2, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, color: 'var(--subtle)' }}>
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
                                <span style={{ fontSize: 12, color: 'var(--subtle)' }}>{effective ? 'вкл' : 'выкл'}</span>
                              </label>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}

                  {accountPerms.allCodes.length === 0 && <div style={{ color: 'var(--subtle)' }}>(права не загружены)</div>}
                </div>
              </div>
            </div>
          )}

          {accountStatus && <div style={{ marginTop: 10, color: accountStatus.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{accountStatus}</div>}
        </div>
      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div>}
    </EntityCardShell>
  );
}
