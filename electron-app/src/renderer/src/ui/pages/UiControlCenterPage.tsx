import React, { useEffect, useMemo, useState } from 'react';
import type { UiControlSettings } from '@matricarmz/shared';
import { DEFAULT_UI_CONTROL_SETTINGS, sanitizeUiControlSettings } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
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

  function applyPreview() {
    props.onApplyEffective(draft);
    setStatus('Предпросмотр применён локально');
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
      <SectionCard title="UI Control Center">
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
          <span style={{ color: 'var(--muted)' }}>Версия global defaults: {uiDefaultsVersion}</span>
        </div>
        {status ? <div style={{ marginTop: 8, color: 'var(--muted)' }}>{status}</div> : null}
      </SectionCard>

      <SectionCard title="Глобальные">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(120px, 1fr))', gap: 8 }}>
          <label>Title<input type="number" value={draft.global.titleFontSize} onChange={(e) => patch((p) => ({ ...p, global: { ...p.global, titleFontSize: Number(e.target.value) } }))} /></label>
          <label>Section<input type="number" value={draft.global.sectionFontSize} onChange={(e) => patch((p) => ({ ...p, global: { ...p.global, sectionFontSize: Number(e.target.value) } }))} /></label>
          <label>Body<input type="number" value={draft.global.bodyFontSize} onChange={(e) => patch((p) => ({ ...p, global: { ...p.global, bodyFontSize: Number(e.target.value) } }))} /></label>
          <label>Muted<input type="number" value={draft.global.mutedFontSize} onChange={(e) => patch((p) => ({ ...p, global: { ...p.global, mutedFontSize: Number(e.target.value) } }))} /></label>
          <label>Space4<input type="number" value={draft.global.space4} onChange={(e) => patch((p) => ({ ...p, global: { ...p.global, space4: Number(e.target.value) } }))} /></label>
        </div>
      </SectionCard>

      <SectionCard title="Кнопки меню">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(120px, 1fr))', gap: 8 }}>
          <label>Dept font<input type="number" value={draft.menuButtons.departmentButtons.active.fontSize} onChange={(e) => patch((p) => ({ ...p, menuButtons: { ...p.menuButtons, departmentButtons: { ...p.menuButtons.departmentButtons, active: { ...p.menuButtons.departmentButtons.active, fontSize: Number(e.target.value) } } } }))} /></label>
          <label>Dept width<input type="number" value={draft.menuButtons.departmentButtons.active.width} onChange={(e) => patch((p) => ({ ...p, menuButtons: { ...p.menuButtons, departmentButtons: { ...p.menuButtons.departmentButtons, active: { ...p.menuButtons.departmentButtons.active, width: Number(e.target.value) } } } }))} /></label>
          <label>Section font<input type="number" value={draft.menuButtons.sectionButtons.active.fontSize} onChange={(e) => patch((p) => ({ ...p, menuButtons: { ...p.menuButtons, sectionButtons: { ...p.menuButtons.sectionButtons, active: { ...p.menuButtons.sectionButtons.active, fontSize: Number(e.target.value) } } } }))} /></label>
          <label>Section gap<input type="number" value={draft.menuButtons.sectionButtons.active.gap} onChange={(e) => patch((p) => ({ ...p, menuButtons: { ...p.menuButtons, sectionButtons: { ...p.menuButtons.sectionButtons, active: { ...p.menuButtons.sectionButtons.active, gap: Number(e.target.value) } } } }))} /></label>
        </div>
      </SectionCard>

      <SectionCard title="Карточки / списки / справочники / прочее">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(120px, 1fr))', gap: 8 }}>
          <label>Card font<input type="number" value={draft.cards.fontSize} onChange={(e) => patch((p) => ({ ...p, cards: { ...p.cards, fontSize: Number(e.target.value) } }))} /></label>
          <label>List font<input type="number" value={draft.lists.fontSize} onChange={(e) => patch((p) => ({ ...p, lists: { ...p.lists, fontSize: Number(e.target.value) } }))} /></label>
          <label>Table font<input type="number" value={draft.directories.tableFontSize} onChange={(e) => patch((p) => ({ ...p, directories: { ...p.directories, tableFontSize: Number(e.target.value) } }))} /></label>
          <label>Datepicker scale<input type="number" step="0.1" value={draft.misc.datePickerScale} onChange={(e) => patch((p) => ({ ...p, misc: { ...p.misc, datePickerScale: Number(e.target.value) } }))} /></label>
        </div>
      </SectionCard>

      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="ghost" onClick={applyPreview}>
          Предпросмотр
        </Button>
        <Button onClick={() => void save()} disabled={loading}>
          Сохранить {mode === 'global' ? 'глобально' : 'для пользователя'}
        </Button>
      </div>
    </div>
  );
}
