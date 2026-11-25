import { useCallback, useEffect, useState } from 'react';

// Операторский пресет меню — ОТДЕЛЬНАЯ НАСТРОЙКА, а не урезание по платформе.
//
// Промт КАРМАНА #142 (зачитка владельца 25.11.2026): «планшетная версия — полный
// функционал, все модули; версия для компьютера — копия планшетной». Значит
// разделы не режутся по платформе: планшет показывает те же разделы, что и
// компьютер, а операторский пресет — это то, что оператор ВЫБИРАЕТ сам.
//
// Раньше было наоборот: `ANDROID_TABS` (рамка разделов для Android) ∩
// `TABLET_OPERATOR_TABS` (операторский пресет) — эффективное меню планшета.
// Владелец видел это как «недостаточно прав», хотя на самом деле раздел просто
// не попадал в рамку.
//
// Теперь:
//   * рамки по платформе нет — раздел режет только право и членство в разделе;
//   * пресет включается ЯВНО (здесь), по умолту выключен: меню полное.
//
// Хранится машинно-локально (localStorage), как «Это планшет» и режим интерфейса:
// пресет — свойство рабочего места, а не пользователя. По той же причине
// синх по серверу его не тянет.
const OPERATOR_MENU_PRESET_KEY = 'matrica:operatorMenuPreset';
const OPERATOR_MENU_PRESET_EVENT = 'matrica:operator-menu-preset-changed';

/** Пресет включён? По умолчанию — нет: меню полное (промт #142). */
export function readOperatorMenuPreset(): boolean {
  try {
    return window?.localStorage?.getItem(OPERATOR_MENU_PRESET_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeOperatorMenuPreset(value: boolean): void {
  try {
    window?.localStorage?.setItem(OPERATOR_MENU_PRESET_KEY, value ? 'true' : 'false');
    window?.dispatchEvent(new CustomEvent(OPERATOR_MENU_PRESET_EVENT, { detail: { value } }));
  } catch {
    // keep in-memory state as fallback
  }
}

export function useOperatorMenuPreset() {
  const [enabled, setEnabled] = useState<boolean>(readOperatorMenuPreset);

  const setEnabledPreset = useCallback((value: boolean) => {
    writeOperatorMenuPreset(value);
    setEnabled(value);
  }, []);

  useEffect(() => {
    const onChanged = () => setEnabled(readOperatorMenuPreset());
    window?.addEventListener(OPERATOR_MENU_PRESET_EVENT, onChanged);
    window?.addEventListener('storage', onChanged);
    return () => {
      window?.removeEventListener(OPERATOR_MENU_PRESET_EVENT, onChanged);
      window?.removeEventListener('storage', onChanged);
    };
  }, []);

  return { operatorMenuPreset: enabled, setOperatorMenuPreset: setEnabledPreset };
}
