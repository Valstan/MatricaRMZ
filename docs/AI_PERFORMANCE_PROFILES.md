# AI Performance Profiles (Ollama)

Ниже профили для сервера класса **2 vCPU / 8GB RAM / без GPU**.

## Что показала проверка
- Установлена только модель `qwen3:8b`.
- Запросы к `qwen3:8b` падают: `llama runner process has terminated: signal: killed` (не хватает памяти).
- `qwen2.5:3b` не установлена (`404 model not found`).

Перед применением профилей:

```bash
ollama pull qwen2.5:1.5b
ollama pull qwen2.5:3b
```

## Профили для `backend-api/.env`

Можно включить профиль одной переменной:

```env
AI_PROFILE=fast
```

Поддерживаются значения: `fast`, `balanced`, `quality`.
При этом любые отдельные переменные (`OLLAMA_TIMEOUT_*`, `AI_CHAT_MAX_RESPONSE_TOKENS`, `AI_RAG_TOP_K`, модели) можно вручную переопределить в `.env`.

### FAST (максимальная скорость)
```env
AI_PROFILE=fast
OLLAMA_MODEL=qwen2.5:1.5b
OLLAMA_MODEL_CHAT=qwen2.5:1.5b
OLLAMA_MODEL_ANALYTICS=qwen2.5:1.5b
OLLAMA_TIMEOUT_MS=30000
OLLAMA_TIMEOUT_CHAT_MS=10000
OLLAMA_TIMEOUT_ANALYTICS_MS=20000
AI_CHAT_MAX_RESPONSE_TOKENS=96
AI_RAG_TOP_K=2
```

### BALANCED (рекомендуется для вашего хоста)
```env
AI_PROFILE=balanced
OLLAMA_MODEL=qwen2.5:3b
OLLAMA_MODEL_CHAT=qwen2.5:1.5b
OLLAMA_MODEL_ANALYTICS=qwen2.5:3b
OLLAMA_TIMEOUT_MS=60000
OLLAMA_TIMEOUT_CHAT_MS=18000
OLLAMA_TIMEOUT_ANALYTICS_MS=45000
AI_CHAT_MAX_RESPONSE_TOKENS=160
AI_RAG_TOP_K=3
```

### QUALITY (лучше ответы, медленнее)
```env
AI_PROFILE=quality
OLLAMA_MODEL=qwen2.5:3b
OLLAMA_MODEL_CHAT=qwen2.5:3b
OLLAMA_MODEL_ANALYTICS=qwen2.5:3b
OLLAMA_TIMEOUT_MS=90000
OLLAMA_TIMEOUT_CHAT_MS=30000
OLLAMA_TIMEOUT_ANALYTICS_MS=70000
AI_CHAT_MAX_RESPONSE_TOKENS=256
AI_RAG_TOP_K=4
```

## Практический совет
- Для текущего железа избегайте `qwen3:8b` в online-path.
- Если хотите стабильный `QUALITY`, добавьте swap (минимум 4-8GB), иначе будут sporadic OOM при пиках.
