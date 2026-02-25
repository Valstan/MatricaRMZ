import { Button } from './Button.js';

export function ListColumnsToggle(props: {
  isMultiColumn: boolean;
  onToggle: () => void;
}) {
  const label = props.isMultiColumn ? '1 колонка' : 'Авто-колонки';
  const title = props.isMultiColumn ? 'Переключить в одноколоночный режим' : 'Переключить в многоколоночный режим';

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
