import { BrowserWindow, Menu } from 'electron';

export function registerInputContextMenu(mainWindow: BrowserWindow) {
  mainWindow.webContents.on('context-menu', (event, params) => {
    if (!params.isEditable) return;

    event.preventDefault();
    const menu = Menu.buildFromTemplate([
      {
        label: 'Копировать',
        role: 'copy',
        enabled: Boolean(params.editFlags.canCopy),
      },
      {
        label: 'Вставить',
        role: 'paste',
        enabled: Boolean(params.editFlags.canPaste),
      },
    ]);

    menu.popup({ window: mainWindow });
  });
}

