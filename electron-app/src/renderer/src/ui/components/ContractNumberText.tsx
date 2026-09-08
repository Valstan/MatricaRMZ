import React from 'react';

import { splitContractNumberAccent } from '@matricarmz/shared';

/**
 * Номер договора с выделенными тремя цифрами (владелец 08.09.2026). Это те же цифры, по
 * которым договор зовут в цеху и которые печатаются коротким номером `*239`; в полном
 * номере из двух десятков цифр глаз их без выделения не находит.
 *
 * Компонент, а не строка со звёздочками: выделение — оформление, и подмешивать разметку
 * в само значение нельзя (оно уедет в поиск, печать и выгрузку как есть).
 */
export function ContractNumberText(props: { value: string | null | undefined; fallback?: string }) {
  const raw = String(props.value ?? '').trim();
  if (!raw) return <>{props.fallback ?? ''}</>;
  const { before, accent, after } = splitContractNumberAccent(raw);
  if (!accent) return <>{raw}</>;
  return (
    <span data-contract-number title={raw}>
      {before}
      <b data-contract-number-accent style={{ fontWeight: 800 }}>
        {accent}
      </b>
      {after}
    </span>
  );
}
