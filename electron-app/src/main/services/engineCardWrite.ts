import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  engineInternalNumberDuplicateMessage,
  engineInternalNumberKey,
  engineKindRequirement,
  normalizeLookupCompact,
} from '@matricarmz/shared';

import {
  engineEntityExists,
  engineHasDuplicateBypassFlag,
  ensureEngineRow,
  findEngineDuplicateByNumber,
  findEngineInternalNumberDuplicate,
  getContractKindById,
  getEngineAttrDefs,
} from './engineService.js';
import { isKnownEngineCardCode, readEngineCardStrict, saveEngineCardStrict } from './engineCardsReplica.js';
import { syncCardDateStageRow } from './repairStageService.js';

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

export type EngineCardWriteResult =
  | { ok: true; changed: boolean; warnings?: string[] }
  | { ok: false; error: string };

/**
 * Значение поля для гейта: присланное (даже пустое — это «оператор снял») либо то,
 * что уже лежит в карточке. Пустая строка и null — «значения нет».
 */
function pickField(incoming: unknown, existing: unknown): string {
  const raw = incoming !== undefined ? incoming : existing;
  return String(raw ?? '').trim();
}

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
    // Гейт вида при ЗАВЕДЕНИИ (промты КАРМАНА #36 + #37): новый двигатель нельзя
    // сохранить без вида — договор уже выбран (вид возьмётся из него) либо оператор
    // поставил вид руками. Строго только при первичном заведении: правка старой
    // карточки, заведённой до появления вида, блокироваться не должна (иначе
    // программа станет непригодна) — такие карточки видны в списке по ступени
    // «Вид не задан».
    // Гейт живёт здесь, а не в форме: у карточки два входа записи (карточка и
    // пачечный приём), и проверка в форме обошлась бы пачкой (класс brain G363).
    if (!(await engineEntityExists(db, id))) {
      const contractId = pickField(fields.contract_id, (replica as Record<string, unknown> | null)?.contractId);
      const manualKind = pickField(fields.engine_kind, (replica as Record<string, unknown> | null)?.engineKind);
      const contractKind = contractId ? await getContractKindById(db, contractId) : null;
      const required = engineKindRequirement({ contractKind, cardKind: manualKind });
      if (!required.ok) return { ok: false, error: required.error };
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
    //
    // Этап помнит СВОЙ ИСТОЧНИК (промты КАРМАНА #133/#136, решение владельца
    // 25.11.2026): сняли дату — этап, ею порождённый, погас; поменяли — этап пришёл к
    // новой дате. Раньше было mark-if-absent: дата удалялась, а этап оставался навсегда.
    // Отказ по правам больше не проглатывается молча — возвращается предупреждением,
    // карточка его показывает (решение владельца: «дата сохранена, этап не записан»).
    const warnings: string[] = [];
    const fresh = await readEngineCardStrict(db, id);
    const actor = deps.actor || 'local';
    const dateOf = (raw: unknown): number | null =>
      typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : null;
    const cardDateStages: Array<{ code: string; name: string; attr: string; at: number | null }> = [
      { code: 'arrival', name: 'Приемка двигателя на завод', attr: 'arrival_date', at: dateOf(fresh?.arrivalDate) },
      { code: 'shipped', name: 'Отгрузка двигателя заказчику', attr: 'status_customer_sent_date', at: dateOf(fresh?.statusCustomerSentDate) },
      { code: 'accepted', name: 'Приемка двигателя заказчиком', attr: 'status_customer_accepted_date', at: dateOf(fresh?.statusCustomerAcceptedDate) },
    ];
    if (deps.canWriteStageRow) {
      for (const stage of cardDateStages) {
        try {
          const res = await syncCardDateStageRow(db, id, stage.code, stage.attr, stage.at, actor);
          if (!res.ok) warnings.push(`Этап «${stage.name}» не записан: ${res.error}`);
        } catch (e) {
          warnings.push(`Этап «${stage.name}» не записан: ${String(e)}`);
        }
      }
    } else if (cardDateStages.some((s) => s.at !== null)) {
      // Права нет — дата сохранилась, этап не появился. Молчать об этом нельзя:
      // оператор увидит в истории двигателя одно, а в карточке другое.
      warnings.push('Нет права на запись этапов: даты карточки сохранены, этапы ремонта не обновлены');
    }
    return { ok: true, changed: saved.changed, warnings };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
