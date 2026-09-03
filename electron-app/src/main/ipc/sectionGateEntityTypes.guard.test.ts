/**
 * Ключи клиентского гейта разделов — реальные имена типов сущностей.
 *
 * Опечатка в этой карте не ломает ничего заметного: незамапленный тип гейт
 * пропускает (это осознанный fail-open для lookup-справочников). Поэтому ключ
 * `counterparty`, которого в базе нет вовсе, тихо отключал гейт на карточках
 * контрагентов — viewer раздела «Договоры» правил их беспрепятственно, — и
 * заметить это можно было только сверкой с серверной картой.
 *
 * Сторож сверяет: каждый ключ клиентской карты либо есть в серверной
 * (LEDGER_SECTION_BY_ENTITY_TYPE — она перечисляет настоящие коды типов), либо
 * назван клиент-специфичным явно. И для общих ключей раздел обязан совпадать:
 * две карты об одном не имеют права отвечать по-разному.
 */
import { describe, expect, it } from 'vitest';

import { LEDGER_SECTION_BY_ENTITY_TYPE } from '@matricarmz/shared';

import { CLIENT_ONLY_GATED_ENTITY_TYPES, ENTITY_TYPE_SECTION } from './sectionGate.js';

describe('карта типов клиентского гейта разделов', () => {
  it('не содержит имён, которых нет ни на сервере, ни в списке клиент-специфичных', () => {
    const serverTypes = new Set(Object.keys(LEDGER_SECTION_BY_ENTITY_TYPE));
    const clientOnly = new Set(CLIENT_ONLY_GATED_ENTITY_TYPES);
    const unknown = Object.keys(ENTITY_TYPE_SECTION).filter((code) => !serverTypes.has(code) && !clientOnly.has(code));
    expect(unknown).toEqual([]);
  });

  it('для общих типов раздел совпадает с серверным', () => {
    const mismatched: Array<{ code: string; client: string; server: string }> = [];
    for (const [code, section] of Object.entries(ENTITY_TYPE_SECTION)) {
      const server = LEDGER_SECTION_BY_ENTITY_TYPE[code];
      if (server && String(server) !== String(section)) {
        mismatched.push({ code, client: String(section), server: String(server) });
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('контрагенты гейтятся под тем именем, под которым они существуют', () => {
    // Именно этот случай и был сломан: карточки контрагентов проходили мимо гейта.
    expect(ENTITY_TYPE_SECTION.customer).toBe('contracts');
    expect(ENTITY_TYPE_SECTION.counterparty).toBeUndefined();
  });

  it('список клиент-специфичных типов не разрастается молча', () => {
    // Каждый элемент — исключение из сверки, и его стоимость видна только списком.
    expect([...CLIENT_ONLY_GATED_ENTITY_TYPES]).toEqual(['engine_brand_group']);
  });
});
