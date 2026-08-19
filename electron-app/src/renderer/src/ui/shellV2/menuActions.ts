export type ActionButtonId =
  | 'theme'
  | 'decor'
  | 'palette'
  | 'tablet_mode'
  | 'search'
  | 'basket'
  | 'column_mode'
  | 'chat_link'
  | 'notes_link'
  | 'program_feedback'
  | 'sync'
  | 'user'
  | 'ai_chat'
  | 'chat';

export type ActionButtonDescriptor = {
  id: ActionButtonId;
  label: string;
  icon: string;
  group: 'appearance' | 'tools_menu' | 'communication' | 'account';
};

export const ACTION_BUTTONS: ActionButtonDescriptor[] = [
  { id: 'theme', label: 'Тема', icon: '🌗', group: 'appearance' },
  { id: 'tablet_mode', label: 'Планшет', icon: '📱', group: 'appearance' },
  { id: 'decor', label: 'Оформление', icon: '❀', group: 'appearance' },
  { id: 'palette', label: 'Палитра', icon: '🎨', group: 'appearance' },
  { id: 'search', label: 'Поиск', icon: '🔍', group: 'tools_menu' },
  { id: 'basket', label: 'Корзина', icon: '🗑', group: 'tools_menu' },
  { id: 'column_mode', label: 'Колонки', icon: '▤', group: 'tools_menu' },
  { id: 'sync', label: 'Синхронизация', icon: '↻', group: 'tools_menu' },
  { id: 'chat_link', label: 'Ссылка в чат', icon: '💬', group: 'tools_menu' },
  { id: 'notes_link', label: 'Ссылка в заметки', icon: '📝', group: 'tools_menu' },
  { id: 'program_feedback', label: 'Правка программы', icon: '✏️', group: 'communication' },
  { id: 'chat', label: 'Чат', icon: '💬', group: 'communication' },
  { id: 'ai_chat', label: 'ИИваныч', icon: '🤖', group: 'communication' },
  { id: 'user', label: 'Профиль', icon: '👤', group: 'account' },
];

export const ACTION_GROUP_LABELS: Record<string, string> = {
  appearance: 'Оформление',
  tools_menu: 'Сервис',
  communication: 'Общение',
  account: 'Аккаунт',
};

export const ACTION_GROUP_ORDER: string[] = ['appearance', 'tools_menu', 'communication', 'account'];
