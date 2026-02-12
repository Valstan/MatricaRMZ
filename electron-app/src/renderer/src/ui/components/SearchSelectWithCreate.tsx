import React from 'react';
import { SearchSelect, type SearchSelectOption } from './SearchSelect.js';

export function SearchSelectWithCreate(props: {
  value: string | null;
  options: SearchSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  canCreate?: boolean;
  createLabel: string;
  onChange: (next: string | null) => void;
  onCreate: (label: string) => Promise<string | null>;
}) {
  const searchProps = {
    value: props.value,
    options: props.options,
    onChange: props.onChange,
    ...(props.placeholder != null ? { placeholder: props.placeholder } : {}),
    ...(props.disabled != null ? { disabled: props.disabled } : {}),
    ...(props.canCreate ? { onCreate: props.onCreate } : {}),
    ...(props.createLabel ? { createLabel: props.createLabel } : {}),
  };
  return (
    <SearchSelect {...searchProps} />
  );
}
