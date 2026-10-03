import { ipcMain } from 'electron';

import { parseContractPayments, type ContractPayments } from '@matricarmz/shared';

import type { IpcContext } from '../ipcContext.js';
import { isViewMode, requirePermOrResult, viewModeWriteError } from '../ipcContext.js';
import {
  readContractPaymentsStrict,
  saveContractPaymentsStrict,
} from '../../services/contractPaymentsReplica.js';

type Err = { ok: false; error: string };

/**
 * Платежи договоров — строгая реплика (план contract-payments-strict-2026-10).
 * Чтение/запись — локальная SQLite, дальше штатный синк. Гейты — те же, что у
 * прежнего пути через карточку (`admin:entities:get/setAttr`): чтение —
 * `masterdata.view`, запись — `masterdata.edit`. Серверный гейт синка требует
 * `contracts.edit` (ledgerAuthz) — он и есть настоящий.
 */
export function registerContractPaymentsIpc(ctx: IpcContext) {
  ipcMain.handle('contractPayments:get', async (_e, contractId: string) => {
    const gate = await requirePermOrResult(ctx, 'masterdata.view');
    if (!gate.ok) return gate as Err;
    try {
      const payments = await readContractPaymentsStrict(ctx.dataDb(), String(contractId ?? ''));
      return { ok: true as const, payments };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });

  ipcMain.handle('contractPayments:save', async (_e, args: { contractId: string; next: unknown }) => {
    if (isViewMode(ctx)) return viewModeWriteError();
    const gate = await requirePermOrResult(ctx, 'masterdata.edit');
    if (!gate.ok) return gate as Err;
    try {
      const contractId = String(args?.contractId ?? '').trim();
      const next = parseContractPayments((args as { next?: unknown })?.next);
      const { changed } = await saveContractPaymentsStrict(ctx.dataDb(), contractId, next as ContractPayments, Date.now());
      void changed;
      const payments = await readContractPaymentsStrict(ctx.dataDb(), contractId);
      return { ok: true as const, payments };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  });
}
