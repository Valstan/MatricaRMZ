import { useEffect } from 'react';

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

function isTextLikeInput(el: HTMLInputElement): boolean {
  const type = String(el.type || 'text').toLowerCase();
  return !NON_TEXT_INPUT_TYPES.has(type);
}

function isNavigableField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLInputElement) {
    return !el.disabled && !el.readOnly && isTextLikeInput(el);
  }
  if (el instanceof HTMLTextAreaElement) {
    return !el.disabled && !el.readOnly;
  }
  return false;
}

function isVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  return el.offsetParent !== null || style.position === 'fixed';
}

function collectFocusableFields(): Array<HTMLInputElement | HTMLTextAreaElement> {
  const nodes = Array.from(document.querySelectorAll('input, textarea'));
  return nodes.filter((el): el is HTMLInputElement | HTMLTextAreaElement => {
    if (!(el instanceof HTMLElement)) return false;
    if (!isNavigableField(el)) return false;
    if (!isVisible(el)) return false;
    return el.tabIndex >= 0;
  });
}

export function useTabFocusSelectAll(options?: { enableEnterAsTab?: boolean }) {
  useEffect(() => {
    let selectOnNextFocus = false;
    const enableEnterAsTab = options?.enableEnterAsTab === true;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) {
        selectOnNextFocus = true;
        return;
      }
      if (enableEnterAsTab && e.key === 'Enter' && !e.altKey && !e.ctrlKey && !e.metaKey) {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement)) return;
        // Keep default multiline behavior in textarea.
        if (active instanceof HTMLTextAreaElement) return;
        if (!(active instanceof HTMLInputElement)) return;
        if (!isNavigableField(active)) return;
        const fields = collectFocusableFields();
        if (fields.length === 0) return;
        const currentIdx = fields.indexOf(active);
        if (currentIdx < 0) return;
        const nextIdx = e.shiftKey ? currentIdx - 1 : currentIdx + 1;
        if (nextIdx < 0 || nextIdx >= fields.length) return;
        e.preventDefault();
        selectOnNextFocus = true;
        const next = fields[nextIdx];
        window.requestAnimationFrame(() => {
          try {
            next.focus();
          } catch {
            // no-op
          }
        });
        return;
      }
      selectOnNextFocus = false;
    };

    const cancelSelectionArm = () => {
      selectOnNextFocus = false;
    };

    const onFocusIn = (e: FocusEvent) => {
      if (!selectOnNextFocus) return;
      selectOnNextFocus = false;
      const target = e.target;
      if (target instanceof HTMLInputElement) {
        if (!isNavigableField(target)) return;
        window.requestAnimationFrame(() => {
          try {
            target.select();
          } catch {
            // no-op
          }
        });
        return;
      }
      if (target instanceof HTMLTextAreaElement) {
        if (!isNavigableField(target)) return;
        window.requestAnimationFrame(() => {
          try {
            target.select();
          } catch {
            // no-op
          }
        });
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('mousedown', cancelSelectionArm, true);
    window.addEventListener('pointerdown', cancelSelectionArm, true);
    window.addEventListener('touchstart', cancelSelectionArm, true);
    window.addEventListener('focusin', onFocusIn, true);

    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('mousedown', cancelSelectionArm, true);
      window.removeEventListener('pointerdown', cancelSelectionArm, true);
      window.removeEventListener('touchstart', cancelSelectionArm, true);
      window.removeEventListener('focusin', onFocusIn, true);
    };
  }, [options?.enableEnterAsTab]);
}

