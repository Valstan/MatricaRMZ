import React, { useEffect, useState } from 'react';

import type { ClientOpsBundleInfo, ClientOpsTab } from '@matricarmz/shared';

import { Button } from './Button.js';

/**
 * «Скрипты обслуживания» — вход в окно обслуживания машины.
 *
 * Раньше здесь заканчивалась помощь программы: оператору показывали архив и пароль, а дальше
 * он сам — найти файл, распаковать, выбрать из двух `.cmd` нужный, догадаться про права
 * администратора. Каждый из этих шагов терял часть парка. Теперь кнопка делает всё: клиент
 * распаковывает архив своим ключом и открывает окно, где утилиты разложены по вкладкам.
 *
 * Показ архива в проводнике и копия в «Загрузки» остались ЗАПАСНЫМ путём, а не основным:
 * они нужны, когда окно не открылось (нет PowerShell, политика запуска, чужая машина) —
 * тогда у оператора по-прежнему есть файл и пароль к нему.
 */
export function ClientOpsDialog(props: { open: boolean; onClose: () => void; notify?: (text: string, tone?: 'info' | 'error') => void }) {
  const [bundle, setBundle] = useState<ClientOpsBundleInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [fallbackOpen, setFallbackOpen] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    setFallbackOpen(false);
    void (async () => {
      try {
        setBundle(await window.matrica.clientOps.bundle());
      } catch {
        setBundle(null);
      }
    })();
  }, [props.open]);

  if (!props.open) return null;

  const launch = async (tab: ClientOpsTab) => {
    setBusy(true);
    try {
      const res = await window.matrica.clientOps.launch({ tab });
      if (!res.ok) {
        props.notify?.(res.error, 'error');
        // Окно не открылось — оставляем оператора у запасного пути, а не у пустого экрана.
        setFallbackOpen(true);
        return;
      }
      // Окно поднимается несколько секунд (сбор данных о компьютере), и всё это время оно
      // ничем не проявляется. Без этой строки оператор успевает нажать кнопку второй раз.
      props.notify?.('Открываю окно обслуживания — оно появится через несколько секунд. Windows может спросить права администратора.');
      props.onClose();
    } catch (e) {
      props.notify?.(`Не удалось открыть окно обслуживания: ${String(e)}`, 'error');
      setFallbackOpen(true);
    } finally {
      setBusy(false);
    }
  };

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
              Откроется окно с вкладками:
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {bundle.contents.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>

            {bundle.canLaunch ? (
              <>
                <div
                  style={{
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: '8px 10px',
                  }}
                >
                  Программа распакует скрипты сама и откроет окно. Windows может спросить права
                  администратора — они нужны только правилу брандмауэра; без них окно тоже
                  работает и готовит строки для Касперского.
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Button onClick={() => void launch('kaspersky')} disabled={busy}>
                    Открыть окно обслуживания
                  </Button>
                  <Button variant="ghost" onClick={() => void launch('lan')} disabled={busy}>
                    Сразу к раздаче соседям
                  </Button>
                  <div style={{ flex: 1 }} />
                  <Button variant="ghost" onClick={props.onClose}>
                    Закрыть
                  </Button>
                </div>
              </>
            ) : (
              <div
                style={{
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '8px 10px',
                }}
              >
                Открыть окно на этой системе нельзя — скрипты рассчитаны на Windows. Архив можно
                забрать вручную: пароль <b>{bundle.password}</b>.
              </div>
            )}

            {fallbackOpen || !bundle.canLaunch ? (
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, display: 'grid', gap: 8 }}>
                <div style={{ color: 'var(--subtle)', fontSize: 13 }}>
                  Если окно не открылось — архив можно распаковать руками. Пароль — <b>{bundle.password}</b>; он
                  не секрет, без него антивирус успевает удалить скрипт раньше, чем для него заведено
                  исключение. Проводник Windows такой архив открывает сам.
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Button variant="ghost" onClick={() => void run('reveal')} disabled={busy}>
                    Показать в проводнике
                  </Button>
                  <Button variant="ghost" onClick={() => void run('saveCopy')} disabled={busy}>
                    Сохранить копию в «Загрузки»
                  </Button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex' }}>
                <button
                  type="button"
                  onClick={() => setFallbackOpen(true)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    color: 'var(--subtle)',
                    fontSize: 13,
                    textDecoration: 'underline',
                    cursor: 'pointer',
                  }}
                >
                  Окно не открылось? Забрать архив вручную
                </button>
              </div>
            )}
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
