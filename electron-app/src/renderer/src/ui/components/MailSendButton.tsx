import React, { useState } from 'react';

import { isAndroidPlatform } from '../platform.js';
import { Button } from './Button.js';
import { MailComposeDialog, type MailAttachment } from './MailComposeDialog.js';

type Lazy<T> = T | (() => T);

/**
 * Кнопка «Почта» рядом с печатью/выгрузкой: одно и то же письмо для любой формы программы.
 *
 * Вложение и текст можно отдать функциями: список на десять тысяч строк и форма документа
 * не должны собираться при каждой перерисовке страницы — только когда оператор действительно
 * нажал «Почта».
 *
 * Планшет не умеет ни вложений, ни `mailto:` — кнопка там не показывается, как и выгрузка.
 */
export function MailSendButton(props: {
  subject: string;
  summary: Lazy<readonly string[]>;
  body: Lazy<string>;
  attachment?: Lazy<MailAttachment>;
  disabled?: boolean;
  label?: string;
  /** `data-*` для смоука: у кнопок выгрузки уже есть `data-list-export`. */
  dataAttr?: string;
}) {
  const [open, setOpen] = useState(false);
  const [payload, setPayload] = useState<{ summary: readonly string[]; body: string; attachment: MailAttachment | null } | null>(null);
  if (isAndroidPlatform()) return null;

  const openWithPayload = () => {
    setPayload({
      summary: typeof props.summary === 'function' ? props.summary() : props.summary,
      body: typeof props.body === 'function' ? props.body() : props.body,
      attachment: props.attachment == null ? null : typeof props.attachment === 'function' ? props.attachment() : props.attachment,
    });
    setOpen(true);
  };

  return (
    <>
      <Button
        variant="ghost"
        disabled={props.disabled}
        onClick={openWithPayload}
        title="Отправить по почте: письмо с этой формой и файлом вложения"
        {...(props.dataAttr ? { 'data-mail-send': props.dataAttr } : {})}
      >
        {props.label ?? 'Почта'}
      </Button>
      {open && payload ? (
        <MailComposeDialog
          subject={props.subject}
          summary={payload.summary}
          body={payload.body}
          {...(payload.attachment ? { attachment: payload.attachment } : {})}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
