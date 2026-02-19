import { useEffect } from 'react';

const AUTO_GROW_TYPES = new Set(['text', 'number', 'search', 'email', 'url', 'tel', 'password']);

type AutoGrowConfig = {
  autoGrowAll: boolean;
  minChars: number;
  maxChars: number;
  extraChars: number;
};

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readNumberCssVar(root: HTMLElement, name: string, fallback: number): number {
  const raw = getComputedStyle(root).getPropertyValue(name).trim();
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isNumericLike(type: string, inputMode: string): boolean {
  return type === 'number' || inputMode === 'numeric' || inputMode === 'decimal';
}

function shouldAutoGrow(input: HTMLInputElement, config: AutoGrowConfig): boolean {
  if (input.dataset.autogrow === 'off') return false;
  const type = String(input.type || 'text').toLowerCase();
  const inputMode = String(input.inputMode || '').toLowerCase();
  if (!AUTO_GROW_TYPES.has(type)) return false;
  if (input.dataset.autogrow === 'on') return true;
  return config.autoGrowAll || isNumericLike(type, inputMode);
}

function contentLength(input: HTMLInputElement): number {
  const value = String(input.value ?? '');
  const placeholder = String(input.placeholder ?? '');
  const source = value.length > 0 ? value : placeholder;
  return Math.max(1, source.length);
}

export function useAutoGrowInputs() {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const body = document.body;
    if (!body) return;

    const readConfig = (): AutoGrowConfig => {
      const minChars = clampInt(readNumberCssVar(root, '--ui-input-autogrow-min-ch', 10), 3, 80);
      const maxCharsRaw = clampInt(readNumberCssVar(root, '--ui-input-autogrow-max-ch', 48), 6, 120);
      const maxChars = Math.max(minChars, maxCharsRaw);
      const extraChars = clampInt(readNumberCssVar(root, '--ui-input-autogrow-extra-ch', 2), 0, 20);
      return {
        autoGrowAll: root.dataset.uiInputAutogrowAll !== '0',
        minChars,
        maxChars,
        extraChars,
      };
    };

    const clearManagedStyle = (input: HTMLInputElement) => {
      if (input.dataset.uiInputAutogrowManaged !== '1') return;
      if (input.dataset.uiInputAutogrowPrevWidth !== undefined) {
        input.style.width = input.dataset.uiInputAutogrowPrevWidth;
      } else {
        input.style.removeProperty('width');
      }
      if (input.dataset.uiInputAutogrowPrevMinWidth !== undefined) {
        input.style.minWidth = input.dataset.uiInputAutogrowPrevMinWidth;
      } else {
        input.style.removeProperty('min-width');
      }
      if (input.dataset.uiInputAutogrowPrevMaxWidth !== undefined) {
        input.style.maxWidth = input.dataset.uiInputAutogrowPrevMaxWidth;
      } else {
        input.style.removeProperty('max-width');
      }
      delete input.dataset.uiInputAutogrowManaged;
      delete input.dataset.uiInputAutogrowPrevWidth;
      delete input.dataset.uiInputAutogrowPrevMinWidth;
      delete input.dataset.uiInputAutogrowPrevMaxWidth;
    };

    const applyToInput = (input: HTMLInputElement, config: AutoGrowConfig) => {
      if (!shouldAutoGrow(input, config)) {
        clearManagedStyle(input);
        return;
      }
      if (input.dataset.uiInputAutogrowManaged !== '1') {
        input.dataset.uiInputAutogrowPrevWidth = input.style.width;
        input.dataset.uiInputAutogrowPrevMinWidth = input.style.minWidth;
        input.dataset.uiInputAutogrowPrevMaxWidth = input.style.maxWidth;
      }
      const targetChars = clampInt(contentLength(input) + config.extraChars, config.minChars, config.maxChars);
      input.style.width = `${targetChars}ch`;
      input.style.minWidth = `${config.minChars}ch`;
      input.style.maxWidth = `${config.maxChars}ch`;
      input.dataset.uiInputAutogrowManaged = '1';
    };

    const syncAll = () => {
      const config = readConfig();
      const allInputs = document.querySelectorAll('input');
      allInputs.forEach((node) => {
        if (node instanceof HTMLInputElement) applyToInput(node, config);
      });
    };

    let rafId = 0;
    const scheduleSync = () => {
      if (rafId) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        syncAll();
      });
    };

    const onInputLike = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      applyToInput(target, readConfig());
    };

    document.addEventListener('input', onInputLike, true);
    document.addEventListener('change', onInputLike, true);
    document.addEventListener('focusin', onInputLike, true);

    const observer = new MutationObserver(() => scheduleSync());
    observer.observe(body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['type', 'placeholder', 'data-autogrow'],
    });
    const rootObserver = new MutationObserver(() => scheduleSync());
    rootObserver.observe(root, {
      attributes: true,
      attributeFilter: ['style', 'data-ui-input-autogrow-all'],
    });

    const intervalId = window.setInterval(scheduleSync, 1200);
    scheduleSync();

    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      window.clearInterval(intervalId);
      observer.disconnect();
      rootObserver.disconnect();
      document.removeEventListener('input', onInputLike, true);
      document.removeEventListener('change', onInputLike, true);
      document.removeEventListener('focusin', onInputLike, true);
    };
  }, []);
}

