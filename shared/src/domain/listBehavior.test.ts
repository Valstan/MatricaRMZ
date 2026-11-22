import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LIST_BEHAVIOR_SETTINGS,
  sanitizeListBehaviorSettings,
} from './listBehavior.js';
import {
  DEFAULT_UI_CONTROL_SETTINGS,
  mergeUiControlSettings,
  sanitizeUiControlSettings,
} from './uiControl.js';

// D-248 (ответ владельца 21.11 по плану «Списки во всей программе по одним правилам»):
// настройка правил списков — ОДНА на всю программу. Живёт в глобальных дефолтах и не
// участвует в слиянии с личными настройками: личная правка иначе стала бы второй правдой.
describe('правила поведения списков (D-248)', () => {
  it('дефолты включены все четыре — список по умолчанию ведёт себя по-новому', () => {
    expect(DEFAULT_LIST_BEHAVIOR_SETTINGS).toEqual({
      dragVisual: true,
      keyboardMove: true,
      lasso: true,
      contextMenu: true,
    });
    expect(DEFAULT_UI_CONTROL_SETTINGS.listBehavior).toEqual(DEFAULT_LIST_BEHAVIOR_SETTINGS);
  });

  it('санитайзер держит явные false и чинит битые значения', () => {
    expect(sanitizeListBehaviorSettings({ dragVisual: false, keyboardMove: false })).toEqual({
      dragVisual: false,
      keyboardMove: false,
      lasso: true,
      contextMenu: true,
    });
    expect(sanitizeListBehaviorSettings({ dragVisual: 'да' }).dragVisual).toBe(true);
    expect(sanitizeListBehaviorSettings(null)).toEqual(DEFAULT_LIST_BEHAVIOR_SETTINGS);
    expect(sanitizeListBehaviorSettings(undefined)).toEqual(DEFAULT_LIST_BEHAVIOR_SETTINGS);
  });

  it('ЛИЧНЫЕ настройки не перекрывают глобальное правило — вторая правда не появляется', () => {
    const global = sanitizeUiControlSettings({
      ...DEFAULT_UI_CONTROL_SETTINGS,
      listBehavior: { dragVisual: true, keyboardMove: true, lasso: false, contextMenu: true },
    });
    const personal = sanitizeUiControlSettings({
      ...DEFAULT_UI_CONTROL_SETTINGS,
      listBehavior: { dragVisual: false, keyboardMove: false, lasso: true, contextMenu: false },
    });
    const merged = mergeUiControlSettings(global, personal);
    expect(merged.listBehavior).toEqual(global.listBehavior);
    expect(merged.listBehavior.lasso).toBe(false);
    expect(merged.listBehavior.dragVisual).toBe(true);
  });

  it('остальные группы по-прежнему сливаются как раньше (регресс)', () => {
    const global = sanitizeUiControlSettings(DEFAULT_UI_CONTROL_SETTINGS);
    // Настройка вида списка живёт в профиле пресета — там и проверяем слияние:
    // правка «профиля» личной настройки обязана дойти до результата.
    const personal = sanitizeUiControlSettings({
      ...DEFAULT_UI_CONTROL_SETTINGS,
      presets: {
        ...DEFAULT_UI_CONTROL_SETTINGS.presets,
        editorPresetId: 'medium',
        defaultPresetId: 'medium',
        profiles: {
          ...DEFAULT_UI_CONTROL_SETTINGS.presets.profiles,
          medium: {
            ...DEFAULT_UI_CONTROL_SETTINGS.presets.profiles.medium,
            lists: { ...DEFAULT_UI_CONTROL_SETTINGS.presets.profiles.medium.lists, fontSize: 21 },
          },
        },
      },
    });
    expect(personal.lists.fontSize).toBe(21);
    const merged = mergeUiControlSettings(global, personal);
    expect(merged.lists.fontSize).toBe(21);
    expect(merged.lists.fontSize).not.toBe(global.lists.fontSize);
  });

  it('без оверлея глобальные правила сохраняются как есть', () => {
    const global = sanitizeUiControlSettings({
      ...DEFAULT_UI_CONTROL_SETTINGS,
      listBehavior: { dragVisual: false, keyboardMove: true, lasso: true, contextMenu: false },
    });
    expect(mergeUiControlSettings(global, undefined).listBehavior).toEqual(global.listBehavior);
  });

  it('смена пресета интерфейса не трогает правила списков', () => {
    const base = sanitizeUiControlSettings(DEFAULT_UI_CONTROL_SETTINGS);
    const applied = mergeUiControlSettings(base, {
      ...base,
      presets: { ...base.presets, defaultPresetId: 'small' },
    });
    expect(applied.listBehavior).toEqual(base.listBehavior);
  });
});
