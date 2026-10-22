import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Вкладка «Маршрут» карточки наряда (план docs/plans/zakaz-naryad-route-2026-10.md, PR-1).
//
// Сторож держит три решения, которые ломаются тихо:
// 1) маршрут — часть наряда, а не отдельная карточка: вкладка живёт в WorkOrderDetailsPage;
// 2) «где сейчас» выводится из шагов общим доменом, а не хранится копией рядом с маршрутом —
//    копия расходится с шагами ровно на ошибке записи;
// 3) цеха берутся из справочника (props.workshops), а не перечисляются в компоненте: список
//    цехов живёт на сервере и в каждом филиале свой.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const PANEL = src('./WorkOrderRoutePanel.tsx');
const PAGE = src('../pages/WorkOrderDetailsPage.tsx');

describe('вкладка «Маршрут» карточки наряда', () => {
  it('вкладка зарегистрирована рядом с остальными и рендерится сестрой, а не вложенной', () => {
    expect(PAGE).toContain("type WorkOrderCardTab = 'main' | 'content' | 'route' | 'signatures'");
    expect(PAGE).toContain("{ key: 'route', label: 'Маршрут' }");
    expect(PAGE).toContain('data-card-tab="route"');
    expect(PAGE).toContain('<WorkOrderRoutePanel');
  });

  it('маршрут правится через payload наряда, а не отдельным хранилищем', () => {
    expect(PAGE).toContain('route={payload.route}');
    expect(PAGE).toContain('next.route = route');
    // Панель не ходит в IPC сама: сохранение — забота карточки (черновик + автосохранение).
    expect(PANEL, 'панель маршрута начала сохранять сама').not.toContain('window.matrica');
  });

  it('«где сейчас» выводится из шагов доменной функцией', () => {
    expect(PANEL).toContain('workOrderRouteCurrentStep');
    expect(PANEL).toContain('workOrderRouteProgress');
    expect(PANEL, 'появилось хранимое поле «текущий цех»').not.toContain('currentShopId');
  });

  it('подписи шагов и состояний берутся из домена, а не переписываются в компоненте', () => {
    expect(PANEL).toContain('WORK_ORDER_ROUTE_STEP_LABELS');
    expect(PANEL).toContain('WORK_ORDER_ROUTE_STEP_STATE_LABELS');
    expect(PANEL).toContain('WORK_ORDER_ROUTE_REASON_LABELS');
    expect(PANEL, 'источник подписей шагов задублирован в компоненте').not.toContain("'Работа в цеху'");
  });

  it('цеха берутся из справочника, а не перечисляются в компоненте', () => {
    expect(PANEL).toContain('props.workshops');
    expect(PANEL, 'в компоненте появился список цехов литералом').not.toMatch(/shopId: '[0-9a-f-]{8,}'/);
  });

  it('маршрут проверяется доменом и расхождение видно оператору', () => {
    expect(PANEL).toContain('validateWorkOrderRoute');
    expect(PANEL).toContain('WORK_ORDER_ROUTE_PROBLEM_MESSAGES');
  });
});
