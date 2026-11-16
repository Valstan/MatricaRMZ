/**
 * Восстановление карточек сотрудников, чьи атрибуты не доехали до сервера.
 *
 * СИТУАЦИЯ (инцидент 16.11.2026, клиент PC63, оператор «hapik»). Клиент создал
 * сотрудника и опубликовал строку `entities`, но строки `attribute_values`
 * (ФИО, должность, табельный номер, даты) на сервер не ушли: на клиенте они
 * остались в статусе `pending`. Серверное зеркало СИЗ (`erp_employee_cards`)
 * берёт сотрудников по ФИО — без атрибутов сотрудник в зеркало не попадает, и
 * карточки спецодежды у него нет ни на сервере, ни у клиентов.
 *
 * ЧТО ДЕЛАЕТ СКРИПТ. Берёт данные карточки из `card_drafts` (kind='recovery') —
 * это снимок формы, который клиент сам публикует по ходу правки. Значит, данные
 * принадлежат оператору, а не восстановлены «по догадке». Атрибуты пишутся
 * обычным путём синка (`recordSyncChanges`), поэтому их получают все клиенты.
 *
 * Usage:
 *   pnpm -F @matricarmz/backend-api employees:restore-from-drafts
 *   pnpm -F @matricarmz/backend-api employees:restore-from-drafts -- --apply
 *   … --apply --mirror        после записи прогнать зеркало СИЗ
 *   … --entity=<id>           только один сотрудник
 *
 * Dry-run по умолчанию: ничего не пишет.
 */
import { randomUUID } from 'node:crypto';

import { SyncTableName } from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { recordSyncChanges } from '../services/sync/syncChangeService.js';

type Actor = { id: string; username: string; role: 'superadmin' };

const ACTOR: Actor = { id: 'system', username: 'system', role: 'superadmin' };

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const MIRROR = args.includes('--mirror');
const onlyEntity = (args.find((a) => a.startsWith('--entity=')) ?? '').split('=')[1]?.trim() || null;

type DraftPayload = {
  lastName?: string | null;
  firstName?: string | null;
  middleName?: string | null;
  position?: string | null;
  departmentId?: string | null;
  workshopId?: string | null;
  attachments?: unknown;
  personnelNumber?: string | null;
  birthDate?: string | null;
  employmentStatus?: string | null;
  hireDate?: string | null;
  terminationDate?: string | null;
  transfers?: unknown;
  customDraftValues?: Record<string, unknown>;
};

/** Дата формы «YYYY-MM-DD» → миллисекунды полуночи по часовому поясу сервера. */
function inputDateToMs(value: string | null | undefined): number | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const [y, m, d] = text.split('-').map((x) => Number(x));
  if (!y || !m || !d) return null;
  const ms = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function fullNameOf(p: DraftPayload): string {
  return [p.lastName, p.firstName, p.middleName]
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

/** Поля черновика → коды атрибутов сотрудника. Значение — уже готовое для JSON. */
function draftToValues(p: DraftPayload): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const set = (code: string, value: unknown) => {
    if (value === null || value === undefined || value === '') return;
    out[code] = value;
  };
  set('last_name', String(p.lastName ?? '').trim() || null);
  set('first_name', String(p.firstName ?? '').trim() || null);
  set('middle_name', String(p.middleName ?? '').trim() || null);
  set('full_name', fullNameOf(p) || null);
  set('role', String(p.position ?? '').trim() || null);
  set('personnel_number', String(p.personnelNumber ?? '').trim() || null);
  set('employment_status', String(p.employmentStatus ?? '').trim() || null);
  set('birth_date', inputDateToMs(p.birthDate));
  set('hire_date', inputDateToMs(p.hireDate));
  set('termination_date', inputDateToMs(p.terminationDate));
  set('department_id', String(p.departmentId ?? '').trim() || null);
  set('workshop_id', String(p.workshopId ?? '').trim() || null);
  if (Array.isArray(p.attachments)) out['attachments'] = p.attachments;
  if (Array.isArray(p.transfers)) out['transfers'] = p.transfers;
  for (const [code, value] of Object.entries(p.customDraftValues ?? {})) {
    if (value === null || value === undefined || value === '') continue;
    out[code] = value;
  }
  return out;
}

async function main() {
  const client = await pool.connect();
  try {
    // 1. Тип «сотрудник» и справочник его атрибутов.
    const typeRes = await client.query<{ id: string }>(
      `select id::text as id from entity_types where code = 'employee' and deleted_at is null limit 1`,
    );
    const employeeTypeId = typeRes.rows[0]?.id;
    if (!employeeTypeId) throw new Error('Тип сущности employee не найден');

    const defRes = await client.query<{ code: string; id: string }>(
      `select code, id::text as id from attribute_defs
        where entity_type_id = $1 and deleted_at is null`,
      [employeeTypeId],
    );
    const defByCode = new Map(defRes.rows.map((r) => [r.code, r.id]));

    // 2. Сотрудники без единого атрибута — их и восстанавливаем.
    const empRes = await client.query<{ id: string; created_at: number }>(
      `select e.id::text as id, e.created_at
         from entities e
        where e.type_id = $1 and e.deleted_at is null
          and not exists (
            select 1 from attribute_values v
             where v.entity_id = e.id and v.deleted_at is null
          )
        order by e.created_at`,
      [employeeTypeId],
    );
    const empty = empRes.rows.filter((r) => !onlyEntity || r.id === onlyEntity);
    if (empty.length === 0) {
      console.log('Сотрудников без атрибутов нет — восстанавливать нечего.');
      return;
    }

    // 3. Свежий recovery-черновик по каждому такому сотруднику.
    const draftRes = await client.query<{
      card_id: string;
      payload_json: string;
      owner_user_id: string;
      updated_at: number;
    }>(
      `select card_id, payload_json, owner_user_id, updated_at
         from card_drafts
        where card_type = 'employee' and card_id = any($1::uuid[])
        order by updated_at desc`,
      [empty.map((r) => r.id)],
    );
    const draftByCard = new Map<string, { payload_json: string; owner_user_id: string; updated_at: number }>();
    for (const row of draftRes.rows) {
      if (!draftByCard.has(row.card_id)) draftByCard.set(row.card_id, row);
    }

    const rows: Record<string, unknown>[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];

    for (const emp of empty) {
      const draft = draftByCard.get(emp.id);
      if (!draft) {
        skipped.push({ id: emp.id, reason: 'черновика нет' });
        continue;
      }
      let payload: DraftPayload;
      try {
        payload = JSON.parse(draft.payload_json) as DraftPayload;
      } catch {
        skipped.push({ id: emp.id, reason: 'черновик не читается' });
        continue;
      }
      const values = draftToValues(payload);
      const fullName = fullNameOf(payload);
      if (!fullName) {
        skipped.push({ id: emp.id, reason: 'в черновике нет ФИО' });
        continue;
      }
      const codes = Object.keys(values);
      const unknown = codes.filter((code) => !defByCode.has(code));
      if (unknown.length > 0) {
        skipped.push({ id: emp.id, reason: `нет атрибута: ${unknown.join(', ')}` });
        continue;
      }
      console.log(
        `${emp.id}  ${fullName}  полей: ${codes.length}  черновик от ${new Date(draft.updated_at).toISOString()}`,
      );
      const ts = Date.now();
      for (const [code, value] of Object.entries(values)) {
        rows.push({
          id: randomUUID(),
          entity_id: emp.id,
          attribute_def_id: defByCode.get(code)!,
          value_json: JSON.stringify(value ?? null),
          created_at: ts,
          updated_at: ts,
          deleted_at: null,
          sync_status: 'synced',
        });
      }
    }

    for (const s of skipped) console.log(`ПРОПУЩЕН ${s.id}: ${s.reason}`);
    console.log(`К восстановлению: ${empty.length - skipped.length} сотрудников, строк атрибутов: ${rows.length}`);

    if (!APPLY) {
      console.log('РЕЖИМ: dry-run (ничего не записано; добавьте --apply)');
      return;
    }
    if (rows.length === 0) {
      console.log('Нечего записывать.');
      return;
    }

    const chunk = 500;
    for (let i = 0; i < rows.length; i += chunk) {
      const batch = rows.slice(i, i + chunk);
      await recordSyncChanges(
        ACTOR,
        batch.map((row) => ({
          op: 'upsert' as const,
          tableName: SyncTableName.AttributeValues,
          rowId: String(row.id),
          payload: row,
        })),
        { allowSyncConflicts: true },
      );
      console.log(`attribute_values: ${Math.min(i + chunk, rows.length)}/${rows.length}`);
    }
    console.log('Записано. Атрибуты уедут клиентам обычным путём синка.');

    if (MIRROR) {
      const { mirrorPpeEmployees } = await import('../services/ppeEmployeeMirror.js');
      const report = await mirrorPpeEmployees({ apply: true });
      console.log(
        `Зеркало СИЗ: создать ${report.created}, обновить ${report.updated}, без изменений ${report.untouched}`,
      );
    }
  } finally {
    client.release();
  }
}

main()
  .then(async () => {
    await pool.end();
  })
  .catch(async (e) => {
    console.error('FATAL:', e instanceof Error ? e.message : String(e));
    await pool.end().catch(() => undefined);
    process.exitCode = 1;
  });
