/**
 * «Комплектование двигателя»: подпись вариантной позиции BOM.
 *
 * У строки BOM два поля позиции, и они не взаимозаменяемы: `positionKey` — машинный ключ,
 * который редактор BOM генерирует сам (`pos-` + случайные знаки), а `positionLabel` — то, что
 * оператор в этом редакторе напечатал. Отчёт читал ключ, поэтому в колонке «Примечание»
 * оператору доставалось «вариант: pos-x7k2m9q» вместо «вариант: Поршневая группа».
 *
 * Ловится только REST-путём: офлайн-путь группирует по легаси-полю `variantGroup`, и ключ
 * туда не попадает. Поэтому тест стабит HTTP-слой, а не БД.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {} }));

const http = vi.hoisted(() => ({ impl: null as null | ((path: string) => unknown) }));
vi.mock('../../httpClient.js', () => ({
  httpAuthed: vi.fn(async (_db: unknown, _base: string, path: string) => ({
    ok: true,
    status: 200,
    json: http.impl ? http.impl(path) : null,
  })),
}));

import { attributeDefs, attributeValues, entities, entityTypes } from '../../../database/schema.js';
import { buildEngineKittingReport } from './engines.js';

const ENGINE = 'bb220000-0000-4000-8000-000000000001';
const BRAND = 'aa110000-0000-4000-8000-000000000001';
const NOM_A = 'e5bb0000-0000-4000-8000-00000000000a';
const NOM_B = 'e5bb0000-0000-4000-8000-00000000000b';
const POSITION_KEY = 'pos-x7k2m9q';

type Row = Record<string, unknown>;

function stubDb(): any {
  const types: Row[] = [
    { id: 'T_engine', code: 'engine' },
    { id: 'T_engine_brand', code: 'engine_brand' },
  ];
  const ents: Row[] = [
    { id: ENGINE, typeId: 'T_engine' },
    { id: BRAND, typeId: 'T_engine_brand' },
  ];
  const attrs: Record<string, Record<string, unknown>> = {
    [ENGINE]: { engine_number: 'ДВ-1001', engine_brand_id: BRAND },
    [BRAND]: { name: 'Д-245' },
  };
  const defs = new Set<string>();
  for (const map of Object.values(attrs)) for (const code of Object.keys(map)) defs.add(code);
  const defRows: Row[] = [...defs].map((code) => ({ id: `D_${code}`, code }));
  const valueRows: Row[] = [];
  for (const [entityId, map] of Object.entries(attrs)) {
    for (const [code, value] of Object.entries(map)) {
      valueRows.push({ entityId, attributeDefId: `D_${code}`, valueJson: JSON.stringify(value) });
    }
  }
  const byTable = new Map<unknown, Row[]>([
    [entityTypes, types],
    [entities, ents],
    [attributeDefs, defRows],
    [attributeValues, valueRows],
  ]);
  return {
    select() {
      return {
        from(table: unknown) {
          const rows = byTable.get(table) ?? [];
          const chain: any = new Proxy(
            {},
            {
              get(_t, prop) {
                if (prop === 'then') return (resolve: (v: Row[]) => unknown) => resolve(rows);
                return () => chain;
              },
            },
          );
          return chain;
        },
      };
    },
  };
}

/** Две строки одной вариантной позиции: у позиции есть и машинный ключ, и подпись оператора. */
function bomResponse(opts: { positionLabel: string | null }) {
  const line = (id: string, nomId: string, name: string, code: string, isDefault: boolean) => ({
    componentNomenclatureId: nomId,
    componentNomenclatureName: name,
    componentNomenclatureCode: code,
    qtyPerUnit: 6,
    positionKey: POSITION_KEY,
    positionLabel: opts.positionLabel,
    isRequired: true,
    priority: 100,
    isDefaultOption: isDefault,
    notes: null,
    id,
  });
  return (path: string) => {
    if (path.startsWith('/warehouse/assembly-bom?')) {
      return { ok: true, rows: [{ id: 'BOM1', name: 'BOM Д-245', status: 'active', isDefault: true, updatedAt: 2 }] };
    }
    if (path.startsWith('/warehouse/assembly-bom/')) {
      return {
        ok: true,
        bom: {
          header: { id: 'BOM1', name: 'BOM Д-245' },
          lines: [line('L1', NOM_A, 'Поршень А', 'П-1', true), line('L2', NOM_B, 'Поршень Б', 'П-2', false)],
        },
      };
    }
    return { ok: true, rows: [] };
  };
}

const ctx = { sysDb: {} as never, apiBaseUrl: 'http://api' };

describe('«Комплектование двигателя»: подпись вариантной позиции', () => {
  beforeEach(() => {
    http.impl = null;
  });

  it('печатает подпись позиции, а не машинный ключ редактора BOM', async () => {
    http.impl = bomResponse({ positionLabel: 'Поршневая группа' });
    const report = await buildEngineKittingReport(stubDb(), { engineId: ENGINE }, ctx);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.rows).toHaveLength(1); // два варианта одной позиции схлопнуты в одну строку
    const note = String(report.rows[0]?.variantNote ?? '');
    expect(note).toContain('вариант: Поршневая группа');
    expect(note).not.toContain(POSITION_KEY);
  });

  it('без подписи позиции не печатает ничего — ключ вместо подписи не подставляется', async () => {
    http.impl = bomResponse({ positionLabel: null });
    const report = await buildEngineKittingReport(stubDb(), { engineId: ENGINE }, ctx);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const note = String(report.rows[0]?.variantNote ?? '');
    expect(note).not.toContain(POSITION_KEY);
    expect(note).not.toContain('вариант:');
  });

  it('позиции остаются разными, даже когда подписи у них одинаковые', async () => {
    // Разрез держится на ключе, а не на подписи: две позиции с одним и тем же текстом
    // «Поршневая группа» — это две позиции, а не одна.
    http.impl = (path: string) => {
      if (path.startsWith('/warehouse/assembly-bom?')) {
        return { ok: true, rows: [{ id: 'BOM1', name: 'BOM Д-245', status: 'active', isDefault: true, updatedAt: 2 }] };
      }
      if (path.startsWith('/warehouse/assembly-bom/')) {
        const mk = (key: string, nomId: string, name: string) => ({
          componentNomenclatureId: nomId,
          componentNomenclatureName: name,
          componentNomenclatureCode: 'П',
          qtyPerUnit: 6,
          positionKey: key,
          positionLabel: 'Поршневая группа',
          isRequired: true,
          priority: 100,
          isDefaultOption: true,
          notes: null,
        });
        return {
          ok: true,
          bom: {
            header: { id: 'BOM1', name: 'BOM Д-245' },
            lines: [mk('pos-aaa1111', NOM_A, 'Поршень А'), mk('pos-bbb2222', NOM_B, 'Поршень Б')],
          },
        };
      }
      return { ok: true, rows: [] };
    };
    const report = await buildEngineKittingReport(stubDb(), { engineId: ENGINE }, ctx);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.rows).toHaveLength(2);
  });
});
