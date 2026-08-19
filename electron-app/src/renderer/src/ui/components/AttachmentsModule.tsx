import { useCallback, useMemo, useState } from 'react';

import type { FileRef } from '@matricarmz/shared';

import { AttachmentsPanel } from './AttachmentsPanel.js';
import { Button } from './Button.js';
import { EnginePhotoGallery } from './EnginePhotoGallery.js';
import { useConfirm } from './ConfirmContext.js';
import { isAndroidPlatform } from '../platform.js';

/**
 * Единый модуль вложений карточки: фотогалерея и список файлов работают как одно
 * целое. До этого карточка рисовала два независимых компонента над ОДНИМ массивом
 * `attachments`: у каждого была своя выборка и свой набор кнопок — отметил фото в
 * галерее, а «Печать» списка про эту отметку не знала, и наоборот. Теперь выборка
 * одна на оба вида, а групповые действия — один тулбар (объединение прежних двух).
 */

type FileLike = FileRef & { isObsolete?: boolean };

function normalizeList(value: unknown): FileLike[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is FileLike => !!x && typeof x === 'object' && typeof x.id === 'string' && typeof x.name === 'string');
}

export function AttachmentsModule(props: {
  title?: string;
  value: unknown;
  canView: boolean;
  canUpload: boolean;
  canDelete: boolean;
  /** Человеческое имя карточки — подписывает папку файлов объекта, печать и PDF. */
  objectLabel?: string;
  scope?: { ownerType: string; ownerId: string; category: string };
  /** Показывать фотогалерею (карточки без фото могут её не включать). */
  withGallery?: boolean;
  onChange: (next: FileRef[]) => Promise<{ ok: true; queued?: boolean } | { ok: false; error: string } | void> | void;
}) {
  const { confirm } = useConfirm();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState('');
  const isAndroid = isAndroidPlatform();

  const list = useMemo(() => normalizeList(props.value), [props.value]);
  const selectedIds = useMemo(() => list.filter((f) => selected.has(f.id)).map((f) => f.id), [list, selected]);
  const objectLabel = props.objectLabel?.trim() || props.title?.trim() || 'Карточка';

  const flash = useCallback((message: string, ms = 2000) => {
    setBusy(message);
    if (message) setTimeout(() => setBusy(''), ms);
  }, []);

  const runBatch = useCallback(
    async (label: string, fn: () => Promise<{ ok: boolean; error?: string; count?: number }>) => {
      setBusy(`${label}…`);
      const r = await fn().catch((e) => ({ ok: false as const, error: String(e) }));
      if (!r.ok) flash(r.error === 'cancelled' ? '' : `Ошибка: ${r.error ?? 'не удалось'}`, 3200);
      else flash(typeof r.count === 'number' ? `${label}: ${r.count}` : `${label}: готово`);
      return r.ok;
    },
    [flash],
  );

  /** «Сохранить все» — весь набор карточки одной папкой, без предварительного выбора. */
  const saveAll = useCallback(async () => {
    const ids = list.map((f) => f.id);
    if (ids.length === 0) return;
    await runBatch('Сохранено файлов', () => window.matrica.files.copyToFolder({ fileIds: ids }));
  }, [list, runBatch]);

  const deleteSelected = useCallback(async () => {
    if (!props.canDelete || selectedIds.length === 0) return;
    const ok = await confirm({
      detail:
        selectedIds.length === 1
          ? `Будет удалён файл «${list.find((f) => f.id === selectedIds[0])?.name ?? ''}» (с диска и из вложений карточки).`
          : `Будет удалено файлов: ${selectedIds.length} (с диска и из вложений карточки).`,
    });
    if (!ok) return;
    setBusy('Удаление…');
    const next = list.filter((f) => !selectedIds.includes(f.id));
    const upd = await Promise.resolve(props.onChange(next)).catch((e) => ({ ok: false as const, error: String(e) }));
    if (upd && !upd.ok) {
      flash(`Ошибка: ${upd.error}`, 3200);
      return;
    }
    // Пред-утверждение: правка ушла на согласование, физически файлы не трогаем.
    if (upd && upd.queued) {
      setSelected(new Set());
      flash('Отправлено на утверждение (см. «Изменения»)', 2400);
      return;
    }
    for (const id of selectedIds) await window.matrica.files.delete({ fileId: id }).catch(() => undefined);
    setSelected(new Set());
    flash(selectedIds.length === 1 ? 'Файл удалён' : `Удалено файлов: ${selectedIds.length}`);
  }, [props, selectedIds, list, confirm, flash]);

  if (!props.canView) return null;

  const hasSelection = selectedIds.length > 0;
  const actionIds = hasSelection ? selectedIds : list.map((f) => f.id);

  return (
    <div data-attachments-module style={{ display: 'flex', flexDirection: 'column' }}>
      {list.length > 0 && (
        <div
          data-attachments-toolbar
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            alignItems: 'center',
            padding: '8px 10px',
            border: `1px solid ${hasSelection ? '#bfdbfe' : 'rgba(15, 23, 42, 0.14)'}`,
            borderRadius: 12,
            background: hasSelection ? '#eff6ff' : 'transparent',
          }}
        >
          <strong style={{ fontSize: 13 }}>
            {hasSelection ? `Выбрано: ${selectedIds.length} из ${list.length}` : `Файлов: ${list.length}`}
          </strong>
          {busy ? (
            <span style={{ fontSize: 12, color: busy.startsWith('Ошибка') ? '#b91c1c' : '#64748b' }}>{busy}</span>
          ) : null}
          <span style={{ flex: 1 }} />
          {!isAndroid && (
            <>
              <Button
                variant="ghost"
                onClick={() => void saveAll()}
                title="Сохранить все файлы карточки в выбранную папку (без предварительного выбора)"
              >
                Сохранить все ({list.length})
              </Button>
              <Button
                variant="ghost"
                onClick={() => void runBatch('Печать', () => window.matrica.files.print({ fileIds: actionIds }))}
              >
                Печать{hasSelection ? '' : ' всех'}
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  void runBatch('Собрано в PDF', () =>
                    window.matrica.files.assemblePdf({ fileIds: actionIds, defaultName: objectLabel }),
                  )
                }
              >
                Собрать в PDF
              </Button>
              <Button
                variant="ghost"
                onClick={() => void runBatch('Скопировано файлов', () => window.matrica.files.copyToFolder({ fileIds: actionIds }))}
              >
                На флешку / в папку…
              </Button>
              <Button
                variant="ghost"
                title="Открыть папку с этими файлами — оттуда их удобно перетащить в Telegram/MAX"
                onClick={() =>
                  void runBatch('Открытие папки', () =>
                    window.matrica.files.revealForShare({ fileIds: actionIds, label: objectLabel }),
                  )
                }
              >
                Открыть папку
              </Button>
            </>
          )}
          {props.canDelete && hasSelection ? (
            <Button variant="ghost" onClick={() => void deleteSelected()}>
              Удалить выбранные
            </Button>
          ) : null}
          {hasSelection ? (
            <Button variant="ghost" onClick={() => setSelected(new Set())}>
              Снять выбор
            </Button>
          ) : null}
        </div>
      )}

      {props.withGallery !== false && (
        <EnginePhotoGallery
          value={props.value}
          canView={props.canView}
          canDelete={props.canDelete}
          {...(props.objectLabel ? { engineLabel: props.objectLabel } : {})}
          onChange={props.onChange}
          selected={selected}
          onSelectedChange={setSelected}
          hideBulkBar
        />
      )}

      <AttachmentsPanel
        {...(props.title ? { title: props.title } : {})}
        value={props.value}
        canView={props.canView}
        canUpload={props.canUpload}
        {...(props.objectLabel ? { objectLabel: props.objectLabel } : {})}
        {...(props.scope ? { scope: props.scope } : {})}
        onChange={props.onChange}
        selected={selected}
        onSelectedChange={setSelected}
        hideBulkBar
      />
    </div>
  );
}
