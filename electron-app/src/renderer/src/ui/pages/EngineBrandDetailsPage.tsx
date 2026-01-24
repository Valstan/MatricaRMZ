import React, { useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { MultiSearchSelect } from '../components/MultiSearchSelect.js';

type PartOption = { id: string; label: string };

export function EngineBrandDetailsPage(props: {
  brandId: string;
  canEdit: boolean;
  canViewParts: boolean;
  canViewMasterData: boolean;
}) {
  const [status, setStatus] = useState<string>('');
  const [name, setName] = useState<string>('');
  const [partsOptions, setPartsOptions] = useState<PartOption[]>([]);
  const [engineBrandPartIds, setEngineBrandPartIds] = useState<string[]>([]);
  const [partsStatus, setPartsStatus] = useState<string>('');

  const partLabelById = useMemo(() => new Map(partsOptions.map((p) => [p.id, p.label])), [partsOptions]);

  async function loadBrand() {
    try {
      setStatus('Загрузка…');
      const details = await window.matrica.admin.entities.get(props.brandId);
      const attrs = details?.attributes ?? {};
      setName(String(attrs.name ?? ''));
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function loadPartsOptions() {
    if (!props.canViewParts) return;
    setPartsStatus('Загрузка списка деталей...');
    const r = await window.matrica.parts.list({ limit: 5000 }).catch((e) => ({ ok: false as const, error: String(e) }));
    if (!r.ok) {
      setPartsOptions([]);
      setPartsStatus(`Ошибка: ${r.error ?? 'unknown'}`);
      return;
    }
    const opts = r.parts.map((p) => ({
      id: String(p.id),
      label: String(p.name ?? p.article ?? p.id),
    }));
    opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    setPartsOptions(opts);
    setPartsStatus('');
  }

  async function loadBrandParts() {
    if (!props.canViewParts) return;
    const r = await window.matrica.parts.list({ engineBrandId: props.brandId, limit: 5000 }).catch((e) => ({ ok: false as const, error: String(e) }));
    if (!r.ok) {
      setEngineBrandPartIds([]);
      setPartsStatus(`Ошибка: ${r.error ?? 'unknown'}`);
      return;
    }
    setEngineBrandPartIds(r.parts.map((p) => String(p.id)));
  }

  async function saveName() {
    if (!props.canEdit) return;
    try {
      setStatus('Сохранение…');
      await window.matrica.admin.entities.setAttr(props.brandId, 'name', name.trim());
      setStatus('Сохранено');
      setTimeout(() => setStatus(''), 700);
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function updateBrandParts(nextIds: string[]) {
    if (!props.canEdit) return;
    const prev = new Set(engineBrandPartIds);
    const next = new Set(nextIds);
    const toAdd = nextIds.filter((id) => !prev.has(id));
    const toRemove = engineBrandPartIds.filter((id) => !next.has(id));
    setPartsStatus('Сохранение связей...');
    try {
      for (const partId of toAdd) {
        const pr = await window.matrica.parts.get(partId);
        if (!pr.ok) throw new Error(pr.error ?? 'Не удалось загрузить деталь');
        const attr = pr.part.attributes.find((a: any) => a.code === 'engine_brand_ids');
        const current = Array.isArray(attr?.value) ? attr.value.filter((x: any): x is string => typeof x === 'string') : [];
        if (current.includes(props.brandId)) continue;
        const updated = [...current, props.brandId];
        const upd = await window.matrica.parts.updateAttribute({ partId, attributeCode: 'engine_brand_ids', value: updated });
        if (!upd.ok) throw new Error(upd.error ?? 'Не удалось сохранить связь');
      }

      for (const partId of toRemove) {
        const pr = await window.matrica.parts.get(partId);
        if (!pr.ok) throw new Error(pr.error ?? 'Не удалось загрузить деталь');
        const attr = pr.part.attributes.find((a: any) => a.code === 'engine_brand_ids');
        const current = Array.isArray(attr?.value) ? attr.value.filter((x: any): x is string => typeof x === 'string') : [];
        if (!current.includes(props.brandId)) continue;
        const updated = current.filter((id) => id !== props.brandId);
        const upd = await window.matrica.parts.updateAttribute({ partId, attributeCode: 'engine_brand_ids', value: updated });
        if (!upd.ok) throw new Error(upd.error ?? 'Не удалось сохранить связь');
      }

      setEngineBrandPartIds(nextIds);
      setPartsStatus('Сохранено');
      setTimeout(() => setPartsStatus(''), 900);
    } catch (e) {
      const msg = String(e);
      setPartsStatus(`Ошибка: ${msg}`);
      window.matrica?.log?.send?.('error', `engine_brand_parts update failed: ${msg}`).catch(() => {});
    }
  }

  useEffect(() => {
    if (!props.canViewMasterData) return;
    void loadBrand();
    void loadPartsOptions();
    void loadBrandParts();
  }, [props.brandId, props.canViewMasterData, props.canViewParts]);

  const selectedPartLabels = engineBrandPartIds.map((id) => partLabelById.get(id) ?? id).filter(Boolean);

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
        <strong style={{ fontSize: 18 }}>Марка двигателя</strong>
        <div style={{ flex: 1 }} />
        <Button variant="ghost" onClick={() => void loadBrand()}>
          Обновить
        </Button>
      </div>

      <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 200px) 1fr', gap: 10 }}>
          <div style={{ color: '#6b7280' }}>Название</div>
          <Input
            value={name}
            disabled={!props.canEdit}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void saveName()}
          />
        </div>
      </div>

      <div style={{ marginTop: 14, border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Детали для марки</div>
        <MultiSearchSelect
          value={engineBrandPartIds}
          options={partsOptions}
          disabled={!props.canEdit || !props.canViewParts}
          onChange={(next) => {
            setEngineBrandPartIds(next);
            void updateBrandParts(next);
          }}
          placeholder="Выберите детали из справочника"
        />
        {selectedPartLabels.length > 0 && (
          <div style={{ marginTop: 8, color: '#6b7280', fontSize: 12 }}>
            Выбрано: {selectedPartLabels.join(', ')}
          </div>
        )}
        {partsStatus && <div style={{ marginTop: 8, color: '#6b7280', fontSize: 12 }}>{partsStatus}</div>}
      </div>

      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}
    </div>
  );
}
