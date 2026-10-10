import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Заявка в снабжение (аудит кнопок 10.10.2026, чинено по канону #1240):
// смена статуса поверх грязного теряла правки, сброс чистил после,
// подпись «Автосохранение» врала (автосейвится только черновик).
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('./SupplyRequestDetailsPage.tsx');

describe('заявка в снабжение бережёт введённое', () => {
  it('переходы статуса идут через flush грязного', () => {
    expect(PAGE).toContain('async function transitionWithFlush(action: string)');
    for (const action of ['sign', 'director_approve', 'accept', 'fulfill_full', 'fulfill_partial']) {
      expect(PAGE, `переход ${action} мимо flush`).toContain(`void transitionWithFlush('${action}');`);
    }
    const direct = PAGE.split('supplyRequests.transition').length - 1;
    expect(direct, 'прямой transition мимо flush вернулся — все кнопки идут через transitionWithFlush').toBe(1);
  });

  it('saveAllAndClose возвращает успех — закрытие идёт по результату', () => {
    expect(PAGE).toContain('async function saveAllAndClose(): Promise<boolean>');
    expect(PAGE).toContain('saveAllAndClose().then((ok) => { if (ok) props.onClose(); })');
  });

  it('«Сброс» гасит изменения и чистит черновик ДО перезагрузки', () => {
    const norm = PAGE.split('\n')
      .map((line) => line.trim())
      .join('\n');
    expect(norm).toContain('sessionHadChanges.current = false;');
    expect(norm.split('await clearDraft();\nawait load();').length - 1, 'оба пути сброса чистят черновик до load').toBe(2);
  });

  it('подпись не врёт про автосохранение', () => {
    expect(PAGE).not.toContain('изменения сохраняются автоматически');
  });
});
