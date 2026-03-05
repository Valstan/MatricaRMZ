# Runbook: Быстрый разбор инцидентов синхронизации

## 1) Быстрый первичный проход (5 минут)

- Проверить свежие критические события:
  - `cd /home/valstan/MatricaRMZ/backend-api`
  - `tail -n 120 logs/critical-events.ndjson | grep -E 'client.sync.pull_gateway_error|server.sync.pipeline_poll_failed|server.sync.error|server.general.error'`
- Считать инцидент каскадным, если один и тот же код повторяется очень часто в коротком интервале (например, >5 раз за 1–2 минуты).
- Если каскад есть, сразу перейти к шагу 2 и не закрывать инцидент как «одноразовый шум».

## 2) Проверить фронт и клиентов
- На клиентских окнах открыть страницу критических событий в настройках superadmin.
- Проверить коды:
  - `client.sync.pull_gateway_error`
  - `server.sync.error`
  - `server.sync.pipeline_poll_failed`
- Зафиксировать `clientId`, `username`, IP и момент времени ошибки для корреляции с сервером.

## 3) Проверить инфраструктуру и прокси
- Сопоставить время с nginx:
  - `sudo grep -n " 502 " /var/log/nginx/matricarmz_access.log | tail -n 40`
  - `sudo grep -n "connect() failed\\|no live upstreams\\|upstream temporarily disabled" /var/log/nginx/matricarmz_error.log | tail -n 60`
- Проверить состояние сервисов и слушаемые порты:
  - `systemctl is-active matricarmz-backend-primary.service matricarmz-backend-secondary.service`
  - `ss -ltnp | grep 3001`
  - `ss -ltnp | grep 3002`
- Если в системных логах были `EADDRINUSE`, проверить и остановить двойной запуск процесса на одном порту:
  - `ps aux | grep node | grep backend-api`
  - убить только лишний/зависший экземпляр и перезапустить только проблемный сервис.

## 4) Диагностика по симптомам
- `client.sync.pull_gateway_error`/`Http 502`:
  - Часто значит, что nginx не получил ответ от backend (`EADDRINUSE`, `connect() failed`, `no live upstreams`).
  - Проверить nginx config и оба инстанса: если один перезапущен, второй должен держать трафик.
  - Не перезапускать оба инстанса одновременно в окне пикового трафика.
- `server.sync.pipeline_poll_failed`:
  - Один-один раз в сети/доступе к Telegram нормально, валидация нужна, если повторяется сплошной серией.
  - Если серии идут часто, проверить `syncPipelineSupervisorService`, сеть до api.telegram.org и отсутствие второго `getUpdates`‑процесса.
- `SqliteError: too many SQL variables` на клиенте:
  - Проверить обновленный клиент и логи синка: должен уйти после последних изменений chunking и лимита `PULL_PAGE_SIZE`.

## 5) После устранения
- Сервисы:
  - `systemctl restart matricarmz-backend-primary.service` 
  - `systemctl restart matricarmz-backend-secondary.service`
  - Лучше в последовательности: primary -> дождаться health -> secondary.
- Проверить:
  - `ss -ltnp | grep -E ':3001|:3002'`
  - `tail -n 40 logs/critical-events.ndjson` — отсутствие новых `client.sync.pull_gateway_error` и резкого потока `server.sync.pipeline_poll_failed`.
- Если через 10–15 минут каскад не повторяется, инцидент считается локализованным.
