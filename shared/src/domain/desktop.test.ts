import { describe, expect, it } from 'vitest';

import {
  DESKTOP_MAX_SHORTCUTS,
  DESKTOP_USAGE_MAX_DAYS,
  createEmptyDesktop,
  desktopAddFolder,
  desktopAddShortcut,
  desktopDeleteFolder,
  desktopEmptyTrash,
  desktopFolderShortcuts,
  desktopLiveShortcutCount,
  desktopMigrateQuickStart,
  desktopMoveToFolder,
  desktopMoveToTrash,
  desktopPutShortcut,
  desktopRenameShortcut,
  desktopRestoreFromTrash,
  desktopShortcutLinkKey,
  desktopSurfaceShortcuts,
  desktopToggleShortcut,
  desktopTrashShortcuts,
  sanitizeDesktopSection,
  sanitizeDesktopUsageSection,
} from './desktop.js';

const NOW = 1_755_600_000_000;

function seeded() {
  let d = createEmptyDesktop();
  d = desktopAddShortcut(d, { id: 's1', label: 'Двигатели', icon: '⚙️', link: { kind: 'app_link', tab: 'engines' } }, NOW);
  d = desktopAddShortcut(d, { id: 's2', label: 'Наряды', icon: '🛠️', link: { kind: 'app_link', tab: 'work_orders' } }, NOW);
  d = desktopAddFolder(d, { id: 'f1', name: 'Склад' }, NOW);
  return d;
}

describe('desktop domain', () => {
  it('в корзину и обратно: ярлык не стирается, возврат кладёт на стол', () => {
    let d = seeded();
    d = desktopMoveToTrash(d, 's1', NOW + 1);
    expect(desktopSurfaceShortcuts(d).map((s) => s.id)).toEqual(['s2']);
    expect(desktopTrashShortcuts(d).map((s) => s.id)).toEqual(['s1']);
    d = desktopRestoreFromTrash(d, 's1');
    expect(desktopSurfaceShortcuts(d).map((s) => s.id).sort()).toEqual(['s1', 's2']);
    expect(desktopTrashShortcuts(d)).toEqual([]);
  });

  it('очистка корзины удаляет окончательно и не трогает живые', () => {
    let d = seeded();
    d = desktopMoveToTrash(d, 's2', NOW + 1);
    d = desktopEmptyTrash(d);
    expect(d.shortcuts.map((s) => s.id)).toEqual(['s1']);
  });

  it('папка: укладка ярлыка, возврат на стол, удаление папки уводит содержимое в корзину', () => {
    let d = seeded();
    d = desktopMoveToFolder(d, 's1', 'f1');
    expect(desktopFolderShortcuts(d, 'f1').map((s) => s.id)).toEqual(['s1']);
    expect(desktopSurfaceShortcuts(d).map((s) => s.id)).toEqual(['s2']);
    d = desktopMoveToFolder(d, 's1', null);
    expect(desktopSurfaceShortcuts(d).map((s) => s.id).sort()).toEqual(['s1', 's2']);
    d = desktopMoveToFolder(d, 's2', 'f1');
    d = desktopDeleteFolder(d, 'f1', NOW + 2);
    expect(d.folders).toEqual([]);
    expect(desktopTrashShortcuts(d).map((s) => s.id)).toEqual(['s2']);
  });

  it('ярлык с осиротевшим folderId рендерится на столе, а не исчезает', () => {
    const d = sanitizeDesktopSection({
      shortcuts: [{ id: 's1', label: 'X', icon: '🔗', folderId: 'ghost', deletedAt: null, createdAt: NOW }],
      folders: [],
      layout: {},
    })!;
    expect(desktopSurfaceShortcuts(d).map((s) => s.id)).toEqual(['s1']);
  });

  it('sanitize: терпимость к мусору, дефолты раскладки, дедуп id, лимиты процентов', () => {
    expect(sanitizeDesktopSection(null)).toBeUndefined();
    expect(sanitizeDesktopSection([])).toBeUndefined();
    const d = sanitizeDesktopSection({
      shortcuts: [
        { id: 's1', label: 'A', icon: '⚙️', link: { kind: 'app_link', tab: 'unknown_future_tab' }, createdAt: NOW },
        { id: 's1', label: 'дубль', icon: '⚙️' },
        { id: '', label: 'без id' },
        'мусор',
      ],
      folders: [{ id: 'f1', name: 'Папка', createdAt: NOW }, { id: 'f1', name: 'дубль' }],
      layout: { chatPct: 5, peoplePct: 200 },
    })!;
    expect(d.shortcuts).toHaveLength(1);
    // Неизвестный tab в link хранится как есть — id-чурн релизов не стирает ярлык.
    expect((d.shortcuts[0]!.link as { tab?: string }).tab).toBe('unknown_future_tab');
    expect(d.folders).toHaveLength(1);
    expect(d.layout.chatPct).toBe(10);
    expect(d.layout.peoplePct).toBe(85);
  });

  it('sanitize: слишком большой link отбрасывается, ярлык остаётся', () => {
    const d = sanitizeDesktopSection({
      shortcuts: [{ id: 's1', label: 'A', icon: '⚙️', link: { blob: 'x'.repeat(5000) }, createdAt: NOW }],
    })!;
    expect(d.shortcuts).toHaveLength(1);
    expect(d.shortcuts[0]!.link).toBeUndefined();
  });
});

// «Прививка» релиза 1 (план «рабочий стол и человеко-понятные названия»): санитайзер
// обязан знать поля РАНЬШЕ, чем появится код, который их пишет. sanitizeUserUiProfile
// зовётся и на чтении, и на записи, а LWW заменяет секцию целиком — клиент, не знающий
// поля, стёр бы его у всех машин пользователя при первом же сохранении.
describe('прививка: поля рабочего стола переживают санитайзер', () => {
  it('координата плитки сохраняется и приводится к целым ячейкам', () => {
    const d = sanitizeDesktopSection({
      shortcuts: [{ id: 's1', label: 'A', createdAt: NOW, pos: { col: 3.7, row: 0 } }],
    })!;
    expect(d.shortcuts[0]!.pos).toEqual({ col: 3, row: 0 });
  });

  it('битая или заоблачная координата отбрасывается, ярлык остаётся', () => {
    const d = sanitizeDesktopSection({
      shortcuts: [
        { id: 's1', label: 'A', createdAt: NOW, pos: { col: -1, row: 0 } },
        { id: 's2', label: 'B', createdAt: NOW, pos: { col: 5000, row: 0 } },
        { id: 's3', label: 'C', createdAt: NOW, pos: 'нет' },
      ],
    })!;
    expect(d.shortcuts).toHaveLength(3);
    for (const shortcut of d.shortcuts) expect(shortcut.pos).toBeUndefined();
  });

  it('отметка переезда «Быстрого запуска» сохраняется, ноль и мусор — нет', () => {
    expect(sanitizeDesktopSection({ shortcutsMigratedAt: NOW })!.shortcutsMigratedAt).toBe(NOW);
    expect(sanitizeDesktopSection({ shortcutsMigratedAt: 0 })!.shortcutsMigratedAt).toBeUndefined();
    expect(sanitizeDesktopSection({ shortcutsMigratedAt: 'вчера' })!.shortcutsMigratedAt).toBeUndefined();
  });

  it('секция счётчика использования переживает круг чтение-запись', () => {
    const usage = sanitizeDesktopUsageSection({
      buckets: { s1: { '2026-08-20': 3, '2026-08-21': 1 } },
      foldedAt: NOW,
    })!;
    expect(usage.buckets.s1).toEqual({ '2026-08-20': 3, '2026-08-21': 1 });
    expect(usage.foldedAt).toBe(NOW);
  });

  it('счётчик чистится: чужие ключи дней, нули и дроби не проходят', () => {
    const usage = sanitizeDesktopUsageSection({
      buckets: { s1: { '2026-08-20': 2.9, вчера: 5, '2026-08-21': 0, '2026-08-22': -3 } },
    })!;
    expect(usage.buckets.s1).toEqual({ '2026-08-20': 2 });
    expect(usage.foldedAt).toBe(0);
  });

  it('окно счётчика — последние 30 дней, старое отсекается', () => {
    const days: Record<string, number> = {};
    for (let i = 1; i <= 40; i++) days[`2026-08-${String(i).padStart(2, '0')}`] = 1;
    const usage = sanitizeDesktopUsageSection({ buckets: { s1: days } })!;
    expect(Object.keys(usage.buckets.s1!)).toHaveLength(DESKTOP_USAGE_MAX_DAYS);
    expect(usage.buckets.s1!['2026-08-01']).toBeUndefined();
    expect(usage.buckets.s1!['2026-08-40']).toBe(1);
  });

  it('секции нет в PATCH — не трогаем (undefined, а не пустой объект)', () => {
    expect(sanitizeDesktopUsageSection(undefined)).toBeUndefined();
    expect(sanitizeDesktopUsageSection([])).toBeUndefined();
  });
});

// Этап B (кнопка-галстук): один ярлык на одну ссылку, тумблер называет исход,
// лимит считает живые, файловый ярлык этапа D не сливается с соседями по вкладке.
describe('ключ ссылки ярлыка', () => {
  it('карточка: специальное поле и универсальная пара cardKind/entityId дают один ключ', () => {
    const byField = desktopShortcutLinkKey({ kind: 'app_link', tab: 'engine', engineId: 'e-1' });
    const byGeneric = desktopShortcutLinkKey({ kind: 'app_link', tab: 'engine', cardKind: 'engine', entityId: 'e-1' });
    expect(byField).toBe('engine:e-1');
    expect(byGeneric).toBe(byField);
  });

  it('раздел без сущности — ключ по вкладке; пустой и мусорный link — без ключа', () => {
    expect(desktopShortcutLinkKey({ kind: 'app_link', tab: 'work_orders' })).toBe('tab:work_orders');
    expect(desktopShortcutLinkKey({ kind: 'app_link', tab: '' })).toBeNull();
    expect(desktopShortcutLinkKey(undefined)).toBeNull();
    expect(desktopShortcutLinkKey('engine:e-1')).toBeNull();
  });

  it('файловый ярлык (этап D) различается по fileId, а не по вкладке', () => {
    const a = desktopShortcutLinkKey({ kind: 'file', fileId: 'f-1', name: 'акт.pdf' });
    const b = desktopShortcutLinkKey({ kind: 'file', fileId: 'f-2', name: 'акт.pdf' });
    expect(a).toBe('file:f-1');
    expect(b).toBe('file:f-2');
    expect(desktopShortcutLinkKey({ kind: 'file', name: 'без id' })).toBeNull();
  });
});

describe('тумблер ярлыка', () => {
  const engine = { kind: 'app_link', tab: 'engine', engineId: 'e-1' };

  it('нет ярлыка — кладёт и говорит added; есть — убирает в корзину и говорит removed', () => {
    let d = createEmptyDesktop();
    const first = desktopToggleShortcut(d, { id: 'n1', label: 'ЯМЗ-238 № 41/26', icon: '⚙️', link: engine }, NOW);
    expect(first.outcome).toBe('added');
    d = first.desktop;
    expect(desktopSurfaceShortcuts(d).map((s) => s.id)).toEqual(['n1']);

    const second = desktopToggleShortcut(d, { id: 'n2', label: 'ЯМЗ-238 № 41/26', icon: '⚙️', link: engine }, NOW + 1);
    expect(second.outcome).toBe('removed');
    expect(desktopSurfaceShortcuts(second.desktop)).toEqual([]);
    expect(desktopTrashShortcuts(second.desktop).map((s) => s.id)).toEqual(['n1']);
  });

  it('ярлык той же ссылки лежит в корзине — возвращается он сам, а не плодится новый', () => {
    let d = createEmptyDesktop();
    d = desktopToggleShortcut(d, { id: 'n1', label: 'A', icon: '⚙️', link: engine }, NOW).desktop;
    d = desktopMoveToTrash(d, 'n1', NOW + 1);
    const r = desktopToggleShortcut(d, { id: 'n2', label: 'A', icon: '⚙️', link: engine }, NOW + 2);
    expect(r.outcome).toBe('added');
    expect(desktopSurfaceShortcuts(r.desktop).map((s) => s.id)).toEqual(['n1']);
    expect(r.desktop.shortcuts).toHaveLength(1);
  });

  it('ярлык в папке — тоже «есть»: тумблер уводит его в корзину', () => {
    let d = createEmptyDesktop();
    d = desktopAddFolder(d, { id: 'f1', name: 'Моё' }, NOW);
    d = desktopToggleShortcut(d, { id: 'n1', label: 'A', icon: '⚙️', link: engine }, NOW).desktop;
    d = desktopMoveToFolder(d, 'n1', 'f1');
    const r = desktopToggleShortcut(d, { id: 'n2', label: 'A', icon: '⚙️', link: engine }, NOW + 1);
    expect(r.outcome).toBe('removed');
    expect(desktopTrashShortcuts(r.desktop).map((s) => s.id)).toEqual(['n1']);
  });

  it('лимит считает живые ярлыки: корзина места не занимает, упор в лимит называется limit', () => {
    let d = createEmptyDesktop();
    for (let i = 0; i < DESKTOP_MAX_SHORTCUTS; i++) {
      d = desktopAddShortcut(d, { id: `s${i}`, label: `A${i}`, icon: '🔗', link: { kind: 'app_link', tab: 'engine', engineId: `e${i}` } }, NOW);
    }
    expect(desktopLiveShortcutCount(d)).toBe(DESKTOP_MAX_SHORTCUTS);
    const extra = { id: 'x', label: 'X', icon: '🔗', link: { kind: 'app_link', tab: 'engine', engineId: 'ex' } };
    const full = desktopToggleShortcut(d, extra, NOW);
    expect(full.outcome).toBe('limit');
    expect(full.desktop).toBe(d);

    d = desktopMoveToTrash(d, 's0', NOW + 1);
    expect(desktopLiveShortcutCount(d)).toBe(DESKTOP_MAX_SHORTCUTS - 1);
    expect(desktopToggleShortcut(d, extra, NOW + 2).outcome).toBe('added');
    expect(desktopAddShortcut(d, { id: 'y', label: 'Y', icon: '🔗' }, NOW).shortcuts).toHaveLength(DESKTOP_MAX_SHORTCUTS + 1);
  });

  it('ссылка без ключа (нечего дедупить) — просто кладётся', () => {
    const r = desktopToggleShortcut(createEmptyDesktop(), { id: 'n1', label: 'A', icon: '🔗' }, NOW);
    expect(r.outcome).toBe('added');
  });
});

describe('«Добавить на Рабочий стол» из меню кнопок — не тумблер', () => {
  const link = { kind: 'app_link', tab: 'engines' };

  it('кладёт один раз: второй раз — exists, ничего не снимает; из корзины возвращает свой', () => {
    let d = createEmptyDesktop();
    const first = desktopPutShortcut(d, { id: 'n1', label: 'Двигатели', icon: '⚙️', link }, NOW);
    expect(first.outcome).toBe('added');
    d = first.desktop;
    const second = desktopPutShortcut(d, { id: 'n2', label: 'Двигатели', icon: '⚙️', link }, NOW + 1);
    expect(second.outcome).toBe('exists');
    expect(second.desktop).toBe(d);
    d = desktopMoveToTrash(d, 'n1', NOW + 2);
    const third = desktopPutShortcut(d, { id: 'n3', label: 'Двигатели', icon: '⚙️', link }, NOW + 3);
    expect(third.outcome).toBe('added');
    expect(third.desktop.shortcuts.map((s) => s.id)).toEqual(['n1']);
  });
});

describe('переименование ярлыка', () => {
  it('подпись меняется, пустая и слишком длинная — режется', () => {
    let d = seeded();
    d = desktopRenameShortcut(d, 's1', '  Мои двигатели  ');
    expect(d.shortcuts.find((s) => s.id === 's1')!.label).toBe('Мои двигатели');
    expect(desktopRenameShortcut(d, 's1', '   ')).toBe(d);
    expect(desktopRenameShortcut(d, 's1', 'x'.repeat(500)).shortcuts.find((s) => s.id === 's1')!.label).toHaveLength(160);
  });
});

describe('переезд «Быстрого запуска» в ярлыки', () => {
  const items = [
    { label: 'Табель', icon: '🗓️', link: { kind: 'app_link', tab: 'timesheets' } },
    { label: 'ЯМЗ-238 № 41/26', icon: '⚙️', link: { kind: 'app_link', tab: 'engine', cardKind: 'engine', entityId: 'e-1' } },
  ];

  it('кладёт ярлыки с детерминированными id и ставит отметку', () => {
    const d = desktopMigrateQuickStart(createEmptyDesktop(), items, NOW);
    expect(d.shortcutsMigratedAt).toBe(NOW);
    expect(desktopSurfaceShortcuts(d).map((s) => s.label)).toEqual(['Табель', 'ЯМЗ-238 № 41/26']);
    const again = desktopMigrateQuickStart(createEmptyDesktop(), items, NOW + 5);
    expect(again.shortcuts.map((s) => s.id)).toEqual(d.shortcuts.map((s) => s.id));
  });

  it('идемпотентен: отметка стоит — второй прогон ничего не меняет, даже если ярлык с тех пор удалили', () => {
    let d = desktopMigrateQuickStart(createEmptyDesktop(), items, NOW);
    d = desktopEmptyTrash(desktopMoveToTrash(d, d.shortcuts[0]!.id, NOW + 1));
    const again = desktopMigrateQuickStart(d, items, NOW + 2);
    expect(again).toBe(d);
  });

  it('не дублирует ссылку, которая уже лежит на столе, и не перетирает совпавший id', () => {
    let d = createEmptyDesktop();
    d = desktopAddShortcut(d, { id: 'mine', label: 'Мой табель', icon: '🗓️', link: { kind: 'app_link', tab: 'timesheets' } }, NOW);
    const migrated = desktopMigrateQuickStart(d, items, NOW + 1);
    expect(migrated.shortcuts.map((s) => s.label)).toEqual(['Мой табель', 'ЯМЗ-238 № 41/26']);

    const occupiedId = migrated.shortcuts[1]!.id;
    let e = createEmptyDesktop();
    e = desktopAddShortcut(e, { id: occupiedId, label: 'Чужой ярлык с тем же id', icon: '🔗', link: { kind: 'app_link', tab: 'reports' } }, NOW);
    const m2 = desktopMigrateQuickStart(e, items, NOW + 1);
    expect(m2.shortcuts.find((s) => s.id === occupiedId)!.label).toBe('Чужой ярлык с тем же id');
    expect(m2.shortcuts.map((s) => s.label)).toContain('Табель');
    expect(m2.shortcuts.map((s) => s.label)).not.toContain('ЯМЗ-238 № 41/26');
  });

  it('пустой «Быстрый запуск» — только отметка, чтобы не повторять переезд', () => {
    const d = desktopMigrateQuickStart(createEmptyDesktop(), [], NOW);
    expect(d.shortcuts).toEqual([]);
    expect(d.shortcutsMigratedAt).toBe(NOW);
  });
});
