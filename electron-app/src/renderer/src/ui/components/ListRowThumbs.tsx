import React, { useEffect, useMemo, useRef, useState } from 'react';

type ListPreviewFile = { id: string; name: string; mime: string | null };
type ThumbState = { dataUrl: string | null; status: 'idle' | 'loading' | 'done' | 'error' };

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
  if (e === 'png' || e === 'jpg' || e === 'jpeg' || e === 'webp' || e === 'gif') return { label: 'IMG', bg: '#e0e7ff', fg: '#3730a3' };
  if (e === 'svg') return { label: 'SVG', bg: '#fef3c7', fg: '#92400e' };
  if (e === 'txt' || e === 'md' || e === 'log') return { label: e.toUpperCase(), bg: '#f1f5f9', fg: '#0f172a' };
  return { label: (e || 'FILE').slice(0, 6).toUpperCase(), bg: '#f3f4f6', fg: '#374151' };
}

export function ListRowThumbs(props: { files: ListPreviewFile[] }) {
  const files = useMemo(() => {
    const unique: ListPreviewFile[] = [];
    const seen = new Set<string>();
    for (const file of props.files ?? []) {
      const id = String(file?.id ?? '').trim();
      const name = String(file?.name ?? '').trim();
      if (!id || !name || seen.has(id)) continue;
      seen.add(id);
      unique.push({ id, name, mime: typeof file.mime === 'string' ? file.mime : null });
      if (unique.length >= 5) break;
    }
    return unique;
  }, [props.files]);
  const fileKey = useMemo(() => files.map((file) => file.id).join('|'), [files]);
  const [thumbs, setThumbs] = useState<Record<string, ThumbState>>({});
  const thumbsRef = useRef(thumbs);

  useEffect(() => {
    thumbsRef.current = thumbs;
  }, [thumbs]);

  useEffect(() => {
    if (files.length === 0) return;
    let alive = true;
    const run = async () => {
      for (const file of files) {
        if (!alive) return;
        const current = thumbsRef.current[file.id];
        if (current && (current.status === 'loading' || current.status === 'done' || current.status === 'error')) continue;
        setThumbs((prev) => ({ ...prev, [file.id]: { dataUrl: null, status: 'loading' } }));
        try {
          const result = await window.matrica.files.previewGet({ fileId: file.id });
          if (!alive) return;
          if (result.ok) {
            setThumbs((prev) => ({ ...prev, [file.id]: { dataUrl: result.dataUrl ?? null, status: 'done' } }));
          } else {
            setThumbs((prev) => ({ ...prev, [file.id]: { dataUrl: null, status: 'error' } }));
          }
        } catch {
          if (!alive) return;
          setThumbs((prev) => ({ ...prev, [file.id]: { dataUrl: null, status: 'error' } }));
        }
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [fileKey, files]);

  if (files.length === 0) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, minHeight: 36 }}>
      {files.map((file) => {
        const thumb = thumbs[file.id];
        const dataUrl = thumb?.dataUrl ?? null;
        const ext = fileExt(file.name);
        const badge = extBadgeStyle(ext);
        return dataUrl ? (
          <img
            key={file.id}
            src={dataUrl}
            alt={file.name}
            title={file.name}
            style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 8, border: '1px solid rgba(15, 23, 42, 0.12)' }}
          />
        ) : (
          <div
            key={file.id}
            title={file.name}
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 10,
              fontWeight: 700,
              background: badge.bg,
              color: badge.fg,
              border: '1px solid rgba(15, 23, 42, 0.12)',
              userSelect: 'none',
            }}
          >
            {badge.label}
          </div>
        );
      })}
    </div>
  );
}
