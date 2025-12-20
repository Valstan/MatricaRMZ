# Релизы Windows-клиента (MatricaRMZ)

## Как выпускаем новую версию

1. Меняем версию в `electron-app/package.json` (поле `version`).
2. Делаем коммит.
3. Создаем тег вида `vX.Y.Z` (например `v0.0.2`) и пушим его в GitHub.
4. GitHub Actions соберет Windows установщик и загрузит файлы в GitHub Releases автоматически.

## Команды

```bash
cd /home/valstan/MatricaRMZ

# пример: поднять версию вручную
# (правим electron-app/package.json, затем:)
git add electron-app/package.json
git commit -m "release: v0.0.2"

git tag v0.0.2
git push origin main --tags
```

## Автообновление

В приложении используется `electron-updater`. После публикации релиза в GitHub Releases:
- клиент при запуске проверяет обновления;
- пользователь может нажать “Проверить/Скачать/Установить” в UI (вкладка “Синхронизация”).

Позже можно включить авто-скачивание и авто-установку (без кнопок).


