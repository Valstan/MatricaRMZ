import { useEffect, useState } from 'react';

import {
  fileTransferPercent,
  fileTransferPhaseLabel,
  formatFileSize,
  isFileTransferActive,
  type FileTransferProgress,
} from '@matricarmz/shared';

import { useFileTransfers } from '../hooks/useFileTransfers';

/**
 * Общая полоса передачи файлов — видна на любом экране.
 *
 * ЗАЧЕМ. Оператор отправляет файл в чат и не понимает, летит он или завис; он жмёт
 * «скачать» десять раз, потому что не видит, что файл качается. Полоса отвечает на
 * оба вопроса: ЧТО передаётся и СКОЛЬКО осталось.
 *
 * НЕОПРЕДЕЛЁННАЯ ПОЛОСА — честная. Если транспорт не умеет считать байты (например,
 * маленький файл уходит в base64-JSON), процент НЕ выдумывается: показывается
 * «крутилка» и имя файла. Враньё про проценты хуже честного «не знаю».
 */
const FINISHED_KEEP_MS = 4000;

function isVisible(t: FileTransferProgress, now: number): boolean {
  if (isFileTransferActive(t)) return true;
  return now - t.updatedAt < FINISHED_KEEP_MS;
}

export function FileTransferProgressPanel() {
  const { transfers } = useFileTransfers();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Раз в секунду пересчитываем «пора спрятать завершённое» — иначе готовая
    // передача висела бы на экране до перерисовки.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const visible = transfers.filter((t) => isVisible(t, now));
  if (visible.length === 0) return null;

  return (
    <div
      data-file-progress-panel="true"
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 3600,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        width: 320,
        maxWidth: 'calc(100vw - 32px)',
      }}
    >
      <style>{`
        @keyframes mx-file-progress-indeterminate {
          0% { margin-left: -35%; }
          100% { margin-left: 100%; }
        }
      `}</style>
      {visible.map((t) => {
        const pct = fileTransferPercent(t);
        const active = isFileTransferActive(t);
        const failed = t.phase === 'error';
        return (
          <div
            key={t.id}
            data-file-progress-row="true"
            data-phase={t.phase}
            style={{
              background: '#111827',
              color: '#f9fafb',
              borderRadius: 10,
              padding: '10px 12px',
              boxShadow: '0 10px 30px rgba(15, 23, 42, 0.35)',
              fontSize: 13,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span aria-hidden="true" style={{ fontSize: 15 }}>
                {t.direction === 'upload' ? '↑' : '↓'}
              </span>
              <span
                style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={t.fileName}
              >
                {t.fileName}
              </span>
              <span style={{ color: failed ? '#fca5a5' : '#cbd5f5', whiteSpace: 'nowrap' }}>
                {failed ? 'Ошибка' : pct != null ? `${pct}%` : fileTransferPhaseLabel(t)}
              </span>
            </div>
            <div
              style={{
                marginTop: 6,
                height: 6,
                borderRadius: 3,
                background: 'rgba(255,255,255,0.18)',
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              {pct != null ? (
                <div
                  style={{
                    width: `${Math.max(2, pct)}%`,
                    height: '100%',
                    background: failed ? '#ef4444' : active ? '#60a5fa' : '#34d399',
                    transition: 'width 120ms linear',
                  }}
                />
              ) : (
                <div
                  style={{
                    width: '35%',
                    height: '100%',
                    background: '#60a5fa',
                    animation: 'mx-file-progress-indeterminate 1.2s linear infinite',
                  }}
                />
              )}
            </div>
            <div style={{ marginTop: 5, color: '#cbd5f5', fontSize: 12 }}>
              {failed
                ? String(t.error ?? 'не удалось передать файл')
                : `${fileTransferPhaseLabel(t)} · ${formatFileSize(t.bytesDone)}${
                    t.bytesTotal ? ` / ${formatFileSize(t.bytesTotal)}` : ''
                  }`}
            </div>
          </div>
        );
      })}
    </div>
  );
}
