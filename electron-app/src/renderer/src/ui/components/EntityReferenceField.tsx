import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { EntityReferenceTarget, QuickCreateRequest, QuickCreateResult } from '@matricarmz/shared';

import { useConfirmOptional } from './ConfirmContext.js';
import { SearchSelect, type SearchSelectOption } from './SearchSelect.js';
import { QuickCreateDialog } from './QuickCreateDialog.js';
import { normalizeLookupText } from '../utils/searchMatching.js';

export type EntityReferenceFieldProps = {
  target: EntityReferenceTarget;
  targetLabel: string;
  value: string | null;
  options: SearchSelectOption[];
  onChange: (next: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  optionsReady?: boolean;
  showAllWhenEmpty?: boolean;
  emptyQueryLimit?: number;
  canCreate?: boolean;
  createLabel?: string;
  onCreate?: (label: string) => Promise<string | null>;
  onQuickCreate?: (request: QuickCreateRequest) => Promise<QuickCreateResult | null>;
  onOpen?: (id: string) => void;
};

export function findUniqueExactReference(query: string, options: SearchSelectOption[]): SearchSelectOption | null {
  const normalized = normalizeLookupText(query);
  if (!normalized) return null;
  const matches = options.filter((option) => normalizeLookupText(option.label) === normalized);
  return matches.length === 1 ? matches[0] ?? null : null;
}

export function hasUnresolvedEntityReference(
  query: string,
  value: string | null,
  selected: SearchSelectOption | null,
): boolean {
  const normalized = normalizeLookupText(query);
  if (!normalized) return false;
  return !value || !selected || normalized !== normalizeLookupText(selected.label);
}

export function EntityReferenceField(props: EntityReferenceFieldProps) {
  const confirm = useConfirmOptional();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const resolvingRef = useRef(false);
  const preserveTypedQueryRef = useRef(false);
  const previousValueRef = useRef<string | null>(props.value);
  const selected = useMemo(
    () => (props.value ? props.options.find((option) => option.id === props.value) ?? null : null),
    [props.options, props.value],
  );
  // Висячая ссылка: значение задано, но не резолвится в живую опцию (сущность удалена).
  // Гейтим на загруженность опций (length>0 и optionsReady!==false), чтобы не показывать
  // предупреждение, пока справочник ещё грузится — иначе мигало бы на каждом старте карточки.
  const dangling = props.value != null && !selected && props.options.length > 0 && props.optionsReady !== false;
  const [query, setQuery] = useState(selected?.label ?? '');
  const [quickCreateLabel, setQuickCreateLabel] = useState<string | null>(null);
  const quickCreateResolveRef = useRef<((result: QuickCreateResult | null) => void) | null>(null);

  useEffect(() => {
    if (selected) {
      setQuery(selected.label);
    } else if (previousValueRef.current && !props.value && !preserveTypedQueryRef.current) {
      setQuery('');
    }
    preserveTypedQueryRef.current = false;
    previousValueRef.current = props.value;
  }, [props.value, selected]);

  useEffect(() => {
    function blockActionUntilResolved(event: MouseEvent) {
      if (
        resolvingRef.current ||
        !hasUnresolvedEntityReference(query, props.value, selected) ||
        rootRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      void resolveOnBlur(query);
    }
    document.addEventListener('mousedown', blockActionUntilResolved, true);
    return () => document.removeEventListener('mousedown', blockActionUntilResolved, true);
  }, [props.disabled, props.options, props.optionsReady, props.value, query, selected]);

  function commit(option: SearchSelectOption) {
    setQuery(option.label);
    props.onChange(option.id);
  }

  function clear() {
    setQuery('');
    props.onChange(null);
  }

  function handleQueryChange(next: string) {
    setQuery(next);
    if (props.value && normalizeLookupText(next) !== normalizeLookupText(selected?.label ?? '')) {
      preserveTypedQueryRef.current = true;
      props.onChange(null);
    }
  }

  async function resolveOnBlur(rawQuery: string) {
    if (props.disabled || resolvingRef.current) return;
    const trimmed = rawQuery.trim();
    if (!trimmed) {
      clear();
      return;
    }
    if (selected && normalizeLookupText(trimmed) === normalizeLookupText(selected.label)) return;
    if (props.optionsReady === false) return;

    const exact = findUniqueExactReference(trimmed, props.options);
    if (exact) {
      commit(exact);
      return;
    }

    resolvingRef.current = true;
    try {
      const canCreate = props.canCreate === true && Boolean(props.onCreate || props.onQuickCreate);
      const choice = await confirm?.pickChoice({
        title: `${props.targetLabel}: элемент не выбран`,
        detail: `Значение «${trimmed}» не найдено в базе. Выберите существующий элемент или создайте новый.`,
        choices: [
          { id: 'choose', label: 'Выбрать другой элемент' },
          ...(canCreate ? [{ id: 'create', label: props.createLabel ?? `Создать: ${trimmed}` }] : []),
        ],
      });
      if (choice === 'create' && (props.onCreate || props.onQuickCreate)) {
        const id = await runCreate(trimmed);
        if (id) {
          setQuery(trimmed);
          props.onChange(id);
          return;
        }
      }
      clear();
      if (choice === 'choose') window.requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      resolvingRef.current = false;
    }
  }

  function runCreate(label: string): Promise<string | null> {
    if (!props.onQuickCreate) return props.onCreate?.(label) ?? Promise.resolve(null);
    return new Promise<string | null>((resolve) => {
      quickCreateResolveRef.current = (result) => resolve(result?.id ?? null);
      setQuickCreateLabel(label);
    });
  }

  function closeQuickCreate(result: QuickCreateResult | null) {
    setQuickCreateLabel(null);
    const resolve = quickCreateResolveRef.current;
    quickCreateResolveRef.current = null;
    resolve?.(result);
  }

  return (
    <div ref={rootRef} style={{ display: 'grid', gridTemplateColumns: props.onOpen ? 'minmax(0, 1fr) auto' : 'minmax(0, 1fr)', gap: 6 }}>
      {dangling && (
        <div
          style={{
            gridColumn: '1 / -1',
            fontSize: 12,
            color: 'var(--danger, #b91c1c)',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          ⚠ {props.targetLabel}: выбранное значение удалено — выберите заново
        </div>
      )}
      <SearchSelect
        value={props.value}
        options={props.options}
        query={query}
        inputRef={inputRef}
        disabled={props.disabled === true}
        onQueryChange={handleQueryChange}
        onInputBlur={(next) => void resolveOnBlur(next)}
        onChange={(next) => {
          if (!next) {
            clear();
            return;
          }
          const option = props.options.find((candidate) => candidate.id === next);
          if (option) commit(option);
        }}
        {...(props.showAllWhenEmpty !== undefined ? { showAllWhenEmpty: props.showAllWhenEmpty } : {})}
        {...(props.emptyQueryLimit !== undefined ? { emptyQueryLimit: props.emptyQueryLimit } : {})}
        {...(props.placeholder !== undefined ? { placeholder: props.placeholder } : {})}
        {...(props.canCreate === true && (props.onCreate || props.onQuickCreate) ? { onCreate: runCreate } : {})}
        {...(props.createLabel !== undefined ? { createLabel: props.createLabel } : {})}
      />
      {props.onOpen && props.value ? (
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => props.onOpen?.(props.value as string)}
          title={`Открыть карточку: ${props.targetLabel.toLocaleLowerCase('ru-RU')}`}
          aria-label={`Открыть карточку: ${props.targetLabel.toLocaleLowerCase('ru-RU')}`}
          style={{
            minWidth: 36,
            minHeight: 36,
            borderRadius: 10,
            border: '1px solid var(--button-ghost-border)',
            background: 'var(--button-ghost-bg)',
            color: 'var(--text)',
            cursor: 'pointer',
          }}
        >
          ↗
        </button>
      ) : null}
      {quickCreateLabel !== null && props.onQuickCreate ? (
        <QuickCreateDialog
          target={props.target}
          targetLabel={props.targetLabel}
          initialLabel={quickCreateLabel}
          onSubmit={props.onQuickCreate}
          onClose={closeQuickCreate}
        />
      ) : null}
    </div>
  );
}
