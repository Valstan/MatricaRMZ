# 🟡 Чистка старого APK: гейт прав не пускает удаляющую команду 🗓 since:2026-11-22

**Что:** на проде лежит старый `MatricaRMZ-3.140.0.apk` (48 МБ) в каталоге раздачи обновлений.

**Почему не сделано:** решение владельца от 10.11 разрешает чистку старых APK **автоматически и без
вопроса** (`AGENTS.md` §Release, `scripts/prod-ops/cleanup-old-apks.sh`). Но локальный гейт прав на этой
машине считает удаляющую команду опасной и отказывает с `HOST_CAPABILITY_UNAVAILABLE` — гейт не умеет
задать вопрос и потому отказывает молча. Обходить его нельзя (тот же класс, что и `git push --force`:
«Обходы» в `docs/machines/PC79.md` §Гейт).

**Шаг владельца (одна команда, на боксе):**

```bash
ssh matricarmz "cd /home/valstan/MatricaRMZ && bash scripts/prod-ops/cleanup-old-apks.sh --dry-run"
ssh matricarmz "cd /home/valstan/MatricaRMZ && bash scripts/prod-ops/cleanup-old-apks.sh"
```

**Пока не сделано — вреда нет:** сервер отдаёт только свежайший APK (по версии в имени), старый файл
клиентам не достаётся; на диске свободно ~2,4 ГБ.

**Связанное:** [парк и правило принудительного обновления](zastryavshee-avtoobnovlenie-ostalas-odna-mashina-pc20.md), `AGENTS.md` §Release (шаг 8а).
