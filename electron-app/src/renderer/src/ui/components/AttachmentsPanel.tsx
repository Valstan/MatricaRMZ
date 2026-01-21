import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { FileRef } from '@matricarmz/shared';

import { Button } from './Button.js';

function isFileRef(x: any): x is FileRef {
  return x && typeof x === 'object' && typeof x.id === 'string' && typeof x.name === 'string';
}

function normalizeList(v: unknown): FileRef[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isFileRef);
}

function formatBytes(n: number): string {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
  return `${(v / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function fileExt(name: string): string {
  const s = String(name || '');
  const dot = s.lastIndexOf('.');
  if (dot < 0) return '';
  return s.slice(dot + 1).trim().toLowerCase();
}

function extBadgeStyle(ext: string): { label: string; bg: string; fg: string } {
  const e = ext.toLowerCase();
  if (e === 'pdf') return { label: 'PDF', bg: '#fee2e2', fg: '#991b1b' };
  if (e === 'doc' || e === 'docx') return { label: 'Word', bg: '#dbeafe', fg: '#1d4ed8' };
  if (e === 'xls' || e === 'xlsx') return { label: 'Excel', bg: '#dcfce7', fg: '#166534' };
  if (e === 'ppt' || e === 'pptx') return { label: 'PPT', bg: '#ffedd5', fg: '#9a3412' };
  if (e === 'zip' || e === 'rar' || e === '7z') return { label: e.toUpperCase(), bg: '#ede9fe', fg: '#5b21b6' };
  // CAD/CAM & drawings
  if (e === 'dwg' || e === 'dxf' || e === 'dwf' || e === 'stp' || e === 'step' || e === 'igs' || e === 'iges') {
    return { label: e.toUpperCase(), bg: '#e0f2fe', fg: '#075985' };
  }
  // Kompas-3D (common extensions)
  if (e === 'cdw' || e === 'frw' || e === 'm3d' || e === 'a3d' || e === 'k3d') return { label: 'KOMPAS', bg: '#ecfeff', fg: '#155e75' };
  // SolidWorks / Inventor / CATIA / NX (icons only)
  if (e === 'sldprt' || e === 'sldasm' || e === 'slddrw') return { label: 'SW', bg: '#ffe4e6', fg: '#9f1239' };
  if (e === 'ipt' || e === 'iam' || e === 'idw' || e === 'ipn') return { label: 'INV', bg: '#ffedd5', fg: '#9a3412' };
  if (e === 'catpart' || e === 'catproduct' || e === 'catdrawing') return { label: 'CAT', bg: '#ede9fe', fg: '#5b21b6' };
  if (e === 'prt' || e === 'asm') return { label: 'NX', bg: '#e0e7ff', fg: '#3730a3' };
  // Raster/graphics
  if (e === 'psd') return { label: 'PSD', bg: '#0b1220', fg: '#93c5fd' };
  if (e === 'ai') return { label: 'AI', bg: '#ffedd5', fg: '#9a3412' };
  if (e === 'cdr') return { label: 'CDR', bg: '#dcfce7', fg: '#166534' };
  if (e === 'svg') return { label: 'SVG', bg: '#fef3c7', fg: '#92400e' };
  // CAM / CNC programs (often text)
  if (e === 'nc' || e === 'cnc' || e === 'tap' || e === 'gcode' || e === 'ngc' || e === 'mpf' || e === 'spf') {
    return { label: 'NC', bg: '#0f172a', fg: '#e2e8f0' };
  }
  if (e === 'exe' || e === 'msi') return { label: e.toUpperCase(), bg: '#e5e7eb', fg: '#111827' };
  if (e === 'png' || e === 'jpg' || e === 'jpeg' || e === 'webp' || e === 'gif') return { label: 'IMG', bg: '#e0e7ff', fg: '#3730a3' };
  if (e === 'txt' || e === 'log' || e === 'md') return { label: e.toUpperCase(), bg: '#f1f5f9', fg: '#0f172a' };
  return { label: (e || 'FILE').slice(0, 6).toUpperCase(), bg: '#f3f4f6', fg: '#374151' };
}

export function AttachmentsPanel(props: {
  title?: string;
  value: unknown; // FileRef[] in JSON
  canView: boolean;
  canUpload: boolean;
  scope?: { ownerType: string; ownerId: string; category: string };
  onChange: (next: FileRef[]) => Promise<{ ok: true; queued?: boolean } | { ok: false; error: string }>;
}) {
  const [busy, setBusy] = useState<string>('');
  const [thumbs, setThumbs] = useState<Record<string, { dataUrl: string | null; status: 'idle' | 'loading' | 'done' | 'error' }>>({});
  const thumbsRef = useRef(thumbs);

  const list = useMemo(() => normalizeList(props.value), [props.value]);
  const listKey = useMemo(() => list.map((x) => x.id).join('|'), [list]);

  useEffect(() => {
    thumbsRef.current = thumbs;
  }, [thumbs]);

  useEffect(() => {
    if (!props.canView) return;
    let alive = true;
    const run = async () => {
      for (const f of list) {
        if (!alive) return;
        const cur = thumbsRef.current[f.id];
        if (cur && (cur.status === 'loading' || cur.status === 'done' || cur.status === 'error')) continue;
        setThumbs((p) => ({ ...p, [f.id]: { dataUrl: null, status: 'loading' } }));
        try {
          const r = await window.matrica.files.previewGet({ fileId: f.id });
          if (!alive) return;
          if (r.ok) setThumbs((p) => ({ ...p, [f.id]: { dataUrl: r.dataUrl ?? null, status: 'done' } }));
          else setThumbs((p) => ({ ...p, [f.id]: { dataUrl: null, status: 'error' } }));
        } catch {
          if (!alive) return;
          setThumbs((p) => ({ ...p, [f.id]: { dataUrl: null, status: 'error' } }));
        }
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [props.canView, listKey, list]);

  async function addFromPaths(paths: string[]) {
    if (!props.canUpload) return;
    const unique = Array.from(new Set(paths.map((p) => String(p || '').trim()).filter(Boolean)));
    if (unique.length === 0) return;
    setBusy('Загрузка файлов...');
    try {
      const added: FileRef[] = [];
      for (const p of unique) {
        const r = await window.matrica.files.upload({ path: p, ...(props.scope ? { scope: props.scope } : {}) });
        if (!r.ok) throw new Error(r.error);
        added.push(r.file);
      }
      const merged = [...list];
      for (const f of added) {
        if (!merged.find((x) => x.id === f.id)) merged.push(f);
      }
      const r = await props.onChange(merged).catch((e) => ({ ok: false as const, error: String(e) }));
      if (!r) {
        setBusy('Готово');
        setTimeout(() => setBusy(''), 700);
        return;
      }
      if (!r.ok) {
        setBusy(`Ошибка: ${r.error}`);
        setTimeout(() => setBusy(''), 3000);
        return;
      }
      if (r.queued) {
        setBusy('Отправлено на утверждение (см. «Изменения»)');
        setTimeout(() => setBusy(''), 1600);
        return;
      }
      setBusy('Готово');
      setTimeout(() => setBusy(''), 700);
    } catch (e) {
      setBusy(`Ошибка: ${String(e)}`);
    }
  }

  async function onDrop(e: React.DragEvent) {
    if (!props.canUpload) return;
    e.preventDefault();
    // В Electron drag&drop не дает доступ к path, поэтому используем диалог
    const pickResult = await window.matrica.files.pick();
    if (pickResult.ok && pickResult.paths) {
      await addFromPaths(pickResult.paths);
    }
  }

  if (!props.canView) return null;

  return (
    <div
      style={{ marginTop: 14, border: '1px solid rgba(15, 23, 42, 0.18)', borderRadius: 14, padding: 12 }}
      onDragOver={(e) => {
        if (!props.canUpload) return;
        e.preventDefault();
      }}
      onDrop={onDrop}
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <strong>{props.title ?? 'Вложения'}</strong>
        <span style={{ flex: 1 }} />
        {busy && <div style={{ color: busy.startsWith('Ошибка') ? '#b91c1c' : '#64748b', fontSize: 12 }}>{busy}</div>}
        {props.canUpload && (
          <>
            <Button
              variant="ghost"
              onClick={async () => {
                const pickResult = await window.matrica.files.pick();
                if (pickResult.ok && pickResult.paths) {
                  await addFromPaths(pickResult.paths);
                }
              }}
            >
              Добавить файл
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          onClick={async () => {
            const r = await window.matrica.files.downloadDirPick();
            if (!r.ok) setBusy(`Ошибка: ${r.error}`);
            else setBusy(`Папка: ${r.path}`);
            setTimeout(() => setBusy(''), 1200);
          }}
        >
          Папка скачивания
        </Button>
      </div>

      <div style={{ marginTop: 10, border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'linear-gradient(135deg, #0f766e 0%, #2563eb 120%)', color: '#fff' }}>
              <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Файл</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10, width: 120 }}>Размер</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10, width: 220 }}>Действия</th>
            </tr>
          </thead>
          <tbody>
            {list.map((f) => (
              <tr key={f.id}>
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    {(() => {
                      const t = thumbs[f.id];
                      const dataUrl = t?.dataUrl ?? null;
                      const ext = fileExt(f.name);
                      const badge = extBadgeStyle(ext);
                      return dataUrl ? (
                        <img
                          src={dataUrl}
                          alt=""
                          style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 10, border: '1px solid rgba(15, 23, 42, 0.12)' }}
                        />
                      ) : (
                        <div
                          title={ext ? `.${ext}` : 'файл'}
                          style={{
                            width: 44,
                            height: 44,
                            borderRadius: 10,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 11,
                            fontWeight: 700,
                            background: badge.bg,
                            color: badge.fg,
                            border: '1px solid rgba(15, 23, 42, 0.12)',
                          }}
                        >
                          {badge.label}
                        </div>
                      );
                    })()}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <div style={{ fontSize: 14, color: '#0b1220' }}>{f.name}</div>
                      <div style={{ fontSize: 12, color: '#6b7280' }}>{f.mime ? String(f.mime) : ''}</div>
                    </div>
                  </div>
                </td>
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{formatBytes(Number(f.size) || 0)}</td>
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Button
                      variant="ghost"
                      onClick={async () => {
                        const r = await window.matrica.files.open({ fileId: f.id });
                        if (!r.ok) setBusy(`Ошибка: ${r.error}`);
                      }}
                    >
                      Открыть
                    </Button>
                    {props.canUpload && (
                      <Button
                        variant="ghost"
                        onClick={async () => {
                          try {
                            const next = list.filter((x) => x.id !== f.id);
                            setBusy('Удаление из списка...');
                            const upd = await props.onChange(next);
                            if (!upd.ok) {
                              setBusy(`Ошибка: ${upd.error}`);
                              setTimeout(() => setBusy(''), 3000);
                              return;
                            }
                            if (upd.queued) {
                              // Важно: pre-approval — запись не поменялась, поэтому файл нельзя удалять физически.
                              setBusy('Отправлено на утверждение (см. «Изменения»)');
                              setTimeout(() => setBusy(''), 2000);
                              return;
                            }

                            // После того как ссылка из записи убрана — можно попытаться удалить файл физически.
                            // Если файл используется где-то ещё, soft-delete может быть нежелательным, но пока оставляем как есть.
                            setBusy('Удаление файла...');
                            const deleteResult = await window.matrica.files.delete({ fileId: f.id });
                            if (!deleteResult.ok) {
                              setBusy(`Файл убран из списка, но удалить на сервере не удалось: ${deleteResult.error}`);
                              setTimeout(() => setBusy(''), 3500);
                              return;
                            }
                            if ((deleteResult as any).queued) {
                              setBusy('Удаление файла отправлено на утверждение (см. «Изменения»)');
                              setTimeout(() => setBusy(''), 2000);
                              return;
                            }
                            setBusy('Файл удален');
                            setTimeout(() => setBusy(''), 700);
                          } catch (e) {
                            setBusy(`Ошибка: ${String(e)}`);
                            setTimeout(() => setBusy(''), 3000);
                          }
                        }}
                      >
                        Удалить файл
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr>
                <td colSpan={3} style={{ padding: 12, color: '#6b7280' }}>
                  Нет вложений. {props.canUpload ? 'Перетащите файл сюда или нажмите “Добавить файл”.' : ''}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}


