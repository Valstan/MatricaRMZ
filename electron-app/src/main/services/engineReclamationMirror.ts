import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { sortEngineReclamations, type EngineReclamationDto } from '@matricarmz/shared';

import { setEngineAttribute } from './engineService.js';

/**
 * EAV-зеркало текущей рекламации.
 *
 * Зачем оно нужно, если отслеживание читает очередь:
 *  · клиенты парка на прежней версии читают признак и даты рекламации из EAV — без
 *    зеркала они рекламацию не видят (парк обновляется не одномоментно);
 *  · серверная проекция карточки (`erp_engine_cards.reclamation_*`) и ИИ-инструменты
 *    берут рекламацию тоже из EAV/карточки.
 *
 * Почему зеркало поддерживаем здесь, а не в карточке: раньше оно копилось только при
 * сохранении карточки (`onPatchMirror` → pending-атрибуты), а «Сохранить очередь»
 * писал очередь и больше ничего. Отсюда и был обрыв: очередь есть, а отслеживания
 * нет ни в одном отчёте. Теперь зеркало пишется в тот же момент, когда сервер принял
 * очередь.
 *
 * Зеркало хранит ТЕКУЩУЮ (последнюю по номеру очереди) рекламацию — ровно то, что
 * значит «сейчас» для двигателя. Вся история заездов лежит в очереди.
 */

/** Коды зеркала — те же, что читала программа до перехода на очередь. */
export const RECLAMATION_MIRROR_CODES = [
  'reclamation_flag',
  'reclamation_accepted_date',
  'reclamation_shipped_date',
  'reclamation_customer_reason',
  'reclamation_actual_defect',
  'reclamation_defect_nature',
  'reclamation_act_number',
  'reclamation_verdict_date',
  'reclamation_comment',
] as const;

function text(value: string | null | undefined): string | null {
  const t = String(value ?? '').trim();
  return t ? t : null;
}

/** Значения зеркала по текущей рекламации (пустая очередь → признак снят, дат нет). */
export function reclamationMirrorValues(
  rows: readonly Pick<
    EngineReclamationDto,
    | 'queueNo'
    | 'acceptedAt'
    | 'shippedAt'
    | 'customerReason'
    | 'actualDefect'
    | 'defectNature'
    | 'actNumber'
    | 'actDate'
    | 'comment'
  >[],
): Array<[string, unknown]> {
  const queue = sortEngineReclamations(rows ?? []);
  const current = queue.length > 0 ? queue[queue.length - 1] : null;
  if (!current) {
    return [
      ['reclamation_flag', false],
      ['reclamation_accepted_date', null],
      ['reclamation_shipped_date', null],
      ['reclamation_customer_reason', null],
      ['reclamation_actual_defect', null],
      ['reclamation_defect_nature', null],
      ['reclamation_act_number', null],
      ['reclamation_verdict_date', null],
      ['reclamation_comment', null],
    ];
  }
  return [
    ['reclamation_flag', true],
    ['reclamation_accepted_date', current.acceptedAt == null ? null : Number(current.acceptedAt)],
    ['reclamation_shipped_date', current.shippedAt == null ? null : Number(current.shippedAt)],
    ['reclamation_customer_reason', text(current.customerReason)],
    ['reclamation_actual_defect', text(current.actualDefect)],
    ['reclamation_defect_nature', text(current.defectNature)],
    ['reclamation_act_number', text(current.actNumber)],
    ['reclamation_verdict_date', current.actDate == null ? null : Number(current.actDate)],
    ['reclamation_comment', text(current.comment)],
  ];
}

/**
 * Записать зеркало текущей рекламации в EAV двигателя.
 *
 * Best-effort по каждому коду: отсутствующий на этой установке атрибут не должен
 * ронять сохранение очереди (очередь на сервере уже принята). Ошибки не молчалив —
 * возвращаются списком, чтобы вызывающий мог их показать.
 */
export async function syncEngineReclamationMirror(
  db: BetterSQLite3Database,
  engineId: string,
  rows: readonly Pick<
    EngineReclamationDto,
    | 'queueNo'
    | 'acceptedAt'
    | 'shippedAt'
    | 'customerReason'
    | 'actualDefect'
    | 'defectNature'
    | 'actNumber'
    | 'actDate'
    | 'comment'
  >[],
  actor?: string,
): Promise<string[]> {
  const errors: string[] = [];
  for (const [code, value] of reclamationMirrorValues(rows)) {
    try {
      await setEngineAttribute(db, engineId, code, value, actor);
    } catch (e) {
      errors.push(`${code}: ${String(e)}`);
    }
  }
  return errors;
}
