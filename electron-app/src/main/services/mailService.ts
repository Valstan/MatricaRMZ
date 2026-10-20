import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { app, shell } from 'electron';

import { sanitizeExportFileName, type CardExportSpec, type ListExportFormat, type ListExportSpec } from '@matricarmz/shared';

import { buildCardDocument } from './cardExportService.js';
import { buildListDocument, buildListWorkbook, exportFileExtension } from './listExportService.js';

/**
 * Почта без своего почтового сервера (решение владельца 20.10.2026: «любой транспорт»).
 *
 * Программа собирает то же, что уходит в печать/выгрузку, кладёт файл вложение во временную
 * папку и открывает системный почтовый клиент с готовой темой и текстом. Вложение `mailto:`
 * не умеет — файл лежит рядом, и оператор прикрепляет его в клиенте одним движением. Это
 * честнее, чем «отправить» без вложения, и не требует держать пароль почты на каждой машине.
 */
export type MailAttachmentSpec =
  | { kind: 'list'; format: ListExportFormat; spec: ListExportSpec }
  | { kind: 'card'; spec: CardExportSpec };

/** `mailto:` в Windows-клиентах режется по длине — длинное тело письма там не доедет. */
const MAILTO_BODY_LIMIT = 1800;

export function mailAttachmentDir(): string {
  return join(app.getPath('temp'), 'matrica-mail');
}

export async function prepareMailAttachment(
  attachment: MailAttachmentSpec,
): Promise<{ ok: true; path: string; name: string } | { ok: false; error: string }> {
  try {
    let buffer: Buffer;
    let baseName: string;
    let ext: string;
    if (attachment.kind === 'list') {
      const format: ListExportFormat = attachment.format === 'docx' ? 'docx' : 'xlsx';
      ext = exportFileExtension(format);
      baseName = sanitizeExportFileName(attachment.spec.fileBaseName || attachment.spec.title);
      buffer = format === 'xlsx' ? await buildListWorkbook(attachment.spec) : await buildListDocument(attachment.spec);
    } else {
      ext = '.docx';
      baseName = sanitizeExportFileName(attachment.spec.fileBaseName || attachment.spec.title);
      buffer = await buildCardDocument(attachment.spec);
    }
    const dir = mailAttachmentDir();
    mkdirSync(dir, { recursive: true });
    const name = `${baseName}${ext}`;
    const path = join(dir, name);
    writeFileSync(path, buffer);
    return { ok: true, path, name };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Письмо открывается только с файлом из нашей временной папки: чужой путь от рендерера не принимаем. */
export function revealMailAttachment(path: string): { ok: true } | { ok: false; error: string } {
  const target = String(path ?? '').trim();
  if (!target) return { ok: false, error: 'путь не указан' };
  if (!target.startsWith(mailAttachmentDir())) return { ok: false, error: 'файл не из папки писем' };
  shell.showItemInFolder(target);
  return { ok: true };
}

export async function openMailDraft(args: {
  to?: string;
  cc?: string;
  subject: string;
  body: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const params = new URLSearchParams();
    const subject = String(args?.subject ?? '').trim();
    const body = String(args?.body ?? '');
    const to = String(args?.to ?? '').trim();
    const cc = String(args?.cc ?? '').trim();
    if (subject) params.set('subject', subject);
    params.set('body', body.length > MAILTO_BODY_LIMIT ? `${body.slice(0, MAILTO_BODY_LIMIT)}\n…` : body);
    if (cc) params.set('cc', cc);
    // Плюс в адресе `mailto:` — разделитель, а не пробел: кодируем query, а адресатов — только
    // запятые-разделители, иначе клиент получит один склеенный адрес.
    const recipients = to
      .split(/[,;]/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map(encodeURIComponent)
      .join(',');
    await shell.openExternal(`mailto:${recipients}?${params.toString()}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
