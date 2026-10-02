import React, { useEffect, useState } from 'react';

import { parseEngineQrValue } from '@matricarmz/shared';

/**
 * Кнопка «Сканировать QR с бирки» для поисков и подборов двигателя.
 * Видна только там, где мост умеет сканировать (планшет с камерой); на десктопе
 * и в браузере не рисуется вовсе.
 *
 * Поток один на всех: скан → разбор `engine:<id>` → номер двигателя через
 * `engines.get` → `onEngineNumber`. Вызывающий кладёт номер туда, куда оператор
 * вводит текст руками (поле поиска, пикер) — дальше работает штатная логика:
 * отбор, точное совпадение, диалог «не найдено». Ошибки — короткой строкой
 * рядом с кнопкой, гаснет сама.
 */
export function EngineQrScanButton(props: {
  onEngineNumber: (engineNumber: string) => void;
  title?: string;
}) {
  const [supported, setSupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    try {
      const api = (window as unknown as { matrica?: { scan?: { qrSupported: () => Promise<unknown> } } })
        .matrica?.scan;
      if (!api) return undefined;
      void api
        .qrSupported()
        .then((r) => {
          if (alive) setSupported((r as { ok?: boolean; supported?: boolean })?.supported === true);
        })
        .catch(() => {});
    } catch {
      // моста нет (тесты) — кнопки нет
    }
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!error) return undefined;
    const t = window.setTimeout(() => setError(''), 4000);
    return () => window.clearTimeout(t);
  }, [error]);

  if (!supported) return null;

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const bridge = (window as unknown as { matrica?: typeof window.matrica }).matrica;
      if (!bridge) {
        setError('Мост недоступен');
        return;
      }
      const r = await bridge.scan.qrScan();
      if (!r.ok) {
        if (!r.cancelled) setError(r.error || 'Не удалось отсканировать');
        return;
      }
      const engineId = parseEngineQrValue(r.text);
      if (!engineId) {
        setError('Это не бирка двигателя');
        return;
      }
      const details = await bridge.engines.get(engineId);
      const number = String(details?.attributes?.engine_number ?? '').trim();
      if (!number) {
        setError('Двигатель не найден');
        return;
      }
      props.onEngineNumber(number);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e ?? 'Не удалось отсканировать'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button
        type="button"
        data-qr-scan-engine
        title={props.title ?? 'Сканировать QR с бирки двигателя'}
        aria-label="Сканировать QR с бирки"
        disabled={busy}
        onClick={() => void run()}
        style={{
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '6px 9px',
          borderRadius: 10,
          border: '1px solid var(--button-ghost-border)',
          background: 'var(--button-ghost-bg)',
          cursor: busy ? 'wait' : 'pointer',
          color: 'var(--text)',
          minHeight: 36,
          fontSize: 16,
        }}
      >
        {busy ? '…' : '📷'}
      </button>
      {error ? (
        <span role="alert" style={{ fontSize: 12, color: 'var(--danger)', maxWidth: 220 }}>
          {error}
        </span>
      ) : null}
    </span>
  );
}

