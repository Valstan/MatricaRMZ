# Настройка MCP (ssh-mcp) на Windows 11 для Cursor

Краткий путеводитель по настройке MCP-сервера для управления удалённым VPS из Cursor на Windows 11.

## 1. Предварительные требования

- **Node.js 22+** установлен и доступен в PATH (`node --version`)
- **SSH-ключ** для доступа к VPS (обычно `C:\Users\<USER>\.ssh\id_rsa`)
- **Cursor** последней версии

Если SSH-ключа ещё нет:

```powershell
ssh-keygen -t rsa -b 4096 -f "$env:USERPROFILE\.ssh\id_rsa"
```

Публичный ключ (`id_rsa.pub`) должен быть добавлен на VPS в `~/.ssh/authorized_keys`.

Проверка подключения:

```powershell
ssh -p 49412 valstan@a6fd55b8e0ae.vps.myjino.ru "echo OK"
```

## 2. Конфигурация MCP

Файл: `C:\Users\<USER>\.cursor\mcp.json`

```json
{
  "mcpServers": {
    "vps-matricarmz": {
      "command": "npx",
      "args": [
        "-y",
        "ssh-mcp",
        "--host=a6fd55b8e0ae.vps.myjino.ru",
        "--port=49412",
        "--user=valstan",
        "--key=C:\\Users\\<USER>\\.ssh\\id_rsa",
        "--timeout=120000"
      ]
    }
  }
}
```

Замените `<USER>` на имя пользователя Windows.

## 3. КРИТИЧНО: формат аргументов

### `--key=value` (через знак `=`) — РАБОТАЕТ

```json
"args": ["--host=example.com", "--user=valstan"]
```

### `--key value` (через пробел) — НЕ РАБОТАЕТ

```json
"args": ["--host", "example.com", "--user", "valstan"]
```

`ssh-mcp` на Windows не парсит пробельный формат — все значения станут пустыми, и вы получите:

```
Error: Configuration error:
Missing required --host
Missing required --user
```

Это главная ловушка. AI-ассистенты по умолчанию генерируют пробельный формат.

## 4. Проверка

1. Откройте Cursor Settings → MCP
2. Найдите `vps-matricarmz`
3. Статус должен быть **зелёный** (enabled)
4. Если красный — нажмите Restart, подождите ~5 секунд

Если после рестарта всё ещё красный — проверьте лог:

```
%APPDATA%\Cursor\logs\<session>\<window>\exthost\anysphere.cursor-mcp\MCP user-vps-matricarmz.log
```

## 5. Частые ошибки и решения

| Ошибка | Причина | Решение |
|--------|---------|---------|
| `Missing required --host` / `--user` | Аргументы через пробел вместо `=` | Используйте `--host=value` формат |
| `SSH exec error: No response from server` | Таймаут SSH-соединения, VPS перегружен | Повторите вызов; при повторении — увеличьте `--timeout` |
| `ENOENT` при запуске | `npx` не найден | Убедитесь, что Node.js в PATH; перезапустите Cursor |
| `Permission denied (publickey)` | Ключ не добавлен на VPS | Добавьте `id_rsa.pub` в `~/.ssh/authorized_keys` на VPS |
| Cursor завис при подключении | Первый запуск `npx -y ssh-mcp` качает пакет | Подождите 10–15 секунд, npx кэширует пакет |

## 6. Доступные инструменты

После подключения MCP предоставляет 2 инструмента:

- **`exec`** — выполнить команду на VPS от имени `valstan`
- **`sudo-exec`** — выполнить команду с `sudo`

Пример вызова (для AI-ассистента):

```
CallMcpTool server="user-vps-matricarmz" toolName="exec"
  arguments: {"command": "uptime", "description": "Check VPS uptime"}
```

## 7. Памятка для AI-ассистента

**При настройке MCP на Windows:**

1. НЕ используйте пробельный формат аргументов (`"--host", "value"`). Только `"--host=value"`.
2. Путь к ключу: двойные обратные слэши в JSON (`C:\\Users\\...`).
3. После создания/редактирования `mcp.json` — рестартните MCP-сервер через Cursor Settings → MCP → Restart.
4. Не пытайтесь диагностировать через `npx ssh-mcp` в терминале — пакет работает только как stdio MCP-сервер, он не выводит ничего полезного вне Cursor.
5. Если `MCP error -32603: SSH exec error: No response from server` — это обычно временный сбой сети. Просто повторите вызов.
6. Таймаут 120000 мс (2 минуты) достаточен для большинства команд. Для длинных операций (сборка, миграция) увеличьте до 300000.
