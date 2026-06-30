import React, { useMemo, useRef, useState } from 'react';

import { Button } from './Button.js';
import * as chatApi from '../../api/chat.js';

type FileRef = {
  id: string;
  name: string;
  size: number;
  mime: string | null;
  sha256: string;
  createdAt: number;
  isObsolete?: boolean;
};
type FileFilterMode = 'actual' | 'obsolete' | 'all';

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

function isObsoleteFile(file: FileRef): boolean {
  return file.isObsolete === true;
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function AttachmentsPanel(props: {
  title?: string;
  value: unknown;
  canView: boolean;
  canUpload: boolean;
  scope?: { ownerType: string; ownerId: string; category: string };
  onChange: (next: FileRef[]) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const [busy, setBusy] = useState<string>('');
  const [filterMode, setFilterMode] = useState<FileFilterMode>('all');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const list = useMemo(() => normalizeList(props.value), [props.value]);
  const filteredList = useMemo(() => {
    if (filterMode === 'actual') return list.filter((file) => !isObsoleteFile(file));
    if (filterMode === 'obsolete') return list.filter((file) => isObsoleteFile(file));
    return list;
  }, [list, filterMode]);

  async function addFiles(files: File[]) {
    if (!props.canUpload) return;
    if (!files.length) return;
    setBusy('Загрузка файлов...');
    try {
      const added: FileRef[] = [];
      for (const file of files) {
        if (file.size > 10 * 1024 * 1024) {
          const buf = await file.arrayBuffer();
          const sha256 = await sha256Hex(buf);
          const init = await chatApi.initLargeUpload({ name: file.name, size: file.size, sha256, mime: file.type || null, scope: props.scope });
          if (!init?.ok) throw new Error(init?.error ?? 'upload failed');
          if (init.uploadUrl) await fetch(init.uploadUrl, { method: 'PUT', body: new Blob([buf]) });
          added.push(init.file as any);
        } else {
          const up = await chatApi.uploadSmallFile(file, props.scope);
          if (!up?.ok) throw new Error(up?.error ?? 'upload failed');
          added.push(up.file as any);
        }
      }
      const merged = [...list];
      for (const f of added) {
        if (!merged.find((x) => x.id === f.id)) merged.push(f);
      }
      const r = await props.onChange(merged);
      if (!r.ok) {
        setBusy(`Ошибка: ${r.error}`);
        setTimeout(() => setBusy(''), 3000);
        return;
      }
      setBusy('Готово');
      setTimeout(() => setBusy(''), 700);
    } catch (e) {
      setBusy(`Ошибка: ${String(e)}`);
      setTimeout(() => setBusy(''), 3000);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function openFile(fileId: string) {
    const u = await chatApi.fileUrl(fileId).catch(() => null);
    if (u?.ok && u.url) {
      window.open(u.url as string, '_blank', 'noopener,noreferrer');
      return;
    }
    const access = localStorage.getItem('matrica_access_token');
    const apiBase = (import.meta as any).env?.VITE_API_BASE_URL ?? '';
    const r = await fetch(`${apiBase}/files/${encodeURIComponent(fileId)}`, {
      headers: access ? { Authorization: `Bearer ${access}` } : undefined,
    });
    if (!r.ok) return;
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function toggleObsoleteFlag(fileId: string, nextObsolete: boolean) {
    if (!props.canUpload) return;
    const next = list.map((file) => {
      if (file.id !== fileId) return file;
      if (nextObsolete) return { ...file, isObsolete: true };
      const { isObsolete: _isObsolete, ...clean } = file;
      return clean;
    });
    const r = await props.onChange(next);
    if (!r.ok) {
      setBusy(`Ошибка: ${r.error}`);
      setTimeout(() => setBusy(''), 3000);
      return;
    }
    setBusy(nextObsolete ? 'Файл помечен как «Устаревшая версия»' : 'Пометка снята');
    setTimeout(() => setBusy(''), 1200);
  }

  if (!props.canView) return null;

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <strong>{props.title ?? 'Вложения'}</strong>
        <span style={{ flex: 1 }} />
        {busy && <div style={{ color: busy.startsWith('Ошибка') ? '#b91c1c' : '#6b7280', fontSize: 12 }}>{busy}</div>}
        {props.canUpload && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                const files = e.target.files ? Array.from(e.target.files) : [];
                void addFiles(files);
              }}
            />
            <Button
              variant="ghost"
              onClick={() => {
                fileInputRef.current?.click();
              }}
            >
              Добавить файл
            </Button>
          </>
        )}
      </div>
      <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>
          <span>Фильтр:</span>
          <select
            value={filterMode}
            onChange={(e) => setFilterMode(e.target.value as FileFilterMode)}
            style={{ minWidth: 280, padding: '4px 8px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff' }}
          >
            <option value="actual">Показывать только актуальные файлы</option>
            <option value="obsolete">Только устаревшие</option>
            <option value="all">Показать все файлы</option>
          </select>
        </label>
        <div style={{ fontSize: 12, color: '#6b7280' }}>
          Показано: {filteredList.length} из {list.length}
        </div>
      </div>

      <div style={{ marginTop: 10, border: '1px solid #f3f4f6', borderRadius: 10, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              <th style={{ textAlign: 'left', padding: 8 }}>Файл</th>
              <th style={{ textAlign: 'left', padding: 8, width: 170 }}>Статус</th>
              <th style={{ textAlign: 'left', padding: 8, width: 120 }}>Размер</th>
              <th style={{ textAlign: 'left', padding: 8, width: 180 }}>Действия</th>
            </tr>
          </thead>
          <tbody>
            {filteredList.map((f) => (
              <tr key={f.id}>
                <td style={{ borderTop: '1px solid #f3f4f6', padding: 8 }}>
                  <div style={{ fontSize: 14 }}>{f.name}</div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>{f.mime ?? ''}</div>
                </td>
                <td style={{ borderTop: '1px solid #f3f4f6', padding: 8 }}>
                  {isObsoleteFile(f) ? (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        padding: '2px 8px',
                        borderRadius: 999,
                        fontSize: 12,
                        fontWeight: 600,
                        background: '#fee2e2',
                        color: '#991b1b',
                        border: '1px solid #fecaca',
                      }}
                    >
                      Устаревшая версия
                    </span>
                  ) : (
                    <span style={{ fontSize: 12, color: '#6b7280' }}>Актуальная</span>
                  )}
                </td>
                <td style={{ borderTop: '1px solid #f3f4f6', padding: 8 }}>{formatBytes(f.size)}</td>
                <td style={{ borderTop: '1px solid #f3f4f6', padding: 8 }}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Button variant="ghost" onClick={() => void openFile(f.id)}>
                      Открыть
                    </Button>
                    {props.canUpload && (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          void toggleObsoleteFlag(f.id, !isObsoleteFile(f));
                        }}
                      >
                        {isObsoleteFile(f) ? 'Снять пометку' : 'Пометить устаревшей'}
                      </Button>
                    )}
                    {props.canUpload && (
                      <Button
                        variant="ghost"
                        onClick={async () => {
                          const next = list.filter((x) => x.id !== f.id);
                          const r = await props.onChange(next);
                          if (!r.ok) setBusy(`Ошибка: ${r.error}`);
                          else setBusy('Удалено');
                          setTimeout(() => setBusy(''), 1200);
                        }}
                      >
                        Убрать
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {filteredList.length === 0 && (
              <tr>
                <td colSpan={4} style={{ padding: 10, color: '#6b7280' }}>
                  {list.length === 0 ? `Нет вложений. ${props.canUpload ? 'Нажмите «Добавить файл».' : ''}` : 'По выбранному фильтру файлы не найдены.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
