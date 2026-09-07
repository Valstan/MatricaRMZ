import React, { useEffect, useState } from 'react';

import type { ClientOpsBundleInfo } from '@matricarmz/shared';

import { Button } from './Button.js';

/**
 * «Скрипты обслуживания» — окно доступа к архиву, который едет вместе с клиентом.
 *
 * Зачем окно, а не запуск по кнопке: скрипты правят настройки антивируса и брандмауэра, часть
 * из них требует прав администратора, и запускать их за оператора вслепую нельзя. Программа
 * доводит его до файлов и говорит пароль — дальше он делает это сам, как и раньше делал с
 * архивом на рабочем столе Windows. Разница в том, что теперь этот путь не пропадает при
 * переустановке и есть на КАЖДОЙ машине, а не только там, где ярлык уцелел.
 */
export function ClientOpsDialog(props: { open: boolean; onClose: () => void; notify?: (text: string, tone?: 'info' | 'error') => void }) {
  const [bundle, setBundle] = useState<ClientOpsBundleInfo | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    void (async () => {
      try {
        setBundle(await window.matrica.clientOps.bundle());
      } catch {
        setBundle(null);
      }
    })();
  }, [props.open]);

  if (!props.open) return null;

  const run = async (action: 'reveal' | 'saveCopy') => {
    setBusy(true);
    try {
      const res = action === 'reveal' ? await window.matrica.clientOps.reveal() : await window.matrica.clientOps.saveCopy();
      if (!res.ok) props.notify?.(res.error, 'error');
      else if (action === 'saveCopy') props.notify?.('Копия положена в «Загрузки» — папка открыта.');
    } catch (e) {
      props.notify?.(`Не удалось открыть архив: ${String(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(2, 6, 23, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1200,
        padding: 16,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        data-client-ops-dialog
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 20,
          maxWidth: 640,
          width: '100%',
          display: 'grid',
          gap: 12,
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 18 }}>🧰 Скрипты обслуживания</div>

        {bundle?.available ? (
          <>
            <div style={{ color: 'var(--subtle)' }}>
              Внутри архива:
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {bundle.contents.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
            <div
              style={{
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '8px 10px',
              }}
            >
              Пароль архива — <b>{bundle.password}</b>. Он не секрет: без пароля антивирус успевает
              удалить скрипт раньше, чем для него заведено исключение. Проводник Windows распакует
              такой архив сам, ничего доустанавливать не нужно.
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button onClick={() => void run('reveal')} disabled={busy}>
                Показать в проводнике
              </Button>
              <Button variant="ghost" onClick={() => void run('saveCopy')} disabled={busy}>
                Сохранить копию в «Загрузки»
              </Button>
              <div style={{ flex: 1 }} />
              <Button variant="ghost" onClick={props.onClose}>
                Закрыть
              </Button>
            </div>
          </>
        ) : (
          <>
            <div style={{ color: 'var(--danger)' }}>
              В этой сборке клиента архива со скриптами нет. Так бывает у сборки для разработки; на
              рабочей машине сообщите об этом — значит, ресурс не попал в установщик.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={props.onClose}>
                Закрыть
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
