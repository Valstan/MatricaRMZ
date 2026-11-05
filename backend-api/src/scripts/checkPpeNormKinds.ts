import 'dotenv/config';

import { parseOrderNormQty } from '@matricarmz/shared';
import type { PpeWearKind } from '@matricarmz/shared';

import { pool } from '../database/db.js';

// Сверка базы с доменом по видам и срокам норм приказа о СИЗ.
//
// Зачем: правило разбора строки приказа живёт в домене (`parseOrderNormQty`), а
// миграции вынуждены повторять его на SQL. Повторение — это approximation, и оно
// разошлось с доменом на двух строках «1 шт. на год» (миграция 0121 отбирала
// годовые строки по слову «год» без требования цифры перед ним, домен требует).
// Расхождение жило на проде тихо: домен считал 113 годовых строк, база держала 111.
//
// Этот скрипт закрывает класс целиком: после миграций база обязана совпадать с
// доменом построчно. Read-only. Безопасен на проде.
//
// Usage:
//   pnpm -F @matricarmz/backend-api ppe:norms-parity
//   pnpm -F @matricarmz/backend-api ppe:norms-parity -- --json
//
// Exit code: 0 — расхождений нет; 1 — есть (гейт приёмки).

type SpecRow = {
  id: string;
  sourceRef: string | null;
  wearKind: string | null;
  wearMonths: number | null;
};

type LineRow = {
  id: string;
  wearKind: string | null;
  wearMonths: number | null;
};

type Mismatch = {
  table: string;
  id: string;
  sourceRef: string | null;
  expected: { wearKind: string; wearMonths: unknown };
  actual: { wearKind: string | null; wearMonths: number | null };
};

/** Виды, у которых срока быть не должно, и виды, у которых срок обязателен. */
const KIND_WITH_PERIOD = new Set<PpeWearKind>(['months', 'months_clerk']);
const KIND_WITHOUT_PERIOD = new Set<PpeWearKind>(['annual', 'until_wearout', 'by_manufacturer']);

async function main(): Promise<void> {
  const specs = await pool.query<SpecRow>(
    `SELECT id, source_ref AS "sourceRef", wear_kind AS "wearKind", wear_months AS "wearMonths"
       FROM ppe_norm_line_specs
      WHERE deleted_at IS NULL
      ORDER BY source_ref NULLS LAST, id`,
  );
  const lines = await pool.query<LineRow>(
    `SELECT id, wear_kind AS "wearKind", wear_months AS "wearMonths"
       FROM ppe_norm_lines
      WHERE deleted_at IS NULL
      ORDER BY id`,
  );

  const mismatches: Mismatch[] = [];

  for (const spec of specs.rows) {
    const parsed = parseOrderNormQty(spec.sourceRef ?? '');
    const expected = { wearKind: parsed.wearKind, wearMonths: parsed.wearMonths };
    const actual = { wearKind: spec.wearKind, wearMonths: spec.wearMonths };
    if (spec.wearKind !== expected.wearKind || spec.wearMonths !== expected.wearMonths) {
      mismatches.push({
        table: 'ppe_norm_line_specs',
        id: spec.id,
        sourceRef: spec.sourceRef,
        expected,
        actual,
      });
    }
  }

  for (const line of lines.rows) {
    const kind = line.wearKind as PpeWearKind | null;
    if (kind == null) continue;
    // В строке нормы срок либо есть, либо вида «без срока»; иначе строка противоречит
    // сама себе (например, 'months' без срока — это просроченная позиция с нулевым
    // сроком, та самая ошибка, что была в DTO).
    const inconsistent =
      (KIND_WITH_PERIOD.has(kind) && line.wearMonths == null) ||
      (KIND_WITHOUT_PERIOD.has(kind) && line.wearMonths != null);
    if (inconsistent) {
      mismatches.push({
        table: 'ppe_norm_lines',
        id: line.id,
        sourceRef: null,
        expected: {
          wearKind: kind,
          wearMonths: KIND_WITH_PERIOD.has(kind) ? 'требуется срок' : null,
        },
        actual: { wearKind: line.wearKind, wearMonths: line.wearMonths },
      });
    }
  }

  const asJson = process.argv.includes('--json');
  if (mismatches.length > 0) {
    if (asJson) console.log(JSON.stringify({ ok: false, mismatches }, null, 2));
    else {
      console.error(`✗ База и домен говорят разное про нормы приказа: расхождений ${mismatches.length}`);
      for (const m of mismatches.slice(0, 20)) {
        console.error(
          `  - ${m.table} ${m.id}${m.sourceRef ? ` («${m.sourceRef}»)` : ''}: домен ${JSON.stringify(m.expected)} vs база ${JSON.stringify(m.actual)}`,
        );
      }
      if (mismatches.length > 20) console.error(`  … и ещё ${mismatches.length - 20}`);
      console.error('');
      console.error('Правило разбора живёт в домене (parseOrderNormQty) — миграция обязана повторять его точно.');
    }
    process.exit(1);
  }

  if (asJson) console.log(JSON.stringify({ ok: true, specs: specs.rows.length, lines: lines.rows.length }));
  else
    console.log(
      `✓ База и домен говорят одно про нормы приказа: строк ${specs.rows.length}, норм ${lines.rows.length}`,
    );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
