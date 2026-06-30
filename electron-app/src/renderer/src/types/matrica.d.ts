import type { ChatDeepLinkPayload, MatricaApi } from '@matricarmz/shared';

type MatricaApiWithEmployeeDefs = Omit<MatricaApi, 'employees' | 'app'> & {
  app: MatricaApi['app'] & {
    onCloseRequest: (handler: () => void) => () => void;
    respondToCloseRequest: (args: { allowClose: boolean }) => void;
    navigateDeepLink: (link: ChatDeepLinkPayload) => Promise<{ ok: boolean; error?: string }>;
    onDeepLink: (handler: (link: ChatDeepLinkPayload) => void) => () => void;
  };
  admin: MatricaApi['admin'] & {
    entityTypes: MatricaApi['admin']['entityTypes'] & {
      resyncFromServer: (entityTypeId: string) => Promise<any>;
      resyncAllFromServer: () => Promise<any>;
    };
    users: MatricaApi['admin']['users'] & {
      changeRequestsList: () => Promise<any>;
      changeRequestsDecide: (args: { id: string; action: 'approve' | 'reject'; note?: string }) => Promise<any>;
    };
  };
  employees: MatricaApi['employees'] & {
    defs: () => Promise<any[]>;
    resyncFromServer: () => Promise<any>;
  };
  warehouse: MatricaApi['warehouse'];
  tools: any;
  update: MatricaApi['update'] & {
    reset: () => Promise<any>;
    downloadDirGet: () => Promise<any>;
    downloadDirPick: () => Promise<any>;
  };
  engines: MatricaApi['engines'] & {
    delete: (id: string) => Promise<any>;
    dedupeAnalyze: () => Promise<
      | { ok: true; totalEngines: number; groups: Array<{ kind: 'exact' | 'similar'; engines: Array<{ id: string; engineNumber: string; engineBrand: string; createdAt: number; opsCount: number }> }> }
      | { ok: false; error: string }
    >;
    dedupeMerge: (args: { survivorId: string; loserIds: string[] }) => Promise<
      | { ok: true; report: { survivorId: string; merged: Array<{ loserId: string; opsRepointed: number; attrsFilled: number }> } }
      | { ok: false; error: string }
    >;
  };
  diagnostics: {
    criticalEventsList: (args?: { days?: number; limit?: number }) => Promise<any>;
    criticalEventsDelete: (args: { id: string }) => Promise<any>;
    criticalEventsClear: () => Promise<any>;
  };
  maintenance: {
    emptyCardsAnalyze: () => Promise<
      | {
          ok: true;
          total: number;
          groups: Array<{
            kind: 'engine' | 'contract' | 'employee' | 'work_order' | 'supply_request';
            label: string;
            rows: Array<{ id: string; kind: string; label: string; createdAt: number }>;
          }>;
        }
      | { ok: false; error: string }
    >;
    emptyCardsDelete: (args: { ids: string[] }) => Promise<
      | { ok: true; deleted: number; skipped: Array<{ id: string; reason: string }> }
      | { ok: false; error: string }
    >;
  };
  drafts: {
    save: (args: { cardType: string; cardId: string; kind?: 'recovery' | 'explicit'; title?: string | null; payloadJson?: string | null; baseUpdatedAt?: number | null }) => Promise<
      { ok: true; id: string } | { ok: false; error: string }
    >;
    list: () => Promise<
      | { ok: true; drafts: Array<{ id: string; cardType: string; cardId: string; kind: 'recovery' | 'explicit'; title: string | null; payloadJson: string | null; baseUpdatedAt: number | null; createdAt: number; updatedAt: number }> }
      | { ok: false; error: string }
    >;
    get: (args: { cardType: string; cardId: string }) => Promise<
      | { ok: true; draft: { id: string; cardType: string; cardId: string; kind: 'recovery' | 'explicit'; title: string | null; payloadJson: string | null; baseUpdatedAt: number | null; createdAt: number; updatedAt: number } | null }
      | { ok: false; error: string }
    >;
    clear: (args: { id?: string; cardType?: string; cardId?: string }) => Promise<
      { ok: true; cleared: number } | { ok: false; error: string }
    >;
  };
};

declare global {
  interface Window {
    matrica: MatricaApiWithEmployeeDefs;
  }
}

export {};


