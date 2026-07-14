import { ipcMain } from 'electron';

import {
  canEditSection,
  canViewSection,
  sanitizeUiSpec,
  type AccessSection,
  type SectionMembership,
  type UiScreenDetails,
  type UiScreenListItem,
} from '@matricarmz/shared';
import { accessSectionMeta } from '@matricarmz/shared';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, viewModeWriteError } from '../ipcContext.js';
import { getSectionMembershipByLogin } from '../../services/employeeService.js';
import { deleteUiScreen, getUiScreen, listUiScreens, saveUiScreen } from '../../services/uiScreenService.js';

/**
 * Operator-built screens (UI builder pilot). Deliberately NOT routed through
 * admin:entities:* — that bridge requires `masterdata.edit`, which plain
 * operators lack. Access model: a screen belongs to one AccessSection; view
 * needs viewer+ of that section, save/delete need editor. Superadmin bypasses.
 * Unseeded membership (legacy) is fail-open, consistent with sectionGate.
 */
export function registerUiScreensIpc(ctx: IpcContext) {
  async function viewerAccess(): Promise<{
    login: string;
    role: string;
    membership: SectionMembership | null;
    isSuperadmin: boolean;
  }> {
    const viewer = await ctx.currentViewer();
    const role = String(viewer.role ?? '').toLowerCase();
    const login = String(viewer.login ?? '').trim().toLowerCase();
    const isSuperadmin = role === 'superadmin';
    const membership =
      !isSuperadmin && login ? await getSectionMembershipByLogin(ctx.dataDb(), login).catch(() => null) : null;
    return { login, role, membership, isSuperadmin };
  }

  function levelAllowed(
    access: Awaited<ReturnType<typeof viewerAccess>>,
    sectionId: string,
    level: 'viewer' | 'editor',
  ): boolean {
    if (access.isSuperadmin) return true;
    if (!accessSectionMeta(sectionId)) return false; // unknown section — deny, a screen must belong to a real one
    if (access.membership == null) return true; // legacy unseeded — fail-open (as sectionGate)
    const check = level === 'editor' ? canEditSection : canViewSection;
    return check({ membership: access.membership, role: access.role, sectionId: sectionId as AccessSection });
  }

  ipcMain.handle('uiScreens:list', async (): Promise<{ ok: true; rows: UiScreenListItem[] } | { ok: false; error: string }> => {
    try {
      const access = await viewerAccess();
      const rows = await listUiScreens(ctx.dataDb());
      const visible = rows
        .filter((r) => levelAllowed(access, r.sectionId, 'viewer'))
        .map(({ specJson: _spec, ...row }) => ({ ...row, canEdit: levelAllowed(access, row.sectionId, 'editor') }));
      return { ok: true, rows: visible };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle('uiScreens:get', async (_e, id: string): Promise<{ ok: true; screen: UiScreenDetails } | { ok: false; error: string }> => {
    try {
      const access = await viewerAccess();
      const row = await getUiScreen(ctx.dataDb(), id);
      if (!row) return { ok: false, error: 'Экран не найден' };
      if (!levelAllowed(access, row.sectionId, 'viewer')) return { ok: false, error: 'Нет доступа к экрану' };
      return { ok: true, screen: { ...row, canEdit: levelAllowed(access, row.sectionId, 'editor') } };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle(
    'uiScreens:save',
    async (_e, args: { id?: string; name: string; sectionId: string; specJson: string }) => {
      if (isViewMode(ctx)) return viewModeWriteError();
      try {
        const access = await viewerAccess();
        const name = String(args?.name ?? '').trim().slice(0, 200);
        const sectionId = String(args?.sectionId ?? '').trim();
        if (!name) return { ok: false, error: 'Укажите название экрана' };
        const spec = sanitizeUiSpec(args?.specJson);
        if (!spec) return { ok: false, error: 'Некорректная спецификация экрана' };
        if (!levelAllowed(access, sectionId, 'editor')) {
          return { ok: false, error: 'Нужен уровень «редактор» в выбранном разделе' };
        }
        const existingId = String(args?.id ?? '').trim();
        if (existingId) {
          const current = await getUiScreen(ctx.dataDb(), existingId);
          if (!current) return { ok: false, error: 'Экран не найден' };
          if (!levelAllowed(access, current.sectionId, 'editor')) {
            return { ok: false, error: 'Нет права редактировать этот экран' };
          }
        }
        return await saveUiScreen(ctx.dataDb(), {
          ...(existingId ? { id: existingId } : {}),
          name,
          sectionId,
          specJson: JSON.stringify(spec),
          createdBy: access.login,
        });
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  );

  ipcMain.handle('uiScreens:delete', async (_e, id: string) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    try {
      const access = await viewerAccess();
      const row = await getUiScreen(ctx.dataDb(), id);
      if (!row) return { ok: false, error: 'Экран не найден' };
      if (!levelAllowed(access, row.sectionId, 'editor')) {
        return { ok: false, error: 'Нет права удалить этот экран' };
      }
      return await deleteUiScreen(ctx.dataDb(), id);
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
}
