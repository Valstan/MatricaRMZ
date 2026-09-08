import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Закрытие программы с несохранёнными карточками (владелец 08.09.2026). Рвётся молча:
// таймер, который не идёт, оставляет окно висеть навсегда; таймер, который идёт при обычном
// переходе между карточками, наоборот молча дожимает legacy-карточку в save. Отдельно —
// «Перейти в карточку»: если не ответить окну `allowClose: false`, программа закроется,
// хотя оператор попросил остаться.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const APP = src('./App.tsx');

describe('закрытие программы с несохранённым', () => {
  it('отсчёт при выходе длиннее, чем при переходе между карточками', () => {
    expect(APP).toContain('setCardCloseCountdown(fromApp ? 30 : 10);');
  });

  it('таймер идёт при выходе всегда, а при переходе — только для карточек с черновиком', () => {
    expect(APP).toContain('if (supportsDraft || fromApp) {');
  });

  it('по истечении срока данные становятся черновиком, а не пропадают', () => {
    // keepDraft у карточки без поддержки черновика падает на saveAndClose — это запись,
    // а не потеря; молчаливой она не будет: список карточек висел все 30 секунд.
    expect(APP).toContain("void finalizeCardClose('keepDraft');");
    expect(APP).toContain('if (actions.keepDraft) await actions.keepDraft();');
  });

  it('модал называет карточки поимённо, а не считает их', () => {
    expect(APP).toContain('setCardCloseLabels(');
    expect(APP).toContain('data-card-close-list');
  });

  it('«Перейти в карточку» отменяет закрытие программы, а не откладывает его', () => {
    expect(APP).toContain('data-card-close-goto');
    expect(APP).toContain('const cancelCardCloseAndGoBack = useCallback(() => {');
    expect(APP, 'без ответа окну программа закроется вопреки просьбе оператора').toContain(
      "window.matrica.app.respondToCloseRequest({ allowClose: false });",
    );
  });

  it('отмена не сохраняет и не отбрасывает — карточка остаётся как есть', () => {
    const cancel = APP.slice(
      APP.indexOf('const cancelCardCloseAndGoBack'),
      APP.indexOf('const finalizeCardClose = useCallback'),
    );
    expect(cancel).not.toContain('saveAndClose');
    expect(cancel).not.toContain('closeWithoutSave');
    expect(cancel, 'отсчёт обязан остановиться, иначе решение примут за оператора').toContain('clearCardCloseTimer();');
  });
});
