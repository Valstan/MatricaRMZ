/**
 * Демо-стенд для портфолио (план docs/plans/portfolio-demo-stand-2026-08.md, D-021).
 *
 * Сеет ВЫДУМАННЫЕ, но правдоподобные данные в отдельную БД `matricarmz_demo` — с нуля,
 * не из рабочих данных. Все ФИО и контрагенты выдуманы; марки двигателей и названия
 * деталей — доменный словарь (их можно брать настоящие).
 *
 * Всё через сервисы приложения (adminMasterdataService / employeeAuthService /
 * warehouseService / workshopsService) — так набор данных согласован по инвариантам,
 * а не «на вид». Операции (наряды, события) — insert + recordSyncChanges, как это
 * делает сам сервер (workOrderClosingService), иначе строки не уедут клиентам.
 *
 * Подготовка БД (один раз):
 *   createdb -h 127.0.0.1 -p <порт> -U postgres matricarmz_demo
 *   PGDATABASE=matricarmz_demo pnpm -F @matricarmz/backend-api db:migrate
 * Сид (идемпотентен по ключевым сущностям, повторный прогон досеет недостающее):
 *   PGDATABASE=matricarmz_demo pnpm -F @matricarmz/backend-api demo:seed
 *
 * ⛔ Guard: скрипт отказывается работать, если PGDATABASE != matricarmz_demo —
 * чтобы выдумка не уехала в probe/prod, а прод-снапшот не попал в кадр.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';

import {
  AttributeDataType,
  EntityTypeCode,
  STATUS_CODES,
  STATUS_LABELS,
  SyncTableName,
  WORK_ORDER_PAYLOAD_VERSION,
  WorkOrderKind,
  statusDateCode,
  syncSlotsWithPlan,
  type AttachedEngineRef,
  type ContractPayments,
  type PaymentRow,
  type PlannedSectionBrand,
  type WorkOrderPayload,
  type WorkOrderWorkLine,
  emptyContractPayments,
} from '@matricarmz/shared';

import { db, pool } from '../database/db.js';
import { attributeDefs, attributeValues, directoryWorkshops, entities, entityTypes, erpNomenclature, operations } from '../database/schema.js';
import { hashPassword } from '../auth/password.js';
import {
  createEmployeeEntity,
  ensureEmployeeAuthDefs,
  getEmployeeAuthByLogin,
  setEmployeeAuth,
  setEmployeeFullName,
} from '../services/employeeAuthService.js';
import {
  createEntity,
  setEntityAttribute,
  upsertAttributeDef,
  upsertEntityType,
} from '../services/adminMasterdataService.js';
import {
  createDirectoryPart,
  createWarehouseDocument,
  listWarehouseLookups,
  listWarehouseNomenclatureTemplates,
  postWarehouseDocument,
  upsertWarehouseNomenclature,
} from '../services/warehouseService.js';
import { upsertWorkshop } from '../services/workshopsService.js';
import { seedSystemLocations } from '../services/warehouseLocationsService.js';
import { recordSyncChanges } from '../services/sync/syncChangeService.js';

// ─────────────────────────────── Guard ───────────────────────────────

const DEMO_DB = 'matricarmz_demo';
if ((process.env.PGDATABASE ?? '') !== DEMO_DB) {
  console.error(
    `[demo-seed] ОТКАЗ: PGDATABASE='${process.env.PGDATABASE ?? ''}', ожидается '${DEMO_DB}'.\n` +
      `Демо-данные сеются ТОЛЬКО в отдельную БД (см. заголовок скрипта). Прод/probe не трогаем.`,
  );
  process.exit(1);
}

// Детерминированный PRNG — пересев даёт тот же «рабочий день завода».
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260810);
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
const between = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));

const DAY = 86_400_000;
const NOW = Date.now();
const daysAgo = (d: number) => NOW - d * DAY;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// row_owners FK требует настоящего user-uuid — main() подменяет на демо-superadmin.
let ACTOR: { id: string; username: string; role: 'admin' | 'superadmin' } = {
  id: '00000000-0000-0000-0000-000000000000',
  username: 'demo-seed',
  role: 'superadmin',
};

// ─────────────────────────── EAV helpers ───────────────────────────

async function ensureType(code: string, name: string): Promise<string> {
  const existing = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, code), isNull(entityTypes.deletedAt)))
    .limit(1);
  if (existing[0]?.id) return String(existing[0].id);
  const r = await upsertEntityType(ACTOR, { code, name });
  if (!r.ok || !r.id) throw new Error(`upsertEntityType ${code}: ${(r as any).error ?? 'failed'}`);
  return r.id;
}

async function ensureAttr(
  entityTypeId: string,
  code: string,
  name: string,
  dataType: string,
  sortOrder: number,
  metaJson?: string | null,
): Promise<void> {
  const existing = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, entityTypeId as any), eq(attributeDefs.code, code), isNull(attributeDefs.deletedAt)))
    .limit(1);
  if (existing[0]?.id) return;
  const r = await upsertAttributeDef(ACTOR, {
    entityTypeId,
    code,
    name,
    dataType,
    sortOrder,
    ...(metaJson != null ? { metaJson } : {}),
  });
  if (!r.ok) throw new Error(`upsertAttributeDef ${code}: ${(r as any).error ?? 'failed'}`);
}

async function findByTextAttr(typeId: string, attrCode: string, value: string): Promise<string | null> {
  const def = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId as any), eq(attributeDefs.code, attrCode), isNull(attributeDefs.deletedAt)))
    .limit(1);
  if (!def[0]) return null;
  const rows = await db
    .select({ id: entities.id })
    .from(entities)
    .innerJoin(attributeValues, eq(attributeValues.entityId, entities.id))
    .where(
      and(
        eq(entities.typeId, typeId as any),
        isNull(entities.deletedAt),
        eq(attributeValues.attributeDefId, def[0].id),
        eq(attributeValues.valueJson, JSON.stringify(value)),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(1);
  return rows[0]?.id ? String(rows[0].id) : null;
}

async function ensureEntityWithAttrs(
  typeId: string,
  keyAttr: string,
  keyValue: string,
  attrs: Record<string, unknown>,
): Promise<{ id: string; created: boolean }> {
  const existing = await findByTextAttr(typeId, keyAttr, keyValue);
  if (existing) return { id: existing, created: false };
  const created = await createEntity(ACTOR, typeId);
  if (!created.ok || !created.id) throw new Error(`createEntity: ${(created as any).error ?? 'failed'}`);
  for (const [code, value] of Object.entries(attrs)) {
    if (value == null) continue;
    await setEntityAttribute(ACTOR, created.id, code, value, { allowSyncConflicts: true });
  }
  return { id: created.id, created: true };
}

// ─────────────────────────── Словари выдумки ───────────────────────────

// Марки/детали — доменный словарь (настоящие названия допустимы по плану).
const BRANDS = [
  'ЯМЗ-238М2',
  'ЯМЗ-236НЕ2',
  'ЯМЗ-7511',
  'Д-245.9',
  'Д-260.2',
  'КАМАЗ-740.31',
  'СМД-18Н',
  'ТМЗ-8481.10',
] as const;

// Контрагенты — ВЫДУМАННЫЕ (проверить перед публикацией, что не совпали с реальными фирмами).
const CUSTOMERS = [
  { name: 'АО «Камаволгатехфлот»', inn: '4307019844', address: 'г. Котельнич, ул. Заводская, 14' },
  { name: 'ООО «Севдизельремкомплект»', inn: '2902118375', address: 'г. Вельск, пер. Механизаторов, 3' },
  { name: 'АО «Обьтрансдизель»', inn: '5504231190', address: 'г. Тара, ул. Речников, 21' },
  { name: 'ООО «Волгасудмеханика»', inn: '3444207516', address: 'г. Камышин, ул. Портовая, 8' },
] as const;

// ФИО — выдуманные.
const EMPLOYEES = [
  'Савельев Дмитрий Андреевич', // демо-оператор (учётка demo)
  'Кравцов Пётр Николаевич',
  'Шумилов Аркадий Викторович',
  'Долгинцев Олег Семёнович',
  'Пестряков Илья Валерьевич',
  'Ворожцов Никита Павлович',
  'Стародумов Егор Кузьмич',
  'Лесников Артём Григорьевич',
  'Чарушин Владислав Игоревич',
  'Балыбердин Сергей Ефимович',
  'Овечкин Тимофей Маркович',
  'Заболотский Роман Львович',
] as const;

const WORKSHOPS = [
  { code: 'w1', name: 'Цех №1 — разборочно-моечный' },
  { code: 'w2', name: 'Цех №2 — механический' },
  { code: 'w3', name: 'Цех №3 — сборочный' },
  { code: 'w4', name: 'Участок испытаний' },
] as const;

const PARTS = [
  'Вал коленчатый',
  'Блок цилиндров',
  'Головка блока цилиндров',
  'Гильза цилиндра',
  'Поршень',
  'Кольца поршневые (комплект)',
  'Вкладыши коренные Р1 (комплект)',
  'Вкладыши шатунные Р1 (комплект)',
  'Шатун',
  'Насос масляный',
  'Насос водяной',
  'Форсунка',
  'ТНВД',
  'Турбокомпрессор',
  'Прокладка ГБЦ',
  'Комплект прокладок двигателя',
  'Вал распределительный',
  'Маховик',
] as const;

const WORK_NAMES = [
  ['Разборка двигателя, мойка узлов', 'нормо-час', 18, 950],
  ['Дефектовка узлов с обмером', 'нормо-час', 10, 1100],
  ['Шлифовка коленчатого вала', 'шт', 1, 28500],
  ['Расточка блока цилиндров', 'шт', 1, 34200],
  ['Восстановление постелей коленвала', 'шт', 1, 21800],
  ['Притирка клапанов ГБЦ', 'компл', 1, 9600],
  ['Замена гильз цилиндров', 'компл', 1, 15400],
  ['Сборка двигателя', 'нормо-час', 32, 1050],
  ['Регулировка ТНВД на стенде', 'шт', 1, 12800],
  ['Обкатка на испытательном стенде', 'нормо-час', 6, 1400],
] as const;

// ─────────────────────────── Сотрудники ───────────────────────────

async function ensureLoginEmployee(login: string, password: string, role: 'admin' | 'superadmin', fullName: string): Promise<string> {
  await ensureEmployeeAuthDefs();
  const passwordHash = await hashPassword(password);
  const existing = await getEmployeeAuthByLogin(login);
  if (existing) return existing.id;
  const id = randomUUID();
  const created = await createEmployeeEntity(id);
  if (!created.ok) throw new Error(`createEmployeeEntity: ${(created as any).error ?? 'failed'}`);
  await setEmployeeAuth(id, { passwordHash, systemRole: role, accessEnabled: true, login });
  await setEmployeeFullName(id, fullName);
  return id;
}

async function ensurePlainEmployee(empTypeId: string, fullName: string): Promise<string> {
  const existing = await findByTextAttr(empTypeId, 'full_name', fullName);
  if (existing) return existing;
  const id = randomUUID();
  const created = await createEmployeeEntity(id);
  if (!created.ok) throw new Error(`createEmployeeEntity: ${(created as any).error ?? 'failed'}`);
  await setEmployeeFullName(id, fullName);
  return id;
}

// ─────────────────────────── Операции (sync-путь сервера) ───────────────────────────

async function insertOperation(row: {
  id: string;
  engineEntityId: string;
  operationType: string;
  status: string;
  note: string | null;
  performedAt: number;
  metaJson: string | null;
}): Promise<void> {
  const existing = await db.select({ id: operations.id }).from(operations).where(eq(operations.id, row.id)).limit(1);
  if (existing[0]) return;
  const ts = row.performedAt;
  const full = {
    ...row,
    performedBy: ACTOR.username,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'synced' as const,
  };
  await db.insert(operations).values(full);
  await recordSyncChanges({ id: ACTOR.id, username: ACTOR.username, role: ACTOR.role }, [
    {
      tableName: SyncTableName.Operations,
      rowId: row.id,
      op: 'upsert',
      payload: {
        id: row.id,
        engine_entity_id: row.engineEntityId,
        operation_type: row.operationType,
        status: row.status,
        note: row.note,
        performed_at: ts,
        performed_by: full.performedBy,
        meta_json: row.metaJson,
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
        sync_status: 'synced',
      },
      ts,
    },
  ]);
}

// Стабильные uuid из строки — идемпотентность нарядов между прогонами.
function stableId(key: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < key.length; i++) {
    h1 = Math.imul(h1 ^ key.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + key.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return `${hex(h1)}-${hex(h2).slice(0, 4)}-4${hex(h2).slice(4, 7)}-8${hex(h1 ^ h2).slice(0, 3)}-${hex(Math.imul(h1, h2))}${hex(h2).slice(0, 4)}`;
}

// ─────────────────────────── main ───────────────────────────

async function main() {
  console.log(`[demo-seed] БД: ${DEMO_DB}. Порождаем выдуманный «рабочий день завода»...`);

  // 1. Учётка демо-оператора (superadmin — из-под неё снимаются все кадры).
  const demoLogin = process.env.MATRICA_DEMO_LOGIN?.trim() || 'demo';
  const demoPassword = process.env.MATRICA_DEMO_PASSWORD?.trim() || 'demo2026';
  const demoUserId = await ensureLoginEmployee(demoLogin, demoPassword, 'superadmin', EMPLOYEES[0]);
  ACTOR = { id: demoUserId, username: demoLogin, role: 'superadmin' };
  console.log(`[demo-seed] оператор: ${demoLogin} / ${demoPassword} (${EMPLOYEES[0]})`);

  // 2. Типы и атрибуты (единый набор кодов с клиентским seed.ts).
  const engineTypeId = await ensureType(EntityTypeCode.Engine, 'Двигатель');
  const brandTypeId = await ensureType(EntityTypeCode.EngineBrand, 'Марка двигателя');
  const customerTypeId = await ensureType(EntityTypeCode.Customer, 'Контрагенты');
  const contractTypeId = await ensureType(EntityTypeCode.Contract, 'Контракт');
  const empTypeId = await ensureType(EntityTypeCode.Employee, 'Сотрудник');
  const unitTypeId = await ensureType('unit', 'Единицы измерения');
  const groupTypeId = await ensureType('nomenclature_group', 'Группы номенклатуры');

  await ensureAttr(brandTypeId, 'name', 'Название', AttributeDataType.Text, 10);
  await ensureAttr(customerTypeId, 'name', 'Название', AttributeDataType.Text, 10);
  await ensureAttr(customerTypeId, 'inn', 'ИНН', AttributeDataType.Text, 20);
  await ensureAttr(customerTypeId, 'address', 'Адрес', AttributeDataType.Text, 40);
  await ensureAttr(unitTypeId, 'name', 'Название', AttributeDataType.Text, 10);
  await ensureAttr(groupTypeId, 'name', 'Название', AttributeDataType.Text, 10);

  await ensureAttr(engineTypeId, 'engine_number', 'Номер двигателя', AttributeDataType.Text, 10);
  await ensureAttr(engineTypeId, 'engine_brand', 'Марка двигателя', AttributeDataType.Text, 20);
  await ensureAttr(engineTypeId, 'engine_brand_id', 'Марка двигателя (справочник)', AttributeDataType.Link, 25, JSON.stringify({ linkTargetTypeCode: EntityTypeCode.EngineBrand }));
  await ensureAttr(engineTypeId, 'arrival_date', 'Дата прихода', AttributeDataType.Date, 26);
  await ensureAttr(engineTypeId, 'customer_id', 'Заказчик', AttributeDataType.Link, 30, JSON.stringify({ linkTargetTypeCode: EntityTypeCode.Customer }));
  await ensureAttr(engineTypeId, 'contract_id', 'Контракт', AttributeDataType.Link, 40, JSON.stringify({ linkTargetTypeCode: EntityTypeCode.Contract }));
  await ensureAttr(engineTypeId, 'contract_section_number', 'Секция контракта', AttributeDataType.Text, 45);
  for (const code of STATUS_CODES) {
    await ensureAttr(engineTypeId, code, STATUS_LABELS[code], AttributeDataType.Boolean, 41 + STATUS_CODES.indexOf(code) * 2);
    await ensureAttr(engineTypeId, statusDateCode(code), `Дата ${STATUS_LABELS[code]}`, AttributeDataType.Date, 42 + STATUS_CODES.indexOf(code) * 2);
  }

  await ensureAttr(contractTypeId, 'number', 'Номер договора', AttributeDataType.Text, 10);
  await ensureAttr(contractTypeId, 'date', 'Дата договора', AttributeDataType.Date, 20);
  await ensureAttr(contractTypeId, 'internal_number', 'Внутренний номер', AttributeDataType.Text, 25);
  await ensureAttr(contractTypeId, 'customer_id', 'Заказчик', AttributeDataType.Link, 30, JSON.stringify({ linkTargetTypeCode: EntityTypeCode.Customer }));
  await ensureAttr(contractTypeId, 'contract_sections', 'Секции контракта', AttributeDataType.Json, 60);
  await ensureAttr(contractTypeId, 'contract_payments', 'Платежи контракта', AttributeDataType.Json, 65);

  // 3. Сотрудники (выдуманные ФИО) — бригады нарядов.
  const employeeIds: string[] = [demoUserId];
  for (const fullName of EMPLOYEES.slice(1)) {
    employeeIds.push(await ensurePlainEmployee(empTypeId, fullName));
  }
  console.log(`[demo-seed] сотрудников: ${employeeIds.length}`);

  // 4. Цехи (+ зеркала в warehouse_locations) и системные склады.
  await seedSystemLocations();
  const workshopIds: string[] = [];
  for (const [i, w] of WORKSHOPS.entries()) {
    const existing = await db
      .select({ id: directoryWorkshops.id })
      .from(directoryWorkshops)
      .where(and(eq(directoryWorkshops.code, w.code), isNull(directoryWorkshops.deletedAt)))
      .limit(1);
    if (existing[0]?.id) {
      workshopIds.push(String(existing[0].id));
      continue;
    }
    const r = await upsertWorkshop({ code: w.code, name: w.name, displayOrder: (i + 1) * 10 });
    if (!r.ok) throw new Error(`upsertWorkshop ${w.code}: ${(r as any).error}`);
    workshopIds.push(r.id);
  }

  // 5. Марки и контрагенты.
  const brandIds = new Map<string, string>();
  for (const name of BRANDS) {
    brandIds.set(name, (await ensureEntityWithAttrs(brandTypeId, 'name', name, { name })).id);
  }
  const customerIds: string[] = [];
  for (const c of CUSTOMERS) {
    customerIds.push((await ensureEntityWithAttrs(customerTypeId, 'name', c.name, c)).id);
  }
  console.log(`[demo-seed] марок: ${brandIds.size}, контрагентов: ${customerIds.length}`);

  // 6. Двигатели — парк ~160 единиц с распределёнными статусами.
  type EngineSeed = { id: string; number: string; brand: string };
  const engines: EngineSeed[] = [];
  const ENGINE_COUNT = 160;
  for (let i = 0; i < ENGINE_COUNT; i++) {
    const brand = BRANDS[i % BRANDS.length]!;
    const prefix = brand.replace(/^[^0-9]*/, '').split(/[.-]/)[0] || '100';
    const number = `${prefix}-${String(10000 + Math.floor(rnd() * 89999))}`;
    const arrival = daysAgo(between(5, 400));
    const { id, created } = await ensureEntityWithAttrs(engineTypeId, 'engine_number', number, {
      engine_number: number,
      engine_brand: brand,
      engine_brand_id: brandIds.get(brand),
      arrival_date: arrival,
      customer_id: pick(customerIds),
    });
    engines.push({ id, number, brand });
    if (!created) continue;
    // Статусная лестница: чем «старше» приход, тем дальше двигатель продвинулся.
    const age = (NOW - arrival) / DAY;
    const roll = rnd();
    const set = async (code: (typeof STATUS_CODES)[number], atDaysAgo: number) => {
      await setEntityAttribute(ACTOR, id, code, true, { allowSyncConflicts: true });
      await setEntityAttribute(ACTOR, id, statusDateCode(code), daysAgo(atDaysAgo), { allowSyncConflicts: true });
    };
    await set('status_storage_received', Math.max(1, Math.round(age - 2)));
    if (age > 30 && roll < 0.75) await set('status_repair_started', Math.max(1, Math.round(age - between(10, 25))));
    if (age > 90 && roll < 0.5) await set('status_repaired', Math.max(1, Math.round(age - between(40, 70))));
    if (age > 150 && roll < 0.35) await set('status_customer_sent', Math.max(1, Math.round(age - between(75, 110))));
    if (age > 200 && roll < 0.25) await set('status_customer_accepted', Math.max(1, Math.round(age - between(100, 140))));
    if (roll > 0.97) await set('status_scrap_confirmed', Math.max(1, Math.round(age - 5)));
  }
  console.log(`[demo-seed] двигателей: ${engines.length}`);

  // 7. Контракты со слотами и платежами.
  const kop = (rub: number) => Math.round(rub * 100);
  async function ensureContract(args: {
    number: string;
    internalNumber: string;
    customerId: string;
    signedDaysAgo: number;
    dueDaysAhead: number;
    primaryRows: Array<{ brand: string; qty: number; priceRub: number }>;
    addonRows?: Array<{ brand: string; qty: number; priceRub: number }>;
    attachEngines: number;
  }): Promise<string> {
    const sections = {
      primary: {
        number: args.number,
        signedAt: daysAgo(args.signedDaysAgo),
        dueAt: NOW + args.dueDaysAhead * DAY,
        internalNumber: args.internalNumber,
        customerId: args.customerId,
        engineBrands: args.primaryRows.map((r) => ({ engineBrandId: brandIds.get(r.brand)!, qty: r.qty, unitPrice: r.priceRub })),
        parts: [],
      },
      addons: (args.addonRows ?? []).length
        ? [
            {
              number: `ДС-1 к ${args.number}`,
              seq: 1,
              signedAt: daysAgo(Math.max(5, args.signedDaysAgo - 60)),
              dueAt: NOW + (args.dueDaysAhead + 90) * DAY,
              createdAt: daysAgo(Math.max(5, args.signedDaysAgo - 60)),
              note: 'Дополнительный объём по итогам дефектовки парка заказчика.',
              engineBrands: (args.addonRows ?? []).map((r) => ({ engineBrandId: brandIds.get(r.brand)!, qty: r.qty, unitPrice: r.priceRub })),
              parts: [],
            },
          ]
        : [],
    };

    const { id, created } = await ensureEntityWithAttrs(contractTypeId, 'number', args.number, {
      number: args.number,
      internal_number: args.internalNumber,
      date: daysAgo(args.signedDaysAgo),
      customer_id: args.customerId,
      contract_sections: sections,
    });
    if (!created) return id;

    // План → слоты (та же доменная сверка, что в карточке контракта и resync-скрипте).
    const planned: PlannedSectionBrand[] = [];
    for (const r of args.primaryRows) planned.push({ sectionKey: 'primary', engineBrandId: brandIds.get(r.brand)!, qty: r.qty, unitPrice: r.priceRub });
    for (const r of args.addonRows ?? []) planned.push({ sectionKey: 'ДС 1', engineBrandId: brandIds.get(r.brand)!, qty: r.qty, unitPrice: r.priceRub });

    // Привязываем подходящие по марке двигатели к контракту.
    const wantedBrands = new Set([...args.primaryRows, ...(args.addonRows ?? [])].map((r) => r.brand));
    const attached: AttachedEngineRef[] = [];
    for (const e of engines) {
      if (attached.length >= args.attachEngines) break;
      if (!wantedBrands.has(e.brand)) continue;
      const sectionKey = args.addonRows?.some((r) => r.brand === e.brand) && rnd() < 0.4 ? 'ДС 1' : 'primary';
      await setEntityAttribute(ACTOR, e.id, 'contract_id', id, { allowSyncConflicts: true });
      await setEntityAttribute(ACTOR, e.id, 'contract_section_number', sectionKey, { allowSyncConflicts: true });
      attached.push({ engineId: e.id, sectionKey, engineBrandId: brandIds.get(e.brand)! });
      engines.splice(engines.indexOf(e), 1); // двигатель уходит в этот контракт, следующему не достаётся
    }

    let cp: ContractPayments = syncSlotsWithPlan(emptyContractPayments(), planned, attached, () => randomUUID());

    // Платежи: стартовые авансы (отсчёт 90 дней), доавансы, пара окончательных расчётов.
    cp = {
      version: 1,
      slots: cp.slots.map((slot, idx) => {
        const price = slot.contractPriceKop != null ? slot.contractPriceKop : kop(1_000_000);
        const payments: PaymentRow[] = [];
        const advDaysAgo = between(20, 120);
        if (idx % 3 !== 2) {
          payments.push({
            id: randomUUID(),
            date: iso(daysAgo(advDaysAgo)),
            amountKop: Math.round(price * 0.3),
            kind: 'advance',
            countdownStart: true,
            note: 'Аванс 30% по счёту',
          });
        }
        if (idx % 4 === 1) {
          payments.push({
            id: randomUUID(),
            date: iso(daysAgo(Math.max(3, advDaysAgo - 30))),
            amountKop: Math.round(price * 0.2),
            kind: 'extra_advance',
            note: 'Доаванс на закупку запчастей',
          });
        }
        if (slot.engineId && idx % 5 === 0) {
          payments.push({
            id: randomUUID(),
            date: iso(daysAgo(between(2, 15))),
            amountKop: price - Math.round(price * 0.3) - (idx % 4 === 1 ? Math.round(price * 0.2) : 0),
            kind: 'final',
            note: 'Окончательный расчёт после приёмки',
          });
        }
        return { ...slot, contractPriceKop: price, payments };
      }),
    };
    await setEntityAttribute(ACTOR, id, 'contract_payments', cp, { allowSyncConflicts: true });
    return id;
  }

  const contractA = await ensureContract({
    number: '№ 14/2026-СД',
    internalNumber: 'РМЗ-К-041',
    customerId: customerIds[0]!,
    signedDaysAgo: 170,
    dueDaysAhead: 120,
    primaryRows: [
      { brand: 'ЯМЗ-238М2', qty: 6, priceRub: 1_485_000 },
      { brand: 'ЯМЗ-236НЕ2', qty: 4, priceRub: 1_190_000 },
    ],
    addonRows: [{ brand: 'Д-260.2', qty: 3, priceRub: 980_000 }],
    attachEngines: 9,
  });
  const contractB = await ensureContract({
    number: '№ 07/2026-РФ',
    internalNumber: 'РМЗ-К-038',
    customerId: customerIds[2]!,
    signedDaysAgo: 240,
    dueDaysAhead: 40,
    primaryRows: [
      { brand: 'КАМАЗ-740.31', qty: 5, priceRub: 1_320_000 },
      { brand: 'Д-245.9', qty: 2, priceRub: 870_000 },
    ],
    attachEngines: 5,
  });
  console.log(`[demo-seed] контракты: ${contractA.slice(0, 8)}…, ${contractB.slice(0, 8)}…`);

  // 8. Наряды с бригадой и КТУ (закрытые + открытые + один выданный в работу).
  const crewPool = employeeIds.slice(1);
  const names = EMPLOYEES.slice(1);
  let woNumber = 1041;
  for (let i = 0; i < 12; i++) {
    const opId = stableId(`work-order:${i}`);
    const engine = engines[(i * 13) % engines.length]!;
    const crewSize = between(3, 5);
    const start = (i * 3) % crewPool.length;
    const crew = Array.from({ length: crewSize }, (_, k) => {
      const idx = (start + k) % crewPool.length;
      return { employeeId: crewPool[idx]!, employeeName: names[idx]!, ktu: [0.8, 0.9, 1, 1, 1.1, 1.2, 1.3][between(0, 6)]! };
    });
    const lineCount = between(2, 4);
    const works: WorkOrderWorkLine[] = Array.from({ length: lineCount }, (_, k) => {
      const [serviceName, unit, qty, priceRub] = WORK_NAMES[(i + k * 3) % WORK_NAMES.length]!;
      return {
        lineNo: k + 1,
        serviceId: null,
        serviceName,
        unit,
        qty,
        priceRub,
        amountRub: qty * priceRub,
        productNumber: engine.number,
        engineId: engine.id,
      } as WorkOrderWorkLine;
    });
    const totalAmountRub = works.reduce((s, w) => s + w.amountRub, 0);
    const ktuSum = crew.reduce((s, c) => s + c.ktu, 0);
    const basePerWorkerRub = Math.round(totalAmountRub / ktuSum);
    const payouts = crew.map((c) => ({ employeeId: c.employeeId, employeeName: c.employeeName, ktu: c.ktu, amountRub: Math.round(basePerWorkerRub * c.ktu) }));
    const orderDate = daysAgo(between(4, 160));
    const closed = i < 8; // 8 закрытых, 3 открытых, 1 выданный в работу
    const payload: WorkOrderPayload = {
      kind: 'work_order',
      version: WORK_ORDER_PAYLOAD_VERSION,
      operationId: opId,
      workOrderNumber: woNumber++,
      orderDate,
      startDate: orderDate + DAY,
      dueDate: orderDate + between(14, 45) * DAY,
      ...(closed ? { completedDate: orderDate + between(10, 40) * DAY } : {}),
      crew,
      workGroups: [],
      freeWorks: [],
      works,
      totalAmountRub,
      basePerWorkerRub,
      payouts,
      workshopId: workshopIds[i % workshopIds.length]!,
      workOrderKind: i % 3 === 0 ? WorkOrderKind.Regular : WorkOrderKind.Repair,
      ...(i === 11 ? { repairIssued: true } : {}),
    };
    await insertOperation({
      id: opId,
      engineEntityId: engine.id,
      operationType: 'work_order',
      status: closed ? 'closed' : 'draft',
      note: `Наряд № ${payload.workOrderNumber}`,
      performedAt: orderDate,
      metaJson: JSON.stringify(payload),
    });
  }
  console.log('[demo-seed] нарядов: 12 (8 закрытых, 3 открытых, 1 выдан в работу)');

  // 9. История ремонта витринного двигателя (кадр «карточка целиком»).
  const hero = engines[0]!;
  await insertOperation({
    id: stableId('op:hero-acceptance'),
    engineEntityId: hero.id,
    operationType: 'acceptance',
    status: 'event',
    note: `Принят в ремонт от ${CUSTOMERS[0].name}: комплектность по акту, видимых повреждений блока нет.`,
    performedAt: daysAgo(120),
    metaJson: null,
  });
  await insertOperation({
    id: stableId('op:hero-defect'),
    engineEntityId: hero.id,
    operationType: 'defect',
    status: 'event',
    note: 'Дефектовка: износ коренных шеек 0,08 мм — шлифовка в Р1; гильзы под замену (4 шт.), ГБЦ — притирка клапанов.',
    performedAt: daysAgo(105),
    metaJson: null,
  });
  console.log(`[demo-seed] витринный двигатель: ${hero.number} (${hero.brand})`);

  // 10. Склад: единицы, группы, номенклатура деталей, приход + расходы.
  const unitNames = ['шт', 'компл', 'кг', 'л'];
  for (const n of unitNames) await ensureEntityWithAttrs(unitTypeId, 'name', n, { name: n });
  const groupNames = ['Детали двигателя', 'РТИ и прокладки', 'Топливная аппаратура', 'Метизы и нормали'];
  for (const n of groupNames) await ensureEntityWithAttrs(groupTypeId, 'name', n, { name: n });

  const lookups = await listWarehouseLookups();
  if (!lookups.ok) throw new Error(`listWarehouseLookups: ${(lookups as any).error}`);
  const unitId = lookups.lookups.units.find((u) => u.label === 'шт')?.id ?? lookups.lookups.units[0]?.id;
  const groupId = lookups.lookups.nomenclatureGroups.find((g) => g.label === 'Детали двигателя')?.id ?? lookups.lookups.nomenclatureGroups[0]?.id;
  const templates = await listWarehouseNomenclatureTemplates();
  if (!templates.ok) throw new Error(`listWarehouseNomenclatureTemplates: ${(templates as any).error}`);
  const partTemplate = templates.rows.find((t) => String(t.directoryKind ?? '') === 'part') ?? templates.rows[0];
  if (!unitId || !groupId || !partTemplate) throw new Error('нет unit/group/template для номенклатуры');

  const nomenclatureIds: string[] = [];
  let nomenclatureCreated = 0;
  for (const [i, name] of PARTS.entries()) {
    const code = `ДВ-${String(i + 1).padStart(3, '0')}`;
    const existingNom = await db
      .select({ id: erpNomenclature.id })
      .from(erpNomenclature)
      .where(and(eq(erpNomenclature.code, code), isNull(erpNomenclature.deletedAt)))
      .limit(1);
    if (existingNom[0]?.id) {
      nomenclatureIds.push(String(existingNom[0].id));
      continue;
    }
    let partId = '';
    const createdPart = await createDirectoryPart({ name });
    if (createdPart.ok) partId = createdPart.part.id;
    else {
      const dup = String(createdPart.error || '').match(/duplicate part exists:\s*([0-9a-f-]{36})/i);
      if (dup?.[1]) partId = dup[1];
      else throw new Error(`createDirectoryPart ${name}: ${createdPart.error}`);
    }
    // createDirectoryPart уже создал зеркальную складскую карточку — обновляем ЕЁ
    // (код/группа/единица/шаблон), а не плодим вторую номенклатуру на ту же деталь.
    const mirror = await db
      .select({ id: erpNomenclature.id })
      .from(erpNomenclature)
      .where(and(eq(erpNomenclature.directoryRefId, partId as any), isNull(erpNomenclature.deletedAt)))
      .limit(1);
    const up = await upsertWarehouseNomenclature({
      ...(mirror[0]?.id ? { id: String(mirror[0].id) } : { directoryKind: 'part', directoryRefId: partId }),
      code,
      name,
      itemType: 'part',
      groupId,
      unitId,
      specJson: JSON.stringify({ templateId: String(partTemplate.id) }),
    });
    if (up.ok) {
      nomenclatureIds.push(up.id);
      nomenclatureCreated += 1;
    } else console.warn(`[demo-seed] номенклатура ${name}: ${(up as any).error}`);
  }
  console.log(`[demo-seed] номенклатуры: ${nomenclatureIds.length} (новых: ${nomenclatureCreated})`);

  if (nomenclatureCreated > 0) {
    // Приход остатков (импортоподобный stock_receipt) + пара расходов в цех.
    const mkLines = (ids: string[], qtyMin: number, qtyMax: number) =>
      ids.map((nomenclatureId) => ({
        qty: between(qtyMin, qtyMax),
        price: between(1_800, 96_000),
        nomenclatureId,
        unit: 'шт',
        warehouseId: 'default',
      }));
    const docs: Array<{ key: string; docType: string; docNo: string; lines: ReturnType<typeof mkLines>; date: number }> = [
      { key: 'receipt-1', docType: 'stock_receipt', docNo: 'ПР-000214', lines: mkLines(nomenclatureIds, 8, 120), date: daysAgo(45) },
      { key: 'receipt-2', docType: 'stock_receipt', docNo: 'ПР-000219', lines: mkLines(nomenclatureIds.slice(0, 6), 4, 40), date: daysAgo(12) },
      { key: 'issue-1', docType: 'stock_issue', docNo: 'РХ-000101', lines: mkLines(nomenclatureIds.slice(2, 8), 1, 6), date: daysAgo(6) },
    ];
    for (const d of docs) {
      const created = await createWarehouseDocument({
        docType: d.docType,
        docNo: d.docNo,
        docDate: d.date,
        header: { warehouseId: 'default' },
        lines: d.lines,
        actor: ACTOR,
      });
      if (!created.ok) {
        console.warn(`[demo-seed] документ ${d.docNo}: ${(created as any).error}`);
        continue;
      }
      const posted = await postWarehouseDocument({ documentId: created.id, actor: ACTOR });
      if (!posted.ok) console.warn(`[demo-seed] проводка ${d.docNo}: ${(posted as any).error}`);
    }
    console.log('[demo-seed] складские документы: 2 прихода + 1 расход (проведены)');
  }

  console.log('');
  console.log('=== Демо-стенд засеян ===');
  console.log(`Логин:  ${demoLogin}`);
  console.log(`Пароль: ${demoPassword}`);
  console.log('Дальше: поднять backend с PGDATABASE=matricarmz_demo, клиент указать на него, пройти сценарии руками.');
  console.log('⚠ Перед съёмкой: проверить выдуманных контрагентов на совпадение с реальными фирмами; экран настроек не снимать.');
}

main()
  .catch((e) => {
    console.error('[demo-seed] failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
