// Расшифровка ссылок карточки: id → название.
//
// Зачем: в карточке двигателя ссылки на справочники лежат id («Контракт
// ed135695-…», «Заказчик 8b039f3c-…»). Оператору нужен номер договора и
// название заказчика: без них сверка «файл ↔ карточка» бессмысленна — в файле
// лежит «АО РТ "Гранит"», а в карточке uuid, и это не «одинаковые значения» и
// не «разные», а «нечего сравнивать».
//
// Данные берём из локальной реплики клиента: они и так у оператора на машине,
// а карточка двигателя с её ссылками читается с правом `engines.view`.

import { and, inArray, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  attributeDefs,
  attributeValues,
  erpCounterparties,
  erpContracts,
  erpEngineCards,
} from '../database/schema.js';

/** Дефы, в которых лежит «название» сущности — по порядку предпочтения. */
const LABEL_DEF_CODES = ['name', 'full_name', 'number', 'engine_number', 'short_name', 'title'] as const;

function parseLabelValue(raw: unknown): string {
  if (raw == null) return '';
  const text = String(raw).trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'string') return parsed.trim();
    if (typeof parsed === 'number' || typeof parsed === 'boolean') return String(parsed);
  } catch {
    // значение не JSON — берём как есть
  }
  return text;
}

/**
 * Названия для переданных id. Ключ, которого нет в ответе, — ссылка не
 * разрешилась (запись не в реплике или у неё нет названия).
 */
export async function resolveReferenceLabels(
  db: BetterSQLite3Database,
  rawIds: readonly string[],
): Promise<Record<string, string>> {
  const ids = Array.from(new Set((rawIds ?? []).map((id) => String(id ?? '').trim()).filter(Boolean)));
  const out: Record<string, string> = {};
  if (ids.length === 0) return out;

  // 1) Строгие таблицы: там каноническое имя (номер договора, название заказчика).
  const [cards, contracts, counterparties] = await Promise.all([
    db
      .select({ id: erpEngineCards.id, number: erpEngineCards.engineNumber })
      .from(erpEngineCards)
      .where(inArray(erpEngineCards.id, ids)),
    db
      .select({ id: erpContracts.id, number: erpContracts.number })
      .from(erpContracts)
      .where(inArray(erpContracts.id, ids)),
    db
      .select({ id: erpCounterparties.id, name: erpCounterparties.name })
      .from(erpCounterparties)
      .where(inArray(erpCounterparties.id, ids)),
  ]);
  for (const row of cards) {
    const value = String(row.number ?? '').trim();
    if (value) out[String(row.id)] = value;
  }
  for (const row of contracts) {
    const value = String(row.number ?? '').trim();
    if (value) out[String(row.id)] = value;
  }
  for (const row of counterparties) {
    const value = String(row.name ?? '').trim();
    if (value) out[String(row.id)] = value;
  }

  // 2) Справочники без строгой таблицы (марки двигателей и прочие EAV-сущности).
  const rest = ids.filter((id) => !out[id]);
  if (rest.length === 0) return out;
  const defs = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(inArray(attributeDefs.code, [...LABEL_DEF_CODES]));
  if (defs.length === 0) return out;
  const defById = new Map(defs.map((d) => [String(d.id), String(d.code)]));
  const priority = new Map<string, number>(LABEL_DEF_CODES.map((code, index) => [code, index]));
  const rows = await db
    .select({
      entityId: attributeValues.entityId,
      defId: attributeValues.attributeDefId,
      valueJson: attributeValues.valueJson,
    })
    .from(attributeValues)
    .where(
      and(
        inArray(attributeValues.entityId, rest),
        inArray(
          attributeValues.attributeDefId,
          defs.map((d) => String(d.id)),
        ),
        isNull(attributeValues.deletedAt),
      ),
    );
  const best = new Map<string, { rank: number; value: string }>();
  for (const row of rows) {
    const entityId = String(row.entityId ?? '');
    const code = defById.get(String(row.defId)) ?? '';
    const value = parseLabelValue(row.valueJson);
    if (!entityId || !value) continue;
    const rank = priority.get(code) ?? LABEL_DEF_CODES.length;
    const current = best.get(entityId);
    if (!current || rank < current.rank) best.set(entityId, { rank, value });
  }
  for (const [entityId, entry] of best) out[entityId] = entry.value;
  return out;
}
