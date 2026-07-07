import React, { useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { MultiSearchSelect, type MultiSearchSelectOption } from '../components/MultiSearchSelect.js';
import { parseIdArray } from '../utils/groupBrandIds.js';
import { loadAllGroupMembers, reexpandPartsForGroup } from '../utils/liveGroupSync.js';

export function EngineBrandGroupDetailsPage(props: {
  groupId: string;
  onClose: () => void;
  canEdit: boolean;
  canViewMasterData: boolean;
}) {
  const [typeId, setTypeId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [brandIds, setBrandIds] = useState<string[]>([]);
  const [brandOptions, setBrandOptions] = useState<MultiSearchSelectOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const types = (await window.matrica.admin.entityTypes.list()) as Array<{ id: string; code: string }>;
        const gt = types.find((t) => String(t.code) === 'engine_brand_group');
        const eb = types.find((t) => String(t.code) === 'engine_brand');
        if (!alive) return;
        if (gt?.id) setTypeId(gt.id);
        if (eb?.id) {
          const brands = (await window.matrica.admin.entities.listByEntityType(eb.id)) as Array<{ id: string; displayName?: string }>;
          if (!alive) return;
          setBrandOptions(
            brands
              .map((b) => ({ id: String(b.id), label: String(b.displayName ?? '').trim() || String(b.id) }))
              .sort((a, b) => a.label.localeCompare(b.label, 'ru')),
          );
        }
        const det = await window.matrica.admin.entities.get(props.groupId, gt?.id).catch(() => null);
        if (!alive) return;
        const attrs = (det as { attributes?: Record<string, unknown> } | null)?.attributes ?? {};
        setName(String(attrs.name ?? '').trim());
        setDescription(String(attrs.description ?? '').trim());
        setBrandIds(parseIdArray(attrs.engine_brand_ids));
        setDirty(false);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [props.groupId]);

  const selectedCount = brandIds.length;
  const brandNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of brandOptions) m.set(o.id, o.label);
    return m;
  }, [brandOptions]);

  async function save(thenClose: boolean) {
    if (!props.canEdit) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setStatus('Ошибка: укажите название группы.');
      return;
    }
    setSaving(true);
    setStatus('Сохранение...');
    try {
      const r1 = await window.matrica.admin.entities.setAttr(props.groupId, 'name', trimmedName, typeId ?? undefined);
      if (!r1?.ok) throw new Error(String(r1?.error ?? 'name'));
      await window.matrica.admin.entities.setAttr(props.groupId, 'description', description.trim() || null, typeId ?? undefined);
      await window.matrica.admin.entities.setAttr(
        props.groupId,
        'engine_brand_ids',
        brandIds.length > 0 ? brandIds : null,
        typeId ?? undefined,
      );
      setDirty(false);
      // Живая связь: пересобрать brandLinks деталей, следящих за этой группой (марки,
      // добавленные/убранные сейчас, применяются/снимаются автоматически). Best-effort —
      // не валим сохранение группы; при неудаче деталь починится при следующем открытии (self-heal).
      try {
        setStatus('Сохранено. Пересборка связей деталей...');
        const gm = await loadAllGroupMembers();
        const res = await reexpandPartsForGroup(props.groupId, gm);
        setStatus(res.changed > 0 ? `Сохранено. Обновлено деталей: ${res.changed}.` : 'Сохранено.');
      } catch {
        setStatus('Сохранено (связи деталей обновятся при следующем открытии).');
      }
      if (thenClose) {
        props.onClose();
        return;
      }
      setTimeout(() => setStatus(''), 2500);
    } catch (e) {
      setStatus(`Ошибка сохранения: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  if (!props.canViewMasterData) {
    return <div style={{ color: 'var(--subtle)' }}>Недостаточно прав для просмотра групп марок.</div>;
  }
  if (loading) {
    return <div style={{ padding: 16, color: 'var(--subtle)' }}>Загрузка группы...</div>;
  }

  const disabled = !props.canEdit;

  return (
    <div className="ui-content-viewport" style={{ height: '100%', overflow: 'auto' }}>
      <div className="entity-card-shell" style={{ padding: 12 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          <Button onClick={() => void save(false)} disabled={disabled || saving}>
            Сохранить
          </Button>
          <Button onClick={() => void save(true)} disabled={disabled || saving}>
            Сохранить и выйти
          </Button>
          <Button variant="ghost" onClick={props.onClose}>
            Закрыть {dirty ? '(без сохранения)' : ''}
          </Button>
          {status ? (
            <span style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)', fontSize: 12 }}>{status}</span>
          ) : null}
        </div>

        <h2 style={{ margin: '0 0 12px' }}>Группа марок: {name.trim() || '(без названия)'}</h2>

        <div className="card-panel" style={{ display: 'grid', gap: 12, maxWidth: 900 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 10, alignItems: 'start' }}>
            <div style={{ color: 'var(--muted)', paddingTop: 6 }}>Название</div>
            <Input
              value={name}
              disabled={disabled}
              placeholder="Например: 59-е (В-59, В-59 УМС)"
              data-autogrow="off"
              onChange={(e) => {
                setDirty(true);
                setName(e.target.value);
              }}
            />

            <div style={{ color: 'var(--muted)', paddingTop: 6 }}>Описание характеристик</div>
            <textarea
              value={description}
              disabled={disabled}
              placeholder="Чем объединены марки (для удобства использования)"
              onChange={(e) => {
                setDirty(true);
                setDescription(e.target.value);
              }}
              style={{
                minHeight: 60,
                padding: '6px 8px',
                borderRadius: 'var(--ui-radius-sm)',
                border: '1px solid var(--input-border)',
                background: disabled ? 'var(--input-bg-disabled)' : 'var(--input-bg)',
                color: 'var(--text)',
                fontFamily: 'inherit',
                fontSize: 'var(--ui-input-font-size, 13px)',
                resize: 'vertical',
              }}
            />

            <div style={{ color: 'var(--muted)', paddingTop: 6 }}>
              Марки двигателей
              <div style={{ fontSize: 11, color: 'var(--subtle)', marginTop: 2 }}>Выбрано: {selectedCount}</div>
            </div>
            <MultiSearchSelect
              values={brandIds}
              options={brandOptions}
              disabled={disabled}
              placeholder="Добавить марки двигателей в группу..."
              onChange={(next) => {
                setDirty(true);
                setBrandIds(next);
              }}
            />
          </div>

          {selectedCount > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {brandIds.map((id) => (
                <span
                  key={id}
                  style={{
                    fontSize: 12,
                    padding: '2px 8px',
                    borderRadius: 10,
                    background: 'var(--card-row-bg)',
                    border: '1px solid var(--card-row-border)',
                    color: 'var(--text)',
                  }}
                >
                  {brandNameById.get(id) ?? id}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
