/**
 * Operator-drawn UI mockups (эскизник модулей, docs/plans/ui-mockup-constructor.md).
 *
 * A screen is a JSON spec: a free canvas of mock blocks (button / input /
 * table / panel / ... placeholders) plus typed links between them. Blocks are
 * NOT functional — each carries a label and a free-text note ("what this
 * element should do / contain"). The mockup is a visual spec the owner and
 * Claude read to build the real module.
 *
 * Storage is unchanged from the v1 pilot: EAV entity type `ui_screen`
 * (attr `spec_json`), factory-wide sync, access enforced in UI + IPC only
 * (screen belongs to one AccessSection, view needs viewer+, edit needs
 * editor). Specs carry no executable behavior by design.
 *
 * Legacy v1 specs (working blocks with intents/widgets) are upgraded to v2
 * mock blocks on parse; there is no downgrade path.
 */

export const MOCK_BLOCK_KINDS = [
  'heading',
  'text',
  'button',
  'input',
  'select',
  'checkbox',
  'date',
  'table',
  'list',
  'panel',
  'tabs',
  'image',
  'note',
] as const;
export type MockBlockKind = (typeof MOCK_BLOCK_KINDS)[number];

export const MOCK_BLOCK_LABELS_RU: Record<MockBlockKind, string> = {
  heading: 'Заголовок',
  text: 'Текст',
  button: 'Кнопка',
  input: 'Поле ввода',
  select: 'Выпадающий список',
  checkbox: 'Галочка',
  date: 'Дата',
  table: 'Таблица',
  list: 'Список',
  panel: 'Панель / раздел',
  tabs: 'Вкладки',
  image: 'Картинка / схема',
  note: 'Заметка',
};

export const MOCK_LINK_KINDS = ['navigate', 'data', 'filter', 'other'] as const;
export type MockLinkKind = (typeof MOCK_LINK_KINDS)[number];

export const MOCK_LINK_LABELS_RU: Record<MockLinkKind, string> = {
  navigate: 'Переход',
  data: 'Данные',
  filter: 'Фильтр',
  other: 'Прочее',
};

export type MockBlock = {
  id: string;
  kind: MockBlockKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Подпись на самом элементе (текст кнопки, заголовок панели, …). */
  label?: string;
  /** «Что должен делать / что содержит» — свободный текст оператора. */
  note?: string;
  /** Колонки таблицы / названия вкладок / пункты списка. */
  items?: string[];
};

export type MockLink = {
  id: string;
  fromId: string;
  toId: string;
  kind: MockLinkKind;
  label?: string;
};

export type UiSpecV2 = {
  version: 2;
  canvas: { w: number; h: number };
  blocks: MockBlock[];
  links: MockLink[];
};

export const UI_SPEC_MAX_BLOCKS = 120;
export const UI_SPEC_MAX_LINKS = 200;
export const UI_CANVAS_DEFAULT = { w: 1280, h: 800 } as const;
export const UI_CANVAS_MIN = 320;
export const UI_CANVAS_MAX = 8000;
export const MOCK_LABEL_MAX = 300;
export const MOCK_NOTE_MAX = 2000;
export const MOCK_ITEMS_MAX = 30;
export const MOCK_BLOCK_MIN_SIZE = 24;

/** Default size when a block is dropped from the palette. */
export const MOCK_BLOCK_DEFAULT_SIZES: Record<MockBlockKind, { w: number; h: number }> = {
  heading: { w: 360, h: 44 },
  text: { w: 360, h: 80 },
  button: { w: 160, h: 40 },
  input: { w: 240, h: 40 },
  select: { w: 240, h: 40 },
  checkbox: { w: 200, h: 32 },
  date: { w: 180, h: 40 },
  table: { w: 480, h: 200 },
  list: { w: 320, h: 200 },
  panel: { w: 520, h: 280 },
  tabs: { w: 480, h: 44 },
  image: { w: 280, h: 180 },
  note: { w: 220, h: 120 },
};

export const EMPTY_UI_SPEC: UiSpecV2 = {
  version: 2,
  canvas: { ...UI_CANVAS_DEFAULT },
  blocks: [],
  links: [],
};

function clampNum(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function sanitizeItems(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const items = raw
    .map((it) => String(it ?? '').slice(0, MOCK_LABEL_MAX).trim())
    .filter((s) => s.length > 0)
    .slice(0, MOCK_ITEMS_MAX);
  return items.length > 0 ? items : null;
}

function sanitizeMockBlock(raw: unknown, index: number): MockBlock | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const kind = String(obj.kind ?? '');
  if (!(MOCK_BLOCK_KINDS as readonly string[]).includes(kind)) return null;
  const id = String(obj.id ?? '').trim() || `b${index}`;
  const def = MOCK_BLOCK_DEFAULT_SIZES[kind as MockBlockKind];
  const label = String(obj.label ?? '').slice(0, MOCK_LABEL_MAX);
  const note = String(obj.note ?? '').slice(0, MOCK_NOTE_MAX);
  const items = sanitizeItems(obj.items);
  return {
    id,
    kind: kind as MockBlockKind,
    x: clampNum(obj.x, 0, UI_CANVAS_MAX, 0),
    y: clampNum(obj.y, 0, UI_CANVAS_MAX, 0),
    w: clampNum(obj.w, MOCK_BLOCK_MIN_SIZE, UI_CANVAS_MAX, def.w),
    h: clampNum(obj.h, MOCK_BLOCK_MIN_SIZE, UI_CANVAS_MAX, def.h),
    ...(label.trim() ? { label } : {}),
    ...(note.trim() ? { note } : {}),
    ...(items ? { items } : {}),
  };
}

function sanitizeMockLink(raw: unknown, index: number, blockIds: ReadonlySet<string>): MockLink | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const kind = String(obj.kind ?? '');
  if (!(MOCK_LINK_KINDS as readonly string[]).includes(kind)) return null;
  const fromId = String(obj.fromId ?? '').trim();
  const toId = String(obj.toId ?? '').trim();
  if (!fromId || !toId || fromId === toId) return null;
  if (!blockIds.has(fromId) || !blockIds.has(toId)) return null;
  const id = String(obj.id ?? '').trim() || `l${index}`;
  const label = String(obj.label ?? '').slice(0, MOCK_LABEL_MAX).trim();
  return { id, fromId, toId, kind: kind as MockLinkKind, ...(label ? { label } : {}) };
}

/** Legacy v1 pilot blocks (working screens) → mock blocks stacked in a column. */
function upgradeV1Blocks(rawBlocks: unknown[]): MockBlock[] {
  const GAP = 16;
  const X = 40;
  let y = 40;
  const blocks: MockBlock[] = [];
  for (let i = 0; i < rawBlocks.length && blocks.length < UI_SPEC_MAX_BLOCKS; i += 1) {
    const raw = rawBlocks[i];
    if (!raw || typeof raw !== 'object') continue;
    const obj = raw as Record<string, unknown>;
    const id = String(obj.id ?? '').trim() || `b${i}`;
    const kindRaw = String(obj.kind ?? '');
    let block: MockBlock | null = null;
    if (kindRaw === 'heading' || kindRaw === 'text') {
      const text = String(obj.text ?? '').slice(0, MOCK_NOTE_MAX);
      const def = MOCK_BLOCK_DEFAULT_SIZES[kindRaw];
      block = { id, kind: kindRaw, x: X, y, w: def.w, h: def.h, ...(text.trim() ? { label: text } : {}) };
    } else if (kindRaw === 'button') {
      const label = String(obj.label ?? '').slice(0, MOCK_LABEL_MAX).trim() || 'Кнопка';
      const intent = obj.intent as Record<string, unknown> | undefined;
      const tabId = intent && intent.type === 'navigate_tab' ? String(intent.tabId ?? '').trim() : '';
      const def = MOCK_BLOCK_DEFAULT_SIZES.button;
      block = {
        id,
        kind: 'button',
        x: X,
        y,
        w: def.w,
        h: def.h,
        label,
        note: tabId ? `Переход на вкладку «${tabId}» (из старой версии экрана)` : 'Открытие отчёта (из старой версии экрана)',
      };
    } else if (kindRaw === 'list') {
      const widget = String(obj.widget ?? '');
      const def = MOCK_BLOCK_DEFAULT_SIZES.list;
      block = {
        id,
        kind: 'list',
        x: X,
        y,
        w: def.w,
        h: def.h,
        label: widget === 'my_work_orders' ? 'Наряды' : 'Последние двигатели',
        note: 'Рабочий список из старой версии экрана',
      };
    }
    if (!block) continue;
    y += block.h + GAP;
    blocks.push(block);
  }
  return blocks;
}

/**
 * Tolerant parse of a stored spec: object, JSON string, or DOUBLE-encoded JSON
 * string (setEntityAttribute JSON.stringify's the already serialized spec —
 * same gotcha as parseSectionMembership). Unknown block/link kinds are
 * dropped, never fatal; v1 pilot specs are upgraded to v2 mock blocks.
 * Returns null only when nothing spec-shaped is found.
 */
export function sanitizeUiSpec(raw: unknown): UiSpecV2 | null {
  let obj: unknown = raw;
  for (let depth = 0; typeof obj === 'string' && depth < 2; depth += 1) {
    try {
      obj = JSON.parse(obj);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  const rawBlocks = rec.blocks;
  if (!Array.isArray(rawBlocks)) return null;

  if (rec.version !== 2) {
    const blocks = upgradeV1Blocks(rawBlocks);
    const maxY = blocks.reduce((m, b) => Math.max(m, b.y + b.h), 0);
    return {
      version: 2,
      canvas: { w: UI_CANVAS_DEFAULT.w, h: Math.max(UI_CANVAS_DEFAULT.h, maxY + 40) },
      blocks,
      links: [],
    };
  }

  const canvasRaw = (rec.canvas ?? {}) as Record<string, unknown>;
  const canvas = {
    w: clampNum(canvasRaw.w, UI_CANVAS_MIN, UI_CANVAS_MAX, UI_CANVAS_DEFAULT.w),
    h: clampNum(canvasRaw.h, UI_CANVAS_MIN, UI_CANVAS_MAX, UI_CANVAS_DEFAULT.h),
  };
  const blocks: MockBlock[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < rawBlocks.length && blocks.length < UI_SPEC_MAX_BLOCKS; i += 1) {
    const block = sanitizeMockBlock(rawBlocks[i], i);
    if (!block) continue;
    let id = block.id;
    while (seenIds.has(id)) id = `${id}_`;
    seenIds.add(id);
    blocks.push(id === block.id ? block : { ...block, id });
  }
  const links: MockLink[] = [];
  const rawLinks = Array.isArray(rec.links) ? rec.links : [];
  const seenLinkIds = new Set<string>();
  for (let i = 0; i < rawLinks.length && links.length < UI_SPEC_MAX_LINKS; i += 1) {
    const link = sanitizeMockLink(rawLinks[i], i, seenIds);
    if (!link) continue;
    let id = link.id;
    while (seenLinkIds.has(id)) id = `${id}_`;
    seenLinkIds.add(id);
    links.push(id === link.id ? link : { ...link, id });
  }
  return { version: 2, canvas, blocks, links };
}

export function serializeUiSpec(spec: UiSpecV2): string {
  return JSON.stringify(spec);
}

export const MOCKUP_STARTER_TEMPLATE_IDS = ['form', 'list_card', 'report'] as const;
export type MockupStarterTemplateId = (typeof MOCKUP_STARTER_TEMPLATE_IDS)[number];

export const MOCKUP_STARTER_TEMPLATE_LABELS_RU: Record<MockupStarterTemplateId, string> = {
  form: 'Форма ввода',
  list_card: 'Список + карточка',
  report: 'Отчёт с фильтрами',
};

/**
 * Starter block sets («заготовки»): a recognizable skeleton the operator
 * reshapes instead of starting from an empty canvas. Blocks get fresh ids
 * from `newId`; links reference those ids.
 */
export function buildStarterTemplate(
  template: MockupStarterTemplateId,
  newId: () => string,
): { blocks: MockBlock[]; links: MockLink[] } {
  const b = (block: Omit<MockBlock, 'id'>): MockBlock => ({ id: newId(), ...block });
  if (template === 'form') {
    const save = b({ kind: 'button', x: 40, y: 330, w: 160, h: 40, label: 'Сохранить' });
    return {
      blocks: [
        b({ kind: 'heading', x: 40, y: 30, w: 420, h: 44, label: 'Новая запись' }),
        b({ kind: 'input', x: 40, y: 100, w: 300, h: 40, label: 'Название…' }),
        b({ kind: 'select', x: 40, y: 156, w: 300, h: 40, label: 'Выберите из списка…' }),
        b({ kind: 'date', x: 40, y: 212, w: 180, h: 40 }),
        b({ kind: 'checkbox', x: 40, y: 268, w: 240, h: 32, label: 'Признак' }),
        save,
        b({ kind: 'button', x: 216, y: 330, w: 120, h: 40, label: 'Отмена' }),
        b({ kind: 'note', x: 400, y: 100, w: 220, h: 140, label: 'Опишите здесь, что сохраняет форма и куда попадает запись' }),
      ],
      links: [],
    };
  }
  if (template === 'list_card') {
    const table = b({ kind: 'table', x: 40, y: 100, w: 460, h: 320, label: 'Список', items: ['Название', 'Статус', 'Дата'] });
    const panel = b({ kind: 'panel', x: 540, y: 100, w: 420, h: 320, label: 'Карточка выбранной строки' });
    return {
      blocks: [
        b({ kind: 'heading', x: 40, y: 30, w: 420, h: 44, label: 'Раздел' }),
        b({ kind: 'input', x: 40, y: 56, w: 260, h: 34, label: 'Поиск…' }),
        table,
        panel,
        b({ kind: 'text', x: 560, y: 150, w: 380, h: 60, label: 'Поля карточки' }),
        b({ kind: 'button', x: 560, y: 350, w: 160, h: 40, label: 'Сохранить' }),
      ],
      links: [{ id: newId(), fromId: table.id, toId: panel.id, kind: 'data', label: 'выбранная строка' }],
    };
  }
  const filterBtn = b({ kind: 'button', x: 560, y: 90, w: 140, h: 40, label: 'Сформировать' });
  const table = b({ kind: 'table', x: 40, y: 160, w: 720, h: 300, label: 'Результат', items: ['Колонка 1', 'Колонка 2', 'Итого'] });
  return {
    blocks: [
      b({ kind: 'heading', x: 40, y: 30, w: 420, h: 44, label: 'Отчёт' }),
      b({ kind: 'date', x: 40, y: 90, w: 160, h: 40, label: 'с даты' }),
      b({ kind: 'date', x: 216, y: 90, w: 160, h: 40, label: 'по дату' }),
      b({ kind: 'select', x: 392, y: 90, w: 150, h: 40, label: 'Фильтр…' }),
      filterBtn,
      table,
      b({ kind: 'note', x: 780, y: 160, w: 200, h: 140, label: 'Что считает отчёт, какие итоги нужны' }),
    ],
    links: [{ id: newId(), fromId: filterBtn.id, toId: table.id, kind: 'filter', label: 'формирует' }],
  };
}

/** Reading order for annotations/export: top-to-bottom, then left-to-right. */
export function orderBlocksForReading(blocks: readonly MockBlock[]): MockBlock[] {
  return [...blocks].sort((a, b) => (a.y - b.y !== 0 ? a.y - b.y : a.x - b.x));
}

/**
 * Text spec for the developer: numbered blocks (reading order) with geometry,
 * labels, notes and typed links. The operator/owner hands this text to the
 * developer (or Claude) as the module's TZ.
 */
export function describeUiSpecForDeveloper(spec: UiSpecV2, screenName?: string): string {
  const ordered = orderBlocksForReading(spec.blocks);
  const numById = new Map<string, number>();
  ordered.forEach((b, i) => numById.set(b.id, i + 1));
  const lines: string[] = [];
  lines.push(`Эскиз экрана${screenName ? ` «${screenName}»` : ''} (холст ${spec.canvas.w}×${spec.canvas.h}).`);
  lines.push('');
  lines.push(`Элементы (${ordered.length}):`);
  for (const b of ordered) {
    const head = `${numById.get(b.id)}. [${MOCK_BLOCK_LABELS_RU[b.kind]}] ${b.label?.trim() || '(без подписи)'} — позиция (${b.x}, ${b.y}), размер ${b.w}×${b.h}`;
    lines.push(head);
    if (b.items && b.items.length > 0) {
      const what = b.kind === 'table' ? 'Колонки' : b.kind === 'tabs' ? 'Вкладки' : 'Пункты';
      lines.push(`   ${what}: ${b.items.join(', ')}`);
    }
    if (b.note?.trim()) lines.push(`   Назначение: ${b.note.trim()}`);
  }
  if (spec.links.length > 0) {
    lines.push('');
    lines.push(`Связи (${spec.links.length}):`);
    for (const l of spec.links) {
      const from = numById.get(l.fromId);
      const to = numById.get(l.toId);
      if (from == null || to == null) continue;
      lines.push(`- №${from} → №${to}: ${MOCK_LINK_LABELS_RU[l.kind]}${l.label ? ` — ${l.label}` : ''}`);
    }
  }
  return lines.join('\n');
}
