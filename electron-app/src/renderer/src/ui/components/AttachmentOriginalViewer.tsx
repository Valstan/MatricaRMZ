import React, { useEffect } from 'react';

import { Button } from './Button.js';
import { PopupLayer } from './PopupLayer.js';

/**
 * Полноэкранный просмотр вложения В ПРОГРАММЕ.
 *
 * Нужен планшету: файловой системы там нет, поэтому «Открыть» не может открыть
 * файл в системном приложении — канала `files:open` на планшете не заведено, и
 * оператор вместо результата видел внутренний текст шима («канал не заведён на
 * планшете…»). Но оригинал программа умеет: тот же путь, что у галереи фото
 * двигателей (`files:original:get` → data:URL). Значит, фото показывается здесь.
 *
 * Рисуется порталом: на планшете `position: fixed` внутри прокручиваемого
 * предка рисуется в слое предка (см. PopupLayer) — без портала полноэкранный
 * просмотр уехал бы под панель.
 */
export function AttachmentOriginalViewer(props: {
  /** Имя файла — подписью сверху. */
  name: string;
  /** Оригинал файла как data:URL. */
  dataUrl: string;
  onClose: () => void;
}) {
  const { onClose } = props;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <PopupLayer>
      <div
        data-attachment-original-viewer
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'radial-gradient(circle at center, rgba(30,41,59,0.94), rgba(2,6,23,0.98))',
          zIndex: 1000,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '12px 18px',
            color: '#e2e8f0',
          }}
        >
          <span style={{ fontSize: 14 }}>{props.name}</span>
          <Button variant="ghost" onClick={onClose}>
            Закрыть ✕
          </Button>
        </div>
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 18px 18px',
            minHeight: 0,
          }}
        >
          <img
            src={props.dataUrl}
            alt={props.name}
            style={{
              maxWidth: '94vw',
              maxHeight: '80vh',
              objectFit: 'contain',
              borderRadius: 10,
              boxShadow: '0 18px 60px rgba(0,0,0,0.42)',
            }}
          />
        </div>
      </div>
    </PopupLayer>
  );
}
