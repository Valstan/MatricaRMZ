import { describe, expect, it } from 'vitest';

import { mergeUserUiProfiles, sanitizeUserUiProfile, type UserUiProfile } from './userUiProfile.js';

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
