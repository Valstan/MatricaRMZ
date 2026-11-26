import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Сторож почтового ограничения (промт КАРМАНА #144, «действия с принятыми файлами»).
//
// Владелец спросил: «умеет ли программа отправлять письма с вложениями?». Ответ проверен
// 26.11.2026 — НЕТ, и вот почему: своего почтового сервера у завода нет (решение владельца
// 20.10.2026), а `mailto:` вложений не умеет по определению протокола. `prepareAttachment`
// собирает только ВЫГРУЗКУ ФОРМЫ (список или карточка) — произвольные файлы в неё не попадают.
//
// Пока ответ не изменился, программа ОБЯЗАНА говорить это оператору словами, а не молча
// отправлять пустое письмо. Сторож держит обе стороны: и почтовый модуль, и слова оператору.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const MAIL = src('./mail.ts');
const PANE = src('../../../renderer/src/ui/components/DesktopPane.tsx');
const MAIL_SERVICE = src('../../services/mailService.ts');

describe('почта не умеет вложения — и это зафиксировано', () => {
  it('почтовый модуль говорит об этом прямо, а не оставляет догадываться', () => {
    expect(MAIL).toContain('MAIL_CAN_ATTACH_FILES = false');
    expect(MAIL).toContain('MAIL_ATTACHMENT_LIMITATION');
  });

  it('указана причина: нет своего сервера, mailto: вложений не умеет', () => {
    expect(MAIL).toContain('mailto:');
    expect(MAIL).toContain('вложений не умеет');
  });

  it('подготовить можно только выгрузку формы — произвольные файлы туда не попадают', () => {
    expect(MAIL).toContain("args.kind !== 'list' && args.kind !== 'card'");
    expect(MAIL_SERVICE).toContain("attachment.kind === 'list'");
  });

  it('оператору сказано то же, что зафиксировано в модуле', () => {
    // Молча отправить пустое письмо — значит солгать оператору, что файл ушёл.
    expect(PANE).toContain('Письмо открыто без вложений');
    expect(PANE).toContain('перетащите их в письмо');
  });

  it('файлы к письму готовятся через файловый слой — с проверкой доступа', () => {
    // Обход файлового слоя дал бы файлы мимо учёта и без проверки прав.
    expect(PANE).toContain('window.matrica.files.revealForShare');
    expect(PANE).not.toContain('prepareAttachment');
  });
});
