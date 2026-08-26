/**
 * Заполнить контакт техподдержки, который оператор видит в окне приветствия релиза.
 *
 * До 2026-08-26 телефон и подпись были литералами в `App.tsx`, то есть лежали в
 * открытом git (репозиторий публичен). Решение владельца (brain D-042): показ
 * оператору сохранить, источник сменить на настройки экземпляра. Значение живёт в
 * строке `__global_ui_defaults__` таблицы `client_settings` и приезжает клиенту
 * аутентифицированным `GET /auth/support-contact`.
 *
 * Значения приходят АРГУМЕНТАМИ — в коде их нет и быть не должно
 * (`AGENTS.md` §«Персональные данные сотрудников»):
 *
 *   corepack pnpm -F @matricarmz/backend-api support:contact                          # показать текущее
 *   corepack pnpm -F @matricarmz/backend-api support:contact --phone "…" --person "…" # записать
 *   corepack pnpm -F @matricarmz/backend-api support:contact --clear                  # убрать показ
 *
 * Пустое значение прячет блок «Техподдержка» целиком, а не рисует пустую строку.
 */
import 'dotenv/config';

import { pool } from '../database/db.js';
import { getGlobalSupportContact, setGlobalSupportContact } from '../services/clientSettingsService.js';

function argValue(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return null;
  const value = process.argv[idx + 1];
  if (value === undefined || value.startsWith('--')) return '';
  return value;
}

function describe(contact: { phone: string; person: string }): string {
  if (!contact.phone && !contact.person) return '(пусто — блок «Техподдержка» не показывается)';
  return `телефон: ${contact.phone || '(нет)'} | подпись: ${contact.person || '(нет)'}`;
}

async function main(): Promise<void> {
  const clear = process.argv.includes('--clear');
  const phone = argValue('--phone');
  const person = argValue('--person');

  const before = await getGlobalSupportContact();
  console.log(`Сейчас: ${describe(before)}`);

  if (!clear && phone === null && person === null) {
    console.log('Ничего не меняю: не передан ни --phone, ни --person, ни --clear.');
    return;
  }

  const next = clear
    ? { phone: '', person: '' }
    : { phone: phone ?? before.phone, person: person ?? before.person };

  const after = await setGlobalSupportContact(next);
  console.log(`Записано: ${describe(after)}`);
  console.log('Клиенты подхватят значение при следующем показе окна приветствия (перезапуск не нужен).');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
