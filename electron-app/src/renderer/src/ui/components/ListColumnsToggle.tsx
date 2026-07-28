import { Button } from './Button.js';

export function ListColumnsToggle(props: {
  isMultiColumn: boolean;
  onToggle: () => void;
}) {
  const currentMode = props.isMultiColumn ? 'Компактный' : 'Один столбец';
  const nextMode = props.isMultiColumn ? 'Один столбец' : 'Компактный';
  const title = `Режим списков: ${currentMode}. Переключить в "${nextMode}"`;

  return (
    <Button
      variant="ghost"
      onClick={props.onToggle}
      title={title}
      aria-label={`Режим: ${currentMode}`}
      style={{ whiteSpace: 'nowrap' }}
    >
      {props.isMultiColumn ? '▥' : '▤'}
      <span data-hdr-label="8">{` Режим: ${currentMode}`}</span>
    </Button>
  );
}
