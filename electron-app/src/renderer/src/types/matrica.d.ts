import type { MatricaApi } from '@matricarmz/shared';

type MatricaApiWithEmployeeDefs = Omit<MatricaApi, 'employees' | 'app'> & {
  app: MatricaApi['app'] & {
    onCloseRequest: (handler: () => void) => () => void;
    respondToCloseRequest: (args: { allowClose: boolean }) => void;
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


