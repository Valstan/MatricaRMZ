// КНОПКА НЕЙРОСЕТИ В РАЗДЕЛЕ — одна кнопка на всю программу.
//
// ЗАЧЕМ ОДНА. Кнопка нужна в каждом разделе (промт КАРМАНА #176, разрез 4), и если
// у каждой страницы своя кнопка, то у каждой страницы своя проверка «есть ли канал
// действий», своя подпись и свой формат вопроса — а правила разъезжаются тихо
// (ADR-0011). Значит: кнопка одна, а раздел ей передаётся.
//
// ЧТО ОНА ДЕЛАЕТ. Открывает ТУ ЖЕ вкладку «ИИваныч» (второго чата не заводим) и кладёт
// в поле ввода вопрос с контекстом раздела. Формат вопроса собирает ДОМЕН
// (`aiSectionQuestion`) — не страница.
//
// КОГДА КНОПКИ НЕТ. На планшете локального модуля агента нет (шим отвечает «не
// настроен»), а значит нет и канала действий: кнопка открыла бы чат, в котором
// нейросеть ничего не сможет сделать. Тогда её нет (та же проверка, что у строки
// статуса в панели ИИваныча).

import React from 'react';

import { aiSectionQuestion, aiSectionTitle, type AiSectionQuestionInput } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { useAiChatLauncher } from './AiChatLauncherContext.js';
import { useAiToolsAvailable } from './useAiToolsAvailable.js';

export type AiSectionButtonProps = {
  /** Ключ раздела (см. `MenuTabId`): из него домен берёт название и формат вопроса. */
  section: string;
  /** Готовый вопрос — иначе его собирает домен по разделу. */
  question?: string;
  /** Данные для сборки вопроса (например, название программы для раздела ПП). */
  context?: AiSectionQuestionInput;
  /** Подпись кнопки. */
  label?: string;
  /** Подсказка при наведении. */
  title?: string;
  /** Метка действия для смоуков (`data-ai-action`). */
  dataAction?: string;
  /** Вид кнопки. */
  variant?: 'primary' | 'ghost' | 'outline';
};

export function AiSectionButton(props: AiSectionButtonProps) {
  const launcher = useAiChatLauncher();
  const available = useAiToolsAvailable();

  // Хуки вызваны выше — порядок правил React соблюдён.
  if (!launcher || !available) return null;

  const question = String(props.question ?? aiSectionQuestion(props.section, props.context) ?? '').trim();
  if (!question) return null;

  return (
    <Button
      variant={props.variant ?? 'ghost'}
      onClick={() => launcher.openAiChat(question)}
      data-ai-action={props.dataAction ?? 'open-chat'}
      data-ai-section={props.section}
      title={props.title ?? `Нейросеть: спросить про раздел «${aiSectionTitle(props.section)}»`}
    >
      {props.label ?? 'Нейросеть'}
    </Button>
  );
}
