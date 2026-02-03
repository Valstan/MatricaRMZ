import type { MatricaApi } from '@matricarmz/shared';

type MatricaApiWithEmployeeDefs = Omit<MatricaApi, 'employees'> & {
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
};

declare global {
  interface Window {
    matrica: MatricaApiWithEmployeeDefs;
  }
}

export {};


