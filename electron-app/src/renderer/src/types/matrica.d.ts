import type {
  MatricaApi,
  ProductionProgramDto,
  ProductionProgramLineDto,
  ProductionProgramSignatureTemplate,
} from '@matricarmz/shared';

// Мост целиком описан контрактом MatricaApi (shared/src/ipc/types.ts) — он и есть источник
// правды по форме window.matrica. Локальных «доклеек» тут быть не должно: любой новый метод
// preload'а идёт в MatricaApi, иначе тип снова разъедется с реальным мостом (2026-08-03).
//
// Исключение — шаблоны подписей ПП (промт КАРМАНА #120): контракт MatricaApi дописывает
// параллельный агент в shared/, а мост клиента уже отдаёт эти методы. Поэтому здесь —
// ПЕРЕСЕЧЕНИЕ с общим контрактом: как только в MatricaApi появятся те же методы,
// пересечение остаётся верным (Omit убирает дубли, чтобы тип не разошёлся).
type ProductionProgramSignatureTemplateBridge = {
  /** Список шаблонов подписей ПП (сервер — источник правды). */
  listSignatureTemplates: () => Promise<
    { ok: true; rows: ProductionProgramSignatureTemplate[] } | { ok: false; error: string }
  >;
  /** Завести/править шаблон подписей; `isDefault` — сделать шаблоном по умолчанию. */
  saveSignatureTemplate: (args: {
    id?: string | null;
    name: string;
    slots: string;
    isDefault?: boolean;
  }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  /** Снять шаблон подписей. */
  deleteSignatureTemplate: (id: string) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
};

/**
 * Программа на экране: снимок шапки + ссылка на шаблон подписей.
 *
 * Поле `signatureTemplateId` есть в реплике и в ответе IPC, а в общий DTO
 * (`shared/src/domain/productionProgram.ts`) его дописывает параллельный агент —
 * поэтому здесь оно описано поверх, а не правкой чужого файла.
 */
export type ProductionProgramRowDto = ProductionProgramDto & {
  signatureTemplateId: string | null;
};

type MatricaApiWithSignatureTemplates = Omit<MatricaApi, 'productionProgram'> & {
  productionProgram: Omit<
    MatricaApi['productionProgram'],
    'list' | 'update' | 'listSignatureTemplates' | 'saveSignatureTemplate' | 'deleteSignatureTemplate'
  > & {
    list: () => Promise<
      | { ok: true; rows: ProductionProgramRowDto[]; lines: ProductionProgramLineDto[] }
      | { ok: false; error: string }
    >;
    update: (args: {
      id: string;
      periodStart?: number;
      periodEnd?: number;
      shop?: string;
      workshopId?: string | null;
      title?: string;
      status?: string;
      signatureSlots?: string | null;
      signatureTemplateId?: string | null;
    }) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  } & ProductionProgramSignatureTemplateBridge;
};

declare global {
  interface Window {
    matrica: MatricaApiWithSignatureTemplates;
  }
}

export {};
