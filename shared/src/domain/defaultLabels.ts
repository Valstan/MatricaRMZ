// PR-5: строгие умолчания подписей (не EAV). Ключ поля → id сотрудника; ФИО резолвится на чтении.
export type DefaultLabelFieldKey = 'defect_act_performer'; // старт — кто провёл дефектовку

export interface DefaultLabelDefault {
  id: number;
  fieldKey: DefaultLabelFieldKey;
  employeeId: number;
  updatedAt: string; // ISO
}
