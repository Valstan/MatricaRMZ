import React from 'react';
import { SearchSelect, type SearchSelectOption } from './SearchSelect.js';

export function SearchSelectWithCreate(props: {
  value: string | null;
  options: SearchSelectOption[];
  disabled?: boolean;
  canCreate?: boolean;
  createLabel: string;
  onChange: (next: string | null) => void;
  onCreate: (label: string) => Promise<string | null>;
}) {
  return (
    <SearchSelect
      value={props.value}
      options={props.options}
      disabled={props.disabled}
      onChange={props.onChange}
      onCreate={props.canCreate ? props.onCreate : undefined}
      createLabel={props.createLabel}
    />
  );
}
