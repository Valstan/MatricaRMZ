import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Сторож разделов заездов в карточке двигателя (владелец 20.11.2026).
//
// Заезды переехали из отдельной вкладки «История заездов» в «Основное» — как раскрывающиеся
// разделы. Тут две вещи, которые ломаются тихо:
//
//  * **Право на историю ремонта.** Вкладка «История ремонта» операционная: её не видно без
//    `operations.view`. Разделы заездов живут в «Основном», его видят и без этого права, —
//    значит историю внутри разделов надо закрыть тем же гейтом. Без гейта «оператор без
//    права на операции» получил бы этапы чужого ремонта прямо в карточке.
//
//  * **Одна правка про текущий/прошлый заезд.** Правило живёт в домене
//    `shared/src/domain/engineVisits.ts`; если карточка начнёт считать «текущий заезд»
//    у себя, «движок сейчас на заводе» и «история по заездам» разъедутся.

function src(rel: string): string {
  // Рабочая копия в CRLF (core.autocrlf=true) — нормализуем, чтобы ассерты не зависели
  // от того, на какой машине сделан checkout.
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PANEL = src('./EngineVisitsPanel.tsx');
const CARD = src('../pages/EngineDetailsPage.tsx');

describe('разделы заездов: история ремонта под тем же правом, что и вкладка «История ремонта»', () => {
  it('карточка передаёт право на операции в панель заездов', () => {
    expect(CARD).toMatch(/<EngineVisitsPanel[\s\S]{0,300}canViewOperations=\{props\.canViewOperations\}/);
  });

  it('историю читают только с правом на операции', () => {
    // Запрос без права всё равно отказали бы на IPC (`ops:list` требует operations.view),
    // но лишний отказ в консоли и пустая таблица «этапов не записано» вводят в заблуждение:
    // у человека просто не видно этапов, а он видит «их нет».
    const fetchAt = PANEL.indexOf('window.matrica.operations.list');
    expect(fetchAt).toBeGreaterThan(-1);
    const around = PANEL.slice(Math.max(0, fetchAt - 400), fetchAt);
    expect(around).toContain('props.canViewOperations');
  });

  it('без права на операции история не рисуется вовсе', () => {
    expect(PANEL).toContain('История ремонта доступна с правом на операции.');
    // Право проверяется ДО ветки «этапов нет» — иначе гейт был бы декорацией.
    const gateAt = PANEL.indexOf('!props.canViewOperations');
    expect(gateAt).toBeGreaterThan(-1);
    expect(PANEL.indexOf('items.length === 0')).toBeGreaterThan(gateAt);
  });

  it('право по умолчанию закрыто — забытый проп не открывает лишнее', () => {
    expect(PANEL).toMatch(/canViewOperations\?: boolean;/);
  });
});

describe('разделы заездов живут в «Основном», отдельной вкладки «История заездов» больше нет', () => {
  it('панель заездов вставлена в основную вкладку карточки', () => {
    const mainAt = CARD.indexOf('data-card-tab="main"');
    expect(mainAt).toBeGreaterThan(-1);
    const panelAt = CARD.indexOf('<EngineVisitsPanel', mainAt);
    expect(panelAt).toBeGreaterThan(mainAt);
  });

  it('ключа вкладки arrivals ни в типе, ни в списке нет', () => {
    expect(CARD).not.toContain("'arrivals'");
    expect(CARD).not.toContain('data-card-tab="arrivals"');
    // Остатки прежней вкладки в типах и фильтрах открыли бы пустую обёртку.
    expect(CARD).not.toMatch(/label: 'История заездов'/);
  });

  it('разделы помечены атрибутами — по ним их и находит приёмка', () => {
    // Приёмка (CDP-смоук) ищет разделы по атрибутам: без них разметка — молчание.
    expect(PANEL).toContain('data-engine-visit={view.visitNo}');
    expect(PANEL).toContain('data-engine-visit-role={view.role}');
    expect(PANEL).toContain('data-engine-visit-tone={view.tone}');
  });

  it('правило «текущий/прошлый» и тон приходят из домена, а не из карточки', () => {
    expect(PANEL).toContain('buildEngineVisitViews');
    expect(PANEL).toContain('splitEngineHistoryByVisits');
    expect(CARD).not.toContain('buildEngineVisitViews');
  });
});
