import React, { useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { AttachmentsPanel } from '../components/AttachmentsPanel.js';
import { permAdminOnly, permGroupRu, permTitleRu } from '../auth/permissionCatalog.js';
import {
  buildLinkTypeOptions,
  normalizeForMatch,
  suggestLinkTargetCodeWithRules,
  type LinkRule,
} from '../utils/linkFieldRules.js';
import { escapeHtml, openPrintPreview } from '../utils/printPreview.js';

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
  return `<ul>${items.map((f) => `<li>${escapeHtml(String((f as any).name))}</li>`).join('')}</ul>`;
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
  const [entityTypes, setEntityTypes] = useState<EntityTypeRow[]>([]);
  const [linkOptionsByDefId, setLinkOptionsByDefId] = useState<Record<string, { id: string; label: string }[]>>({});
  const [linkLoadingByDefId, setLinkLoadingByDefId] = useState<Record<string, boolean>>({});
  const [linkRules, setLinkRules] = useState<LinkRule[]>([]);

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
  const canToggleAccess = props.canManageUsers && (meRole === 'admin' || meRole === 'superadmin');
  const canEditPermissions = canEditAccount;

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

  async function loadCustomDefs() {
    try {
      const defs = await window.matrica.employees.defs();
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
    const value = employee?.attributes?.[def.code];
    if (def.dataType === 'boolean') {
      return (
        <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={Boolean(value)}
            disabled={!props.canEdit}
            onChange={(e) => {
              if (!props.canEdit) return;
              void saveAttr(def.code, e.target.checked);
            }}
          />
          <span style={{ color: '#6b7280', fontSize: 12 }}>{Boolean(value) ? 'да' : 'нет'}</span>
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
            void saveAttr(def.code, fromInputDate(e.target.value));
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
            void saveAttr(def.code, Number.isFinite(next as number) ? next : null);
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
              void saveAttr(def.code, next);
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
      const createHandler =
        props.canEdit && targetCode
          ? async (label: string) => {
              const id = await createLinkedEntity(def, label);
              if (!id) return null;
              await ensureLinkOptions(def);
              void saveAttr(def.code, id);
              return id;
            }
          : null;
      return (
        <SearchSelect
          value={current}
          disabled={!props.canEdit}
          options={options}
          placeholder={loading ? 'Загрузка…' : '(не выбрано)'}
          onChange={(next) => {
            if (!props.canEdit) return;
            void saveAttr(def.code, next || null);
          }}
          {...(createHandler ? { onCreate: createHandler, createLabel: `Новая запись (${targetCode})` } : {})}
        />
      );
    }
    const text = value == null ? '' : String(value);
    return (
      <Input
        value={text}
        disabled={!props.canEdit}
        onChange={(e) => {
          if (!props.canEdit) return;
          void saveAttr(def.code, e.target.value);
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
  }, [employee?.id, employee?.attributes]);

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

  async function saveNameField(code: 'last_name' | 'first_name' | 'middle_name', value: string) {
    await saveAttr(code, value.trim() || null);
    const nextFull = buildFullName(
      code === 'last_name' ? value : lastName,
      code === 'first_name' ? value : firstName,
      code === 'middle_name' ? value : middleName,
    );
    await saveAttr('full_name', nextFull || null);
  }

  function printEmployeeCard() {
    const attrs = employee?.attributes ?? {};
    const mainRows: Array<[string, string]> = [
      ['ФИО', computedFullName],
      ['Табельный номер', personnelNumber],
      ['Должность', position],
      ['Подразделение', departmentLabel || ''],
      ['Дата рождения', birthDate || ''],
    ];
    const employmentRows: Array<[string, string]> = [
      ['Статус', employmentStatus === 'terminated' ? 'Уволен' : 'Работает'],
      ['Дата приема', hireDate || ''],
      ['Дата увольнения', terminationDate || ''],
    ];
    const transfersHtml =
      transfers.length === 0
        ? '<div class="muted">Нет данных</div>'
        : `<ul>${transfers
            .map((t) => {
              const dt = t.date ? new Date(t.date).toLocaleDateString('ru-RU') : '';
              return `<li>${escapeHtml(dt)}: ${escapeHtml(String(t.kind ?? ''))} — ${escapeHtml(String(t.value ?? ''))}</li>`;
            })
            .join('')}</ul>`;
    const extraRows = customDefs.map((d) => [d.name || d.code, formatValue((attrs as any)[d.code])]);

    openPrintPreview({
      title: 'Карточка сотрудника',
      subtitle: computedFullName ? `Сотрудник: ${computedFullName}` : undefined,
      sections: [
        { id: 'main', title: 'Основное', html: keyValueTable(mainRows) },
        { id: 'employment', title: 'Кадровые данные', html: keyValueTable(employmentRows) },
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

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
        <strong style={{ fontSize: 18 }}>{computedFullName || 'Карточка сотрудника'}</strong>
        {departmentLabel && <span style={{ color: '#6b7280' }}>• {departmentLabel}</span>}
        <span style={{ flex: 1 }} />
        <Button variant="ghost" onClick={printEmployeeCard}>
          Распечатать
        </Button>
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
        <div style={{ color: '#6b7280' }}>Табельный номер</div>
        <Input
          value={personnelNumber}
          onChange={(e) => setPersonnelNumber(e.target.value)}
          onBlur={() => void saveAttr('personnel_number', personnelNumber.trim() || null)}
          disabled={!props.canEdit}
          placeholder="Табельный номер"
        />
        <div style={{ color: '#6b7280' }}>Дата рождения</div>
        <Input
          type="date"
          value={birthDate}
          onChange={(e) => setBirthDate(e.target.value)}
          onBlur={() => void saveAttr('birth_date', fromInputDate(birthDate))}
          disabled={!props.canEdit}
        />
        <div style={{ color: '#6b7280' }}>Должность</div>
        <Input
          value={position}
          onChange={(e) => setPosition(e.target.value)}
          onBlur={() => void saveAttr('role', position.trim() || null)}
          disabled={!props.canEdit}
          placeholder="Должность"
        />
        <div style={{ color: '#6b7280' }}>Статус</div>
        <select
          value={employmentStatus}
          onChange={async (e) => {
            const next = e.target.value === 'fired' ? 'fired' : 'working';
            setEmploymentStatus(next);
            await saveAttr('employment_status', next);
            if (next === 'fired' && canToggleAccess) {
              const r = await window.matrica.admin.users.update(props.employeeId, { accessEnabled: false });
              setAccountStatus(r.ok ? 'Доступ отключён (уволен)' : `Ошибка: ${r.error ?? 'unknown'}`);
              await loadAccountPerms();
              if (r.ok) props.onAccessChanged?.();
            }
          }}
          disabled={!props.canEdit}
          style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
        >
          <option value="working">работает</option>
          <option value="fired">уволен</option>
        </select>
        <div style={{ color: '#6b7280' }}>Дата приема</div>
        <Input
          type="date"
          value={hireDate}
          onChange={(e) => setHireDate(e.target.value)}
          onBlur={() => void saveAttr('hire_date', fromInputDate(hireDate))}
          disabled={!props.canEdit}
        />
        <div style={{ color: '#6b7280' }}>Дата увольнения</div>
        <Input
          type="date"
          value={terminationDate}
          onChange={(e) => setTerminationDate(e.target.value)}
          onBlur={() => void saveAttr('termination_date', fromInputDate(terminationDate))}
          disabled={!props.canEdit}
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

      <div style={{ marginTop: 18, border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <strong>Переводы</strong>
          <span style={{ flex: 1 }} />
        </div>
        <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
          {transfers.length === 0 && <div style={{ color: '#6b7280' }}>Переводов нет</div>}
          {transfers.map((t) => (
            <div key={t.id} style={{ display: 'grid', gridTemplateColumns: '160px 140px 1fr 120px', gap: 8, alignItems: 'center' }}>
              <div style={{ color: '#111827' }}>{t.kind === 'department' ? 'Подразделение' : 'Должность'}</div>
              <div style={{ color: '#6b7280' }}>{t.date ? new Date(t.date).toLocaleDateString('ru-RU') : '—'}</div>
              <div style={{ color: '#111827' }}>{t.value || '—'}</div>
              <Button
                variant="ghost"
                onClick={async () => {
                  if (!props.canEdit) return;
                  const next = transfers.filter((x) => x.id !== t.id);
                  setTransfers(next);
                  await saveAttr('transfers', next);
                }}
                disabled={!props.canEdit}
              >
                Удалить
              </Button>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '160px 180px 1fr 140px', gap: 8, alignItems: 'center' }}>
          <select
            value={transferKind}
            onChange={(e) => setTransferKind(e.target.value)}
            disabled={!props.canEdit}
            style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
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
              setTransfers(next);
              setTransferValue('');
              setTransferDate('');
              await saveAttr('transfers', next);
            }}
            disabled={!props.canEdit}
          >
            Добавить
          </Button>
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
          const r = await window.matrica.employees.setAttr(props.employeeId, 'attachments', next);
          return r.ok ? { ok: true as const } : { ok: false as const, error: r.error ?? 'unknown' };
        }}
      />

      <div style={{ marginTop: 18, border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <strong>Дополнительные поля</strong>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" onClick={() => void loadCustomDefs()}>
            Обновить
          </Button>
        </div>

        <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '200px 1fr', gap: 10, alignItems: 'center', maxWidth: 820 }}>
          {customDefs.length === 0 && <div style={{ color: '#6b7280' }}>(доп. полей нет)</div>}
          {customDefs.map((def) => (
            <React.Fragment key={def.id}>
              <div style={{ color: '#6b7280' }}>{def.name}</div>
              {renderCustomField(def)}
            </React.Fragment>
          ))}
        </div>

        {props.canEdit && (
          <div style={{ marginTop: 12, borderTop: '1px solid #f3f4f6', paddingTop: 12 }}>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>Добавить поле</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 180px 200px 140px', gap: 8, alignItems: 'center' }}>
              <Input value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder="Название поля" />
              <select
                value={customDataType}
                onChange={(e) => setCustomDataType(e.target.value)}
                style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
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
                    style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
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
                    {!recommendedLinkCode && <span style={{ color: '#6b7280', fontSize: 12 }}>Нет рекомендации</span>}
                  </div>
                  {(standardType || recommendedType) && (
                    <div style={{ color: '#6b7280', fontSize: 12 }}>
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
                <div style={{ color: '#6b7280', fontSize: 12 }}>Тип данных</div>
              )}
              <Button onClick={async () => void createCustomField()} disabled={!customName.trim()}>
                Добавить
              </Button>
            </div>
            {customStatus && <div style={{ marginTop: 8, color: customStatus.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{customStatus}</div>}
          </div>
        )}
      </div>

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
