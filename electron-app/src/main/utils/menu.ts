import type { MenuItemConstructorOptions } from 'electron';
import { Menu, app, dialog } from 'electron';
import { checkForUpdates, downloadUpdate, quitAndInstall } from '../services/updateService.js';
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
          label: 'Проверить обновления',
          click: async () => {
            const r = await checkForUpdates();
            await dialog.showMessageBox({
              type: r.ok ? 'info' : 'error',
              title: 'Обновление',
              message: r.ok
                ? r.updateAvailable
                  ? `Доступно обновление: ${r.version ?? ''}`
                  : 'Обновлений нет'
                : 'Ошибка проверки обновлений',
              detail: r.ok ? '' : r.error,
            });
          },
        },
        {
          label: 'Скачать обновление',
          click: async () => {
            const r = await downloadUpdate();
            await dialog.showMessageBox({
              type: r.ok ? 'info' : 'error',
              title: 'Обновление',
              message: r.ok ? 'Обновление скачано' : 'Ошибка скачивания обновления',
              detail: r.ok ? 'Нажмите “Установить обновление”.' : r.error,
            });
          },
        },
        {
          label: 'Установить обновление и перезапустить',
          click: async () => {
            await quitAndInstall();
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}


