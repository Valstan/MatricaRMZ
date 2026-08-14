import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { FileRef } from '@matricarmz/shared';

import { Button } from './Button.js';
import { useConfirm } from './ConfirmContext.js';
import { isAndroidPlatform } from '../platform.js';

type GalleryFile = FileRef & { isObsolete?: boolean };

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);

function fileExt(name: string): string {
  const s = String(name || '');
  const dot = s.lastIndexOf('.');
  return dot < 0 ? '' : s.slice(dot + 1).trim().toLowerCase();
}

function isImage(file: GalleryFile): boolean {
  if (typeof file.mime === 'string' && file.mime.startsWith('image/')) return true;
  return IMAGE_EXT.has(fileExt(file.name));
}

function normalizeList(v: unknown): GalleryFile[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is GalleryFile => x && typeof x === 'object' && typeof x.id === 'string' && typeof x.name === 'string');
}

export function stepGalleryIndex(current: number, delta: -1 | 1, length: number): number {
  if (length <= 0) return 0;
  return (current + delta + length) % length;
}

type EnginePhotoGalleryProps = {
  value: unknown; // FileRef[] (все вложения; галерея сама отфильтрует фото)
  canView: boolean;
  canDelete: boolean;
  engineLabel?: string;
  onChange: (next: FileRef[]) => Promise<{ ok: true; queued?: boolean } | { ok: false; error: string } | void> | void;
};

export function EnginePhotoGallery(props: EnginePhotoGalleryProps) {
  return <EnginePhotoGalleryInner {...props} />;
}

function EnginePhotoGalleryInner(props: EnginePhotoGalleryProps) {
  const { confirm } = useConfirm();
  const allFiles = useMemo(() => normalizeList(props.value), [props.value]);
  const photos = useMemo(() => allFiles.filter(isImage), [allFiles]);
  const photosKey = useMemo(() => photos.map((p) => p.id).join('|'), [photos]);

  const [thumbs, setThumbs] = useState<Record<string, string | null>>({});
  const thumbsRef = useRef(thumbs);
  useEffect(() => {
    thumbsRef.current = thumbs;
  }, [thumbs]);

  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [bigUrl, setBigUrl] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState('');
  const [shareOpen, setShareOpen] = useState(false);
  // Планшет: буфера обмена, печати и папок у WebView нет — эти действия там прячем,
  // просмотр и удаление работают.
  const isAndroid = isAndroidPlatform();

  const flash = (msg: string, ms = 1600) => {
    setBusy(msg);
    setTimeout(() => setBusy(''), ms);
  };

  // Превью (thumbnails) для сетки.
  useEffect(() => {
    if (!props.canView || photos.length === 0) return;
    let alive = true;
    void (async () => {
      for (const p of photos) {
        if (!alive) return;
        if (p.id in thumbsRef.current) continue;
        try {
          const r = await window.matrica.files.previewGet({ fileId: p.id });
          if (!alive) return;
          setThumbs((prev) => ({ ...prev, [p.id]: r.ok ? r.dataUrl ?? null : null }));
        } catch {
          if (!alive) return;
          setThumbs((prev) => ({ ...prev, [p.id]: null }));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [props.canView, photosKey, photos]);

  const active = activeIndex != null ? photos[activeIndex] ?? null : null;

  // Полноразмерное изображение для лайтбокса.
  useEffect(() => {
    if (!active) {
      setBigUrl(null);
      return;
    }
    let alive = true;
    setBigUrl(null);
    void (async () => {
      try {
        const r = await window.matrica.files.originalGet({ fileId: active.id });
        if (!alive) return;
        setBigUrl(r.ok ? r.dataUrl : thumbsRef.current[active.id] ?? null);
      } catch {
        if (!alive) return;
        setBigUrl(thumbsRef.current[active.id] ?? null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [active]);

  // Навигация клавиатурой в лайтбоксе.
  useEffect(() => {
    if (activeIndex == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActiveIndex(null);
      else if (e.key === 'ArrowLeft') setActiveIndex((i) => (i == null ? i : stepGalleryIndex(i, -1, photos.length)));
      else if (e.key === 'ArrowRight') setActiveIndex((i) => (i == null ? i : stepGalleryIndex(i, 1, photos.length)));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeIndex, photos.length]);

  if (!props.canView || photos.length === 0) return null;

  // Выборка накопительная и живёт независимо от лайтбокса: набрал фото листанием —
  // действие идёт по всему набору. Пусто — работаем с текущим открытым фото.
  const targetIds = (): string[] => {
    if (selected.size > 0) return photos.filter((p) => selected.has(p.id)).map((p) => p.id);
    return active ? [active.id] : [];
  };
  const activeSelected = active != null && selected.has(active.id);
  const defaultName = `Фото двигателя ${props.engineLabel ?? ''}`.trim();

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  async function doCopy() {
    if (!active) return;
    setBusy('Копирование…');
    const r = await window.matrica.files.copyImage({ fileId: active.id });
    if (!r.ok) flash(`Ошибка: ${r.error}`, 3000);
    else flash(selected.size > 1 ? 'Скопировано текущее фото (буфер хранит одно изображение)' : 'Фото скопировано в буфер обмена');
  }

  async function doDelete() {
    if (!props.canDelete) return;
    const ids = targetIds();
    if (ids.length === 0) return;
    const ok = await confirm({
      detail: ids.length === 1
        ? `Будет удалено фото «${photos.find((p) => p.id === ids[0])?.name ?? ''}» (с диска и из вложений двигателя).`
        : `Будет удалено фото: ${ids.length} шт. (с диска и из вложений двигателя).`,
    });
    if (!ok) return;
    setBusy('Удаление…');
    const next = allFiles.filter((f) => !ids.includes(f.id));
    const upd = await Promise.resolve(props.onChange(next)).catch((e) => ({ ok: false as const, error: String(e) }));
    if (upd && !upd.ok) {
      flash(`Ошибка: ${upd.error}`, 3000);
      return;
    }
    if (upd && upd.queued) {
      flash('Отправлено на утверждение (см. «Изменения»)', 2200);
      setActiveIndex(null);
      return;
    }
    for (const id of ids) {
      await window.matrica.files.delete({ fileId: id }).catch(() => undefined);
    }
    setSelected(new Set());
    setActiveIndex(null);
    flash(ids.length === 1 ? 'Фото удалено' : `Удалено фото: ${ids.length}`);
  }

  async function doCopyToFolder() {
    setShareOpen(false);
    const ids = targetIds();
    if (ids.length === 0) return;
    setBusy('Сохранение копий…');
    const r = await window.matrica.files.copyToFolder({ fileIds: ids });
    if (!r.ok) flash(r.error === 'cancelled' ? '' : `Ошибка: ${r.error}`, 3000);
    else flash(`Сохранено файлов: ${r.count}`);
  }

  async function doReveal(mailto: boolean) {
    setShareOpen(false);
    const ids = targetIds();
    if (ids.length === 0) return;
    setBusy(mailto ? 'Подготовка письма…' : 'Открываю папку…');
    const r = await window.matrica.files.revealForShare({ fileIds: ids, label: defaultName, ...(mailto ? { mailto: true } : {}) });
    if (!r.ok) flash(`Ошибка: ${r.error}`, 3000);
    else flash(mailto ? 'Папка открыта + черновик письма (перетащите фото вложением)' : 'Папка открыта (перетащите фото в Telegram/MAX)');
  }

  async function doPrint() {
    const ids = targetIds();
    if (ids.length === 0) return;
    setBusy('Печать…');
    const r = await window.matrica.files.print({ fileIds: ids });
    if (!r.ok) flash(`Ошибка: ${r.error}`, 3000);
    else flash('Отправлено на печать');
  }

  async function doAssemblePdf() {
    const ids = targetIds();
    if (ids.length === 0) return;
    setBusy('Сборка PDF…');
    const r = await window.matrica.files.assemblePdf({ fileIds: ids, defaultName });
    if (!r.ok) flash(r.error === 'cancelled' ? '' : `Ошибка: ${r.error}`, 3000);
    else flash('PDF сохранён');
  }

  const tbBtn: React.CSSProperties = {
    color: '#111827',
    background: '#fff',
    border: '1px solid rgba(255,255,255,0.78)',
    borderRadius: 999,
    boxShadow: '0 5px 16px rgba(0,0,0,0.2)',
    fontWeight: 650,
  };

  return (
    <div style={{ marginTop: 14, border: '1px solid rgba(15, 23, 42, 0.18)', borderRadius: 14, padding: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
        <strong>Фотогалерея двигателя</strong>
        <span style={{ fontSize: 12, color: '#64748b' }}>{photos.length} фото</span>
        <span style={{ flex: 1 }} />
        {busy && <div style={{ color: busy.startsWith('Ошибка') ? '#b91c1c' : '#64748b', fontSize: 12 }}>{busy}</div>}
        {/* Режим выбора нужен и в сетке, а не только внутри просмотрщика. */}
        <Button
          variant="ghost"
          onClick={() => {
            setSelectMode((v) => {
              if (v) setSelected(new Set());
              return !v;
            });
          }}
        >
          {selectMode ? 'Выйти из выбора' : 'Выбрать несколько'}
        </Button>
      </div>
      {selected.size > 0 && (
        <div
          style={{
            marginBottom: 10,
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
            padding: '8px 10px',
            border: '1px solid #bfdbfe',
            borderRadius: 12,
            background: '#eff6ff',
          }}
        >
          <strong style={{ fontSize: 13 }}>Выбрано фото: {selected.size}</strong>
          <span style={{ flex: 1 }} />
          {!isAndroid && (
            <>
              <Button variant="ghost" onClick={doPrint}>Печать</Button>
              <Button variant="ghost" onClick={doAssemblePdf}>Собрать в PDF</Button>
              <Button variant="ghost" onClick={doCopyToFolder}>На флешку / в папку…</Button>
              <Button variant="ghost" onClick={() => doReveal(false)}>Открыть папку с файлами</Button>
            </>
          )}
          {props.canDelete && <Button variant="ghost" onClick={doDelete}>Удалить</Button>}
          <Button variant="ghost" onClick={() => setSelected(new Set())}>Снять выбор</Button>
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {photos.map((p, idx) => {
          const url = thumbs[p.id];
          const sel = selected.has(p.id);
          return (
            <div
              key={p.id}
              title={p.name}
              onClick={() => (selectMode ? toggleSelected(p.id) : setActiveIndex(idx))}
              style={{
                position: 'relative',
                width: 96,
                height: 96,
                borderRadius: 10,
                overflow: 'hidden',
                cursor: 'pointer',
                border: sel ? '2px solid #2563eb' : '1px solid rgba(15, 23, 42, 0.15)',
                background: '#f1f5f9',
              }}
            >
              {url ? (
                <img src={url} alt={p.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#64748b' }}>
                  {fileExt(p.name).toUpperCase() || 'IMG'}
                </div>
              )}
              {(selectMode || sel) && (
                <div style={{ position: 'absolute', top: 4, left: 4, width: 18, height: 18, borderRadius: 4, background: sel ? '#2563eb' : 'rgba(255,255,255,0.85)', border: '1px solid #2563eb', color: '#fff', fontSize: 12, lineHeight: '16px', textAlign: 'center', fontWeight: 700 }}>
                  {sel ? '✓' : ''}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {active && (
        <div
          onClick={() => setActiveIndex(null)}
          style={{ position: 'fixed', inset: 0, background: 'radial-gradient(circle at center, rgba(30,41,59,0.94), rgba(2,6,23,0.98))', zIndex: 1000, display: 'flex', flexDirection: 'column' }}
        >
          {/* Тулбар */}
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              padding: '12px 16px',
              flexWrap: 'wrap',
              background: 'rgba(15,23,42,0.9)',
              borderBottom: '1px solid rgba(255,255,255,0.14)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.24)',
              zIndex: 3,
            }}
          >
            {!isAndroid && <Button variant="ghost" style={tbBtn} onClick={doCopy}>Копировать</Button>}
            {props.canDelete && <Button variant="ghost" style={tbBtn} onClick={doDelete}>Удалить</Button>}
            {/* Кнопка добавляет/убирает ТЕКУЩЕЕ фото и набор не обнуляет: листаешь —
                выбранное копится, а действия тулбара идут по всему набору. */}
            <Button
              variant="ghost"
              style={activeSelected ? { ...tbBtn, background: '#2563eb', color: '#fff', borderColor: '#60a5fa' } : tbBtn}
              onClick={() => {
                if (!active) return;
                setSelectMode(true);
                toggleSelected(active.id);
              }}
            >
              {activeSelected ? '✓ Выбрано' : 'Выбрать'}
            </Button>
            {selected.size > 0 && (
              <Button variant="ghost" style={tbBtn} onClick={() => setSelected(new Set())}>
                Снять выбор ({selected.size})
              </Button>
            )}
            {!isAndroid && (
            <div style={{ position: 'relative' }}>
              <Button variant="ghost" style={tbBtn} onClick={() => setShareOpen((v) => !v)}>Отправить ▾</Button>
              {shareOpen && (
                <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, background: '#fff', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.3)', overflow: 'hidden', zIndex: 1100, minWidth: 240 }}>
                  <button style={shareItemStyle} onClick={doCopyToFolder}>На флешку / в папку…</button>
                  <button style={shareItemStyle} onClick={() => doReveal(false)}>Открыть папку с файлами</button>
                  <button style={shareItemStyle} onClick={() => doReveal(true)}>Почта…</button>
                </div>
              )}
            </div>
            )}
            {!isAndroid && <Button variant="ghost" style={tbBtn} onClick={doPrint}>Печать</Button>}
            {!isAndroid && <Button variant="ghost" style={tbBtn} onClick={doAssemblePdf}>Собрать в PDF</Button>}
            <span style={{ flex: 1 }} />
            <span style={{ color: '#cbd5e1', fontSize: 13 }}>
              {(activeIndex ?? 0) + 1} / {photos.length}
              {selected.size > 0 ? ` · выбрано ${selected.size} — действия по выбранным` : ''}
            </span>
            <Button variant="ghost" style={tbBtn} onClick={() => setActiveIndex(null)}>Закрыть ✕</Button>
          </div>
          {busy && <div onClick={(e) => e.stopPropagation()} style={{ textAlign: 'center', color: busy.startsWith('Ошибка') ? '#fca5a5' : '#e2e8f0', fontSize: 13, paddingBottom: 4 }}>{busy}</div>}

          {/* Изображение занимает центр независимо от своих пропорций. Навигация прибита
              к краям viewport, поэтому не прыгает между узкими и широкими фотографиями. */}
          <div onClick={(e) => e.stopPropagation()} style={{ position: 'relative', flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '18px 28px', minHeight: 0 }}>
            {bigUrl ? (
              <img src={bigUrl} alt={active.name} style={{ maxWidth: '92vw', maxHeight: '78vh', objectFit: 'contain', borderRadius: 10, boxShadow: '0 18px 60px rgba(0,0,0,0.42)' }} />
            ) : (
              <div style={{ color: '#cbd5e1' }}>Загрузка…</div>
            )}
            {photos.length > 1 ? (
              <>
                <button
                  onClick={() => setActiveIndex((i) => (i == null ? i : stepGalleryIndex(i, -1, photos.length)))}
                  style={{ ...arrowStyle, left: 24 }}
                  aria-label="Предыдущее изображение"
                  title="Предыдущее изображение (←)"
                >
                  <span aria-hidden="true" style={{ fontSize: 34, lineHeight: 1 }}>‹</span>
                  <span>Предыдущее</span>
                </button>
                <button
                  onClick={() => setActiveIndex((i) => (i == null ? i : stepGalleryIndex(i, 1, photos.length)))}
                  style={{ ...arrowStyle, right: 24 }}
                  aria-label="Следующее изображение"
                  title="Следующее изображение (→)"
                >
                  <span>Следующее</span>
                  <span aria-hidden="true" style={{ fontSize: 34, lineHeight: 1 }}>›</span>
                </button>
              </>
            ) : null}
          </div>
          <div onClick={(e) => e.stopPropagation()} style={{ textAlign: 'center', color: '#cbd5e1', fontSize: 13, paddingBottom: 12 }}>{active.name}</div>
        </div>
      )}
    </div>
  );
}

const shareItemStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '10px 14px',
  border: 'none',
  background: '#fff',
  color: '#0b1220',
  fontSize: 14,
  cursor: 'pointer',
};

const arrowStyle: React.CSSProperties = {
  position: 'absolute',
  top: '50%',
  transform: 'translateY(-50%)',
  minWidth: 154,
  height: 68,
  padding: '0 18px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  borderRadius: 999,
  border: '1px solid rgba(255,255,255,0.5)',
  background: 'rgba(15,23,42,0.82)',
  backdropFilter: 'blur(12px)',
  color: '#fff',
  fontSize: 15,
  fontWeight: 750,
  letterSpacing: '0.01em',
  boxShadow: '0 10px 32px rgba(0,0,0,0.34)',
  cursor: 'pointer',
  zIndex: 2,
};
