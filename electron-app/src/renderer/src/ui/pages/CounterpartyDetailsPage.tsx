import React, { useCallback, useEffect, useRef, useState } from 'react';

import { CardActionBar } from '../components/CardActionBar.js';
import type { CardCloseActions } from '../cardCloseTypes.js';
import { Input } from '../components/Input.js';
import { AttachmentsPanel } from '../components/AttachmentsPanel.js';
import { DraggableFieldList } from '../components/DraggableFieldList.js';
import { SectionCard } from '../components/SectionCard.js';
import { ensureAttributeDefs, orderFieldsByDefs, persistFieldOrder, type AttributeDefRow } from '../utils/fieldOrder.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { useDraftWriteGuard } from '../hooks/useDraftWriteGuard.js';
import type { CounterpartyStrictRow } from '@matricarmz/shared';

// Ядро карточки — строгая реплика/двери (план contract-cutover-2026-10, C2).
// Вложения остаются в EAV (в strict-зеркале их нет).
const COUNTERPARTY_CORE_CODES = new Set(['name', 'short_name', 'inn', 'kpp', 'address', 'phone', 'email']);

type CounterpartyEntity = {
  id: string;
  typeId: string;
  createdAt: number;
  updatedAt: number;
  attributes: Record<string, unknown>;
};

export function CounterpartyDetailsPage(props: {
  counterpartyId: string;
  canEdit: boolean;
  canViewFiles: boolean;
  canUploadFiles: boolean;
  onClose: () => void;
  registerCardCloseActions?: (actions: CardCloseActions | null) => void;
  requestClose?: () => void;
}) {
  const [entity, setEntity] = useState<CounterpartyEntity | null>(null);
  const [strict, setStrict] = useState<CounterpartyStrictRow | null>(null);
  const [defs, setDefs] = useState<AttributeDefRow[]>([]);
  const [status, setStatus] = useState<string>('');
  const [typeId, setTypeId] = useState<string>('');
  const [coreDefsReady, setCoreDefsReady] = useState(false);

  const [name, setName] = useState<string>('');
  const [shortName, setShortName] = useState<string>('');
  const [inn, setInn] = useState<string>('');
  const [kpp, setKpp] = useState<string>('');
  const [address, setAddress] = useState<string>('');
  const [phone, setPhone] = useState<string>('');
  const [email, setEmail] = useState<string>('');
  const [attachments, setAttachments] = useState<unknown>([]);
  const dirtyRef = useRef(false);
  // Сброс обязан пересевать форму даже когда updatedAt не изменился (иначе ресид-эффект
  // по тем же deps пропускает перезагрузку и сброс мёртвый): ключ форсирует прогон.
  const [reseedKey, setReseedKey] = useState(0);
  // Phase 3d: recovery-draft движок пилота (наряды/заявки/товары). Снимок = локальные
  // несохранённые поля (файлы вложений грузятся сразу — в черновик едет только их JSON-список).
  const draftTimerRef = useRef<number | null>(null);
  const draftRestoredRef = useRef(false);
  const { guardDraftWrite, awaitPendingDraftWrite } = useDraftWriteGuard();
  const DRAFT_CARD_TYPE = 'counterparty';

  type CounterpartyDraftSnapshot = {
    name: string;
    shortName: string;
    inn: string;
    kpp: string;
    address: string;
    phone: string;
    email: string;
    attachments: unknown;
  };

  function currentDraftSnapshot(): CounterpartyDraftSnapshot {
    return { name, shortName, inn, kpp, address, phone, email, attachments };
  }

  function buildDraftTitle(s: CounterpartyDraftSnapshot): string {
    return `Контрагент «${s.name.trim() || 'без названия'}»`;
  }

  async function saveDraftNow(s: CounterpartyDraftSnapshot, kind: 'recovery' | 'explicit' = 'recovery') {
    if (!props.canEdit) return false;
    return guardDraftWrite(async () => {
      try {
        const r = await window.matrica.drafts.save({
          cardType: DRAFT_CARD_TYPE,
          cardId: props.counterpartyId,
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
    });
  }

  async function clearDraft() {
    await awaitPendingDraftWrite();
    try {
      await window.matrica.drafts.clear({ cardType: DRAFT_CARD_TYPE, cardId: props.counterpartyId });
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

  function applyDraftSnapshot(s: Partial<CounterpartyDraftSnapshot>) {
    setName(String(s.name ?? ''));
    setShortName(String(s.shortName ?? ''));
    setInn(String(s.inn ?? ''));
    setKpp(String(s.kpp ?? ''));
    setAddress(String(s.address ?? ''));
    setPhone(String(s.phone ?? ''));
    setEmail(String(s.email ?? ''));
    setAttachments(Array.isArray(s.attachments) ? s.attachments : []);
  }

  const load = useCallback(async () => {
    try {
      setStatus('Загрузка…');
      const types = await window.matrica.admin.entityTypes.list();
      const type = (types as any[]).find((t) => String(t.code) === 'customer') ?? null;
      if (!type?.id) {
        setEntity(null);
        setStatus('Справочник «Контрагенты» не найден (customer).');
        return;
      }
      setTypeId(String(type.id));
      // fallbackTypeId: a not-yet-saved (deferred-create) card has no row — synthesize an empty
      // card so it opens instead of throwing. For existing entities the fallback is ignored.
      const details = await window.matrica.admin.entities.get(props.counterpartyId, String(type.id));
      setEntity(details as any);
      // Ядро — из строгой реплики; если её нет (холодный pull / запись старого
      // клиента ещё не дозеркалена) — из EAV. Вложения всегда из EAV.
      try {
        const s = (await window.matrica.contracts.counterparty.get(props.counterpartyId)) as
          | { ok: boolean; row?: CounterpartyStrictRow | null }
          | null;
        setStrict(s && s.ok ? (s.row ?? null) : null);
      } catch {
        setStrict(null);
      }
      const defsList = await window.matrica.admin.attributeDefs.listByEntityType(String(type.id));
      setDefs(defsList as AttributeDefRow[]);
      setCoreDefsReady(false);
      setStatus('');
      dirtyRef.current = false;
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [props.counterpartyId]);

  useEffect(() => {
    void load();
  }, [load]);

  useLiveDataRefresh(
    async () => {
      if (dirtyRef.current) return;
      await load();
    },
    { intervalMs: 20000 },
  );

  useEffect(() => {
    if (!props.canEdit || !typeId || defs.length === 0 || coreDefsReady) return;
    const desired = [
      { code: 'name', name: 'Название', dataType: 'text', sortOrder: 10 },
      { code: 'short_name', name: 'Краткое наименование', dataType: 'text', sortOrder: 15 },
      { code: 'inn', name: 'ИНН', dataType: 'text', sortOrder: 20 },
      { code: 'kpp', name: 'КПП', dataType: 'text', sortOrder: 30 },
      { code: 'address', name: 'Адрес', dataType: 'text', sortOrder: 40 },
      { code: 'phone', name: 'Телефон', dataType: 'text', sortOrder: 50 },
      { code: 'email', name: 'Email', dataType: 'text', sortOrder: 60 },
      { code: 'attachments', name: 'Вложения', dataType: 'json', sortOrder: 300 },
    ];
    void ensureAttributeDefs(typeId, desired, defs).then((next) => {
      if (next.length !== defs.length) setDefs(next);
      setCoreDefsReady(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot core-def bootstrap per loaded card; `defs.length` is the deliberate trigger, depending on the `defs` array identity would re-fire the attribute-def write on every setDefs (e.g. field reorder)
  }, [props.canEdit, typeId, defs.length, coreDefsReady]);

  useEffect(() => {
    if (!entity) return;
    // Перезагрузка поверх несохранённых правок запрещена (баг 10.10.2026, #1240):
    // сохранение вложений бампало updatedAt и ресид затирал форму.
    if (dirtyRef.current) return;
    const attrs = entity.attributes ?? {};
    // Ядро предпочитает strict; EAV — переходный фолбэк. Вложения всегда из EAV.
    const core = (strict ?? attrs) as Record<string, unknown>;
    setName(String(core.name ?? ''));
    setShortName(String(core.short_name ?? ''));
    setInn(String(core.inn ?? ''));
    setKpp(String(core.kpp ?? ''));
    setAddress(String(core.address ?? ''));
    setPhone(String(core.phone ?? ''));
    setEmail(String(core.email ?? ''));
    setAttachments(attrs.attachments ?? []);
    dirtyRef.current = false;
    // Phase 3d: несохранённый снимок (крах / «оставить черновик») побеждает committed-копию.
    // Один раз на маунт карточки (draftRestoredRef) — явный «Сброс» перезагружает committed.
    // Восстановление здесь, а не в load(): именно этот эффект заполняет поля из entity и
    // иначе перетёр бы применённый снимок.
    if (props.canEdit && !draftRestoredRef.current) {
      void (async () => {
        try {
          const d = await window.matrica.drafts.get({ cardType: DRAFT_CARD_TYPE, cardId: props.counterpartyId });
          if (d.ok && d.draft?.payloadJson) {
            applyDraftSnapshot(JSON.parse(d.draft.payloadJson) as Partial<CounterpartyDraftSnapshot>);
            dirtyRef.current = true;
            draftRestoredRef.current = true;
          }
        } catch {
          // битый/отсутствующий черновик → остаёмся на committed-копии
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- field hydration is deliberately keyed on the loaded entity version and the strict row version; re-running on the `entity` object identity, on canEdit, or on the per-render `applyDraftSnapshot` would overwrite the user's in-progress edits
  }, [entity?.id, entity?.updatedAt, strict?.updated_at, reseedKey]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the 1.5s debounce must restart only on an actual field edit; currentDraftSnapshot/saveDraftNow are re-created every render, so depending on them would re-arm the timer on every render and the autosave would never fire
  }, [name, shortName, inn, kpp, address, phone, email, attachments, props.canEdit]);

  useEffect(() => {
    if (!props.registerCardCloseActions) return;
    props.registerCardCloseActions({
      isDirty: () => dirtyRef.current,
      saveAndClose: async () => {
        if (!(await saveAllAndClose())) throw new Error('сохранение не удалось — панель оставлена открытой');
      },
      reset: async () => {
        // Канон сброса (#1240, карточка двигателя): грязь и черновик — ДО перезагрузки,
        // плюс ключ пересева (updatedAt без записи не меняется и ресид иначе пропускается).
        dirtyRef.current = false;
        cancelPendingDraftSave();
        await clearDraft();
        draftRestoredRef.current = false;
        setReseedKey((k) => k + 1);
        await load();
      },
      closeWithoutSave: () => {
        cancelPendingDraftSave();
        dirtyRef.current = false;
        void clearDraft();
      },
      keepDraft: async () => {
        cancelPendingDraftSave();
        if (props.canEdit) await saveDraftNow(currentDraftSnapshot());
        dirtyRef.current = false;
      },
      copyToNew: async () => {
        if (!typeId) return;
        const r = (await window.matrica.contracts.counterparty.create({
          fields: {
            name: name.trim() + ' (копия)',
            short_name: shortName.trim() || null,
            inn: inn.trim() || null,
            kpp: kpp.trim() || null,
            address: address.trim() || null,
            phone: phone.trim() || null,
            email: email.trim() || null,
          },
        })) as { ok: boolean; error?: string } | null;
        if (!r?.ok) setStatus(`Ошибка: ${(r as { error?: string } | null)?.error ?? 'unknown'}`);
      },
    });
    return () => { props.registerCardCloseActions?.(null); };
    // attachments в deps: keepDraft/saveAndClose снимают снимок из замыкания — без него
    // зарегистрированные actions видели бы устаревший список вложений.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-registration is deliberately keyed on the edited values the close actions capture; clearDraft/currentDraftSnapshot/saveAllAndClose/saveDraftNow and the whole `props` object are re-created every render, so depending on them would unregister+re-register the card close actions on every render
  }, [name, shortName, inn, kpp, address, phone, email, attachments, typeId, props.registerCardCloseActions]);

  async function saveAttr(code: string, value: unknown): Promise<boolean> {
    if (!props.canEdit) return false;
    try {
      setStatus('Сохранение…');
      // Ядро — серверной дверью в strict; остальное (вложения) — прежним EAV-путём.
      // fallbackTypeId materializes the row on the first write for a deferred card.
      if (COUNTERPARTY_CORE_CODES.has(code)) {
        const r = (await window.matrica.contracts.counterparty.save({
          id: props.counterpartyId,
          fields: { [code]: value },
        })) as { ok: boolean; row?: CounterpartyStrictRow; error?: string } | null;
        if (!r?.ok) {
          setStatus(`Ошибка: ${(r as { error?: string } | null)?.error ?? 'unknown'}`);
          return false;
        }
        if (r.row) {
          setStrict(r.row);
          applyStrictRow(r.row);
        }
        setStatus('Сохранено');
        setTimeout(() => setStatus(''), 900);
        return true;
      }
      const r = await window.matrica.admin.entities.setAttr(props.counterpartyId, code, value, typeId || undefined);
      if (!r?.ok) {
        setStatus(`Ошибка: ${r?.error ?? 'unknown'}`);
        return false;
      }
      // Без перезагрузки: стейт уже держит записанное значение, а релоад бампал
      // updatedAt и ресид-эффект затирал форму поверх несохранённых правок (#1240).
      setStatus('Сохранено');
      setTimeout(() => setStatus(''), 900);
      return true;
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
      return false;
    }
  }

  function applyStrictRow(row: CounterpartyStrictRow) {
    setName(String(row.name ?? ''));
    setShortName(String(row.short_name ?? ''));
    setInn(String(row.inn ?? ''));
    setKpp(String(row.kpp ?? ''));
    setAddress(String(row.address ?? ''));
    setPhone(String(row.phone ?? ''));
    setEmail(String(row.email ?? ''));
  }

  async function saveAllAndClose(): Promise<boolean> {
    if (props.canEdit) {
      // Ядро — одним патчем в дверь (не семью round-trip), вложения — прежним путём.
      const r = (await window.matrica.contracts.counterparty.save({
        id: props.counterpartyId,
        fields: {
          name: name.trim(),
          short_name: shortName.trim() || null,
          inn: inn.trim() || null,
          kpp: kpp.trim() || null,
          address: address.trim() || null,
          phone: phone.trim() || null,
          email: email.trim() || null,
        },
      })) as { ok: boolean; row?: CounterpartyStrictRow; error?: string } | null;
      if (!r?.ok) {
        setStatus(`Ошибка: ${(r as { error?: string } | null)?.error ?? 'unknown'}`);
        return false;
      }
      if (r.row) {
        setStrict(r.row);
        applyStrictRow(r.row);
      }
      // Вложения при провале не чистят черновик: иначе теряется копия (#1240).
      if (!(await saveAttr('attachments', attachments))) return false;
      // Полный коммит вытесняет recovery-снимок; отменяем отложенный автосейв,
      // чтобы он не переписал черновик после очистки.
      cancelPendingDraftSave();
      await clearDraft();
      setStatus('Сохранено');
      setTimeout(() => setStatus(''), 900);
    }
    dirtyRef.current = false;
    return true;
  }

  async function handleDelete() {
    if (!props.canEdit) return;
    try {
      setStatus('Удаление…');
      const r = await window.matrica.admin.entities.softDelete(props.counterpartyId);
      if (!r?.ok) {
        setStatus(`Ошибка: ${r?.error ?? 'unknown'}`);
        return;
      }
      setStatus('Удалено');
      setTimeout(() => setStatus(''), 900);
      props.onClose();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  if (!entity) {
    return <div>{status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div>}</div>;
  }

  const mainFields = orderFieldsByDefs(
    [
      {
        code: 'name',
        defaultOrder: 10,
        label: 'Название',
        value: name,
        render: (
          <Input value={name} disabled={!props.canEdit} onChange={(e) => { setName(e.target.value); dirtyRef.current = true; }} />
        ),
      },
      {
        code: 'short_name',
        defaultOrder: 15,
        label: 'Краткое наименование',
        value: shortName,
        render: (
          <Input
            value={shortName}
            disabled={!props.canEdit}
            placeholder="Для печати в наряде (если пусто — полное имя)"
            onChange={(e) => { setShortName(e.target.value); dirtyRef.current = true; }}
          />
        ),
      },
      {
        code: 'inn',
        defaultOrder: 20,
        label: 'ИНН',
        value: inn,
        render: (
          <Input value={inn} disabled={!props.canEdit} onChange={(e) => { setInn(e.target.value); dirtyRef.current = true; }} />
        ),
      },
      {
        code: 'kpp',
        defaultOrder: 30,
        label: 'КПП',
        value: kpp,
        render: (
          <Input value={kpp} disabled={!props.canEdit} onChange={(e) => { setKpp(e.target.value); dirtyRef.current = true; }} />
        ),
      },
      {
        code: 'address',
        defaultOrder: 40,
        label: 'Адрес',
        value: address,
        render: (
          <Input value={address} disabled={!props.canEdit} onChange={(e) => { setAddress(e.target.value); dirtyRef.current = true; }} />
        ),
      },
      {
        code: 'phone',
        defaultOrder: 50,
        label: 'Телефон',
        value: phone,
        render: (
          <Input value={phone} disabled={!props.canEdit} onChange={(e) => { setPhone(e.target.value); dirtyRef.current = true; }} />
        ),
      },
      {
        code: 'email',
        defaultOrder: 60,
        label: 'Email',
        value: email,
        render: (
          <Input value={email} disabled={!props.canEdit} onChange={(e) => { setEmail(e.target.value); dirtyRef.current = true; }} />
        ),
      },
      {
        code: 'attachments',
        defaultOrder: 300,
        label: 'Вложения',
        value: Array.isArray(attachments) ? attachments.length : 0,
        render: (
          <AttachmentsPanel
            title="Вложения"
            value={attachments}
            canView={props.canViewFiles}
            canUpload={props.canUploadFiles && props.canEdit}
            scope={{ ownerType: 'customer', ownerId: entity.id, category: 'attachments' }}
            onChange={(next) => {
              dirtyRef.current = true;
              setAttachments(next);
              return Promise.resolve({ ok: true as const });
            }}
          />
        ),
      },
    ],
    defs,
  );

  const headerTitle = name.trim() ? name.trim() : 'Карточка контрагента';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ flexShrink: 0, borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
        <CardActionBar
          canEdit={props.canEdit}
          onCopyToNew={() => {
            void (async () => {
              if (!typeId) return;
              const created = await window.matrica.admin.entities.create(typeId);
              if (created?.ok && 'id' in created) {
                await window.matrica.admin.entities.setAttr(created.id, 'name', name.trim() + ' (копия)');
                await window.matrica.admin.entities.setAttr(created.id, 'inn', inn.trim() || null);
                await window.matrica.admin.entities.setAttr(created.id, 'kpp', kpp.trim() || null);
                await window.matrica.admin.entities.setAttr(created.id, 'address', address.trim() || null);
                await window.matrica.admin.entities.setAttr(created.id, 'phone', phone.trim() || null);
                await window.matrica.admin.entities.setAttr(created.id, 'email', email.trim() || null);
              }
            })();
          }}
          onSave={() => { void saveAllAndClose().catch(() => undefined); }}
          onSaveAndClose={() => { void saveAllAndClose().then((ok) => { if (ok) props.onClose(); }).catch(() => undefined); }}
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
            void (async () => {
              dirtyRef.current = false;
              cancelPendingDraftSave();
              await clearDraft();
              draftRestoredRef.current = false;
              setReseedKey((k) => k + 1);
              await load();
            })();
          }}
          onDelete={() => void handleDelete()}
          deleteConfirmDetail={`Будет удалён контрагент «${name.trim() || props.counterpartyId}»${inn.trim() ? ` (ИНН ${inn.trim()})` : ''}.`}
          onClose={() => props.requestClose?.()}
        />
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: 20, fontWeight: 800 }}>{headerTitle}</div>
        <div style={{ flex: 1 }} />
        {status && <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)', fontSize: 12 }}>{status}</div>}
      </div>

      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', paddingTop: 12 }}>
        <SectionCard style={{ padding: 12 }}>
          <DraggableFieldList
            items={mainFields}
            getKey={(f) => f.code}
            canDrag={props.canEdit}
            onReorder={(next) => {
              if (!typeId) return;
              void persistFieldOrder(
                next.map((f) => f.code),
                defs,
                { entityTypeId: typeId },
              ).then(() => setDefs([...defs]));
            }}
            renderItem={(field, itemProps, _dragHandleProps, state) => (
              <div
                {...itemProps}
                className="card-row"
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(160px, 200px) 1fr',
                  gap: 8,
                  alignItems: 'center',
                  padding: '4px 6px',
                  border: state.isOver ? '1px dashed var(--input-border-focus)' : '1px solid var(--card-row-border)',
                  background: state.isDragging ? 'var(--card-row-drag-bg)' : undefined,
                }}
              >
                <div style={{ color: 'var(--subtle)' }}>{field.label}</div>
                {field.render}
              </div>
            )}
          />
        </SectionCard>
      </div>
    </div>
  );
}
