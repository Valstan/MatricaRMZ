/**
 * Ledger write authorization guard (RBAC #474, brain #015).
 *
 * Enforcement half of the policy in shared `ledgerAuthz`. The write path
 * (/ledger/tx/submit -> applyLedgerTxs) previously authorized by authentication
 * only. This partitions a submit batch into allowed vs forbidden writes, keyed
 * by the resolved entity_type / operation_type of each row.
 *
 * Operator scoping bites ONLY the scoped operator roles. superadmin / admin /
 * legacy `user` / pending / employee keep today's behavior for that part
 * (additive migration — no one breaks until reassigned a scoped role).
 *
 * EXCEPT the server-only employee-attribute backstop (security-hardening-2026-06
 * C2), which denies writes to auth/security EAV attrs (system_role,
 * password_hash, access_enabled, login, delete_requested_*) for EVERY role —
 * those are server-managed and must never arrive via a client ledger tx.
 *
 * Forbidden rows are returned as skipped with `forbidden:<type>` so the batch is
 * not failed and the offline queue is not poisoned; the same list feeds the
 * deny-log (M3).
 */
import { inArray, isNull } from 'drizzle-orm';

import {
  canEditWorkOrder,
  ENGINE_RESERVATION_CODE,
  engineReservationSkipReason,
  isEngineEditBlockedByReservation,
  isEngineReservationGatedOperationType,
  isOperatorRole,
  isServerOnlyAttrCode,
  isServerManagedSyncTable,
  isSuperadminOnlyAttrCode,
  ledgerWriteRequirement,
  operatorMeetsRequirement,
  sectionForLedgerWrite,
  sectionLevelFor,
  SyncTableName,
} from '@matricarmz/shared';

import { getEffectivePermissionsForUser } from '../../auth/permissions.js';
import { db } from '../../database/db.js';
import { attributeDefs, entities, entityTypes } from '../../database/schema.js';
import { getLiveEngineReservations } from '../engineReservationGuard.js';
import type { SyncSkippedRow } from './applyPushBatch.js';
import {
  getRestrictedWorkOrderOwners,
  getRestrictedWorkOrderPolicy,
  getSectionMembershipForLogin,
} from './restrictedWorkOrders.js';
import type { SyncWriteActor, SyncWriteInput } from './syncWriteService.js';

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

/** Аварийный выключатель advisory-гейта: откат без передеплоя (systemd env). */
function engineReservationGateEnabled(): boolean {
  const raw = String(process.env.MATRICA_ENGINE_RESERVATION_GATE ?? '').toLowerCase();
  return !(raw === 'off' || raw === 'false' || raw === '0');
}

export async function partitionLedgerInputsByAuthz(
  inputs: SyncWriteInput[],
  actor: SyncWriteActor,
): Promise<{ allowed: SyncWriteInput[]; denied: SyncSkippedRow[] }> {
  const role = String(actor.role ?? '').toLowerCase();
  const operatorScoped = isOperatorRole(role);

  // entity_type_id -> code (small finite set)
  const typeRows = await db
    .select({ id: entityTypes.id, code: entityTypes.code })
    .from(entityTypes)
    .where(isNull(entityTypes.deletedAt));
  const codeByTypeId = new Map<string, string>();
  for (const r of typeRows) codeByTypeId.set(str(r.id), str(r.code));
  // Тип, ПРИЕХАВШИЙ В ЭТОМ ЖЕ БАТЧЕ, в БД ещё нет — без него entityTypeCode
  // оказывался пустым, а пустой код ledgerWriteRequirement трактует как `open`.
  // Из БД взятое НЕ перекрываем: код существующего типа — источник правды.
  for (const inp of inputs) {
    if (inp.table !== SyncTableName.EntityTypes) continue;
    const tid = str(inp.row?.['id'] ?? inp.row_id);
    const code = str(inp.row?.['code']);
    if (tid && code && !codeByTypeId.has(tid)) codeByTypeId.set(tid, code);
  }

  // Sync-контракт entities несёт тип в поле `type_id` (entityRowSchema), НЕ
  // `entity_type_id` — чтение не того поля давало entityTypeCode=null для всех
  // entities-строк, и гейты (резерв Ф2, разделы Ф3) молча не применялись к
  // upsert'ам сущностей, хотя их атрибуты уже гейтились. Fallback оставлен на
  // случай легаси-строк в оффлайн-очередях.
  const entityRowTypeId = (inp: SyncWriteInput): string =>
    str(inp.row?.['type_id'] ?? inp.row?.['entity_type_id']);

  // entity_id -> entity_type_id: from this batch's entities rows first, then DB
  // for the rest (an entity created in the same batch is not yet in the DB).
  // ПОРЯДОК ВАЖЕН: сперва БД, батч — только для сущностей, которых в БД ещё нет.
  // Обратный порядок был дырой: клиент слал entities-строку с чужим type_id для
  // СУЩЕСТВУЮЩЕГО сотрудника, гейт резолвил его тип как, скажем, `part`, и
  // employee-гейты к атрибутам этой сущности не применялись. (аудит 2026-08-29)
  const typeIdByEntityId = new Map<string, string>();
  const need = new Set<string>();
  for (const inp of inputs) {
    if (inp.table === SyncTableName.AttributeValues) {
      const eid = str(inp.row?.['entity_id']);
      if (eid) need.add(eid);
    } else if (inp.table === SyncTableName.Entities) {
      const eid = str(inp.row?.['id'] ?? inp.row_id);
      if (eid) need.add(eid);
    }
  }
  if (need.size > 0) {
    const rows = await db
      .select({ id: entities.id, entityTypeId: entities.typeId })
      .from(entities)
      .where(inArray(entities.id, [...need] as string[]));
    for (const r of rows) typeIdByEntityId.set(str(r.id), str(r.entityTypeId));
  }
  for (const inp of inputs) {
    if (inp.table === SyncTableName.Entities) {
      const eid = str(inp.row?.['id'] ?? inp.row_id);
      const tid = entityRowTypeId(inp);
      if (eid && tid && !typeIdByEntityId.has(eid)) typeIdByEntityId.set(eid, tid);
    }
  }

  // attribute_def_id -> code, for the server-only employee-attr backstop below.
  const defIds = new Set<string>();
  for (const inp of inputs) {
    if (inp.table === SyncTableName.AttributeValues) {
      const did = str(inp.row?.['attribute_def_id']);
      if (did) defIds.add(did);
    }
  }
  const codeByDefId = new Map<string, string>();
  if (defIds.size > 0) {
    const defs = await db
      .select({ id: attributeDefs.id, code: attributeDefs.code })
      .from(attributeDefs)
      .where(inArray(attributeDefs.id, [...defIds] as string[]));
    for (const d of defs) codeByDefId.set(str(d.id), str(d.code));
  }
  // Определения, ПРИЕХАВШИЕ В ЭТОМ ЖЕ БАТЧЕ, в БД ещё нет — без них backstop'ы
  // обходятся: клиент кладёт свой attribute_def с защищённым кодом и пишет
  // значение по его id, а гейт видит код как «неизвестный» и пропускает.
  // Но батчевый код НЕ перекрывает код из БД: перекрытие было симметричной
  // дырой — клиент слал attribute_defs-строку с id НАСТОЯЩЕГО `system_role` и
  // безобидным `code`, и backstop переставал узнавать защищённый атрибут.
  // Правило: для гейта берётся более достоверное из двух — код из БД, если
  // определение там есть; батчевый — только для новых id. (аудит 2026-08-29)
  for (const inp of inputs) {
    if (inp.table !== SyncTableName.AttributeDefs) continue;
    const did = str(inp.row?.['id'] ?? inp.row_id);
    const code = str(inp.row?.['code']);
    if (did && code && defIds.has(did) && !codeByDefId.has(did)) codeByDefId.set(did, code);
  }

  // Advisory-резерв двигателя (Ф2). Собираем двигатели, которых касается батч:
  // сама engine-entity, её атрибуты и операции карточки двигателя (по белому
  // списку типов — `engine_entity_id` есть и у нарядов, и у заявок снабжения,
  // а их пишут мастер и снабженец, у которых кнопки резерва нет).
  const reservationGateOn = engineReservationGateEnabled();
  const touchedEngineIds = new Set<string>();
  if (reservationGateOn) {
    for (const inp of inputs) {
      if (inp.table === SyncTableName.Entities) {
        const tid = entityRowTypeId(inp);
        if (codeByTypeId.get(tid) === 'engine') touchedEngineIds.add(str(inp.row?.['id'] ?? inp.row_id));
      } else if (inp.table === SyncTableName.AttributeValues) {
        const eid = str(inp.row?.['entity_id']);
        const tid = eid ? typeIdByEntityId.get(eid) : undefined;
        if (tid && codeByTypeId.get(tid) === 'engine') touchedEngineIds.add(eid);
      } else if (inp.table === SyncTableName.Operations) {
        if (isEngineReservationGatedOperationType(str(inp.row?.['operation_type']))) {
          const eid = str(inp.row?.['engine_entity_id']);
          if (eid) touchedEngineIds.add(eid);
        }
      }
    }
  }
  const reservations =
    touchedEngineIds.size > 0 ? await getLiveEngineReservations([...touchedEngineIds]) : new Map();
  const actorIsAdmin = role === 'admin' || role === 'superadmin';
  const gateNow = Date.now();

  const perms = operatorScoped ? await getEffectivePermissionsForUser(actor.id) : {};

  // Restricted work-order write isolation (Phase 3): map of restricted order id ->
  // owner login. A restricted order may be edited only by its owner or the superadmin,
  // regardless of role (so the plain `admin` / legacy `user` bypass below does not let
  // them through). Fetched once, only when the batch actually touches operations.
  const hasOps = inputs.some((i) => i.table === SyncTableName.Operations);
  const restrictedOwners = hasOps ? await getRestrictedWorkOrderOwners() : new Map<string, string>();
  const restrictedPolicy = hasOps ? await getRestrictedWorkOrderPolicy() : undefined;
  const actorUsername = String(actor.username ?? '');

  // Section viewer write-gate (Ф3): once an actor's membership is seeded, a
  // section write requires editor level in that section — for EVERY role except
  // superadmin (membership is the final word; legacy `user` does not bypass).
  // Unseeded membership (null) or an unmapped write → fail-open, day-one safe.
  const sectionMembership =
    role === 'superadmin' ? null : await getSectionMembershipForLogin(actorUsername);

  const allowed: SyncWriteInput[] = [];
  const denied: SyncSkippedRow[] = [];
  for (const inp of inputs) {
    // Табличный backstop (B3/R3). Строгие таблицы аккаунтов пишет ТОЛЬКО сервер;
    // клиентский пуш в них запрещён любой роли, включая суперадмина, — у него
    // для этого своя дверь (POST /admin/users/:id/section-access, R2).
    // Стоит ДО всего остального: ниже по коду ветка `if (!operatorScoped)`
    // пропускает admin / легаси `user` / pending / employee мимо requirement'ов,
    // а applyPushBatch молча игнорирует таблицу без обработчика — то есть без
    // этого отказа крафтовая строка ушла бы в ledger и не появилась в PG,
    // разведя их беззвучно. С отказом она попадает в skipped и в деньлог.
    if (isServerManagedSyncTable(inp.table)) {
      denied.push({
        table: inp.table,
        row_id: inp.row_id,
        reason: `forbidden:server_managed_table:${inp.table}`,
      });
      continue;
    }

    let entityTypeCode: string | null = null;
    let ownerEntityId: string | null = null;
    let operationType: string | null = null;

    if (inp.table === SyncTableName.Entities) {
      ownerEntityId = str(inp.row?.['id'] ?? inp.row_id);
      entityTypeCode = codeByTypeId.get(entityRowTypeId(inp)) ?? null;
    } else if (inp.table === SyncTableName.AttributeValues) {
      ownerEntityId = str(inp.row?.['entity_id']);
      const tid = typeIdByEntityId.get(ownerEntityId);
      entityTypeCode = tid ? (codeByTypeId.get(tid) ?? null) : null;
    } else if (inp.table === SyncTableName.Operations) {
      operationType = str(inp.row?.['operation_type']);
    }

    // Universal backstop: server-managed employee auth/security attributes are
    // never writable via a client ledger tx, regardless of role. Operators are
    // only own_employee-scoped (which alone would let them write their OWN
    // system_role); legacy user/pending/admin otherwise bypass the gate.
    // (security-hardening-2026-06 C2)
    if (inp.table === SyncTableName.AttributeValues) {
      const attrCode = codeByDefId.get(str(inp.row?.['attribute_def_id'])) ?? null;
      if (isServerOnlyAttrCode(attrCode)) {
        denied.push({
          table: inp.table,
          row_id: inp.row_id,
          reason: `forbidden:employee_auth_attr:${attrCode}`,
        });
        continue;
      }
      // Управление доступами — только суперадмин (owner decision 2026-07-26).
      // Без этого own_employee-правило позволяло бы оператору выдать СЕБЕ
      // section_access editor'ом всех разделов крафтовой ledger-записью.
      if (role !== 'superadmin' && isSuperadminOnlyAttrCode(attrCode)) {
        denied.push({
          table: inp.table,
          row_id: inp.row_id,
          reason: `forbidden:superadmin_only_attr:${attrCode}`,
        });
        continue;
      }
      // Резерв — server-managed (пишется только через REST с серверными часами):
      // клиент не может ни подделать чужой замок, ни стереть свой оффлайн. Заодно
      // гейт ниже не блокирует сам себя — снятие замка не проходит этим путём.
      if (attrCode === ENGINE_RESERVATION_CODE) {
        denied.push({
          table: inp.table,
          row_id: inp.row_id,
          reason: `forbidden:server_managed_attr:${ENGINE_RESERVATION_CODE}`,
        });
        continue;
      }
    }

    // Advisory-резерв двигателя (Ф2): мягкий гейт — чужие правки занятого
    // двигателя уезжают в skipped, батч не падает, очередь не отравляется.
    // Правки со штампом раньше взятия замка (оффлайн-планшет) проходят.
    if (reservationGateOn && reservations.size > 0) {
      let gatedEngineId = '';
      if (inp.table === SyncTableName.Entities && entityTypeCode === 'engine') {
        gatedEngineId = str(inp.row?.['id'] ?? inp.row_id);
      } else if (inp.table === SyncTableName.AttributeValues && entityTypeCode === 'engine') {
        gatedEngineId = str(inp.row?.['entity_id']);
      } else if (
        inp.table === SyncTableName.Operations &&
        isEngineReservationGatedOperationType(str(inp.row?.['operation_type']))
      ) {
        gatedEngineId = str(inp.row?.['engine_entity_id']);
      }

      const reservation = gatedEngineId ? (reservations.get(gatedEngineId) ?? null) : null;
      if (
        reservation &&
        isEngineEditBlockedByReservation({
          reservation,
          actorUserId: str(actor.id),
          rowUpdatedAt: Number(inp.row?.['updated_at'] ?? 0),
          nowMs: gateNow,
          actorIsAdmin,
        })
      ) {
        denied.push({ table: inp.table, row_id: inp.row_id, reason: engineReservationSkipReason(reservation) });
        continue;
      }
    }

    // Restricted work-order write isolation (Phase 3): only the owner or the
    // superadmin may edit a restricted order. Runs BEFORE the non-operator bypass
    // so admin / legacy `user` (and the read-allowlist accountant) are caught too.
    if (inp.table === SyncTableName.Operations) {
      const owner = restrictedOwners.get(str(inp.row?.['id'] ?? inp.row_id));
      if (
        owner &&
        !canEditWorkOrder({
          editorLogin: actorUsername,
          editorRole: role,
          ownerLogin: owner,
          ...(restrictedPolicy ? { policy: restrictedPolicy } : {}),
        })
      ) {
        denied.push({ table: inp.table, row_id: inp.row_id, reason: 'forbidden:restricted_work_order' });
        continue;
      }
    }

    // Section viewer write-gate (Ф3). Own employee record stays writable at any
    // level (profile self-service parity with the own_employee requirement).
    if (sectionMembership) {
      const section = sectionForLedgerWrite({ table: inp.table, entityTypeCode, operationType });
      const ownEmployeeRow = entityTypeCode === 'employee' && !!ownerEntityId && ownerEntityId === actor.id;
      if (section && !ownEmployeeRow) {
        const level = sectionLevelFor({ membership: sectionMembership, role, sectionId: section });
        if (level !== 'editor') {
          denied.push({ table: inp.table, row_id: inp.row_id, reason: `forbidden:section_viewer:${section}` });
          continue;
        }
      }
    }

    // Operator scoping (RBAC #474). Non-operator roles keep today's behavior
    // (additive migration) for everything except the backstop above.
    if (!operatorScoped) {
      allowed.push(inp);
      continue;
    }

    const req = ledgerWriteRequirement({ table: inp.table, entityTypeCode, operationType });
    const ok = operatorMeetsRequirement(req, { perms, actorId: actor.id, ownerEntityId });
    if (ok) {
      allowed.push(inp);
    } else {
      denied.push({
        table: inp.table,
        row_id: inp.row_id,
        reason: `forbidden:${entityTypeCode || operationType || inp.table}`,
      });
    }
  }
  return { allowed, denied };
}
