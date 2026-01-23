import { useEffect, useRef } from 'react';

import type { AiAgentContext, AiAgentEvent } from '@matricarmz/shared';

const IDLE_TIMEOUT_MS = 8000;
const LONG_IDLE_MS = 20000;

function nowMs() {
  return Date.now();
}

function isIgnoredTarget(target: HTMLElement | null): boolean {
  if (!target) return false;
  return Boolean(target.closest('[data-ai-agent-ignore="true"]'));
}

function isFieldElement(target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  if (!target || !(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

function getLabelForElement(el: HTMLElement): string | null {
  const id = el.getAttribute('id');
  if (id) {
    const label = document.querySelector(`label[for="${id}"]`);
    const text = label?.textContent?.trim();
    if (text) return text;
  }
  const parentLabel = el.closest('label');
  const labelText = parentLabel?.textContent?.trim();
  return labelText || null;
}

function maskValue(raw: string, fieldName: string, inputType: string) {
  const lower = `${fieldName} ${inputType}`.toLowerCase();
  if (
    lower.includes('password') ||
    lower.includes('пароль') ||
    lower.includes('token') ||
    lower.includes('secret') ||
    lower.includes('ключ')
  ) {
    return '[masked]';
  }
  return raw;
}

function extractValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
  if (el instanceof HTMLSelectElement) {
    return el.value ?? '';
  }
  if (el instanceof HTMLInputElement && el.type === 'checkbox') {
    return el.checked ? 'true' : 'false';
  }
  return el.value ?? '';
}

function buildEvent(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, type: AiAgentEvent['type']): AiAgentEvent {
  const name = el.getAttribute('name') ?? null;
  const label = getLabelForElement(el);
  const placeholder = el.getAttribute('placeholder');
  const inputType = el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase();
  const valueRaw = String(extractValue(el) ?? '').trim();
  const valueMasked = maskValue(valueRaw, name || label || '', inputType);
  return {
    type,
    ts: nowMs(),
    tab: '',
    field: {
      name,
      label,
      placeholder: placeholder || null,
      inputType,
    },
    valuePreview: valueMasked ? valueMasked.slice(0, 120) : null,
  };
}

export function useAiAgentTracker(args: {
  enabled: boolean;
  context: AiAgentContext;
  onEvent?: (event: AiAgentEvent) => void;
}) {
  const contextRef = useRef(args.context);
  const focusStartRef = useRef<Map<HTMLElement, number>>(new Map());
  const lastInputRef = useRef<{ el: HTMLElement | null; value: string; ts: number }>({ el: null, value: '', ts: 0 });
  const idleTimerRef = useRef<number | null>(null);
  const lastIdleSentAtRef = useRef<number>(0);

  useEffect(() => {
    contextRef.current = args.context;
  }, [args.context.tab, args.context.entityId, args.context.entityType, args.context.breadcrumbs?.join('|')]);

  useEffect(() => {
    if (!args.enabled) return;

    const emit = (event: AiAgentEvent) => {
      const ctx = contextRef.current;
      const enriched: AiAgentEvent = {
        ...event,
        tab: ctx.tab,
        entityId: ctx.entityId ?? null,
        entityType: ctx.entityType ?? null,
      };
      args.onEvent?.(enriched);
      void window.matrica.aiAgent.logEvent({ context: ctx, event: enriched }).catch(() => {});
    };

    const handleFocus = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (!isFieldElement(target) || isIgnoredTarget(target)) return;
      focusStartRef.current.set(target, nowMs());
      emit(buildEvent(target, 'focus'));
    };

    const handleBlur = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (!isFieldElement(target) || isIgnoredTarget(target)) return;
      const startedAt = focusStartRef.current.get(target);
      const evt = buildEvent(target, 'blur');
      if (startedAt) {
        evt.durationMs = Math.max(0, nowMs() - startedAt);
        focusStartRef.current.delete(target);
      }
      emit(evt);
    };

    const scheduleIdle = () => {
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = window.setTimeout(() => {
        const last = lastInputRef.current;
        if (!last.el || !isFieldElement(last.el) || isIgnoredTarget(last.el)) return;
        const idleMs = Math.max(0, nowMs() - last.ts);
        if (idleMs < IDLE_TIMEOUT_MS) return;
        if (nowMs() - lastIdleSentAtRef.current < IDLE_TIMEOUT_MS) return;
        lastIdleSentAtRef.current = nowMs();
        const evt = buildEvent(last.el, 'idle');
        evt.idleMs = idleMs;
        emit(evt);
      }, IDLE_TIMEOUT_MS);
    };

    const handleInput = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (!isFieldElement(target) || isIgnoredTarget(target)) return;
      const value = String(extractValue(target as any) ?? '');
      lastInputRef.current = { el: target, value, ts: nowMs() };
      scheduleIdle();
    };

    document.addEventListener('focusin', handleFocus);
    document.addEventListener('focusout', handleBlur);
    document.addEventListener('input', handleInput);
    return () => {
      document.removeEventListener('focusin', handleFocus);
      document.removeEventListener('focusout', handleBlur);
      document.removeEventListener('input', handleInput);
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    };
  }, [args.enabled, args.onEvent]);

  return {
    longIdleMs: LONG_IDLE_MS,
  };
}
