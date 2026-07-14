import type { UiIntent } from '@matricarmz/shared';

/**
 * Runtime injected into SpecRenderer by App.tsx. Executes intents through the
 * app's own navigation (v1 setTab / v2 list-column semantics are the caller's
 * concern) and answers whether the CURRENT viewer may run an intent — a button
 * to a section-gated tab renders disabled instead of navigating into a wall.
 */
export type UiIntentRuntime = {
  runIntent: (intent: UiIntent) => void;
  canRunIntent: (intent: UiIntent) => boolean;
  /** Tooltip for disabled buttons (null when enabled). */
  intentHint: (intent: UiIntent) => string | null;
  openEngine: (engineId: string) => void;
  openWorkOrder: (workOrderId: string) => void;
};

export function createIntentRuntime(deps: {
  /** Navigate to a menu tab (App branches v1/v2 shell internally). */
  navigateTab: (tabId: string) => void;
  /** Menu tabs the current viewer can actually see (section-gated). */
  accessibleMenuTabs: ReadonlySet<string>;
  openEngine: (engineId: string) => void;
  openWorkOrder: (workOrderId: string) => void;
}): UiIntentRuntime {
  const targetTab = (intent: UiIntent): string => (intent.type === 'navigate_tab' ? intent.tabId : 'reports');
  const canRunIntent = (intent: UiIntent) => deps.accessibleMenuTabs.has(targetTab(intent));
  return {
    canRunIntent,
    intentHint: (intent) => (canRunIntent(intent) ? null : 'Нет доступа к этому разделу'),
    runIntent: (intent) => {
      if (!canRunIntent(intent)) return;
      deps.navigateTab(targetTab(intent));
    },
    openEngine: deps.openEngine,
    openWorkOrder: deps.openWorkOrder,
  };
}

/** Preview runtime for the editor: navigation is a no-op reported via toast. */
export function createPreviewIntentRuntime(notify: (msg: string) => void): UiIntentRuntime {
  return {
    canRunIntent: () => true,
    intentHint: () => null,
    runIntent: (intent) => {
      notify(
        intent.type === 'navigate_tab'
          ? `Переход на вкладку «${intent.tabId}» (в предпросмотре не выполняется)`
          : 'Открытие отчёта (в предпросмотре не выполняется)',
      );
    },
    openEngine: () => notify('Открытие карточки (в предпросмотре не выполняется)'),
    openWorkOrder: () => notify('Открытие наряда (в предпросмотре не выполняется)'),
  };
}
