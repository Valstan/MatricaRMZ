// ДОСТУПНОСТЬ КНОПКИ НЕЙРОСЕТИ — есть ли канал действий на этой машине.
//
// ЗАЧЕМ. Кнопка «Нейросети» в разделе открывает чат, в котором нейросеть может
// вызвать инструмент программы (разрез 2 нитки КАРМАНА #176). Инструменты живут в
// локальном модуле агента, а он есть только на машине оператора с рантаймом. На
// планшете модуля нет (шим отвечает «не настроен») ⇒ кнопки там нет: она открыла бы
// чат, в котором ни одного действия не случится, — враньё.
//
// ПРОВЕРКА — ТА ЖЕ, что у строки статуса в панели ИИваныча (`aiChat:localStatus`),
// чтобы «модуль есть» и «кнопка есть» значили одно и то же.

import { useEffect, useState } from 'react';

/**
 * Настроен ли локальный модуль агента (то есть есть ли канал действий).
 *
 * Пока проверка не прошла — false: кнопки нет до подтверждения, а не «мигает».
 */
export function useAiToolsAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await window.matrica.aiChat.localStatus();
        if (alive && res.ok) setAvailable(res.status.configured === true);
      } catch {
        if (alive) setAvailable(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return available;
}
