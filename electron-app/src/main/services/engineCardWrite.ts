import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { engineInternalNumberDuplicateMessage, engineInternalNumberKey, normalizeLookupCompact } from '@matricarmz/shared';

import {
  engineHasDuplicateBypassFlag,
  ensureEngineRow,
  findEngineDuplicateByNumber,
  findEngineInternalNumberDuplicate,
  getEngineAttrDefs,
} from './engineService.js';
import { isKnownEngineCardCode, readEngineCardStrict, saveEngineCardStrict } from './engineCardsReplica.js';
import { ensureRepairStageRow } from './repairStageService.js';

/**
 * Единственная дверь записи карточки двигателя (E3b + пакетный приём списком).
 *
 * Гейты дублей и авто-этапы живут здесь, а не в IPC-обработчике: у карточки с
 * 10.2026 появился второй вход — «Принять двигатели списком» заводит карточки
 * пачкой. Пока логика лежала в `engines:card:save`, второй вход либо копировал
 * бы гейты (и однажды разошёлся бы с ними), либо обходил их вовсе — класс
 * brain G363 (право/гейт держат в одном экране, а не по всему периметру).
 */
export type EngineCardWriteDeps = {
  db: BetterSQLite3Database;
  actor: string;
  /** `work_sheets.edit` ИЛИ `operations.edit` — сверяет вызывающий (у него права под рукой). */
  canWriteStageRow: boolean;
};

export type EngineCardWriteResult = { ok: true; changed: boolean } | { ok: false; error: string };

export async function saveEngineCardGated(
  deps: EngineCardWriteDeps,
  idRaw: string,
  rawFields: Record<string, unknown>,
): Promise<EngineCardWriteResult> {
  try {
    const id = String(idRaw ?? '').trim();
    if (!id) return { ok: false, error: 'пустой id двигателя' };
    const fields = rawFields ?? {};
    if (typeof fields !== 'object' || Array.isArray(fields)) {
      return { ok: false, error: 'ожидался объект полей карточки' };
    }
    const bad = Object.keys(fields).filter((k) => !isKnownEngineCardCode(k));
    if (bad.length > 0) return { ok: false, error: `неизвестные поля карточки двигателя: ${bad.join(', ')}` };
    const db = deps.db;
    const replica = await readEngineCardStrict(db, id);
    if (fields.engine_number !== undefined && fields.engine_number !== null) {
      const next = String(fields.engine_number ?? '');
      const key = normalizeLookupCompact(next);
      if (key) {
        const dup = await findEngineDuplicateByNumber(db, next, id);
        if (dup) {
          const explicit = fields.repeat_arrival_flag !== undefined || fields.number_collision_flag !== undefined;
          const bypass = explicit
            ? fields.repeat_arrival_flag === true || fields.number_collision_flag === true
            : Boolean(replica?.repeatArrivalFlag || replica?.numberCollisionFlag) ||
              (await engineHasDuplicateBypassFlag(db, id, await getEngineAttrDefs(db)));
          if (!bypass) {
            return {
              ok: false,
              error: `Двигатель с номером «${dup.engineNumber}» уже существует. Откройте его карточку вместо создания дубля.`,
            };
          }
        }
      }
    }
    if (fields.engine_internal_number !== undefined || fields.engine_internal_number_year !== undefined) {
      const rep = replica as Record<string, unknown> | null;
      const num =
        fields.engine_internal_number !== undefined && fields.engine_internal_number !== null
          ? String(fields.engine_internal_number ?? '')
          : rep?.engineInternalNumber != null
            ? String(rep.engineInternalNumber)
            : null;
      const year =
        fields.engine_internal_number_year !== undefined && fields.engine_internal_number_year !== null
          ? (fields.engine_internal_number_year as number)
          : ((rep?.engineInternalNumberYear as number | null) ?? null);
      if (num !== null) {
        const key = engineInternalNumberKey(num, year);
        if (key) {
          const dup = await findEngineInternalNumberDuplicate(db, num, year, id);
          if (dup) return { ok: false, error: engineInternalNumberDuplicateMessage(dup) };
        }
      }
    }
    // Deferred-create (как setAttr): сущность материализуется первой реальной
    // записью — брошенная пустая карточка призрака не оставляет. Строго после
    // гейтов: отбитая запись не должна создавать сущность.
    await ensureEngineRow(db, id, Date.now(), deps.actor);
    const saved = await saveEngineCardStrict(db, id, fields, Date.now());
    // Даты «Основного» — в этапы единого списка (таблица 05.10.2026). В main, а не
    // в рендерере: там запись шла через `workSheets:stages:save` под правом
    // `work_sheets.edit` (поимённое, у производственных ролей его нет) — дату
    // сохраняли, а этап молча не появлялся (замер 07.10: 70 записей от инженера
    // за утро без единого этапа). Права сверяет вызывающий: у `engines:card:save`
    // это `engines.edit`, у пакетного приёма — он же.
    // На сервере строку этапа примет дизъюнкция `work_sheets.edit` ИЛИ
    // `operations.edit` (ledgerAuthz); роль без обоих прав (technolog) строку не
    // получит — сверяемся заранее, чтобы не создавать её в реплике и не гонять
    // отклонённый push. Даты берём из СВЕЖЕЙ строки реплики, а не из присланных
    // полей: тогда любой сейв карточки долечивает недостающий этап, даже если саму
    // дату не трогали (иначе 78 старых движков ждали бы ручной правки даты).
    // Тот же mark-if-absent, что у EAV-пути (`setEngineAttribute`): идемпотентно,
    // дату существующей строки правит только «История ремонта». Best-effort:
    // карточка уже сохранена.
    if (deps.canWriteStageRow) {
      const fresh = await readEngineCardStrict(db, id);
      const actor = deps.actor || 'local';
      const stageFromDate = async (code: string, raw: unknown): Promise<void> => {
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return;
        try {
          await ensureRepairStageRow(db, id, code, Math.trunc(raw), actor);
        } catch {
          /* авто-метка — не причина терять карточку */
        }
      };
      await stageFromDate('arrival', fresh?.arrivalDate);
      await stageFromDate('shipped', fresh?.statusCustomerSentDate);
      await stageFromDate('accepted', fresh?.statusCustomerAcceptedDate);
    }
    return { ok: true, changed: saved.changed };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
