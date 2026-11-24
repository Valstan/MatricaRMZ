import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  decideListDragDrop,
  listDragSourceKey,
  type ListDragEventLike,
} from '../utils/listDragDrop.js';

/**
 * Перетаскивание строк в ПП не работало: строка подсвечивалась, линия места
 * вставки показывалась, а порядок не менялся (владелец, 24.11.2026).
 *
 * КЛАСС ПОЛОМКИ (общий для всех списков на ките): состояние перетаскивания
 * гасилось ДО того, как страница успевала прочитать источник.
 *
 * Порядок событий в браузере:
 *   capture: document → … → корень React → … → цель
 *   всплытие: цель → … → корень React → … → document
 *
 * React 18 делегирует `onDrop` на корневой контейнер, поэтому обработчик
 * страницы срабатывает в фазе ВСПЛЫТИЯ на корне — ПОЗЖЕ capture-фазы на
 * `document`. Слушатель `drop` на `document` с `capture = true` приходил
 * первым и обнулял ref кита; после этого обработчик страницы видел «пусто» и
 * перестановку не делал.
 *
 * Сторож держит ДВЕ вещи:
 *   1. поведение — источник перетаскивания не зависит от состояния ref'а кита
 *      (тест ниже моделирует обе фазы и требует, чтобы перестановка случилась);
 *   2. проводку — `drop` на `document` слушается в фазе ВСПЛЫТИЯ, а не в capture.
 */
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const KIT = src('./useListDrag.ts');
const REORDER = src('./useListReorder.ts');

/** Событие перетаскивания с фейковым `dataTransfer` (в браузере он есть только в фазе drop). */
function dragEvent(dataKey: string | null): ListDragEventLike {
  return {
    dataTransfer: {
      getData: (format: string) => (format === 'text/plain' ? (dataKey ?? '') : ''),
    },
  };
}

describe('перетаскивание: источник не зависит от состояния кита', () => {
  it('источник читается из dataTransfer, даже если ref кита уже погашен', () => {
    // Ref погашен слушателем, отработавшим раньше обработчика страницы.
    const refCleared = null;
    expect(listDragSourceKey(dragEvent('row-7'), refCleared)).toBe('row-7');
  });

  it('без источника перестановки нет — и это явно, а не молча', () => {
    const decision = decideListDragDrop({
      sourceKey: listDragSourceKey(dragEvent(null), null),
      target: { index: 0, key: 'row-1', position: 'before' },
    });
    expect(decision).toEqual({ kind: 'ignore', reason: 'no-source' });
  });

  it('drop случился — порядок изменился (регрессия «строка остаётся на месте»)', () => {
    // Модель двух фаз: документный слушатель гасит состояние кита, затем
    // приходит обработчик страницы. Перестановка обязана случиться.
    const kitState = { source: 'row-7' as string | null };
    const event = dragEvent('row-7');

    // Фаза 1: capture-фаза на document — состояние гаснут (любой слушатель).
    kitState.source = null;

    // Фаза 2: обработчик страницы — источник всё ещё читается.
    const sourceKey = listDragSourceKey(event, kitState.source);
    const decision = decideListDragDrop({
      sourceKey,
      target: { index: 1, key: 'row-3', position: 'before' },
    });

    expect(decision.kind).toBe('reorder');
    if (decision.kind !== 'reorder') throw new Error('перестановка не произошла');
    expect(decision.sourceKey).toBe('row-7');
    expect(decision.target.key).toBe('row-3');
    expect(decision.target.position).toBe('before');
  });

  it('цели нет — перестановки нет, но это не тишина (решение «ignore»)', () => {
    const decision = decideListDragDrop({
      sourceKey: 'row-7',
      target: null,
    });
    expect(decision).toEqual({ kind: 'ignore', reason: 'no-target' });
  });
});

describe('перетаскивание: проводка событий в ките', () => {
  it('drop на document слушается в фазе ВСПЛЫТИЯ, а не в capture', () => {
    // capture-фаза на document приходит раньше обработчика страницы (React
    // делегирует onDrop на корневой контейнер) и гасит состояние раньше
    // времени — с этим ломалось перетаскивание во всех списках на ките.
    expect(KIT).toContain("document.addEventListener('drop', onEnd, false)");
    expect(KIT).not.toContain("document.addEventListener('drop', onEnd, true)");
    // dragend — отдельное событие, оно приходит после drop: capture тут безопасен.
    expect(KIT).toContain("document.addEventListener('dragend', onEnd, true)");
  });

  it('кит читает источник из dataTransfer, а не из своего ref', () => {
    expect(KIT).toContain('listDragSourceKey');
    expect(KIT).toContain('decideListDragDrop');
  });

  it('списки карточек берут источник так же — из dataTransfer', () => {
    // useListReorder раньше читал `drag.drag.key` (состояние кита) и выходил
    // раньше времени, если состояние уже погасло.
    expect(REORDER).toContain('drag.sourceKeyOf(event)');
    expect(REORDER).not.toContain('if (!drag.drag) return;');
  });
});

/**
 * Все страницы на ките — а не только ПП.
 *
 * Правка в ките чинит оба пути (ПП через `useListDrag` напрямую, карточки —
 * через `useListReorder`), но страница может «сойти с кита»: завести своё
 * состояние перетаскивания или повесить свой слушатель `drop`. Тогда класс
 * «строка осталась на месте» вернётся на этой странице, а кит будет чинить
 * только ПП. Сторож ловит именно это.
 */
describe('перетаскивание: все страницы ведут перестановку через кит', () => {
  const UI_ROOT = fileURLToPath(new URL('..', import.meta.url));

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = `${dir}/${entry}`;
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
    }
    return out;
  }

  const pages = walk(UI_ROOT)
    .filter((file) => !file.includes('.test.'))
    // Сам кит (и его проводник) — не «страница»: там слушатель `drop` законен.
    .filter((file) => !file.endsWith('hooks/useListDrag.ts') && !file.endsWith('hooks/useListReorder.ts'))
    .map((file) => ({ file: file.slice(UI_ROOT.length).replace(/\\/g, '/'), text: readFileSync(file, 'utf8') }))
    .filter(({ text }) => text.includes('useListDrag') || text.includes('useListReorder'));

  it('страницы на ките есть — список не сдулся', () => {
    // ПП + карточки (наряд, договор, сотрудник, табель, склад, снабжение,
    // инструмент и редакторы). Если это число упало — скорее всего, кто-то
    // увёл страницу с кита, и починка перестала её чинить.
    expect(pages.length).toBeGreaterThanOrEqual(5);
  });

  it('ни одна страница не заводит своё состояние перетаскивания', () => {
    const offenders = pages
      .filter(({ text }) => text.includes('drag.drag') || text.includes("addEventListener('drop'"))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('источник перетаскивания на всех страницах идёт из dataTransfer', () => {
    // ПП читает `event.dataTransfer.getData('text/plain')`, карточки —
    // `drag.sourceKeyOf(event)`. Оба пути переживают погашенное состояние кита.
    const pp = pages.find(({ file }) => file.endsWith('ProductionProgramPage.tsx'));
    expect(pp?.text).toContain("event.dataTransfer.getData('text/plain')");
    expect(REORDER).toContain('drag.sourceKeyOf(event)');
  });
});
