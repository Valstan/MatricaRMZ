import React, { useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ACCESS_SECTION_CATALOG,
  UI_LIST_WIDGET_IDS,
  UI_LIST_WIDGET_LABELS_RU,
  sanitizeUiSpec,
  serializeUiSpec,
  type UiBlock,
  type UiSpecV1,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { theme } from '../theme.js';
import { SpecRenderer } from '../uiBuilder/SpecRenderer.js';
import { createPreviewIntentRuntime } from '../uiBuilder/intentRuntime.js';

export type ScreenEditorTabOption = { id: string; label: string };

const BLOCK_KIND_LABELS: Record<UiBlock['kind'], string> = {
  heading: 'Заголовок',
  text: 'Текст',
  button: 'Кнопка-переход',
  list: 'Список',
};

let blockSeq = 0;
function newBlockId(): string {
  blockSeq += 1;
  return `blk_${Date.now().toString(36)}_${blockSeq}`;
}

function makeBlock(kind: UiBlock['kind'], firstTabId: string): UiBlock {
  const id = newBlockId();
  switch (kind) {
    case 'heading':
      return { id, kind, text: 'Заголовок' };
    case 'text':
      return { id, kind, text: '' };
    case 'button':
      return { id, kind, label: 'Перейти', intent: { type: 'navigate_tab', tabId: firstTabId } };
    case 'list':
      return { id, kind, widget: 'recent_engines', limit: 10 };
  }
}

function SortableBlockRow(props: {
  block: UiBlock;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.block.id });
  const b = props.block;
  const summary =
    b.kind === 'heading' || b.kind === 'text'
      ? b.text.slice(0, 60) || '(пусто)'
      : b.kind === 'button'
        ? b.label
        : UI_LIST_WIDGET_LABELS_RU[b.widget];
  return (
    <div
      ref={setNodeRef}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        border: `1px solid ${props.selected ? theme.colors.borderStrong : theme.colors.border}`,
        borderRadius: 6,
        background: props.selected ? 'var(--panel-2, rgba(125,125,125,0.08))' : 'transparent',
        opacity: isDragging ? 0.6 : 1,
        transform: CSS.Transform.toString(transform),
        transition: transition ?? undefined,
        cursor: 'pointer',
      }}
      onClick={props.onSelect}
    >
      <span {...attributes} {...listeners} style={{ cursor: 'grab', color: theme.colors.muted }} title="Перетащить">
        ⋮⋮
      </span>
      <span style={{ fontSize: 12, color: theme.colors.muted, minWidth: 96 }}>{BLOCK_KIND_LABELS[b.kind]}</span>
      <span style={{ fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span>
      <Button
        size="sm"
        variant="ghost"
        onClick={(e) => {
          e.stopPropagation();
          props.onRemove();
        }}
        title="Удалить блок"
      >
        ✕
      </Button>
    </div>
  );
}

function BlockProperties(props: {
  block: UiBlock;
  tabOptions: ScreenEditorTabOption[];
  onChange: (next: UiBlock) => void;
}) {
  const { block, onChange } = props;
  const label = (text: string) => <div style={{ fontSize: 12, color: theme.colors.muted, marginTop: 8 }}>{text}</div>;
  if (block.kind === 'heading' || block.kind === 'text') {
    return (
      <div>
        {label(block.kind === 'heading' ? 'Текст заголовка' : 'Текст')}
        <textarea
          value={block.text}
          onChange={(e) => onChange({ ...block, text: e.target.value })}
          rows={block.kind === 'heading' ? 2 : 4}
          style={{
            width: '100%',
            fontSize: 13,
            padding: 6,
            borderRadius: 6,
            border: `1px solid ${theme.colors.border}`,
            background: 'transparent',
            color: theme.colors.text,
            resize: 'vertical',
          }}
        />
      </div>
    );
  }
  if (block.kind === 'button') {
    return (
      <div>
        {label('Надпись на кнопке')}
        <Input value={block.label} onChange={(e) => onChange({ ...block, label: e.target.value })} />
        {label('Куда ведёт')}
        <select
          value={block.intent.type === 'navigate_tab' ? block.intent.tabId : 'reports'}
          onChange={(e) => onChange({ ...block, intent: { type: 'navigate_tab', tabId: e.target.value } })}
          style={{
            width: '100%',
            fontSize: 13,
            padding: 6,
            borderRadius: 6,
            border: `1px solid ${theme.colors.border}`,
            background: 'var(--panel, transparent)',
            color: theme.colors.text,
          }}
        >
          {props.tabOptions.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
    );
  }
  return (
    <div>
      {label('Какой список показать')}
      <select
        value={block.widget}
        onChange={(e) => onChange({ ...block, widget: e.target.value as (typeof UI_LIST_WIDGET_IDS)[number] })}
        style={{
          width: '100%',
          fontSize: 13,
          padding: 6,
          borderRadius: 6,
          border: `1px solid ${theme.colors.border}`,
          background: 'var(--panel, transparent)',
          color: theme.colors.text,
        }}
      >
        {UI_LIST_WIDGET_IDS.map((w) => (
          <option key={w} value={w}>
            {UI_LIST_WIDGET_LABELS_RU[w]}
          </option>
        ))}
      </select>
      {label('Сколько строк (1–50)')}
      <Input
        type="number"
        min={1}
        max={50}
        value={block.limit ?? 10}
        onChange={(e) => {
          const n = Math.max(1, Math.min(50, Math.floor(Number(e.target.value) || 10)));
          onChange({ ...block, limit: n });
        }}
      />
    </div>
  );
}

/**
 * Конструктор экранов (пилот): вертикальный список блоков, dnd-kit сортировка,
 * живой превью через тот же SpecRenderer. Сохранение — uiScreens:save (main
 * проверяет editor-уровень в выбранном разделе).
 */
export function ScreenEditorPage(props: {
  screenId: string | null;
  tabOptions: ScreenEditorTabOption[];
  onSaved?: (id: string) => void;
  onDeleted?: () => void;
}) {
  const [screenDbId, setScreenDbId] = useState<string | null>(props.screenId);
  const [name, setName] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [blocks, setBlocks] = useState<UiBlock[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(true);
  const [editorSections, setEditorSections] = useState<Array<{ id: string; titleRu: string }>>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const notify = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3500);
  };
  const previewRuntime = useMemo(() => createPreviewIntentRuntime(notify), []);
  const spec: UiSpecV1 = useMemo(() => ({ version: 1, blocks }), [blocks]);

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

  // Загрузка существующего экрана.
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
      setBlocks(sanitizeUiSpec(res.screen.specJson)?.blocks ?? []);
    })();
    return () => {
      alive = false;
    };
  }, [props.screenId]);

  const selected = blocks.find((b) => b.id === selectedId) ?? null;

  function addBlock(kind: UiBlock['kind']) {
    const firstTab = props.tabOptions[0]?.id ?? 'reports';
    const block = makeBlock(kind, firstTab);
    setBlocks((prev) => [...prev, block]);
    setSelectedId(block.id);
  }

  function updateBlock(next: UiBlock) {
    setBlocks((prev) => prev.map((b) => (b.id === next.id ? next : b)));
  }

  function removeBlock(id: string) {
    setBlocks((prev) => prev.filter((b) => b.id !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setBlocks((prev) => {
      const from = prev.findIndex((b) => b.id === active.id);
      const to = prev.findIndex((b) => b.id === over.id);
      if (from < 0 || to < 0) return prev;
      const next = [...prev];
      const moved = next.splice(from, 1)[0];
      if (!moved) return prev;
      next.splice(to, 0, moved);
      return next;
    });
  }

  async function save() {
    if (busy) return;
    if (!name.trim()) {
      notify('Укажите название экрана');
      return;
    }
    if (!sectionId) {
      notify('Выберите раздел доступа');
      return;
    }
    setBusy(true);
    try {
      const res = await window.matrica.uiScreens.save({
        ...(screenDbId ? { id: screenDbId } : {}),
        name: name.trim(),
        sectionId,
        specJson: serializeUiSpec(spec),
      });
      if (!res.ok) {
        notify(res.error);
        return;
      }
      setScreenDbId(res.id);
      notify('Экран сохранён');
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
      notify('Экран удалён');
      props.onDeleted?.();
    } finally {
      setBusy(false);
    }
  }

  const noSections = editorSections.length === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Input
          placeholder="Название экрана"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ minWidth: 220 }}
        />
        <select
          value={sectionId}
          onChange={(e) => setSectionId(e.target.value)}
          style={{
            fontSize: 13,
            padding: 6,
            borderRadius: 6,
            border: `1px solid ${theme.colors.border}`,
            background: 'var(--panel, transparent)',
            color: theme.colors.text,
          }}
        >
          <option value="">— раздел доступа —</option>
          {editorSections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.titleRu}
            </option>
          ))}
        </select>
        <Button onClick={() => void save()} disabled={busy || !canEdit || noSections}>
          Сохранить экран
        </Button>
        {screenDbId ? (
          <Button variant="ghost" tone="danger" onClick={() => void remove()} disabled={busy || !canEdit}>
            Удалить экран
          </Button>
        ) : null}
        {toast ? <span style={{ fontSize: 13, color: theme.colors.muted }}>{toast}</span> : null}
      </div>
      {noSections ? (
        <div style={{ fontSize: 13, color: theme.colors.muted }}>
          Для сохранения экранов нужен уровень «редактор» хотя бы в одном разделе — обратитесь к администратору.
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
        <div style={{ flex: '0 0 380px', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(Object.keys(BLOCK_KIND_LABELS) as Array<UiBlock['kind']>).map((kind) => (
              <Button key={kind} size="sm" variant="ghost" onClick={() => addBlock(kind)}>
                + {BLOCK_KIND_LABELS[kind]}
              </Button>
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflow: 'auto', minHeight: 0 }}>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
                {blocks.map((b) => (
                  <SortableBlockRow
                    key={b.id}
                    block={b}
                    selected={b.id === selectedId}
                    onSelect={() => setSelectedId(b.id)}
                    onRemove={() => removeBlock(b.id)}
                  />
                ))}
              </SortableContext>
            </DndContext>
            {blocks.length === 0 ? (
              <div style={{ fontSize: 13, color: theme.colors.muted, padding: 8 }}>
                Добавьте блоки кнопками выше — они появятся в этом списке и в предпросмотре справа.
              </div>
            ) : null}
          </div>
          {selected ? (
            <div style={{ borderTop: `1px solid ${theme.colors.border}`, paddingTop: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Свойства: {BLOCK_KIND_LABELS[selected.kind]}</div>
              <BlockProperties block={selected} tabOptions={props.tabOptions} onChange={updateBlock} />
            </div>
          ) : null}
        </div>
        <div
          style={{
            flex: 1,
            border: `1px dashed ${theme.colors.border}`,
            borderRadius: 8,
            padding: 12,
            overflow: 'auto',
            minHeight: 0,
          }}
        >
          <div style={{ fontSize: 12, color: theme.colors.muted, marginBottom: 8 }}>Предпросмотр</div>
          <SpecRenderer spec={spec} runtime={previewRuntime} />
        </div>
      </div>
    </div>
  );
}

export default ScreenEditorPage;
