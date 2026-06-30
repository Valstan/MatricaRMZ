import { Button } from './Button.js';

export function ListColumnsToggle(props: {
  isMultiColumn: boolean;
  onToggle: () => void;
}) {
  const currentMode = props.isMultiColumn ? 'Компактный' : 'Один столбец';
  const nextMode = props.isMultiColumn ? 'Один столбец' : 'Компактный';
  const label = `Режим: ${currentMode}`;
  const title = `Переключить в режим "${nextMode}"`;

  return (
    <Button
      variant="ghost"
      onClick={props.onToggle}
      title={title}
      style={{ whiteSpace: 'nowrap' }}
    >
      {label}
    </Button>
  );
}
