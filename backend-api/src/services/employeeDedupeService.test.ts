import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { __testables } from './employeeDedupeService.js';

const { normalizeName, editBudgetForName, PROTECTED_CODES } = __testables;

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
});
