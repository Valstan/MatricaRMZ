/**
 * Import the authoritative employee roster from a semicolon-separated CP1251 CSV.
 *
 * Safe by default: dry-run only. Matching never uses fuzzy names automatically:
 *   1. unique personnel number;
 *   2. exact normalized full name, only when the existing personnel number is empty
 *      or equal and a populated birth date does not conflict;
 *   3. everything suspicious is reported and blocks --apply.
 *
 * Всё, что называет конкретных людей, задаётся аргументами запуска — в репо ФИО и
 * табельных номеров нет (D-041). Разовые решения владельца по конкретному файлу
 * (кого выбросить, чью опечатку в ФИО считать тем же человеком, кого сверить глазами)
 * живут в командной строке того прогона, а не в коде.
 *
 * Usage:
 *   pnpm -F @matricarmz/backend-api employees:import-csv -- --file=/path/staff.csv
 *   pnpm -F @matricarmz/backend-api employees:import-csv -- --file=/path/staff.csv --apply
 *   … --drop-personnel=566,610          выбросить строки с этими табельными
 *   … --name-alias="ФИО в файле=ФИО в базе;…"   считать разное написание одним человеком
 *   … --verify="Фамилия Имя Отчество;…"  распечатать, какие карточки нашлись по этим ФИО
 */
import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { SyncTableName } from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { recordSyncChanges } from '../services/sync/syncChangeService.js';
import { upsertWorkshop } from '../services/workshopsService.js';

type Actor = { id: string; username: string; role: 'superadmin' };
type SourceEmployee = {
  sourceLine: number;
  section: string;
  fullName: string;
  lastName: string;
  firstName: string;
  middleName: string;
  personnelNumber: string;
  role: string;
  hireDate: number;
  birthDate: number;
  note: string | null;
};
type ExistingEmployee = {
  id: string;
  fullName: string;
  lastName: string;
  firstName: string;
  middleName: string;
  personnelNumber: string;
  role: string;
  hireDate: number | null;
  birthDate: number | null;
  employmentStatus: string;
  departmentId: string;
  workshopId: string;
  values: Map<string, { id: string; valueJson: string | null; createdAt: number }>;
};
type SectionTarget = { kind: 'department'; id: string; name: string } | { kind: 'workshop'; id: string; name: string };
type PlannedSectionTarget = SectionTarget & { create: boolean; code?: string };
type Ambiguity = { source: SourceEmployee; reason: string; candidates: ExistingEmployee[] };

const APPLY = process.argv.includes('--apply');
const fileArg = process.argv.find((arg) => arg.startsWith('--file='));
const FILE = fileArg?.slice('--file='.length).trim() ?? '';
const actorArg = process.argv.find((arg) => arg.startsWith('--actor='));
const ACTOR_OVERRIDE = actorArg?.slice('--actor='.length).trim() || null;

/** Всё, что называет конкретных людей, приходит аргументом запуска — в репо имён нет (D-041). */
function listArg(flag: string, separator = ';'): string[] {
  const raw = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  return (raw ? raw.slice(flag.length + 1) : '')
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** ФИО, по которым печатать разрешение карточек: --verify="Фамилия Имя Отчество;…". */
const VERIFY_NAMES = listArg('--verify');
/** Табельные номера, которые надо выбросить из файла (вторая карточка одного человека). */
const DROPPED_PERSONNEL = new Set(listArg('--drop-personnel', ','));

function norm(value: unknown): string {
  return String(value ?? '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim();
}

function personnelKey(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return /^\d+$/.test(text) ? String(Number(text)) : norm(text);
}

function parseJson(value: string | null): unknown {
  if (value == null) return null;
  try { return JSON.parse(value); } catch { return value; }
}

function textValue(value: string | null): string {
  const parsed = parseJson(value);
  return parsed == null ? '' : String(parsed).trim();
}

function numberValue(value: string | null): number | null {
  const parsed = parseJson(value);
  if (parsed == null || parsed === '') return null;
  const number = Number(parsed);
  return Number.isFinite(number) ? number : null;
}

function parseDate(value: string, sourceLine: number, label: string): number {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value.trim());
  if (!match) throw new Error(`Строка ${sourceLine}: неверная ${label}: «${value}»`);
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error(`Строка ${sourceLine}: несуществующая ${label}: «${value}»`);
  }
  return date.getTime();
}

function dateRu(value: number | null): string {
  if (value == null) return '—';
  const d = new Date(value);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function parseName(raw: string, sourceLine: number) {
  const noteMatch = raw.match(/\s*(\([^)]*\))\s*$/u);
  const fullName = raw.replace(/\s*\([^)]*\)\s*$/u, '').replace(/\s+/g, ' ').trim();
  const parts = fullName.split(' ').filter(Boolean);
  if (parts.length < 2 || parts.length > 3) throw new Error(`Строка ${sourceLine}: ФИО нельзя разделить безопасно: «${raw}»`);
  return {
    fullName,
    lastName: parts[0]!,
    firstName: parts[1]!,
    middleName: parts[2] ?? '',
    note: noteMatch?.[1] ?? null,
  };
}

async function loadSource(): Promise<SourceEmployee[]> {
  if (!FILE) throw new Error('Нужен --file=/path/to/staff.csv');
  const bytes = await readFile(FILE);
  const text = new TextDecoder('windows-1251').decode(bytes).replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  const result: SourceEmployee[] = [];
  let section = '';
  for (let index = 0; index < lines.length; index++) {
    const sourceLine = index + 1;
    const raw = lines[index]?.trimEnd() ?? '';
    if (!raw.trim()) continue;
    const cells = raw.split(';').map((cell) => cell.trim());
    const first = cells[0] ?? '';
    if (first === 'Подразделение' || first === '№') continue;
    if (!/^\d+$/.test(first)) {
      section = first.replace(/\s+/g, ' ').trim();
      continue;
    }
    if (!section) throw new Error(`Строка ${sourceLine}: сотрудник вне подразделения`);
    const name = parseName(cells[1] ?? '', sourceLine);
    const personnelNumber = String(cells[2] ?? '').trim();
    if (!personnelNumber) throw new Error(`Строка ${sourceLine}: пустой табельный номер`);
    result.push({
      sourceLine,
      section,
      ...name,
      personnelNumber,
      role: String(cells[3] ?? '').trim(),
      hireDate: parseDate(cells[4] ?? '', sourceLine, 'дата приема'),
      birthDate: parseDate(cells[5] ?? '', sourceLine, 'дата рождения'),
    });
  }
  // Внутреннее совместительство — это текущий табельный на ОДНОЙ карточке, а не вторая
  // карточка: лишние строки такого рода называет --drop-personnel (см. шапку).
  const resolved = result.filter((row) => !DROPPED_PERSONNEL.has(personnelKey(row.personnelNumber)));
  const duplicatePersonnel = [...indexMany(resolved, (row) => row.personnelNumber).entries()].filter(([, rows]) => rows.length > 1);
  if (duplicatePersonnel.length) throw new Error(`В CSV повторяются табельные номера: ${duplicatePersonnel.map(([key]) => key).join(', ')}`);
  return resolved;
}

async function getEntityTypeId(code: string): Promise<string> {
  const r = await pool.query('select id::text as id from entity_types where code=$1 and deleted_at is null limit 1', [code]);
  if (!r.rows[0]) throw new Error(`entity_type '${code}' not found`);
  return String(r.rows[0].id);
}

async function loadDefIds(typeId: string): Promise<Map<string, string>> {
  const r = await pool.query(
    'select id::text as id, code from attribute_defs where entity_type_id=$1 and deleted_at is null',
    [typeId],
  );
  return new Map(r.rows.map((row: any) => [String(row.code), String(row.id)]));
}

async function resolveActor(employeeTypeId: string, defs: Map<string, string>): Promise<Actor> {
  const roleDef = defs.get('system_role');
  const loginDef = defs.get('login');
  if (!roleDef || !loginDef) throw new Error('У employee нет system_role/login defs');
  const r = await pool.query(
    `select e.id::text as id, trim(both '"' from login.value_json) as username
       from entities e
       join attribute_values role on role.entity_id=e.id and role.attribute_def_id=$1 and role.deleted_at is null
            and trim(both '"' from role.value_json)='superadmin'
       join attribute_values login on login.entity_id=e.id and login.attribute_def_id=$2 and login.deleted_at is null
      where e.type_id=$3 and e.deleted_at is null order by username`,
    [roleDef, loginDef, employeeTypeId],
  );
  const pick = ACTOR_OVERRIDE ? r.rows.find((row: any) => String(row.username) === ACTOR_OVERRIDE) : r.rows[0];
  if (!pick) throw new Error(ACTOR_OVERRIDE ? `superadmin --actor=${ACTOR_OVERRIDE} не найден` : 'superadmin не найден');
  return { id: String(pick.id), username: String(pick.username), role: 'superadmin' };
}

async function loadExistingEmployees(typeId: string, defs: Map<string, string>): Promise<ExistingEmployee[]> {
  const relevantCodes = ['full_name', 'last_name', 'first_name', 'middle_name', 'personnel_number', 'role', 'hire_date', 'birth_date', 'employment_status', 'department_id', 'workshop_id'];
  const defById = new Map<string, string>();
  for (const code of relevantCodes) {
    const id = defs.get(code);
    if (!id) throw new Error(`У employee отсутствует attr def '${code}'`);
    defById.set(id, code);
  }
  const entitiesResult = await pool.query('select id::text as id from entities where type_id=$1 and deleted_at is null', [typeId]);
  const byId = new Map<string, ExistingEmployee>();
  for (const row of entitiesResult.rows) {
    const id = String(row.id);
    byId.set(id, { id, fullName: '', lastName: '', firstName: '', middleName: '', personnelNumber: '', role: '', hireDate: null, birthDate: null, employmentStatus: '', departmentId: '', workshopId: '', values: new Map() });
  }
  if (!byId.size) return [];
  const values = await pool.query(
    `select av.id::text as id, av.entity_id::text as entity_id, av.attribute_def_id::text as def_id,
            av.value_json, av.created_at
       from attribute_values av join entities e on e.id=av.entity_id
      where e.type_id=$1 and e.deleted_at is null and av.deleted_at is null and av.attribute_def_id = any($2::uuid[])`,
    [typeId, [...defById.keys()]],
  );
  for (const row of values.rows as any[]) {
    const employee = byId.get(String(row.entity_id));
    const code = defById.get(String(row.def_id));
    if (!employee || !code) continue;
    employee.values.set(code, { id: String(row.id), valueJson: row.value_json == null ? null : String(row.value_json), createdAt: Number(row.created_at) });
    if (code === 'hire_date' || code === 'birth_date') employee[code === 'hire_date' ? 'hireDate' : 'birthDate'] = numberValue(row.value_json);
    else (employee as any)[({ full_name: 'fullName', last_name: 'lastName', first_name: 'firstName', middle_name: 'middleName', personnel_number: 'personnelNumber', role: 'role', employment_status: 'employmentStatus', department_id: 'departmentId', workshop_id: 'workshopId' } as Record<string, string>)[code]!] = textValue(row.value_json);
  }
  for (const employee of byId.values()) {
    if (!employee.fullName) employee.fullName = [employee.lastName, employee.firstName, employee.middleName].filter(Boolean).join(' ');
  }
  return [...byId.values()];
}

async function loadNamedEntities(typeCode: string): Promise<Array<{ id: string; name: string }>> {
  const typeId = await getEntityTypeId(typeCode);
  const defs = await loadDefIds(typeId);
  const nameDef = defs.get('name');
  if (!nameDef) throw new Error(`У ${typeCode} отсутствует attr def 'name'`);
  const r = await pool.query(
    `select e.id::text as id, trim(both '"' from av.value_json) as name
       from entities e join attribute_values av on av.entity_id=e.id and av.attribute_def_id=$1 and av.deleted_at is null
      where e.type_id=$2 and e.deleted_at is null`,
    [nameDef, typeId],
  );
  return r.rows.map((row: any) => ({ id: String(row.id), name: String(row.name ?? '').trim() })).filter((row: any) => row.name);
}

async function loadSectionTargets(): Promise<{ targets: Map<string, SectionTarget[]>; departments: Array<{ id: string; name: string }>; workshops: Array<{ id: string; code: string; name: string }> }> {
  const targets = new Map<string, SectionTarget[]>();
  const departments = await loadNamedEntities('department');
  const workshopsResult = await pool.query('select id::text as id, code, name from directory_workshops where deleted_at is null');
  const workshopsWithCode = workshopsResult.rows.map((row: any) => ({ id: String(row.id), code: String(row.code ?? ''), name: String(row.name ?? '').trim() }));
  const all: SectionTarget[] = [
    ...departments.map((row) => ({ kind: 'department' as const, ...row })),
    ...workshopsWithCode.map((row) => ({ kind: 'workshop' as const, id: row.id, name: row.name })),
  ];
  for (const target of all) targets.set(norm(target.name), [...(targets.get(norm(target.name)) ?? []), target]);
  return { targets, departments, workshops: workshopsWithCode };
}

const DEPARTMENT_CANONICAL_NAMES: Record<string, string> = {
  [norm('управление')]: 'Управление',
  [norm('ремонтно-эксплуатационная службы (РЭС)')]: 'Ремонтно-эксплуатационная служба (РЭС)',
  [norm('Малмыжский ремзавод-НН')]: 'Малмыжский ремзавод-НН',
  [norm('Малмыжский ремзавод')]: 'Малмыжский ремзавод',
  [norm('технический отдел')]: 'Технический отдел',
  [norm('Отдел по работе с военным представительством')]: 'Отдел по работе с военным представительством',
  [norm('служба безопасности')]: 'Служба безопасности',
  [norm('отдел по работе с ГОЗ')]: 'Отдел по работе с ГОЗ',
  [norm('отдел учёта готовой продукции')]: 'Отдел учёта готовой продукции',
  [norm('служба обеспечения')]: 'Служба обеспечения',
  [norm('отдел снабжения и обеспечения')]: 'Снабжение',
  [norm('планово-экономический отдел')]: 'Планово-экономический отдел',
  [norm('транспортный цех')]: 'Транспортный цех',
  [norm('отдел информационных технологий')]: 'Отдел информационных технологий',
  [norm('отдел технического контроля')]: 'ОТК',
  [norm('склад')]: 'Склад',
  [norm('Малмыжский ремзавод-ЕКБ')]: 'Малмыжский ремзавод-ЕКБ',
  [norm('планово-диспетчерский отдел')]: 'Планово-диспетчерский отдел',
};

function workshopNumber(section: string): string | null {
  const match = /цех\s*№\s*(\d+)/iu.exec(section);
  return match?.[1] ?? null;
}

function planSections(
  sections: string[],
  existing: Awaited<ReturnType<typeof loadSectionTargets>>,
): { bySource: Map<string, PlannedSectionTarget>; createDepartments: PlannedSectionTarget[]; createWorkshops: PlannedSectionTarget[]; errors: string[] } {
  const bySource = new Map<string, PlannedSectionTarget>();
  const createDepartments: PlannedSectionTarget[] = [];
  const createWorkshops: PlannedSectionTarget[] = [];
  const errors: string[] = [];
  for (const section of [...new Set(sections)]) {
    const number = workshopNumber(section);
    if (number) {
      const matches = existing.workshops.filter((row) => personnelKey(row.code) === personnelKey(number) || norm(row.name) === norm(`Цех №${number}`));
      if (matches.length > 1) { errors.push(`«${section}»: несколько цехов №${number}`); continue; }
      const target: PlannedSectionTarget = matches[0]
        ? { kind: 'workshop', id: matches[0].id, name: matches[0].name, create: false, code: matches[0].code }
        : { kind: 'workshop', id: randomUUID(), name: `Цех №${number}`, create: true, code: number };
      bySource.set(norm(section), target);
      if (target.create) createWorkshops.push(target);
      continue;
    }
    const desiredName = DEPARTMENT_CANONICAL_NAMES[norm(section)] ?? section.replace(/\s+/g, ' ').trim();
    const matches = existing.departments.filter((row) => norm(row.name) === norm(desiredName));
    if (matches.length > 1) { errors.push(`«${section}»: несколько подразделений «${desiredName}»`); continue; }
    const target: PlannedSectionTarget = matches[0]
      ? { kind: 'department', id: matches[0].id, name: matches[0].name, create: false }
      : { kind: 'department', id: randomUUID(), name: desiredName, create: true };
    bySource.set(norm(section), target);
    if (target.create) createDepartments.push(target);
  }
  return { bySource, createDepartments, createWorkshops, errors };
}

function indexMany<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    if (!value) continue;
    result.set(value, [...(result.get(value) ?? []), row]);
  }
  return result;
}

function candidateLabel(employee: ExistingEmployee): string {
  return `${employee.fullName || 'без ФИО'} [таб. ${employee.personnelNumber || '—'}, рожд. ${dateRu(employee.birthDate)}, id=${employee.id}]`;
}

/** Опечатки в ФИО существующих карточек: --name-alias="ФИО в файле=ФИО в базе;…". */
const EXISTING_NAME_ALIASES: Record<string, string> = Object.fromEntries(
  listArg('--name-alias')
    .map((pair) => pair.split('='))
    .filter((parts) => parts.length === 2 && parts[0]!.trim() && parts[1]!.trim())
    .map(([from, to]) => [norm(from), norm(to)]),
);

async function main() {
  console.log(APPLY ? '!!! EMPLOYEE CSV APPLY !!!' : '--- EMPLOYEE CSV DRY-RUN (no writes) ---');
  const source = await loadSource();
  const employeeTypeId = await getEntityTypeId('employee');
  const defs = await loadDefIds(employeeTypeId);
  const existing = await loadExistingEmployees(employeeTypeId, defs);
  const actor = await resolveActor(employeeTypeId, defs);
  const sectionCatalog = await loadSectionTargets();
  const sectionPlan = planSections(source.map((row) => row.section), sectionCatalog);
  const byPersonnel = indexMany(existing, (row) => personnelKey(row.personnelNumber));
  const byName = indexMany(existing, (row) => norm(row.fullName));
  const sourceByPersonnel = new Map(source.map((row) => [personnelKey(row.personnelNumber), row] as const));
  const repeatedSourceNameKeys = new Set(
    [...indexMany(source, (row) => norm(row.fullName)).entries()].filter(([, rows]) => rows.length > 1).map(([key]) => key),
  );

  const matched: Array<{ source: SourceEmployee; employee: ExistingEmployee; via: 'personnel' | 'name' }> = [];
  const creates: SourceEmployee[] = [];
  const ambiguities: Ambiguity[] = [];
  const unmappedSections = new Map<string, SourceEmployee[]>();

  for (const row of source) {
    const personnelMatches = byPersonnel.get(personnelKey(row.personnelNumber)) ?? [];
    if (personnelMatches.length === 1) {
      matched.push({ source: row, employee: personnelMatches[0]!, via: 'personnel' });
      continue;
    }
    if (personnelMatches.length > 1) {
      const exactName = personnelMatches.filter((candidate) => norm(candidate.fullName) === norm(row.fullName));
      if (exactName.length === 1) {
        matched.push({ source: row, employee: exactName[0]!, via: 'personnel' });
        continue;
      }
      ambiguities.push({ source: row, reason: 'табельный номер уже у нескольких карточек', candidates: personnelMatches });
      continue;
    }
    const matchNameKey = EXISTING_NAME_ALIASES[norm(row.fullName)] ?? norm(row.fullName);
    const nameMatches = byName.get(matchNameKey) ?? [];
    const safeNameMatches = nameMatches.filter((candidate) => {
      const currentPersonnelOwner = sourceByPersonnel.get(personnelKey(candidate.personnelNumber));
      const personnelCompatible = !candidate.personnelNumber || personnelKey(candidate.personnelNumber) === personnelKey(row.personnelNumber)
        || !currentPersonnelOwner || norm(currentPersonnelOwner.fullName) === norm(row.fullName);
      const birthCompatible = candidate.birthDate == null || candidate.birthDate === row.birthDate;
      return personnelCompatible && birthCompatible;
    });
    if (safeNameMatches.length === 1 && nameMatches.length === 1 && !repeatedSourceNameKeys.has(norm(row.fullName))) {
      matched.push({ source: row, employee: safeNameMatches[0]!, via: 'name' });
      continue;
    }
    if (nameMatches.length) {
      ambiguities.push({ source: row, reason: 'совпало ФИО, но табельный номер/дата рождения не позволяют безопасно выбрать карточку', candidates: nameMatches });
      continue;
    }
    const sameBirth = existing.filter((candidate) => candidate.birthDate === row.birthDate);
    if (sameBirth.length) {
      ambiguities.push({ source: row, reason: 'нет точного ФИО, но дата рождения уже встречается в базе', candidates: sameBirth });
      continue;
    }
    creates.push(row);
  }

  for (const row of source) if (!sectionPlan.bySource.has(norm(row.section))) unmappedSections.set(row.section, [...(unmappedSections.get(row.section) ?? []), row]);

  const desiredValues = (row: SourceEmployee, target: SectionTarget | null): Record<string, unknown> => ({
    full_name: row.fullName,
    last_name: row.lastName,
    first_name: row.firstName,
    middle_name: row.middleName || null,
    personnel_number: row.personnelNumber,
    role: row.role,
    hire_date: row.hireDate,
    birth_date: row.birthDate,
    employment_status: 'working',
    ...(target?.kind === 'department' ? { department_id: target.id, workshop_id: null } : {}),
    ...(target?.kind === 'workshop' ? { workshop_id: target.id, department_id: null } : {}),
  });

  let changedCards = 0;
  let changedValues = 0;
  let unchangedValues = 0;
  for (const item of matched) {
    const target = sectionPlan.bySource.get(norm(item.source.section)) ?? null;
    let cardChanged = false;
    for (const [code, value] of Object.entries(desiredValues(item.source, target))) {
      const next = JSON.stringify(value);
      const current = item.employee.values.get(code)?.valueJson ?? null;
      if (current === next) unchangedValues++;
      else { changedValues++; cardChanged = true; }
    }
    if (cardChanged) changedCards++;
  }

  console.log(`source employees: ${source.length}; existing active cards: ${existing.length}`);
  console.log(`matched: ${matched.length} (personnel ${matched.filter((x) => x.via === 'personnel').length}, exact name ${matched.filter((x) => x.via === 'name').length})`);
  console.log(`would create: ${creates.length}; would update cards: ${changedCards}; changed values: ${changedValues}; unchanged values: ${unchangedValues}`);
  console.log(`ambiguous: ${ambiguities.length}; section errors: ${sectionPlan.errors.length}; actor: ${actor.username}`);
  console.log(`sections to create: departments ${sectionPlan.createDepartments.length}, workshops ${sectionPlan.createWorkshops.length}`);

  if (VERIFY_NAMES.length) {
    console.log('\nVERIFY OWNER RESOLUTIONS:');
    for (const name of VERIFY_NAMES) {
      const rows = existing.filter((employee) => norm(employee.fullName) === norm(name));
      if (!rows.length) console.log(`  - ${name}: NOT FOUND`);
      for (const employee of rows) console.log(`  - ${employee.fullName}: таб. ${employee.personnelNumber || '—'}, должность «${employee.role || '—'}», статус ${employee.employmentStatus || 'working'}, рожд. ${dateRu(employee.birthDate)}`);
    }
  }

  const personnelChanges = matched.filter((item) => item.employee.personnelNumber && personnelKey(item.employee.personnelNumber) !== personnelKey(item.source.personnelNumber));
  if (personnelChanges.length) {
    console.log(`\nPERSONNEL NUMBER CHANGES FROM SOURCE (${personnelChanges.length}):`);
    for (const item of personnelChanges) console.log(`  - ${item.source.fullName}: ${item.employee.personnelNumber} -> ${item.source.personnelNumber}`);
  }

  if (unmappedSections.size || sectionPlan.errors.length) {
    console.log('\nUNMAPPED SECTIONS (blocks apply):');
    for (const [section, rows] of unmappedSections) {
      const candidates = [...sectionCatalog.targets.values()].flat().filter((target) => norm(target.name).includes(norm(section)) || norm(section).includes(norm(target.name)));
      console.log(`  - «${section}» (${rows.length} employees); candidates: ${candidates.map((x) => `${x.kind}:${x.name}`).join(', ') || 'none'}`);
    }
    for (const error of sectionPlan.errors) console.log(`  - ${error}`);
  }
  if (ambiguities.length) {
    console.log('\nAMBIGUITIES (blocks apply):');
    for (const item of ambiguities) {
      console.log(`  - CSV line ${item.source.sourceLine}: ${item.source.fullName} [таб. ${item.source.personnelNumber}, рожд. ${dateRu(item.source.birthDate)}] — ${item.reason}`);
      for (const candidate of item.candidates) console.log(`      ? ${candidateLabel(candidate)}`);
    }
  }
  if (!APPLY) {
    console.log('\nDry-run complete; no writes.');
    await pool.end();
    return;
  }
  if (ambiguities.length || unmappedSections.size || sectionPlan.errors.length) {
    throw new Error('Apply blocked: resolve ambiguities and section mappings first');
  }

  for (const workshop of sectionPlan.createWorkshops) {
    const result = await upsertWorkshop({ code: workshop.code!, name: workshop.name, isActive: true, displayOrder: Number(workshop.code) || 0 });
    if (!result.ok) throw new Error(`Не удалось создать ${workshop.name}: ${result.error}`);
    workshop.id = result.id;
    console.log(`created workshop: ${workshop.name} (${workshop.id})`);
  }

  const ts = Date.now();
  const entityRows: Record<string, unknown>[] = [];
  const valueRows: Record<string, unknown>[] = [];
  const departmentTypeId = await getEntityTypeId('department');
  const departmentDefs = await loadDefIds(departmentTypeId);
  const departmentNameDef = departmentDefs.get('name');
  if (!departmentNameDef) throw new Error("У department отсутствует attr def 'name'");
  for (const department of sectionPlan.createDepartments) {
    entityRows.push({ id: department.id, type_id: departmentTypeId, created_at: ts, updated_at: ts, deleted_at: null, sync_status: 'synced' });
    valueRows.push({ id: randomUUID(), entity_id: department.id, attribute_def_id: departmentNameDef, value_json: JSON.stringify(department.name), created_at: ts, updated_at: ts, deleted_at: null, sync_status: 'synced' });
  }
  const plans = [
    ...matched.map((item) => ({ source: item.source, employee: item.employee })),
    ...creates.map((sourceRow) => ({ source: sourceRow, employee: null as ExistingEmployee | null })),
  ];
  for (const plan of plans) {
    const target = sectionPlan.bySource.get(norm(plan.source.section))!;
    const entityId = plan.employee?.id ?? randomUUID();
    if (!plan.employee) entityRows.push({ id: entityId, type_id: employeeTypeId, created_at: ts, updated_at: ts, deleted_at: null, sync_status: 'synced' });
    for (const [code, value] of Object.entries(desiredValues(plan.source, target))) {
      const defId = defs.get(code);
      if (!defId) throw new Error(`Missing employee attr def '${code}'`);
      const current = plan.employee?.values.get(code);
      const next = JSON.stringify(value);
      if (current?.valueJson === next) continue;
      valueRows.push({ id: current?.id ?? randomUUID(), entity_id: entityId, attribute_def_id: defId, value_json: next, created_at: current?.createdAt ?? ts, updated_at: ts, deleted_at: null, sync_status: 'synced' });
    }
  }

  const push = async (tableName: SyncTableName, rows: Record<string, unknown>[]) => {
    const chunk = 1000;
    for (let index = 0; index < rows.length; index += chunk) {
      const batch = rows.slice(index, index + chunk);
      await recordSyncChanges(actor, batch.map((row) => ({ op: 'upsert' as const, tableName, rowId: String(row.id), payload: row })), { allowSyncConflicts: true });
      console.log(`${tableName}: ${Math.min(index + chunk, rows.length)}/${rows.length}`);
    }
  };
  await push(SyncTableName.Entities, entityRows);
  await push(SyncTableName.AttributeValues, valueRows);
  console.log(`Applied: created ${entityRows.length}, attribute values ${valueRows.length}`);
  await pool.end();
}

main().catch(async (error) => {
  console.error('FATAL:', error instanceof Error ? error.message : String(error));
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
