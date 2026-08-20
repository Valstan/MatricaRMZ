import { describe, expect, it } from 'vitest';

import {
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
