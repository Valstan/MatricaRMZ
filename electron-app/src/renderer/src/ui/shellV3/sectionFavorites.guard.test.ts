import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Сторож избранного разделов (владелец 12.10.2026): слева — постоянная колонка
// больших карточек избранного, звёздочки золотые на вкладках и в МЕНЮ.
// Цепочка длинная (контракт → preload → main → App → шелл → панель), и порвать
// её молча легко: ни типы, ни линт не заметят пропавший проброс пропса или
// незарегистрированный канал — избранное просто перестанет сохраняться.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

// Корень монорепо — поиском вверх до pnpm-workspace.yaml, без подсчёта `..`:
// длинные цепочки `../` в new URL под vitest разрешаются на уровень выше
// (проверено вживую: 5 подъёмов из shellV3 дали electron-app вместо корня).
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('repo root with pnpm-workspace.yaml not found');
}

function rootSrc(rel: string): string {
  return readFileSync(join(repoRoot(), rel), 'utf8');
}

describe('избранное разделов: цепочка контракт → мост → шелл цела', () => {
  it('контракт MatricaApi описывает sections.favoritesGet/Set', () => {
    const text = rootSrc('shared/src/ipc/types.ts');
    expect(text).toContain('sections: {');
    expect(text).toContain('SectionFavoritesResult');
  });

  it('preload мостит sections на IPC', () => {
    const text = rootSrc('electron-app/src/preload/index.ts');
    expect(text).toContain("ipcRenderer.invoke('sections:favoritesGet'");
    expect(text).toContain("ipcRenderer.invoke('sections:favoritesSet'");
  });

  it('main регистрирует оба канала', () => {
    const text = rootSrc('electron-app/src/main/ipc/registerIpc.ts');
    expect(text).toContain('registerSectionFavoritesIpc');
  });

  it('App грузит избранное при логине и отдаёт в шелл', () => {
    const text = src('../App.tsx');
    expect(text).toContain('sections');
    expect(text).toContain('favoritesGet');
    expect(text).toContain('sectionFavorites={sectionFavorites}');
    expect(text).toContain('onToggleSectionFavorite={toggleSectionFavorite}');
  });

  it('шелл рисует левую панель; звезда — в МЕНЮ и на вкладке', () => {
    const text = src('./V3TabShell.tsx');
    expect(text).toContain('data-fav-rail');
    expect(text).toContain('data-fav-card');
    expect(text).toContain('onToggleSectionFavorite');
    // Владелец 13.11.2026: звезда вернулась на вкладки («верни значок звездочки, чтобы
    // вкладку в левую колонку можно было добавлять»). Цепочка сохранения та же:
    // favoritesGet/Set.
    expect(text).toContain('FavoriteStarButton');
    expect(text).toContain('v3-tab-star');
    const star = src('../components/FavoriteStarButton.tsx');
    expect(star).toContain('data-fav-star');
  });

  it('панель МЕНЮ ставит звёздочки только nav-кнопкам разделов', () => {
    const text = src('../shellV2/ButtonPanel.tsx');
    expect(text).toContain('FavoriteStarButton');
    expect(text).toContain("btn.kind === 'nav'");
    expect(text).toContain('onToggleFavoriteTab');
  });
});

// Левая панель не должна оставаться пустой (владелец 13.11.2026: «многие клиенты так
// и сидят до сих пор с пустой колонкой слева»). Дефолтные разделы — список двигателей
// и список контрактов — лежат в реестре разделов (один источник правды), а main
// подмешивает их к выбору оператора и помнит, что тот их снял.
describe('дефолтные разделы левой панели', () => {
  it('дефолты живут в реестре разделов: двигатели, контракты и табель', () => {
    const text = rootSrc('shared/src/domain/uiSections.ts');
    expect(text).toContain('DEFAULT_SECTION_FAVORITES');
    expect(text).toMatch(/DEFAULT_SECTION_FAVORITES[^=]*=\s*\['engines',\s*'contracts',\s*'timesheets'\]/);
  });

  it('main отдаёт дефолты каждому и считает снятые отдельно', () => {
    const text = rootSrc('electron-app/src/main/ipc/register/sectionFavorites.ts');
    expect(text).toContain('DEFAULT_SECTION_FAVORITES');
    expect(text).toContain('effectiveSectionFavoriteIds');
    // Снятый дефолт должен ПЕРЕЖИТЬ перезапуск: иначе «по умолчанию» — фикция.
    expect(text).toMatch(/off\s*=/);
    expect(text).toContain('off:');
  });

  it('звезда с вкладки ведёт в тот же профиль избранного', () => {
    const text = src('./V3TabShell.tsx');
    expect(text).toContain('props.onToggleSectionFavorite(menuId)');
    expect(text).toContain('props.sectionFavorites.includes(menuId)');
  });

  it('звезда молчит, пока профиль не прочитан (иначе клик затрёт выбор)', () => {
    const text = src('../App.tsx');
    expect(text).toContain('sectionFavoritesLoaded');
    expect(text).toContain('if (!sectionFavoritesLoaded) return;');
  });
});
