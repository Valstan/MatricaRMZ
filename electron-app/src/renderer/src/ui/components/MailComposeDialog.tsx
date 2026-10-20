import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import type { CardExportSpec, ListExportFormat, ListExportSpec } from '@matricarmz/shared';

import { Button } from './Button.js';
import { FormField } from './FormField.js';
import { Input } from './Input.js';

export type MailAttachment =
  | { kind: 'list'; format: ListExportFormat; spec: ListExportSpec }
  | { kind: 'card'; spec: CardExportSpec };

export type MailComposeProps = {
  subject: string;
  /** Строки сводки: что за форма, сколько строк, какой отбор. */
  summary: readonly string[];
  /** Полный текст письма: таблица или карточка в читаемом виде. */
  body: string;
  attachment?: MailAttachment;
  onClose: () => void;
};

const TEXTAREA_STYLE: React.CSSProperties = {
  width: '100%',
  minHeight: 180,
  maxHeight: '40vh',
  resize: 'vertical',
  fontFamily: 'inherit',
  fontSize: 13,
  lineHeight: 1.5,
  padding: 8,
  borderRadius: 8,
  border: '1px solid var(--border)',
  background: 'var(--input-bg, #fff)',
  color: 'var(--text)',
};

/**
 * Письмо с формой программы (владелец 20.10.2026: «рядом с каждой кнопкой печати/Word/Excel»).
 *
 * Транспорт выбран по возможностям завода: своего почтового сервера нет, поэтому программа
 * готовит письмо и файл, а отправляет клиент оператора. Текст всегда кладётся в буфер обмена —
 * это единственный путь, который работает и в веб-почте, и в Outlook, и на машине без клиента.
 */
export function MailComposeDialog(props: MailComposeProps) {
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState(props.subject);
  const [text, setText] = useState([...props.summary, '', props.body].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n'));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [attachment, setAttachment] = useState<{ path: string; name: string } | null>(null);

  // Файл собирается сразу при открытии окна: к моменту «Открыть почту» он уже лежит на диске,
  // и оператору не приходится ждать сборку с открытым почтовым клиентом.
  useEffect(() => {
    if (!props.attachment) return;
    let alive = true;
    void (async () => {
      const res = await window.matrica.mail.prepareAttachment(props.attachment!).catch(() => null);
      if (!alive) return;
      if (res?.ok) setAttachment({ path: res.path, name: res.name });
      else setStatus(`Ошибка вложения: ${res && !res.ok ? res.error : 'не удалось собрать файл'}`);
    })();
    return () => {
      alive = false;
    };
  }, [props.attachment]);

  const copyText = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus('Текст письма скопирован в буфер обмена');
    } catch {
      setStatus('Не удалось скопировать текст — выделите его и скопируйте вручную');
    }
  }, [text]);

  async function openMail() {
    setBusy(true);
    try {
      // Копируем ДО открытия клиента: `mailto:` режет длинный текст, а в буфере он остаётся
      // целиком, и оператор вставляет его одним движением.
      await navigator.clipboard.writeText(text).catch(() => undefined);
      const res = await window.matrica.mail.openDraft({ to, cc, subject, body: text });
      setStatus(
        res.ok
          ? `Письмо открыто в почтовом клиенте. Текст — в буфере обмена${attachment ? `, файл «${attachment.name}» — в папке писем` : ''}.`
          : `Ошибка: ${res.error}`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function reveal() {
    if (!attachment) return;
    const res = await window.matrica.mail.revealAttachment({ path: attachment.path }).catch(() => null);
    if (res && !res.ok) setStatus(`Ошибка: ${res.error}`);
  }

  return createPortal(
    <div
      onClick={props.onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        zIndex: 1300,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: 24,
        overflow: 'auto',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        data-mail-compose="1"
        style={{
          background: 'var(--card-bg, #fff)',
          color: 'var(--text)',
          borderRadius: 12,
          padding: 16,
          width: 'min(720px, 96vw)',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 16 }}>Письмо</div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <FormField label="Кому">
            <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="адрес; адрес" />
          </FormField>
          <FormField label="Копия">
            <Input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="необязательно" />
          </FormField>
        </div>

        <FormField label="Тема">
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </FormField>

        <FormField label="Текст письма">
          <textarea value={text} onChange={(e) => setText(e.target.value)} style={TEXTAREA_STYLE} />
        </FormField>

        {props.attachment ? (
          <div style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span>📎 {attachment ? attachment.name : 'готовим файл…'}</span>
            {attachment ? (
              <Button variant="ghost" onClick={() => void reveal()}>
                Показать в папке
              </Button>
            ) : null}
          </div>
        ) : null}

        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
          {props.attachment
            ? 'Почтовый клиент не умеет прикреплять файлы по ссылке: нажмите «Показать в папке» и перетащите файл в письмо. Полный текст письма уже скопирован.'
            : 'Полный текст письма копируется в буфер обмена при открытии клиента.'}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <Button variant="ghost" onClick={() => void copyText()}>
            Скопировать текст
          </Button>
          <Button variant="primary" onClick={() => void openMail()} disabled={busy}>
            {busy ? 'Открываем…' : 'Открыть почту'}
          </Button>
          <Button variant="ghost" onClick={props.onClose}>
            Закрыть
          </Button>
        </div>

        {status ? <div style={{ fontSize: 13, color: status.startsWith('Ошибка') ? 'var(--danger, #b91c1c)' : 'var(--muted)' }}>{status}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
