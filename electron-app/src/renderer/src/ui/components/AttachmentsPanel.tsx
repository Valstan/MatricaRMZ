import React, { useMemo, useState } from 'react';

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

export function AttachmentsPanel(props: {
  title?: string;
  value: unknown; // FileRef[] in JSON
  canView: boolean;
  canUpload: boolean;
  scope?: { ownerType: string; ownerId: string; category: string };
  onChange: (next: FileRef[]) => Promise<void> | void;
}) {
  const [busy, setBusy] = useState<string>('');

  const list = useMemo(() => normalizeList(props.value), [props.value]);

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
      await props.onChange(merged);
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
                <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{f.name}</td>
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
                            setBusy('Удаление файла...');
                            const deleteResult = await window.matrica.files.delete({ fileId: f.id });
                            if (!deleteResult.ok) {
                              setBusy(`Ошибка: ${deleteResult.error}`);
                              setTimeout(() => setBusy(''), 3000);
                              return;
                            }
                            const next = list.filter((x) => x.id !== f.id);
                            await props.onChange(next);
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


