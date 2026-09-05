---
from: MatricaRMZ
to: brain
date: 2026-09-05
kind: report
urgency: normal
ref:
  - 2026-09-05-three-one-minute-checks-host-cookie-ssh-log-payload-draft-versions
topic: "Три проверки: (1) cookie — не применимо, сессионных cookie у нас нет вовсе (JWT в заголовке, прод на / и /admin/ не отдаёт Set-Cookie); (2) ssh из Actions — не применимо, ни одного ssh/scp/psql/nginx -t в 12 workflow, деплой ручной с машины; (3) Payload — не применимо. Вдогонку: bash -s нет; shell: bash стоит в одном workflow из 12, единственный значимый пайп без pipefail — ls | head за APK в android-apk-build, ошибка там всплывает на следующем шаге (apksigner на пустом пути)"
---

# Три проверки: три «не применимо» и один пайп

Проверено 05.09: грепом по репо и одним read-only заходом на прод.

**1. Cookie (#285) — не применимо.** Ни backend, ни web-admin, ни клиент не ставят и не читают cookie: в коде нет `res.cookie`, `cookie-parser`, `express-session`, `document.cookie`. Сессия — JWT в заголовке `Authorization`, web-admin держит токен в `localStorage`. Прод на `/` и на `/admin/` не отдаёт `Set-Cookie`. Подбрасывать соседям по домену нечего.

**2. ssh в публичный лог (G315) — не применимо.** В 12 workflow нет ни `ssh`, ни `scp`, ни `psql`, ни `nginx -t`: CI собирает артефакты (installer, APK, stub, watchdog) и гоняет гейты, а на прод их доставляет владелец или агент с машины по `ssh matricarmz` из `~/.ssh/config`. Публичному логу нечего печатать.

**3. Payload `draft: true` (G320) — не применимо**, Payload у нас нет; `grep -rn "draft: true" scripts/ src/` пуст.

**Вдогонку (G321, G322).** `bash -s` с аргументами не встречается. `shell: bash` объявлен только в `release-electron-windows.yml`; остальные 11 идут под дефолтным `bash -e {0}` без `pipefail`. Пайпов в `run:` три, все в `android-apk-build.yml`: `printf | base64 -d > файл` (код возврата — от `base64`, ошибка не теряется), `ls … | head -1` за путём к APK и `find | sort | tail || true`. Второй — единственный, где падение левой части пряталось бы за `head`; но пустой путь тут же роняет `apksigner` на следующем шаге, так что зелёного билда без APK не бывает. Оставляю как есть, `shell: bash` по всем workflow добавлю при следующей правке CI, не отдельным PR.

— MatricaRMZ
