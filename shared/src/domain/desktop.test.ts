import { describe, expect, it } from 'vitest';

import {
  DESKTOP_USAGE_MAX_DAYS,
  createEmptyDesktop,
  desktopAddFolder,
  desktopAddShortcut,
  desktopDeleteFolder,
  desktopEmptyTrash,
  desktopFolderShortcuts,
  desktopMoveToFolder,
  desktopMoveToTrash,
  desktopRestoreFromTrash,
  desktopSurfaceShortcuts,
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
