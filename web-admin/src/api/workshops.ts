import { apiJson } from './client.js';

// Цеха живут в строгой таблице `directory_workshops` (SSOT), а не в EAV: типа-сущности
// `workshop` в базе нет вовсе. Поэтому ссылочные поля «Цех» на экране справочников
// резолвятся этим вызовом, а не перечислением сущностей — как это делает Electron-клиент.
export type WorkshopRow = {
  id: string;
  code?: string | null;
  name?: string | null;
  isActive?: boolean;
  displayOrder?: number;
};

export function listWorkshops(): Promise<{ ok: boolean; rows?: WorkshopRow[]; error?: string }> {
  return apiJson('/workshops', { method: 'GET' }) as Promise<{ ok: boolean; rows?: WorkshopRow[]; error?: string }>;
}
