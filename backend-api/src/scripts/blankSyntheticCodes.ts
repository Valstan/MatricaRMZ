import 'dotenv/config';

import { and, eq, gte, isNull, isNotNull, like, ne, or, sql } from 'drizzle-orm';
import { LedgerTableName } from '@matricarmz/ledger';

import { db, pool } from '../database/db.js';
import { clientSettings, directoryParts, erpNomenclature } from '../database/schema.js';
import { signAndAppendDetailed } from '../ledger/ledgerService.js';

/**
 * Deep-dedup Ф2 (owner decision 2026-07-12): убрать синтетические коды-заглушки
 * из ПАРЫ id-identical строк erp_nomenclature ↔ directory_parts.
 *
 * Корзины (порядок важен):
 *  1. PROMOTE — реальный артикул в живой directory_parts.code, в зеркале синтетика
 *     → поднимаем реальный код в зеркало. Обнулять такие строки нельзя: после blank
 *     артикул уже не достать (кандидат отбирается по синтетике, а она исчезнет).
 *  2. BLANK — артикула нет ни с одной стороны → erp.code = '' и dp.code = NULL.
 *     Асимметрия намеренная: `createDirectoryPart`/`saveWarehousePartSpec` кладут в
 *     directory_parts NULL, зеркало (`ensurePartNomenclatureMirror`) пишет ''.
 *     Партиал-уникальные индексы на code (PG 0075, клиент 0016) исключают ''.
 *  3. COLLISION — артикул занят живой строкой ИЛИ повторяется внутри самого батча
 *     (две карточки с одним артикулом — штатная модель, идентичность детали это
 *     пара «имя+артикул», ср. «Картер верхний»/«Картер нижний» 3301-15-30).
 *     Пропускаем целиком: слияние — ручное решение владельца.
 *  4. SUSPICIOUS — код похож на синтетику префиксом, но НЕ имеет генерируемой формы
 *     `PREFIX-<11 цифр>` (`buildNomenclatureCode`). Скорее всего живой вендорский
 *     артикул («NM-1050») → не трогаем вообще, печатаем списком.
 *  5. GHOSTS — живой directory_parts при soft-deleted зеркале ретайрится.
 *
 * ⚠️ ПОЧЕМУ НЕ `recordSyncChanges` (грабля, стоившая прошлой версии скрипта
 * работоспособности): для erp_nomenclature путь не работает дважды. Во-первых,
 * `writeSyncChanges` валидирует payload схемой `erpNomenclatureRowSchema`, где
 * `code: z.string().min(1)` — пустая строка бросает `sync_invalid_row` и роняет прогон
 * на первой же строке. Во-вторых, даже с валидным кодом запись не доедет до PG:
 * `applyPushBatch` не имеет веток ни для одной erp_*-таблицы, то есть путь подписывает
 * ledger и молча ничего не приземляет (тот же урок выучен вживую 2026-07-12 в
 * `linkNomenclatureToPart.ts`). Клиенты берут erp_nomenclature именно из PG.
 * Пишем канонически: UPDATE в PG + `signAndAppendDetailed`, как `upsertWarehouseNomenclature`.
 *
 * ⚠️ ДОСТАВКА КЛИЕНТАМ. `last_server_seq` для erp-таблиц не проставляет никто, кроме
 * `applyPushBatch` (веток для erp там нет), поэтому изменение НЕ приезжает
 * инкрементальным пуллом — только холодным снимком/полным пуллом. После прогона
 * обязателен force_full_pull каждому клиенту (web-admin → клиенты, либо
 * POST /admin/clients/:clientId/sync-request). Это не особенность скрипта, а текущее
 * поведение всего erp-контура — отдельный пункт в PENDING_FOLLOWUPS.
 *
 * ⚠️ ПРЕДУСЛОВИЯ ПРОГОНА (проверяются скриптом, кроме последнего):
 *   • боевой env просорсен (MATRICA_LEDGER_DIR) — иначе подпись уйдёт в паразитный
 *     ledger с новыми ключами (GOTCHAS M30);
 *   • ВСЕ живые клиенты ≥ 2026.712.1818 (partial unique на code, client migration
 *     0016 / schema-version 11). На старом клиенте пустой код ломает применение pull'а;
 *   • ledger-replay должен переживать пустой код — `normalizeRow` отбрасывал строки
 *     falsy-проверкой (починено вместе с этим скриптом);
 *   • роут POST /warehouse/nomenclature требует `code: z.string().min(1)` → после
 *     обнуления карточку нельзя сохранить. Ослабление роута выкатывается ТЕМ ЖЕ
 *     релизом, что и прогон. Скрипт это не проверяет — держать в рантбуке.
 *
 * Dry-run by default; `--apply` мутирует. pg_dump обеих таблиц заранее.
 * `--allow-ghosts=N` — подтвердить ретайр N «духов» (защита от массового удаления).
 */
const APPLY = process.argv.includes('--apply');
const ALLOW_GHOSTS = (() => {
  const arg = process.argv.find((a) => a.startsWith('--allow-ghosts='));
  return arg ? Number(arg.split('=')[1]) : 2;
})();

/** Форма из buildNomenclatureCode: PREFIX + 8 цифр времени + 3 случайные. */
const SYNTHETIC_STRICT = /^(DET|NM)-\d{11}$/;
const SYNTHETIC_PREFIX = /^(DET|NM)-/;
const MIN_CLIENT_VERSION = '2026.712.1818';
const CLIENT_ALIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const norm = (v: string | null | undefined): string => String(v ?? '').trim();
const isRealArticle = (code: string): boolean => code !== '' && !SYNTHETIC_PREFIX.test(code);

const calverParts = (v: string): number[] =>
  norm(v)
    .split('.')
    .map((p) => Number(p.replace(/[^0-9]/g, '')) || 0);

function calverBelow(version: string, floor: string): boolean {
  const a = calverParts(version);
  const b = calverParts(floor);
  if (a.length < 3) return true; // неизвестная/битая версия — считаем устаревшей
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]!;
  }
  return false;
}

/** Ledger-строка erp_nomenclature — форма один-в-один с upsertWarehouseNomenclature. */
function ledgerRow(row: Record<string, any>): Record<string, unknown> {
  return {
    id: String(row.id),
    code: String(row.code),
    sku: row.sku ?? null,
    name: String(row.name),
    item_type: String(row.itemType),
    category: row.category ?? null,
    directory_kind: row.directoryKind ?? null,
    directory_ref_id: row.directoryRefId ?? null,
    group_id: row.groupId,
    unit_id: row.unitId,
    barcode: row.barcode,
    min_stock: row.minStock,
    max_stock: row.maxStock,
    default_brand_id: row.defaultBrandId ?? null,
    is_serial_tracked: Boolean(row.isSerialTracked),
    default_warehouse_id: row.defaultWarehouseId,
    spec_json: row.specJson,
    is_active: Boolean(row.isActive),
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
  };
}

/** spec_json.article дублирует code: синтетику вычистить, реальный артикул подставить. */
function nextSpecJson(specJson: unknown, code: string): string | undefined {
  if (!specJson) return undefined;
  try {
    const spec = JSON.parse(String(specJson));
    if (!spec || typeof spec !== 'object') return undefined;
    const article = norm((spec as Record<string, unknown>).article as string);
    if (code === '') {
      if (!SYNTHETIC_PREFIX.test(article)) return undefined; // реальный артикул не трогаем
      delete (spec as Record<string, unknown>).article;
    } else {
      if (article === code) return undefined;
      (spec as Record<string, unknown>).article = code;
    }
    return JSON.stringify(spec);
  } catch {
    return undefined; // malformed spec_json — не трогаем
  }
}

type Candidate = {
  id: string;
  name: string;
  nCode: string;
  dCode: string;
  dAlive: boolean;
  specJson: unknown;
};

/**
 * Пишет пару атомарно: зеркало + карточка в одной транзакции, ledger — сразу после
 * коммита (паттерн mergeDirectoryParts). UPDATE несёт предикат «код всё ещё тот» —
 * иначе прогон затрёт правку, сделанную оператором во время работы скрипта.
 */
async function writePair(
  c: Candidate,
  nextCode: string,
  blankCard: boolean,
  ts: number,
): Promise<'written' | 'changed-under-us'> {
  const spec = nextSpecJson(c.specJson, nextCode);
  let saved: Record<string, any> | undefined;

  const outcome = await db.transaction(async (tx) => {
    const updated = await tx
      .update(erpNomenclature)
      .set({ code: nextCode, updatedAt: ts, ...(spec === undefined ? {} : { specJson: spec }) })
      .where(
        and(
          eq(erpNomenclature.id, c.id),
          eq(erpNomenclature.code, c.nCode),
          isNull(erpNomenclature.deletedAt),
        ),
      )
      .returning({ id: erpNomenclature.id });
    if (updated.length === 0) return 'changed-under-us' as const;

    if (blankCard) {
      await tx
        .update(directoryParts)
        .set({ code: null, updatedAt: ts })
        .where(and(eq(directoryParts.id, c.id), isNull(directoryParts.deletedAt)));
    }

    const rows = await tx.select().from(erpNomenclature).where(eq(erpNomenclature.id, c.id)).limit(1);
    saved = rows[0] as Record<string, any> | undefined;
    return 'written' as const;
  });

  if (outcome === 'written' && saved) {
    signAndAppendDetailed([
      {
        type: 'upsert',
        table: LedgerTableName.ErpNomenclature,
        row_id: c.id,
        row: ledgerRow(saved),
        actor: { userId: 'system', username: 'system', role: 'system' },
        ts,
      },
    ]);
  }
  return outcome;
}

async function assertPreconditions(): Promise<void> {
  if (!process.env.MATRICA_LEDGER_DIR) {
    throw new Error(
      'MATRICA_LEDGER_DIR не задан — просорсь боевой env перед прогоном (GOTCHAS M30), ' +
        'иначе подпись уйдёт в паразитный ledger с новыми ключами',
    );
  }
  const since = Date.now() - CLIENT_ALIVE_WINDOW_MS;
  const clients = await db
    .select({
      clientId: clientSettings.clientId,
      version: clientSettings.lastVersion,
      username: clientSettings.lastUsername,
      hostname: clientSettings.lastHostname,
    })
    .from(clientSettings)
    .where(gte(clientSettings.lastSeenAt, since));
  const stale = clients.filter((c) => calverBelow(String(c.version ?? ''), MIN_CLIENT_VERSION));
  if (stale.length > 0) {
    for (const c of stale) {
      console.error(
        `   ${String(c.username ?? '—')} (${String(c.hostname ?? c.clientId)}) — ${String(c.version ?? 'версия неизвестна')}`,
      );
    }
    throw new Error(
      `клиентов ниже ${MIN_CLIENT_VERSION}: ${stale.length} — на них глобальный unique уронит применение pull'а ` +
        'второй же строкой с пустым кодом. Обновить/переустановить и повторить.',
    );
  }
  console.log(`[blank-synth] предусловия ok: живых клиентов ${clients.length}, все ≥ ${MIN_CLIENT_VERSION}`);
}

async function main() {
  // Живое зеркало с синтетическим префиксом + состояние парной карточки.
  // Пара берётся ТОЛЬКО живая: код из soft-deleted карточки промоутить нельзя.
  const rows = await db
    .select({
      id: erpNomenclature.id,
      nCode: erpNomenclature.code,
      name: erpNomenclature.name,
      specJson: erpNomenclature.specJson,
      dCode: directoryParts.code,
      dId: directoryParts.id,
    })
    .from(erpNomenclature)
    .leftJoin(
      directoryParts,
      and(eq(directoryParts.id, erpNomenclature.id), isNull(directoryParts.deletedAt)),
    )
    .where(
      and(
        isNull(erpNomenclature.deletedAt),
        or(like(erpNomenclature.code, 'DET-%'), like(erpNomenclature.code, 'NM-%')),
      ),
    );

  const all: Candidate[] = rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    nCode: String(r.nCode),
    dCode: norm(r.dCode),
    dAlive: r.dId != null,
    specJson: r.specJson,
  }));

  // Похоже на синтетику, но не сгенерированной формы → живой вендорский артикул.
  const suspicious = all.filter((c) => !SYNTHETIC_STRICT.test(c.nCode));
  const candidates = all.filter((c) => SYNTHETIC_STRICT.test(c.nCode));

  // PROMOTE vs COLLISION: сначала дубли внутри батча, потом занятость живой строкой.
  const byCode = new Map<string, Candidate[]>();
  for (const c of candidates.filter((x) => x.dAlive && isRealArticle(x.dCode))) {
    const list = byCode.get(c.dCode) ?? [];
    list.push(c);
    byCode.set(c.dCode, list);
  }
  const promote: Candidate[] = [];
  const collide: Array<Candidate & { why: string }> = [];
  for (const [code, group] of byCode) {
    if (group.length > 1) {
      for (const c of group) collide.push({ ...c, why: `артикул ${code} повторяется в батче ×${group.length}` });
      continue;
    }
    const c = group[0]!;
    const dup = await db
      .select({ n: sql<number>`count(*)` })
      .from(erpNomenclature)
      .where(and(eq(erpNomenclature.code, code), ne(erpNomenclature.id, c.id), isNull(erpNomenclature.deletedAt)));
    if (Number(dup[0]?.n ?? 0) > 0) collide.push({ ...c, why: `артикул ${code} занят живой номенклатурой` });
    else promote.push(c);
  }
  const handled = new Set([...promote, ...collide].map((c) => c.id));
  const blank = candidates.filter((c) => !handled.has(c.id));

  // Догон карточек: синтетика в directory_parts.code при живой карточке. leftJoin —
  // сироты без зеркала тоже должны обнулиться, иначе backfill вернёт код в зеркало.
  const dpRows = await db
    .select({ id: directoryParts.id, code: directoryParts.code, name: directoryParts.name, nCode: erpNomenclature.code })
    .from(directoryParts)
    .leftJoin(erpNomenclature, and(eq(erpNomenclature.id, directoryParts.id), isNull(erpNomenclature.deletedAt)))
    .where(
      and(
        isNull(directoryParts.deletedAt),
        or(like(directoryParts.code, 'DET-%'), like(directoryParts.code, 'NM-%')),
      ),
    );
  const dpCatchUp = dpRows.filter((r) => !handled.has(String(r.id)) && SYNTHETIC_STRICT.test(norm(r.code)));
  const dpSuspicious = dpRows.filter((r) => !SYNTHETIC_STRICT.test(norm(r.code)));

  const ghosts = await db
    .select({ id: directoryParts.id, name: directoryParts.name })
    .from(directoryParts)
    .innerJoin(erpNomenclature, eq(erpNomenclature.id, directoryParts.id))
    .where(and(isNull(directoryParts.deletedAt), isNotNull(erpNomenclature.deletedAt)));

  console.log(`[blank-synth] mode=${APPLY ? 'APPLY' : 'dry-run'}`);
  console.log(`[blank-synth] PROMOTE (артикул из карточки → зеркало): ${promote.length}`);
  for (const p of promote) console.log(`   ${p.nCode} → ${p.dCode} — ${p.name}`);
  console.log(`[blank-synth] COLLISION (пропуск, ручной merge): ${collide.length}`);
  for (const c of collide) console.log(`   ${c.id.slice(0, 8)} ${c.nCode} — ${c.name} · ${c.why}`);
  console.log(`[blank-synth] BLANK зеркал (erp.code → ''): ${blank.length}`);
  for (const b of blank) console.log(`   ${b.nCode} — ${b.name}`);
  console.log(`[blank-synth] BLANK карточек (directory_parts.code → NULL): ${dpCatchUp.length}`);
  for (const r of dpCatchUp) console.log(`   ${norm(r.code)} — ${String(r.name)}${r.nCode == null ? ' (без зеркала)' : ''}`);
  console.log(`[blank-synth] SUSPICIOUS — префикс синтетики, но форма чужая → НЕ трогаем: ${suspicious.length + dpSuspicious.length}`);
  for (const s of suspicious) console.log(`   erp ${s.nCode} — ${s.name}`);
  for (const s of dpSuspicious) console.log(`   dp  ${norm(s.code)} — ${String(s.name)}`);
  console.log(`[blank-synth] GHOSTS (карточка жива, зеркало удалено) → retire: ${ghosts.length}`);
  for (const g of ghosts) console.log(`   ${String(g.id).slice(0, 8)} — ${String(g.name)}`);

  if (!APPLY) {
    console.log('[blank-synth] DRY-RUN (pass --apply to mutate)');
    await pool.end();
    return;
  }

  await assertPreconditions();
  if (ghosts.length > ALLOW_GHOSTS) {
    throw new Error(
      `«духов» ${ghosts.length} при пороге ${ALLOW_GHOSTS} — это мягкое удаление карточек деталей ` +
        `вместе с их brand_links. Проверить список выше и повторить с --allow-ghosts=${ghosts.length}`,
    );
  }

  const ts = Date.now();
  const mutated: string[] = [];
  let promoted = 0;
  let blanked = 0;
  let skipped = 0;
  try {
    for (const p of promote) {
      const r = await writePair(p, p.dCode, false, ts);
      if (r === 'written') {
        promoted += 1;
        mutated.push(p.id);
      } else {
        skipped += 1;
        console.warn(`   ⚠️ ${p.id.slice(0, 8)} изменилась под руками — пропущена`);
      }
    }
    for (const b of blank) {
      const r = await writePair(b, '', b.dAlive, ts);
      if (r === 'written') {
        blanked += 1;
        mutated.push(b.id);
      } else {
        skipped += 1;
        console.warn(`   ⚠️ ${b.id.slice(0, 8)} изменилась под руками — пропущена`);
      }
    }
  } catch (e) {
    console.error(`[blank-synth] прервано после ${mutated.length} строк. Уже изменены: ${mutated.join(',')}`);
    throw e;
  }

  let cardsBlanked = 0;
  for (const r of dpCatchUp) {
    await db
      .update(directoryParts)
      .set({ code: null, updatedAt: ts })
      .where(and(eq(directoryParts.id, String(r.id)), isNull(directoryParts.deletedAt)));
    cardsBlanked += 1;
  }

  let retired = 0;
  for (const g of ghosts) {
    await db
      .update(directoryParts)
      .set({ deletedAt: ts, updatedAt: ts })
      .where(and(eq(directoryParts.id, String(g.id)), isNull(directoryParts.deletedAt)));
    retired += 1;
  }

  // Контроль по тем же множествам, что и мутации: синтетики строгой формы остаться
  // не должно нигде, кроме коллизий (их зеркала мы намеренно не трогали).
  const leftNom = await db
    .select({ code: erpNomenclature.code })
    .from(erpNomenclature)
    .where(
      and(
        isNull(erpNomenclature.deletedAt),
        or(like(erpNomenclature.code, 'DET-%'), like(erpNomenclature.code, 'NM-%')),
      ),
    );
  const leftDir = await db
    .select({ code: directoryParts.code })
    .from(directoryParts)
    .where(
      and(
        isNull(directoryParts.deletedAt),
        or(like(directoryParts.code, 'DET-%'), like(directoryParts.code, 'NM-%')),
      ),
    );
  const nomLeft = leftNom.filter((r) => SYNTHETIC_STRICT.test(norm(r.code))).length;
  const dirLeft = leftDir.filter((r) => SYNTHETIC_STRICT.test(norm(r.code))).length;

  console.log(
    `[blank-synth] APPLIED: promoted=${promoted} blanked=${blanked} cards-blanked=${cardsBlanked} ` +
      `ghosts-retired=${retired} skipped=${skipped}`,
  );
  console.log(`[blank-synth] осталось синтетики строгой формы: erp=${nomLeft} (ожидалось ${collide.length}) dp=${dirLeft} (ожидалось 0)`);
  if (nomLeft !== collide.length || dirLeft !== 0) {
    console.error('[blank-synth] ⚠️ остаток не сошёлся с ожиданием — разобрать вручную до следующего шага');
  }
  console.log('[blank-synth] ДАЛЬШЕ: разослать force_full_pull клиентам — иначе изменение не доедет (инкрементальный pull не носит erp-таблицы)');
  await pool.end();
}

main().catch(async (e) => {
  console.error('[blank-synth] fatal', e);
  await pool.end();
  process.exit(1);
});
