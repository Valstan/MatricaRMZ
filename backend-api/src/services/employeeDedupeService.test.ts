import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// База и соседние сервисы подменены. Чистой части и сторожу по коду это безразлично, а проверка
// отказа внизу гоняет сам `mergeEmployees` и смотрит, что до отказа не случилось ни одной записи.
const state = vi.hoisted(() => ({ selectByTable: new Map<unknown, unknown[][]>() }));

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
        then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) => {
          const queue = state.selectByTable.get(currentTable);
          const result = queue && queue.length > 0 ? queue.shift()! : [];
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return chain;
    }),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
  };
  return { db };
});

vi.mock('./adminMasterdataService.js', () => ({
  countExtendedIncomingReferences: vi.fn(async () => new Map<string, number>()),
  findIncomingLinkRows: vi.fn(async () => []),
  setEntityAttribute: vi.fn(async () => ({ ok: true })),
  softDeleteEntity: vi.fn(async () => ({ ok: true })),
  upsertAttributeDef: vi.fn(async () => ({ ok: true })),
}));
vi.mock('./userDeletionService.js', () => ({ reassignUserReferences: vi.fn(async () => undefined) }));
vi.mock('./sync/syncChangeService.js', () => ({ recordSyncChanges: vi.fn(async () => undefined) }));
vi.mock('./criticalEventsService.js', () => ({ ingestServerCriticalEvent: vi.fn() }));

const { db } = await import('../database/db.js');
const { entities, entityTypes, operations, timesheetRows } = await import('../database/schema.js');
const admin = await import('./adminMasterdataService.js');
const { reassignUserReferences } = await import('./userDeletionService.js');
const { __testables, mergeEmployees } = await import('./employeeDedupeService.js');

const { normalizeName, editBudgetForName, PROTECTED_CODES, isUncountedOperationReference, referenceRefusalMessage } =
  __testables;

// Слияние сотрудников правит ЖИВЫЕ данные и необратимо. Самое дорогое здесь — не «склеилось
// или нет», а границы: что переносится, что не трогается никогда и что происходит в dry-run.
// Чистая часть проверяется вызовами, а границы записи — сторожем по коду: поднимать ради них
// живую БД в юнит-тесте дороже, чем прочитать сам путь записи.
describe('ключ группировки по имени', () => {
  it('не различает регистр, лишние пробелы и «ё»', () => {
    expect(normalizeName('  Цветкова   Алёна Владимировна ')).toBe('цветкова алена владимировна');
    expect(normalizeName('ЦВЕТКОВА АЛЕНА ВЛАДИМИРОВНА')).toBe(normalizeName('Цветкова Алена Владимировна'));
  });

  it('пустое имя ключом не становится', () => {
    expect(normalizeName('   ')).toBe('');
    expect(normalizeName(null)).toBe('');
    expect(normalizeName(undefined)).toBe('');
  });

  it('короткие имена опечаток не прощают', () => {
    // Иначе «Иванов» и «Иванок» — разные люди — попали бы в одну группу.
    expect(editBudgetForName('иванов')).toBe(0);
    expect(editBudgetForName('цветкова алена')).toBeGreaterThan(0);
    expect(editBudgetForName('цветкова алена владимировна')).toBe(2);
  });
});

describe('границы слияния', () => {
  it('логин, пароль, роль и доступ защищены от переноса', () => {
    for (const code of ['login', 'password_hash', 'system_role', 'access_enabled']) {
      expect(PROTECTED_CODES.has(code)).toBe(true);
    }
    // Метка слияния тоже не переносится: она принадлежит вторичной записи.
    expect(PROTECTED_CODES.has('merged_into')).toBe(true);
  });

  it('обычные поля карточки под защиту не попадают', () => {
    for (const code of ['full_name', 'telegram_login', 'personnel_number', 'department_id']) {
      expect(PROTECTED_CODES.has(code)).toBe(false);
    }
  });
});

describe('путь записи (сторож по коду)', () => {
  const SRC = readFileSync(fileURLToPath(new URL('./employeeDedupeService.ts', import.meta.url)), 'utf8');

  it('непустое поле основного никогда не перетирается', () => {
    expect(SRC).toContain("if ((survivorAttrs.get(code) ?? '') !== '') continue;");
  });

  it('dry-run возвращает отчёт ДО первой записи', () => {
    const beforeWrites = SRC.slice(0, SRC.indexOf('for (const { code, value } of fillable) {'));
    expect(beforeWrites, 'иначе «проверка» уже что-то изменила').toContain('if (dryRun) {');
    expect(beforeWrites).toContain('return { ok: true as const, report };');
  });

  it('пользовательские ссылки переносит тот же код, что и при удалении пользователя', () => {
    expect(SRC).toContain('await reassignUserReferences({ fromUserId: loserId, toUserId: survivorId');
  });

  it('настройки клиента перевешиваются по ЛОГИНУ, а не по id', () => {
    // `client_settings.lastUsername` хранит логин: поиск по id молча ничего не нашёл бы.
    expect(SRC).toContain('.where(eq(clientSettings.lastUsername, loserLogin as never))');
  });

  it('метка ставится ДО гашения, иначе связь основной и вторичной теряется', () => {
    expect(SRC.indexOf('MERGED_INTO_CODE, survivorId')).toBeLessThan(SRC.indexOf('await softDeleteEntity(args.actor, loserId'));
  });

  it('определение метки заводится до первой записи, но не в проверке', () => {
    // Без определения метка не пишется, а падало на ней уже ПОСЛЕ переноса чата и файлов.
    const ensureAt = SRC.indexOf('await upsertAttributeDef(args.actor');
    expect(ensureAt).toBeGreaterThan(SRC.indexOf('if (dryRun) {'));
    expect(ensureAt).toBeLessThan(SRC.indexOf('for (const { code, value } of fillable) {'));
  });

  it('вход по вторичному логину закрывается явно', () => {
    // Строка `users` остаётся, и без выключения доступа по её логину можно было бы войти.
    expect(SRC).toContain('.update(users).set({ accessEnabled: false })');
  });

  it('слияние записи с самой собой и мёртвых записей отвергается', () => {
    expect(SRC).toContain("if (survivorId === loserId) return { ok: false as const, error: 'основная и вторичная записи совпадают' };");
    expect(SRC).toContain("error: 'основная запись не найдена среди действующих сотрудников'");
  });

  it('уже слитые записи в кандидаты не попадают', () => {
    expect(SRC).toContain('if (attrs.get(MERGED_INTO_CODE)) continue;');
  });

  it('один человек не может попасть в две группы', () => {
    expect(SRC).toContain('const rest = candidates.filter((c) => !grouped.has(c.id));');
  });

  it('ссылки на вторичную считаются до «Проверить» — отказ видит и проверка', () => {
    const countAt = SRC.indexOf('await countEmployeeIncomingReferences(loserId)');
    expect(countAt).toBeGreaterThan(-1);
    expect(countAt).toBeLessThan(SRC.indexOf('if (dryRun) {'));
  });

  it('счёт ссылок видит всё, что гейт удаления, и хранилища сотрудника сверх него', () => {
    // Каждое из этих мест держит id сотрудника; выпавшее снова дало бы слияние «без ссылок».
    for (const probe of [
      'countExtendedIncomingReferences(employeeId)',
      'findIncomingLinkRows(employeeId)',
      'like(operations.metaJson, quotedId)',
      'erpEngineAssemblyBom.executionProfileJson',
      'timesheetRows.employeeId',
      'servicePriceOrders.issuedByEmployeeId',
      'erpDocumentHeaders.authorId',
    ]) {
      expect(SRC, probe).toContain(probe);
    }
  });
});

describe('ссылки, мимо которых проходит гейт удаления', () => {
  const EMP = 'eeeeeeee-0000-0000-0000-000000000001';

  it('бригада и подписи наряда уже посчитаны гейтом — второй раз не считаются', () => {
    expect(isUncountedOperationReference('work_order', { crew: [{ employeeId: EMP }] }, EMP)).toBe(false);
    expect(isUncountedOperationReference('work_order', { signatureBlocks: [{ slots: [{ employeeId: EMP }] }] }, EMP)).toBe(false);
  });

  it('утверждающий наряда и акт двигателя гейт не видит — их считает слияние', () => {
    expect(isUncountedOperationReference('work_order', { printSettings: { approverEmployeeId: EMP } }, EMP)).toBe(true);
    expect(isUncountedOperationReference('completeness', { commission: [{ id: 'm1', employeeId: EMP }] }, EMP)).toBe(true);
  });

  it('нечитаемый meta_json с id сотрудника — тоже ссылка: гейт такие пропускает', () => {
    expect(isUncountedOperationReference('work_order', null, EMP)).toBe(true);
  });

  it('отказ называет каждый вид с числом и говорит, что делать', () => {
    const text = referenceRefusalMessage(new Map([['Наряды', 3], ['Табели', 1]]));
    expect(text).toContain('Наряды: 3');
    expect(text).toContain('Табели: 1');
    expect(text).toContain('«Проверить»');
  });
});

describe('отказ при ссылках на вторичную запись', () => {
  const SURVIVOR = 'aaaaaaaa-0000-0000-0000-000000000001';
  const LOSER = 'aaaaaaaa-0000-0000-0000-000000000002';
  const ACTOR = { id: 'u1', username: 'owner1', role: 'superadmin' };

  beforeEach(() => {
    state.selectByTable.clear();
    vi.clearAllMocks();
    state.selectByTable.set(entityTypes, [[{ id: 'type-employee' }]]);
    state.selectByTable.set(entities, [[{ id: SURVIVOR }, { id: LOSER }]]);
  });

  function expectNoWrites() {
    expect(admin.upsertAttributeDef).not.toHaveBeenCalled();
    expect(admin.setEntityAttribute).not.toHaveBeenCalled();
    expect(admin.softDeleteEntity).not.toHaveBeenCalled();
    expect(reassignUserReferences).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  }

  it('«Проверить» отказывает с разбивкой: вторичная в наряде и в табеле', async () => {
    vi.mocked(admin.countExtendedIncomingReferences).mockResolvedValueOnce(new Map([['Наряды', 2]]));
    state.selectByTable.set(timesheetRows, [[{ id: 'row-1' }]]);

    const r = await mergeEmployees({ survivorId: SURVIVOR, loserId: LOSER, actor: ACTOR, dryRun: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('Наряды: 2');
      expect(r.error).toContain('Табели: 1');
    }
  });

  it('боевое слияние отказывает раньше первой записи — утверждающий наряда тоже ссылка', async () => {
    state.selectByTable.set(operations, [
      [{ operationType: 'work_order', metaJson: JSON.stringify({ printSettings: { approverEmployeeId: LOSER } }) }],
    ]);

    const r = await mergeEmployees({ survivorId: SURVIVOR, loserId: LOSER, actor: ACTOR });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Наряды: 1');
    expectNoWrites();
  });

  it('link-атрибут карточки назван видом карточки', async () => {
    vi.mocked(admin.findIncomingLinkRows).mockResolvedValueOnce([
      {
        valueId: 'v1',
        fromEntityId: 'dep-1',
        fromEntityTypeId: 'type-department',
        fromEntityTypeCode: 'department',
        fromEntityTypeName: 'Подразделения',
        attributeDefId: 'def-head',
        attributeCode: 'head_employee_id',
        attributeName: 'Руководитель',
      },
    ]);

    const r = await mergeEmployees({ survivorId: SURVIVOR, loserId: LOSER, actor: ACTOR, dryRun: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Подразделения: 1');
    expectNoWrites();
  });

  it('без ссылок проверка проходит, как раньше', async () => {
    const r = await mergeEmployees({ survivorId: SURVIVOR, loserId: LOSER, actor: ACTOR, dryRun: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.report.dryRun).toBe(true);
    expectNoWrites();
  });
});
