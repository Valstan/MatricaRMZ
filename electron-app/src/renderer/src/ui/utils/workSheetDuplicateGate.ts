import { buildWorkSheetDuplicateMessage, type WorkSheetDuplicateRef } from '@matricarmz/shared';

/**
 * Гейт дублей этапов работ: один двигатель, один вид работ, один день — один раз.
 *
 * В отличие от гейта сборочных нарядов, который спрашивают ДО создания, этот поднимается ПО
 * ОТКАЗУ записи: ключ дубля (вид работ, дата) лежит внутри `meta_json`, и достоверно совпадение
 * знает только main-процесс, уже нормализовавший значения. Поэтому порядок такой: сохранить →
 * получить `duplicate` → спросить → при «это возврат» сохранить повторно с номером прохода.
 *
 * Гейт не блокирует: двигатель действительно возвращается на тот же этап (переборка, замечание
 * ОТК). Запрет оператор обошёл бы сдвигом даты, и мы потеряли бы и данные, и доверие к ним.
 */
export type WorkSheetDuplicateDecision = { action: 'repeat'; pass: number } | { action: 'cancel' };

type PickChoice = (opts: {
  title: string;
  detail?: string;
  choices: Array<{ id: string; label: string }>;
}) => Promise<string | null>;

export type WorkSheetDuplicatePayload = {
  refs: WorkSheetDuplicateRef[];
  nextPass: number;
  typeName: string;
  atMs: number;
};

/**
 * `engineLabel` — как двигатель зовут в тексте. Пустая строка допустима: сообщение тогда скажет
 * «двигатель» вместо клейма, и это лучше, чем не показать гейт вовсе из-за незаполненной подписи.
 */
export async function askWorkSheetDuplicate(args: {
  duplicate: WorkSheetDuplicatePayload;
  engineLabel: string;
  pickChoice: PickChoice;
}): Promise<WorkSheetDuplicateDecision> {
  const message = buildWorkSheetDuplicateMessage({
    engineLabel: args.engineLabel,
    typeName: args.duplicate.typeName,
    at: args.duplicate.atMs,
    refs: args.duplicate.refs,
  });
  // Пустое сообщение значит, что ссылок не осталось: отказ был не про дубль. Молча пропускаем —
  // выдумывать вопрос там, где совпадения нет, значит учить оператора жать «да» не глядя.
  if (!message) return { action: 'cancel' };

  const picked = await args.pickChoice({
    title: 'Такой этап за этот день уже внесён',
    detail: message.text,
    choices: [{ id: 'repeat', label: `Это повторный проход № ${message.nextPass}` }],
  });
  return picked === 'repeat' ? { action: 'repeat', pass: message.nextPass } : { action: 'cancel' };
}
