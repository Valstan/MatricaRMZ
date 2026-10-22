// Маршрут заказ-наряда по цехам (план — docs/plans/zakaz-naryad-route-2026-10.md, PR-0).
//
// Маршрут живёт внутри существующего наряда (payload `operations`, поле `route`) и отвечает
// на два вопроса владельца: «где сейчас» работа и кто её принял. Передачу фиксируют обе
// стороны: отправивший цех ставит отметку `sent`, принимающий — `accepted`. Отказ принять —
// не пятое состояние шага, а возврат с причиной на предыдущий шаг: иначе отклонённый шаг
// пришлось бы руками снимать при повторной отправке, а причина терялась бы.
//
// Здесь только чистые функции и реестры: ни БД, ни синка, ни UI.

/** Виды шагов маршрута — по заводскому разговору: заявка → комплектация → работа → контроль → сдача. */
export const WORK_ORDER_ROUTE_STEP_KINDS = ['order', 'picking', 'work', 'control', 'handover'] as const;

export type WorkOrderRouteStepKind = (typeof WORK_ORDER_ROUTE_STEP_KINDS)[number];

export const WORK_ORDER_ROUTE_STEP_LABELS: Record<WorkOrderRouteStepKind, string> = {
  order: 'Заявка',
  picking: 'Комплектация',
  work: 'Работа в цеху',
  control: 'Контроль',
  handover: 'Сдача',
};

export const WORK_ORDER_ROUTE_STEP_HINTS: Record<WorkOrderRouteStepKind, string> = {
  order: 'Цех-заказчик пишет, что нужно сделать и откуда берём детали',
  picking: 'Проверяем наличие: что взяли из ремфонда, что надо изготовить',
  work: 'Ремонт или изготовление в цеху-исполнителе',
  control: 'Проверка сделанного: годно или брак',
  handover: 'Цех-заказчик принимает работу и закрывает наряд',
};

/** Минимальный маршрут: когда комплектация и отдельный контроль не нужны. */
export const WORK_ORDER_ROUTE_MINIMAL_KINDS: readonly WorkOrderRouteStepKind[] = ['order', 'work', 'handover'];

export const WORK_ORDER_ROUTE_STEP_STATES = ['planned', 'sent', 'accepted', 'done'] as const;

export type WorkOrderRouteStepState = (typeof WORK_ORDER_ROUTE_STEP_STATES)[number];

export const WORK_ORDER_ROUTE_STEP_STATE_LABELS: Record<WorkOrderRouteStepState, string> = {
  planned: 'Ожидает отправки',
  sent: 'В пути',
  accepted: 'В работе',
  done: 'Выполнен',
};

/** Причины «не исполнен» и возврата работы. Коды стабильны: подписи можно менять, записи — нет. */
export const WORK_ORDER_ROUTE_REASONS = [
  'no_material',
  'no_worker',
  'machine_busy',
  'defect',
  'waiting_customer',
  'other',
] as const;

export type WorkOrderRouteReason = (typeof WORK_ORDER_ROUTE_REASONS)[number];

export const WORK_ORDER_ROUTE_REASON_LABELS: Record<WorkOrderRouteReason, string> = {
  no_material: 'Нет материала',
  no_worker: 'Нет исполнителя',
  machine_busy: 'Станок занят',
  defect: 'Брак при изготовлении',
  waiting_customer: 'Ждём заказчика',
  other: 'Другое',
};

/** Причина «другое» без пояснения бесполезна — домен требует приписку. */
export function workOrderRouteReasonNeedsNote(reason: WorkOrderRouteReason): boolean {
  return reason === 'other';
}

export type WorkOrderRouteMark = {
  /** Момент отметки, ms. */
  at: number;
  /** Логин сотрудника: по нему в отчётах резолвится ФИО. */
  by: string;
  employeeName?: string;
};

export type WorkOrderRouteReturn = WorkOrderRouteMark & {
  reason: WorkOrderRouteReason;
  note?: string;
};

export const WORK_ORDER_ROUTE_LINE_SOURCES = ['repair_fund', 'manufacture', 'stock'] as const;

export type WorkOrderRouteLineSource = (typeof WORK_ORDER_ROUTE_LINE_SOURCES)[number];

export const WORK_ORDER_ROUTE_LINE_SOURCE_LABELS: Record<WorkOrderRouteLineSource, string> = {
  repair_fund: 'Из ремфонда',
  manufacture: 'Изготовить',
  stock: 'Со склада',
};

/**
 * Строка требования шага. Экземпляры ремфонда — ссылки (`repairFundInstanceIds`), а не копии:
 * маршрут не должен становиться вторым учётом деталей.
 */
export type WorkOrderRouteLine = {
  id: string;
  name: string;
  qty: number;
  source: WorkOrderRouteLineSource;
  nomenclatureId?: string;
  repairFundInstanceIds?: string[];
};

export type WorkOrderRouteStep = {
  id: string;
  kind: WorkOrderRouteStepKind;
  shopId: string;
  /** Снимок имени цеха: справочник цехов в реплику не едет. */
  shopName: string;
  title?: string;
  state: WorkOrderRouteStepState;
  sent?: WorkOrderRouteMark;
  accepted?: WorkOrderRouteMark;
  done?: WorkOrderRouteMark;
  returns?: WorkOrderRouteReturn[];
  lines?: WorkOrderRouteLine[];
};

export type WorkOrderRouteCompletionStatus = 'fulfilled' | 'not_fulfilled';

export const WORK_ORDER_ROUTE_COMPLETION_STATUS_LABELS: Record<WorkOrderRouteCompletionStatus, string> = {
  fulfilled: 'Исполнен',
  not_fulfilled: 'Не исполнен',
};

/** Итог маршрута: цех-заказчик принял работу или отказался с причиной. */
export type WorkOrderRouteCompletion = WorkOrderRouteMark & {
  status: WorkOrderRouteCompletionStatus;
  reason?: WorkOrderRouteReason;
  note?: string;
};

export type WorkOrderRoute = {
  steps: WorkOrderRouteStep[];
  completion?: WorkOrderRouteCompletion;
};

export const WORK_ORDER_ROUTE_ERRORS = [
  'step_not_found',
  'empty_route',
  'already_completed',
  'not_planned',
  'not_sent',
  'not_accepted',
  'previous_not_done',
  'no_previous_step',
  'reason_required',
  'note_required',
  'route_not_finished',
] as const;

export type WorkOrderRouteError = (typeof WORK_ORDER_ROUTE_ERRORS)[number];

export const WORK_ORDER_ROUTE_ERROR_MESSAGES: Record<WorkOrderRouteError, string> = {
  step_not_found: 'Шаг маршрута не найден',
  empty_route: 'В маршруте нет ни одного шага',
  already_completed: 'Маршрут уже завершён',
  not_planned: 'Шаг уже отправлен — повторно отправить нельзя',
  not_sent: 'Цех ещё не отправлял работу — принимать нечего',
  not_accepted: 'Сначала цех должен принять работу',
  previous_not_done: 'Предыдущий шаг ещё не выполнен',
  no_previous_step: 'Первый шаг нельзя вернуть — отправлять его некому',
  reason_required: 'Укажите причину',
  note_required: 'Для причины «Другое» нужна приписка',
  route_not_finished: 'Ещё не все шаги выполнены',
};

export type WorkOrderRouteTransition =
  | { ok: true; route: WorkOrderRoute }
  | { ok: false; error: WorkOrderRouteError };

function fail(error: WorkOrderRouteError): WorkOrderRouteTransition {
  return { ok: false, error };
}

function cloneStep(step: WorkOrderRouteStep): WorkOrderRouteStep {
  return {
    ...step,
    ...(step.returns ? { returns: step.returns.map((row) => ({ ...row })) } : {}),
    ...(step.lines ? { lines: step.lines.map((row) => ({ ...row })) } : {}),
  };
}

function cloneRoute(route: WorkOrderRoute): WorkOrderRoute {
  return {
    steps: route.steps.map(cloneStep),
    ...(route.completion ? { completion: { ...route.completion } } : {}),
  };
}

export function workOrderRouteStepIndex(route: WorkOrderRoute | undefined | null, stepId: string): number {
  if (!route) return -1;
  return route.steps.findIndex((step) => step.id === stepId);
}

/** Текущий шаг — первый невыполненный. Маршрут закончен, когда таких нет. */
export function workOrderRouteCurrentStep(route: WorkOrderRoute | undefined | null): WorkOrderRouteStep | null {
  if (!route) return null;
  return route.steps.find((step) => step.state !== 'done') ?? null;
}

export function workOrderRouteIsFinished(route: WorkOrderRoute | undefined | null): boolean {
  if (!route || route.steps.length === 0) return false;
  return route.steps.every((step) => step.state === 'done');
}

export function workOrderRouteProgress(route: WorkOrderRoute | undefined | null): { done: number; total: number } {
  if (!route) return { done: 0, total: 0 };
  return { done: route.steps.filter((step) => step.state === 'done').length, total: route.steps.length };
}

export function createWorkOrderRouteStep(draft: {
  id: string;
  kind: WorkOrderRouteStepKind;
  shopId: string;
  shopName: string;
  title?: string;
  lines?: WorkOrderRouteLine[];
}): WorkOrderRouteStep {
  return {
    id: draft.id,
    kind: draft.kind,
    shopId: draft.shopId,
    shopName: draft.shopName,
    ...(draft.title ? { title: draft.title } : {}),
    state: 'planned',
    ...(draft.lines && draft.lines.length > 0 ? { lines: draft.lines.map((row) => ({ ...row })) } : {}),
  };
}

/**
 * Отправил цех предыдущего шага (или цех-заказчик для первого шага). Первый шаг отправляется
 * без предыдущего: заявку пишет сам заказчик, принимать её внутрь маршрута некому.
 */
export function sendWorkOrderRouteStep(
  route: WorkOrderRoute,
  stepId: string,
  mark: WorkOrderRouteMark,
): WorkOrderRouteTransition {
  if (route.completion) return fail('already_completed');
  const index = workOrderRouteStepIndex(route, stepId);
  if (index < 0) return fail('step_not_found');
  const step = route.steps[index];
  if (!step) return fail('step_not_found');
  if (step.state !== 'planned') return fail('not_planned');
  if (index > 0 && route.steps[index - 1]?.state !== 'done') return fail('previous_not_done');

  const next = cloneRoute(route);
  next.steps[index] = { ...cloneStep(step), state: 'sent', sent: { ...mark } };
  return { ok: true, route: next };
}

/** Принял цех этого шага: работа физически у него. */
export function acceptWorkOrderRouteStep(
  route: WorkOrderRoute,
  stepId: string,
  mark: WorkOrderRouteMark,
): WorkOrderRouteTransition {
  if (route.completion) return fail('already_completed');
  const index = workOrderRouteStepIndex(route, stepId);
  if (index < 0) return fail('step_not_found');
  const step = route.steps[index];
  if (!step) return fail('step_not_found');
  if (step.state !== 'sent') return fail('not_sent');

  const next = cloneRoute(route);
  next.steps[index] = { ...cloneStep(step), state: 'accepted', accepted: { ...mark } };
  return { ok: true, route: next };
}

/** Цех закончил работу по шагу. Для последнего шага (`handover`) это и есть сдача. */
export function completeWorkOrderRouteStep(
  route: WorkOrderRoute,
  stepId: string,
  mark: WorkOrderRouteMark,
): WorkOrderRouteTransition {
  if (route.completion) return fail('already_completed');
  const index = workOrderRouteStepIndex(route, stepId);
  if (index < 0) return fail('step_not_found');
  const step = route.steps[index];
  if (!step) return fail('step_not_found');
  if (step.state !== 'accepted') return fail('not_accepted');

  const next = cloneRoute(route);
  next.steps[index] = { ...cloneStep(step), state: 'done', done: { ...mark } };
  return { ok: true, route: next };
}

/**
 * Возврат: цех не принял работу или нашёл брак. Работа уходит на предыдущий шаг (он снова
 * «в работе»), у отказавшегося шага остаётся запись причины — состояние шага при этом
 * сбрасывается в `planned`, чтобы повторная отправка не требовала ручной правки.
 */
export function returnWorkOrderRouteStep(
  route: WorkOrderRoute,
  stepId: string,
  args: { mark: WorkOrderRouteMark; reason: WorkOrderRouteReason; note?: string },
): WorkOrderRouteTransition {
  if (route.completion) return fail('already_completed');
  const index = workOrderRouteStepIndex(route, stepId);
  if (index < 0) return fail('step_not_found');
  if (index === 0) return fail('no_previous_step');
  const step = route.steps[index];
  if (!step) return fail('step_not_found');
  if (step.state !== 'sent' && step.state !== 'accepted') return fail('not_sent');
  if (workOrderRouteReasonNeedsNote(args.reason) && !args.note?.trim()) return fail('note_required');

  const note = args.note?.trim();
  const returnRecord: WorkOrderRouteReturn = {
    at: args.mark.at,
    by: args.mark.by,
    ...(args.mark.employeeName ? { employeeName: args.mark.employeeName } : {}),
    reason: args.reason,
    ...(note ? { note } : {}),
  };

  const next = cloneRoute(route);
  next.steps[index] = {
    id: step.id,
    kind: step.kind,
    shopId: step.shopId,
    shopName: step.shopName,
    ...(step.title ? { title: step.title } : {}),
    state: 'planned',
    ...(step.lines ? { lines: step.lines.map((row) => ({ ...row })) } : {}),
    returns: [...(step.returns ?? []), returnRecord].map((row) => ({ ...row })),
  };

  const previous = route.steps[index - 1];
  if (!previous) return fail('no_previous_step');
  next.steps[index - 1] = {
    id: previous.id,
    kind: previous.kind,
    shopId: previous.shopId,
    shopName: previous.shopName,
    ...(previous.title ? { title: previous.title } : {}),
    state: 'accepted',
    ...(previous.sent ? { sent: { ...previous.sent } } : {}),
    ...(previous.accepted ? { accepted: { ...previous.accepted } } : {}),
    ...(previous.lines ? { lines: previous.lines.map((row) => ({ ...row })) } : {}),
    ...(previous.returns ? { returns: previous.returns.map((row) => ({ ...row })) } : {}),
  };
  return { ok: true, route: next };
}

/**
 * Итог маршрута: цех-заказчик принял работу («исполнен») или отказался с причиной
 * («не исполнен»). Требует, чтобы все шаги были выполнены: иначе итог врёт.
 */
export function completeWorkOrderRoute(
  route: WorkOrderRoute,
  args: { mark: WorkOrderRouteMark; status: WorkOrderRouteCompletionStatus; reason?: WorkOrderRouteReason; note?: string },
): WorkOrderRouteTransition {
  if (route.completion) return fail('already_completed');
  if (route.steps.length === 0) return fail('empty_route');
  if (!workOrderRouteIsFinished(route)) return fail('route_not_finished');

  const note = args.note?.trim();
  if (args.status === 'not_fulfilled') {
    if (!args.reason) return fail('reason_required');
    if (workOrderRouteReasonNeedsNote(args.reason) && !note) return fail('note_required');
  }

  return {
    ok: true,
    route: {
      ...cloneRoute(route),
      completion: {
        at: args.mark.at,
        by: args.mark.by,
        ...(args.mark.employeeName ? { employeeName: args.mark.employeeName } : {}),
        status: args.status,
        ...(args.status === 'not_fulfilled' && args.reason ? { reason: args.reason } : {}),
        ...(note ? { note } : {}),
      },
    },
  };
}

export const WORK_ORDER_ROUTE_PROBLEMS = [
  'empty',
  'duplicate_step_id',
  'missing_shop',
  'unknown_kind',
  'marks_mismatch',
  'step_out_of_order',
  'return_on_first_step',
  'last_step_not_handover',
  'completion_incomplete',
] as const;

export type WorkOrderRouteProblemCode = (typeof WORK_ORDER_ROUTE_PROBLEMS)[number];

/** Что показать оператору, если маршрут собран с расхождением (проверка на сохранении и в карточке). */
export const WORK_ORDER_ROUTE_PROBLEM_MESSAGES: Record<WorkOrderRouteProblemCode, string> = {
  empty: 'в маршруте нет ни одного шага',
  duplicate_step_id: 'шаги повторяют один и тот же номер',
  missing_shop: 'у шага не выбран цех',
  unknown_kind: 'неизвестный вид шага',
  marks_mismatch: 'отметки шага не сходятся с его состоянием',
  step_out_of_order: 'работа стоит на шаге, хотя предыдущий не выполнен',
  return_on_first_step: 'первый шаг не может быть возвратом',
  last_step_not_handover: 'последний шаг должен быть «Сдача»',
  completion_incomplete: 'у итога «не исполнен» нет причины',
};

export type WorkOrderRouteProblem = {
  code: WorkOrderRouteProblemCode;
  stepIndex?: number;
};

/**
 * Проверка целостности маршрута. Вызывается на сохранении и в тестах: домен не даёт собрать
 * маршрут, где отметка есть, а состояния под неё нет, или где работа «телепортировалась»
 * через невыполненный шаг.
 */
export function validateWorkOrderRoute(route: WorkOrderRoute | undefined | null): WorkOrderRouteProblem[] {
  if (!route || route.steps.length === 0) return [{ code: 'empty' }];
  const problems: WorkOrderRouteProblem[] = [];
  const seen = new Set<string>();
  let blocked = false;

  route.steps.forEach((step, index) => {
    if (seen.has(step.id)) problems.push({ code: 'duplicate_step_id', stepIndex: index });
    seen.add(step.id);
    if (!step.shopId.trim()) problems.push({ code: 'missing_shop', stepIndex: index });
    if (!WORK_ORDER_ROUTE_STEP_KINDS.includes(step.kind)) problems.push({ code: 'unknown_kind', stepIndex: index });

    const hasSent = Boolean(step.sent);
    const hasAccepted = Boolean(step.accepted);
    const hasDone = Boolean(step.done);
    const marksOk =
      step.state === 'planned'
        ? !hasSent && !hasAccepted && !hasDone
        : step.state === 'sent'
          ? hasSent && !hasAccepted && !hasDone
          : step.state === 'accepted'
            ? hasSent && hasAccepted && !hasDone
            : hasSent && hasAccepted && hasDone;
    if (!marksOk) problems.push({ code: 'marks_mismatch', stepIndex: index });

    if (index === 0 && (step.returns?.length ?? 0) > 0) problems.push({ code: 'return_on_first_step', stepIndex: index });
    if (blocked && (hasSent || hasAccepted || hasDone)) problems.push({ code: 'step_out_of_order', stepIndex: index });
    if (step.state !== 'done') blocked = true;
  });

  if (route.steps[route.steps.length - 1]?.kind !== 'handover') problems.push({ code: 'last_step_not_handover' });

  if (route.completion) {
    const completion = route.completion;
    const incomplete =
      (completion.status === 'not_fulfilled' && !completion.reason) ||
      (completion.reason !== undefined && workOrderRouteReasonNeedsNote(completion.reason) && !completion.note?.trim());
    if (incomplete) problems.push({ code: 'completion_incomplete' });
  }

  return problems;
}

function parseMark(raw: unknown): WorkOrderRouteMark | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;
  const at = Number(rec.at);
  const by = typeof rec.by === 'string' ? rec.by.trim() : '';
  if (!Number.isFinite(at) || at <= 0 || !by) return undefined;
  const employeeName = typeof rec.employeeName === 'string' ? rec.employeeName.trim() : '';
  return { at, by, ...(employeeName ? { employeeName } : {}) };
}

function isRouteKind(value: unknown): value is WorkOrderRouteStepKind {
  return typeof value === 'string' && (WORK_ORDER_ROUTE_STEP_KINDS as readonly string[]).includes(value);
}

function isRouteReason(value: unknown): value is WorkOrderRouteReason {
  return typeof value === 'string' && (WORK_ORDER_ROUTE_REASONS as readonly string[]).includes(value);
}

function isLineSource(value: unknown): value is WorkOrderRouteLineSource {
  return typeof value === 'string' && (WORK_ORDER_ROUTE_LINE_SOURCES as readonly string[]).includes(value);
}

function normalizeRouteLine(raw: unknown, index: number): WorkOrderRouteLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const name = typeof rec.name === 'string' ? rec.name.trim() : '';
  const qty = Number(rec.qty);
  if (!name || !Number.isFinite(qty) || qty <= 0) return null;
  const id = typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim() : `line-${index + 1}`;
  const source: WorkOrderRouteLineSource = isLineSource(rec.source) ? rec.source : 'stock';
  const nomenclatureId = typeof rec.nomenclatureId === 'string' ? rec.nomenclatureId.trim() : '';
  const instanceIds = Array.isArray(rec.repairFundInstanceIds)
    ? [...new Set(rec.repairFundInstanceIds.map((value) => String(value ?? '').trim()).filter(Boolean))]
    : [];
  return {
    id,
    name,
    qty,
    source,
    ...(nomenclatureId ? { nomenclatureId } : {}),
    ...(instanceIds.length > 0 ? { repairFundInstanceIds: instanceIds } : {}),
  };
}

function normalizeRouteReturn(raw: unknown): WorkOrderRouteReturn | null {
  const mark = parseMark(raw);
  if (!mark) return null;
  const rec = raw as Record<string, unknown>;
  if (!isRouteReason(rec.reason)) return null;
  const note = typeof rec.note === 'string' ? rec.note.trim() : '';
  return { ...mark, reason: rec.reason, ...(note ? { note } : {}) };
}

function normalizeRouteStep(raw: unknown, index: number): WorkOrderRouteStep | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  if (!isRouteKind(rec.kind)) return null;
  const shopId = typeof rec.shopId === 'string' ? rec.shopId.trim() : '';
  if (!shopId) return null;
  const id = typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim() : `step-${index + 1}`;
  const shopName = typeof rec.shopName === 'string' ? rec.shopName.trim() : '';
  const title = typeof rec.title === 'string' ? rec.title.trim() : '';
  const sent = parseMark(rec.sent);
  const accepted = parseMark(rec.accepted);
  const done = parseMark(rec.done);
  // Состояние восстанавливаем по отметкам, а не доверяем записанному: так расхождение
  // «состояние без отметки» чинится чтением, а не всплывает в UI пустой датой.
  const state: WorkOrderRouteStepState = done ? 'done' : accepted ? 'accepted' : sent ? 'sent' : 'planned';
  const returns = Array.isArray(rec.returns)
    ? rec.returns.map(normalizeRouteReturn).filter((row): row is WorkOrderRouteReturn => row !== null)
    : [];
  const lines = Array.isArray(rec.lines)
    ? rec.lines.map((row, lineIndex) => normalizeRouteLine(row, lineIndex)).filter((row): row is WorkOrderRouteLine => row !== null)
    : [];
  return {
    id,
    kind: rec.kind,
    shopId,
    shopName,
    ...(title ? { title } : {}),
    state,
    ...(state !== 'planned' && sent ? { sent } : {}),
    ...((state === 'accepted' || state === 'done') && accepted ? { accepted } : {}),
    ...(state === 'done' && done ? { done } : {}),
    ...(returns.length > 0 ? { returns } : {}),
    ...(lines.length > 0 ? { lines } : {}),
  };
}

/** Читает маршрут из payload любой версии. Мусор отбрасывается, наряд без маршрута — законен. */
export function normalizeWorkOrderRoute(raw: unknown): WorkOrderRoute | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;
  const steps = Array.isArray(rec.steps)
    ? rec.steps.map((row, index) => normalizeRouteStep(row, index)).filter((row): row is WorkOrderRouteStep => row !== null)
    : [];
  if (steps.length === 0) return undefined;

  const route: WorkOrderRoute = { steps };
  const completionMark = parseMark(rec.completion);
  if (completionMark) {
    const completionRec = rec.completion as Record<string, unknown>;
    const status: WorkOrderRouteCompletionStatus =
      completionRec.status === 'not_fulfilled' ? 'not_fulfilled' : 'fulfilled';
    const reason = isRouteReason(completionRec.reason) ? completionRec.reason : undefined;
    const note = typeof completionRec.note === 'string' ? completionRec.note.trim() : '';
    route.completion = {
      ...completionMark,
      status,
      ...(reason ? { reason } : {}),
      ...(note ? { note } : {}),
    };
  }
  return route;
}
