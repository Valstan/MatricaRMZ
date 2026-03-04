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
  };
  employees: MatricaApi['employees'] & {
    defs: () => Promise<any[]>;
    resyncFromServer: () => Promise<any>;
  };
  warehouse: any;
  tools: any;
  update: MatricaApi['update'] & {
    reset: () => Promise<any>;
  };
  engines: MatricaApi['engines'] & {
    delete: (id: string) => Promise<any>;
  };
};

declare global {
  interface Window {
    matrica: MatricaApiWithEmployeeDefs;
  }
}

export {};


