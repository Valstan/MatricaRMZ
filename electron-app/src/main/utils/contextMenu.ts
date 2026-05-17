import { BrowserWindow, Menu } from 'electron';

export function registerInputContextMenu(mainWindow: BrowserWindow) {
  mainWindow.webContents.on('context-menu', (event, params) => {
    const canCopy = Boolean(params.editFlags.canCopy);
    const canPaste = Boolean(params.editFlags.canPaste);
    if (!params.isEditable && !canCopy) return;

    event.preventDefault();
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: 'Копировать',
        role: 'copy',
        enabled: canCopy,
      },
    ];
    if (params.isEditable) {
      template.push({
        label: 'Вставить',
        role: 'paste',
        enabled: canPaste,
      });
    }

    const menu = Menu.buildFromTemplate(template);
    menu.popup({
      window: mainWindow,
      callback: () => {
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.focus();
        }
      },
    });
  });
}

