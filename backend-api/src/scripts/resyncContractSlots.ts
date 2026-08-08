/**
 * Ретро-сверка слотов ВСЕХ контрактов с планом марок (R5-PR3 grand-refactor-2026-08).
 *
 * До фикса #502 syncSlotsWithPlan «подгонял» число слотов под ПОСЛЕДНЮЮ строку марки
 * (дубли строк одной марки плодил сам UI), а цену всех слотов диктовала первая строка.
 * Клиент чинит контракт только при открытии его карточки; скрипт прогоняет исправленную
 * доменную сверку по всей базе разом: досоздаёт слоты до суммы строк, сеет позиционные
 * цены в пустые, рассаживает привязанные двигатели по слотам своих марок и печатает
 * отчёт расхождений (марка вне плана / двигателей больше плана / без секции).
 *
 * ⚠️ Запускать ТОЛЬКО после того, как парк клиентов обновится до релиза с #502
 * (иначе старый клиент, открыв карточку, пересинкает слоты СТАРОЙ логикой), и после
 * contracts:canonicalize-section-keys.
 *
 * Записи идут штатным путём (`setEntityAttribute` → recordSyncChanges) и доезжают
 * клиентам инкрементальным sync (GOTCHAS M6/M8). Идемпотентен: повторный запуск даст 0.
 *
 * Dry-run по умолчанию. Флаги:
 *   --apply              — выполнить запись
 *   --actor=<username>   — актор change_log (по умолчанию: первый superadmin)
 *
 *   pnpm -F @matricarmz/backend-api contracts:resync-slots
 *   pnpm -F @matricarmz/backend-api contracts:resync-slots --apply
 */
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import {
  canonicalContractSectionKey,
  contractSectionToken,
  parseContractPayments,
  parseContractSections,
  syncSlotsWithPlan,
  type AttachedEngineRef,
  type PlannedSectionBrand,
} from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { setEntityAttribute } from '../services/adminMasterdataService.js';

const APPLY = process.argv.includes('--apply');
const actorArg = process.argv.find((a) => a.startsWith('--actor='));
const ACTOR_OVERRIDE = actorArg ? actorArg.split('=')[1] : null;

type Actor = { id: string; username: string; role: 'admin' | 'superadmin' };

function log(...args: unknown[]) {
  console.log(...args);
}

function parseJsonish(valueJson: string | null): unknown {
  if (valueJson == null) return null;
  try {
    return JSON.parse(valueJson);
  } catch {
    return valueJson;
  }
}

function asText(v: unknown): string {
  if (v == null) return '';
  return typeof v === 'string' ? v.trim() : String(v).trim();
}

async function resolveActor(): Promise<Actor> {
  const r = await pool.query(
    `select e.id::text as id, trim(both '"' from lg.value_json) as username
       from entities e
       join attribute_defs sd on sd.code='system_role' and sd.deleted_at is null
       join attribute_values sr on sr.entity_id=e.id and sr.attribute_def_id=sd.id and sr.deleted_at is null
            and trim(both '"' from sr.value_json)='superadmin'
       join attribute_defs ld on ld.code='login' and ld.deleted_at is null
       left join attribute_values lg on lg.entity_id=e.id and lg.attribute_def_id=ld.id and lg.deleted_at is null
      where e.deleted_at is null
      order by username`,
  );
  if (r.rows.length === 0) throw new Error('no superadmin employee found — pass --actor=<username>');
  const pick = ACTOR_OVERRIDE
    ? r.rows.find((x: { username: string }) => String(x.username) === ACTOR_OVERRIDE)
    : r.rows[0];
  if (!pick) throw new Error(`--actor=${ACTOR_OVERRIDE} is not a superadmin`);
  return { id: String(pick.id), username: String(pick.username), role: 'superadmin' };
}

type ContractRow = { id: string; attrs: Record<string, unknown> };

async function loadContracts(): Promise<ContractRow[]> {
  const r = await pool.query(
    `select e.id::text as id, d.code as code, av.value_json as value_json
       from entities e
       join entity_types t on t.id = e.type_id and t.code = 'contract' and t.deleted_at is null
       join attribute_values av on av.entity_id = e.id and av.deleted_at is null
       join attribute_defs d on d.id = av.attribute_def_id and d.deleted_at is null
            and d.code in ('contract_sections', 'contract_payments', 'number')
      where e.deleted_at is null`,
  );
  const byId = new Map<string, ContractRow>();
  for (const row of r.rows as Array<{ id: string; code: string; value_json: string | null }>) {
    const entry = byId.get(row.id) ?? { id: row.id, attrs: {} };
    entry.attrs[row.code] = parseJsonish(row.value_json);
    byId.set(row.id, entry);
  }
  return [...byId.values()];
}

type EngineRef = { engineId: string; contractId: string; sectionRaw: string; engineBrandId: string };

async function loadEngineBindings(): Promise<EngineRef[]> {
  const r = await pool.query(
    `select av.entity_id::text as engine_id, d.code as code, av.value_json as value_json
       from attribute_values av
       join attribute_defs d on d.id = av.attribute_def_id and d.deleted_at is null
            and d.code in ('contract_id', 'contract_section_number', 'engine_brand_id')
       join entities e on e.id = av.entity_id and e.deleted_at is null
      where av.deleted_at is null`,
  );
  const byEngine = new Map<string, Record<string, string>>();
  for (const row of r.rows as Array<{ engine_id: string; code: string; value_json: string | null }>) {
    const bag = byEngine.get(row.engine_id) ?? {};
    bag[row.code] = asText(parseJsonish(row.value_json));
    byEngine.set(row.engine_id, bag);
  }
  const out: EngineRef[] = [];
  for (const [engineId, bag] of byEngine) {
    const contractId = asText(bag.contract_id);
    if (!contractId) continue;
    out.push({
      engineId,
      contractId,
      sectionRaw: asText(bag.contract_section_number),
      engineBrandId: asText(bag.engine_brand_id),
    });
  }
  return out;
}

function buildPlanned(attrs: Record<string, unknown>): PlannedSectionBrand[] {
  const sections = parseContractSections(attrs);
  const planned: PlannedSectionBrand[] = [];
  const pushRows = (sectionKey: string, rows: Array<{ engineBrandId: string; qty: number; unitPrice: number }>) => {
    for (const row of rows) {
      const engineBrandId = asText(row.engineBrandId);
      const qty = Number(row.qty);
      if (!engineBrandId || !Number.isFinite(qty) || qty <= 0) continue;
      const unitPrice = Number(row.unitPrice);
      planned.push({ sectionKey, engineBrandId, qty: Math.round(qty), unitPrice: Number.isFinite(unitPrice) ? unitPrice : 0 });
    }
  };
  pushRows(contractSectionToken(sections.primary), sections.primary.engineBrands);
  for (const addon of sections.addons) pushRows(contractSectionToken(addon), addon.engineBrands);
  return planned;
}

async function main() {
  const actor = await resolveActor();
  log(`Режим: ${APPLY ? 'APPLY (запись)' : 'DRY-RUN (только отчёт)'}; актор: ${actor.username}`);

  const [contracts, engineRefs] = await Promise.all([loadContracts(), loadEngineBindings()]);
  const enginesByContract = new Map<string, EngineRef[]>();
  for (const ref of engineRefs) {
    const list = enginesByContract.get(ref.contractId) ?? [];
    list.push(ref);
    enginesByContract.set(ref.contractId, list);
  }
  log(`Контрактов с данными: ${contracts.length}; двигателей с привязкой: ${engineRefs.length}`);

  let touchedContracts = 0;
  let slotsAdded = 0;
  let pricesSeeded = 0;
  let enginesPlaced = 0;
  const warnings: string[] = [];

  for (const contract of contracts.sort((a, b) => a.id.localeCompare(b.id))) {
    const planned = buildPlanned(contract.attrs);
    const engines = enginesByContract.get(contract.id) ?? [];
    if (planned.length === 0 && engines.length === 0) continue;

    const label = asText(contract.attrs.number) || contract.id.slice(0, 8);
    const cpBefore = parseContractPayments(contract.attrs.contract_payments);

    const noSection = engines.filter((e) => !canonicalContractSectionKey(e.sectionRaw));
    const attached: AttachedEngineRef[] = engines
      .filter((e) => canonicalContractSectionKey(e.sectionRaw))
      .map((e) => ({
        engineId: e.engineId,
        sectionKey: canonicalContractSectionKey(e.sectionRaw),
        ...(e.engineBrandId ? { engineBrandId: e.engineBrandId } : {}),
      }));

    const cpAfter = syncSlotsWithPlan(cpBefore, planned, attached, () => randomUUID());
    const changed = JSON.stringify(cpAfter) !== JSON.stringify(cpBefore);

    // Расхождения план ↔ факт (отчёт оператору, данные не трогаем).
    const plannedByKey = new Map<string, number>();
    for (const p of planned) plannedByKey.set(`${p.sectionKey} ${p.engineBrandId}`, (plannedByKey.get(`${p.sectionKey} ${p.engineBrandId}`) ?? 0) + p.qty);
    const plannedBrands = new Set(planned.map((p) => p.engineBrandId));
    const attachedByKey = new Map<string, number>();
    for (const a of attached) {
      if (!a.engineBrandId) continue;
      const key = `${a.sectionKey} ${a.engineBrandId}`;
      attachedByKey.set(key, (attachedByKey.get(key) ?? 0) + 1);
    }
    for (const [key, count] of attachedByKey) {
      const plan = plannedByKey.get(key) ?? 0;
      const brandInPlan = plannedBrands.has(key.split(' ')[1] ?? '');
      if (!brandInPlan) warnings.push(`контракт «${label}»: двигатели марки вне плана (${key}, шт: ${count})`);
      else if (count > plan) warnings.push(`контракт «${label}»: двигателей больше плана (${key}: ${count} из ${plan})`);
    }
    if (noSection.length > 0) warnings.push(`контракт «${label}»: двигателей без секции: ${noSection.length}`);

    if (!changed) continue;
    touchedContracts += 1;
    const added = cpAfter.slots.length - cpBefore.slots.length;
    const seeded =
      cpAfter.slots.filter((s) => s.contractPriceKop != null).length -
      cpBefore.slots.filter((s) => s.contractPriceKop != null).length;
    const placed =
      cpAfter.slots.filter((s) => s.engineId).length - cpBefore.slots.filter((s) => s.engineId).length;
    slotsAdded += Math.max(0, added);
    pricesSeeded += Math.max(0, seeded);
    enginesPlaced += Math.max(0, placed);
    log(
      `  «${label}» (${contract.id.slice(0, 8)}): слотов ${cpBefore.slots.length} → ${cpAfter.slots.length}` +
        `${seeded > 0 ? `, цен посеяно ${seeded}` : ''}${placed > 0 ? `, двигателей рассажено ${placed}` : ''}`,
    );
    if (APPLY) {
      await setEntityAttribute(actor, contract.id, 'contract_payments', cpAfter, { allowSyncConflicts: true });
    }
  }

  log(`\nИтого: контрактов к правке ${touchedContracts}, слотов добавлено ${slotsAdded}, цен посеяно ${pricesSeeded}, двигателей рассажено ${enginesPlaced}.`);
  if (warnings.length > 0) {
    log(`\n⚠ Расхождения план ↔ факт (${warnings.length}) — данные не менялись, показать владельцу:`);
    for (const w of warnings) log(`  - ${w}`);
  }
  if (!APPLY && touchedContracts > 0) {
    log('\nЗапись не выполнялась. Повторить с --apply (идемпотентно: повторный запуск даст 0).');
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
