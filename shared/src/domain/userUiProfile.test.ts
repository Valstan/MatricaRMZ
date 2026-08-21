import { describe, expect, it } from 'vitest';

import { DEFAULT_UI_SHELL_PREFS } from './uiShellV2.js';
import {
  extractUserUiProfileShellPrefs,
  mergeUserUiProfiles,
  sanitizeUserUiProfile,
  type UserUiProfile,
} from './userUiProfile.js';

// Merge с per-key LWW (v3.5.0). До него PATCH заменял профиль целиком:
// клиент, пушащий 4 ключа из 5, молча стирал aiChatTemplates, а пуш пустого
// снапшота после неудачного GET стирал серверные пины «Моего круга».

const T1 = 1_000_000;
const T2 = 2_000_000;
const T3 = 3_000_000;

function storedProfile(): UserUiProfile {
  return {
    updatedAt: T2,
    shortcuts: ['tab:engines', 'tab:contracts'],
    aiChatTemplates: [{ id: 'tpl1', title: 'Шаблон', text: 'привет', createdAt: T1 }],
    keyUpdatedAt: { shortcuts: T2, aiChatTemplates: T2 },
  };
}

describe('mergeUserUiProfiles', () => {
  it('an absent section stays untouched (the aiChatTemplates wipe is fixed)', () => {
    // Легаси-клиент шлёт 4 ключа без aiChatTemplates и без keyUpdatedAt.
    const { profile, stale } = mergeUserUiProfiles(storedProfile(), {
      updatedAt: T3,
      shortcuts: ['tab:engines'],
      recentVisits: [],
      quickStartScores: {},
      tabsLayout: null,
    });
    expect(stale).toBe(false);
    expect(profile.shortcuts).toEqual(['tab:engines']);
    expect(profile.aiChatTemplates).toEqual(storedProfile().aiChatTemplates);
    expect(profile.updatedAt).toBe(T3);
  });

  it('per-key: a newer key wins, an older key is rejected without touching the rest', () => {
    const { profile, stale } = mergeUserUiProfiles(storedProfile(), {
      updatedAt: T1,
      keyUpdatedAt: { shortcuts: T1, aiChatTemplates: T3 },
      shortcuts: ['tab:stale'],
      aiChatTemplates: [{ id: 'tpl2', title: 'Новый', text: 'ok', createdAt: T3 }],
    });
    expect(stale).toBe(true); // shortcuts отклонены
    expect(profile.shortcuts).toEqual(storedProfile().shortcuts);
    expect(profile.aiChatTemplates?.[0]?.id).toBe('tpl2');
    expect(profile.keyUpdatedAt?.aiChatTemplates).toBe(T3);
    expect(profile.keyUpdatedAt?.shortcuts).toBe(T2); // отклонённый ключ хранит прежний штамп
  });

  it('legacy semantics: a fully stale whole-profile PATCH applies nothing', () => {
    const { profile, stale } = mergeUserUiProfiles(storedProfile(), {
      updatedAt: T1,
      shortcuts: [],
      aiChatTemplates: [],
    });
    expect(stale).toBe(true);
    expect(profile.shortcuts).toEqual(storedProfile().shortcuts);
    expect(profile.aiChatTemplates).toEqual(storedProfile().aiChatTemplates);
  });

  it('a deliberately emptied list with a newer stamp IS accepted', () => {
    const { profile, stale } = mergeUserUiProfiles(storedProfile(), {
      updatedAt: T3,
      keyUpdatedAt: { shortcuts: T3 },
      shortcuts: [],
    });
    expect(stale).toBe(false);
    expect(profile.shortcuts).toEqual([]);
    expect(profile.aiChatTemplates).toEqual(storedProfile().aiChatTemplates);
  });

  it('no stored profile: incoming becomes the baseline with stamps for present keys', () => {
    const { profile, stale } = mergeUserUiProfiles(null, { updatedAt: T1, shortcuts: ['tab:x'] });
    expect(stale).toBe(false);
    expect(profile.shortcuts).toEqual(['tab:x']);
    expect(profile.keyUpdatedAt).toEqual({ shortcuts: T1 });
  });

  it('shellPrefs section: sanitized without sessions, roams through merge', () => {
    const full = structuredClone(DEFAULT_UI_SHELL_PREFS);
    full.v2.buttonLayout.pinned = ['engines', 'unknown_future_tab'];
    full.v2.session.openCards = [{ kind: 'engine', entityId: 'e1', title: 'X' }];
    const roam = extractUserUiProfileShellPrefs(full);
    // Сессии в roaming-подмножество не входят.
    expect('session' in (roam.v2 as Record<string, unknown>)).toBe(false);
    // Неизвестные id пинов сохраняются (id-чурн не должен стирать пины).
    expect(roam.v2.buttonLayout.pinned).toEqual(['engines', 'unknown_future_tab']);

    const { profile } = mergeUserUiProfiles(null, { updatedAt: T1, shellPrefs: roam });
    expect(profile.shellPrefs?.v2.buttonLayout.pinned).toEqual(['engines', 'unknown_future_tab']);
    expect(profile.keyUpdatedAt?.shellPrefs).toBe(T1);

    // Мусорная секция выбрасывается, валидные проценты клампятся.
    const p = sanitizeUserUiProfile({ updatedAt: T1, shellPrefs: { v2: null, v3: { sectionsPct: 99, comparePct: 1 } } });
    expect(p.shellPrefs?.v3.sectionsPct).toBe(85);
    expect(p.shellPrefs?.v3.comparePct).toBe(15);
  });

  it('a partial aiChatTemplates-only PATCH does not touch other sections', () => {
    const { profile, stale } = mergeUserUiProfiles(storedProfile(), {
      updatedAt: T3,
      keyUpdatedAt: { aiChatTemplates: T3 },
      aiChatTemplates: [{ id: 'tpl9', title: 'Т', text: 'x', createdAt: T3 }],
    });
    expect(stale).toBe(false);
    expect(profile.shortcuts).toEqual(storedProfile().shortcuts);
    expect(profile.aiChatTemplates?.[0]?.id).toBe('tpl9');
  });

  it('columnLayouts section survives merge and is sanitized per layout', () => {
    const { profile } = mergeUserUiProfiles(storedProfile(), {
      updatedAt: T3,
      keyUpdatedAt: { columnLayouts: T3 },
      columnLayouts: {
        'list:engines:columns': { order: ['num', 'brand'], hidden: ['brand'], updatedAt: T3 },
        'list:bad': 'not an object',
      },
    });
    expect(profile.columnLayouts?.['list:engines:columns']?.hidden).toEqual(['brand']);
    expect(profile.columnLayouts?.['list:bad']).toBeUndefined();
    // Другие секции не задеты.
    expect(profile.shortcuts).toEqual(storedProfile().shortcuts);
  });

  it('sanitizer keeps keyUpdatedAt and drops garbage entries', () => {
    const p = sanitizeUserUiProfile({
      updatedAt: T1,
      keyUpdatedAt: { shortcuts: T1, bad: 'nope', zero: 0, ['x'.repeat(200)]: T1 },
    });
    expect(p.keyUpdatedAt?.shortcuts).toBe(T1);
    expect(p.keyUpdatedAt && Object.keys(p.keyUpdatedAt).some((k) => k.length > 64)).toBe(false);
    expect(p.keyUpdatedAt && 'bad' in p.keyUpdatedAt).toBe(false);
    expect(p.keyUpdatedAt && 'zero' in p.keyUpdatedAt).toBe(false);
  });
});

// «Прививка» релиза 1: секции рабочего стола обязаны пережить и санитайзер, и merge на
// релиз РАНЬШЕ, чем появится пишущий их код. Иначе клиент прошлой версии, сохранив
// профиль, сотрёт раскладку и рейтинг у всех машин пользователя — sanitizeUserUiProfile
// вызывается и на чтении, и на записи, а LWW заменяет секцию целиком.
describe('прививка секций рабочего стола', () => {
  const withDesktop = {
    updatedAt: 100,
    desktop: {
      shortcuts: [{ id: 's1', label: 'Двигатели', createdAt: 50, pos: { col: 2, row: 1 } }],
      folders: [],
      layout: { chatPct: 33, peoplePct: 30 },
      shortcutsMigratedAt: 90,
    },
    desktopUsage: { buckets: { s1: { '2026-08-21': 4 } }, foldedAt: 95 },
  };

  it('санитайзер не выбрасывает ни координату, ни отметку переезда, ни счётчик', () => {
    const p = sanitizeUserUiProfile(withDesktop);
    expect(p.desktop?.shortcuts[0]?.pos).toEqual({ col: 2, row: 1 });
    expect(p.desktop?.shortcutsMigratedAt).toBe(90);
    expect(p.desktopUsage?.buckets.s1).toEqual({ '2026-08-21': 4 });
  });

  it('merge не стирает счётчик, когда клиент прислал PATCH без него', () => {
    const stored = sanitizeUserUiProfile(withDesktop);
    const { profile } = mergeUserUiProfiles(stored, {
      updatedAt: 200,
      keyUpdatedAt: { shortcuts: 200 },
      shortcuts: ['engines'],
    });
    expect(profile.desktopUsage?.buckets.s1).toEqual({ '2026-08-21': 4 });
    expect(profile.desktop?.shortcuts[0]?.pos).toEqual({ col: 2, row: 1 });
  });

  it('свежая секция счётчика применяется по своему штампу', () => {
    const stored = sanitizeUserUiProfile(withDesktop);
    const { profile, stale } = mergeUserUiProfiles(stored, {
      updatedAt: 300,
      keyUpdatedAt: { desktopUsage: 300 },
      desktopUsage: { buckets: { s1: { '2026-08-22': 9 } }, foldedAt: 300 },
    });
    expect(stale).toBe(false);
    expect(profile.desktopUsage?.buckets.s1).toEqual({ '2026-08-22': 9 });
  });
});
