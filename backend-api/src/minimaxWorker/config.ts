// Настройки воркера MiniMax (промт КАРМАНА #56, план #57).
//
// Воркер живёт на боксе «Матрицы РМЗ» отдельным systemd-юнитом и говорит с
// бэкендом по Anthropic-совместимому `/v1/messages` — контракт ИИваныча при
// этом не меняется (правки только в транспорте).
//
// Секреты в конфиг не вшиваются: адрес и токен пула приходят из env, а токен
// с правом записи берётся из комнаты КАРМАНА (тот же приём, что у `MAX_ALERT_TOKEN`:
// комната — сейф, бокс в неё пишущим правом не входит).

export type MinimaxWorkerConfig = {
  /** Порт локального эндпойнта воркера (наружу не выставляется — только 127.0.0.1). */
  port: number;
  host: string;
  /** Токен доступа к самому воркеру: защищает локальный эндпойнт от соседей по хосту. */
  serviceToken: string;
  /** Базовый адрес ручек пула Кармана (`…/api/minimax`). Пусто — пул не настроен. */
  karmanApiBase: string;
  /** Токен пула из env. Пусто — берём из комнаты (сервисный грант). */
  karmanToken: string;
  /** Ключ токена пула в комнате Кармана. */
  karmanTokenVaultKey: string;
  /** Разметка потребителя для аудита Кармана (`X-MiniMax-Project` / `X-MiniMax-Area`). */
  project: string;
  area: string;
  /** Путь к CLI MiniMax Code на боксе. */
  cli: string;
  /** Модель агента в формате `провайдер/модель` — как требует CLI. */
  model: string;
  /** Каталог профилей аккаунтов (внутри — конфиг CLI и токен-стор). */
  accountsDir: string;
  /** Режим контекста CLI: `standard` — агент видит вложенные файлы. */
  cliMode: string;
  /** Таймаут одного вызова CLI, секунд. */
  timeoutSec: number;
  /** Сколько шагов агента разрешаем. */
  maxSteps: number;
  /** Потолок кучи V8 для CLI — на боксе 1536 МБ без него ядро снимает крупнейший процесс. */
  maxOldSpaceMb: number;
};

const SECRETS_URL_SUFFIX = '/api/secrets';

function envText(env: NodeJS.ProcessEnv, name: string): string {
  return String(env[name] ?? '').trim();
}

function envNum(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = envText(env, name);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Базовый адрес ручек пула.
 *
 * Явный `KARMAN_MINIMAX_API_URL` важнее вывода из `SECRETS_VAULT_URL`: адрес
 * сервиса в репозитории не хранится, и вывод из адреса хранилища — это лишь
 * запасной путь (как в «Сарафане»).
 */
export function resolveKarmanApiBase(env: NodeJS.ProcessEnv): string {
  const explicit = envText(env, 'KARMAN_MINIMAX_API_URL').replace(/\/+$/, '');
  if (explicit) return explicit;
  const vault = envText(env, 'SECRETS_VAULT_URL').replace(/\/+$/, '');
  if (!vault) return '';
  if (vault.endsWith(SECRETS_URL_SUFFIX)) {
    return `${vault.slice(0, -SECRETS_URL_SUFFIX.length)}/api/minimax`;
  }
  return `${vault}/minimax`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MinimaxWorkerConfig {
  return {
    port: envNum(env, 'MATRICA_MINIMAX_WORKER_PORT', 3010),
    host: envText(env, 'MATRICA_MINIMAX_WORKER_HOST') || '127.0.0.1',
    serviceToken: envText(env, 'MATRICA_MINIMAX_WORKER_TOKEN') || 'minimax-worker-local',
    karmanApiBase: resolveKarmanApiBase(env),
    karmanToken: envText(env, 'KARMAN_MINIMAX_TOKEN'),
    karmanTokenVaultKey: envText(env, 'KARMAN_MINIMAX_TOKEN_KEY') || 'KARMAN_MINIMAX_TOKEN',
    project: envText(env, 'MINIMAX_PROJECT') || 'matricarmz',
    area: envText(env, 'MINIMAX_AREA') || 'iivanych',
    cli: envText(env, 'MINIMAX_CLI') || 'mcode',
    model: envText(env, 'MINIMAX_MODEL') || 'minimax/MiniMax-M3.1-Flash',
    accountsDir: envText(env, 'MINIMAX_ACCOUNTS_DIR') || '/opt/minimax-accounts',
    cliMode: envText(env, 'MINIMAX_CLI_MODE') || 'standard',
    timeoutSec: envNum(env, 'MINIMAX_TIMEOUT', 120),
    maxSteps: envNum(env, 'MINIMAX_MAX_STEPS', 6),
    maxOldSpaceMb: envNum(env, 'MINIMAX_NODE_MAX_OLD_SPACE_MB', 320),
  };
}
