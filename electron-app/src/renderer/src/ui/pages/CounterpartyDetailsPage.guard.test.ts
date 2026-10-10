import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Карточка контрагента (аудит кнопок 10.10.2026, чинено по канону #1240):
// ресид поверх грязного затирал форму, «Сброс» был мёртв, провал вложений
// чистил черновик с копией, закрытие шло мимо результата сохранения.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('./CounterpartyDetailsPage.tsx');

describe('карточка контрагента бережёт введённое', () => {
  it('ресид не срабатывает поверх грязной карточки', () => {
    expect(PAGE).toContain('if (dirtyRef.current) return;');
  });

  it('сохранение вложений не перезагружает карточку', () => {
    // saveAttr пишет и выходит: load() после setAttr бампал updatedAt и ресид затирал форму.
    const fn = PAGE.slice(PAGE.indexOf('async function saveAttr'), PAGE.indexOf('function applyStrictRow'));
    expect(fn, 'в saveAttr не должно быть перезагрузки').not.toContain('load()');
  });

  it('saveAttr и saveAllAndClose возвращают успех — провал не чистят и не закрывают', () => {
    expect(PAGE).toContain('async function saveAttr(code: string, value: unknown): Promise<boolean>');
    expect(PAGE).toContain('async function saveAllAndClose(): Promise<boolean>');
    expect(PAGE, 'вложения при провале обязаны остановить коммит до clearDraft').toContain(
      "if (!(await saveAttr('attachments', attachments))) return false;",
    );
    expect(PAGE, 'закрытие мимо результата').toContain('saveAllAndClose().then((ok) => { if (ok) props.onClose(); })');
  });

  it('«Сброс» гасит dirty и чистит черновик ДО перезагрузки и форсирует ресид', () => {
    const norm = PAGE.split('\n')
      .map((line) => line.trim())
      .join('\n');
    const snippet = 'dirtyRef.current = false;\ncancelPendingDraftSave();\nawait clearDraft();';
    const hits = norm.split(snippet).length - 1;
    expect(hits, 'оба пути сброса (тулбар и close-actions) обязаны гасить dirty до ресида').toBe(2);
    expect(PAGE, 'без ключа пересева сброс мёртв при неизменном updatedAt').toContain('setReseedKey((k) => k + 1)');
  });
});
