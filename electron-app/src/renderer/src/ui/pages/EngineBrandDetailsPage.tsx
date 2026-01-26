import React, { useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelectWithCreate } from '../components/SearchSelectWithCreate.js';
import { AttachmentsPanel } from '../components/AttachmentsPanel.js';

type PartOption = { id: string; label: string };

export function EngineBrandDetailsPage(props: {
  brandId: string;
  canEdit: boolean;
  canViewParts: boolean;
  canViewMasterData: boolean;
  onOpenPart: (partId: string) => void;
  canViewFiles: boolean;
  canUploadFiles: boolean;
}) {
  const [status, setStatus] = useState<string>('');
  const [name, setName] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [drawings, setDrawings] = useState<unknown>([]);
  const [techDocs, setTechDocs] = useState<unknown>([]);
  const [attachments, setAttachments] = useState<unknown>([]);
  const [partsOptions, setPartsOptions] = useState<PartOption[]>([]);
  const [engineBrandPartIds, setEngineBrandPartIds] = useState<string[]>([]);
  const [partsStatus, setPartsStatus] = useState<string>('');
  const [showAddPart, setShowAddPart] = useState(false);
  const [addPartId, setAddPartId] = useState<string | null>(null);

  const partLabelById = useMemo(() => new Map(partsOptions.map((p) => [p.id, p.label])), [partsOptions]);

  async function loadBrand() {
    try {
      setStatus('Загрузка…');
      const details = await window.matrica.admin.entities.get(props.brandId);
      const attrs = details?.attributes ?? {};
      setName(String(attrs.name ?? ''));
      setDescription(String(attrs.description ?? ''));
      setDrawings(attrs.drawings ?? []);
      setTechDocs(attrs.tech_docs ?? []);
      setAttachments(attrs.attachments ?? []);
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

  async function saveDescription() {
    if (!props.canEdit) return;
    try {
      setStatus('Сохранение…');
      await window.matrica.admin.entities.setAttr(props.brandId, 'description', description.trim() || null);
      setStatus('Сохранено');
      setTimeout(() => setStatus(''), 700);
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function saveFiles(code: 'drawings' | 'tech_docs' | 'attachments', value: unknown, setter: (v: unknown) => void) {
    if (!props.canEdit) return { ok: false as const, error: 'no permission' };
    try {
      const r = await window.matrica.admin.entities.setAttr(props.brandId, code, value);
      if (!r?.ok) return { ok: false as const, error: r?.error ?? 'save failed' };
      setter(value);
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: String(e) };
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

  function sortParts(ids: string[]) {
    const label = (id: string) => partLabelById.get(id) ?? id;
    const next = [...ids];
    next.sort((a, b) => label(a).localeCompare(label(b), 'ru'));
    return next;
  }

  async function addPart(partId: string) {
    if (!partId) return;
    if (engineBrandPartIds.includes(partId)) {
      setAddPartId(null);
      setShowAddPart(false);
      return;
    }
    const next = sortParts([...engineBrandPartIds, partId]);
    setEngineBrandPartIds(next);
    setAddPartId(null);
    setShowAddPart(false);
    await updateBrandParts(next);
  }

  async function createAndAddPart(label: string) {
    if (!props.canEdit) return null;
    const name = label.trim();
    if (!name) return null;
    setPartsStatus('Создание детали...');
    try {
      const created = await window.matrica.parts.create({ attributes: { name } });
      if (!created?.ok || !created.part?.id) {
        setPartsStatus(`Ошибка: ${created?.error ?? 'Не удалось создать деталь'}`);
        return null;
      }
      const id = String(created.part.id);
      if (!partsOptions.some((o) => o.id === id)) {
        const nextOpts = [...partsOptions, { id, label: name }];
        nextOpts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
        setPartsOptions(nextOpts);
      }
      await addPart(id);
      setPartsStatus('');
      return id;
    } catch (e) {
      setPartsStatus(`Ошибка: ${String(e)}`);
      return null;
    }
  }

  useEffect(() => {
    if (!props.canViewMasterData) return;
    void loadBrand();
    void loadPartsOptions();
    void loadBrandParts();
  }, [props.brandId, props.canViewMasterData, props.canViewParts]);

  const selectedParts = engineBrandPartIds.map((id) => ({
    id,
    label: partLabelById.get(id) ?? id,
  }));
  const headerTitle = name.trim() ? `Марка двигателя: ${name.trim()}` : 'Марка двигателя';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', paddingBottom: 8, borderBottom: '1px solid #e5e7eb' }}>
        <div style={{ fontSize: 20, fontWeight: 800 }}>{headerTitle}</div>
        <div style={{ flex: 1 }} />
        <Button variant="ghost" onClick={() => void loadBrand()}>
          Обновить
        </Button>
      </div>

      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', paddingTop: 12 }}>
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 200px) 1fr', gap: 10 }}>
          <div style={{ color: '#6b7280' }}>Название</div>
          <Input
            value={name}
            disabled={!props.canEdit}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void saveName()}
          />
          <div style={{ color: '#6b7280', alignSelf: 'start', paddingTop: 6 }}>Описание</div>
          <textarea
            value={description}
            disabled={!props.canEdit}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => void saveDescription()}
            rows={3}
            style={{
              width: '100%',
              padding: '8px 10px',
              borderRadius: 10,
              border: '1px solid var(--input-border)',
              background: props.canEdit ? 'var(--input-bg)' : 'var(--input-bg-disabled)',
              color: 'var(--text)',
              fontSize: 14,
              lineHeight: 1.4,
              resize: 'vertical',
            }}
          />
        </div>
      </div>

      <div style={{ marginTop: 14, border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <div style={{ fontWeight: 600 }}>Детали для марки</div>
          <div style={{ flex: 1 }} />
          {props.canEdit && props.canViewParts && (
            <Button variant="ghost" onClick={() => setShowAddPart((v) => !v)}>
              + Добавить деталь
            </Button>
          )}
        </div>

        {showAddPart && props.canViewParts && (
          <div style={{ marginBottom: 10 }}>
            <SearchSelectWithCreate
              value={addPartId}
              options={partsOptions}
              disabled={!props.canEdit}
              canCreate={props.canEdit}
              createLabel="Добавить новую деталь"
              onChange={(next) => {
                setAddPartId(next);
                if (next) void addPart(next);
              }}
              onCreate={async (label) => await createAndAddPart(label)}
            />
          </div>
        )}

        {selectedParts.length === 0 ? (
          <div style={{ color: '#6b7280', fontSize: 13 }}>Детали не добавлены.</div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {selectedParts.map((p) => (
              <div
                key={p.id}
                onClick={() => props.onOpenPart(p.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 10px',
                  borderRadius: 10,
                  border: '1px solid #e5e7eb',
                  background: '#fff',
                  cursor: props.canViewParts ? 'pointer' : 'default',
                }}
              >
                <div style={{ fontWeight: 600 }}>{p.label}</div>
                <div style={{ flex: 1 }} />
                <Button
                  variant="ghost"
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onOpenPart(p.id);
                  }}
                  disabled={!props.canViewParts}
                >
                  Открыть
                </Button>
                <Button
                  variant="ghost"
                  onClick={(event) => {
                    event.stopPropagation();
                    void updateBrandParts(engineBrandPartIds.filter((id) => id !== p.id));
                  }}
                  disabled={!props.canEdit}
                  style={{ color: '#b91c1c' }}
                >
                  Убрать
                </Button>
              </div>
            ))}
          </div>
        )}

        {partsStatus && <div style={{ marginTop: 8, color: '#6b7280', fontSize: 12 }}>{partsStatus}</div>}
      </div>

      <AttachmentsPanel
        title="Чертежи"
        value={drawings}
        canView={props.canViewFiles}
        canUpload={props.canUploadFiles && props.canEdit}
        scope={{ ownerType: 'engine_brand', ownerId: props.brandId, category: 'drawings' }}
        onChange={(next) => saveFiles('drawings', next, setDrawings)}
      />
      <AttachmentsPanel
        title="Документы"
        value={techDocs}
        canView={props.canViewFiles}
        canUpload={props.canUploadFiles && props.canEdit}
        scope={{ ownerType: 'engine_brand', ownerId: props.brandId, category: 'tech_docs' }}
        onChange={(next) => saveFiles('tech_docs', next, setTechDocs)}
      />
      <AttachmentsPanel
        title="Вложения (прочее)"
        value={attachments}
        canView={props.canViewFiles}
        canUpload={props.canUploadFiles && props.canEdit}
        scope={{ ownerType: 'engine_brand', ownerId: props.brandId, category: 'attachments' }}
        onChange={(next) => saveFiles('attachments', next, setAttachments)}
      />

      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}
      </div>
    </div>
  );
}
