import type { MatricaApi } from '@matricarmz/shared';

type MatricaApiWithEmployeeDefs = Omit<MatricaApi, 'employees'> & {
  employees: MatricaApi['employees'] & {
    defs: () => Promise<any[]>;
  };
};

declare global {
  interface Window {
    matrica: MatricaApiWithEmployeeDefs;
  }
}

export {};


