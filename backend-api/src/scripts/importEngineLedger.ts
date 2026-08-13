/**
 * Импорт учётной таблицы двигателей владельца (`учет двигателей.csv`).
 *
 * Разбор, правила сопоставления и решения владельца — `docs/plans/engine-import-2026-08-13.md`.
 * Коротко: файл — источник истины; двигатель ищется по номеру; недостающие заводятся;
 * повторы номера внутри файла становятся отдельными карточками заездов; договор
 * прописывается только при единственном кандидате.
 *
 * Dry-run по умолчанию (НИКАКИХ записей). Флаги:
 *   --file=<path>        — CSV (CP1251 или UTF-8), обязателен
 *   --apply              — выполнить запись
 *   --actor=<username>   — актор change_log (по умолчанию первый superadmin)
 *   --limit=<n>          — обработать только первые n строк (для проверки на малом объёме)
 *
 *   pnpm -F @matricarmz/backend-api engines:import -- --file=/path/to.csv
 *   pnpm -F @matricarmz/backend-api engines:import -- --file=/path/to.csv --apply
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { ENGINE_FLAT_FIELDS, SyncTableName } from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { createEntity, setEntityAttribute, upsertAttributeDef } from '../services/adminMasterdataService.js';
import { recordSyncChanges } from '../services/sync/syncChangeService.js';

const APPLY = process.argv.includes('--apply');
const arg = (name: string) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};
const FILE = arg('file');
const ACTOR_OVERRIDE = arg('actor');
const LIMIT = Number(arg('limit') ?? '0') || 0;

type Actor = { id: string; username: string; role: 'admin' | 'superadmin' };
const log = (...a: unknown[]) => console.log(...a);

// ── разбор CSV ──────────────────────────────────────────────────────────────
/** Файл выгружен из Excel в CP1251; UTF-8 определяем по BOM/успешному декодированию. */
function readCsv(path: string): string[][] {
  const buf = readFileSync(path);
  let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  // «` `»-мусор от неверной кодировки: в CP1251-файле кириллица даёт U+FFFD
  if (text.includes('�')) text = new TextDecoder('windows-1251').decode(buf);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ';') { row.push(cell); cell = ''; continue; }
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    if (c === '\r') continue;
    cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const COLS = ['customer','brand','engineNo','contract','arrival','arrivalInvoice','defectState','defectDate',
  'shipDate','shipInvoice','note','docsState','aspvrContractor','vpSendReturn','aspvrToCustomer',
  'trackOrAct','aspvrSignedCustomer','returnFromCustomer'] as const;
type Row = Record<(typeof COLS)[number], string> & { line: number };

// ── нормализация ────────────────────────────────────────────────────────────
/** Латиница, визуально совпадающая с кириллицей: без приведения номера расходятся молча. */
const HOMO: Record<string, string> = { A:'А',B:'В',C:'С',E:'Е',H:'Н',K:'К',M:'М',O:'О',P:'Р',T:'Т',X:'Х',Y:'У' };
const keyEngine = (s: string) => s.toUpperCase().replace(/[ABCEHKMOPTXY]/g, (c) => HOMO[c] ?? c);

/** Явные разборы владельца для номеров, которые общее правило берёт неверно. */
const NUMBER_OVERRIDES: Array<[RegExp, string]> = [
  [/^Б\/Н/i, 'б/н'],
  [/^Я09\(4\)АТ6260/i, 'АТ6260'],
  [/^236-170-20-15/i, '236-170-20-15'],
  [/^МНУ\s*2071СРS/i, '2071СРS'],
];

/** Номер двигателя: буквы и цифры слева до первого не-алфанумерика. */
function engineNumber(raw: string): string {
  const s = (raw ?? '').trim();
  for (const [re, value] of NUMBER_OVERRIDES) if (re.test(s)) return value;
  const m = s.match(/^[0-9A-Za-zА-Яа-яЁё]+/);
  return m ? m[0] : '';
}

/** Дата вида «ДД,ММ,ГГ» (встречается и через точку). Текст вместо даты → null. */
function parseDate(raw: string): number | null {
  const m = (raw ?? '').trim().match(/^(\d{1,2})[,.](\d{1,2})[,.](\d{2,4})/);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  const ts = new Date(y, mo - 1, d, 0, 0, 0, 0).getTime();
  return Number.isFinite(ts) ? ts : null;
}

/** Ячейка «дата1/дата2» (скан/оригинал, отправка/возврат) — две самостоятельные даты. */
function parsePair(raw: string): { first: number | null; second: number | null; leftover: string } {
  const s = (raw ?? '').trim();
  if (!s) return { first: null, second: null, leftover: '' };
  const [a = '', b = ''] = s.split('/');
  const first = parseDate(a);
  const second = parseDate(b);
  const leftover = !first && !second && s ? s : '';
  return { first, second, leftover };
}

const norm = (s: string) => (s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^0-9a-zа-я]+/g, '');
/** Для контрагентов ОПФ отбрасывается: «АО "Спецтехника"» и «ООО "СПЕЦТЕХНИКА"» — одно и то же. */
const normCustomer = (s: string) =>
  norm((s ?? '').toLowerCase().replace(/\b(ао|оао|зао|ооо|пао|ано|фгку|фгуп|ип|оо|нпф|мк|рптп|фгбу)\b/g, ' '));

/** Короткий номер: в файле — первая группа цифр; в базе — последние три цифры до первого «/». */
const fileShort = (cell: string) => {
  const m = (cell ?? '').match(/\d+/);
  if (!m) return '';
  return m[0].length >= 3 ? m[0].slice(-3) : m[0];
};
const progShort = (number: string) => {
  const d = (number ?? '').split('/')[0]?.match(/\d/g) ?? [];
  return d.length >= 3 ? d.slice(-3).join('') : '';
};
const fileSection = (cell: string) => {
  const m = (cell ?? '').match(/(?:д\/с|дс|спецификация|спец\.?)\s*№?\s*(\d+)/i);
  return m ? m[1] : null;
};

/** Марки: решения владельца — часть к уже заведённым, часть заводится новой. */
const BRAND_ALIASES: Record<string, string> = {
  'в-59 умс (55)': 'В-59 УМС',
  'д12а-525а': 'ТНВД Д12А-525А',
  'д12-525а': 'ТНВД Д12А-525А',
  'тмз 8435.10': 'ТМЗ 8435.1000175-151',
  '1д12а-525': '1Д12А-525А',
  'в-46-2см1': 'В-46-2С1М',
  'ямз-238-м2': 'ЯМЗ-238М2-48',
  'в-84мс': 'В-84 М',
  'ямз': 'ЯМЗ -236',
};
/** Контрагенты: длинное имя в базе не понижаем до аббревиатуры; «Свет» вместо «Техно-М». */
const CUSTOMER_ALIASES: Record<string, string> = {
  'ао "умз"': 'АО "Ульяновский механический завод"',
  'ао "свет"(техно-м)': 'АО "Свет"',
  '"техно-м"': 'АО "Свет"',
};

// ── доступ к базе ───────────────────────────────────────────────────────────
async function typeId(code: string): Promise<string> {
  const r = await pool.query('select id from entity_types where code=$1 and deleted_at is null limit 1', [code]);
  if (!r.rows[0]) throw new Error(`entity_type '${code}' not found`);
  return String(r.rows[0].id);
}
async function defId(entityTypeId: string, code: string): Promise<string> {
  const r = await pool.query(
    'select id from attribute_defs where entity_type_id=$1 and code=$2 and deleted_at is null limit 1',
    [entityTypeId, code],
  );
  if (!r.rows[0]) throw new Error(`attribute_def '${code}' not found (тип ${entityTypeId}) — обновите клиент, defs заводит карточка`);
  return String(r.rows[0].id);
}
/** Заводит недостающие defs плоских полей. Возвращает коды, которых не хватало. */
async function ensureFlatFieldDefs(engineTypeId: string, actor: Actor): Promise<string[]> {
  const r = await pool.query(
    'select code from attribute_defs where entity_type_id=$1 and deleted_at is null',
    [engineTypeId],
  );
  const have = new Set((r.rows as any[]).map((x) => String(x.code)));
  const missing = ENGINE_FLAT_FIELDS.filter((f) => !have.has(f.code));
  if (!APPLY) return missing.map((f) => f.code);
  for (const f of missing) {
    await upsertAttributeDef(actor, {
      entityTypeId: engineTypeId,
      code: f.code,
      name: f.label,
      dataType: f.kind === 'bool' ? 'boolean' : f.kind,
      sortOrder: f.order,
    });
  }
  return missing.map((f) => f.code);
}

async function resolveActor(employeeTypeId: string): Promise<Actor> {
  const sr = await defId(employeeTypeId, 'system_role');
  const lg = await defId(employeeTypeId, 'login');
  const r = await pool.query(
    `select e.id::text as id, trim(both '"' from lg.value_json) as username
       from entities e
       join attribute_values sr on sr.entity_id=e.id and sr.attribute_def_id=$1 and sr.deleted_at is null
            and trim(both '"' from sr.value_json)='superadmin'
       left join attribute_values lg on lg.entity_id=e.id and lg.attribute_def_id=$2 and lg.deleted_at is null
      where e.type_id=$3 and e.deleted_at is null order by username`,
    [sr, lg, employeeTypeId],
  );
  if (!r.rows.length) throw new Error('нет superadmin — передайте --actor=<username>');
  const pick = ACTOR_OVERRIDE ? r.rows.find((x: any) => String(x.username) === ACTOR_OVERRIDE) : r.rows[0];
  if (!pick) throw new Error(`--actor=${ACTOR_OVERRIDE} не superadmin`);
  return { id: String(pick.id), username: String(pick.username), role: 'superadmin' };
}
/** Все сущности типа с набором атрибутов: id → { code: value }. */
async function loadEntities(code: string, attrs: string[]): Promise<Array<Record<string, any>>> {
  const tid = await typeId(code);
  const r = await pool.query(
    `select e.id::text as id, ad.code as code, av.value_json as value
       from entities e
       join attribute_defs ad on ad.entity_type_id=e.type_id and ad.code = any($2)
       left join attribute_values av on av.entity_id=e.id and av.attribute_def_id=ad.id and av.deleted_at is null
      where e.type_id=$1 and e.deleted_at is null`,
    [tid, attrs],
  );
  const byId = new Map<string, Record<string, any>>();
  for (const row of r.rows as any[]) {
    const id = String(row.id);
    if (!byId.has(id)) byId.set(id, { id });
    let v: any = row.value;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* оставляем как есть */ } }
    byId.get(id)![String(row.code)] = v;
  }
  return [...byId.values()];
}

// ── план ────────────────────────────────────────────────────────────────────
type Plan = {
  kind: 'update' | 'create' | 'create-repeat';
  engineId: string | null;
  number: string;
  row: Row;
  values: Record<string, unknown>;
  manual: string[];
};

async function main() {
  if (!FILE) throw new Error('нужен --file=<path к CSV>');
  log('=== Импорт учётной таблицы двигателей ===');
  log(APPLY ? '!!! РЕЖИМ ЗАПИСИ (--apply) !!!' : '--- DRY-RUN (без записей; --apply для выполнения) ---');

  const raw = readCsv(FILE);
  const body = raw.slice(2).filter((r) => r.some((c) => (c ?? '').trim()));
  const rows: Row[] = body.map((r, i) => {
    const rec: any = { line: i + 3 };
    COLS.forEach((c, j) => { rec[c] = (r[j] ?? '').trim(); });
    return rec as Row;
  });
  const limited = LIMIT ? rows.slice(0, LIMIT) : rows;
  log(`строк в файле: ${rows.length}${LIMIT ? ` (обрабатываю ${limited.length} по --limit)` : ''}`);

  const employeeTypeId = await typeId('employee');
  const engineTypeId = await typeId('engine');
  const customerTypeId = await typeId('customer');
  const brandTypeId = await typeId('engine_brand');
  const actor = await resolveActor(employeeTypeId);
  log(`actor: ${actor.username} (${actor.id})`);

  // Defs плоских полей обычно заводит карточка при первом открытии. На проде
  // релиз может ещё не дойти до клиентов — заводим недостающие сами, из той же
  // таблицы `shared`, что читает карточка (копий описаний нет).
  const missingDefs = await ensureFlatFieldDefs(engineTypeId, actor);
  if (missingDefs.length) {
    log(`-- ${APPLY ? 'заведено' : 'будет заведено'} недостающих полей карточки: ${missingDefs.length} --`);
    for (const c of missingDefs) log(`   + ${c}`);
    log('');
  }

  const engines = await loadEntities('engine', ['engine_number', 'arrival_date', 'customer_id', 'contract_id', 'engine_brand_id']);
  const customers = await loadEntities('customer', ['name', 'short_name']);
  const brands = await loadEntities('engine_brand', ['name']);
  const contracts = await loadEntities('contract', ['number', 'internal_number']);
  log(`в базе: двигателей ${engines.length}, контрагентов ${customers.length}, марок ${brands.length}, договоров ${contracts.length}\n`);

  const engineByNo = new Map<string, Record<string, any>[]>();
  for (const e of engines) {
    const k = keyEngine(String(e.engine_number ?? '').trim());
    if (k) engineByNo.set(k, [...(engineByNo.get(k) ?? []), e]);
  }
  const custByNorm = new Map<string, Record<string, any>>();
  for (const c of customers) for (const f of ['name', 'short_name']) {
    if (c[f]) custByNorm.set(normCustomer(String(c[f])), c);
  }
  const brandByNorm = new Map<string, Record<string, any>>();
  for (const b of brands) if (b.name) brandByNorm.set(norm(String(b.name)), b);
  const contractsByShort = new Map<string, Record<string, any>[]>();
  for (const c of contracts) {
    const s = progShort(String(c.number ?? ''));
    if (s) contractsByShort.set(s, [...(contractsByShort.get(s) ?? []), c]);
  }

  // ── справочники: что придётся завести ──
  const newCustomers = new Map<string, string>();  // norm → отображаемое имя
  const newBrands = new Map<string, string>();
  for (const r of limited) {
    if (r.customer) {
      const alias = CUSTOMER_ALIASES[r.customer.toLowerCase()] ?? r.customer;
      const k = normCustomer(alias);
      if (!custByNorm.has(k) && !newCustomers.has(k)) newCustomers.set(k, alias);
    }
    if (r.brand) {
      const alias = BRAND_ALIASES[r.brand.toLowerCase()] ?? r.brand;
      const k = norm(alias);
      if (!brandByNorm.has(k) && !newBrands.has(k)) newBrands.set(k, alias);
    }
  }
  log(`-- завести контрагентов: ${newCustomers.size} --`);
  for (const n of newCustomers.values()) log(`   + ${n}`);
  log(`\n-- завести марок: ${newBrands.size} --`);
  for (const n of newBrands.values()) log(`   + ${n}`);

  // ── повторы номера внутри файла ──
  const byNumber = new Map<string, Row[]>();
  for (const r of limited) {
    const n = engineNumber(r.engineNo);
    if (!n) continue;
    byNumber.set(keyEngine(n), [...(byNumber.get(keyEngine(n)) ?? []), r]);
  }

  const plans: Plan[] = [];
  const manualAll: string[] = [];
  let contractSet = 0, contractConflict = 0, contractAmbiguous = 0;

  for (const [k, group] of byNumber) {
    const sorted = [...group].sort((a, b) => (parseDate(a.arrival) ?? 0) - (parseDate(b.arrival) ?? 0));
    const existing = engineByNo.get(k) ?? [];
    if (existing.length > 1) {
      manualAll.push(`номер ${k}: в базе ${existing.length} карточек — пропущен целиком`);
      continue;
    }
    const target = existing[0] ?? null;
    // Обновляем ту строку, чья дата прихода совпала с карточкой; иначе самую раннюю.
    let primaryIdx = 0;
    if (target?.arrival_date) {
      const idx = sorted.findIndex((r) => parseDate(r.arrival) === Number(target.arrival_date));
      if (idx >= 0) primaryIdx = idx;
    }

    sorted.forEach((row, idx) => {
      const manual: string[] = [];
      const values: Record<string, unknown> = {};
      const num = engineNumber(row.engineNo);
      values.engine_number = num;

      // контрагент
      if (row.customer) {
        const alias = CUSTOMER_ALIASES[row.customer.toLowerCase()] ?? row.customer;
        values.__customerKey = normCustomer(alias);
      }
      // марка
      if (row.brand) {
        const alias = BRAND_ALIASES[row.brand.toLowerCase()] ?? row.brand;
        values.__brandKey = norm(alias);
      }
      // договор — только единственный кандидат
      const short = fileShort(row.contract);
      if (short) {
        const cands = contractsByShort.get(short) ?? [];
        const current = target?.contract_id ? contracts.find((c) => c.id === target.contract_id) : null;
        if (current && progShort(String(current.number ?? '')) !== short) {
          contractConflict++;
          manual.push(`договор: в файле «${row.contract}», в программе «${current.internal_number ?? current.number}» — не трогаю`);
        } else if (!current) {
          if (cands.length === 1) { values.contract_id = cands[0]!.id; contractSet++; }
          else if (cands.length > 1) { contractAmbiguous++; manual.push(`договор «${row.contract}»: ${cands.length} кандидатов — не трогаю`); }
        }
        const sec = fileSection(row.contract);
        if (sec) values.contract_section_number = sec;
      }

      // даты и накладные
      const arrival = parseDate(row.arrival);
      if (arrival != null) values.arrival_date = arrival;
      else if (row.arrival) manual.push(`дата прихода не разобрана: «${row.arrival}»`);
      if (row.arrivalInvoice) values.arrival_invoice = row.arrivalInvoice;
      const defect = parseDate(row.defectDate);
      if (defect != null) values.defect_date = defect;
      const ship = parseDate(row.shipDate);
      if (ship != null) {
        values.status_customer_sent_date = ship;
        values.status_customer_sent = true;
      }
      if (row.shipInvoice) values.shipment_invoice = row.shipInvoice;
      if (/утиль/i.test(row.defectState)) values.status_scrap_confirmed = true;
      if (row.note) values.engine_note = row.note;

      // отчётные документы
      const docsNote: string[] = [];
      if (row.docsState) values.docs_state = row.docsState;
      const ac = parseDate(row.aspvrContractor);
      if (ac != null) values.docs_aspvr_contractor_date = ac;
      else if (row.aspvrContractor) docsNote.push(`исполнитель: ${row.aspvrContractor}`);
      const vp = parsePair(row.vpSendReturn);
      if (vp.first != null) values.docs_vp_sent_date = vp.first;
      if (vp.second != null) values.docs_vp_returned_date = vp.second;
      if (vp.leftover) docsNote.push(`ВП: ${vp.leftover}`);
      const toCust = parsePair(row.aspvrToCustomer);
      if (toCust.first != null) values.docs_aspvr_customer_scan_date = toCust.first;
      if (toCust.second != null) values.docs_aspvr_customer_original_date = toCust.second;
      if (toCust.leftover) docsNote.push(`АСПВР заказчику: ${toCust.leftover}`);
      if (row.trackOrAct) values.docs_track_or_act = row.trackOrAct;
      const signed = parseDate(row.aspvrSignedCustomer);
      if (signed != null) values.docs_aspvr_signed_customer_date = signed;
      else if (/получен/i.test(row.aspvrSignedCustomer)) values.docs_aspvr_customer_received = true;
      else if (row.aspvrSignedCustomer) docsNote.push(`подписан заказчиком: ${row.aspvrSignedCustomer}`);
      const ret = parsePair(row.returnFromCustomer);
      if (ret.first != null) values.docs_return_scan_date = ret.first;
      if (ret.second != null) values.docs_return_original_date = ret.second;
      if (ret.leftover) docsNote.push(`возврат: ${ret.leftover}`);
      if (docsNote.length) values.docs_note = docsNote.join('; ');

      const isPrimary = idx === primaryIdx;
      if (target && isPrimary) plans.push({ kind: 'update', engineId: target.id, number: num, row, values, manual });
      else if (target) {
        values.repeat_arrival_flag = true;
        values.previous_arrival_id = target.id;
        plans.push({ kind: 'create-repeat', engineId: null, number: num, row, values, manual });
      } else if (isPrimary) plans.push({ kind: 'create', engineId: null, number: num, row, values, manual });
      else {
        values.repeat_arrival_flag = true;
        plans.push({ kind: 'create-repeat', engineId: null, number: num, row, values, manual });
      }
      for (const m of manual) manualAll.push(`строка ${row.line} (${num}): ${m}`);
    });
  }

  const upd = plans.filter((p) => p.kind === 'update').length;
  const cre = plans.filter((p) => p.kind === 'create').length;
  const rep = plans.filter((p) => p.kind === 'create-repeat').length;
  log(`\n=== ПЛАН ===`);
  log(`   обновить существующих:            ${upd}`);
  log(`   завести новых:                    ${cre}`);
  log(`   завести повторными заездами:      ${rep}`);
  log(`   договор проставим:                ${contractSet}`);
  log(`   договор не трогаем (конфликт):    ${contractConflict}`);
  log(`   договор не трогаем (неоднозначно):${contractAmbiguous}`);
  log(`   строк с оговорками:               ${manualAll.length}`);

  log(`\n-- НА РУЧНУЮ ПРОВЕРКУ (первые 40 из ${manualAll.length}) --`);
  for (const m of manualAll.slice(0, 40)) log(`   ? ${m}`);

  if (!APPLY) {
    log(`\n(dry-run — записей не было. Повторите с --apply после ревью.)`);
    await pool.end();
    return;
  }

  log(`\n=== ЗАПИСЬ ===`);
  const custIdByKey = new Map<string, string>();
  for (const [k, c] of custByNorm) custIdByKey.set(k, String(c.id));
  const brandIdByKey = new Map<string, string>();
  for (const [k, b] of brandByNorm) brandIdByKey.set(k, String(b.id));

  for (const [k, name] of newCustomers) {
    const ce = await createEntity(actor, customerTypeId);
    if (!ce.ok) { log(`   ✗ контрагент «${name}»: ${(ce as any).error}`); continue; }
    const r = await setEntityAttribute(actor, ce.id, 'name', name, { allowSyncConflicts: true });
    if (!r.ok) { log(`   ✗ контрагент «${name}» name: ${(r as any).error}`); continue; }
    custIdByKey.set(k, ce.id);
  }
  for (const [k, name] of newBrands) {
    const ce = await createEntity(actor, brandTypeId);
    if (!ce.ok) { log(`   ✗ марка «${name}»: ${(ce as any).error}`); continue; }
    const r = await setEntityAttribute(actor, ce.id, 'name', name, { allowSyncConflicts: true });
    if (!r.ok) { log(`   ✗ марка «${name}» name: ${(r as any).error}`); continue; }
    brandIdByKey.set(k, ce.id);
  }
  log(`   заведено контрагентов: ${newCustomers.size}, марок: ${newBrands.size}`);

  // ── запись двигателей: ПАКЕТАМИ, а не по атрибуту ────────────────────────
  // Поатрибутный `setEntityAttribute` делает ledger-append на КАЖДОЕ значение, а
  // append переписывает `state.json` целиком (на проде это 164 МБ) — замер 13.08
  // дал ~1 двигатель в минуту, то есть сутки на файл. `writeSyncChanges` делает
  // РОВНО ОДИН append на весь переданный пакет, поэтому пишем чанками.
  const ts = Date.now();
  const defIdByCode = new Map<string, string>();
  {
    const r = await pool.query(
      'select code, id from attribute_defs where entity_type_id=$1 and deleted_at is null',
      [engineTypeId],
    );
    for (const row of r.rows as any[]) defIdByCode.set(String(row.code), String(row.id));
  }

  // id существующих значений: на (entity_id, attribute_def_id) висит unique,
  // поэтому обновление обязано переиспользовать прежний id строки.
  const existingValueId = new Map<string, string>();
  const existingValueJson = new Map<string, string | null>();
  {
    const r = await pool.query(
      `select av.id::text as id, av.entity_id::text as eid, av.attribute_def_id::text as did, av.value_json
         from attribute_values av
         join entities e on e.id = av.entity_id and e.type_id = $1 and e.deleted_at is null
        where av.deleted_at is null`,
      [engineTypeId],
    );
    for (const row of r.rows as any[]) {
      const k = `${row.eid}:${row.did}`;
      existingValueId.set(k, String(row.id));
      existingValueJson.set(k, row.value_json == null ? null : String(row.value_json));
    }
  }

  const entityRows: Record<string, unknown>[] = [];
  const valueRows: Record<string, unknown>[] = [];
  let skippedCodes = 0;
  let unchanged = 0;
  for (const p of plans) {
    let engineId = p.engineId;
    if (!engineId) {
      engineId = randomUUID();
      entityRows.push({ id: engineId, type_id: engineTypeId, created_at: ts, updated_at: ts, deleted_at: null });
    }
    const values = { ...p.values };
    const ck = values.__customerKey as string | undefined;
    const bk = values.__brandKey as string | undefined;
    delete values.__customerKey;
    delete values.__brandKey;
    if (ck && custIdByKey.has(ck)) values.customer_id = custIdByKey.get(ck);
    if (bk && brandIdByKey.has(bk)) values.engine_brand_id = brandIdByKey.get(bk);

    for (const [code, value] of Object.entries(values)) {
      const did = defIdByCode.get(code);
      if (!did) { skippedCodes++; continue; }
      const key = `${engineId}:${did}`;
      const next = JSON.stringify(value);
      // Уже совпадающее не переписываем: это и лишний ledger-append, и, главное,
      // делает повторный заход после обрыва движением ВПЕРЁД, а не с нуля.
      if (existingValueJson.get(key) === next) { unchanged++; continue; }
      valueRows.push({
        id: existingValueId.get(key) ?? randomUUID(),
        entity_id: engineId,
        attribute_def_id: did,
        value_json: next,
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
      });
    }
  }
  log(`   к записи: карточек ${entityRows.length} новых, значений ${valueRows.length}` +
      `, уже совпадает ${unchanged}` +
      (skippedCodes ? `, пропущено кодов без def: ${skippedCodes}` : ''));

  async function pushChunk(table: SyncTableName, rows: Record<string, unknown>[]) {
    await recordSyncChanges(
      actor,
      rows.map((row) => ({ op: 'upsert' as const, tableName: table, rowId: String(row.id), payload: row })),
      { allowSyncConflicts: true },
    );
  }

  // Карточки — до значений: у attribute_values FK на entities.
  const CHUNK = Number(arg('chunk') ?? '1000') || 1000;
  for (let i = 0; i < entityRows.length; i += CHUNK) {
    await pushChunk(SyncTableName.Entities, entityRows.slice(i, i + CHUNK));
    log(`   карточки: ${Math.min(i + CHUNK, entityRows.length)}/${entityRows.length}`);
  }
  for (let i = 0; i < valueRows.length; i += CHUNK) {
    await pushChunk(SyncTableName.AttributeValues, valueRows.slice(i, i + CHUNK));
    log(`   значения: ${Math.min(i + CHUNK, valueRows.length)}/${valueRows.length}`);
  }

  log(`\n=== ИТОГО (applied) ===`);
  log(`карточек заведено: ${entityRows.length}, значений записано: ${valueRows.length}`);
  log(`ledger-append'ов: ${Math.ceil(entityRows.length / CHUNK) + Math.ceil(valueRows.length / CHUNK)}`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
