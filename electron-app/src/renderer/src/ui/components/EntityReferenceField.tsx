import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { EntityReferenceTarget, QuickCreateRequest, QuickCreateResult } from '@matricarmz/shared';

import { useConfirmOptional } from './ConfirmContext.js';
import { SearchSelect, type SearchSelectOption } from './SearchSelect.js';
import { QuickCreateDialog } from './QuickCreateDialog.js';
import { normalizeLookupCompact, rankLookupOptions } from '../utils/searchMatching.js';
import { usePickerRank } from '../hooks/usePickerRank.js';

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
  /**
   * Точка выбора для рейтинга «кого оператор выбирает чаще» (§D4). Задан — часто выбираемые
   * поднимаются наверх списка, и каждый выбор поднимает счётчик. Ключ называет РОЛЬ, а не
   * экран: «утверждающий» и «член экипажа» — разные люди, общий рейтинг мешал бы обоим.
   * Не задан — порядок опций ровно тот, что пришёл от вызывающего.
   */
  rankKey?: string;
};

export function findUniqueExactReference(query: string, options: SearchSelectOption[]): SearchSelectOption | null {
  // Compact comparison: users type «в84» while the catalog says «В-84» — spacing
  // and punctuation must not force the "элемент не выбран" dialog. Ambiguity
  // (several compact-equal labels) still returns null and asks the user.
  const normalized = normalizeLookupCompact(query);
  if (!normalized) return null;
  const matches = options.filter((option) => normalizeLookupCompact(option.label) === normalized);
  return matches.length === 1 ? matches[0] ?? null : null;
}

export function hasUnresolvedEntityReference(
  query: string,
  value: string | null,
  selected: SearchSelectOption | null,
): boolean {
  const normalized = normalizeLookupCompact(query);
  if (!normalized) return false;
  return !value || !selected || normalized !== normalizeLookupCompact(selected.label);
}

/** Что делать с кликом мимо поля, пока в нём висит неразрешённый текст. */
export type UnresolvedClickAction =
  /** Не наше дело: пропустить клик как есть. */
  | 'ignore'
  /** Запустить разбор текста, но клик пропустить дальше (фокус обязан уйти). */
  | 'resolve'
  /** Запустить разбор текста и съесть клик, чтобы действие не выполнилось. */
  | 'resolve-and-block';

/** Снимок цели клика: DOM здесь уже разобран, решение принимается по чистым данным. */
export type ReferenceClickTarget = {
  /** Клик внутри самого поля или его выпадающего списка. */
  insideField: boolean;
  /** Тег элемента под курсором в верхнем регистре: 'INPUT', 'BUTTON', … */
  tagName: string;
  /** Значение type у input (для прочих тегов — null). */
  inputType: string | null;
  /** Элемент (или его предок) редактируется мышью — contenteditable. */
  editable: boolean;
};

/** Типы input, которые по клику выполняют действие, а не принимают текст. */
const ACTION_INPUT_TYPES = new Set(['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file']);

export function isTextEntryClickTarget(target: ReferenceClickTarget): boolean {
  if (target.editable) return true;
  if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
  if (target.tagName !== 'INPUT') return false;
  return !ACTION_INPUT_TYPES.has((target.inputType ?? 'text').toLowerCase());
}

/**
 * Клик мимо поля с неразрешённым текстом: съесть, пропустить или пропустить с разбором.
 *
 * Глотать клик по ДРУГОМУ полю ввода нельзя: для оператора это выглядит как «курсор
 * застрял между текстурами» — он целится в соседнее поле, а оно не принимает ввод.
 * Диалог разбора всё равно откроется, фокус при этом уходит туда, куда оператор метил.
 * Кнопку/ссылку по-прежнему блокируем: там клик выполняет действие, и выполнить его
 * с неразобранным значением в поле — это записать в базу мусор.
 */
export function decideUnresolvedReferenceClick(
  target: ReferenceClickTarget,
  state: { unresolved: boolean; resolving: boolean },
): UnresolvedClickAction {
  if (!state.unresolved || state.resolving) return 'ignore';
  if (target.insideField) return 'ignore';
  return isTextEntryClickTarget(target) ? 'resolve' : 'resolve-and-block';
}

function describeReferenceClickTarget(node: Node | null, root: HTMLElement | null): ReferenceClickTarget {
  const element = node instanceof Element ? node : null;
  // SearchSelect рисует выпадашку (и кнопку-подсказку) порталом в document.body —
  // такой клик относится к ЭТОМУ полю, а не к уходу из него.
  const insideField =
    (node != null && root?.contains(node) === true) ||
    (element != null && element.closest('[data-entity-lookup-popup]') != null);
  return {
    insideField,
    tagName: element?.tagName ?? '',
    inputType: element instanceof HTMLInputElement ? element.type : null,
    editable: element != null && element.closest('[contenteditable=""],[contenteditable="true"]') != null,
  };
}

export function EntityReferenceField(props: EntityReferenceFieldProps) {
  const confirm = useConfirmOptional();
  const rank = usePickerRank(props.rankKey);
  // Рейтинг переставляет опции ДО выпадающего списка: при пустом запросе он показывает первые
  // N штук, и нужный человек иначе в эти N не попадал вовсе. При набранном запросе порядок
  // держит поиск (`rankLookupOptions`), рейтинг там разводит только равные совпадения.
  const options = useMemo(() => rank.rankOptions(props.options), [props.options, rank]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const resolvingRef = useRef(false);
  const preserveTypedQueryRef = useRef(false);
  const previousValueRef = useRef<string | null>(props.value);
  const selected = useMemo(
    () => (props.value ? options.find((option) => option.id === props.value) ?? null : null),
    [options, props.value],
  );
  // Висячая ссылка: значение задано, но не резолвится в живую опцию (сущность удалена).
  // Гейтим на загруженность опций (length>0 и optionsReady!==false), чтобы не показывать
  // предупреждение, пока справочник ещё грузится — иначе мигало бы на каждом старте карточки.
  const dangling = props.value != null && !selected && options.length > 0 && props.optionsReady !== false;
  const [query, setQuery] = useState(selected?.label ?? '');
  // Компактная форма текста, который диалог разбора уже отработал. Без этой памяти поле
  // после «Создать: …» снова считается неразрешённым (опции у вызывающего ещё не
  // обновились) и опять съедает каждый клик — для оператора это залипание фокуса.
  const [settledQuery, setSettledQuery] = useState<string | null>(null);
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

  // Поле «держит» неразрешённый текст. Пока это не так (а это 99% времени), глобального
  // перехватчика кликов на документе быть не должно вовсе. Выключённое поле и незагруженный
  // справочник разобрать текст не могут — блокировать клики там значит съедать их молча.
  const unresolved =
    props.disabled !== true &&
    props.optionsReady !== false &&
    normalizeLookupCompact(query) !== settledQuery &&
    hasUnresolvedEntityReference(query, props.value, selected);

  // Всё, что читает перехватчик, держим в ref: иначе слушатель переустанавливался бы на
  // каждый рендер (options — новый массив каждый раз), а props, которые resolveOnBlur
  // читает по пути к диалогу, оставались бы от момента установки слушателя.
  const latestRef = useRef({ query, unresolved, resolve: resolveOnBlur });
  useEffect(() => {
    latestRef.current = { query, unresolved, resolve: resolveOnBlur };
  });

  useEffect(() => {
    if (!unresolved) return undefined;
    function blockActionUntilResolved(event: MouseEvent) {
      const latest = latestRef.current;
      const action = decideUnresolvedReferenceClick(
        describeReferenceClickTarget(event.target as Node | null, rootRef.current),
        { unresolved: latest.unresolved, resolving: resolvingRef.current },
      );
      if (action === 'ignore') return;
      if (action === 'resolve-and-block') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      }
      void latest.resolve(latest.query);
    }
    document.addEventListener('mousedown', blockActionUntilResolved, true);
    return () => document.removeEventListener('mousedown', blockActionUntilResolved, true);
  }, [unresolved]);

  function commit(option: SearchSelectOption) {
    setQuery(option.label);
    // Счётчик поднимается ЗДЕСЬ, потому что это единственная воронка настоящего выбора:
    // клик по подсказке, Enter с клавиатуры, точное совпадение по набранному тексту и ответ
    // «Выбрать: …» в диалоге. Очистка поля (`clear`) выбором не является и не считается.
    rank.bump(option.id);
    props.onChange(option.id);
  }

  function clear() {
    setQuery('');
    props.onChange(null);
  }

  function handleQueryChange(next: string) {
    setQuery(next);
    // Текст изменился — прошлый разбор к нему не относится, перехват снова в силе.
    setSettledQuery(null);
    if (props.value && normalizeLookupCompact(next) !== normalizeLookupCompact(selected?.label ?? '')) {
      preserveTypedQueryRef.current = true;
      props.onChange(null);
    }
  }

  async function resolveOnBlur(rawQuery: string) {
    if (props.disabled || resolvingRef.current) return;
    // Флаг ставим СИНХРОННО, до первого await и до любого выхода: иначе второй клик
    // успевает проскочить, пока диалог ещё не открылся, и запускает второй диалог поверх.
    // Снимается во всех ветках выхода — за это отвечает finally.
    resolvingRef.current = true;
    try {
      const trimmed = rawQuery.trim();
      if (!trimmed) {
        clear();
        return;
      }
      if (selected && normalizeLookupCompact(trimmed) === normalizeLookupCompact(selected.label)) {
        // Same element typed with different spacing/punctuation — snap the visible
        // text back to the canonical label instead of leaving the variant on screen.
        setQuery(selected.label);
        return;
      }
      if (props.optionsReady === false) return;

      const exact = findUniqueExactReference(trimmed, options);
      if (exact) {
        commit(exact);
        return;
      }

      const canCreate = props.canCreate === true && Boolean(props.onCreate || props.onQuickCreate);
      const similar = rankLookupOptions(options, trimmed)[0] ?? null;
      const choice = await confirm?.pickChoice({
        title: `${props.targetLabel}: элемент не выбран`,
        detail: `Значение «${trimmed}» не найдено в базе. Выберите существующий элемент или создайте новый.`,
        choices: [
          ...(similar ? [{ id: 'similar', label: `Выбрать: ${similar.label}` }] : []),
          { id: 'choose', label: 'Выбрать другой элемент' },
          ...(canCreate ? [{ id: 'create', label: props.createLabel ?? `Создать: ${trimmed}` }] : []),
        ],
      });
      // Диалог закрыт (в т.ч. «Отмена»/по фону) — этот текст разобран. Дальше он не считается
      // неразрешённым, пока оператор его не изменит: иначе следующий клик снова блокируется.
      setSettledQuery(normalizeLookupCompact(trimmed));
      if (choice === 'similar' && similar) {
        commit(similar);
        return;
      }
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
        options={options}
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
          const option = options.find((candidate) => candidate.id === next);
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
