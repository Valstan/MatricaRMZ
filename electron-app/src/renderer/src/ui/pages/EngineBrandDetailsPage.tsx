import React, { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelectWithCreate } from '../components/SearchSelectWithCreate.js';
import { SectionCard } from '../components/SectionCard.js';
import { AttachmentsPanel } from '../components/AttachmentsPanel.js';
import { CardActionBar } from '../components/CardActionBar.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import type { CardCloseActions } from '../cardCloseTypes.js';
import type { SearchSelectOption } from '../components/SearchSelect.js';
import {
  createEngineBrandSummarySyncState,
  computeSummaryFromBrandRows,
  persistBrandSummary,
  type EngineBrandSummarySyncState,
} from '../utils/engineBrandSummary.js';
import {
  deletePartSpecBrandLink,
  invalidateListAllPartSpecsCache,
  listAllPartSpecs,
  listPartSpecBrandLinks,
  propagatePartSpecBrandLinkToBrands,
  upsertPartSpecBrandLink,
} from '../utils/partsPagination.js';
import { parseIdArray } from '../utils/groupBrandIds.js';
import { buildSearchOption, joinOptionSearch, mapPartRowsToSearchOptions, sortSearchOptions } from '../utils/selectOptions.js';
import { printRowsPreview } from '../utils/listContextActions.js';
import { matchesQueryInRecord } from '../utils/search.js';

// Режимы отображения списка деталей марки (директива владельца 2026-07-05):
// фильтр внутри раздутых карточек + срезы по актам + группировка по узлам + печать среза.
type BrandPartsView = 'all' | 'completeness' | 'defect' | 'units';
const BRAND_PARTS_VIEWS: Array<{ id: BrandPartsView; label: string; title: string }> = [
  { id: 'all', label: 'Все', title: 'Все детали марки' },
  { id: 'completeness', label: 'Комплектовка', title: 'Только детали акта комплектности' },
  { id: 'defect', label: 'Дефектовка', title: 'Только детали акта дефектовки' },
  { id: 'units', label: 'По узлам', title: 'Группировка по узлам (артикул / № сборочной единицы)' },
];

type PartOption = SearchSelectOption;
type BrandPartRow = {
  id: string;
  label: string;
  linkId?: string;
  // Артикул детали (= nomenclature code). Решение владельца (2026-06-12): артикул И ЕСТЬ
  // «№ сборочной единицы», артикул приоритетен. Показывается во втором столбце списка.
  article: string;
  assemblyUnitNumber: string;
  quantity: number;
  // Т4: галочки актов шаблона марки — наследуются строками двигателей этой марки.
  inCompletenessAct: boolean;
  inDefectAct: boolean;
};
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
  const [brandTypeId, setBrandTypeId] = useState<string>('');
  const [partsOptions, setPartsOptions] = useState<PartOption[]>([]);
  const [brandParts, setBrandParts] = useState<BrandPartRow[]>([]);
  const [partsStatus, setPartsStatus] = useState<string>('');
  const [showAddPart, setShowAddPart] = useState(false);
  const [addPartId, setAddPartId] = useState<string | null>(null);
  // «Распространить набор деталей марки на все марки её группы».
  const [propagateOpen, setPropagateOpen] = useState(false);
  const [propagateGroups, setPropagateGroups] = useState<Array<{ id: string; name: string; targetBrandIds: string[] }>>([]);
  const [propagateSelId, setPropagateSelId] = useState<string | null>(null);
  const [propagateBusy, setPropagateBusy] = useState(false);
  const [propagateStatus, setPropagateStatus] = useState('');
  const dirtyRef = useRef(false);

  async function openPropagateModal() {
    setPropagateStatus('');
    setPropagateGroups([]);
    setPropagateSelId(null);
    setPropagateOpen(true);
    try {
      const types = (await window.matrica.admin.entityTypes.list()) as Array<{ id: string; code: string }>;
      const gt = types.find((t) => String(t.code) === 'engine_brand_group');
      if (!gt?.id) return;
      const list = (await window.matrica.admin.entities.listByEntityType(gt.id)) as Array<{ id: string; displayName?: string }>;
      const out: Array<{ id: string; name: string; targetBrandIds: string[] }> = [];
      for (const row of list) {
        const det = await window.matrica.admin.entities.get(String(row.id), gt.id).catch(() => null);
        const attrs = (det as { attributes?: Record<string, unknown> } | null)?.attributes ?? {};
        const brandIds = parseIdArray(attrs.engine_brand_ids);
        if (!brandIds.includes(props.brandId)) continue;
        const targets = brandIds.filter((b) => b && b !== props.brandId);
        if (targets.length === 0) continue;
        const name = String(attrs.name ?? row.displayName ?? '').trim() || String(row.id);
        out.push({ id: String(row.id), name, targetBrandIds: targets });
      }
      out.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      setPropagateGroups(out);
      setPropagateSelId(out.length === 1 ? out[0]!.id : null);
    } catch (e) {
      setPropagateStatus(`Ошибка загрузки групп: ${String(e)}`);
    }
  }

  async function runPropagate() {
    const group = propagateGroups.find((g) => g.id === propagateSelId);
    if (!group) return;
    const source = brandParts.filter((r) => r.id);
    if (source.length === 0) {
      setPropagateStatus('У марки нет деталей для распространения.');
      return;
    }
    setPropagateBusy(true);
    let done = 0;
    let failed = 0;
    for (const row of source) {
      const r = await propagatePartSpecBrandLinkToBrands({
        partId: row.id,
        targetBrandIds: group.targetBrandIds,
        assemblyUnitNumber: row.assemblyUnitNumber,
        quantity: row.quantity,
        inCompletenessAct: row.inCompletenessAct,
        inDefectAct: row.inDefectAct,
      });
      if (r.ok) done += 1;
      else failed += 1;
      setPropagateStatus(`Копирование: ${done + failed}/${source.length}…`);
    }
    invalidateListAllPartSpecsCache();
    setPropagateBusy(false);
    setPropagateStatus(
      failed > 0
        ? `Готово с ошибками: ${done} деталей ок, ${failed} с ошибкой (× ${group.targetBrandIds.length} марок).`
        : `Готово: ${done} деталей × ${group.targetBrandIds.length} марок «${group.name}».`,
    );
  }
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
        (args.offset ?? 0) > 0
          ? { ok: true as const, parts: [] as unknown[] }
          : listAllPartSpecs({ engineBrandId: args.engineBrandId }),
    }),
    [],
  );

  async function loadBrand() {
    try {
      setStatus('Загрузка…');
      // Resolve the type so a not-yet-saved (deferred-create) brand opens as an empty card
      // instead of throwing. For existing brands the fallback is ignored.
      let fallbackTypeId = brandTypeId;
      if (!fallbackTypeId) {
        const types = await window.matrica.admin.entityTypes.list();
        fallbackTypeId = String((types as any[]).find((t) => String(t.code) === 'engine_brand')?.id ?? '');
        if (fallbackTypeId) setBrandTypeId(fallbackTypeId);
      }
      const details = await window.matrica.admin.entities.get(props.brandId, fallbackTypeId || undefined);
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
    const r = await listAllPartSpecs();
    if (!r.ok) {
      setPartsOptions([]);
      setPartsStatus(`Ошибка: ${r.error ?? 'unknown'}`);
      return;
    }
    setPartsOptions(mapPartRowsToSearchOptions(r.parts as Array<{ id: string; name?: string; article?: string; templateName?: string }>));
    setPartsStatus('');
  }

  async function persistBrandSummaryFromRows(rows: BrandPartRow[]) {
    if (!props.canEdit) return;
    const { kinds, totalQty } = computeSummaryFromBrandRows(rows);
    await persistBrandSummary(summaryDeps, summaryPersistState.current, props.brandId, kinds, totalQty);
  }

  async function loadBrandParts() {
    if (!props.canViewParts) return;
    const r = await listAllPartSpecs({ engineBrandId: props.brandId }).catch(() => ({ ok: false as const, error: 'unknown' }));
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
      let inCompletenessAct = false;
      let inDefectAct = false;
      for (const link of linksForBrand) {
        if (!assemblyUnitNumber) {
          const fallback = String((link as any)?.assemblyUnitNumber || '').trim();
          if (fallback) assemblyUnitNumber = fallback;
        }
        const rawQty = Number((link as any)?.quantity);
        if (Number.isFinite(rawQty)) quantity += Math.max(0, Math.floor(rawQty));
        if ((link as any)?.inCompletenessAct) inCompletenessAct = true;
        if ((link as any)?.inDefectAct) inDefectAct = true;
      }

      const name = typeof part.name === 'string' ? String(part.name) : '';
      const article = typeof part.article === 'string' ? String(part.article) : '';
      const label = String(name || article || partId);

      rows.push({
        id: partId,
        label,
        ...(linkId ? { linkId } : {}),
        article,
        assemblyUnitNumber,
        quantity,
        inCompletenessAct,
        inDefectAct,
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
      await window.matrica.admin.entities.setAttr(props.brandId, 'name', name.trim(), brandTypeId || undefined);
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
      await window.matrica.admin.entities.setAttr(props.brandId, 'description', description.trim() || null, brandTypeId || undefined);
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
      const r = await window.matrica.admin.entities.setAttr(props.brandId, code, value, brandTypeId || undefined);
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
    inCompletenessAct?: boolean;
    inDefectAct?: boolean;
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
      ...(args.inCompletenessAct !== undefined ? { inCompletenessAct: args.inCompletenessAct } : {}),
      ...(args.inDefectAct !== undefined ? { inDefectAct: args.inDefectAct } : {}),
    };
    const r = await upsertPartSpecBrandLink(payload);
    if (!r.ok) return { ok: false as const, error: r.error ?? 'Не удалось сохранить связь' };
    return { ok: true as const, linkId: r.linkId };
  }

  // Т4: смена галочки акта — немедленное сохранение с явной строкой (не из state,
  // setState асинхронен и updateBrandPartRow увидел бы устаревшее значение).
  async function saveBrandPartActFlags(row: BrandPartRow) {
    if (!props.canEdit || !props.canEditParts) return;
    setPartsStatus('Сохранение...');
    const r = await upsertBrandPartLink({
      partId: row.id,
      assemblyUnitNumber: row.assemblyUnitNumber === 'не задано' ? '' : row.assemblyUnitNumber,
      quantity: row.quantity,
      inCompletenessAct: row.inCompletenessAct,
      inDefectAct: row.inDefectAct,
      ...(row.linkId ? { linkId: row.linkId } : {}),
    });
    setPartsStatus(r.ok ? '' : `Ошибка: ${String(r.error ?? 'unknown')}`);
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
        const links = await listPartSpecBrandLinks({ partId });
        if (!links.ok) throw new Error(links.error ?? 'Не удалось загрузить связи детали');
        const found = links.brandLinks.find((l) => l.engineBrandId === props.brandId);
        if (found?.id) linkId = found.id;
      }
      if (!linkId) throw new Error('Связь не найдена');
      const del = await deletePartSpecBrandLink({ partId, linkId });
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
    let assemblyUnitNumber = '';
    try {
      const links = await listPartSpecBrandLinks({ partId });
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
    // Safety net: the link write succeeded, so the part now belongs to this brand. If the
    // refetch above didn't surface it yet (list eventual-consistency or a racing cache
    // refill), add it optimistically so the operator always sees the result of their action.
    // Harmless: it only ever shows a part whose brand-link was just confirmed written.
    setBrandParts((prev) => {
      if (prev.some((p) => p.id === partId)) return prev;
      const label = partsOptions.find((o) => o.id === partId)?.label?.trim() || partId;
      const optimistic: BrandPartRow = {
        id: partId,
        label,
        ...(r.linkId ? { linkId: r.linkId } : {}),
        article: '',
        assemblyUnitNumber,
        quantity: 1,
        inCompletenessAct: false,
        inDefectAct: false,
      };
      const next = [...prev, optimistic].sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      persistBrandSummaryFromRows(next);
      return next;
    });
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
      const created = await window.matrica.warehouse.nomenclatureDirectoryPartCreate({ name });
      let id = '';
      if (created?.ok && created.part?.id) {
        id = String(created.part.id);
      } else {
        const rawErr = created && 'error' in created ? String((created as { error?: unknown }).error ?? '') : '';
        // A near-duplicate name slipped past the option list — reuse the existing part
        // (same contract createWarehouseNomenclatureFromDirectory parses) instead of erroring.
        const dup = rawErr.match(/duplicate part exists:\s*([0-9a-f-]{36})/i);
        if (dup?.[1]) {
          id = String(dup[1]);
        } else {
          setPartsStatus(`Ошибка: ${rawErr || 'Не удалось создать деталь'}`);
          return null;
        }
      }
      invalidateListAllPartSpecsCache();
      if (!partsOptions.some((o) => o.id === id)) {
        setPartsOptions(
          sortSearchOptions([
            ...partsOptions,
            buildSearchOption({ id, label: name, searchText: joinOptionSearch([name, id]) }),
          ]),
        );
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

  // Фильтр + режим отображения списка деталей.
  const [partsQuery, setPartsQuery] = useState('');
  const [partsView, setPartsView] = useState<BrandPartsView>('all');
  const [openUnits, setOpenUnits] = useState<Record<string, boolean>>({});

  const partUnitKey = (p: BrandPartRow) => (p.article || p.assemblyUnitNumber || '').trim() || 'Без узла';

  const visibleParts = useMemo(() => {
    const q = partsQuery.trim();
    let rows = selectedParts;
    if (q) {
      rows = rows.filter((p) =>
        matchesQueryInRecord(q, { label: p.label, article: p.article, assemblyUnitNumber: p.assemblyUnitNumber }),
      );
    }
    if (partsView === 'completeness') rows = rows.filter((p) => p.inCompletenessAct);
    if (partsView === 'defect') rows = rows.filter((p) => p.inDefectAct);
    return rows;
  }, [selectedParts, partsQuery, partsView]);

  const unitGroups = useMemo(() => {
    if (partsView !== 'units') return [];
    const map = new Map<string, BrandPartRow[]>();
    for (const p of visibleParts) {
      const key = partUnitKey(p);
      const list = map.get(key);
      if (list) list.push(p);
      else map.set(key, [p]);
    }
    return [...map.entries()]
      .map(([key, rows]) => ({
        key,
        rows,
        qty: rows.reduce((acc, p) => acc + Math.max(0, Math.floor(Number(p.quantity) || 0)), 0),
      }))
      .sort((a, b) => (a.key === 'Без узла' ? 1 : b.key === 'Без узла' ? -1 : a.key.localeCompare(b.key, 'ru')));
  }, [partsView, visibleParts]);

  // При активном фильтре узлы раскрыты (оператор ищет конкретное), без фильтра — по клику.
  const isUnitOpen = (key: string) => (partsQuery.trim() ? openUnits[key] !== false : openUnits[key] === true);

  function printVisibleParts() {
    const view = BRAND_PARTS_VIEWS.find((v) => v.id === partsView);
    const q = partsQuery.trim();
    const rows =
      partsView === 'units'
        ? unitGroups.flatMap((g) => g.rows.map((p) => ({ ...p, unit: g.key })))
        : visibleParts.map((p) => ({ ...p, unit: partUnitKey(p) }));
    printRowsPreview({
      title: headerTitle,
      sectionTitle: [view?.title ?? 'Детали', q ? `фильтр: «${q}»` : '', `строк: ${rows.length}`]
        .filter(Boolean)
        .join(' · '),
      rows,
      columns: [
        { title: 'Деталь', value: (p) => p.label },
        { title: 'Артикул / узел', value: (p) => p.unit === 'Без узла' ? '—' : p.unit },
        { title: 'Кол-во', value: (p) => String(p.quantity) },
        { title: 'Акт компл.', value: (p) => (p.inCompletenessAct ? 'да' : '—') },
        { title: 'Акт деф.', value: (p) => (p.inDefectAct ? 'да' : '—') },
      ],
    });
  }

  function renderPartRow(p: BrandPartRow) {
    // Артикул приоритетен над legacy-номером сборки; пусто → «не задано».
    const articleDisplay = (p.article || p.assemblyUnitNumber || '').trim();
    return (
      <div
        key={p.id}
        data-testid="brand-part-row"
        onClick={() => props.onOpenPart(p.id)}
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(160px, 1fr) minmax(120px, 220px) max-content max-content max-content max-content',
          alignItems: 'center',
          gap: 12,
          padding: '8px 10px',
          borderRadius: 0,
          border: '1px solid var(--border)',
          background: 'var(--surface)',
          cursor: props.canViewParts ? 'pointer' : 'default',
        }}
      >
        <div style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</div>
        <div
          title="Артикул"
          style={{
            fontSize: 13,
            color: articleDisplay ? 'var(--text)' : 'var(--subtle)',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {articleDisplay || 'не задано'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {(['inCompletenessAct', 'inDefectAct'] as const).map((flag) => (
            <label
              key={flag}
              style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--subtle)', cursor: 'pointer' }}
              onClick={(event) => event.stopPropagation()}
            >
              <input
                type="checkbox"
                checked={p[flag]}
                disabled={!props.canEdit || !props.canEditParts}
                onChange={(e) => {
                  const nextRow = { ...p, [flag]: e.target.checked } as BrandPartRow;
                  setBrandParts((prev) => prev.map((x) => (x.id === p.id ? nextRow : x)));
                  void saveBrandPartActFlags(nextRow);
                }}
              />
              {flag === 'inCompletenessAct' ? 'Акт компл.' : 'Акт деф.'}
            </label>
          ))}
        </div>
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
    );
  }

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
          onSave={() => { void saveAllAndClose(); }}
          onSaveAndClose={() => { void saveAllAndClose().then(() => props.onClose()); }}
          onReset={() => {
            void loadBrand().then(() => {
              dirtyRef.current = false;
            });
          }}
          onDelete={() => void handleDelete()}
          deleteConfirmDetail={`Будет удалена марка двигателя «${name.trim() || props.brandId}».`}
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
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <Button variant="ghost" onClick={() => setShowAddPart((v) => !v)}>
                + Добавить деталь
              </Button>
              <Button
                variant="ghost"
                onClick={() => void openPropagateModal()}
                disabled={brandParts.length === 0}
                title="Скопировать этот набор деталей (кол-во, № узла, галочки актов комплектности/дефектовки) на все марки выбранной группы"
              >
                Распространить на группу
              </Button>
            </div>
          ) : undefined
        }
      >
        {propagateOpen ? (
          <div
            style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200, padding: 20 }}
            onClick={() => { if (!propagateBusy) setPropagateOpen(false); }}
          >
            <div style={{ width: 'min(560px, 95vw)', background: 'var(--surface)', borderRadius: 14, padding: 16 }} onClick={(e) => e.stopPropagation()}>
              <div style={{ fontWeight: 800, fontSize: 16 }}>Распространить набор деталей на группу</div>
              <div style={{ marginTop: 8, color: 'var(--muted)', fontSize: 13 }}>
                {brandParts.length} видов деталей этой марки будут скопированы (кол-во, № узла, галочки актов) на все другие марки выбранной группы. Существующие привязки этих деталей на марках-целях перезаписываются; прочие детали марок-целей не трогаются.
              </div>
              {propagateGroups.length === 0 ? (
                <div style={{ marginTop: 12, color: 'var(--subtle)' }}>
                  {propagateStatus || 'Эта марка не входит ни в одну группу с другими марками. Добавьте марку в группу в разделе «Группы марок».'}
                </div>
              ) : (
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {propagateGroups.map((g) => (
                    <label key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 8, background: 'var(--surface-2, rgba(148,163,184,0.10))', cursor: 'pointer' }}>
                      <input type="radio" name="propagate-group" checked={propagateSelId === g.id} onChange={() => setPropagateSelId(g.id)} disabled={propagateBusy} />
                      <span style={{ flex: 1 }}>{g.name}</span>
                      <span style={{ color: 'var(--subtle)', fontSize: 12 }}>{g.targetBrandIds.length} марок-целей</span>
                    </label>
                  ))}
                </div>
              )}
              {propagateStatus && propagateGroups.length > 0 ? <div style={{ marginTop: 10, color: propagateStatus.startsWith('Ошибка') || propagateStatus.includes('ошиб') ? 'var(--danger)' : 'var(--subtle)', fontSize: 13 }}>{propagateStatus}</div> : null}
              <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Button variant="ghost" onClick={() => setPropagateOpen(false)} disabled={propagateBusy}>Закрыть</Button>
                <Button variant="ghost" tone="success" onClick={() => void runPropagate()} disabled={propagateBusy || !propagateSelId}>
                  {propagateBusy ? 'Копирую…' : 'Скопировать'}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
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

        {selectedParts.length > 0 && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <div style={{ flex: '1 1 220px', minWidth: 180 }}>
              <Input
                value={partsQuery}
                onChange={(e) => setPartsQuery(e.target.value)}
                placeholder="Фильтр: деталь, артикул, узел…"
              />
            </div>
            <span style={{ fontSize: 12, color: 'var(--subtle)', whiteSpace: 'nowrap' }}>
              {partsQuery.trim() || partsView !== 'all' ? `${visibleParts.length} из ${selectedParts.length}` : `${selectedParts.length}`}
            </span>
            {BRAND_PARTS_VIEWS.map((v) => (
              <Button
                key={v.id}
                variant="ghost"
                title={v.title}
                onClick={() => setPartsView(v.id)}
                style={partsView === v.id ? { background: 'rgba(37, 99, 235, 0.15)' } : undefined}
              >
                {v.label}
              </Button>
            ))}
            <Button variant="ghost" title="Распечатать текущий срез списка" onClick={() => printVisibleParts()}>
              🖨 Печать
            </Button>
          </div>
        )}

        {selectedParts.length === 0 ? (
          <div style={{ color: 'var(--subtle)', fontSize: 13 }}>Детали не добавлены.</div>
        ) : visibleParts.length === 0 ? (
          <div style={{ color: 'var(--subtle)', fontSize: 13 }}>Ничего не найдено по текущему фильтру.</div>
        ) : partsView === 'units' ? (
          <div style={{ display: 'grid', gap: 8 }}>
            {unitGroups.map((g) => (
              <div key={g.key} style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}>
                <div
                  data-testid="brand-unit-group"
                  onClick={() => setOpenUnits((prev) => ({ ...prev, [g.key]: !isUnitOpen(g.key) }))}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 10px',
                    cursor: 'pointer',
                    fontWeight: 600,
                  }}
                >
                  <span style={{ fontSize: 12, color: 'var(--subtle)' }}>{isUnitOpen(g.key) ? '▼' : '▶'}</span>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.key}</span>
                  <span style={{ fontSize: 12, color: 'var(--subtle)', whiteSpace: 'nowrap' }}>
                    {g.rows.length} дет. · {g.qty} шт.
                  </span>
                </div>
                {isUnitOpen(g.key) && (
                  <div style={{ display: 'grid', gap: 8, padding: '0 10px 10px' }}>
                    {g.rows.map((p) => renderPartRow(p))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {visibleParts.map((p) => renderPartRow(p))}
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
