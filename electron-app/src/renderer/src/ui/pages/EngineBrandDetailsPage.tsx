import React, { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelectWithCreate } from '../components/SearchSelectWithCreate.js';
import { SectionCard } from '../components/SectionCard.js';
import { AttachmentsPanel } from '../components/AttachmentsPanel.js';
import { CardActionBar } from '../components/CardActionBar.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import type { CardCloseActions } from '../cardCloseTypes.js';
import {
  createEngineBrandSummarySyncState,
  computeSummaryFromBrandRows,
  persistBrandSummary,
  type EngineBrandSummarySyncState,
} from '../utils/engineBrandSummary.js';
import { invalidateListAllPartsCache, listAllParts } from '../utils/partsPagination.js';

type PartOption = { id: string; label: string };
type BrandPartRow = { id: string; label: string; linkId?: string; assemblyUnitNumber: string; quantity: number };
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
  registerCardCloseActions?: (actions: CardCloseActions | null) => void;
  requestClose?: () => void;
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
  const dirtyRef = useRef(false);
  const summaryPersistState = useRef<EngineBrandSummarySyncState>(createEngineBrandSummarySyncState());
  const summaryDeps = useMemo(
    () => ({
      entityTypesList: async () => (await window.matrica.admin.entityTypes.list()) as unknown[],
      upsertAttributeDef: async (args: {
        entityTypeId: string;
        code: string;
        name: string;
        dataType: 'number';
        sortOrder: number;
      }) => window.matrica.admin.attributeDefs.upsert(args),
      setEntityAttr: async (entityId: string, code: string, value: number) =>
        window.matrica.admin.entities.setAttr(entityId, code, value) as Promise<{ ok: boolean; error?: string }>,
      listPartsByBrand: async (args: { engineBrandId: string; limit: number; offset?: number }) =>
        window.matrica.parts.list(args)
          .then((r) => r as { ok: boolean; parts?: unknown[]; error?: string })
          .catch((error) => ({ ok: false as const, error: String(error) })),
    }),
    [],
  );

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
      dirtyRef.current = false;
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function loadPartsOptions() {
    if (!props.canViewParts) return;
    setPartsStatus('Загрузка списка деталей...');
    const r = await listAllParts();
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

  async function persistBrandSummaryFromRows(rows: BrandPartRow[]) {
    if (!props.canEdit) return;
    const { kinds, totalQty } = computeSummaryFromBrandRows(rows);
    await persistBrandSummary(summaryDeps, summaryPersistState.current, props.brandId, kinds, totalQty);
  }

  async function loadBrandParts() {
    if (!props.canViewParts) return;
    const r = await listAllParts({ engineBrandId: props.brandId }).catch(() => ({ ok: false as const, error: 'unknown' }));
    if (!r.ok) {
      setBrandParts([]);
      setPartsStatus(`Ошибка: ${r.error ?? 'unknown'}`);
      return;
    }
    const rows: BrandPartRow[] = [];
    const seenPartIds = new Set<string>();

    for (const p of r.parts) {
      const part = p as Record<string, unknown>;
      const partId = String(part?.id || '').trim();
      if (!partId || seenPartIds.has(partId)) continue;

      const brandLinks = Array.isArray(part?.brandLinks) ? (part.brandLinks as Record<string, unknown>[]) : [];
      const linksForBrand = brandLinks.filter((link) => String((link as any)?.engineBrandId || '').trim() === props.brandId);
      if (!linksForBrand.length) continue;
      const firstLink = linksForBrand[0] ?? null;
      const linkId = firstLink && typeof (firstLink as any).id === 'string' ? String((firstLink as any).id).trim() : '';

      let assemblyUnitNumber = '';
      let quantity = 0;
      for (const link of linksForBrand) {
        if (!assemblyUnitNumber) {
          const fallback = String((link as any)?.assemblyUnitNumber || '').trim();
          if (fallback) assemblyUnitNumber = fallback;
        }
        const rawQty = Number((link as any)?.quantity);
        if (Number.isFinite(rawQty)) quantity += Math.max(0, Math.floor(rawQty));
      }

      const name = typeof part.name === 'string' ? String(part.name) : '';
      const article = typeof part.article === 'string' ? String(part.article) : '';
      const label = String(name || article || partId);

      rows.push({
        id: partId,
        label,
        ...(linkId ? { linkId } : {}),
        assemblyUnitNumber: assemblyUnitNumber || 'не задано',
        quantity,
      } satisfies BrandPartRow);
      seenPartIds.add(partId);
    }
    rows.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    setBrandParts(rows);
    setPartsStatus('');
    persistBrandSummaryFromRows(rows);
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
    if (!props.canEdit) return;
    await saveName();
    await saveDescription();
    dirtyRef.current = false;
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

  async function upsertBrandPartLink(args: {
    partId: string;
    linkId?: string;
    assemblyUnitNumber: string;
    quantity: number;
  }) {
    if (!props.canEdit || !props.canEditParts) return { ok: false as const, error: 'no permission' };
    const assemblyUnitNumber = String(args.assemblyUnitNumber || '').trim();
    const qty = Math.max(0, Math.floor(Number(args.quantity) || 0));
    const payload = {
      partId: args.partId,
      engineBrandId: props.brandId,
      assemblyUnitNumber,
      quantity: qty,
      ...(args.linkId ? { linkId: args.linkId } : {}),
    };
    const r = await window.matrica.parts.partBrandLinks.upsert(payload);
    if (!r.ok) return { ok: false as const, error: r.error ?? 'Не удалось сохранить связь' };
    return { ok: true as const, linkId: r.linkId };
  }

  async function updateBrandPartRow(partId: string, row: BrandPartRow) {
    if (!props.canEdit || !props.canEditParts) return;
    const rowFromState = brandParts.find((p) => p.id === partId) ?? row;
    if (!rowFromState?.id) return;
    setPartsStatus('Сохранение...');
    const r = await upsertBrandPartLink({
      partId,
      assemblyUnitNumber: String(rowFromState.assemblyUnitNumber || ''),
      quantity: rowFromState.quantity,
      ...(rowFromState.linkId ? { linkId: rowFromState.linkId } : {}),
    });
    if (!r.ok) {
      setPartsStatus(`Ошибка: ${String(r.error ?? 'unknown')}`);
      return;
    }
    const updatedLinkId = r.linkId;
    setBrandParts((prev) => {
      const next = prev.map((x) => (x.id === partId ? { ...x, linkId: x.linkId || updatedLinkId } : x));
      persistBrandSummaryFromRows(next);
      return next;
    });
    setPartsStatus('Сохранено');
    setTimeout(() => setPartsStatus(''), 1200);
  }

  async function detachBrandPart(partId: string) {
    if (!props.canEdit || !props.canEditParts) return;
    const current = brandParts.find((x) => x.id === partId);
    if (!current) return;
    setPartsStatus('Сохранение связей...');
    try {
      let linkId = (current.linkId || '').trim();
      if (!linkId) {
        const links = await window.matrica.parts.partBrandLinks.list({ partId });
        if (!links.ok) throw new Error(links.error ?? 'Не удалось загрузить связи детали');
        const found = links.brandLinks.find((l) => l.engineBrandId === props.brandId);
        if (found?.id) linkId = found.id;
      }
      if (!linkId) throw new Error('Связь не найдена');
      const del = await window.matrica.parts.partBrandLinks.delete({ partId, linkId });
      if (!del.ok) throw new Error(del.error ?? 'Не удалось удалить связь');
      setBrandParts((prev) => {
        const next = prev.filter((x) => x.id !== partId);
        persistBrandSummaryFromRows(next);
        return next;
      });
      setPartsStatus('Сохранено');
      setTimeout(() => setPartsStatus(''), 900);
    } catch (e) {
      const msg = String(e);
      setPartsStatus(`Ошибка: ${msg}`);
      window.matrica?.log?.send?.('error', `engine_brand_parts update failed: ${msg}`).catch(() => {});
    }
  }

  async function addPart(partId: string) {
    if (!partId) return;
    if (!props.canEdit || !props.canEditParts) return;
    if (brandParts.some((p) => p.id === partId)) {
      setAddPartId(null);
      setShowAddPart(false);
      return;
    }
    let assemblyUnitNumber = 'не задано';
    try {
      const links = await window.matrica.parts.partBrandLinks.list({ partId });
      if (links.ok) {
        const candidate = links.brandLinks.find((link) => link.engineBrandId !== props.brandId && link.assemblyUnitNumber?.trim());
        if (candidate?.assemblyUnitNumber?.trim()) {
          assemblyUnitNumber = String(candidate.assemblyUnitNumber).trim();
        }
      }
    } catch {
      // keep fallback
    }

    const r = await upsertBrandPartLink({ partId, assemblyUnitNumber, quantity: 1 });
    if (!r.ok) {
      setPartsStatus(`Ошибка: ${String(r.error ?? 'unknown')}`);
      return;
    }
    await loadBrandParts();
    setAddPartId(null);
    setShowAddPart(false);
    setPartsStatus('Сохранено');
    setTimeout(() => setPartsStatus(''), 900);
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
      invalidateListAllPartsCache({ engineBrandId: props.brandId });
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
      if (dirtyRef.current) return;
      await loadBrand();
      await loadBrandParts();
    },
    { enabled: props.canViewMasterData, intervalMs: 20000 },
  );

  useEffect(() => {
    if (!props.registerCardCloseActions) return;
    props.registerCardCloseActions({
      isDirty: () => dirtyRef.current,
      saveAndClose: async () => {
        await saveAllAndClose();
      },
      reset: async () => {
        await loadBrand();
        dirtyRef.current = false;
      },
      closeWithoutSave: () => {
        dirtyRef.current = false;
      },
      copyToNew: async () => {
        const types = await window.matrica.admin.entityTypes.list().catch(() => [] as any[]);
        const type = (types as any[]).find((t: any) => String(t.code) === 'engine_brand');
        if (!type?.id) return;
        const created = await window.matrica.admin.entities.create(type.id);
        if (created?.ok && 'id' in created) {
          await window.matrica.admin.entities.setAttr(created.id, 'name', name.trim() + ' (копия)');
          await window.matrica.admin.entities.setAttr(created.id, 'description', description.trim() || null);
        }
      },
    });
    return () => { props.registerCardCloseActions?.(null); };
  }, [name, description, props.registerCardCloseActions]);

  const selectedParts = brandParts;
  const headerTitle = name.trim() ? `Марка двигателя: ${name.trim()}` : 'Марка двигателя';
  const totalPartKinds = selectedParts.length;
  const totalPartsQty = selectedParts.reduce((acc, p) => acc + (Number.isFinite(Number(p.quantity)) ? Math.max(0, Math.floor(Number(p.quantity))) : 0), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ flexShrink: 0, borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
        <CardActionBar
          canEdit={props.canEdit}
          onCopyToNew={() => {
            void (async () => {
              const types = await window.matrica.admin.entityTypes.list().catch(() => [] as any[]);
              const type = (types as any[]).find((t: any) => String(t.code) === 'engine_brand');
              if (!type?.id) return;
              const created = await window.matrica.admin.entities.create(type.id);
              if (created?.ok && 'id' in created) {
                await window.matrica.admin.entities.setAttr(created.id, 'name', name.trim() + ' (копия)');
                await window.matrica.admin.entities.setAttr(created.id, 'description', description.trim() || null);
              }
            })();
          }}
          onSaveAndClose={() => { void saveAllAndClose().then(() => props.onClose()); }}
          onReset={() => {
            void loadBrand().then(() => {
              dirtyRef.current = false;
            });
          }}
          onDelete={() => void handleDelete()}
          onClose={() => props.requestClose?.()}
        />
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: 20, fontWeight: 800 }}>{headerTitle}</div>
        <div style={{ flex: 1 }} />
      </div>

      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', paddingTop: 12 }}>
        <SectionCard style={{ padding: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 200px) 1fr', gap: 8 }}>
          <div style={{ color: 'var(--subtle)' }}>Название</div>
          <Input
            value={name}
            disabled={!props.canEdit}
            onChange={(e) => { setName(e.target.value); dirtyRef.current = true; }}
          />
          <div style={{ color: 'var(--subtle)', alignSelf: 'start', paddingTop: 6 }}>Описание</div>
          <textarea
            value={description}
            disabled={!props.canEdit}
            onChange={(e) => { setDescription(e.target.value); dirtyRef.current = true; }}
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
        <div style={{ marginBottom: 10, color: 'var(--subtle)', fontSize: 13 }}>
            Видов деталей: {totalPartKinds}, всего штук: {totalPartsQty}
        </div>

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
                <Input
                  value={p.assemblyUnitNumber}
                  disabled={!props.canEdit || !props.canEditParts}
                  placeholder="Номер сборки"
                  style={{ width: 180 }}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(e) => {
                    const nextAssemblyUnitNumber = e.target.value;
                    setBrandParts((prev) => prev.map((x) => (x.id === p.id ? { ...x, assemblyUnitNumber: nextAssemblyUnitNumber } : x)));
                  }}
                  onBlur={() => void updateBrandPartRow(p.id, p)}
                />
                <div style={{ flex: 1 }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ color: 'var(--subtle)', fontSize: 12 }}>Количество</div>
                  <Input
                    type="number"
                    min={0}
                    value={String(p.quantity)}
                    disabled={!props.canEdit || !props.canEditParts}
                    style={{ width: 96 }}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(e) => {
                      const raw = Number(e.target.value);
                      const nextQty = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
                      setBrandParts((prev) => prev.map((x) => (x.id === p.id ? { ...x, quantity: nextQty } : x)));
                    }}
                    onBlur={() => void updateBrandPartRow(p.id, p)}
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
                    void detachBrandPart(p.id);
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
