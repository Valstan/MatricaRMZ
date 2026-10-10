import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Мелкие карточки (аудит кнопок 10.10.2026, чинено по канону #1240):
// BOM виден хост-гарду, свойство не закрывается мимо ошибки,
// марка чистит черновик до перезагрузки.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const norm = (s: string) => s.split('\n').map((line) => line.trim()).join('\n');

describe('BOM виден хост-гарду закрытия', () => {
  const PAGE = src('./EngineAssemblyBomDetailsPage.tsx');
  const APP = src('../App.tsx');

  it('страница регистрирует close-actions', () => {
    expect(PAGE).toContain('registerCardCloseActions?: (actions: CardCloseActions | null) => void;');
    expect(PAGE).toContain('props.registerCardCloseActions(actions);');
    expect(PAGE).toContain('isDirty: () => isBomDirty');
  });

  it('обе точки монтирования передают регистрацию', () => {
    const mounts = APP.split('<EngineAssemblyBomDetailsPage').slice(1);
    expect(mounts, 'вторая панель + основная').toHaveLength(2);
    for (const m of mounts) {
      expect(m.slice(0, 600)).toContain('registerCardCloseActions=');
    }
  });
});

describe('свойство инструмента не закрывается мимо ошибки', () => {
  const PAGE = src('./ToolPropertyDetailsPage.tsx');

  it('saveAll возвращает успех, закрытие идёт по результату', () => {
    expect(PAGE).toContain('async function saveAll(): Promise<boolean>');
    expect(PAGE).toContain("if (!(await saveAttr('name', name.trim()))) return false;");
    expect(PAGE).toContain('if (!(await saveAll())) return;');
  });
});

describe('марка чистит черновик до перезагрузки', () => {
  const PAGE = src('./EngineBrandDetailsPage.tsx');

  it('оба пути сброса гасят dirty, отменяют автосейв и чистят черновик', () => {
    const hits = norm(PAGE).split('cancelPendingDraftSave();\nawait clearDraft();').length - 1;
    expect(hits, 'тулбар и close-actions чистят черновик до load').toBeGreaterThanOrEqual(2);
    expect(PAGE).toContain('draftRestoredRef.current = false;');
  });
});
