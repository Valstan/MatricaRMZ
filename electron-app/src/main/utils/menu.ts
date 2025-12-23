import type { MenuItemConstructorOptions } from 'electron';
import { Menu, app, dialog } from 'electron';
import { checkForUpdates, runAutoUpdateFlow } from '../services/updateService.js';
import { getReleaseDate } from './releaseInfo.js';

export function setupMenu() {
  const releaseDate = getReleaseDate();
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
    {
      label: 'Обновление',
      submenu: [
        {
          label: 'Проверить и обновить',
          click: async () => {
            const r = await checkForUpdates();
            if (!r.ok) {
              await dialog.showMessageBox({
                type: 'error',
                title: 'Обновление',
                message: 'Ошибка проверки обновлений',
                detail: r.error,
              });
              return;
            }
            if (!r.updateAvailable) {
              await dialog.showMessageBox({ type: 'info', title: 'Обновление', message: 'Обновлений нет' });
              return;
            }
            await runAutoUpdateFlow({ reason: 'manual_menu' });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}


