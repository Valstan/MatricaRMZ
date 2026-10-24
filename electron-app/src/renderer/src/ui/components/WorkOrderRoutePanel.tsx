import {
  WORK_ORDER_ROUTE_COMPLETION_STATUS_LABELS,
  WORK_ORDER_ROUTE_PROBLEM_MESSAGES,
  WORK_ORDER_ROUTE_REASON_LABELS,
  WORK_ORDER_ROUTE_STEP_HINTS,
  WORK_ORDER_ROUTE_STEP_KINDS,
  WORK_ORDER_ROUTE_STEP_LABELS,
  WORK_ORDER_ROUTE_STEP_STATE_LABELS,
  createWorkOrderRouteStep,
  validateWorkOrderRoute,
  workOrderRouteCurrentStep,
  workOrderRouteProgress,
  type WorkOrderRoute,
  type WorkOrderRouteStep,
  type WorkOrderRouteStepKind,
  type WorkOrderRouteStepState,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { SectionCard } from './SectionCard.js';
import { theme } from '../theme.js';
import { formatMoscowLongDateTime } from '../utils/dateUtils.js';

/**
 * Вкладка «Маршрут» карточки наряда: по каким цехам идёт работа и где она стоит сейчас.
 *
 * Панель ничего не сохраняет сама — она правит `payload.route` через `onChange`,
 * автосохранение черновика делает карточка (общий механизм наряда). Отметки передачи
 * («отправил» / «принял») ставит следующая нитка — здесь только сборка маршрута,
 * поэтому у отметок видимый, но нередактируемый вид.
 */

export type WorkOrderRouteWorkshop = { id: string; code: string; name: string };

// Тон читаем лениво: модульное чтение темы даёт TDZ на цикле чанков (M167, theme.chunk.guard.test.ts).
function stateTone(state: WorkOrderRouteStepState): string {
  switch (state) {
    case 'planned':
      return theme.colors.subtle;
    case 'sent':
      return theme.colors.warn;
    case 'accepted':
      return theme.colors.success;
    default:
      return theme.colors.muted;
  }
}

function workshopLabel(workshops: readonly WorkOrderRouteWorkshop[], id: string): string {
  const found = workshops.find((row) => row.id === id);
  if (!found) return id ? 'цех не найден' : 'цех не выбран';
  return found.code ? `Цех ${found.code} — ${found.name}` : found.name;
}

function newStepId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `step-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function markLine(label: string, mark: { at: number; by: string; employeeName?: string } | undefined): string {
  if (!mark) return '';
  return `${label ? `${label}: ` : ''}${whoLine(mark)}`;
}

function whoLine(mark: { at: number; by: string; employeeName?: string }): string {
  const who = mark.employeeName ? `${mark.employeeName} (${mark.by})` : mark.by;
  return `${who} · ${formatMoscowLongDateTime(mark.at)}`;
}

export function WorkOrderRoutePanel(props: {
  route: WorkOrderRoute | undefined;
  workshops: readonly WorkOrderRouteWorkshop[];
  canEdit: boolean;
  /** Цех-заказчик наряда (`payload.workshopId`) — им подписаны «Заявка» и «Сдача» в шаблоне. */
  customerShopId?: string;
  onChange: (route: WorkOrderRoute | undefined) => void;
}) {
  const steps = props.route?.steps ?? [];
  const current = workOrderRouteCurrentStep(props.route);
  const progress = workOrderRouteProgress(props.route);
  const problems = props.route ? validateWorkOrderRoute(props.route) : [];
  const completion = props.route?.completion;

  const defaultShopId = props.customerShopId || props.workshops[0]?.id || '';

  function commit(nextSteps: WorkOrderRouteStep[], nextCompletion = completion) {
    if (nextSteps.length === 0) {
      props.onChange(undefined);
      return;
    }
    props.onChange({
      steps: nextSteps,
      ...(nextCompletion ? { completion: nextCompletion } : {}),
    });
  }

  function addStep(kind: WorkOrderRouteStepKind) {
    const step = createWorkOrderRouteStep({
      id: newStepId(),
      kind,
      shopId: defaultShopId,
      shopName: workshopLabel(props.workshops, defaultShopId),
    });
    commit([...steps, step]);
  }

  function patchStep(stepId: string, patch: Partial<WorkOrderRouteStep>) {
    commit(steps.map((step) => (step.id === stepId ? { ...step, ...patch } : step)));
  }

  function removeStep(stepId: string) {
    commit(steps.filter((step) => step.id !== stepId));
  }

  function moveStep(stepId: string, direction: -1 | 1) {
    const index = steps.findIndex((step) => step.id === stepId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= steps.length) return;
    const next = [...steps];
    const [row] = next.splice(index, 1);
    if (!row) return;
    next.splice(target, 0, row);
    commit(next);
  }

  function buildMinimalRoute() {
    const customerShopId = props.customerShopId;
    if (!customerShopId) return;
    const customerName = workshopLabel(props.workshops, customerShopId);
    const executor = props.workshops.find((row) => row.id !== customerShopId) ?? props.workshops[0];
    if (!executor) return;
    commit(
      [
        createWorkOrderRouteStep({ id: newStepId(), kind: 'order', shopId: customerShopId, shopName: customerName }),
        createWorkOrderRouteStep({
          id: newStepId(),
          kind: 'work',
          shopId: executor.id,
          shopName: workshopLabel(props.workshops, executor.id),
        }),
        createWorkOrderRouteStep({ id: newStepId(), kind: 'handover', shopId: customerShopId, shopName: customerName }),
      ],
      undefined,
    );
  }

  const currentLine = completion
    ? `Итог: ${WORK_ORDER_ROUTE_COMPLETION_STATUS_LABELS[completion.status]}${
        completion.reason ? ` — ${WORK_ORDER_ROUTE_REASON_LABELS[completion.reason]}` : ''
      }`
    : current
      ? `Где сейчас: ${current.shopName || workshopLabel(props.workshops, current.shopId)} · ${WORK_ORDER_ROUTE_STEP_LABELS[current.kind]} · ${
          WORK_ORDER_ROUTE_STEP_STATE_LABELS[current.state]
        }`
      : steps.length > 0
        ? 'Все шаги выполнены — маршрут ждёт итога'
        : 'Маршрут не задан';

  return (
    <SectionCard
      title="Маршрут по цехам"
      actions={
        <span style={{ fontSize: 12, color: theme.colors.muted }}>
          {steps.length > 0 ? `пройдено ${progress.done} из ${progress.total}` : ''}
        </span>
      }
    >
      <div data-wo-route style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div
          data-wo-route-current
          style={{
            padding: '8px 10px',
            borderRadius: 10,
            border: `1px solid ${theme.colors.border}`,
            background: theme.colors.surface2,
            fontWeight: 650,
          }}
        >
          {currentLine}
        </div>

        {steps.length === 0 ? (
          <div style={{ fontSize: 13, color: theme.colors.muted }}>
            Работа числится за цехом наряда. Соберите маршрут, если она будет переходить между цехами: заявка →
            комплектация → работа → контроль → сдача.
          </div>
        ) : (
          <ol data-wo-route-steps style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {steps.map((step, index) => {
              const isCurrent = current?.id === step.id;
              return (
                <li
                  key={step.id}
                  data-wo-route-step
                  data-wo-route-step-state={step.state}
                  style={{
                    border: `1px solid ${isCurrent ? theme.colors.borderStrong : theme.colors.border}`,
                    borderRadius: 10,
                    padding: '8px 10px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    background: isCurrent ? theme.colors.surface2 : 'transparent',
                  }}
                >
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, color: theme.colors.muted, minWidth: 18 }}>{index + 1}</span>
                    <select
                      data-wo-route-step-kind
                      value={step.kind}
                      disabled={!props.canEdit}
                      title={WORK_ORDER_ROUTE_STEP_HINTS[step.kind]}
                      onChange={(event) => patchStep(step.id, { kind: event.target.value as WorkOrderRouteStepKind })}
                      style={{ minWidth: 150, padding: '4px 6px' }}
                    >
                      {WORK_ORDER_ROUTE_STEP_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {WORK_ORDER_ROUTE_STEP_LABELS[kind]}
                        </option>
                      ))}
                    </select>
                    <select
                      data-wo-route-step-shop
                      value={step.shopId}
                      disabled={!props.canEdit}
                      onChange={(event) =>
                        patchStep(step.id, {
                          shopId: event.target.value,
                          shopName: workshopLabel(props.workshops, event.target.value),
                        })
                      }
                      style={{ minWidth: 170, padding: '4px 6px' }}
                    >
                      <option value="">— цех —</option>
                      {props.workshops.map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.code ? `Цех ${row.code} — ${row.name}` : row.name}
                        </option>
                      ))}
                    </select>
                    <input
                      data-wo-route-step-title
                      type="text"
                      value={step.title ?? ''}
                      disabled={!props.canEdit}
                      placeholder="что делают (необязательно)"
                      onChange={(event) => patchStep(step.id, { title: event.target.value })}
                      style={{ flex: 1, minWidth: 180, padding: '4px 6px' }}
                    />
                    <span
                      data-wo-route-step-state-label
                      style={{ fontSize: 12, fontWeight: 650, color: stateTone(step.state), whiteSpace: 'nowrap' }}
                    >
                      {WORK_ORDER_ROUTE_STEP_STATE_LABELS[step.state]}
                    </span>
                    {props.canEdit ? (
                      <span style={{ display: 'inline-flex', gap: 2 }}>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={index === 0}
                          title="Выше"
                          onClick={() => moveStep(step.id, -1)}
                        >
                          ↑
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={index === steps.length - 1}
                          title="Ниже"
                          onClick={() => moveStep(step.id, 1)}
                        >
                          ↓
                        </Button>
                        <Button variant="ghost" size="sm" title="Убрать шаг" onClick={() => removeStep(step.id)}>
                          ✕
                        </Button>
                      </span>
                    ) : null}
                  </div>

                  {step.sent || step.accepted || step.done ? (
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12, color: theme.colors.muted }}>
                      {step.sent ? <span>{markLine('Отправил', step.sent)}</span> : null}
                      {step.accepted ? <span>{markLine('Принял', step.accepted)}</span> : null}
                      {step.done ? <span>{markLine('Выполнил', step.done)}</span> : null}
                    </div>
                  ) : null}

                  {step.returns && step.returns.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12, color: theme.colors.danger }}>
                      {step.returns.map((row, returnIndex) => (
                        <span key={`${step.id}-return-${returnIndex}`}>
                          Возврат: {WORK_ORDER_ROUTE_REASON_LABELS[row.reason]}
                          {row.note ? ` — ${row.note}` : ''} · {whoLine(row)}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}

        {problems.length > 0 ? (
          <div data-wo-route-problems style={{ fontSize: 12, color: theme.colors.danger }}>
            Маршрут сохранён с расхождением: {problems.map((problem) => WORK_ORDER_ROUTE_PROBLEM_MESSAGES[problem.code]).join('; ')}.
          </div>
        ) : null}

        {props.canEdit ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {WORK_ORDER_ROUTE_STEP_KINDS.map((kind) => (
              <Button
                key={kind}
                variant="ghost"
                size="sm"
                data-wo-route-add={kind}
                title={WORK_ORDER_ROUTE_STEP_HINTS[kind]}
                onClick={() => addStep(kind)}
              >
                + {WORK_ORDER_ROUTE_STEP_LABELS[kind]}
              </Button>
            ))}
            <span style={{ flex: 1 }} />
            <Button
              variant="outline"
              size="sm"
              data-wo-route-template="minimal"
              disabled={!props.customerShopId || props.workshops.length === 0}
              title={
                props.customerShopId
                  ? 'Заявка в цехе-заказчике → работа в другом цеху → сдача заказчику'
                  : 'Сначала выберите цех наряда в реквизитах'
              }
              onClick={buildMinimalRoute}
            >
              Собрать маршрут: заявка → работа → сдача
            </Button>
            {steps.length > 0 ? (
              <Button variant="ghost" size="sm" data-wo-route-clear onClick={() => props.onChange(undefined)}>
                Убрать маршрут
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
