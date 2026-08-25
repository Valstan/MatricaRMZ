import { describe, expect, it } from 'vitest';

import {
  DESKTOP_CELL_H,
  DESKTOP_CELL_W,
  DESKTOP_MAX_SHORTCUTS,
  DESKTOP_USAGE_MAX_DAYS,
  createEmptyDesktop,
  createEmptyDesktopUsage,
  desktopAddFolder,
  desktopAddShortcut,
  desktopDeleteFolder,
  desktopEmptyTrash,
  desktopFileFromLink,
  desktopFileIcon,
  desktopFileLink,
  desktopFolderShortcuts,
  desktopLayoutGrid,
  desktopLiveFileShortcuts,
  desktopLiveShortcutCount,
  desktopMigrateQuickStart,
  desktopMoveToFolder,
  desktopMoveToFolderMany,
  desktopMoveToTrash,
  desktopMoveToTrashMany,
  desktopPutShortcut,
  desktopRenameShortcut,
  desktopRestoreFromTrash,
  desktopSetPositions,
  desktopShortcutLinkKey,
  desktopSurfaceShortcuts,
  desktopTileMetrics,
  desktopToggleShortcut,
  desktopTrashShortcuts,
  desktopUsageAdd,
  desktopUsageBump,
  desktopUsageDay,
  desktopUsageKeepOnly,
  desktopUsageScore,
  desktopUsageSteps,
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

describe('файловый ярлык', () => {
  it('ссылка собирается и разбирается кругом', () => {
    const link = desktopFileLink({ id: 'f-1', name: 'Акт.pdf', mime: 'application/pdf' });
    expect(link).toEqual({ kind: 'file', fileId: 'f-1', name: 'Акт.pdf', mime: 'application/pdf' });
    expect(desktopFileFromLink(link)).toEqual({ fileId: 'f-1', name: 'Акт.pdf', mime: 'application/pdf' });
  });

  it('mime необязателен и не превращается в undefined-поле', () => {
    const link = desktopFileLink({ id: 'f-2', name: 'x.txt', mime: null });
    expect('mime' in link).toBe(false);
    expect(desktopFileFromLink(link)?.mime).toBeNull();
  });

  it('файловая ссылка переживает санитайзер целиком — иначе ярлык потеряет файл', () => {
    const link = desktopFileLink({ id: 'f-3', name: 'Чертёж.dwg' });
    const raw = {
      shortcuts: [{ id: 's1', label: 'Чертёж.dwg', icon: '📐', folderId: null, deletedAt: null, createdAt: NOW, link }],
      folders: [],
      layout: {},
    };
    expect(sanitizeDesktopSection(raw)?.shortcuts[0]?.link).toEqual(link);
  });

  it('не файл — не разбирается', () => {
    expect(desktopFileFromLink({ kind: 'app_link', tab: 'engines' })).toBeNull();
    expect(desktopFileFromLink({ kind: 'file' })).toBeNull();
    expect(desktopFileFromLink({ kind: 'file', fileId: '  ' })).toBeNull();
    expect(desktopFileFromLink(null)).toBeNull();
  });

  it('два ярлыка на один файл — один ключ дедупа, на разные файлы — разные', () => {
    const a = desktopFileLink({ id: 'f-1', name: 'Акт.pdf' });
    const b = desktopFileLink({ id: 'f-1', name: 'Акт (копия).pdf' });
    expect(desktopShortcutLinkKey(a)).toBe(desktopShortcutLinkKey(b));
    expect(desktopShortcutLinkKey(desktopFileLink({ id: 'f-2', name: 'Акт.pdf' }))).not.toBe(desktopShortcutLinkKey(a));
  });

  it('карточке видны живые файлы и со стола, и из папок, но не из корзины', () => {
    let d = createEmptyDesktop();
    d = desktopAddFolder(d, { id: 'f1', name: 'Ящик' }, NOW);
    d = desktopAddShortcut(d, { id: 'a', label: 'Акт.pdf', icon: '📕', link: desktopFileLink({ id: 'file-a', name: 'Акт.pdf' }) }, NOW);
    d = desktopAddShortcut(d, { id: 'b', label: 'В папке.xlsx', icon: '📗', link: desktopFileLink({ id: 'file-b', name: 'В папке.xlsx' }) }, NOW);
    d = desktopAddShortcut(d, { id: 'c', label: 'Удалённый.txt', icon: '📄', link: desktopFileLink({ id: 'file-c', name: 'Удалённый.txt' }) }, NOW);
    d = desktopAddShortcut(d, { id: 'tab', label: 'Двигатели', icon: '⚙️', link: { kind: 'app_link', tab: 'engines' } }, NOW);
    d = desktopMoveToFolder(d, 'b', 'f1');
    d = desktopMoveToTrash(d, 'c', NOW + 1);

    const files = desktopLiveFileShortcuts(d);
    expect(files.map((f) => f.fileId)).toEqual(['file-a', 'file-b']);
    expect(files[0]).toEqual({ shortcutId: 'a', fileId: 'file-a', name: 'Акт.pdf', mime: null, label: 'Акт.pdf' });
  });

  it('переименованный ярлык отдаёт и подпись со стола, и настоящее имя файла', () => {
    let d = desktopAddShortcut(createEmptyDesktop(), { id: 'a', label: 'Акт.pdf', icon: '📕', link: desktopFileLink({ id: 'file-a', name: 'Акт.pdf' }) }, NOW);
    d = desktopRenameShortcut(d, 'a', 'Акт по 41-му');
    const [file] = desktopLiveFileShortcuts(d);
    expect(file?.label).toBe('Акт по 41-му');
    expect(file?.name).toBe('Акт.pdf');
  });

  it('значок узнаёт документ по расширению, незнакомое — скрепка', () => {
    expect(desktopFileIcon('Акт.pdf')).toBe('📕');
    expect(desktopFileIcon('ВЕДОМОСТЬ.XLSX')).toBe('📗');
    expect(desktopFileIcon('фото.jpeg')).toBe('🖼️');
    expect(desktopFileIcon('вал.cdw')).toBe('📐');
    expect(desktopFileIcon('файл.неведомо')).toBe('📎');
    expect(desktopFileIcon('без-расширения')).toBe('📎');
    expect(desktopFileIcon('.gitignore')).toBe('📎');
  });
});

describe('метрики плитки', () => {
  it('шаг 0 повторяет сегодняшний вид — эти числа менять нельзя', () => {
    expect(desktopTileMetrics(0)).toEqual({
      step: 0,
      width: 92,
      icon: 30,
      iconLine: 34,
      label: 11,
      labelLine: 13,
      height: 80,
      cells: 1,
    });
  });

  it('крупные шаги занимают две ячейки, мелкие — одну; вертикаль не растягивается', () => {
    expect([-1, 0, 1].map((s) => desktopTileMetrics(s).cells)).toEqual([1, 1, 1]);
    expect([2, 3, 4].map((s) => desktopTileMetrics(s).cells)).toEqual([2, 2, 2]);
    for (const s of [-1, 0, 1, 2, 3, 4]) expect(desktopTileMetrics(s).height).toBeLessThanOrEqual(DESKTOP_CELL_H);
  });

  it('ширина плитки помещается в свои ячейки на каждом шаге', () => {
    for (const s of [-1, 0, 1, 2, 3, 4]) {
      const m = desktopTileMetrics(s);
      expect(m.width, `шаг ${s} не влезает в ${m.cells} ячеек`).toBeLessThanOrEqual(DESKTOP_CELL_W * m.cells);
    }
  });

  it('шаг растёт монотонно — больший счёт не должен давать плитку меньше', () => {
    const widths = [-1, 0, 1, 2, 3, 4].map((s) => desktopTileMetrics(s).width);
    expect(widths).toEqual([...widths].sort((a, b) => a - b));
  });

  it('значение вне диапазона зажимается, мусор читается как ноль', () => {
    expect(desktopTileMetrics(-9).step).toBe(-1);
    expect(desktopTileMetrics(99).step).toBe(4);
    expect(desktopTileMetrics(Number.NaN).step).toBe(0);
  });
});

describe('раскладка сетки', () => {
  const one = (id: string, pos?: { col: number; row: number }) => ({ id, cells: 1 as const, ...(pos ? { pos } : {}) });

  it('без координат — поток слева направо, папки первыми', () => {
    const g = desktopLayoutGrid({ folderIds: ['f1'], shortcuts: [one('a'), one('b')], cols: 3 });
    expect(g.folders).toEqual([{ id: 'f1', col: 0, row: 0, cells: 1 }]);
    expect(g.shortcuts).toEqual([
      { id: 'a', col: 1, row: 0, cells: 1 },
      { id: 'b', col: 2, row: 0, cells: 1 },
    ]);
    expect(g.rows).toBe(1);
  });

  it('координата уважается, свободные места достаются остальным', () => {
    const g = desktopLayoutGrid({ folderIds: [], shortcuts: [one('a'), one('b', { col: 0, row: 0 })], cols: 2 });
    expect(g.shortcuts.find((p) => p.id === 'b')).toEqual({ id: 'b', col: 0, row: 0, cells: 1 });
    expect(g.shortcuts.find((p) => p.id === 'a')).toEqual({ id: 'a', col: 1, row: 0, cells: 1 });
  });

  it('узкий стол не теряет плитку: не влезшая координата переносится на свободное место', () => {
    const g = desktopLayoutGrid({ folderIds: [], shortcuts: [one('a', { col: 7, row: 0 })], cols: 2 });
    expect(g.shortcuts).toEqual([{ id: 'a', col: 0, row: 0, cells: 1 }]);
  });

  it('две плитки на одной ячейке не накладываются — вторая уезжает на свободное', () => {
    const g = desktopLayoutGrid({
      folderIds: [],
      shortcuts: [one('a', { col: 1, row: 1 }), one('b', { col: 1, row: 1 })],
      cols: 3,
    });
    const spots = g.shortcuts.map((p) => `${p.row}:${p.col}`);
    expect(new Set(spots).size).toBe(2);
    expect(spots).toContain('1:1');
  });

  it('крупная плитка занимает две соседние ячейки и не пускает туда мелкую', () => {
    const g = desktopLayoutGrid({
      folderIds: [],
      shortcuts: [{ id: 'big', cells: 2, pos: { col: 0, row: 0 } }, one('a')],
      cols: 3,
    });
    expect(g.shortcuts.find((p) => p.id === 'a')).toEqual({ id: 'a', col: 2, row: 0, cells: 1 });
  });

  it('крупная плитка не разрывается по краю: не влезла в хвост строки — уходит на следующую', () => {
    const g = desktopLayoutGrid({ folderIds: ['f1'], shortcuts: [{ id: 'big', cells: 2 }], cols: 2 });
    expect(g.shortcuts).toEqual([{ id: 'big', col: 0, row: 1, cells: 2 }]);
    expect(g.rows).toBe(2);
  });

  it('ноль колонок читается как одна', () => {
    expect(desktopLayoutGrid({ folderIds: [], shortcuts: [one('a')], cols: 0 }).shortcuts).toEqual([
      { id: 'a', col: 0, row: 0, cells: 1 },
    ]);
  });

  // Плитка шире всего стола — это не выдуманный случай: разделитель тянется до узкой полосы,
  // а крупный шаг рейтинга требует двух ячеек. Наивный поиск свободного места («перебираем
  // строки, пока не влезет») в этом случае крутится вечно и вешает поток целиком.
  it('плитка шире стола занимает всё, что есть, и не вешает раскладку', () => {
    expect(desktopLayoutGrid({ folderIds: [], shortcuts: [{ id: 'big', cells: 2 }], cols: 1 }).shortcuts).toEqual([
      { id: 'big', col: 0, row: 0, cells: 1 },
    ]);
    const many = desktopLayoutGrid({
      folderIds: ['f1'],
      shortcuts: [{ id: 'b1', cells: 2 }, { id: 'b2', cells: 2, pos: { col: 0, row: 0 } }],
      cols: 1,
    });
    expect(many.shortcuts.map((p) => p.cells)).toEqual([1, 1]);
    expect(new Set(many.shortcuts.map((p) => `${p.row}:${p.col}`)).size).toBe(2);
  });

  it('порядок ярлыков в массиве не меняет мест с координатами', () => {
    const items = [one('a', { col: 2, row: 0 }), one('b', { col: 0, row: 0 }), one('c')];
    const straight = desktopLayoutGrid({ folderIds: [], shortcuts: items, cols: 3 });
    const reversed = desktopLayoutGrid({ folderIds: [], shortcuts: [...items].reverse(), cols: 3 });
    const at = (g: typeof straight, id: string) => g.shortcuts.find((p) => p.id === id);
    for (const id of ['a', 'b', 'c']) expect(at(reversed, id)).toEqual(at(straight, id));
  });
});

describe('запись координат пачкой', () => {
  it('пишет координаты и возвращает новый стол', () => {
    const d = seeded();
    const next = desktopSetPositions(d, [{ id: 's1', pos: { col: 2, row: 1 } }]);
    expect(next).not.toBe(d);
    expect(next.shortcuts.find((s) => s.id === 's1')?.pos).toEqual({ col: 2, row: 1 });
  });

  it('дроп плитки на её же место — не изменение (иначе лишняя запись профиля)', () => {
    const d = desktopSetPositions(seeded(), [{ id: 's1', pos: { col: 2, row: 1 } }]);
    expect(desktopSetPositions(d, [{ id: 's1', pos: { col: 2, row: 1 } }])).toBe(d);
  });

  it('перенос выделения — одно изменение на весь жест', () => {
    const next = desktopSetPositions(seeded(), [
      { id: 's1', pos: { col: 0, row: 2 } },
      { id: 's2', pos: { col: 1, row: 2 } },
    ]);
    expect(next.shortcuts.filter((s) => s.pos != null)).toHaveLength(2);
  });
});

describe('пачечные действия выделения', () => {
  it('Delete уводит в корзину всё выделенное разом', () => {
    const d = desktopMoveToTrashMany(seeded(), ['s1', 's2'], NOW + 5);
    expect(desktopTrashShortcuts(d).map((s) => s.id)).toEqual(['s1', 's2']);
    expect(desktopSurfaceShortcuts(d)).toHaveLength(0);
  });

  it('уже лежащее в корзине не переудаляется, пустое выделение — не изменение', () => {
    const d = desktopMoveToTrash(seeded(), 's1', NOW + 1);
    expect(desktopMoveToTrashMany(d, ['s1'], NOW + 9)).toBe(d);
    expect(desktopMoveToTrashMany(d, [], NOW + 9)).toBe(d);
  });

  it('перенос выделения в папку снимает координаты: место в папке своё', () => {
    let d = desktopSetPositions(seeded(), [{ id: 's1', pos: { col: 3, row: 3 } }]);
    d = desktopMoveToFolderMany(d, ['s1', 's2'], 'f1');
    expect(desktopFolderShortcuts(d, 'f1').map((s) => s.id)).toEqual(['s1', 's2']);
    expect(d.shortcuts.find((s) => s.id === 's1')?.pos).toBeUndefined();
  });

  it('ярлык уже в этой папке — не изменение', () => {
    const d = desktopMoveToFolderMany(seeded(), ['s1'], 'f1');
    expect(desktopMoveToFolderMany(d, ['s1'], 'f1')).toBe(d);
  });
});

describe('счётчик использования', () => {
  const DAY = 86_400_000;
  const ago = (days: number) => NOW - days * DAY;

  it('открытие кладётся в бакет текущего дня по местному времени', () => {
    const u = desktopUsageBump(createEmptyDesktopUsage(), 's1', NOW);
    expect(Object.keys(u.buckets.s1 ?? {})).toEqual([desktopUsageDay(NOW)]);
    expect(u.buckets.s1?.[desktopUsageDay(NOW)]).toBe(1);
    expect(desktopUsageDay(NOW)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('неделя простоя делит счёт пополам', () => {
    const fresh = desktopUsageBump(createEmptyDesktopUsage(), 's1', NOW);
    const week = desktopUsageBump(createEmptyDesktopUsage(), 's1', ago(7));
    expect(desktopUsageScore(fresh, 's1', NOW)).toBeCloseTo(1, 6);
    expect(desktopUsageScore(week, 's1', NOW)).toBeCloseTo(0.5, 6);
  });

  it('за окном 30 дней открытие не считается и не хранится', () => {
    let u = createEmptyDesktopUsage();
    u = desktopUsageBump(u, 's1', ago(40));
    expect(desktopUsageScore(u, 's1', NOW)).toBe(0);
    // Свежий bump заодно подчищает окно — старый день не остаётся в карте.
    u = desktopUsageBump(u, 's1', NOW);
    expect(Object.keys(u.buckets.s1 ?? {})).toEqual([desktopUsageDay(NOW)]);
  });

  it('свёртка складывает, а не заменяет: вторая машина не теряет своё', () => {
    // Роумящийся счёт: s1 открывали дважды. Локальная добавка: s1 ещё раз и s2 впервые.
    const roamed = desktopUsageBump(desktopUsageBump(createEmptyDesktopUsage(), 's1', NOW), 's1', NOW);
    const local = desktopUsageBump(desktopUsageBump(createEmptyDesktopUsage(), 's1', NOW), 's2', NOW);
    const sum = desktopUsageAdd(roamed, local, NOW);
    expect(sum.buckets.s1?.[desktopUsageDay(NOW)]).toBe(3);
    expect(sum.buckets.s2?.[desktopUsageDay(NOW)]).toBe(1);
  });

  it('счётчик забывает снесённые ярлыки', () => {
    const u = desktopUsageBump(desktopUsageBump(createEmptyDesktopUsage(), 's1', NOW), 'gone', NOW);
    expect(Object.keys(desktopUsageKeepOnly(u, ['s1']).buckets)).toEqual(['s1']);
    // Нечего выкидывать — тот же объект, лишней записи профиля не будет.
    expect(desktopUsageKeepOnly(u, ['s1', 'gone'])).toBe(u);
  });
});

describe('шаг размера по рейтингу', () => {
  const DAY = 86_400_000;
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i + 1}`);

  it('никто ничего не открывал — весь стол на шаге 0, сегодняшним видом', () => {
    const steps = desktopUsageSteps(createEmptyDesktopUsage(), ids(8), NOW);
    expect(Object.values(steps)).toEqual(Array(8).fill(0));
  });

  it('равные счета получают равный шаг — первый ярлык не становится гигантом случайно', () => {
    let u = createEmptyDesktopUsage();
    for (const id of ids(6)) u = desktopUsageBump(u, id, NOW);
    expect(new Set(Object.values(desktopUsageSteps(u, ids(6), NOW))).size).toBe(1);
  });

  it('потолок шага зависит от числа ярлыков: на трёх плитках гигантомании нет', () => {
    let small = createEmptyDesktopUsage();
    for (let i = 0; i < 20; i += 1) small = desktopUsageBump(small, 's1', NOW);
    small = desktopUsageBump(small, 's2', NOW);
    small = desktopUsageBump(small, 's3', NOW);
    expect(desktopUsageSteps(small, ['s1', 's2', 's3'], NOW).s1).toBe(1);

    let big = createEmptyDesktopUsage();
    const many = ids(20);
    many.forEach((id, i) => {
      for (let k = 0; k <= i; k += 1) big = desktopUsageBump(big, id, NOW);
    });
    const steps = desktopUsageSteps(big, many, NOW);
    expect(steps.s20).toBe(4);
    expect(steps.s1).toBe(-1);
  });

  // Это то, что стоит проговорить владельцу: заброшенный стол не «дышит» размерами.
  it('на заброшенном столе плитки не скачут: все счета падают синхронно', () => {
    let u = createEmptyDesktopUsage();
    const many = ids(12);
    many.forEach((id, i) => {
      for (let k = 0; k <= i; k += 1) u = desktopUsageBump(u, id, NOW);
    });
    const before = desktopUsageSteps(u, many, NOW);
    const after = desktopUsageSteps(u, many, NOW + 10 * DAY);
    expect(after).toEqual(before);
  });

  it('плитка уменьшается ОТНОСИТЕЛЬНО тех, которыми продолжают пользоваться', () => {
    let u = createEmptyDesktopUsage();
    const many = ids(12);
    for (const id of many) u = desktopUsageBump(u, id, NOW);
    for (let k = 0; k < 30; k += 1) u = desktopUsageBump(u, 's12', NOW + 10 * DAY);
    const after = desktopUsageSteps(u, many, NOW + 10 * DAY);
    expect(after.s12).toBeGreaterThan(after.s1 ?? 0);
  });

  it('пустой стол — пустая карта шагов', () => {
    expect(desktopUsageSteps(createEmptyDesktopUsage(), [], NOW)).toEqual({});
  });
});
