import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { FileRef } from '@matricarmz/shared';

import { Button } from './Button.js';
import { useConfirm } from './ConfirmContext.js';

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

export function EnginePhotoGallery(props: {
  value: unknown; // FileRef[] (все вложения; галерея сама отфильтрует фото)
  canView: boolean;
  canDelete: boolean;
  engineLabel?: string;
  onChange: (next: FileRef[]) => Promise<{ ok: true; queued?: boolean } | { ok: false; error: string } | void> | void;
}) {
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
      else if (e.key === 'ArrowLeft') setActiveIndex((i) => (i == null ? i : (i - 1 + photos.length) % photos.length));
      else if (e.key === 'ArrowRight') setActiveIndex((i) => (i == null ? i : (i + 1) % photos.length));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeIndex, photos.length]);

  if (!props.canView || photos.length === 0) return null;

  const targetIds = (): string[] => {
    if (selectMode && selected.size > 0) return photos.filter((p) => selected.has(p.id)).map((p) => p.id);
    return active ? [active.id] : [];
  };
  const targetCount = selectMode && selected.size > 0 ? selected.size : active ? 1 : 0;
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
    else flash(selectMode && selected.size > 1 ? 'Скопировано текущее фото (буфер хранит одно изображение)' : 'Фото скопировано в буфер обмена');
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

  const tbBtn: React.CSSProperties = { color: '#fff', borderColor: 'rgba(255,255,255,0.5)' };

  return (
    <div style={{ marginTop: 14, border: '1px solid rgba(15, 23, 42, 0.18)', borderRadius: 14, padding: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
        <strong>Фотогалерея двигателя</strong>
        <span style={{ fontSize: 12, color: '#64748b' }}>{photos.length} фото</span>
        <span style={{ flex: 1 }} />
        {busy && <div style={{ color: busy.startsWith('Ошибка') ? '#b91c1c' : '#64748b', fontSize: 12 }}>{busy}</div>}
      </div>
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
              {selectMode && (
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
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.82)', zIndex: 1000, display: 'flex', flexDirection: 'column' }}
        >
          {/* Тулбар */}
          <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 14px', flexWrap: 'wrap' }}>
            <Button variant="ghost" style={tbBtn} onClick={doCopy}>Копировать</Button>
            {props.canDelete && <Button variant="ghost" style={tbBtn} onClick={doDelete}>Удалить</Button>}
            <Button variant="ghost" style={selectMode ? { ...tbBtn, background: 'rgba(37,99,235,0.4)' } : tbBtn} onClick={() => { setSelectMode((v) => !v); setSelected(new Set()); }}>
              {selectMode ? `Выбрано: ${selected.size}` : 'Выбрать'}
            </Button>
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
            <Button variant="ghost" style={tbBtn} onClick={doPrint}>Печать</Button>
            <Button variant="ghost" style={tbBtn} onClick={doAssemblePdf}>Собрать в PDF</Button>
            <span style={{ flex: 1 }} />
            <span style={{ color: '#cbd5e1', fontSize: 13 }}>
              {(activeIndex ?? 0) + 1} / {photos.length}
              {targetCount > 1 ? ` · действие на ${targetCount}` : ''}
            </span>
            <Button variant="ghost" style={tbBtn} onClick={() => setActiveIndex(null)}>Закрыть ✕</Button>
          </div>
          {busy && <div onClick={(e) => e.stopPropagation()} style={{ textAlign: 'center', color: busy.startsWith('Ошибка') ? '#fca5a5' : '#e2e8f0', fontSize: 13, paddingBottom: 4 }}>{busy}</div>}

          {/* Картинка + стрелки */}
          <div onClick={(e) => e.stopPropagation()} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '0 14px 14px', minHeight: 0 }}>
            <button onClick={() => setActiveIndex((i) => (i == null ? i : (i - 1 + photos.length) % photos.length))} style={arrowStyle} aria-label="Предыдущее">‹</button>
            {bigUrl ? (
              <img src={bigUrl} alt={active.name} style={{ maxWidth: '82vw', maxHeight: '78vh', objectFit: 'contain', borderRadius: 8 }} />
            ) : (
              <div style={{ color: '#cbd5e1' }}>Загрузка…</div>
            )}
            <button onClick={() => setActiveIndex((i) => (i == null ? i : (i + 1) % photos.length))} style={arrowStyle} aria-label="Следующее">›</button>
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
  flex: '0 0 auto',
  width: 44,
  height: 64,
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.3)',
  background: 'rgba(255,255,255,0.1)',
  color: '#fff',
  fontSize: 32,
  lineHeight: 1,
  cursor: 'pointer',
};
