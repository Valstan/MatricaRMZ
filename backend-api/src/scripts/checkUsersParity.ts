import 'dotenv/config';

import { pool } from '../database/db.js';

// B3/R1 parity: EAV ↔ строгие таблицы (users / user_credentials /
// user_section_access / user_settings), заведённые миграцией 0086.
//
// Зачем отдельный скрипт, а не «доверять триггеру». Источник правды на этапе R1
// остаётся в EAV, а строгие таблицы держатся триггерами — то есть КОДОМ, который
// может разойтись с данными молча: пропущенный путь записи, отключённый триггер,
// ручной UPDATE, восстановление из дампа мимо триггеров. Расхождение здесь ничем
// себя не проявит до R2, когда на строгие таблицы переедут читатели, — и тогда
// это будет выглядеть как «у человека пропал доступ», а не как «зеркало отстало».
//
// Ожидаемое состояние выводится ЗАНОВО из EAV на TypeScript — намеренно вторая,
// независимая реализация той же логики, что в SQL-функции rebuild_user. Копия
// SQL-запроса ловила бы только порчу данных; независимый вывод ловит ещё и
// ошибку самой функции.
//
// Read-only. Безопасен на проде.
//
// Usage:
//   pnpm -F @matricarmz/backend-api users:parity
//   pnpm -F @matricarmz/backend-api users:parity -- --json
//   pnpm -F @matricarmz/backend-api users:parity -- --limit 20
//
// Exit code: 0 — расхождений нет; 1 — есть (годится как гейт в CI).

const SUPERADMIN_LOGIN = 'valstan';

// Зеркало SYSTEM_ROLE_CATALOG. Список продублирован намеренно: скрипт обязан
// сверять то, что записано в CHECK миграции, а не то, что импортировал из того
// же модуля, откуда взялась запись.
const ROLE_SET = new Set([
  'superadmin',
  'admin',
  'engineer',
  'technolog',
  'master',
  'supply',
  'storekeeper',
  'timekeeper',
  'viewer',
  'user',
  'pending',
  'employee',
]);

const SECTION_LEVELS = new Set(['viewer', 'editor']);

type Mismatch = { entityId: string; kind: string; expected: unknown; actual: unknown };

// Зеркало SQL-функции eav_emp_text: приведение к jsonb и извлечение через #>>
// с пустым путём. Тонкость, из-за которой прежняя версия врала: JSON-литерал
// null в value_json (а такие строки в EAV встречаются — см. защитный фильтр в
// backfillSectionAccess) SQL отдаёт как NULL, а наивный String(raw) давал
// непустую строку 'null'. Расхождение сделало бы parity красным на проде в
// местах, где зеркало на самом деле право.
function parseEavText(raw: string | null): string | null {
  if (raw == null) return null;
  let out: string;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null) return null;
    if (typeof parsed === 'string') out = parsed;
    else if (typeof parsed === 'object') out = JSON.stringify(parsed);
    else out = String(parsed);
  } catch {
    out = raw;
  }
  return out === '' ? null : out;
}

// СТРОГО как продукт: employeeAuthService сравнивает через ===, поэтому '"1"',
// '"yes"' и '"true"' доступом не являются. Толерантный разбор был бы
// расхождением в сторону fail-open — в зеркале доступ появился бы там, где
// программа его не даёт.
// Только НАСТОЯЩИЙ булев, как `=== true` в продукте. Через parseEavText делать
// нельзя: распаковка приводит JSON-строку "true" и булев true к одному тексту.
function parseEavBool(raw: string | null): boolean | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'boolean' ? parsed : null;
  } catch {
    return null;
  }
}

function parseEavMs(raw: string | null): number | null {
  const txt = parseEavText(raw);
  if (txt == null) return null;
  const n = Number(txt);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function parseEavObject(raw: string | null): Record<string, unknown> | null {
  const txt = parseEavText(raw);
  if (txt == null) return null;
  try {
    const v = JSON.parse(txt);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Независимая реализация rebuild_user: login → роль, как её видит normalizeRole. */
function expectedRole(login: string, rawRole: string | null): string {
  if (login === SUPERADMIN_LOGIN) return 'superadmin';
  const r = (rawRole ?? '').trim().toLowerCase();
  return ROLE_SET.has(r) ? r : 'employee';
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const limitArg = args.indexOf('--limit');
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : 50;

  const mismatches: Mismatch[] = [];

  // 1) Всё EAV-состояние сотрудников одним проходом.
  const eav = await pool.query<{
    entity_id: string;
    entity_deleted_at: string | null;
    code: string;
    value_json: string | null;
  }>(
    `SELECT e.id AS entity_id, e.deleted_at AS entity_deleted_at, ad.code, av.value_json
       FROM entities e
       JOIN entity_types t ON t.id = e.type_id AND t.code = 'employee'
       LEFT JOIN attribute_values av ON av.entity_id = e.id AND av.deleted_at IS NULL
       LEFT JOIN attribute_defs ad ON ad.id = av.attribute_def_id`,
  );

  const byEntity = new Map<string, { deletedAt: number | null; attrs: Map<string, string | null> }>();
  for (const row of eav.rows) {
    let rec = byEntity.get(row.entity_id);
    if (!rec) {
      rec = {
        deletedAt: row.entity_deleted_at == null ? null : Number(row.entity_deleted_at),
        attrs: new Map(),
      };
      byEntity.set(row.entity_id, rec);
    }
    if (row.code) rec.attrs.set(row.code, row.value_json);
  }

  // 2) Строгие таблицы.
  const usersRows = await pool.query<{
    id: string;
    login: string;
    system_role: string;
    access_enabled: boolean;
    deleted_at: string | null;
    delete_requested_at: string | null;
    delete_requested_by: string | null;
  }>(`SELECT id, login, system_role, access_enabled, deleted_at, delete_requested_at, delete_requested_by FROM users`);
  const usersById = new Map(usersRows.rows.map((r) => [r.id, r]));

  const credRows = await pool.query<{ user_id: string; password_hash: string }>(
    `SELECT user_id, password_hash FROM user_credentials`,
  );
  const credByUser = new Map(credRows.rows.map((r) => [r.user_id, r.password_hash]));

  const sectionRows = await pool.query<{ user_id: string; section_id: string; level: string; deleted_at: string | null }>(
    `SELECT user_id, section_id, level, deleted_at FROM user_section_access WHERE deleted_at IS NULL`,
  );
  const sectionsByUser = new Map<string, Map<string, string>>();
  for (const r of sectionRows.rows) {
    let m = sectionsByUser.get(r.user_id);
    if (!m) {
      m = new Map();
      sectionsByUser.set(r.user_id, m);
    }
    m.set(r.section_id, r.level);
  }

  const knownSections = new Set(
    (await pool.query<{ id: string }>(`SELECT id FROM access_sections`)).rows.map((r) => r.id),
  );

  // 3) Сверка по каждой карточке сотрудника.
  for (const [entityId, rec] of byEntity) {
    const login = (parseEavText(rec.attrs.get('login') ?? null) ?? '').trim().toLowerCase();
    const row = usersById.get(entityId);

    // Карточка без логина — ЖИВОГО аккаунта быть не должно. Тумбстоун допустим и
    // обязателен: с B3/R3 снятие логина гасит строку, а не сносит (0088). Иначе
    // снятый аккаунт остался бы жить в реплике каждой машины парка — клиент
    // применяет pull только апсертами и строк, которых нет в ответе, не удаляет.
    if (login === '') {
      if (row && row.deleted_at == null) {
        mismatches.push({ entityId, kind: 'users:живая строка есть, а логина в EAV нет', expected: null, actual: row.login });
      }
      continue;
    }

    if (!row) {
      mismatches.push({ entityId, kind: 'users:строки нет, а логин в EAV есть', expected: login, actual: null });
      continue;
    }

    if (row.login !== login) {
      mismatches.push({ entityId, kind: 'users.login', expected: login, actual: row.login });
    }

    const wantRole = expectedRole(login, parseEavText(rec.attrs.get('system_role') ?? null));
    if (row.system_role !== wantRole) {
      mismatches.push({ entityId, kind: 'users.system_role', expected: wantRole, actual: row.system_role });
    }

    const wantAccess = parseEavBool(rec.attrs.get('access_enabled') ?? null) ?? false;
    if (row.access_enabled !== wantAccess) {
      mismatches.push({ entityId, kind: 'users.access_enabled', expected: wantAccess, actual: row.access_enabled });
    }

    const wantDeleted = rec.deletedAt;
    const gotDeleted = row.deleted_at == null ? null : Number(row.deleted_at);
    if ((wantDeleted == null) !== (gotDeleted == null)) {
      mismatches.push({ entityId, kind: 'users.deleted_at', expected: wantDeleted, actual: gotDeleted });
    }

    // Заявка на удаление. Инициатор проставляется, только если у него самого есть
    // аккаунт (FK) и дата на месте (асимметричный CHECK) — обе страховки в rebuild_user.
    const wantReqAt = parseEavMs(rec.attrs.get('delete_requested_at') ?? null);
    const gotReqAt = row.delete_requested_at == null ? null : Number(row.delete_requested_at);
    if (wantReqAt !== gotReqAt) {
      mismatches.push({ entityId, kind: 'users.delete_requested_at', expected: wantReqAt, actual: gotReqAt });
    }
    const rawReqBy = parseEavText(rec.attrs.get('delete_requested_by_id') ?? null);
    const wantReqBy = wantReqAt != null && rawReqBy && usersById.has(rawReqBy) ? rawReqBy : null;
    if ((row.delete_requested_by ?? null) !== wantReqBy) {
      mismatches.push({ entityId, kind: 'users.delete_requested_by', expected: wantReqBy, actual: row.delete_requested_by ?? null });
    }

    // Кред: строка ровно тогда, когда хэш непустой.
    const wantHash = (parseEavText(rec.attrs.get('password_hash') ?? null) ?? '').trim();
    const gotHash = credByUser.get(entityId) ?? '';
    if (wantHash === '' && gotHash !== '') {
      mismatches.push({ entityId, kind: 'user_credentials:строка есть, а хэша в EAV нет', expected: null, actual: '<hash>' });
    } else if (wantHash !== '' && gotHash !== wantHash) {
      // Значения не печатаем — это секрет.
      mismatches.push({ entityId, kind: 'user_credentials.password_hash', expected: '<hash>', actual: gotHash === '' ? null : '<other>' });
    }

    // Разделы: живой membership из EAV против живых строк junction.
    const membership = parseEavObject(rec.attrs.get('section_access') ?? null) ?? {};
    const wantSections = new Map<string, string>();
    for (const [sectionId, lvl] of Object.entries(membership)) {
      const level = String(lvl);
      if (!knownSections.has(sectionId)) continue;
      if (!SECTION_LEVELS.has(level)) continue;
      wantSections.set(sectionId, level);
    }
    const gotSections = sectionsByUser.get(entityId) ?? new Map<string, string>();
    for (const [sectionId, level] of wantSections) {
      const got = gotSections.get(sectionId);
      if (got !== level) {
        mismatches.push({ entityId, kind: `user_section_access[${sectionId}]`, expected: level, actual: got ?? null });
      }
    }
    for (const [sectionId, level] of gotSections) {
      if (!wantSections.has(sectionId)) {
        mismatches.push({ entityId, kind: `user_section_access[${sectionId}]:лишняя живая строка`, expected: null, actual: level });
      }
    }
  }

  // 4) Строки users без карточки сотрудника вообще.
  for (const [id, row] of usersById) {
    if (!byEntity.has(id)) {
      mismatches.push({ entityId: id, kind: 'users:строка без карточки сотрудника', expected: null, actual: row.login });
    }
  }

  // Отказы пересборки зеркала (0087). Барьер исключений в rebuild-функциях не
  // даёт зеркалу ронять транзакцию клиентского пуша, но платит за это тем, что
  // сбой проглатывается: EAV-запись прошла, строка в users осталась старой.
  // С R2 на строгие таблицы переехали читатели разделов доступа, поэтому
  // непустая таблица здесь — это не «зеркало отстало», а «у человека сейчас не
  // тот доступ». Прогон обязан быть красным даже при нулевых расхождениях:
  // расхождение могло ещё не проявиться в тех полях, которые сверяет parity.
  const failures = await pool.query<{ n: string; last_fn: string | null; last_msg: string | null }>(
    `SELECT count(*)::text AS n,
            (SELECT fn FROM users_mirror_failures ORDER BY at DESC LIMIT 1) AS last_fn,
            (SELECT message FROM users_mirror_failures ORDER BY at DESC LIMIT 1) AS last_msg
       FROM users_mirror_failures`,
  );
  const failureCount = Number(failures.rows[0]?.n ?? 0);
  const accounts = usersById.size;
  const cards = byEntity.size;

  if (asJson) {
    console.log(JSON.stringify({ ok: mismatches.length === 0 && failureCount === 0, cards, accounts, failureCount, mismatches }, null, 2));
  } else {
    console.log(`Карточек сотрудников: ${cards}`);
    console.log(`Аккаунтов (users):    ${accounts}`);
    console.log(`Кредов:               ${credByUser.size}`);
    console.log(`Живых строк доступа:  ${sectionRows.rows.length}`);
    console.log(`Отказов пересборки:   ${failureCount}`);
    if (failureCount > 0) {
      console.log(`  последний: ${failures.rows[0]?.last_fn ?? '?'} — ${failures.rows[0]?.last_msg ?? ''}`);
    }
    if (mismatches.length === 0 && failureCount === 0) {
      console.log('\n✓ Расхождений EAV ↔ строгие таблицы нет.');
    } else if (mismatches.length === 0) {
      console.log(`
✗ Расхождений нет, но зеркало ${failureCount} раз(а) не пересобралось — строки могли остаться старыми.`);
    } else {
      console.log(`\n✗ Расхождений: ${mismatches.length} (показаны первые ${Math.min(limit, mismatches.length)})`);
      for (const m of mismatches.slice(0, limit)) {
        console.log(`  ${m.entityId}  ${m.kind}\n     ожидалось: ${JSON.stringify(m.expected)}\n     в таблице: ${JSON.stringify(m.actual)}`);
      }
    }
  }

  await pool.end();
  process.exit(mismatches.length === 0 && failureCount === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(String(e));
  await pool.end().catch(() => undefined);
  process.exit(2);
});
