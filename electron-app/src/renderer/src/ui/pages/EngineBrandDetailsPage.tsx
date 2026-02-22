import React, { useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelectWithCreate } from '../components/SearchSelectWithCreate.js';
import { SectionCard } from '../components/SectionCard.js';
import { AttachmentsPanel } from '../components/AttachmentsPanel.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';

type PartOption = { id: string; label: string };
type BrandPartRow = { id: string; label: string; assemblyUnitNumber: string; quantity: number };

export function EngineBrandDetailsPage(props: {
  brandId: string;
  canEdit: boolean;
  canViewParts: boolean;
  canCreateParts: boolean;
  canEditParts: boolean;
  canViewMasterData: boolean;
  onOpenPart: (partId: string) => void;
  canViewFiles: boolean;
  canUploadFiles: boolean;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<string>('');
  const [name, setName] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [drawings, setDrawings] = useState<unknown>([]);
  const [techDocs, setTechDocs] = useState<unknown>([]);
  const [attachments, setAttachments] = useState<unknown>([]);
  const [partsOptions, setPartsOptions] = useState<PartOption[]>([]);
  const [brandParts, setBrandParts] = useState<BrandPartRow[]>([]);
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
      setBrandParts([]);
      setPartsStatus(`Ошибка: ${r.error ?? 'unknown'}`);
      return;
    }
    const rows = r.parts
      .map((p: any) => {
        const qtyNum = Number(p.engineBrandQty ?? 0);
        return {
          id: String(p.id),
          label: String(p.name ?? p.article ?? p.id),
          assemblyUnitNumber: String(p.assemblyUnitNumber ?? ''),
          quantity: Number.isFinite(qtyNum) && qtyNum > 0 ? qtyNum : 0,
        } satisfies BrandPartRow;
      })
      .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    setBrandParts(rows);
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

  async function saveAllAndClose() {
    if (!props.canEdit) {
      props.onClose();
      return;
    }
    await saveName();
    await saveDescription();
    props.onClose();
  }

  async function handleDelete() {
    if (!props.canEdit) return;
    if (!confirm('Удалить марку двигателя?')) return;
    try {
      setStatus('Удаление…');
      const r = await window.matrica.admin.entities.softDelete(props.brandId);
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error ?? 'unknown'}`);
        return;
      }
      setStatus('Удалено');
      setTimeout(() => setStatus(''), 900);
      props.onClose();
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

  async function updateBrandPartQty(partId: string, quantity: number) {
    if (!props.canEdit || !props.canEditParts) return;
    const safeQty = Math.max(0, Math.floor(Number(quantity) || 0));
    try {
      const pr = await window.matrica.parts.get(partId);
      if (!pr.ok) throw new Error(pr.error ?? 'Не удалось загрузить деталь');
      const attr = pr.part.attributes.find((a: any) => a.code === 'engine_brand_qty_map');
      const currentRaw = attr?.value;
      const currentMap: Record<string, number> =
        currentRaw && typeof currentRaw === 'object' && !Array.isArray(currentRaw)
          ? Object.fromEntries(
              Object.entries(currentRaw as Record<string, unknown>)
                .map(([k, v]) => [String(k), Number(v)] as [string, number])
                .filter((entry): entry is [string, number] => Number.isFinite(entry[1]) && entry[1] >= 0),
            )
          : {};
      currentMap[props.brandId] = safeQty;
      const upd = await window.matrica.parts.updateAttribute({
        partId,
        attributeCode: 'engine_brand_qty_map',
        value: currentMap,
      });
      if (!upd.ok) throw new Error(upd.error ?? 'Не удалось сохранить количество');
    } catch (e) {
      setPartsStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function clearBrandPartQty(partId: string) {
    if (!props.canEdit || !props.canEditParts) return;
    try {
      const pr = await window.matrica.parts.get(partId);
      if (!pr.ok) return;
      const attr = pr.part.attributes.find((a: any) => a.code === 'engine_brand_qty_map');
      const currentRaw = attr?.value;
      const currentMap: Record<string, number> =
        currentRaw && typeof currentRaw === 'object' && !Array.isArray(currentRaw)
          ? Object.fromEntries(
              Object.entries(currentRaw as Record<string, unknown>)
                .map(([k, v]) => [String(k), Number(v)] as [string, number])
                .filter((entry): entry is [string, number] => Number.isFinite(entry[1]) && entry[1] >= 0),
            )
          : {};
      if (!(props.brandId in currentMap)) return;
      delete currentMap[props.brandId];
      const upd = await window.matrica.parts.updateAttribute({
        partId,
        attributeCode: 'engine_brand_qty_map',
        value: currentMap,
      });
      if (!upd.ok) throw new Error(upd.error ?? 'Не удалось очистить количество');
    } catch {
      // best effort
    }
  }

  async function updateBrandParts(nextIds: string[]) {
    if (!props.canEdit || !props.canEditParts) return;
    const prev = new Set(brandParts.map((p) => p.id));
    const next = new Set(nextIds);
    const toAdd = nextIds.filter((id) => !prev.has(id));
    const toRemove = brandParts.map((p) => p.id).filter((id) => !next.has(id));
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
        await clearBrandPartQty(partId);
      }

      setBrandParts((prevRows) => {
        const byId = new Map(prevRows.map((r) => [r.id, r]));
        const rows = nextIds.map((id) => {
          const row = byId.get(id);
          if (row) return row;
          return {
            id,
            label: partLabelById.get(id) ?? id,
            assemblyUnitNumber: '',
            quantity: 0,
          } satisfies BrandPartRow;
        });
        rows.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
        return rows;
      });
      setPartsStatus('Сохранено');
      setTimeout(() => setPartsStatus(''), 900);
    } catch (e) {
      const msg = String(e);
      setPartsStatus(`Ошибка: ${msg}`);
      window.matrica?.log?.send?.('error', `engine_brand_parts update failed: ${msg}`).catch(() => {});
    }
  }

  function sortParts(ids: string[]) {
    const label = (id: string) => brandParts.find((p) => p.id === id)?.label ?? partLabelById.get(id) ?? id;
    const next = [...ids];
    next.sort((a, b) => label(a).localeCompare(label(b), 'ru'));
    return next;
  }

  async function addPart(partId: string) {
    if (!partId) return;
    if (!props.canEdit || !props.canEditParts) return;
    if (brandParts.some((p) => p.id === partId)) {
      setAddPartId(null);
      setShowAddPart(false);
      return;
    }
    const next = sortParts([...brandParts.map((p) => p.id), partId]);
    setBrandParts((prev) => {
      const nextRows = [...prev, { id: partId, label: partLabelById.get(partId) ?? partId, assemblyUnitNumber: '', quantity: 1 }];
      nextRows.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      return nextRows;
    });
    setAddPartId(null);
    setShowAddPart(false);
    await updateBrandParts(next);
    await updateBrandPartQty(partId, 1);
  }

  async function createAndAddPart(label: string) {
    if (!props.canEdit || !props.canCreateParts) return null;
    const name = label.trim();
    if (!name) return null;
    setPartsStatus('Создание детали...');
    try {
      const created = await window.matrica.parts.create({ attributes: { name } });
      if (!created?.ok || !created.part?.id) {
        setPartsStatus(`Ошибка: ${(created as any)?.error ?? 'Не удалось создать деталь'}`);
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

  useLiveDataRefresh(
    async () => {
      if (!props.canViewMasterData) return;
      await loadBrand();
      await loadBrandParts();
    },
    { enabled: props.canViewMasterData, intervalMs: 20000 },
  );

  const selectedParts = brandParts;
  const headerTitle = name.trim() ? `Марка двигателя: ${name.trim()}` : 'Марка двигателя';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: 20, fontWeight: 800 }}>{headerTitle}</div>
        <div style={{ flex: 1 }} />
        {props.canEdit && (
          <Button variant="ghost" tone="success" onClick={() => void saveAllAndClose()}>
            Сохранить
          </Button>
        )}
        {props.canEdit && (
          <Button variant="ghost" tone="danger" onClick={() => void handleDelete()}>
            Удалить
          </Button>
        )}
        <Button variant="ghost" tone="neutral" onClick={() => void loadBrand()}>
          Обновить
        </Button>
      </div>

      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', paddingTop: 12 }}>
        <SectionCard style={{ padding: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 200px) 1fr', gap: 8 }}>
          <div style={{ color: 'var(--subtle)' }}>Название</div>
          <Input
            value={name}
            disabled={!props.canEdit}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void saveName()}
          />
          <div style={{ color: 'var(--subtle)', alignSelf: 'start', paddingTop: 6 }}>Описание</div>
          <textarea
            value={description}
            disabled={!props.canEdit}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => void saveDescription()}
            rows={3}
            style={{
              width: '100%',
              padding: '8px 10px',
              borderRadius: 0,
              border: '1px solid var(--input-border)',
              background: props.canEdit ? 'var(--input-bg)' : 'var(--input-bg-disabled)',
              color: 'var(--text)',
              fontSize: 14,
              lineHeight: 1.4,
              resize: 'vertical',
            }}
          />
        </div>
      </SectionCard>

      <SectionCard
        title="Детали для марки"
        style={{ marginTop: 14, padding: 12 }}
        actions={
          props.canEdit && props.canViewParts && props.canEditParts ? (
            <Button variant="ghost" onClick={() => setShowAddPart((v) => !v)}>
              + Добавить деталь
            </Button>
          ) : undefined
        }
      >

        {showAddPart && props.canViewParts && props.canEditParts && (
          <div style={{ marginBottom: 10 }}>
            <SearchSelectWithCreate
              value={addPartId}
              options={partsOptions}
              disabled={!props.canEdit || !props.canEditParts}
              canCreate={props.canCreateParts}
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
          <div style={{ color: 'var(--subtle)', fontSize: 13 }}>Детали не добавлены.</div>
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
                  borderRadius: 0,
                  border: '1px solid var(--border)',
                  background: 'var(--surface)',
                  cursor: props.canViewParts ? 'pointer' : 'default',
                }}
              >
                <div style={{ fontWeight: 600 }}>{p.label}</div>
                <div style={{ color: 'var(--subtle)', fontSize: 12 }}>
                  {p.assemblyUnitNumber ? `№ сборки: ${p.assemblyUnitNumber}` : '№ сборки: —'}
                </div>
                <div style={{ flex: 1 }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ color: 'var(--subtle)', fontSize: 12 }}>Количество</div>
                  <Input
                    type="number"
                    min={0}
                    value={String(p.quantity)}
                    disabled={!props.canEdit || !props.canEditParts}
                    style={{ width: 96 }}
                    onChange={(e) => {
                      const raw = Number(e.target.value);
                      const nextQty = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
                      setBrandParts((prev) => prev.map((x) => (x.id === p.id ? { ...x, quantity: nextQty } : x)));
                    }}
                    onBlur={() => void updateBrandPartQty(p.id, p.quantity)}
                  />
                </div>
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
                    void updateBrandParts(brandParts.map((x) => x.id).filter((id) => id !== p.id));
                  }}
                  disabled={!props.canEdit || !props.canEditParts}
                  style={{ color: 'var(--danger)' }}
                >
                  Убрать
                </Button>
              </div>
            ))}
          </div>
        )}

        {partsStatus && <div style={{ marginTop: 8, color: 'var(--subtle)', fontSize: 12 }}>{partsStatus}</div>}
      </SectionCard>

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

      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div>}
      </div>
    </div>
  );
}
