import { Menu } from 'electron';

export function setupMenu() {
  // В приложении все меню реализованы внутри окна (React UI).
  // Старое верхнее меню Electron (“Справка”, “Обновление”) убираем полностью.
  Menu.setApplicationMenu(null);
}


