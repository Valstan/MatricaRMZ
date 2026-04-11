# MCP-сервер для MatricaRMZ

## ✅ Статус: уже настроен

MCP для подключения к VPS MatricaRMZ **уже настроен** и работает.

**Конфигурация находится в:** `c:\Users\valstan\.qwen\settings.json`

**Сервер:** `sshmatricarmz`

### Рабочая конфигурация (уже добавлена)

```json
{
  "mcpServers": {
    "sshmatricarmz": {
      "command": "npx",
      "args": [
        "-y",
        "ssh-mcp",
        "--host", "a6fd55b8e0ae.vps.myjino.ru",
        "--port", "49412",
        "--user", "valstan",
        "--key", "C:\\Users\\valstan\\.ssh\\id_ed25519"
      ],
      "timeout": 120000,
      "trust": true,
      "description": "Matrix ARMZ VPS server"
    }
  }
}
```

> **Примечание:** В `settings.json` используется пробельный формат аргументов (`"--host", "value"`). Он работает в Qwen Code.

---

## Информация о сервере

| Параметр | Значение |
|----------|----------|
| SSH Host | `sshmatricarmz` |
| HostName | a6fd55b8e0ae.vps.myjino.ru |
| User | valstan |
| Port | 49412 |
| Проект | `/home/valstan/MatricaRMZ` |

### Сервисы

| Сервис | Описание |
|--------|----------|
| `matricarmz-backend-primary` | Backend API + singleton background jobs (порт 3001) |
| `matricarmz-backend-secondary` | Backend API только (порт 3002) |
| `nginx` | Reverse proxy upstream для обоих инстансов |

### Памятка по перезапуску

**Правильный порядок** (последовательно, не одновременно!):
```bash
sudo systemctl restart matricarmz-backend-primary
sleep 3
sudo systemctl restart matricarmz-backend-secondary
```

---

## Что может делать ИИ-агент через MCP

| Запрос | Пример команды на VPS |
|--------|----------------------|
| "Покажи статус сервисов" | `systemctl status matricarmz-backend-primary matricarmz-backend-secondary nginx` |
| "Задеплой изменения" | `cd /home/valstan/MatricaRMZ && git pull --rebase origin main && pnpm install && pnpm --filter @matricarmz/shared build && pnpm --filter @matricarmz/backend-api build && sudo systemctl restart matricarmz-backend-primary && sleep 3 && sudo systemctl restart matricarmz-backend-secondary` |
| "Перезапусти primary" | `sudo systemctl restart matricarmz-backend-primary` |
| "Покажи логи backend" | `sudo journalctl -u matricarmz-backend-primary -n 200 --no-pager` |
| "Проверь здоровье" | `curl -s http://127.0.0.1:3001/health` |
| "Покажи git status" | `cd /home/valstan/MatricaRMZ && git status` |
| "Место на диске" | `df -h /` |

---

## Troubleshooting

| Ошибка | Решение |
|--------|---------|
| `SSH exec error: No response from server` | Временный сбой сети, повторите вызов |
| `Permission denied (publickey)` | Проверьте что ключ `id_ed25519` существует и добавлен на VPS |
| MCP не отвечает | Перезапустите VS Code полностью |

### Проверка SSH вручную

```powershell
ssh sshmatricarmz "echo OK"
```

Или напрямую:

```powershell
ssh -p 49412 valstan@a6fd55b8e0ae.vps.myjino.ru "echo OK"
```
