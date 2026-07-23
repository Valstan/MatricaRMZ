import React, { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../components/Button.js';
import { EntityReferenceField } from '../components/EntityReferenceField.js';
import { Input } from '../components/Input.js';
import { SectionCard } from '../components/SectionCard.js';
import { AttachmentsPanel } from '../components/AttachmentsPanel.js';
import { CardActionBar } from '../components/CardActionBar.js';
import { ensureAttributeDefs, type AttributeDefRow } from '../utils/fieldOrder.js';
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
  clearPartSpecBrandLinkActFlagForBrands,
  deletePartSpecBrandLink,
  invalidateListAllPartSpecsCache,
  listAllPartSpecs,
  listPartSpecBrandLinks,
  propagatePartSpecBrandLinkToBrands,
  removePartSpecBrandLinksForBrands,
  upsertPartSpecBrandLink,
  type PartSpecRow,
} from '../utils/partsPagination.js';
import { parseIdArray } from '../utils/groupBrandIds.js';
import { buildSearchOption, joinOptionSearch, mapPartRowsToSearchOptions, sortSearchOptions } from '../utils/selectOptions.js';
import { printRowsPreview } from '../utils/listContextActions.js';
import { matchesQueryInRecord } from '../utils/search.js';

// Режимы отображения списка деталей марки (директива владельца 2026-07-05):
// фильтр внутри раздутых карточек + срезы по актам + группировка по узлам + печать среза.
type BrandPartsView = 'all' | 'completeness' | 'defect' | 'units';
// Распространение набора деталей на группу марок: что распространять и как применить к целям.
type PropagateScope = 'all' | 'completeness' | 'defect' | 'selected';
type PropagateMerge = 'add-missing' | 'overwrite' | 'replace';
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
  // Тема F (owner-батч 2026-07-10): одно «Вложения» вместо Чертежи/Документы/Вложения.
  // Старые attrs drawings/tech_docs читаются и сливаются в общий список (дедуп по FileRef.id);
  // первое изменение пересохраняет merged в `attachments` и зануляет legacy-attrs.
  const [attachments, setAttachments] = useState<unknown>([]);
  const [hasLegacyFileAttrs, setHasLegacyFileAttrs] = useState(false);
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
  // Что распространять: весь список / детали акта комплектности / акта дефектовки / отмеченные детали.
  const [propagateScope, setPropagateScope] = useState<PropagateScope>('all');
  // Как применить к маркам-целям: add-missing (безоп. дефолт) / overwrite / replace (только для scope=all).
  const [propagateMerge, setPropagateMerge] = useState<PropagateMerge>('add-missing');
  const [propagateReplaceConfirm, setPropagateReplaceConfirm] = useState(false);
  // Отмеченные детали (scope=selected) — множество id деталей марки.
  const [selectedPartIds, setSelectedPartIds] = useState<Set<string>>(new Set());
  const dirtyRef = useRef(false);
  // Отложенное сохранение списка деталей: committed-снапшот из последней загрузки,
  // brandParts — редактируемый драфт. Дифф пишется в БД только по «Сохранить».
  const committedPartsRef = useRef<BrandPartRow[]>([]);
  // Phase 3d: recovery-draft движок пилота. Снимок = локальные несохранённые поля
  // (name/description) + драфт списка деталей; файлы сохраняются сразу — в черновик не входят.
  const draftTimerRef = useRef<number | null>(null);
  const draftRestoredRef = useRef(false);
  // true только если восстановленный черновик содержал драфт списка деталей —
  // старые черновики без parts не должны блокировать загрузку committed-списка.
  const draftPartsRestoredRef = useRef(false);
  const DRAFT_CARD_TYPE = 'engine_brand';

  type BrandDraftSnapshot = { name: string; description: string; parts?: BrandPartRow[] };

  function currentDraftSnapshot(): BrandDraftSnapshot {
    return { name, description, parts: brandParts };
  }

  function buildDraftTitle(s: BrandDraftSnapshot): string {
    return `Марка двигателя «${s.name.trim() || 'без названия'}»`;
  }

  async function saveDraftNow(s: BrandDraftSnapshot, kind: 'recovery' | 'explicit' = 'recovery') {
    if (!props.canEdit) return false;
    try {
      const r = await window.matrica.drafts.save({
        cardType: DRAFT_CARD_TYPE,
        cardId: props.brandId,
        kind,
        title: buildDraftTitle(s),
        payloadJson: JSON.stringify(s),
        baseUpdatedAt: null,
      });
      return Boolean(r?.ok);
    } catch {
      // autosave is best-effort — a write failure must never block editing
      return false;
    }
  }

  async function clearDraft() {
    try {
      await window.matrica.drafts.clear({ cardType: DRAFT_CARD_TYPE, cardId: props.brandId });
    } catch {
      // best-effort
    }
  }

  function cancelPendingDraftSave() {
    if (draftTimerRef.current != null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
  }

  function applyDraftSnapshot(s: Partial<BrandDraftSnapshot>) {
    setName(String(s.name ?? ''));
    setDescription(String(s.description ?? ''));
    // Старые черновики без parts — не трогаем список (останется committed-копия).
    if (Array.isArray(s.parts)) {
      setBrandParts(s.parts as BrandPartRow[]);
      draftPartsRestoredRef.current = true;
    }
  }

  async function openPropagateModal() {
    // Распространение читает СОХРАНЁННОЕ состояние связей — при несохранённых правках
    // оператор получил бы не то, что видит на экране.
    if (dirtyRef.current) {
      setPartsStatus('Сначала сохраните карточку («Сохранить») — распространение работает от сохранённого списка.');
      setTimeout(() => setPartsStatus(''), 4000);
      return;
    }
    setPropagateStatus('');
    setPropagateGroups([]);
    setPropagateSelId(null);
    setPropagateScope((prev) => (prev === 'selected' && selectedPartIds.size === 0 ? 'all' : prev));
    setPropagateMerge('add-missing');
    setPropagateReplaceConfirm(false);
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

  // Подмножество деталей марки по выбранному scope (all / акты / отмеченные).
  function propagateSourceRows(scope: PropagateScope): BrandPartRow[] {
    const rows = brandParts.filter((r) => r.id);
    if (scope === 'completeness') return rows.filter((r) => r.inCompletenessAct);
    if (scope === 'defect') return rows.filter((r) => r.inDefectAct);
    if (scope === 'selected') return rows.filter((r) => selectedPartIds.has(r.id));
    return rows;
  }
  // «replace» доступен для scope=all (удаляет лишние ДЕТАЛИ) и для scope=акта (G2: снимает
  // галочку акта у лишних деталей, не удаляя привязки). Для scope=selected — схлопывается в overwrite.
  const isActScope = propagateScope === 'completeness' || propagateScope === 'defect';
  const propagateMergeEffective: PropagateMerge =
    propagateScope === 'all' || isActScope
      ? propagateMerge
      : propagateMerge === 'replace'
        ? 'overwrite'
        : propagateMerge;
  const propagateScopeCounts: Record<PropagateScope, number> = {
    all: brandParts.filter((r) => r.id).length,
    completeness: brandParts.filter((r) => r.id && r.inCompletenessAct).length,
    defect: brandParts.filter((r) => r.id && r.inDefectAct).length,
    selected: brandParts.filter((r) => r.id && selectedPartIds.has(r.id)).length,
  };

  async function runPropagate() {
    const group = propagateGroups.find((g) => g.id === propagateSelId);
    if (!group) return;
    const source = propagateSourceRows(propagateScope);
    if (source.length === 0) {
      setPropagateStatus('Нет деталей для распространения по выбранному условию.');
      return;
    }
    const merge = propagateMergeEffective;
    if (merge === 'replace' && !propagateReplaceConfirm) {
      setPropagateStatus('Подтвердите полное замещение галочкой ниже.');
      return;
    }
    const ensureActFlag = propagateScope === 'completeness' ? 'completeness' : propagateScope === 'defect' ? 'defect' : undefined;
    const perPartMerge: 'overwrite' | 'add-missing' = merge === 'replace' ? 'overwrite' : merge;

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
        mergeMode: perPartMerge,
        ...(ensureActFlag ? { ensureActFlag } : {}),
      });
      if (r.ok) done += 1;
      else failed += 1;
      setPropagateStatus(`Копирование: ${done + failed}/${source.length}…`);
    }

    // Полное замещение. scope=all — у деталей ВНЕ набора снять привязки марок-целей (список
    // деталей цели = набор). scope=акта (G2) — у деталей вне набора снять ГАЛОЧКУ этого акта
    // (набор акта у цели = набор; привязки/детали не трогаются). scope=selected replace не
    // достигает (схлопнут в overwrite).
    let removedParts = 0;
    let removeFailed = 0;
    if (merge === 'replace') {
      const sourceIds = new Set(source.map((r) => r.id));
      const actFlag: 'completeness' | 'defect' | null =
        propagateScope === 'completeness' ? 'completeness' : propagateScope === 'defect' ? 'defect' : null;
      const flagKey = actFlag === 'completeness' ? 'inCompletenessAct' : 'inDefectAct';
      const all = await listAllPartSpecs({});
      if (all.ok) {
        const extras = (all.parts as PartSpecRow[]).filter((p) => {
          if (sourceIds.has(String(p.id))) return false;
          return p.brandLinks.some((l) => {
            if (!group.targetBrandIds.includes(String(l.engineBrandId ?? '').trim())) return false;
            // Для акт-scope в extras берём только детали, у которых этот акт РЕАЛЬНО стоит.
            return actFlag ? Boolean((l as Record<string, unknown>)[flagKey]) : true;
          });
        });
        for (let i = 0; i < extras.length; i += 1) {
          const rr = actFlag
            ? await clearPartSpecBrandLinkActFlagForBrands({ partId: String(extras[i]!.id), brandIds: group.targetBrandIds, actFlag })
            : await removePartSpecBrandLinksForBrands({ partId: String(extras[i]!.id), brandIds: group.targetBrandIds });
          if (rr.ok) {
            const touched = 'removed' in rr ? rr.removed : rr.cleared;
            if (touched > 0) removedParts += 1;
          } else removeFailed += 1;
          setPropagateStatus(`${actFlag ? 'Снятие галочки акта' : 'Удаление лишних'}: ${i + 1}/${extras.length}…`);
        }
      } else {
        removeFailed += 1;
      }
    }

    invalidateListAllPartSpecsCache();
    setPropagateBusy(false);
    const marksLbl = `× ${group.targetBrandIds.length} марок «${group.name}»`;
    const errTail = failed > 0 || removeFailed > 0 ? ` (ошибок: копирование ${failed}, зачистка ${removeFailed})` : '';
    const removedTail =
      merge === 'replace'
        ? isActScope
          ? `, снята галочка акта у ${removedParts} лишних деталей`
          : `, удалено лишних у ${removedParts} деталей`
        : '';
    setPropagateStatus(`Готово: ${done} деталей ${marksLbl}${removedTail}${errTail}.`);
  }

  function toggleSelectPart(id: string, on: boolean) {
    setSelectedPartIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  function clearPartSelection() {
    setSelectedPartIds(new Set());
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
      // Тема F: на свежих установках у engine_brand не засеяны defs `description`/`attachments`
      // (seed давал только name/category_id/attachments; description и вовсе нигде) → setAttr
      // отвечал «Неизвестный атрибут», а файл при этом уже залит и оставался сиротой. Гарантируем
      // defs один раз, если у типа их ещё нет (idempotent — существующие не трогаются).
      if (props.canEdit && fallbackTypeId) {
        try {
          const existing = (await window.matrica.admin.attributeDefs.listByEntityType(fallbackTypeId)) as AttributeDefRow[];
          await ensureAttributeDefs(fallbackTypeId, [
            { code: 'description', name: 'Описание', dataType: 'text', sortOrder: 20 },
            { code: 'attachments', name: 'Вложения', dataType: 'json', sortOrder: 9990 },
          ], existing);
        } catch {
          // best-effort — сохранение всё равно попытается, ошибку покажет пользователю
        }
      }
      const details = await window.matrica.admin.entities.get(props.brandId, fallbackTypeId || undefined);
      const attrs = details?.attributes ?? {};
      setName(String(attrs.name ?? ''));
      setDescription(String(attrs.description ?? ''));
      // Слить три legacy-раздела в один список, дедуп по id (один файл мог быть в двух).
      const toArr = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);
      const legacyDrawings = toArr(attrs.drawings);
      const legacyTechDocs = toArr(attrs.tech_docs);
      const merged: Array<Record<string, unknown>> = [];
      const seen = new Set<string>();
      for (const f of [...toArr(attrs.attachments), ...legacyDrawings, ...legacyTechDocs]) {
        const id = String(f?.id ?? '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        merged.push(f);
      }
      setAttachments(merged);
      setHasLegacyFileAttrs(legacyDrawings.length > 0 || legacyTechDocs.length > 0);
      setStatus('');
      dirtyRef.current = false;
      // Phase 3d: несохранённый снимок (крах / «оставить черновик») побеждает committed-копию.
      // Один раз на маунт карточки (draftRestoredRef) — явный «Сброс» перезагружает committed.
      if (props.canEdit && !draftRestoredRef.current) {
        try {
          const d = await window.matrica.drafts.get({ cardType: DRAFT_CARD_TYPE, cardId: props.brandId });
          if (d.ok && d.draft?.payloadJson) {
            applyDraftSnapshot(JSON.parse(d.draft.payloadJson) as Partial<BrandDraftSnapshot>);
            dirtyRef.current = true;
            draftRestoredRef.current = true;
          }
        } catch {
          // битый/отсутствующий черновик → остаёмся на committed-копии
        }
      }
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

  async function loadBrandParts(opts: { force?: boolean } = {}) {
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
    committedPartsRef.current = rows;
    // Восстановленный recovery-драфт списка не затираем committed-копией (кроме force: Сброс/после сохранения).
    const preserveDraft = !opts.force && dirtyRef.current && draftPartsRestoredRef.current;
    if (!preserveDraft) setBrandParts(rows);
    setPartsStatus('');
    persistBrandSummaryFromRows(rows);
  }

  async function saveName() {
    if (!props.canEdit) return;
    // Имя марки — ключевой идентификатор (наряды, BOM, прогноз). Пустая запись поверх
    // существующего имени превращает марку в UUID во всех списках (инцидент В-84,
    // 2026-07-10: имя перезаписано "" — вероятно, force-save шаренного черновика).
    if (!name.trim()) {
      setStatus('Ошибка: имя марки не может быть пустым — переименуйте или закройте без сохранения');
      return;
    }
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

  async function saveAllAndClose(): Promise<boolean> {
    if (!props.canEdit) return false;
    // Стоп ДО любых записей: иначе успешный saveDescription перетёр бы сообщение об ошибке
    // имени статусом «Сохранено», а оператор решил бы, что всё сохранилось.
    if (!name.trim()) {
      setStatus('Ошибка: имя марки не может быть пустым — переименуйте или закройте без сохранения');
      return false;
    }
    await saveName();
    await saveDescription();
    // Отложенный список деталей: применяем дифф; при частичной ошибке карточка остаётся dirty.
    const partsOk = await applyBrandPartsDiff();
    if (!partsOk) return false;
    // Полный коммит вытесняет recovery-снимок; отменяем отложенный автосейв,
    // чтобы он не переписал черновик после очистки.
    cancelPendingDraftSave();
    await clearDraft();
    dirtyRef.current = false;
    return true;
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

  // Единое «Вложения»: пишем в `attachments`; при первом изменении зануляем legacy-attrs
  // drawings/tech_docs (их содержимое уже слито в `attachments` при загрузке).
  async function saveAttachments(value: unknown) {
    if (!props.canEdit) return { ok: false as const, error: 'no permission' };
    try {
      const r = await window.matrica.admin.entities.setAttr(props.brandId, 'attachments', value, brandTypeId || undefined);
      if (!r?.ok) return { ok: false as const, error: r?.error ?? 'save failed' };
      setAttachments(value);
      if (hasLegacyFileAttrs) {
        // best-effort зачистка legacy-разделов (их файлы уже в общем списке).
        await window.matrica.admin.entities.setAttr(props.brandId, 'drawings', [], brandTypeId || undefined).catch(() => null);
        await window.matrica.admin.entities.setAttr(props.brandId, 'tech_docs', [], brandTypeId || undefined).catch(() => null);
        setHasLegacyFileAttrs(false);
      }
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

  // Отложенное сохранение: правка строки — только драфт-state + dirty; в БД пишет
  // applyBrandPartsDiff по кнопке «Сохранить».
  function markPartsDirty() {
    dirtyRef.current = true;
    setPartsStatus('Изменения списка не сохранены — нажмите «Сохранить».');
  }

  /** Дифф драфта против committed-снапшота -> записи в БД. Возвращает false при ошибках. */
  async function applyBrandPartsDiff(): Promise<boolean> {
    if (!props.canEdit || !props.canEditParts) return true;
    const committed = committedPartsRef.current;
    const draft = brandParts;
    const draftById = new Map(draft.map((r) => [r.id, r] as const));
    const committedById = new Map(committed.map((r) => [r.id, r] as const));
    const removed = committed.filter((r) => !draftById.has(r.id));
    const addedOrChanged = draft.filter((r) => {
      const prev = committedById.get(r.id);
      if (!prev) return true;
      return (
        prev.quantity !== r.quantity ||
        prev.inCompletenessAct !== r.inCompletenessAct ||
        prev.inDefectAct !== r.inDefectAct ||
        prev.assemblyUnitNumber !== r.assemblyUnitNumber
      );
    });
    if (removed.length === 0 && addedOrChanged.length === 0) return true;
    setPartsStatus('Сохранение списка деталей…');
    let failed = 0;
    for (const row of removed) {
      try {
        let linkId = (row.linkId || '').trim();
        if (!linkId) {
          const links = await listPartSpecBrandLinks({ partId: row.id });
          if (!links.ok) throw new Error(links.error ?? 'Не удалось загрузить связи детали');
          const found = links.brandLinks.find((l) => l.engineBrandId === props.brandId);
          if (found?.id) linkId = found.id;
        }
        if (!linkId) continue; // связи и не было (строка добавлена и удалена в драфте)
        const del = await deletePartSpecBrandLink({ partId: row.id, linkId });
        if (!del.ok) throw new Error(del.error ?? 'Не удалось удалить связь');
      } catch (e) {
        failed += 1;
        window.matrica?.log?.send?.('error', `engine_brand_parts diff detach failed: ${String(e)}`).catch(() => {});
      }
    }
    for (const row of addedOrChanged) {
      const r = await upsertBrandPartLink({
        partId: row.id,
        assemblyUnitNumber: row.assemblyUnitNumber === 'не задано' ? '' : row.assemblyUnitNumber,
        quantity: row.quantity,
        inCompletenessAct: row.inCompletenessAct,
        inDefectAct: row.inDefectAct,
        ...(row.linkId ? { linkId: row.linkId } : {}),
      });
      if (!r.ok) failed += 1;
    }
    invalidateListAllPartSpecsCache();
    if (failed > 0) {
      setPartsStatus(`Ошибка: не сохранились изменения по ${failed} деталям — попробуйте «Сохранить» ещё раз.`);
      return false;
    }
    draftPartsRestoredRef.current = false;
    await loadBrandParts({ force: true });
    setPartsStatus('');
    return true;
  }

  // G1 (owner-батч 2026-07-10): массовая простановка/снятие галочки акта у ВСЕХ показанных
  // деталей (текущий срез visibleParts — уважает фильтр/вид). Цикл upsert по деталям с
  // прогрессом и блокировкой повторного клика; useLiveDataRefresh на время правки не мешает
  // (dirtyRef не нужен — правка идёт по одной, но оптимистичный state обновляем сразу).
  const [bulkActBusy] = useState(false);
  function bulkSetActFlag(flag: 'inCompletenessAct' | 'inDefectAct', value: boolean) {
    if (!props.canEdit || !props.canEditParts) return;
    const targets = visibleParts.filter((p) => p.id && p[flag] !== value);
    if (targets.length === 0) return;
    setBrandParts((prev) => prev.map((x) => (targets.some((t) => t.id === x.id) ? { ...x, [flag]: value } : x)));
    markPartsDirty();
  }

  function detachBrandPart(partId: string) {
    if (!props.canEdit || !props.canEditParts) return;
    setBrandParts((prev) => prev.filter((x) => x.id !== partId));
    markPartsDirty();
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

    // Отложенно: строка добавляется в драфт, связь запишется по «Сохранить» (applyBrandPartsDiff).
    setBrandParts((prev) => {
      if (prev.some((p) => p.id === partId)) return prev;
      const label = partsOptions.find((o) => o.id === partId)?.label?.trim() || partId;
      const draftRow: BrandPartRow = {
        id: partId,
        label,
        article: '',
        assemblyUnitNumber,
        quantity: 1,
        inCompletenessAct: false,
        inDefectAct: false,
      };
      return [...prev, draftRow].sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    });
    setAddPartId(null);
    setShowAddPart(false);
    markPartsDirty();
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

  // Phase 3d: debounced recovery-автосейв (~1.5с после последней правки, пока карточка dirty).
  useEffect(() => {
    if (!props.canEdit || !dirtyRef.current) return;
    const snapshot = currentDraftSnapshot();
    const timer = window.setTimeout(() => {
      void saveDraftNow(snapshot);
    }, 1500);
    draftTimerRef.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (draftTimerRef.current === timer) draftTimerRef.current = null;
    };
  }, [name, description, brandParts, props.canEdit]);

  useEffect(() => {
    if (!props.registerCardCloseActions) return;
    props.registerCardCloseActions({
      isDirty: () => dirtyRef.current,
      saveAndClose: async () => {
        await saveAllAndClose();
      },
      reset: async () => {
        dirtyRef.current = false;
        draftPartsRestoredRef.current = false;
        await Promise.all([loadBrand(), loadBrandParts({ force: true })]);
      },
      closeWithoutSave: () => {
        dirtyRef.current = false;
        void clearDraft();
      },
      keepDraft: async () => {
        cancelPendingDraftSave();
        if (props.canEdit) await saveDraftNow(currentDraftSnapshot());
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
  }, [name, description, brandParts, props.registerCardCloseActions]);

  const selectedParts = brandParts;
  const canPropagate = props.canEdit && props.canViewParts && props.canEditParts;
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
          gridTemplateColumns: `${canPropagate ? 'max-content ' : ''}minmax(160px, 1fr) minmax(120px, 220px) max-content max-content max-content max-content`,
          alignItems: 'center',
          gap: 12,
          padding: '8px 10px',
          borderRadius: 0,
          border: '1px solid var(--border)',
          background: selectedPartIds.has(p.id) ? 'rgba(37, 99, 235, 0.08)' : 'var(--surface)',
          cursor: props.canViewParts ? 'pointer' : 'default',
        }}
      >
        {canPropagate ? (
          <label
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
            title="Отметить деталь для распространения на группу"
            onClick={(event) => event.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={selectedPartIds.has(p.id)}
              onChange={(e) => toggleSelectPart(p.id, e.target.checked)}
            />
          </label>
        ) : null}
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
                  markPartsDirty();
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
              markPartsDirty();
            }}
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
          onSaveAndClose={() => { void saveAllAndClose().then((ok) => { if (ok) props.onClose(); }); }}
          onSaveAsDraft={() => {
            void (async () => {
              // Явная парковка в черновик: без записи в EAV; отменяем отложенный
              // автосейв, чтобы он не перештамповал kind обратно в recovery.
              cancelPendingDraftSave();
              const ok = await saveDraftNow(currentDraftSnapshot(), 'explicit');
              if (!ok) {
                setStatus('Ошибка: не удалось сохранить черновик');
                return;
              }
              dirtyRef.current = false;
              props.onClose();
            })();
          }}
          onReset={() => {
            draftPartsRestoredRef.current = false;
            void Promise.all([loadBrand(), loadBrandParts({ force: true })]).then(() => {
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
            <div style={{ width: 'min(600px, 95vw)', maxHeight: '90vh', overflowY: 'auto', background: 'var(--surface)', borderRadius: 14, padding: 16 }} onClick={(e) => e.stopPropagation()}>
              <div style={{ fontWeight: 800, fontSize: 16 }}>Распространить набор деталей на группу</div>
              {propagateGroups.length === 0 ? (
                <div style={{ marginTop: 12, color: 'var(--subtle)' }}>
                  {propagateStatus || 'Эта марка не входит ни в одну группу с другими марками. Добавьте марку в группу в разделе «Группы марок».'}
                </div>
              ) : (
                <>
                  {/* 1. Группа-цель */}
                  <div style={{ marginTop: 12, fontWeight: 700, fontSize: 13 }}>Группа-цель</div>
                  <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {propagateGroups.map((g) => (
                      <label key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 8, background: 'var(--surface-2, rgba(148,163,184,0.10))', cursor: 'pointer' }}>
                        <input type="radio" name="propagate-group" checked={propagateSelId === g.id} onChange={() => setPropagateSelId(g.id)} disabled={propagateBusy} />
                        <span style={{ flex: 1 }}>{g.name}</span>
                        <span style={{ color: 'var(--subtle)', fontSize: 12 }}>{g.targetBrandIds.length} марок-целей</span>
                      </label>
                    ))}
                  </div>

                  {/* 2. Что распространять */}
                  <div style={{ marginTop: 14, fontWeight: 700, fontSize: 13 }}>Что распространять</div>
                  <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {([
                      { id: 'all', label: 'Весь список деталей марки' },
                      { id: 'completeness', label: 'Детали акта комплектности' },
                      { id: 'defect', label: 'Детали акта дефектовки' },
                      { id: 'selected', label: 'Отмеченные детали' },
                    ] as Array<{ id: PropagateScope; label: string }>).map((s) => {
                      const cnt = propagateScopeCounts[s.id];
                      const disabled = propagateBusy || (s.id === 'selected' && cnt === 0);
                      return (
                        <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderRadius: 8, background: 'var(--surface-2, rgba(148,163,184,0.10))', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1 }}>
                          <input
                            type="radio"
                            name="propagate-scope"
                            checked={propagateScope === s.id}
                            disabled={disabled}
                            onChange={() => {
                              setPropagateScope(s.id);
                              // replace допустим для all и актов; уходим на selected с replace — сброс.
                              if (s.id === 'selected' && propagateMerge === 'replace') {
                                setPropagateMerge('add-missing');
                                setPropagateReplaceConfirm(false);
                              }
                            }}
                          />
                          <span style={{ flex: 1 }}>{s.label}</span>
                          <span style={{ color: 'var(--subtle)', fontSize: 12 }}>
                            {s.id === 'selected' && cnt === 0 ? 'отметьте в списке' : `${cnt} шт.`}
                          </span>
                        </label>
                      );
                    })}
                  </div>

                  {/* 3. Как применить */}
                  <div style={{ marginTop: 14, fontWeight: 700, fontSize: 13 }}>Как применить к маркам-целям</div>
                  <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {([
                      { id: 'add-missing', label: 'Только добавить недостающие', hint: 'существующие детали марок не менять; для актов — проставить галочку у уже имеющихся' },
                      { id: 'overwrite', label: 'Обновить совпадающие и добавить недостающие', hint: 'кол-во/узел/галочки совпадающих = как здесь; прочие детали марок оставить' },
                      {
                        id: 'replace',
                        // G2: для акт-scope replace НЕ удаляет детали, а снимает галочку акта у лишних.
                        label: isActScope ? 'Перепривязать акт целиком' : 'Полное замещение',
                        hint: isActScope
                          ? `набор акта у каждой марки станет точно таким — у прочих деталей галочка «${propagateScope === 'completeness' ? 'Акт компл.' : 'Акт деф.'}» будет СНЯТА (привязки и второй акт сохранятся)`
                          : 'список деталей каждой марки станет точно таким — лишние детали у марок будут удалены',
                      },
                    ] as Array<{ id: PropagateMerge; label: string; hint: string }>)
                      .filter((m) => m.id !== 'replace' || propagateScope === 'all' || isActScope)
                      .map((m) => {
                        const danger = m.id === 'replace';
                        return (
                          <label key={m.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 8px', borderRadius: 8, background: danger ? 'rgba(220,38,38,0.08)' : 'var(--surface-2, rgba(148,163,184,0.10))', cursor: propagateBusy ? 'default' : 'pointer' }}>
                            <input
                              type="radio"
                              name="propagate-merge"
                              checked={propagateMerge === m.id}
                              disabled={propagateBusy}
                              style={{ marginTop: 3 }}
                              onChange={() => {
                                setPropagateMerge(m.id);
                                if (m.id !== 'replace') setPropagateReplaceConfirm(false);
                              }}
                            />
                            <span style={{ flex: 1 }}>
                              <span style={{ fontWeight: 600, color: danger ? 'var(--danger)' : undefined }}>{danger ? '⚠️ ' : ''}{m.label}</span>
                              <span style={{ display: 'block', color: 'var(--subtle)', fontSize: 12, marginTop: 2 }}>{m.hint}</span>
                            </span>
                          </label>
                        );
                      })}
                  </div>

                  {propagateMergeEffective === 'replace' ? (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, color: 'var(--danger)', fontSize: 13, cursor: 'pointer' }}>
                      <input type="checkbox" checked={propagateReplaceConfirm} disabled={propagateBusy} onChange={(e) => setPropagateReplaceConfirm(e.target.checked)} />
                      {isActScope
                        ? `Понимаю: у ${propagateSelId ? (propagateGroups.find((g) => g.id === propagateSelId)?.targetBrandIds.length ?? 0) : 0} марок галочка «${propagateScope === 'completeness' ? 'Акт компл.' : 'Акт деф.'}» будет снята у деталей вне этого набора (привязки сохранятся).`
                        : `Понимаю: у ${propagateSelId ? (propagateGroups.find((g) => g.id === propagateSelId)?.targetBrandIds.length ?? 0) : 0} марок будут удалены детали, которых нет в этом наборе.`}
                    </label>
                  ) : null}

                  {/* Резюме */}
                  <div style={{ marginTop: 12, color: 'var(--muted)', fontSize: 12.5, lineHeight: 1.5 }}>
                    {propagateScopeCounts[propagateScope]} деталей ({
                      { all: 'весь список', completeness: 'акт комплектности', defect: 'акт дефектовки', selected: 'отмеченные' }[propagateScope]
                    }) → {propagateSelId ? (propagateGroups.find((g) => g.id === propagateSelId)?.targetBrandIds.length ?? 0) : 0} марок группы.{' '}
                    {propagateMergeEffective === 'add-missing'
                      ? 'Существующие привязки марок не изменятся, добавятся только недостающие.'
                      : propagateMergeEffective === 'overwrite'
                        ? 'Совпадающие привязки перезапишутся, недостающие добавятся, прочие детали марок останутся.'
                        : isActScope
                          ? `Набор акта у марок станет точно равен этому; у прочих деталей галочка акта будет снята (детали НЕ удаляются).`
                          : 'Список деталей марок станет точно равен набору; лишние детали у марок будут удалены.'}
                  </div>

                  {propagateStatus ? <div style={{ marginTop: 10, color: propagateStatus.includes('ошиб') ? 'var(--danger)' : 'var(--subtle)', fontSize: 13 }}>{propagateStatus}</div> : null}
                </>
              )}
              <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Button variant="ghost" onClick={() => setPropagateOpen(false)} disabled={propagateBusy}>Закрыть</Button>
                {propagateGroups.length > 0 ? (
                  <Button
                    variant="ghost"
                    tone="success"
                    onClick={() => void runPropagate()}
                    disabled={propagateBusy || !propagateSelId || propagateScopeCounts[propagateScope] === 0 || (propagateMergeEffective === 'replace' && !propagateReplaceConfirm)}
                  >
                    {propagateBusy ? 'Выполняю…' : 'Распространить'}
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
        <div style={{ marginBottom: 10, color: 'var(--subtle)', fontSize: 13 }}>
            Видов деталей: {totalPartKinds}, всего штук: {totalPartsQty}
        </div>

        {showAddPart && props.canViewParts && props.canEditParts && (
          <div style={{ marginBottom: 10 }}>
            <EntityReferenceField
              target="part"
              targetLabel="Деталь"
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
              onOpen={props.onOpenPart}
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
            {props.canEdit && props.canEditParts ? (
              <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--subtle)', whiteSpace: 'nowrap' }}>Все показанные:</span>
                <Button
                  variant="ghost"
                  disabled={bulkActBusy || visibleParts.length === 0}
                  title="Проставить «Акт компл.» всем показанным деталям"
                  onClick={() => void bulkSetActFlag('inCompletenessAct', true)}
                >
                  ✔ Компл.
                </Button>
                <Button
                  variant="ghost"
                  disabled={bulkActBusy || visibleParts.length === 0}
                  title="Снять «Акт компл.» со всех показанных деталей"
                  onClick={() => void bulkSetActFlag('inCompletenessAct', false)}
                >
                  ✖ Компл.
                </Button>
                <Button
                  variant="ghost"
                  disabled={bulkActBusy || visibleParts.length === 0}
                  title="Проставить «Акт деф.» всем показанным деталям"
                  onClick={() => void bulkSetActFlag('inDefectAct', true)}
                >
                  ✔ Деф.
                </Button>
                <Button
                  variant="ghost"
                  disabled={bulkActBusy || visibleParts.length === 0}
                  title="Снять «Акт деф.» со всех показанных деталей"
                  onClick={() => void bulkSetActFlag('inDefectAct', false)}
                >
                  ✖ Деф.
                </Button>
              </span>
            ) : null}
            {canPropagate ? (
              <>
                <Button
                  variant="ghost"
                  title="Отметить/снять все показанные детали (для распространения на группу)"
                  onClick={() => {
                    setSelectedPartIds((prev) => {
                      const next = new Set(prev);
                      const allSelected = visibleParts.length > 0 && visibleParts.every((p) => next.has(p.id));
                      for (const p of visibleParts) {
                        if (allSelected) next.delete(p.id);
                        else next.add(p.id);
                      }
                      return next;
                    });
                  }}
                >
                  {visibleParts.length > 0 && visibleParts.every((p) => selectedPartIds.has(p.id)) ? 'Снять показанные' : 'Выбрать показанные'}
                </Button>
                {selectedPartIds.size > 0 ? (
                  <span style={{ fontSize: 12, color: 'var(--subtle)', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    выбрано: {selectedPartIds.size}
                    <button
                      type="button"
                      onClick={() => clearPartSelection()}
                      style={{ background: 'none', border: 'none', color: 'var(--link, #2563eb)', cursor: 'pointer', padding: 0, fontSize: 12 }}
                    >
                      снять
                    </button>
                  </span>
                ) : null}
              </>
            ) : null}
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
        title="Вложения"
        value={attachments}
        canView={props.canViewFiles}
        canUpload={props.canUploadFiles && props.canEdit}
        scope={{ ownerType: 'engine_brand', ownerId: props.brandId, category: 'attachments' }}
        onChange={(next) => saveAttachments(next)}
      />

      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div>}
      </div>
    </div>
  );
}
