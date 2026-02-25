import React, { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { EntityCardShell } from '../components/EntityCardShell.js';
import { CardActionBar } from '../components/CardActionBar.js';
import type { CardCloseActions } from '../cardCloseTypes.js';
import { SectionCard } from '../components/SectionCard.js';
import { AttachmentsPanel } from '../components/AttachmentsPanel.js';
import { DraggableFieldList } from '../components/DraggableFieldList.js';
import { SearchSelectWithCreate } from '../components/SearchSelectWithCreate.js';
import { useFileUploadFlow } from '../hooks/useFileUploadFlow.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import type { FileRef } from '@matricarmz/shared';
import { ensureAttributeDefs, orderFieldsByDefs, persistFieldOrder, type AttributeDefRow } from '../utils/fieldOrder.js';

export function SimpleMasterdataDetailsPage(props: {
  title: string;
  entityId: string;
  ownerType?: string;
  typeCode?: string;
  canEdit: boolean;
  canViewFiles: boolean;
  canUploadFiles: boolean;
  onClose: () => void;
  registerCardCloseActions?: (actions: CardCloseActions | null) => void;
  requestClose?: () => void;
}) {
  const [status, setStatus] = useState<string>('');
  const [name, setName] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [attachments, setAttachments] = useState<unknown>([]);
  const [shop, setShop] = useState<string>('');
  const [article, setArticle] = useState<string>('');
  const [unit, setUnit] = useState<string>('');
  const [price, setPrice] = useState<string>('');
  const [photos, setPhotos] = useState<FileRef[]>([]);
  const [mainPhotoId, setMainPhotoId] = useState<string | null>(null);
  const [photoThumbs, setPhotoThumbs] = useState<Record<string, { dataUrl: string | null; status: 'idle' | 'loading' | 'done' | 'error' }>>({});
  const thumbsRef = useRef(photoThumbs);
  const [entityTypeId, setEntityTypeId] = useState<string>('');
  const [defs, setDefs] = useState<AttributeDefRow[]>([]);
  const [coreDefsReady, setCoreDefsReady] = useState(false);
  const [unitOptions, setUnitOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [storeOptions, setStoreOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [unitTypeId, setUnitTypeId] = useState<string>('');
  const [storeTypeId, setStoreTypeId] = useState<string>('');
  const uploadFlow = useFileUploadFlow();
  const dirtyRef = useRef(false);

  async function load() {
    try {
      setStatus('Загрузка…');
      const details = await window.matrica.admin.entities.get(props.entityId);
      const attrs = details?.attributes ?? {};
      setName(String(attrs.name ?? ''));
      setDescription(String(attrs.description ?? ''));
      setAttachments(attrs.attachments ?? []);
      setShop(String(attrs.shop ?? ''));
      setArticle(String(attrs.article ?? ''));
      setUnit(String(attrs.unit ?? ''));
      setPrice(attrs.price != null ? String(attrs.price) : '');
      const nextPhotos = Array.isArray(attrs.photos) ? attrs.photos.filter(isFileRef) : [];
      setPhotos(nextPhotos);
      setMainPhotoId(nextPhotos[0]?.id ?? null);
      dirtyRef.current = false;
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function loadDefs() {
    if (!props.typeCode) return;
    try {
      const types = await window.matrica.admin.entityTypes.list();
      const type = (types as any[]).find((t) => String(t.code) === String(props.typeCode)) ?? null;
      if (!type?.id) return;
      setEntityTypeId(String(type.id));
      const rows = await window.matrica.admin.attributeDefs.listByEntityType(String(type.id));
      setDefs(rows as AttributeDefRow[]);
      setCoreDefsReady(false);
    } catch {
      setDefs([]);
    }
  }

  function isFileRef(x: any): x is FileRef {
    return x && typeof x === 'object' && typeof x.id === 'string' && typeof x.name === 'string';
  }

  useEffect(() => {
    thumbsRef.current = photoThumbs;
  }, [photoThumbs]);

  useEffect(() => {
    if (!props.canViewFiles) return;
    let alive = true;
    const run = async () => {
      for (const f of photos) {
        if (!alive) return;
        const cur = thumbsRef.current[f.id];
        if (cur && (cur.status === 'loading' || cur.status === 'done' || cur.status === 'error')) continue;
        setPhotoThumbs((p) => ({ ...p, [f.id]: { dataUrl: null, status: 'loading' } }));
        try {
          const r = await window.matrica.files.previewGet({ fileId: f.id });
          if (!alive) return;
          if (r.ok) setPhotoThumbs((p) => ({ ...p, [f.id]: { dataUrl: r.dataUrl ?? null, status: 'done' } }));
          else setPhotoThumbs((p) => ({ ...p, [f.id]: { dataUrl: null, status: 'error' } }));
        } catch {
          if (!alive) return;
          setPhotoThumbs((p) => ({ ...p, [f.id]: { dataUrl: null, status: 'error' } }));
        }
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [props.canViewFiles, photos]);

  useEffect(() => {
    void loadDefs();
  }, [props.typeCode]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const types = await window.matrica.admin.entityTypes.list();
        const unitType = (types as any[]).find((t) => String(t.code) === 'unit') ?? null;
        const storeType = (types as any[]).find((t) => String(t.code) === 'customer') ?? null;
        if (!alive) return;
        setUnitTypeId(unitType?.id ? String(unitType.id) : '');
        setStoreTypeId(storeType?.id ? String(storeType.id) : '');
        if (unitType?.id) {
          const rows = await window.matrica.admin.entities.listByEntityType(String(unitType.id));
          const opts = (rows as any[]).map((r) => ({ id: String(r.id), label: String(r.displayName ?? r.id) }));
          opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
          setUnitOptions(opts);
        }
        if (storeType?.id) {
          const rows = await window.matrica.admin.entities.listByEntityType(String(storeType.id));
          const opts = (rows as any[]).map((r) => ({ id: String(r.id), label: String(r.displayName ?? r.id) }));
          opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
          setStoreOptions(opts);
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function createLookupEntity(typeId: string, label: string) {
    const name = label.trim();
    if (!typeId || !name) return null;
    const created = await window.matrica.admin.entities.create(typeId);
    if (!created?.ok || !created.id) return null;
    await window.matrica.admin.entities.setAttr(created.id, 'name', name);
    return created.id;
  }

  useEffect(() => {
    if (!props.canEdit || !entityTypeId || defs.length === 0 || coreDefsReady) return;
    const desired = [
      { code: 'name', name: 'Название', dataType: 'text', sortOrder: 10 },
      { code: 'description', name: 'Описание', dataType: 'text', sortOrder: 20 },
      { code: 'shop', name: 'Магазин', dataType: 'text', sortOrder: 30 },
      { code: 'article', name: 'Артикул', dataType: 'text', sortOrder: 40 },
      { code: 'unit', name: 'Ед. измерения', dataType: 'text', sortOrder: 50 },
      { code: 'price', name: 'Цена', dataType: 'number', sortOrder: 60 },
      { code: 'attachments', name: 'Вложения', dataType: 'json', sortOrder: 300 },
      { code: 'photos', name: 'Фото', dataType: 'json', sortOrder: 310 },
    ];
    void ensureAttributeDefs(entityTypeId, desired, defs).then((next) => {
      if (next.length !== defs.length) setDefs(next);
      setCoreDefsReady(true);
    });
  }, [props.canEdit, entityTypeId, defs.length, coreDefsReady]);

  async function saveName() {
    if (!props.canEdit) return;
    try {
      setStatus('Сохранение…');
      await window.matrica.admin.entities.setAttr(props.entityId, 'name', name.trim());
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
      await window.matrica.admin.entities.setAttr(props.entityId, 'description', description.trim() || null);
      setStatus('Сохранено');
      setTimeout(() => setStatus(''), 700);
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function saveFiles(code: 'attachments' | 'photos', value: unknown, setter: (v: unknown) => void) {
    if (!props.canEdit) return { ok: false as const, error: 'no permission' };
    try {
      const r = await window.matrica.admin.entities.setAttr(props.entityId, code, value);
      if (!r?.ok) return { ok: false as const, error: r?.error ?? 'save failed' };
      setter(value);
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  }

  async function saveField(code: string, value: unknown) {
    if (!props.canEdit) return;
    try {
      setStatus('Сохранение…');
      await window.matrica.admin.entities.setAttr(props.entityId, code, value);
      setStatus('Сохранено');
      setTimeout(() => setStatus(''), 700);
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function saveAllAndClose() {
    if (props.canEdit) {
      await saveName();
      await saveDescription();
      await saveField('shop', shop.trim() || null);
      await saveField('article', article.trim() || null);
      await saveField('unit', unit.trim() || null);
      await saveField('price', price ? Number(price) : null);
    }
    dirtyRef.current = false;
  }

  async function handleDelete() {
    if (!props.canEdit) return;
    if (!confirm('Удалить запись?')) return;
    try {
      setStatus('Удаление…');
      const r = await window.matrica.admin.entities.softDelete(props.entityId);
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

  useEffect(() => {
    void load();
  }, [props.entityId]);

  useEffect(() => {
    if (!props.registerCardCloseActions) return;
    props.registerCardCloseActions({
      isDirty: () => dirtyRef.current,
      saveAndClose: async () => {
        await saveAllAndClose();
      },
      reset: async () => {
        await load();
        dirtyRef.current = false;
      },
      closeWithoutSave: () => {
        dirtyRef.current = false;
      },
      copyToNew: async () => {
        if (!entityTypeId) return;
        const created = await window.matrica.admin.entities.create(entityTypeId);
        if (created?.ok && 'id' in created) {
          await window.matrica.admin.entities.setAttr(created.id, 'name', name.trim() + ' (копия)');
        }
      },
    });
    return () => { props.registerCardCloseActions?.(null); };
  }, [name, entityTypeId, props.registerCardCloseActions]);

  useLiveDataRefresh(
    async () => {
      if (dirtyRef.current) return;
      await load();
    },
    { intervalMs: 20000 },
  );

  const ownerType = props.ownerType ?? 'masterdata';
  const activePhoto = useMemo(() => photos.find((p) => p.id === mainPhotoId) ?? photos[0] ?? null, [photos, mainPhotoId]);
  const photosBlock = (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <strong>Фото</strong>
        <div style={{ flex: 1 }} />
        {props.canUploadFiles && props.canEdit && (
          <Button
            variant="ghost"
            onClick={async () => {
              const pickResult = await window.matrica.files.pick();
              if (!pickResult.ok || !pickResult.paths?.length) return;
              const uploads = await uploadFlow.buildTasks(pickResult.paths);
              if (!uploads) {
                uploadFlow.setStatusWithTimeout('Загрузка отменена пользователем', 1500);
                return;
              }
              uploadFlow.setStatus('');
              const uploadResult = await uploadFlow.runUploads<FileRef>(
                uploads,
                async (task) => {
                  const r = await window.matrica.files.upload({
                    path: task.path,
                    fileName: task.fileName,
                    scope: { ownerType, ownerId: props.entityId, category: 'photos' },
                  });
                  return r.ok ? { ok: true as const, value: r.file } : { ok: false as const, error: r.error };
                },
                { continueOnError: true },
              );
              const added = uploadResult.successes.map((x) => x.value);
              const failed = uploadResult.failures.map((f) => `${f.task.fileName}: ${f.error}`);
              if (added.length === 0) {
                uploadFlow.setProgress({ active: false, percent: 0, label: '' });
                uploadFlow.setStatusWithTimeout(`Неуспешно: ${failed[0] ?? 'не удалось загрузить файлы'}`, 4500);
                return;
              }
              const merged = [...photos];
              for (const f of added) {
                if (!merged.find((x) => x.id === f.id)) merged.push(f);
              }
              uploadFlow.setProgress({ active: true, percent: 98, label: 'Сохранение изменений...' });
              const saved = await saveFiles('photos', merged, (v) => setPhotos(Array.isArray(v) ? v.filter(isFileRef) : []));
              uploadFlow.setProgress({ active: false, percent: 0, label: '' });
              if (!saved.ok) failed.push(`сохранение: ${saved.error}`);
              if (!mainPhotoId && merged[0]) setMainPhotoId(merged[0].id);
              if (failed.length > 0) {
                uploadFlow.setStatusWithTimeout(`Неуспешно: ${failed[0]}`, 4500);
                return;
              }
              uploadFlow.setStatusWithTimeout(`Успешно: прикреплено файлов — ${added.length}`, 1400);
            }}
          >
            Добавить фото
          </Button>
        )}
      </div>
      {uploadFlow.status ? (
        <div style={{ marginBottom: 8, color: uploadFlow.status.startsWith('Неуспешно') ? 'var(--danger)' : 'var(--subtle)', fontSize: 12 }}>{uploadFlow.status}</div>
      ) : null}
      {uploadFlow.progress.active ? (
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--subtle)', marginBottom: 4 }}>
            <span>{uploadFlow.progress.label}</span>
            <span>{Math.max(0, Math.min(100, Math.round(uploadFlow.progress.percent)))}%</span>
          </div>
          <div style={{ height: 8, borderRadius: 0, background: 'var(--border)', overflow: 'hidden' }}>
            <div
              style={{
                width: `${Math.max(0, Math.min(100, uploadFlow.progress.percent))}%`,
                height: '100%',
                background: 'var(--button-primary-bg)',
                transition: 'width 0.2s ease',
              }}
            />
          </div>
        </div>
      ) : null}
      {activePhoto ? (
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ overflow: 'hidden', border: '1px solid var(--border)', background: 'var(--surface)' }}>
            {photoThumbs[activePhoto.id]?.dataUrl ? (
              <img
                src={photoThumbs[activePhoto.id]?.dataUrl ?? ''}
                alt=""
                style={{ width: '100%', height: 320, objectFit: 'contain', display: 'block', background: 'var(--surface)' }}
              />
            ) : (
              <div style={{ height: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--subtle)' }}>
                Предпросмотр недоступен
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {photos.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setMainPhotoId(p.id)}
                style={{
                  border: p.id === activePhoto.id ? '2px solid var(--input-border-focus)' : '1px solid var(--border)',
                  borderRadius: 0,
                  overflow: 'hidden',
                  padding: 0,
                  background: 'var(--surface)',
                  width: 80,
                  height: 80,
                  cursor: 'pointer',
                }}
              >
                {photoThumbs[p.id]?.dataUrl ? (
                  <img src={photoThumbs[p.id]?.dataUrl ?? ''} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--subtle)' }}>
                    Фото
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ color: 'var(--subtle)' }}>Фото не добавлены.</div>
      )}
    </div>
  );

  const attachmentsBlock = (
    <AttachmentsPanel
      title="Файлы"
      value={attachments}
      canView={props.canViewFiles}
      canUpload={props.canUploadFiles && props.canEdit}
      scope={{ ownerType, ownerId: props.entityId, category: 'attachments' }}
      onChange={(next) => saveFiles('attachments', next, setAttachments)}
    />
  );

  const mainFields = orderFieldsByDefs(
    [
      {
        code: 'name',
        defaultOrder: 10,
        label: 'Название',
        value: name,
        render: (
          <Input
            value={name}
            disabled={!props.canEdit}
            onChange={(e) => { dirtyRef.current = true; setName(e.target.value); }}
          />
        ),
      },
      {
        code: 'description',
        defaultOrder: 20,
        label: 'Описание',
        value: description,
        render: (
          <textarea
            value={description}
            disabled={!props.canEdit}
            onChange={(e) => { dirtyRef.current = true; setDescription(e.target.value); }}
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
        ),
      },
      {
        code: 'shop',
        defaultOrder: 30,
        label: 'Магазин',
        value: shop,
        render: (
          <SearchSelectWithCreate
            value={storeOptions.find((o) => o.label === shop)?.id ?? null}
            options={storeOptions}
            disabled={!props.canEdit}
            canCreate={props.canEdit}
            createLabel="Добавить контрагента"
            onChange={(next) => {
              dirtyRef.current = true;
              const label = storeOptions.find((o) => o.id === next)?.label ?? '';
              setShop(label);
            }}
            onCreate={async (label) => {
              const id = await createLookupEntity(storeTypeId, label);
              if (!id) return null;
              const opt = { id, label: label.trim() };
              setStoreOptions((prev) => [...prev, opt].sort((a, b) => a.label.localeCompare(b.label, 'ru')));
              dirtyRef.current = true;
              setShop(label.trim());
              return id;
            }}
          />
        ),
      },
      {
        code: 'article',
        defaultOrder: 40,
        label: 'Артикул',
        value: article,
        render: (
          <Input
            value={article}
            disabled={!props.canEdit}
            onChange={(e) => {
              dirtyRef.current = true;
              setArticle(e.target.value);
            }}
          />
        ),
      },
      {
        code: 'unit',
        defaultOrder: 50,
        label: 'Ед. измерения',
        value: unit,
        render: (
          <SearchSelectWithCreate
            value={unitOptions.find((o) => o.label === unit)?.id ?? null}
            options={unitOptions}
            disabled={!props.canEdit}
            canCreate={props.canEdit}
            createLabel="Добавить единицу"
            onChange={(next) => {
              dirtyRef.current = true;
              const label = unitOptions.find((o) => o.id === next)?.label ?? '';
              setUnit(label);
            }}
            onCreate={async (label) => {
              const id = await createLookupEntity(unitTypeId, label);
              if (!id) return null;
              const opt = { id, label: label.trim() };
              setUnitOptions((prev) => [...prev, opt].sort((a, b) => a.label.localeCompare(b.label, 'ru')));
              dirtyRef.current = true;
              setUnit(label.trim());
              return id;
            }}
          />
        ),
      },
      {
        code: 'price',
        defaultOrder: 60,
        label: 'Цена',
        value: price,
        render: (
          <Input
            value={price}
            disabled={!props.canEdit}
            onChange={(e) => { dirtyRef.current = true; setPrice(e.target.value); }}
            placeholder="0"
          />
        ),
      },
      { code: 'photos', defaultOrder: 300, label: 'Фото', value: photos.length, render: photosBlock },
      { code: 'attachments', defaultOrder: 310, label: 'Файлы', value: Array.isArray(attachments) ? attachments.length : 0, render: attachmentsBlock },
    ],
    defs,
  );

  const headerTitle = name.trim() ? name.trim() : props.title;

  return (
    <EntityCardShell
      title={headerTitle}
      layout="two-column"
      cardActions={
        <CardActionBar
          canEdit={props.canEdit}
          onCopyToNew={() => {
            void (async () => {
              if (!entityTypeId) return;
              const created = await window.matrica.admin.entities.create(entityTypeId);
              if (created?.ok && 'id' in created) {
                await window.matrica.admin.entities.setAttr(created.id, 'name', name.trim() + ' (копия)');
              }
            })();
          }}
          onSaveAndClose={() => { void saveAllAndClose().then(() => props.onClose()); }}
          onReset={() => {
            void load().then(() => {
              dirtyRef.current = false;
            });
          }}
          onCloseWithoutSave={() => { dirtyRef.current = false; props.onClose(); }}
          onDelete={() => void handleDelete()}
          onClose={() => props.requestClose?.()}
        />
      }
      status={status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}
    >
        <SectionCard style={{ padding: 12 }}>
          <DraggableFieldList
            items={mainFields}
            getKey={(f) => f.code}
            canDrag={props.canEdit}
            onReorder={(next) => {
              if (!entityTypeId) return;
              void persistFieldOrder(
                next.map((f) => f.code),
                defs,
                { entityTypeId },
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
                <div
                  style={{
                    color: 'var(--subtle)',
                    alignSelf: field.code === 'description' ? 'start' : 'center',
                    paddingTop: field.code === 'description' ? 6 : 0,
                  }}
                >
                  {field.label}
                </div>
                {field.render}
              </div>
            )}
          />
        </SectionCard>
      
      {uploadFlow.renameDialog}
    </EntityCardShell>
  );
}
