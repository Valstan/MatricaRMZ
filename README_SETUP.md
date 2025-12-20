# Инструкция по установке и запуску MatricaRMZ

## Текущее состояние проекта

✅ **Готово:**
- Монорепо настроен (pnpm workspaces)
- Схемы БД созданы (SQLite для клиента, PostgreSQL для сервера)
- Backend API реализован (синхронизация push/pull)
- Electron приложение с UI готово
- Все собирается и проходит линт

⚠️ **Требует настройки:**
- Подключение к PostgreSQL на VPS (нужен правильный пароль)
- Запуск backend API на VPS
- Сборка Electron приложения для Windows
- Настройка Electron на подключение к backend

---

## Шаг 1: Настройка PostgreSQL на VPS

### 1.1. ✅ Уже настроено!

Пользователь PostgreSQL `valstan` создан с паролем `matricarmz2024`.
Файл `.env` уже настроен с правильными учетными данными.

**Если нужно изменить пароль:**
```bash
sudo -u postgres psql -c "ALTER USER valstan PASSWORD 'новый_пароль';"
# Затем обновите /home/valstan/MatricaRMZ/backend-api/.env
```

### 1.3. Применить миграции

```bash
cd /home/valstan/MatricaRMZ/backend-api
pnpm run db:migrate
```

Должно вывести: `[backend-api] migrations applied`

---

## Шаг 2: Запуск Backend API на VPS

### 2.1. Запуск в режиме разработки (для тестирования)

```bash
cd /home/valstan/MatricaRMZ/backend-api
pnpm run dev
```

Backend будет доступен на `http://a6fd55b8e0ae.vps.myjino.ru:3001`

### 2.2. Проверка работы

В другом терминале:
```bash
curl http://localhost:3001/health
```

Должен вернуть: `{"ok":true}`

### 2.3. Запуск в production (через PM2 или systemd)

**Вариант A: PM2 (рекомендуется)**
```bash
# Установить PM2 глобально
npm install -g pm2

# Запустить backend
cd /home/valstan/MatricaRMZ/backend-api
pnpm run build
pm2 start dist/index.js --name matricarmz-api

# Автозапуск при перезагрузке
pm2 startup
pm2 save
```

**Вариант B: systemd service**
Создайте файл `/etc/systemd/system/matricarmz-api.service`:
```ini
[Unit]
Description=MatricaRMZ Backend API
After=network.target postgresql.service

[Service]
Type=simple
User=valstan
WorkingDirectory=/home/valstan/MatricaRMZ/backend-api
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/index.js
Restart=always

[Install]
WantedBy=multi-user.target
```

Затем:
```bash
sudo systemctl daemon-reload
sudo systemctl enable matricarmz-api
sudo systemctl start matricarmz-api
```

---

## Шаг 3: Сборка Electron приложения

### 3.1. На VPS (Linux, для тестирования)

```bash
cd /home/valstan/MatricaRMZ/electron-app
pnpm run build
```

Собранные файлы будут в `dist/`

### 3.2. Для Windows (на вашем компьютере)

**Вариант A: Скачать исходники и собрать локально**

1. Установите на Windows:
   - Node.js (v22+)
   - pnpm: `npm install -g pnpm`
   - Git

2. Клонируйте/скачайте проект:
```bash
git clone <ваш_репозиторий> # или скачайте архив
cd MatricaRMZ
pnpm install
```

3. Настройте URL backend API:
   - Отредактируйте `electron-app/src/main/index.ts`
   - Измените строку 50:
   ```typescript
   const apiBaseUrl = process.env.MATRICA_API_URL ?? 'http://a6fd55b8e0ae.vps.myjino.ru:3001';
   ```

4. Соберите приложение:
```bash
cd electron-app
pnpm run build
pnpm run dist  # Создаст установщик для Windows
```

Установщик будет в `electron-app/release/`

**Вариант B: Собрать на VPS и скачать**

Если на VPS есть возможность собрать для Windows (нужен wine или cross-compile):

```bash
cd /home/valstan/MatricaRMZ/electron-app
# Настроить apiBaseUrl в src/main/index.ts
pnpm run build
pnpm run dist
```

Затем скачайте файлы из `electron-app/release/` через SCP/SFTP.

---

## Шаг 4: Настройка Electron клиента

### 4.1. Указать URL backend API

В файле `electron-app/src/main/index.ts` (строка ~50):

```typescript
const apiBaseUrl = process.env.MATRICA_API_URL ?? 'http://a6fd55b8e0ae.vps.myjino.ru:3001';
```

Или через переменную окружения при запуске:
```bash
MATRICA_API_URL=http://a6fd55b8e0ae.vps.myjino.ru:3001 pnpm run dev
```

### 4.2. Запуск в режиме разработки

```bash
cd /home/valstan/MatricaRMZ/electron-app
pnpm run dev
```

---

## Шаг 5: Тестирование синхронизации

### 5.1. Запустить backend на VPS
```bash
cd /home/valstan/MatricaRMZ/backend-api
pnpm run dev
```

### 5.2. Запустить Electron приложение
```bash
cd /home/valstan/MatricaRMZ/electron-app
pnpm run dev
```

### 5.3. Проверить синхронизацию

1. В Electron приложении:
   - Откройте вкладку "Двигатели"
   - Нажмите "Добавить двигатель"
   - Введите номер и марку
   - Перейдите на вкладку "Синхронизация"
   - Нажмите "Синхронизировать сейчас"

2. Проверить в базе данных:
```bash
sudo -u postgres psql -d matricarmz -c "SELECT * FROM entities LIMIT 5;"
```

---

## ✅ Текущий статус

1. ✅ **PostgreSQL настроен** — пользователь `valstan` создан, миграции применены
2. ✅ **Backend готов** — можно запускать через `pnpm run dev`
3. ⏳ **Electron сборка для Windows** — нужно собрать на вашем компьютере
4. ⏳ **Тестирование** — готово к проверке синхронизации

---

## Следующие шаги

После того как все заработает:
- Настроить автозапуск backend через PM2/systemd
- Настроить firewall для доступа к порту 3001 (если нужно)
- Создать релиз Electron приложения с автообновлением через GitHub Releases
- Добавить аутентификацию пользователей (сейчас MVP без авторизации)

