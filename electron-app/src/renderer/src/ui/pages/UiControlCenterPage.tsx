import React, { useEffect, useMemo, useState } from 'react';
import type { UiControlSettings, UiDisplayButtonState, UiDisplayButtonStyle, UiDisplayTarget } from '@matricarmz/shared';
import { DEFAULT_UI_CONTROL_SETTINGS, sanitizeUiControlSettings } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SectionCard } from '../components/SectionCard.js';

type Mode = 'global' | 'user';

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

  const editTarget = useMemo(() => (mode === 'global' ? globalDefaults : userSettings ?? effective), [effective, globalDefaults, mode, userSettings]);

  useEffect(() => {
    setDraft(sanitizeUiControlSettings(editTarget));
  }, [editTarget]);

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

  function applyPreview() {
    props.onApplyEffective(draft);
    setStatus('Предпросмотр применён локально');
  }

  function resetToDefaults() {
    const next = mode === 'global' ? DEFAULT_UI_CONTROL_SETTINGS : globalDefaults;
    setDraft(sanitizeUiControlSettings(next));
    props.onApplyEffective(next);
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
      setGlobalDefaults(sanitizeUiControlSettings(res.globalDefaults ?? draft));
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
            <Input type="number" value={draft.global.titleFontSize} onChange={(e) => patch((p) => ({ ...p, global: { ...p.global, titleFontSize: Number(e.target.value) } }))} />
          </label>
          <label>
            Размер заголовков секций (px)
            <Input type="number" value={draft.global.sectionFontSize} onChange={(e) => patch((p) => ({ ...p, global: { ...p.global, sectionFontSize: Number(e.target.value) } }))} />
          </label>
          <label>
            Размер основного текста (px)
            <Input type="number" value={draft.global.bodyFontSize} onChange={(e) => patch((p) => ({ ...p, global: { ...p.global, bodyFontSize: Number(e.target.value) } }))} />
          </label>
          <label>
            Размер вторичного текста (px)
            <Input type="number" value={draft.global.mutedFontSize} onChange={(e) => patch((p) => ({ ...p, global: { ...p.global, mutedFontSize: Number(e.target.value) } }))} />
          </label>
          <label>
            Базовый отступ уровня 4 (px)
            <Input type="number" value={draft.global.space4} onChange={(e) => patch((p) => ({ ...p, global: { ...p.global, space4: Number(e.target.value) } }))} />
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
            <Input
              type="number"
              value={
                isButtonTarget(draft.menuButtons.selectedTarget)
                  ? currentButtonStyle().fontSize
                  : draft.menuButtons.selectedTarget === 'listFont'
                    ? draft.lists.fontSize
                    : draft.cards.fontSize
              }
              onChange={(e) => {
                const next = Number(e.target.value);
                if (isButtonTarget(draft.menuButtons.selectedTarget)) updateButtonStyleField('fontSize', next);
                else if (draft.menuButtons.selectedTarget === 'listFont') patch((p) => ({ ...p, lists: { ...p.lists, fontSize: next } }));
                else patch((p) => ({ ...p, cards: { ...p.cards, fontSize: next } }));
              }}
            />

            <div style={{ color: 'var(--muted)' }}>Ширина кнопки (px)</div>
            <Input type="number" disabled={!isButtonTarget(draft.menuButtons.selectedTarget)} value={isButtonTarget(draft.menuButtons.selectedTarget) ? currentButtonStyle().width : 0} onChange={(e) => updateButtonStyleField('width', Number(e.target.value))} />

            <div style={{ color: 'var(--muted)' }}>Высота кнопки (px)</div>
            <Input type="number" disabled={!isButtonTarget(draft.menuButtons.selectedTarget)} value={isButtonTarget(draft.menuButtons.selectedTarget) ? currentButtonStyle().height : 0} onChange={(e) => updateButtonStyleField('height', Number(e.target.value))} />

            <div style={{ color: 'var(--muted)' }}>Отступ по горизонтали (px)</div>
            <Input type="number" disabled={!isButtonTarget(draft.menuButtons.selectedTarget)} value={isButtonTarget(draft.menuButtons.selectedTarget) ? currentButtonStyle().paddingX : 0} onChange={(e) => updateButtonStyleField('paddingX', Number(e.target.value))} />

            <div style={{ color: 'var(--muted)' }}>Отступ по вертикали (px)</div>
            <Input type="number" disabled={!isButtonTarget(draft.menuButtons.selectedTarget)} value={isButtonTarget(draft.menuButtons.selectedTarget) ? currentButtonStyle().paddingY : 0} onChange={(e) => updateButtonStyleField('paddingY', Number(e.target.value))} />

            <div style={{ color: 'var(--muted)' }}>Расстояние между кнопками (px)</div>
            <Input type="number" disabled={!isButtonTarget(draft.menuButtons.selectedTarget)} value={isButtonTarget(draft.menuButtons.selectedTarget) ? currentButtonStyle().gap : 0} onChange={(e) => updateButtonStyleField('gap', Number(e.target.value))} />
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
            <Input type="number" value={draft.cards.fontSize} onChange={(e) => patch((p) => ({ ...p, cards: { ...p.cards, fontSize: Number(e.target.value) } }))} />
          </label>
          <label>
            Шрифт списков (px)
            <Input type="number" value={draft.lists.fontSize} onChange={(e) => patch((p) => ({ ...p, lists: { ...p.lists, fontSize: Number(e.target.value) } }))} />
          </label>
          <label>
            Шрифт таблиц справочников (px)
            <Input type="number" value={draft.directories.tableFontSize} onChange={(e) => patch((p) => ({ ...p, directories: { ...p.directories, tableFontSize: Number(e.target.value) } }))} />
          </label>
          <label>
            Ширина карточки по умолчанию (px)
            <Input type="number" value={draft.directories.entityCardMinWidth} onChange={(e) => patch((p) => ({ ...p, directories: { ...p.directories, entityCardMinWidth: Number(e.target.value) } }))} />
          </label>
          <label>
            Масштаб календаря
            <Input type="number" step="0.1" value={draft.misc.datePickerScale} onChange={(e) => patch((p) => ({ ...p, misc: { ...p.misc, datePickerScale: Number(e.target.value) } }))} />
          </label>
          <label>
            Размер шрифта календаря (px)
            <Input type="number" value={draft.misc.datePickerFontSize} onChange={(e) => patch((p) => ({ ...p, misc: { ...p.misc, datePickerFontSize: Number(e.target.value) } }))} />
          </label>
        </div>
      </SectionCard>

      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="ghost" onClick={applyPreview}>
          Предпросмотр
        </Button>
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
