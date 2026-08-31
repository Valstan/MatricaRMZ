import { describe, expect, it } from 'vitest';

import { parseSectionMembership } from '@matricarmz/shared';
import { applySectionAccessDelta, sectionAccessSeedValue } from '../services/employeeAuthService.js';

// Seeding decision for section_access on role assignment (review finding on
// PR #707: assigning a role wrote only system_role, leaving the Ф3 section
// gate fail-open for the new account).

describe('sectionAccessSeedValue', () => {
  it('seeds the role template when no membership exists', () => {
    const value = sectionAccessSeedValue(null, 'storekeeper');
    expect(value).not.toBeNull();
    expect(parseSectionMembership(value)).toMatchObject({ warehouse: 'editor', supply: 'editor', production: 'viewer' });
  });

  it('never overwrites a configured matrix (role change keeps hand-tuned sections)', () => {
    const existing = JSON.stringify({ contracts: 'viewer' });
    expect(sectionAccessSeedValue(existing, 'storekeeper')).toBeNull();
  });

  it('treats a stored empty membership as missing', () => {
    expect(sectionAccessSeedValue('{}', 'viewer')).not.toBeNull();
    expect(sectionAccessSeedValue(JSON.stringify(JSON.stringify({})), 'viewer')).not.toBeNull();
  });

  it('writes nothing for roles whose seed is empty (pending/employee/unknown)', () => {
    expect(sectionAccessSeedValue(null, 'pending')).toBeNull();
    expect(sectionAccessSeedValue(null, 'employee')).toBeNull();
    expect(sectionAccessSeedValue(null, 'nonsense')).toBeNull();
  });

  it('tolerates the double-encoded prod storage format', () => {
    const doubleEncoded = JSON.stringify(JSON.stringify({ production: 'viewer' }));
    expect(sectionAccessSeedValue(doubleEncoded, 'viewer')).toBeNull();
  });
});

// B3/R4a: дельта-дверь доступов. Класс дефекта, ради которого она заведена —
// «протухший read-modify-write»: обе страницы доступов строят полный набор из
// ЛОКАЛЬНОГО EAV и шлют его целиком, а дверь полного набора снимает всё, чего
// в наборе нет. Пока EAV живой, это верно; после cutover (R4b) один клик на не
// обновлённой машине вернул бы матрицу к состоянию на день заморозки — молча,
// с надписью «сохранено». Дельта убирает саму возможность: клиент присылает
// только правку, базу берёт сервер.
describe('applySectionAccessDelta — дверь, которой нельзя откатить чужую работу', () => {
  it('сохраняет разделы, о которых клиент не знает', () => {
    // Ровно тот сценарий: у человека на сервере уже есть production, клиент о
    // нём не подозревает и выдаёт reports. production обязан выжить.
    const stored = JSON.stringify({ production: 'editor' });
    const r = applySectionAccessDelta(stored, 'reports', 'viewer');
    expect(r.ok).toBe(true);
    expect(r.ok && r.membership).toEqual({ production: 'editor', reports: 'viewer' });
  });

  it('снятие раздела убирает ровно его', () => {
    const stored = JSON.stringify({ production: 'editor', reports: 'viewer' });
    const r = applySectionAccessDelta(stored, 'reports', null);
    expect(r.ok && r.membership).toEqual({ production: 'editor' });
  });

  it('снятие несуществующего раздела — не ошибка и ничего не трогает', () => {
    const stored = JSON.stringify({ production: 'editor' });
    const r = applySectionAccessDelta(stored, 'reports', null);
    expect(r.ok && r.membership).toEqual({ production: 'editor' });
  });

  it('незнакомый раздел в ПРАВКЕ — громкий отказ с именем виновника', () => {
    const r = applySectionAccessDelta(null, 'no_such_section', 'viewer');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('no_such_section');
  });

  it('незнакомый уровень — громкий отказ', () => {
    const r = applySectionAccessDelta(null, 'reports', 'owner');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('owner');
  });

  it('уровень null и уровень-мусор различаются: первый снимает, второй отказывает', () => {
    expect(applySectionAccessDelta(JSON.stringify({ reports: 'viewer' }), 'reports', null).ok).toBe(true);
    expect(applySectionAccessDelta(JSON.stringify({ reports: 'viewer' }), 'reports', '').ok).toBe(false);
  });

  it('legacy-мусор в сохранённой базе отбрасывается молча, а не запирает админа', () => {
    // За раздел из прежней версии каталога админ не отвечает; отказ здесь
    // означал бы, что доступами этому человеку больше не управляет никто.
    const stored = JSON.stringify({ legacy_section: 'viewer', production: 'editor' });
    const r = applySectionAccessDelta(stored, 'reports', 'viewer');
    expect(r.ok).toBe(true);
    expect(r.ok && r.membership).toEqual({ production: 'editor', reports: 'viewer' });
  });

  it('пустая база — законное состояние, а не повод отказать', () => {
    const r = applySectionAccessDelta(null, 'reports', 'viewer');
    expect(r.ok && r.membership).toEqual({ reports: 'viewer' });
  });
});
