import type { MenuItemConstructorOptions } from 'electron';
import { Menu, app, dialog } from 'electron';

export function setupMenu() {
  const releaseDate = process.env.MATRICA_RELEASE_DATE ?? 'unknown';
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Справка',
      submenu: [
        {
          label: 'О программе',
          click: async () => {
            await dialog.showMessageBox({
              type: 'info',
              title: 'О программе',
              message: 'Матрица РМЗ',
              detail: `Версия: ${app.getVersion()}\nДата релиза: ${releaseDate}`,
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}


