import { describe, expect, it } from 'vitest';
import {
  WORK_ORDER_ROUTE_MINIMAL_KINDS,
  WORK_ORDER_ROUTE_REASON_LABELS,
  WORK_ORDER_ROUTE_REASONS,
  WORK_ORDER_ROUTE_STEP_KINDS,
  WORK_ORDER_ROUTE_STEP_LABELS,
  WORK_ORDER_ROUTE_STEP_STATES,
  WORK_ORDER_ROUTE_STEP_STATE_LABELS,
  acceptWorkOrderRouteStep,
  completeWorkOrderRoute,
  completeWorkOrderRouteStep,
  createWorkOrderRouteStep,
  normalizeWorkOrderRoute,
  returnWorkOrderRouteStep,
  sendWorkOrderRouteStep,
  validateWorkOrderRoute,
  workOrderRouteCurrentStep,
  workOrderRouteIsFinished,
  workOrderRouteProgress,
  workOrderRouteStepIndex,
  type WorkOrderRoute,
  type WorkOrderRouteStep,
} from './workOrderRoute.js';
import { WORK_ORDER_PAYLOAD_VERSION, normalizeWorkOrderPayloadV3Fields } from './workOrder.js';

const at1 = 1_700_000_000_000;

function mark(by = 'master1', at = at1) {
  return { at, by };
}

function step(id: string, kind: WorkOrderRouteStep['kind'], shopId: string): WorkOrderRouteStep {
  return createWorkOrderRouteStep({ id, kind, shopId, shopName: `Цех ${shopId}` });
}

function route(): WorkOrderRoute {
  return {
    steps: [step('s1', 'order', '1'), step('s2', 'work', '3'), step('s3', 'handover', '1')],
  };
}

/** Доводит маршрут до состояния «все шаги выполнены». */
function finishedRoute(): WorkOrderRoute {
  let current = route();
  const steps = ['s1', 's2', 's3'];
  for (const id of steps) {
    const sent = sendWorkOrderRouteStep(current, id, mark('sender'));
    if (!sent.ok) throw new Error(sent.error);
    current = sent.route;
    // Первый шаг отправляет сам заказчик — принимать внутрь маршрута некому.
    const accepted = acceptWorkOrderRouteStep(current, id, mark('receiver'));
    if (!accepted.ok) throw new Error(accepted.error);
    current = accepted.route;
    const done = completeWorkOrderRouteStep(current, id, mark('receiver'));
    if (!done.ok) throw new Error(done.error);
    current = done.route;
  }
  return current;
}

describe('реестры маршрута', () => {
  it('у каждого вида шага, состояния и причины есть подпись', () => {
    for (const kind of WORK_ORDER_ROUTE_STEP_KINDS) expect(WORK_ORDER_ROUTE_STEP_LABELS[kind]).toBeTruthy();
    for (const state of WORK_ORDER_ROUTE_STEP_STATES) expect(WORK_ORDER_ROUTE_STEP_STATE_LABELS[state]).toBeTruthy();
    for (const reason of WORK_ORDER_ROUTE_REASONS) expect(WORK_ORDER_ROUTE_REASON_LABELS[reason]).toBeTruthy();
  });

  it('минимальный маршрут состоит только из известных шагов и кончается сдачей', () => {
    expect(WORK_ORDER_ROUTE_MINIMAL_KINDS.length).toBeGreaterThan(1);
    for (const kind of WORK_ORDER_ROUTE_MINIMAL_KINDS) expect(WORK_ORDER_ROUTE_STEP_KINDS).toContain(kind);
    expect(WORK_ORDER_ROUTE_MINIMAL_KINDS.at(-1)).toBe('handover');
  });
});

describe('переходы шагов', () => {
  it('первый шаг отправляется без предыдущего, второй — только после выполнения первого', () => {
    const step1 = sendWorkOrderRouteStep(route(), 's1', mark());
    expect(step1.ok).toBe(true);

    const early = sendWorkOrderRouteStep(route(), 's2', mark());
    expect(early).toEqual({ ok: false, error: 'previous_not_done' });

    const accepted = acceptWorkOrderRouteStep(route(), 's1', mark());
    expect(accepted).toEqual({ ok: false, error: 'not_sent' });

    const done = completeWorkOrderRouteStep(route(), 's1', mark());
    expect(done).toEqual({ ok: false, error: 'not_accepted' });
  });

  it('повторная отправка и несуществующий шаг отклоняются', () => {
    const sent = sendWorkOrderRouteStep(route(), 's1', mark());
    if (!sent.ok) throw new Error(sent.error);
    expect(sendWorkOrderRouteStep(sent.route, 's1', mark())).toEqual({ ok: false, error: 'not_planned' });
    expect(sendWorkOrderRouteStep(sent.route, 'nope', mark())).toEqual({ ok: false, error: 'step_not_found' });
  });

  it('шаг проходит путь planned → sent → accepted → done', () => {
    let current = route();
    const sent = sendWorkOrderRouteStep(current, 's1', mark('zakazchik'));
    expect(sent.ok && sent.route.steps[0]).toMatchObject({ state: 'sent', sent: { by: 'zakazchik' } });
    if (!sent.ok) return;
    current = sent.route;

    const accepted = acceptWorkOrderRouteStep(current, 's1', mark('prinyal'));
    expect(accepted.ok && accepted.route.steps[0]).toMatchObject({ state: 'accepted', accepted: { by: 'prinyal' } });
    if (!accepted.ok) return;
    current = accepted.route;

    const done = completeWorkOrderRouteStep(current, 's1', mark('prinyal'));
    expect(done.ok && done.route.steps[0]).toMatchObject({ state: 'done', done: { by: 'prinyal' } });
  });

  it('исходный маршрут не мутируется', () => {
    const source = route();
    sendWorkOrderRouteStep(source, 's1', mark());
    expect(source.steps[0].state).toBe('planned');
    expect(source.steps[0].sent).toBeUndefined();
  });
});

describe('где сейчас', () => {
  it('текущий шаг — первый невыполненный', () => {
    expect(workOrderRouteCurrentStep(route())?.id).toBe('s1');
    const sent = sendWorkOrderRouteStep(route(), 's1', mark());
    if (!sent.ok) return;
    const accepted = acceptWorkOrderRouteStep(sent.route, 's1', mark());
    if (!accepted.ok) return;
    const done = completeWorkOrderRouteStep(accepted.route, 's1', mark());
    if (!done.ok) return;
    expect(workOrderRouteCurrentStep(done.route)?.id).toBe('s2');
    expect(workOrderRouteProgress(done.route)).toEqual({ done: 1, total: 3 });
  });

  it('законченный маршрут не имеет текущего шага', () => {
    const finished = finishedRoute();
    expect(workOrderRouteCurrentStep(finished)).toBeNull();
    expect(workOrderRouteIsFinished(finished)).toBe(true);
    expect(workOrderRouteProgress(finished)).toEqual({ done: 3, total: 3 });
  });

  it('пустой маршрут не считается законченным', () => {
    expect(workOrderRouteIsFinished({ steps: [] })).toBe(false);
    expect(workOrderRouteIsFinished(undefined)).toBe(false);
    expect(workOrderRouteCurrentStep(undefined)).toBeNull();
  });

  it('индекс шага ищется по id', () => {
    expect(workOrderRouteStepIndex(route(), 's2')).toBe(1);
    expect(workOrderRouteStepIndex(route(), 'nope')).toBe(-1);
    expect(workOrderRouteStepIndex(undefined, 's1')).toBe(-1);
  });
});

describe('возврат с причиной', () => {
  function sentSecondStep(): WorkOrderRoute {
    let current = route();
    const s1in = sendWorkOrderRouteStep(current, 's1', mark());
    if (!s1in.ok) throw new Error(s1in.error);
    const s1ok = acceptWorkOrderRouteStep(s1in.route, 's1', mark());
    if (!s1ok.ok) throw new Error(s1ok.error);
    const s1out = completeWorkOrderRouteStep(s1ok.route, 's1', mark());
    if (!s1out.ok) throw new Error(s1out.error);
    const s2in = sendWorkOrderRouteStep(s1out.route, 's2', mark());
    if (!s2in.ok) throw new Error(s2in.error);
    return s2in.route;
  }

  it('возврат снимает шаг в planned и будит предыдущий цех', () => {
    const returned = returnWorkOrderRouteStep(sentSecondStep(), 's2', { mark: mark('ceh3'), reason: 'defect', note: 'овал 0,05' });
    if (!returned.ok) throw new Error(returned.error);
    expect(returned.route.steps[1]).toMatchObject({ state: 'planned' });
    expect(returned.route.steps[1].sent).toBeUndefined();
    expect(returned.route.steps[1].returns).toEqual([
      { at: at1, by: 'ceh3', reason: 'defect', note: 'овал 0,05' },
    ]);
    // Работа вернулась к предыдущему цеху: он снова «в работе», а не «выполнен».
    expect(returned.route.steps[0]).toMatchObject({ state: 'accepted' });
    expect(returned.route.steps[0].done).toBeUndefined();
    expect(workOrderRouteCurrentStep(returned.route)?.id).toBe('s1');
  });

  it('первый шаг вернуть некому', () => {
    const sent = sendWorkOrderRouteStep(route(), 's1', mark());
    if (!sent.ok) return;
    expect(returnWorkOrderRouteStep(sent.route, 's1', { mark: mark(), reason: 'no_material' })).toEqual({
      ok: false,
      error: 'no_previous_step',
    });
  });

  it('причина «другое» требует приписки', () => {
    expect(returnWorkOrderRouteStep(sentSecondStep(), 's2', { mark: mark(), reason: 'other' })).toEqual({
      ok: false,
      error: 'note_required',
    });
    const withNote = returnWorkOrderRouteStep(sentSecondStep(), 's2', { mark: mark(), reason: 'other', note: 'нет крана' });
    expect(withNote.ok).toBe(true);
  });

  it('возврат возможен только из «в пути» или «в работе»', () => {
    expect(returnWorkOrderRouteStep(route(), 's2', { mark: mark(), reason: 'no_worker' })).toEqual({
      ok: false,
      error: 'not_sent',
    });
  });
});

describe('итог маршрута', () => {
  it('нельзя завершить незаконченный маршрут', () => {
    expect(completeWorkOrderRoute(route(), { mark: mark(), status: 'fulfilled' })).toEqual({
      ok: false,
      error: 'route_not_finished',
    });
  });

  it('«исполнен» без причины — законный итог', () => {
    const completed = completeWorkOrderRoute(finishedRoute(), { mark: mark('nachalnik'), status: 'fulfilled' });
    if (!completed.ok) throw new Error(completed.error);
    expect(completed.route.completion).toEqual({ at: at1, by: 'nachalnik', status: 'fulfilled' });
  });

  it('«не исполнен» требует причины, а причина «другое» — приписки', () => {
    const finished = finishedRoute();
    expect(completeWorkOrderRoute(finished, { mark: mark(), status: 'not_fulfilled' })).toEqual({
      ok: false,
      error: 'reason_required',
    });
    expect(completeWorkOrderRoute(finished, { mark: mark(), status: 'not_fulfilled', reason: 'other' })).toEqual({
      ok: false,
      error: 'note_required',
    });
    const ok = completeWorkOrderRoute(finished, { mark: mark(), status: 'not_fulfilled', reason: 'waiting_customer' });
    expect(ok.ok && ok.route.completion).toMatchObject({ status: 'not_fulfilled', reason: 'waiting_customer' });
  });

  it('завершённый маршрут не меняется переходами', () => {
    const completed = completeWorkOrderRoute(finishedRoute(), { mark: mark(), status: 'fulfilled' });
    if (!completed.ok) return;
    expect(sendWorkOrderRouteStep(completed.route, 's1', mark())).toEqual({ ok: false, error: 'already_completed' });
    expect(completeWorkOrderRoute(completed.route, { mark: mark(), status: 'fulfilled' })).toEqual({
      ok: false,
      error: 'already_completed',
    });
  });
});

describe('проверка целостности маршрута', () => {
  it('собранный переходами маршрут целостен', () => {
    expect(validateWorkOrderRoute(route())).toEqual([]);
    expect(validateWorkOrderRoute(finishedRoute())).toEqual([]);
  });

  it('пустой маршрут — проблема', () => {
    expect(validateWorkOrderRoute({ steps: [] })).toEqual([{ code: 'empty' }]);
    expect(validateWorkOrderRoute(undefined)).toEqual([{ code: 'empty' }]);
  });

  it('последний шаг обязан быть сдачей', () => {
    const bad: WorkOrderRoute = { steps: [step('s1', 'order', '1'), step('s2', 'work', '3')] };
    expect(validateWorkOrderRoute(bad)).toEqual([{ code: 'last_step_not_handover' }]);
  });

  it('повторяющиеся id и цех без shopId — проблемы', () => {
    const bad: WorkOrderRoute = {
      steps: [step('s1', 'order', '1'), createWorkOrderRouteStep({ id: 's1', kind: 'handover', shopId: '', shopName: '' })],
    };
    const codes = validateWorkOrderRoute(bad).map((problem) => problem.code);
    expect(codes).toContain('duplicate_step_id');
    expect(codes).toContain('missing_shop');
  });

  it('отметка без состояния — проблема', () => {
    const bad: WorkOrderRoute = {
      steps: [
        { ...step('s1', 'order', '1'), state: 'sent' },
        step('s2', 'handover', '1'),
      ],
    };
    expect(validateWorkOrderRoute(bad).map((problem) => problem.code)).toContain('marks_mismatch');
  });

  it('работа не может уехать через невыполненный шаг', () => {
    const bad: WorkOrderRoute = {
      steps: [
        step('s1', 'order', '1'),
        { ...step('s2', 'work', '3'), state: 'sent', sent: mark() },
        step('s3', 'handover', '1'),
      ],
    };
    expect(validateWorkOrderRoute(bad).map((problem) => problem.code)).toContain('step_out_of_order');
  });

  it('итог «не исполнен» без причины виден проверкой', () => {
    const bad: WorkOrderRoute = {
      ...finishedRoute(),
      completion: { at: at1, by: 'x', status: 'not_fulfilled' },
    };
    expect(validateWorkOrderRoute(bad).map((problem) => problem.code)).toContain('completion_incomplete');
  });
});

describe('чтение маршрута из payload', () => {
  it('без маршрута наряд читается как раньше', () => {
    expect(normalizeWorkOrderRoute(undefined)).toBeUndefined();
    expect(normalizeWorkOrderRoute(null)).toBeUndefined();
    expect(normalizeWorkOrderRoute({})).toBeUndefined();
    expect(normalizeWorkOrderRoute({ steps: 'нет' })).toBeUndefined();
    expect(normalizeWorkOrderPayloadV3Fields({ workOrderNumber: 7 }).route).toBeUndefined();
  });

  it('маршрут переживает запись и чтение', () => {
    const source = finishedRoute();
    const restored = normalizeWorkOrderRoute(JSON.parse(JSON.stringify(source)));
    expect(restored).toEqual(source);
  });

  it('состояние восстанавливается по отметкам, а не по записанному', () => {
    const restored = normalizeWorkOrderRoute({
      steps: [
        { id: 's1', kind: 'order', shopId: '1', state: 'planned', sent: mark('a'), accepted: mark('b') },
        { id: 's2', kind: 'handover', shopId: '1' },
      ],
    });
    expect(restored?.steps[0]).toMatchObject({ state: 'accepted', sent: { by: 'a' }, accepted: { by: 'b' } });
    expect(restored?.steps[1].state).toBe('planned');
  });

  it('мусор в шагах отбрасывается, а не ломает чтение', () => {
    const restored = normalizeWorkOrderRoute({
      steps: [
        { id: 's1', kind: 'order', shopId: '1', shopName: 'Цех 1' },
        { id: 's2', kind: 'неизвестно', shopId: '1' },
        { id: 's3', kind: 'handover' },
        'строка',
        { id: 's4', kind: 'handover', shopId: '1', shopName: 'Цех 1' },
      ],
    });
    expect(restored?.steps.map((row) => row.id)).toEqual(['s1', 's4']);
    expect(validateWorkOrderRoute(restored)).toEqual([]);
  });

  it('строки требований чистятся: qty, дубли экземпляров, источник по умолчанию', () => {
    const restored = normalizeWorkOrderRoute({
      steps: [
        {
          id: 's1',
          kind: 'order',
          shopId: '1',
          lines: [
            { name: 'Гильза', qty: 4, source: 'repair_fund', repairFundInstanceIds: ['a', 'a', 'b'] },
            { name: 'Палец', qty: 0 },
            { name: '', qty: 2 },
            { name: 'Втулка', qty: 1, source: 'нет-такого' },
          ],
        },
        { id: 's2', kind: 'handover', shopId: '1' },
      ],
    });
    expect(restored?.steps[0].lines).toEqual([
      { id: 'line-1', name: 'Гильза', qty: 4, source: 'repair_fund', repairFundInstanceIds: ['a', 'b'] },
      { id: 'line-4', name: 'Втулка', qty: 1, source: 'stock' },
    ]);
  });

  it('итог маршрута читается и чистится', () => {
    const restored = normalizeWorkOrderRoute({
      steps: [{ id: 's1', kind: 'handover', shopId: '1' }],
      completion: { at: at1, by: 'x', status: 'not_fulfilled', reason: 'нет-такой', note: ' ждём ' },
    });
    expect(restored?.completion).toEqual({ at: at1, by: 'x', status: 'not_fulfilled', note: 'ждём' });
  });

  it('итог без отметки (кому и когда) не читается', () => {
    const restored = normalizeWorkOrderRoute({
      steps: [{ id: 's1', kind: 'handover', shopId: '1' }],
      completion: { status: 'fulfilled' },
    });
    expect(restored?.completion).toBeUndefined();
  });
});

describe('payload наряда', () => {
  it('маршрут доезжает через нормализацию payload', () => {
    const source = route();
    const normalized = normalizeWorkOrderPayloadV3Fields({ route: JSON.parse(JSON.stringify(source)) });
    expect(normalized.route).toEqual(source);
  });

  it('версия payload поднята до 5', () => {
    expect(WORK_ORDER_PAYLOAD_VERSION).toBe(5);
  });
});
