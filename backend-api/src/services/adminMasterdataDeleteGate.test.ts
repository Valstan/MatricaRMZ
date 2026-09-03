import { beforeEach, describe, expect, it, vi } from 'vitest';

// Ф4 (референс-целостность при удалении): серверный softDeleteEntity обязан видеть
// ссылки не только в одиночных EAV-линках, но и в JSON/junction-хранилищах —
// contract_sections, meta_json нарядов/заявок, массивные EAV-линки, BOM-junction,
// brand_links_json деталей.

const state = vi.hoisted(() => ({ selectByTable: new Map<unknown, any[][]>() }));

vi.mock('../database/db.js', () => {
  const db = {
    select: vi.fn(() => {
      let currentTable: unknown;
      const chain: any = {
        from: vi.fn((table: unknown) => {
          currentTable = table;
          return chain;
        }),
        innerJoin: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        then: (resolve: (v: any[]) => any, reject?: (e: any) => any) => {
          const queue = state.selectByTable.get(currentTable);
          const result = queue && queue.length > 0 ? queue.shift()! : [];
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return chain;
    }),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoNothing: vi.fn(async () => undefined) })) })),
  };
  return { db };
});

vi.mock('./sync/syncChangeService.js', () => ({
  recordSyncChanges: vi.fn(async () => undefined),
}));

const { attributeDefs, attributeValues, directoryParts, entities, erpEngineAssemblyBomBrandLinks, operations } = await import(
  '../database/schema.js'
);
const { setEntityAttribute, softDeleteEntity } = await import('./adminMasterdataService.js');

const ACTOR = { id: 'u1', username: 'test-admin', role: 'admin' };
const TARGET = 'aaaaaaaa-0000-0000-0000-000000000001';

const TYPE_ID = 'bbbbbbbb-0000-0000-0000-000000000002';

function seedTargetEntity() {
  state.selectByTable.set(entities, [[{ id: TARGET, typeId: TYPE_ID, createdAt: 1, updatedAt: 1, deletedAt: null }]]);
}

beforeEach(() => {
  state.selectByTable.clear();
});

describe('softDeleteEntity — Ф4 расширенный гейт входящих ссылок', () => {
  it('отклоняет удаление при ссылке в contract_sections JSON', async () => {
    seedTargetEntity();
    // Порядок select'ов по attribute_values: findIncomingLinkRows → массивные EAV → contract_sections.
    state.selectByTable.set(attributeValues, [
      [], // findIncomingLinkRows: одиночных линков нет
      [], // массивные EAV-линки: нет
      [
        {
          valueJson: JSON.stringify({
            primary: { customerId: TARGET, engineBrands: [], parts: [] },
            addons: [],
          }),
        },
      ],
    ]);
    state.selectByTable.set(attributeDefs, [[{ id: 'def-sections' }]]);
    state.selectByTable.set(operations, [[]]);
    state.selectByTable.set(erpEngineAssemblyBomBrandLinks, [[]]);

    const r = await softDeleteEntity(ACTOR, TARGET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Контракты');
  });

  it('отклоняет удаление при ссылке в meta_json наряда', async () => {
    seedTargetEntity();
    state.selectByTable.set(attributeValues, [[], [], []]);
    state.selectByTable.set(attributeDefs, [[{ id: 'def-sections' }]]);
    state.selectByTable.set(operations, [
      [
        {
          operationType: 'work_order',
          metaJson: JSON.stringify({ crew: [{ employeeId: TARGET }] }),
        },
      ],
    ]);
    state.selectByTable.set(erpEngineAssemblyBomBrandLinks, [[]]);

    const r = await softDeleteEntity(ACTOR, TARGET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Наряды');
  });

  it('отклоняет удаление при массивном EAV-линке', async () => {
    seedTargetEntity();
    state.selectByTable.set(attributeValues, [
      [], // одиночные
      [{ valueJson: JSON.stringify([TARGET, 'other-id']), fromEntityTypeName: 'Услуги' }],
      [],
    ]);
    state.selectByTable.set(attributeDefs, [[]]);
    state.selectByTable.set(operations, [[]]);
    state.selectByTable.set(erpEngineAssemblyBomBrandLinks, [[]]);

    const r = await softDeleteEntity(ACTOR, TARGET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Услуги');
  });

  it('отклоняет удаление марки при живой BOM-junction строке', async () => {
    seedTargetEntity();
    state.selectByTable.set(attributeValues, [[], [], []]);
    state.selectByTable.set(attributeDefs, [[]]);
    state.selectByTable.set(operations, [[]]);
    state.selectByTable.set(erpEngineAssemblyBomBrandLinks, [[{ id: 'bl1' }]]);

    const r = await softDeleteEntity(ACTOR, TARGET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Спецификации BOM');
  });

  // Связь «деталь ↔ марка» переехала в directory_parts.brand_links_json (Phase 3): пока
  // гейт её не читал, марку с привязанными деталями он отпускал как «без связанных записей»,
  // и в карточках деталей оставались строки без имени марки.
  it('отклоняет удаление марки, на которую ссылается brand_links_json детали', async () => {
    seedTargetEntity();
    state.selectByTable.set(attributeValues, [[], [], []]);
    state.selectByTable.set(attributeDefs, [[]]);
    state.selectByTable.set(operations, [[]]);
    state.selectByTable.set(erpEngineAssemblyBomBrandLinks, [[]]);
    state.selectByTable.set(directoryParts, [
      [{ brandLinksJson: JSON.stringify([{ id: 'l1', engineBrandId: TARGET, quantity: 2 }]) }],
    ]);

    const r = await softDeleteEntity(ACTOR, TARGET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Детали (марки)');
  });

  // LIKE по json ловит и деталь, где нужный uuid стоит в чужом поле: считать такую ссылкой
  // значит блокировать удаление без причины, поэтому разбор обязателен, а не только грубый LIKE.
  it('не считает ссылкой деталь, где uuid марки лежит не в engineBrandId', async () => {
    seedTargetEntity();
    state.selectByTable.set(attributeValues, [[], [], []]);
    state.selectByTable.set(attributeDefs, [[]]);
    state.selectByTable.set(operations, [[]]);
    state.selectByTable.set(erpEngineAssemblyBomBrandLinks, [[]]);
    state.selectByTable.set(directoryParts, [
      [{ brandLinksJson: JSON.stringify([{ id: TARGET, engineBrandId: null, quantity: 1 }]) }],
    ]);

    const r = await softDeleteEntity(ACTOR, TARGET);
    expect(r.ok).toBe(true);
  });

  it('пропускает удаление без входящих ссылок', async () => {
    seedTargetEntity();
    state.selectByTable.set(attributeValues, [[], [], []]);
    state.selectByTable.set(attributeDefs, [[]]);
    state.selectByTable.set(operations, [[]]);
    state.selectByTable.set(erpEngineAssemblyBomBrandLinks, [[]]);
    state.selectByTable.set(directoryParts, [[]]);

    const r = await softDeleteEntity(ACTOR, TARGET);
    expect(r.ok).toBe(true);
  });
});


// Аудит 2026-08-29: POST /admin/masterdata/entities/:id/set-attr пропускал ЛЮБОЙ
// код атрибута и был закрыт только requireAdmin — обычный `admin` одним запросом
// ставил себе system_role='superadmin' или переписывал чужой password_hash,
// минуя isAssignableSystemRole и ensureManageAllowed. Backstop живёт в сервисе:
// у setEntityAttribute есть и другие вызывающие.
describe('setEntityAttribute — backstop служебных атрибутов', () => {
  for (const code of [
    'system_role',
    'password_hash',
    'login',
    'access_enabled',
    'delete_requested_at',
    'delete_requested_by_id',
    'delete_requested_by_username',
    'section_access',
  ]) {
    it(`отказывает в записи «${code}» обычным путём`, async () => {
      const r = await setEntityAttribute(ACTOR, TARGET, code, 'superadmin');
      expect(r.ok).toBe(false);
      expect(String((r as { error: string }).error)).toContain(code);
    });
  }

  it('пропускает служебный атрибут только при явном allowProtectedAttrs (серверные скрипты)', async () => {
    // Сущности нет в моке → падает на следующей проверке, а НЕ на backstop:
    // это и доказывает, что opt-in снял именно его.
    const r = await setEntityAttribute(ACTOR, TARGET, 'section_access', '{}', { allowProtectedAttrs: true });
    expect(r.ok).toBe(false);
    expect(String((r as { error: string }).error)).toBe('Сущность не найдена');
  });

  it('обычные атрибуты не задеты', async () => {
    const r = await setEntityAttribute(ACTOR, TARGET, 'full_name', 'Иванова Мария Петровна');
    expect(String((r as { error: string }).error)).toBe('Сущность не найдена');
  });
});
