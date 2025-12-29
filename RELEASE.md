# Релизы MatricaRMZ (единая версия клиента + бэкенда)

## Формат версии

Версия хранится в формате **MAJOR.MINOR.RELEASE**.

- **RELEASE** — монотонный счётчик релизов (увеличивается *на каждом* выпуске и **не сбрасывается** при росте MAJOR/MINOR).
- **MINOR** повышаем при заметных функциональных/UX-изменениях без «ломания» совместимости.
- **MAJOR** повышаем при несовместимых изменениях (когда нужен обязательный апдейт).

Источник истины: файл `VERSION` в корне репозитория.

## Как выпускаем новую версию

1. Поднимаем версию через скрипт (он обновит `VERSION` и версии во всех пакетах):
   - обычный релиз: `pnpm version:bump`
   - минорный релиз: `pnpm version:bump:minor`
   - мажорный релиз: `pnpm version:bump:major`
2. Делаем коммит.
3. Создаем тег вида `vX.Y.Z` (например `v0.1.53`) и пушим его в GitHub.
4. GitHub Actions соберёт Windows установщик и загрузит файлы в GitHub Releases.

## Правило: команда “выпусти новый релиз”

Если в задаче/чате написано **«выпусти новый релиз»**, выполняем чек‑лист:

1. **Определить тип релиза и поднять версию**
   - решить: `patch` / `minor` / `major` (по правилам выше)
   - выполнить bump:
     - `pnpm version:bump` (patch)
     - `pnpm version:bump:minor`
     - `pnpm version:bump:major`
   - сделать commit, где в сообщении есть версия (`v$(cat VERSION)`).

2. **Обновить и перезапустить бэкенд (VPS/прод)**
   - обновить код (обычно `git pull`)
   - `pnpm install`
   - `pnpm -C shared build`
   - `pnpm -C backend-api build`
   - перезапустить backend (зависит от того, чем управляем процессом):
     - systemd: `sudo systemctl restart <service-name>`
     - pm2: `pm2 restart <name>`
     - вручную: остановить старый процесс и запустить `pnpm -C backend-api start`

3. **Выпустить новый релиз клиента**
   - создать тег `vX.Y.Z` (равный `VERSION`) и запушить его
   - дождаться GitHub Actions (Release Electron) — он опубликует релиз и обновления (включая Яндекс.Диск).

4. **Запушить на GitHub**
   - `git push origin main --tags`

## Команды

```bash
cd /home/valstan/MatricaRMZ

# пример: минорный релиз (MINOR+1, RELEASE+1)
pnpm version:bump:minor

git add VERSION electron-app/package.json backend-api/package.json shared/package.json
git commit -m "release: v$(cat VERSION)"

git tag "v$(cat VERSION)"
git push origin main --tags
```

## Автообновление

Обновление клиента идёт через **Яндекс.Диск (public folder)**:
- клиент при запуске проверяет обновления;
- пользователь может вручную запустить проверку через меню: **«Обновление → Проверить и обновить»**.

`release-info.json` формируется в GitHub Actions (шаг `Write release-info.json`) и упаковывается в приложение.


