import React, { useEffect, useMemo, useState } from 'react';
import type { UiControlSettings, UiDisplayButtonState, UiDisplayButtonStyle, UiDisplayTarget } from '@matricarmz/shared';
import { DEFAULT_UI_CONTROL_SETTINGS, mergeUiControlSettings, sanitizeUiControlSettings } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SectionCard } from '../components/SectionCard.js';

type Mode = 'global' | 'user';

const PRESET_TITLE_FONT_SIZES = [16, 18, 20, 22, 24, 26, 28, 30, 32];
const PRESET_FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 26, 28];
const PRESET_SPACES = [0, 2, 4, 6, 8, 10, 12, 16, 20, 24, 28, 32];
const PRESET_BUTTON_WIDTHS = [120, 140, 160, 180, 200, 220, 240, 260, 280, 320];
const PRESET_BUTTON_HEIGHTS = [28, 32, 36, 40, 44, 48, 56, 64, 80, 96, 120, 152];
const PRESET_BUTTON_PADDING = [0, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24];
const PRESET_ENTITY_CARD_WIDTHS = [260, 320, 360, 420, 480, 520, 560, 640, 720, 840, 960, 1080];
const PRESET_DATE_PICKER_SCALE = [1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.4, 2.6, 2.8, 3];

function parseNumericInput(raw: string, allowDecimal: boolean): number | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(',', '.');
  const valid = allowDecimal ? /^\d*(?:\.\d*)?$/.test(normalized) : /^\d+$/.test(normalized);
  if (!valid) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return allowDecimal ? parsed : Math.round(parsed);
}

function NumericPresetInput(props: {
  listId: string;
  value: number;
  presets: number[];
  disabled?: boolean;
  allowDecimal?: boolean;
  onValueChange: (next: number) => void;
}) {
  const [text, setText] = useState(String(props.value ?? ''));
  const [focused, setFocused] = useState(false);
  const allowDecimal = props.allowDecimal === true;

  useEffect(() => {
    if (!focused) setText(String(props.value ?? ''));
  }, [focused, props.value]);

  const options = Array.from(new Set(props.presets.map((v) => (allowDecimal ? Number(v) : Math.round(v))))).sort((a, b) => a - b);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr minmax(96px, 120px)', gap: 6, alignItems: 'center' }}>
      <Input
        type="text"
        inputMode={allowDecimal ? 'decimal' : 'numeric'}
        pattern={allowDecimal ? '^\\d*(?:[\\.,]\\d*)?$' : '^\\d+$'}
        value={text}
        disabled={props.disabled}
        onFocus={() => setFocused(true)}
        onChange={(e) => {
          const nextText = String(e.target.value ?? '');
          setText(nextText);
          const parsed = parseNumericInput(nextText, allowDecimal);
          if (parsed != null) props.onValueChange(parsed);
        }}
        onBlur={() => {
          setFocused(false);
          const parsed = parseNumericInput(text, allowDecimal);
          if (parsed == null) {
            setText(String(props.value ?? ''));
            return;
          }
          props.onValueChange(parsed);
          setText(String(parsed));
        }}
      />
      <select
        disabled={props.disabled}
        value=""
        onChange={(e) => {
          const raw = String(e.target.value ?? '');
          if (!raw) return;
          const parsed = parseNumericInput(raw, allowDecimal);
          if (parsed == null) return;
          props.onValueChange(parsed);
          setText(String(parsed));
        }}
        style={{
          width: '100%',
          minHeight: 28,
          padding: '4px 6px',
          border: '1px solid var(--input-border)',
          background: props.disabled ? 'var(--input-bg-disabled)' : 'var(--input-bg)',
          color: 'var(--text)',
          fontSize: 'var(--ui-input-font-size, 13px)',
        }}
        title="Популярные значения"
      >
        <option value="">Пресет</option>
        {options.map((v) => (
          <option key={`${props.listId}-preset-${v}`} value={String(v)}>
            {String(v)}
          </option>
        ))}
      </select>
    </div>
  );
}

export function UiControlCenterPage(props: {
  canEditGlobal: boolean;
  onApplyEffective: (settings: UiControlSettings) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [mode, setMode] = useState<Mode>('user');
  const [uiDefaultsVersion, setUiDefaultsVersion] = useState<number>(1);
  const [globalDefaults, setGlobalDefaults] = useState<UiControlSettings>(DEFAULT_UI_CONTROL_SETTINGS);
  const [userSettings, setUserSettings] = useState<UiControlSettings | null>(null);
  const [effective, setEffective] = useState<UiControlSettings>(DEFAULT_UI_CONTROL_SETTINGS);
  const [draft, setDraft] = useState<UiControlSettings>(DEFAULT_UI_CONTROL_SETTINGS);
  const [autoApplyReady, setAutoApplyReady] = useState(false);

  const editTarget = useMemo(() => (mode === 'global' ? globalDefaults : userSettings ?? effective), [effective, globalDefaults, mode, userSettings]);

  useEffect(() => {
    setDraft(sanitizeUiControlSettings(editTarget));
  }, [editTarget]);

  useEffect(() => {
    if (!autoApplyReady) return;
    props.onApplyEffective(draft);
  }, [autoApplyReady, draft, props.onApplyEffective]);

  async function load() {
    setLoading(true);
    setStatus('');
    try {
      const res = await window.matrica.settings.uiControlGet();
      if (!res?.ok) {
        setStatus(`Ошибка загрузки: ${String((res as any)?.error ?? 'unknown')}`);
        return;
      }
      setUiDefaultsVersion(Number(res.uiDefaultsVersion ?? 1));
      setGlobalDefaults(sanitizeUiControlSettings(res.globalDefaults ?? DEFAULT_UI_CONTROL_SETTINGS));
      setUserSettings(res.userSettings ? sanitizeUiControlSettings(res.userSettings) : null);
      const nextEffective = sanitizeUiControlSettings(res.effective ?? DEFAULT_UI_CONTROL_SETTINGS);
      setEffective(nextEffective);
      props.onApplyEffective(nextEffective);
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setAutoApplyReady(true);
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function patch(mutator: (prev: UiControlSettings) => UiControlSettings) {
    setDraft((prev) => sanitizeUiControlSettings(mutator(prev)));
  }

  function isButtonTarget(target: UiDisplayTarget): target is 'departmentButtons' | 'sectionButtons' {
    return target === 'departmentButtons' || target === 'sectionButtons';
  }

  function currentButtonStyle(): UiDisplayButtonStyle {
    if (!isButtonTarget(draft.menuButtons.selectedTarget)) return draft.menuButtons.sectionButtons.active;
    return draft.menuButtons[draft.menuButtons.selectedTarget][draft.menuButtons.selectedButtonState];
  }

  function updateButtonStyleField(field: keyof UiDisplayButtonStyle, value: number) {
    const target = draft.menuButtons.selectedTarget;
    const state = draft.menuButtons.selectedButtonState;
    if (!isButtonTarget(target)) return;
    patch((prev) => ({
      ...prev,
      menuButtons: {
        ...prev.menuButtons,
        [target]: {
          ...prev.menuButtons[target],
          [state]: {
            ...prev.menuButtons[target][state],
            [field]: Number.isFinite(value) ? value : prev.menuButtons[target][state][field],
          },
        },
      },
    }));
  }

  function resetToDefaults() {
    const next = mode === 'global' ? DEFAULT_UI_CONTROL_SETTINGS : globalDefaults;
    setDraft(sanitizeUiControlSettings(next));
    setStatus(mode === 'global' ? 'Сброшено к базовым глобальным настройкам' : 'Сброшено к глобальным настройкам');
  }

  async function save() {
    setStatus('');
    if (mode === 'global') {
      if (!props.canEditGlobal) {
        setStatus('Недостаточно прав для изменения глобальных настроек');
        return;
      }
      const res = await window.matrica.settings.uiControlSetGlobal({ uiSettings: draft, bumpVersion: true });
      if (!res?.ok) {
        setStatus(`Ошибка сохранения: ${String((res as any)?.error ?? 'unknown')}`);
        return;
      }
      const nextGlobal = sanitizeUiControlSettings(res.globalDefaults ?? draft);
      setGlobalDefaults(nextGlobal);
      const nextEffective = sanitizeUiControlSettings(
        userSettings ? mergeUiControlSettings(nextGlobal, userSettings) : nextGlobal,
      );
      setEffective(nextEffective);
      props.onApplyEffective(nextEffective);
      setUiDefaultsVersion(Number(res.uiDefaultsVersion ?? uiDefaultsVersion + 1));
      setStatus('Глобальные настройки сохранены');
    } else {
      const res = await window.matrica.settings.uiControlSetUser({ uiSettings: draft });
      if (!res?.ok) {
        setStatus(`Ошибка сохранения: ${String((res as any)?.error ?? 'unknown')}`);
        return;
      }
      const nextUser = sanitizeUiControlSettings(res.userSettings ?? draft);
      const nextEffective = sanitizeUiControlSettings(res.effective ?? nextUser);
      setUserSettings(nextUser);
      setGlobalDefaults(sanitizeUiControlSettings(res.globalDefaults ?? globalDefaults));
      setUiDefaultsVersion(Number(res.uiDefaultsVersion ?? uiDefaultsVersion));
      setEffective(nextEffective);
      props.onApplyEffective(nextEffective);
      setStatus('Пользовательские настройки сохранены');
    }
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <SectionCard title="Центр управления интерфейсом">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button size="sm" variant={mode === 'user' ? 'primary' : 'ghost'} onClick={() => setMode('user')}>
            Мои настройки
          </Button>
          <Button size="sm" variant={mode === 'global' ? 'primary' : 'ghost'} onClick={() => setMode('global')} disabled={!props.canEditGlobal}>
            Глобальные настройки
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
            Обновить
          </Button>
          <span style={{ color: 'var(--muted)' }}>Версия глобальных настроек: {uiDefaultsVersion}</span>
        </div>
        <div style={{ marginTop: 8, color: 'var(--muted)', fontSize: 12 }}>
          Единые настройки интерфейса разделены на два режима: персональные и глобальные.
          {' '}
          Глобальные настройки доступны только суперадминистратору и применяются как базовые.
        </div>
        {status ? <div style={{ marginTop: 8, color: 'var(--muted)' }}>{status}</div> : null}
      </SectionCard>

      <SectionCard title="Глобальные параметры интерфейса">
        <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 8 }}>
          Эти параметры влияют на базовую типографику и отступы во всём приложении.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: 8 }}>
          <label>
            Размер заголовка страницы (px)
            <NumericPresetInput
              listId="ui-control-global-title-size"
              value={draft.global.titleFontSize}
              presets={PRESET_TITLE_FONT_SIZES}
              onValueChange={(next) => patch((p) => ({ ...p, global: { ...p.global, titleFontSize: next } }))}
            />
          </label>
          <label>
            Размер заголовков секций (px)
            <NumericPresetInput
              listId="ui-control-global-section-size"
              value={draft.global.sectionFontSize}
              presets={PRESET_FONT_SIZES}
              onValueChange={(next) => patch((p) => ({ ...p, global: { ...p.global, sectionFontSize: next } }))}
            />
          </label>
          <label>
            Размер основного текста (px)
            <NumericPresetInput
              listId="ui-control-global-body-size"
              value={draft.global.bodyFontSize}
              presets={PRESET_FONT_SIZES}
              onValueChange={(next) => patch((p) => ({ ...p, global: { ...p.global, bodyFontSize: next } }))}
            />
          </label>
          <label>
            Размер вторичного текста (px)
            <NumericPresetInput
              listId="ui-control-global-muted-size"
              value={draft.global.mutedFontSize}
              presets={PRESET_FONT_SIZES}
              onValueChange={(next) => patch((p) => ({ ...p, global: { ...p.global, mutedFontSize: next } }))}
            />
          </label>
          <label>
            Базовый отступ уровня 4 (px)
            <NumericPresetInput
              listId="ui-control-global-space4"
              value={draft.global.space4}
              presets={PRESET_SPACES}
              onValueChange={(next) => patch((p) => ({ ...p, global: { ...p.global, space4: next } }))}
            />
          </label>
        </div>
      </SectionCard>

      <SectionCard title="Отображение интерфейса клиента">
        <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 10 }}>
          Настройка кнопок отделов/разделов и размеров шрифта списков и карточек.
        </div>
        <div style={{ display: 'grid', gap: 12 }}>
          <div>
            <div style={{ color: 'var(--muted)', marginBottom: 6 }}>Что редактировать</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button
                variant={draft.menuButtons.selectedTarget === 'departmentButtons' ? 'primary' : 'ghost'}
                onClick={() => patch((p) => ({ ...p, menuButtons: { ...p.menuButtons, selectedTarget: 'departmentButtons' } }))}
              >
                Кнопки отделов
              </Button>
              <Button
                variant={draft.menuButtons.selectedTarget === 'sectionButtons' ? 'primary' : 'ghost'}
                onClick={() => patch((p) => ({ ...p, menuButtons: { ...p.menuButtons, selectedTarget: 'sectionButtons' } }))}
              >
                Кнопки разделов
              </Button>
              <Button variant={draft.menuButtons.selectedTarget === 'listFont' ? 'primary' : 'ghost'} onClick={() => patch((p) => ({ ...p, menuButtons: { ...p.menuButtons, selectedTarget: 'listFont' } }))}>
                Шрифт списков
              </Button>
              <Button variant={draft.menuButtons.selectedTarget === 'cardFont' ? 'primary' : 'ghost'} onClick={() => patch((p) => ({ ...p, menuButtons: { ...p.menuButtons, selectedTarget: 'cardFont' } }))}>
                Шрифт карточек
              </Button>
            </div>
          </div>

          <div>
            <div style={{ color: 'var(--muted)', marginBottom: 6 }}>Режим кнопки</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button
                variant={draft.menuButtons.selectedButtonState === 'active' ? 'primary' : 'ghost'}
                disabled={!isButtonTarget(draft.menuButtons.selectedTarget)}
                onClick={() => patch((p) => ({ ...p, menuButtons: { ...p.menuButtons, selectedButtonState: 'active' as UiDisplayButtonState } }))}
              >
                Активная кнопка
              </Button>
              <Button
                variant={draft.menuButtons.selectedButtonState === 'inactive' ? 'primary' : 'ghost'}
                disabled={!isButtonTarget(draft.menuButtons.selectedTarget)}
                onClick={() => patch((p) => ({ ...p, menuButtons: { ...p.menuButtons, selectedButtonState: 'inactive' as UiDisplayButtonState } }))}
              >
                Неактивная кнопка
              </Button>
              {!isButtonTarget(draft.menuButtons.selectedTarget) && <span style={{ color: 'var(--muted)', fontSize: 12 }}>Для шрифтов режим кнопки не используется</span>}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 10, alignItems: 'center' }}>
            <div style={{ color: 'var(--muted)' }}>Размер шрифта (px)</div>
            <NumericPresetInput
              listId="ui-control-menu-font-size"
              value={
                isButtonTarget(draft.menuButtons.selectedTarget)
                  ? currentButtonStyle().fontSize
                  : draft.menuButtons.selectedTarget === 'listFont'
                    ? draft.lists.fontSize
                    : draft.cards.fontSize
              }
              presets={PRESET_FONT_SIZES}
              onValueChange={(next) => {
                if (isButtonTarget(draft.menuButtons.selectedTarget)) updateButtonStyleField('fontSize', next);
                else if (draft.menuButtons.selectedTarget === 'listFont') patch((p) => ({ ...p, lists: { ...p.lists, fontSize: next } }));
                else patch((p) => ({ ...p, cards: { ...p.cards, fontSize: next } }));
              }}
            />

            <div style={{ color: 'var(--muted)' }}>Ширина кнопки (px)</div>
            <NumericPresetInput
              listId="ui-control-menu-button-width"
              disabled={!isButtonTarget(draft.menuButtons.selectedTarget)}
              value={isButtonTarget(draft.menuButtons.selectedTarget) ? currentButtonStyle().width : 0}
              presets={PRESET_BUTTON_WIDTHS}
              onValueChange={(next) => updateButtonStyleField('width', next)}
            />

            <div style={{ color: 'var(--muted)' }}>Высота кнопки (px)</div>
            <NumericPresetInput
              listId="ui-control-menu-button-height"
              disabled={!isButtonTarget(draft.menuButtons.selectedTarget)}
              value={isButtonTarget(draft.menuButtons.selectedTarget) ? currentButtonStyle().height : 0}
              presets={PRESET_BUTTON_HEIGHTS}
              onValueChange={(next) => updateButtonStyleField('height', next)}
            />

            <div style={{ color: 'var(--muted)' }}>Отступ по горизонтали (px)</div>
            <NumericPresetInput
              listId="ui-control-menu-button-padding-x"
              disabled={!isButtonTarget(draft.menuButtons.selectedTarget)}
              value={isButtonTarget(draft.menuButtons.selectedTarget) ? currentButtonStyle().paddingX : 0}
              presets={PRESET_BUTTON_PADDING}
              onValueChange={(next) => updateButtonStyleField('paddingX', next)}
            />

            <div style={{ color: 'var(--muted)' }}>Отступ по вертикали (px)</div>
            <NumericPresetInput
              listId="ui-control-menu-button-padding-y"
              disabled={!isButtonTarget(draft.menuButtons.selectedTarget)}
              value={isButtonTarget(draft.menuButtons.selectedTarget) ? currentButtonStyle().paddingY : 0}
              presets={PRESET_BUTTON_PADDING}
              onValueChange={(next) => updateButtonStyleField('paddingY', next)}
            />

            <div style={{ color: 'var(--muted)' }}>Расстояние между кнопками (px)</div>
            <NumericPresetInput
              listId="ui-control-menu-button-gap"
              disabled={!isButtonTarget(draft.menuButtons.selectedTarget)}
              value={isButtonTarget(draft.menuButtons.selectedTarget) ? currentButtonStyle().gap : 0}
              presets={PRESET_SPACES}
              onValueChange={(next) => updateButtonStyleField('gap', next)}
            />
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Карточки / списки / справочники / прочее">
        <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 8 }}>
          Точные параметры, которые меняют плотность строк, шрифты таблиц и масштаб календаря.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))', gap: 8 }}>
          <label>
            Шрифт карточек (px)
            <NumericPresetInput
              listId="ui-control-cards-font-size"
              value={draft.cards.fontSize}
              presets={PRESET_FONT_SIZES}
              onValueChange={(next) => patch((p) => ({ ...p, cards: { ...p.cards, fontSize: next } }))}
            />
          </label>
          <label>
            Шрифт списков (px)
            <NumericPresetInput
              listId="ui-control-lists-font-size"
              value={draft.lists.fontSize}
              presets={PRESET_FONT_SIZES}
              onValueChange={(next) => patch((p) => ({ ...p, lists: { ...p.lists, fontSize: next } }))}
            />
          </label>
          <label>
            Шрифт таблиц справочников (px)
            <NumericPresetInput
              listId="ui-control-directories-table-font-size"
              value={draft.directories.tableFontSize}
              presets={PRESET_FONT_SIZES}
              onValueChange={(next) => patch((p) => ({ ...p, directories: { ...p.directories, tableFontSize: next } }))}
            />
          </label>
          <label>
            Ширина карточки по умолчанию (px)
            <NumericPresetInput
              listId="ui-control-directories-card-width"
              value={draft.directories.entityCardMinWidth}
              presets={PRESET_ENTITY_CARD_WIDTHS}
              onValueChange={(next) => patch((p) => ({ ...p, directories: { ...p.directories, entityCardMinWidth: next } }))}
            />
          </label>
          <label>
            Масштаб календаря
            <NumericPresetInput
              listId="ui-control-misc-datepicker-scale"
              value={draft.misc.datePickerScale}
              presets={PRESET_DATE_PICKER_SCALE}
              allowDecimal
              onValueChange={(next) => patch((p) => ({ ...p, misc: { ...p.misc, datePickerScale: next } }))}
            />
          </label>
          <label>
            Размер шрифта календаря (px)
            <NumericPresetInput
              listId="ui-control-misc-datepicker-font-size"
              value={draft.misc.datePickerFontSize}
              presets={PRESET_FONT_SIZES}
              onValueChange={(next) => patch((p) => ({ ...p, misc: { ...p.misc, datePickerFontSize: next } }))}
            />
          </label>
        </div>
      </SectionCard>

      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="ghost" onClick={resetToDefaults}>
          Сбросить настройки по-умолчанию
        </Button>
        <Button onClick={() => void save()} disabled={loading}>
          Сохранить {mode === 'global' ? 'глобальные настройки' : 'для пользователя'}
        </Button>
      </div>
    </div>
  );
}
