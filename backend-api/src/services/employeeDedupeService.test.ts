import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// База и соседние сервисы подменены. Чистой части и сторожу по коду это безразлично, а проверки
// ниже гоняют сам `mergeEmployees`: важно не «склеилось ли», а порядок — перевод ссылок идёт
// первым, отказ не оставляет записей, а «Проверить» не пишет вовсе.
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
  setEntityAttribute: vi.fn(async () => ({ ok: true })),
  softDeleteEntity: vi.fn(async () => ({ ok: true })),
  upsertAttributeDef: vi.fn(async () => ({ ok: true })),
}));
vi.mock('./employeeAuthService.js', () => ({ setEmployeeAuth: vi.fn(async () => ({ ok: true })) }));
vi.mock('./employeeReferenceRepoint.js', () => ({
  repointEmployeeReferences: vi.fn(async () => ({ moved: 0, byStore: [], blockers: [], notes: [] })),
}));
vi.mock('./userDeletionService.js', () => ({ reassignUserReferences: vi.fn(async () => undefined) }));
vi.mock('./criticalEventsService.js', () => ({ ingestServerCriticalEvent: vi.fn() }));

const { db } = await import('../database/db.js');
const { entities, entityTypes, attributeDefs, attributeValues, users } = await import('../database/schema.js');
const admin = await import('./adminMasterdataService.js');
const { setEmployeeAuth } = await import('./employeeAuthService.js');
const { repointEmployeeReferences } = await import('./employeeReferenceRepoint.js');
const { reassignUserReferences } = await import('./userDeletionService.js');
const { __testables, mergeEmployees } = await import('./employeeDedupeService.js');

const { normalizeName, editBudgetForName, PROTECTED_CODES, blockerMessage } = __testables;

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

  it('отказ по непереводимой ссылке называет причину и не обещает пустого хода', () => {
    const text = blockerMessage({
      moved: 3,
      byStore: [{ store: 'Наряды', count: 3 }],
      blockers: [{ store: 'Складские документы (автор)', reason: 'нет строки erp_employee_cards' }],
      notes: [],
    });
    expect(text).toContain('Складские документы (автор)');
    expect(text).toContain('нет строки erp_employee_cards');
    // На боевом проходе часть ссылок уже переехала — обещать «ничего не изменено» нельзя.
    expect(text).not.toContain('Ни одна запись не изменена');
    expect(text).toContain('повтор');
  });
});

describe('путь записи (сторож по коду)', () => {
  const SRC = readFileSync(fileURLToPath(new URL('./employeeDedupeService.ts', import.meta.url)), 'utf8');

  it('непустое поле основного никогда не перетирается', () => {
    expect(SRC).toContain("const survivorValue = survivorAttrs.get(code) ?? '';");
    expect(SRC).toContain("if (survivorValue !== '') {");
    // Ветка «у основной уже заполнено» НИЧЕГО не пишет в основную запись — только
    // пополняет отчёт (иначе тихая потеря, промты КАРМАНА #52/#53).
    const from = SRC.indexOf("if (survivorValue !== '') {");
    const to = SRC.indexOf('fillable.push({ code, value });');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    expect(SRC.slice(from, to)).not.toContain('setEntityAttribute');
  });

  it('неперенесённые поля называются в отчёте, а не теряются молча', () => {
    // Отчёт обязан перечислить коды, которые НЕ перенеслись, с причиной: оператор видел
    // лишь «заполнено полей: 0» и думал, что слияние не сработало (промты #52/#53).
    expect(SRC).toContain("notTransferred: [],");
    expect(SRC).toContain("reason: 'protected'");
    expect(SRC).toContain("reason: 'occupied'");
    expect(SRC).toContain("reason: 'write_failed'");
  });

  it('запись атрибута воскрешает мёртвую строку, иначе значение пропадёт молча', () => {
    // Уникальный индекс (entity_id, attribute_def_id) один на пару — «мёртвая» строка
    // тоже строка. Запись в неё без снятия deleted_at выглядит успешной, а чтение её
    // не видит: атрибут исчезает (промты КАРМАНА #52/#53).
    const masterdata = readFileSync(fileURLToPath(new URL('./adminMasterdataService.ts', import.meta.url)), 'utf8');
    expect(masterdata).toContain('const reviving = existing[0] !== undefined && existing[0].deletedAt != null;');
    expect(masterdata).toContain('...(reviving ? { deletedAt: null } : {})');
    const auth = readFileSync(fileURLToPath(new URL('./employeeAuthService.ts', import.meta.url)), 'utf8');
    expect(auth).toContain('const reviving = existing[0].deletedAt != null;');
    expect(auth).toContain('...(reviving ? { deletedAt: null } : {})');
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

  it('доступ вторичного гасится через EAV, а не прямым UPDATE по зеркалу `users`', () => {
    // Строку `users` собирает триггер и публикует очередь: прямая правка не доехала бы до
    // клиентов и была бы стёрта следующей пересборкой из EAV.
    expect(SRC).toContain('await setEmployeeAuth(loserId, { accessEnabled: false })');
    expect(SRC).not.toContain('.update(users).set({ accessEnabled: false })');
  });

  it('перевод ссылок считается тем же кодом, что и применяет', () => {
    expect(SRC).toContain('apply: false');
    expect(SRC).toContain('apply: true');
    const planAt = SRC.indexOf('apply: false');
    expect(planAt).toBeLessThan(SRC.indexOf('if (dryRun) {'));
    expect(SRC.indexOf('apply: true')).toBeLessThan(SRC.indexOf('for (const { code, value } of fillable) {'));
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
});

describe('перевод ссылок в слиянии', () => {
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
    expect(setEmployeeAuth).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  }

  it('«Проверить» показывает, что будет переведено, и ничего не пишет', async () => {
    vi.mocked(repointEmployeeReferences).mockResolvedValueOnce({
      moved: 4,
      byStore: [
        { store: 'Наряды', count: 3 },
        { store: 'Табели (строки)', count: 1 },
      ],
      blockers: [],
      notes: ['в табеле обе записи уже стояли: 2 дн. остались с отметками основной записи'],
    });

    const r = await mergeEmployees({ survivorId: SURVIVOR, loserId: LOSER, actor: ACTOR, dryRun: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.report.referencesMoved).toBe(4);
      expect(r.report.referencesByStore).toEqual([
        { store: 'Наряды', count: 3 },
        { store: 'Табели (строки)', count: 1 },
      ]);
      expect(r.report.referenceNotes[0]).toContain('в табеле');
    }
    expect(vi.mocked(repointEmployeeReferences).mock.calls[0]?.[0]?.apply).toBe(false);
    expectNoWrites();
  });

  it('непереводимая ссылка останавливает и проверку, и слияние', async () => {
    vi.mocked(repointEmployeeReferences).mockResolvedValueOnce({
      moved: 0,
      byStore: [],
      blockers: [{ store: 'Складские документы (автор)', reason: 'нет строки erp_employee_cards' }],
      notes: [],
    });

    const r = await mergeEmployees({ survivorId: SURVIVOR, loserId: LOSER, actor: ACTOR });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Складские документы (автор)');
    expectNoWrites();
  });

  it('боевое слияние переводит ссылки ДО заполнения полей и гашения', async () => {
    vi.mocked(repointEmployeeReferences)
      .mockResolvedValueOnce({ moved: 2, byStore: [{ store: 'Наряды', count: 2 }], blockers: [], notes: [] })
      .mockResolvedValueOnce({ moved: 2, byStore: [{ store: 'Наряды', count: 2 }], blockers: [], notes: [] });

    const r = await mergeEmployees({ survivorId: SURVIVOR, loserId: LOSER, actor: ACTOR });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.report.referencesMoved).toBe(2);

    const applyCall = vi.mocked(repointEmployeeReferences).mock.invocationCallOrder[1];
    const tombCall = vi.mocked(admin.setEntityAttribute).mock.invocationCallOrder[0];
    const deleteCall = vi.mocked(admin.softDeleteEntity).mock.invocationCallOrder[0];
    expect(applyCall).toBeLessThan(tombCall ?? Number.MAX_SAFE_INTEGER);
    expect(applyCall).toBeLessThan(deleteCall ?? Number.MAX_SAFE_INTEGER);
    expect(vi.mocked(repointEmployeeReferences).mock.calls[1]?.[0]?.apply).toBe(true);
    expect(setEmployeeAuth).toHaveBeenCalledWith(LOSER, { accessEnabled: false });
  });

  it('без ссылок отчёт честно показывает ноль', async () => {
    const r = await mergeEmployees({ survivorId: SURVIVOR, loserId: LOSER, actor: ACTOR, dryRun: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.report.referencesMoved).toBe(0);
      expect(r.report.referencesByStore).toEqual([]);
    }
  });
});

/**
 * Отчёт о слиянии: что НЕ перенеслось (промты КАРМАНА #52/#53).
 *
 * Жалоба владельца: «данные одного из аккаунтов пропадают, остаются только данные одного
 * аккаунта». Пока в отчёте был только счётчик «полей заполнено N», потеря была невидима:
 * оператор не понимал, что произошло, и списывал это на «слияние не работает».
 */
describe('отчёт о слиянии: что НЕ перенеслось', () => {
  const SURVIVOR = 'aaaaaaaa-0000-0000-0000-000000000001';
  const LOSER = 'aaaaaaaa-0000-0000-0000-000000000002';
  const ACTOR = { id: 'u1', username: 'owner1', role: 'superadmin' };

  beforeEach(() => {
    state.selectByTable.clear();
    vi.clearAllMocks();
    state.selectByTable.set(entityTypes, [[{ id: 'type-employee' }]]);
    state.selectByTable.set(entities, [[{ id: SURVIVOR }, { id: LOSER }]]);
    state.selectByTable.set(users, [[]]);
    state.selectByTable.set(attributeDefs, [
      [
        { id: 'd-role', code: 'role' },
        { id: 'd-full', code: 'full_name' },
        { id: 'd-tg', code: 'telegram_login' },
      ],
    ]);
  });

  it('у основной поле уже заполнено — в отчёт идёт код с причиной, а не молчание', async () => {
    state.selectByTable.set(attributeValues, [
      [{ attributeDefId: 'd-role', valueJson: '"Токарь"' }],
      [{ attributeDefId: 'd-role', valueJson: '"Механик участка"' }],
    ]);
    const r = await mergeEmployees({ survivorId: SURVIVOR, loserId: LOSER, actor: ACTOR, dryRun: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.attrsFilled).toBe(0);
    const occupied = r.report.notTransferred.find((n) => n.code === 'role');
    expect(occupied?.reason).toBe('occupied');
    // Расхождение значений обязано быть видно словами: «Токарь» против «Механик участка».
    expect(occupied?.detail).toContain('Токарь');
    expect(occupied?.detail).toContain('Механик участка');
  });

  it('пустое у основной поле переносится и в отчёт не попадает', async () => {
    state.selectByTable.set(attributeValues, [
      [],
      [{ attributeDefId: 'd-tg', valueJson: '"@mechanic"' }],
    ]);
    const r = await mergeEmployees({ survivorId: SURVIVOR, loserId: LOSER, actor: ACTOR });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.attrsFilled).toBe(1);
    expect(r.report.notTransferred).toEqual([]);
    expect(vi.mocked(admin.setEntityAttribute).mock.calls[0]?.[2]).toBe('telegram_login');
  });

  it('отказ записи виден в отчёте, а не теряется', async () => {
    state.selectByTable.set(attributeValues, [
      [],
      [{ attributeDefId: 'd-tg', valueJson: '"@mechanic"' }],
    ]);
    vi.mocked(admin.setEntityAttribute).mockImplementation(async (_actor, _id, code) =>
      code === 'telegram_login'
        ? { ok: false as const, error: 'связанный элемент не найден' }
        : { ok: true as const },
    );
    const r = await mergeEmployees({ survivorId: SURVIVOR, loserId: LOSER, actor: ACTOR });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.attrsFilled).toBe(0);
    const failed = r.report.notTransferred.find((n) => n.code === 'telegram_login');
    expect(failed?.reason).toBe('write_failed');
    expect(failed?.detail).toContain('связанный элемент не найден');
  });

  it('защищённые коды (логин, доступ) помечены отдельно и не считаются потерей данных', async () => {
    state.selectByTable.set(attributeValues, [
      [],
      [{ attributeDefId: 'd-full', valueJson: '"Иванов Иван"' }],
    ]);
    const r = await mergeEmployees({ survivorId: SURVIVOR, loserId: LOSER, actor: ACTOR, dryRun: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.protectedSkipped).toEqual([]);
    expect(r.report.notTransferred).toEqual([]);
  });
});
