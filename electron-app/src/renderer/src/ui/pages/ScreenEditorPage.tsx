import React, { useEffect, useRef, useState } from 'react';
import {
  ACCESS_SECTION_CATALOG,
  EMPTY_UI_SPEC,
  MOCK_BLOCK_DEFAULT_SIZES,
  MOCK_BLOCK_KINDS,
  MOCK_BLOCK_LABELS_RU,
  MOCK_LINK_KINDS,
  MOCK_LINK_LABELS_RU,
  MOCKUP_STARTER_TEMPLATE_IDS,
  MOCKUP_STARTER_TEMPLATE_LABELS_RU,
  UI_SPEC_MAX_BLOCKS,
  UI_SPEC_MAX_LINKS,
  buildStarterTemplate,
  describeUiSpecForDeveloper,
  sanitizeUiSpec,
  serializeUiSpec,
  type MockBlock,
  type MockBlockKind,
  type MockLink,
  type MockLinkKind,
  type MockupStarterTemplateId,
  type UiSpecV2,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { theme } from '../theme.js';
import { MockupCanvas, MOCK_LINK_STYLES, type MockupSelection } from '../uiBuilder/MockupCanvas.js';

export type ScreenEditorTabOption = { id: string; label: string };

let seq = 0;
function newId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}`;
}

const ITEMS_HINT: Partial<Record<MockBlockKind, string>> = {
  table: 'Колонки таблицы (по одной на строку)',
  tabs: 'Названия вкладок (по одному на строку)',
  list: 'Пункты списка (по одному на строку, можно оставить пустым)',
};

const fieldLabel = (text: string) => (
  <div style={{ fontSize: 12, color: theme.colors.muted, marginTop: 8 }}>{text}</div>
);

const textareaStyle: React.CSSProperties = {
  width: '100%',
  fontSize: 13,
  padding: 6,
  borderRadius: 6,
  border: `1px solid ${theme.colors.border}`,
  background: 'transparent',
  color: theme.colors.text,
  resize: 'vertical',
  boxSizing: 'border-box',
};

const selectStyle: React.CSSProperties = {
  width: '100%',
  fontSize: 13,
  padding: 6,
  borderRadius: 6,
  border: `1px solid ${theme.colors.border}`,
  background: 'var(--panel, transparent)',
  color: theme.colors.text,
};

function BlockProperties(props: {
  block: MockBlock;
  onChange: (next: MockBlock) => void;
  onRemove: () => void;
  onDuplicate: () => void;
}) {
  const { block, onChange } = props;
  const itemsHint = ITEMS_HINT[block.kind];
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600 }}>Элемент: {MOCK_BLOCK_LABELS_RU[block.kind]}</div>
      {fieldLabel('Подпись (текст на элементе)')}
      <Input
        value={block.label ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          const { label: _label, ...rest } = block;
          onChange(v ? { ...rest, label: v } : rest);
        }}
      />
      {itemsHint ? (
        <>
          {fieldLabel(itemsHint)}
          <textarea
            value={(block.items ?? []).join('\n')}
            onChange={(e) => {
              const items = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean);
              const { items: _items, ...rest } = block;
              onChange(items.length > 0 ? { ...rest, items } : rest);
            }}
            rows={4}
            style={textareaStyle}
          />
        </>
      ) : null}
      {fieldLabel('Что должен делать / что содержит (описание для разработчика)')}
      <textarea
        value={block.note ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          const { note: _note, ...rest } = block;
          onChange(v ? { ...rest, note: v } : rest);
        }}
        rows={5}
        style={textareaStyle}
        placeholder="Например: по нажатию открывается список двигателей в ремонте, отсортированный по дате…"
      />
      <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
        {(['x', 'y', 'w', 'h'] as const).map((k) => (
          <label key={k} style={{ fontSize: 11, color: theme.colors.muted, display: 'flex', flexDirection: 'column', gap: 2, width: 64 }}>
            {k === 'x' ? 'X' : k === 'y' ? 'Y' : k === 'w' ? 'Ширина' : 'Высота'}
            <Input
              type="number"
              value={block[k]}
              onChange={(e) => onChange({ ...block, [k]: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
            />
          </label>
        ))}
      </div>
      <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
        <Button size="sm" variant="ghost" onClick={props.onDuplicate} title="Ctrl+D">
          Дублировать
        </Button>
        <Button size="sm" variant="ghost" tone="danger" onClick={props.onRemove} title="Delete">
          Удалить элемент
        </Button>
      </div>
    </div>
  );
}

function LinkProperties(props: {
  link: MockLink;
  blocks: readonly MockBlock[];
  onChange: (next: MockLink) => void;
  onRemove: () => void;
}) {
  const { link, onChange } = props;
  const name = (id: string) => {
    const b = props.blocks.find((x) => x.id === id);
    return b ? `${MOCK_BLOCK_LABELS_RU[b.kind]}${b.label ? ` «${b.label}»` : ''}` : '?';
  };
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600 }}>Связь</div>
      <div style={{ fontSize: 12, color: theme.colors.muted, marginTop: 4 }}>
        {name(link.fromId)} → {name(link.toId)}
      </div>
      {fieldLabel('Тип связи')}
      <select value={link.kind} onChange={(e) => onChange({ ...link, kind: e.target.value as MockLinkKind })} style={selectStyle}>
        {MOCK_LINK_KINDS.map((k) => (
          <option key={k} value={k}>
            {MOCK_LINK_LABELS_RU[k]}
          </option>
        ))}
      </select>
      {fieldLabel('Подпись на нити (что за связь)')}
      <Input
        value={link.label ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          const { label: _label, ...rest } = link;
          onChange(v ? { ...rest, label: v } : rest);
        }}
      />
      <div style={{ marginTop: 10 }}>
        <Button size="sm" variant="ghost" tone="danger" onClick={props.onRemove}>
          Удалить связь
        </Button>
      </div>
    </div>
  );
}

/**
 * Эскизник модулей: свободный холст mock-блоков + типизированные связи-нити.
 * Ничего не исполняет — это визуальное ТЗ оператора для владельца/разработчика.
 * Сохранение — uiScreens:save (main проверяет editor-уровень в выбранном разделе).
 */
export function ScreenEditorPage(props: {
  screenId: string | null;
  /** Оставлено для совместимости вызова из App; эскизнику не нужно. */
  tabOptions?: ScreenEditorTabOption[];
  onSaved?: (id: string) => void;
  onDeleted?: () => void;
}) {
  const [screenDbId, setScreenDbId] = useState<string | null>(props.screenId);
  const [name, setName] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [spec, setSpec] = useState<UiSpecV2>(() => ({ ...EMPTY_UI_SPEC, canvas: { ...EMPTY_UI_SPEC.canvas }, blocks: [], links: [] }));
  const [selection, setSelection] = useState<MockupSelection>(null);
  const [linkMode, setLinkMode] = useState(false);
  const [linkFromId, setLinkFromId] = useState<string | null>(null);
  const [showAnnotations, setShowAnnotations] = useState(false);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [canEdit, setCanEdit] = useState(true);
  const [editorSections, setEditorSections] = useState<Array<{ id: string; titleRu: string }>>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const GRID = 8;
  const HISTORY_MAX = 60;
  const historyRef = useRef<{ past: UiSpecV2[]; future: UiSpecV2[] }>({ past: [], future: [] });

  const notify = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3500);
  };

  /** All structural edits go through here — every mutation is one undo step. */
  function mutateSpec(fn: (prev: UiSpecV2) => UiSpecV2) {
    setSpec((prev) => {
      const h = historyRef.current;
      h.past.push(prev);
      if (h.past.length > HISTORY_MAX) h.past.shift();
      h.future = [];
      return fn(prev);
    });
  }

  /** Snapshot without changing the spec (start of a drag gesture). */
  function snapshotForDrag() {
    setSpec((prev) => {
      const h = historyRef.current;
      h.past.push(prev);
      if (h.past.length > HISTORY_MAX) h.past.shift();
      h.future = [];
      return prev;
    });
  }

  function undo() {
    setSpec((prev) => {
      const h = historyRef.current;
      const past = h.past.pop();
      if (!past) return prev;
      h.future.push(prev);
      return past;
    });
  }

  function redo() {
    setSpec((prev) => {
      const h = historyRef.current;
      const next = h.future.pop();
      if (!next) return prev;
      h.past.push(prev);
      return next;
    });
  }

  // Разделы, куда автор может сохранять (editor-уровень; superadmin/легаси — все).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [membership, status] = await Promise.all([
          window.matrica.access.sectionsSelf(),
          window.matrica.auth.status(),
        ]);
        if (!alive) return;
        const role = String(status?.user?.role ?? '').toLowerCase();
        const regular = ACCESS_SECTION_CATALOG.filter((s) => !s.restrictedAssign).map((s) => ({
          id: s.id,
          titleRu: s.titleRu,
        }));
        if (role === 'superadmin' || membership == null) {
          setEditorSections(regular);
        } else {
          setEditorSections(regular.filter((s) => membership[s.id] === 'editor'));
        }
      } catch {
        if (alive) setEditorSections([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Загрузка существующего экрана (v1 конвертируется в v2 внутри sanitizeUiSpec).
  useEffect(() => {
    let alive = true;
    if (!props.screenId) return undefined;
    (async () => {
      const res = await window.matrica.uiScreens.get(props.screenId as string);
      if (!alive) return;
      if (!res.ok) {
        notify(res.error);
        return;
      }
      setScreenDbId(res.screen.id);
      setName(res.screen.name);
      setSectionId(res.screen.sectionId);
      setCanEdit(res.screen.canEdit);
      const parsed = sanitizeUiSpec(res.screen.specJson);
      if (parsed) setSpec(parsed);
    })();
    return () => {
      alive = false;
    };
  }, [props.screenId]);

  const selectedBlock = selection?.type === 'block' ? spec.blocks.find((b) => b.id === selection.id) ?? null : null;
  const selectedLink = selection?.type === 'link' ? spec.links.find((l) => l.id === selection.id) ?? null : null;

  function addBlock(kind: MockBlockKind) {
    if (spec.blocks.length >= UI_SPEC_MAX_BLOCKS) {
      notify(`Не больше ${UI_SPEC_MAX_BLOCKS} элементов на эскизе`);
      return;
    }
    const def = MOCK_BLOCK_DEFAULT_SIZES[kind];
    const n = spec.blocks.length;
    const block: MockBlock = {
      id: newId('blk'),
      kind,
      x: 40 + (n % 8) * 28,
      y: 40 + (n % 8) * 28,
      w: def.w,
      h: def.h,
    };
    mutateSpec((prev) => ({ ...prev, blocks: [...prev.blocks, block] }));
    setSelection({ type: 'block', id: block.id });
  }

  function insertStarterTemplate(template: MockupStarterTemplateId) {
    const made = buildStarterTemplate(template, () => newId('blk'));
    if (spec.blocks.length + made.blocks.length > UI_SPEC_MAX_BLOCKS) {
      notify(`Не больше ${UI_SPEC_MAX_BLOCKS} элементов на эскизе`);
      return;
    }
    // Drop below existing content so the starter never buries current work.
    const baseY = spec.blocks.reduce((m, b) => Math.max(m, b.y + b.h), 0);
    const dy = baseY > 0 ? baseY + 40 - 30 : 0;
    const shifted = made.blocks.map((b) => ({ ...b, y: b.y + dy }));
    mutateSpec((prev) => ({
      ...prev,
      canvas: { w: prev.canvas.w, h: Math.max(prev.canvas.h, shifted.reduce((m, b) => Math.max(m, b.y + b.h), 0) + 40) },
      blocks: [...prev.blocks, ...shifted],
      links: [...prev.links, ...made.links],
    }));
    setSelection(null);
  }

  function updateBlock(next: MockBlock) {
    mutateSpec((prev) => ({ ...prev, blocks: prev.blocks.map((b) => (b.id === next.id ? next : b)) }));
  }

  function duplicateBlock(id: string) {
    const src = spec.blocks.find((b) => b.id === id);
    if (!src) return;
    if (spec.blocks.length >= UI_SPEC_MAX_BLOCKS) {
      notify(`Не больше ${UI_SPEC_MAX_BLOCKS} элементов на эскизе`);
      return;
    }
    const copy: MockBlock = { ...src, id: newId('blk'), x: src.x + 24, y: src.y + 24 };
    mutateSpec((prev) => ({ ...prev, blocks: [...prev.blocks, copy] }));
    setSelection({ type: 'block', id: copy.id });
  }

  function nudgeBlock(id: string, dx: number, dy: number) {
    mutateSpec((prev) => ({
      ...prev,
      blocks: prev.blocks.map((b) =>
        b.id === id ? { ...b, x: Math.max(0, b.x + dx), y: Math.max(0, b.y + dy) } : b,
      ),
    }));
  }

  function patchBlockGeometry(id: string, patch: { x?: number; y?: number; w?: number; h?: number }) {
    const snapped = snapToGrid
      ? Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, Math.round((v as number) / GRID) * GRID]))
      : patch;
    // continuous during drag — history snapshot is taken once at gesture start
    setSpec((prev) => ({
      ...prev,
      blocks: prev.blocks.map((b) => (b.id === id ? { ...b, ...snapped } : b)),
    }));
  }

  function removeBlock(id: string) {
    mutateSpec((prev) => ({
      ...prev,
      blocks: prev.blocks.filter((b) => b.id !== id),
      links: prev.links.filter((l) => l.fromId !== id && l.toId !== id),
    }));
    setSelection(null);
  }

  function updateLink(next: MockLink) {
    mutateSpec((prev) => ({ ...prev, links: prev.links.map((l) => (l.id === next.id ? next : l)) }));
  }

  function removeLink(id: string) {
    mutateSpec((prev) => ({ ...prev, links: prev.links.filter((l) => l.id !== id) }));
    setSelection(null);
  }

  // Keyboard: undo/redo, delete, duplicate, arrow nudge. Skipped while typing in fields.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if (!selection) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (selection.type === 'block') removeBlock(selection.id);
        else removeLink(selection.id);
        return;
      }
      if (selection.type !== 'block') return;
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicateBlock(selection.id);
        return;
      }
      const stepPx = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') { e.preventDefault(); nudgeBlock(selection.id, -stepPx, 0); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); nudgeBlock(selection.id, stepPx, 0); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); nudgeBlock(selection.id, 0, -stepPx); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); nudgeBlock(selection.id, 0, stepPx); }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selection, spec.blocks.length, snapToGrid]);

  function onLinkClick(blockId: string) {
    if (!linkFromId) {
      setLinkFromId(blockId);
      return;
    }
    if (linkFromId === blockId) {
      setLinkFromId(null);
      return;
    }
    if (spec.links.length >= UI_SPEC_MAX_LINKS) {
      notify(`Не больше ${UI_SPEC_MAX_LINKS} связей на эскизе`);
      return;
    }
    const link: MockLink = { id: newId('lnk'), fromId: linkFromId, toId: blockId, kind: 'navigate' };
    mutateSpec((prev) => ({ ...prev, links: [...prev.links, link] }));
    setLinkFromId(null);
    setLinkMode(false);
    setSelection({ type: 'link', id: link.id });
  }

  async function copyDeveloperSpec() {
    const text = describeUiSpecForDeveloper(spec, name.trim() || undefined);
    try {
      await navigator.clipboard.writeText(text);
      notify('Описание для разработчика скопировано в буфер');
    } catch {
      notify('Не удалось скопировать в буфер');
    }
  }

  async function save() {
    if (busy) return;
    if (!name.trim()) {
      notify('Укажите название эскиза');
      return;
    }
    if (!sectionId) {
      notify('Выберите раздел доступа');
      return;
    }
    setBusy(true);
    try {
      // Autogrow canvas so nothing saved ends up outside the sheet.
      const maxX = spec.blocks.reduce((m, b) => Math.max(m, b.x + b.w), 0);
      const maxY = spec.blocks.reduce((m, b) => Math.max(m, b.y + b.h), 0);
      const grown: UiSpecV2 = {
        ...spec,
        canvas: { w: Math.max(spec.canvas.w, maxX + 40), h: Math.max(spec.canvas.h, maxY + 40) },
      };
      const res = await window.matrica.uiScreens.save({
        ...(screenDbId ? { id: screenDbId } : {}),
        name: name.trim(),
        sectionId,
        specJson: serializeUiSpec(grown),
      });
      if (!res.ok) {
        notify(res.error);
        return;
      }
      setSpec(grown);
      setScreenDbId(res.id);
      notify('Эскиз сохранён');
      props.onSaved?.(res.id);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!screenDbId || busy) return;
    setBusy(true);
    try {
      const res = await window.matrica.uiScreens.delete(screenDbId);
      if (!res.ok) {
        notify(res.error);
        return;
      }
      notify('Эскиз удалён');
      props.onDeleted?.();
    } finally {
      setBusy(false);
    }
  }

  const noSections = editorSections.length === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Input placeholder="Название эскиза" value={name} onChange={(e) => setName(e.target.value)} style={{ minWidth: 220 }} />
        <select value={sectionId} onChange={(e) => setSectionId(e.target.value)} style={{ ...selectStyle, width: 'auto' }}>
          <option value="">— раздел доступа —</option>
          {editorSections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.titleRu}
            </option>
          ))}
        </select>
        <Button onClick={() => void save()} disabled={busy || !canEdit || noSections}>
          Сохранить эскиз
        </Button>
        <Button
          size="sm"
          variant={linkMode ? 'primary' : 'ghost'}
          onClick={() => {
            setLinkMode((v) => !v);
            setLinkFromId(null);
          }}
          title="Кликните первый элемент, затем второй — появится нить"
        >
          🔗 Связать
        </Button>
        <Button size="sm" variant={showAnnotations ? 'primary' : 'ghost'} onClick={() => setShowAnnotations((v) => !v)}>
          № Сноски
        </Button>
        <Button size="sm" variant="ghost" onClick={undo} title="Ctrl+Z">
          ↩ Отменить
        </Button>
        <Button size="sm" variant="ghost" onClick={redo} title="Ctrl+Shift+Z / Ctrl+Y">
          ↪ Вернуть
        </Button>
        <Button
          size="sm"
          variant={snapToGrid ? 'primary' : 'ghost'}
          onClick={() => setSnapToGrid((v) => !v)}
          title="Прилипание к сетке 8px при перетаскивании"
        >
          ⌗ Сетка
        </Button>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <Button size="sm" variant="ghost" onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.25) * 100) / 100))}>
            −
          </Button>
          <span style={{ fontSize: 12, color: theme.colors.muted, minWidth: 38, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
          <Button size="sm" variant="ghost" onClick={() => setZoom((z) => Math.min(1.5, Math.round((z + 0.25) * 100) / 100))}>
            +
          </Button>
        </span>
        <select
          value=""
          onChange={(e) => {
            const v = e.target.value as MockupStarterTemplateId | '';
            if (v) insertStarterTemplate(v);
          }}
          style={{ ...selectStyle, width: 'auto' }}
          title="Готовый скелет эскиза — добавится на холст, дальше лепите под себя"
        >
          <option value="">+ Заготовка…</option>
          {MOCKUP_STARTER_TEMPLATE_IDS.map((tid) => (
            <option key={tid} value={tid}>
              {MOCKUP_STARTER_TEMPLATE_LABELS_RU[tid]}
            </option>
          ))}
        </select>
        <Button size="sm" variant="ghost" onClick={() => void copyDeveloperSpec()}>
          📋 Описание для разработчика
        </Button>
        {screenDbId ? (
          <Button variant="ghost" tone="danger" onClick={() => void remove()} disabled={busy || !canEdit}>
            Удалить эскиз
          </Button>
        ) : null}
        {toast ? <span style={{ fontSize: 13, color: theme.colors.muted }}>{toast}</span> : null}
      </div>
      {linkMode ? (
        <div style={{ fontSize: 13, color: theme.colors.muted }}>
          {linkFromId ? 'Теперь кликните второй элемент — к нему пойдёт нить.' : 'Кликните первый элемент (откуда идёт связь).'}
        </div>
      ) : null}
      {noSections ? (
        <div style={{ fontSize: 13, color: theme.colors.muted }}>
          Для сохранения эскизов нужен уровень «редактор» хотя бы в одном разделе — обратитесь к администратору.
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
        <div style={{ flex: '0 0 280px', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, overflow: 'auto' }}>
          <div style={{ fontSize: 12, color: theme.colors.muted }}>Палитра — кликните, элемент появится на холсте:</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {MOCK_BLOCK_KINDS.map((kind) => (
              <Button key={kind} size="sm" variant="ghost" onClick={() => addBlock(kind)}>
                + {MOCK_BLOCK_LABELS_RU[kind]}
              </Button>
            ))}
          </div>
          <div style={{ fontSize: 12, color: theme.colors.muted, marginTop: 4 }}>
            Типы связей:{' '}
            {MOCK_LINK_KINDS.map((k) => (
              <span key={k} style={{ color: MOCK_LINK_STYLES[k].stroke, marginRight: 8, whiteSpace: 'nowrap' }}>
                ━ {MOCK_LINK_LABELS_RU[k]}
              </span>
            ))}
          </div>
          {selectedBlock ? (
            <div style={{ borderTop: `1px solid ${theme.colors.border}`, paddingTop: 8 }}>
              <BlockProperties
                block={selectedBlock}
                onChange={updateBlock}
                onRemove={() => removeBlock(selectedBlock.id)}
                onDuplicate={() => duplicateBlock(selectedBlock.id)}
              />
            </div>
          ) : selectedLink ? (
            <div style={{ borderTop: `1px solid ${theme.colors.border}`, paddingTop: 8 }}>
              <LinkProperties link={selectedLink} blocks={spec.blocks} onChange={updateLink} onRemove={() => removeLink(selectedLink.id)} />
            </div>
          ) : (
            <div style={{ fontSize: 12, color: theme.colors.muted, borderTop: `1px solid ${theme.colors.border}`, paddingTop: 8 }}>
              Кликните элемент или нить на холсте — здесь появятся его свойства. Элементы можно таскать мышкой и растягивать за
              правый нижний угол. У каждого элемента заполняйте «что должен делать» — это главное в эскизе.
            </div>
          )}
        </div>
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0, minWidth: 0 }}>
          <MockupCanvas
            spec={spec}
            mode="edit"
            selection={selection}
            showAnnotations={showAnnotations}
            linkMode={linkMode}
            linkFromId={linkFromId}
            scale={zoom}
            onSelect={setSelection}
            onLinkClick={onLinkClick}
            onDragStart={snapshotForDrag}
            onBlockGeometry={patchBlockGeometry}
          />
        </div>
      </div>
    </div>
  );
}

export default ScreenEditorPage;
