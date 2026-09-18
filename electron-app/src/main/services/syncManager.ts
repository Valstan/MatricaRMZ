import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { SyncRunResult, SyncStatus } from '@matricarmz/shared';

import { flushPendingEngineReservationReleases } from './engineReservationClient.js';
import {
  countPendingLocalChanges,
  hasActiveSession,
  readLastPulledServerSeq,
  runSync,
  waitForServerChanges,
} from './syncService.js';
import { isOfflineSyncError } from './sync/syncErrorClassifier.js';
import { computeLocalDirtyAction, computeNextSyncDelayMs, computeWakeIdlePauseMs } from './sync/syncScheduling.js';
import { SettingsKey, settingsGetString } from './settingsStore.js';

type RunSyncOpts = Parameters<typeof runSync>[3];
type ProgressHandler = NonNullable<NonNullable<RunSyncOpts>['progress']>['onProgress'];

function nowMs() {
  return Date.now();
}

/** Сколько сервер держит ждущий запрос. Ответ приходит раньше, если новости есть. */
const WAKE_HOLD_MS = 25_000;
/** Пауза перед повторным ожиданием после ошибки сети (сервер лёг, вырвали кабель). */
const WAKE_ERROR_PAUSE_MS = 15_000;
/** Пауза, когда сервер отвечает отказом по правам (токен отняли на сервере). */
const WAKE_UNAUTHORIZED_PAUSE_MS = 30_000;
/** Пауза, пока в клиента не вошли: проверка локальная, в сеть не ходим. */
const WAKE_NO_SESSION_PAUSE_MS = 2_000;
/** Нижний зазор между синками, запущенными пробуждением: буря правок — один синк. */
const WAKE_MIN_GAP_MS = 1_000;
/** Пауза, когда после синка курсор так и не догнал номер сервера (защита от петли). */
const WAKE_STALL_PAUSE_MS = 5_000;
/** Как часто сторож смотрит, не появилось ли своей несинканной работы. */
const LOCAL_WATCH_MS = 1_000;
const LOCAL_RETRY_MIN_MS = 5_000;
const LOCAL_RETRY_MAX_MS = 60_000;

export class SyncManager {
  private state: SyncStatus['state'] = 'idle';
  private lastSyncAt: number | null = null;
  private lastError: string | null = null;
  private lastResult: SyncRunResult | null = null;
  private timer: NodeJS.Timeout | null = null;
  private nextAt: number | null = null;
  private inFlight = false;
  /** Текущий прогон (с его же уборкой в finally); null — синка сейчас нет. */
  private chain: Promise<SyncRunResult> | null = null;
  /** Уже поставленный в очередь следующий прогон: глубже одного не копим. */
  private pending: Promise<SyncRunResult> | null = null;
  private baseIntervalMs = 5 * 60_000;
  private consecutiveErrors = 0;
  private readonly onProgress?: ProgressHandler;
  /** Пробуждение сервером: выключается навсегда, если сервер старее клиента. */
  private wakeEnabled = true;
  private wakeRunning = false;
  private wakeGeneration = 0;
  private lastWakeSyncAt: number | null = null;
  private localTimer: NodeJS.Timeout | null = null;
  private localBusy = false;
  private lastPendingRows: number | null = null;
  private lastDirtySyncAt: number | null = null;
  private localRetryDelayMs = LOCAL_RETRY_MIN_MS;

  constructor(
    private readonly db: BetterSQLite3Database,
    private readonly clientId: string,
    private apiBaseUrl: string,
    opts?: {
      onProgress?: ProgressHandler;
    },
  ) {
    this.onProgress = opts?.onProgress;
  }

  setApiBaseUrl(next: string) {
    this.apiBaseUrl = next;
  }

  getApiBaseUrl() {
    return this.apiBaseUrl;
  }

  private async refreshApiBaseUrlFromDb() {
    try {
      const next = (await settingsGetString(this.db, SettingsKey.ApiBaseUrl))?.trim() ?? '';
      if (next) this.apiBaseUrl = next;
    } catch {
      // ignore
    }
  }

  getStatus(): SyncStatus {
    const now = nowMs();
    const nextAutoSyncInMs = this.nextAt == null ? null : Math.max(0, this.nextAt - now);
    return {
      state: this.state,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      lastResult: this.lastResult,
      nextAutoSyncInMs,
    };
  }

  /**
   * Автоматическая синхронизация. Работают три источника, все — через `runOnce`,
   * то есть параллельных прогонов по-прежнему не бывает:
   *
   * 1. **Пробуждение сервером** — ждущий запрос `/ledger/state/wait` висит и отвечает
   *    в тот же миг, когда в журнале появилось что-то новее нашего курсора. Отсюда
   *    сообщения чата и правки соседней машины приезжают за секунду, а не за минуты.
   * 2. **Сторож своих правок** — раз в секунду дешёвая проба локальной БД; запись
   *    оператора уезжает сразу, не дожидаясь тика.
   * 3. **Интервал** (`intervalMs`) — страховка: сеть/сервер/сессия могли подвести,
   *    и тогда синк всё равно случится сам.
   */
  startAuto(intervalMs: number) {
    this.baseIntervalMs = Math.max(10_000, Number(intervalMs) || 5 * 60_000);
    this.stopAuto();
    this.scheduleNext(this.baseIntervalMs);
    this.startServerWake();
    this.startLocalWatch();
  }

  private scheduleNext(delayMs: number) {
    if (this.timer) clearTimeout(this.timer);
    this.nextAt = nowMs() + delayMs;
    this.timer = setTimeout(() => {
      void this.tick(this.baseIntervalMs);
    }, delayMs);
  }

  stopAuto() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = null;
    this.stopServerWake();
    this.stopLocalWatch();
  }

  private startServerWake() {
    if (!this.wakeEnabled || this.wakeRunning) return;
    this.wakeRunning = true;
    const generation = ++this.wakeGeneration;
    void this.wakeLoop(generation).finally(() => {
      if (generation === this.wakeGeneration) this.wakeRunning = false;
    });
  }

  private stopServerWake() {
    // Висящий запрос не обрываем: он сам закроется по окну ожидания, а поколение
    // уже сменилось — его результат не запустит ни синка, ни следующего круга.
    this.wakeGeneration += 1;
    this.wakeRunning = false;
  }

  private async wakeLoop(generation: number) {
    while (generation === this.wakeGeneration && this.wakeEnabled) {
      // Пока в клиента не вошли, ждать нечего: спрашиваем локально и дёшево, чтобы
      // сразу после входа первая же правка приехала мгновенно, а не после паузы.
      if (!(await hasActiveSession(this.db).catch(() => false))) {
        await sleep(WAKE_NO_SESSION_PAUSE_MS);
        continue;
      }
      let result: Awaited<ReturnType<typeof waitForServerChanges>>;
      const startedAt = nowMs();
      try {
        await this.refreshApiBaseUrlFromDb();
        const since = await readLastPulledServerSeq(this.db);
        result = await waitForServerChanges(this.db, this.apiBaseUrl, since, WAKE_HOLD_MS);
      } catch (e) {
        result = { ok: false, unsupported: false, status: null, error: String(e) };
      }
      if (generation !== this.wakeGeneration) return;

      if (!result.ok) {
        if (result.unsupported) {
          // Сервер старее клиента: молча живём на интервале и сторожe своих правок.
          this.wakeEnabled = false;
          return;
        }
        // Сессии нет или её отняли: ждать нечего, пока оператор не войдёт заново —
        // держим редкий круг, чтобы не долбить сервер отказами.
        const unauthorized = result.status === 401 || result.status === 403;
        await sleep(unauthorized ? WAKE_UNAUTHORIZED_PAUSE_MS : WAKE_ERROR_PAUSE_MS);
        continue;
      }
      if (!result.changed) {
        // Сервер обязан был держать запрос до конца окна. Если он ответил пустым
        // сразу (заглушка, прокси, чужая версия) — добираем остаток сами, иначе
        // цикл станет петлёй без передышки.
        await sleep(computeWakeIdlePauseMs(nowMs() - startedAt, WAKE_HOLD_MS));
        continue;
      }

      // Нижний зазор: десять правок подряд на сервере дают один догоняющий синк.
      const sinceLast = this.lastWakeSyncAt == null ? Number.POSITIVE_INFINITY : nowMs() - this.lastWakeSyncAt;
      if (sinceLast < WAKE_MIN_GAP_MS) await sleep(WAKE_MIN_GAP_MS - sinceLast);
      if (generation !== this.wakeGeneration) return;
      this.lastWakeSyncAt = nowMs();
      const run = await this.runOnce(this.progressOpts()).catch(() => undefined);
      if (generation !== this.wakeGeneration) return;

      // Синк отказал (сервер жив, но не пускает) — сервер тут же снова скажет «новости
      // есть», и без паузы круг стал бы запросом в секунду.
      if (!run?.ok) {
        await sleep(WAKE_ERROR_PAUSE_MS);
        continue;
      }
      // Курсор не догнал номер, о котором сказал сервер: либо за это время пришло ещё,
      // либо мы почему-то не двигаемся. Первое подождёт полсекунды, второе не закрутится.
      const cursor = await readLastPulledServerSeq(this.db).catch(() => 0);
      if (cursor < result.serverLastSeq) await sleep(WAKE_STALL_PAUSE_MS);
    }
  }

  private startLocalWatch() {
    if (this.localTimer) return;
    this.localTimer = setInterval(() => void this.localWatchTick(), LOCAL_WATCH_MS);
    this.localTimer.unref?.();
  }

  private stopLocalWatch() {
    if (this.localTimer) clearInterval(this.localTimer);
    this.localTimer = null;
    this.lastPendingRows = null;
    this.localRetryDelayMs = LOCAL_RETRY_MIN_MS;
  }

  private async localWatchTick() {
    if (this.localBusy || this.inFlight) return;
    this.localBusy = true;
    try {
      const pendingRows = await countPendingLocalChanges();
      const action = computeLocalDirtyAction({
        pendingRows,
        lastPendingRows: this.lastPendingRows,
        nowMs: nowMs(),
        lastDirtySyncAtMs: this.lastDirtySyncAt,
        retryDelayMs: this.localRetryDelayMs,
        minRetryDelayMs: LOCAL_RETRY_MIN_MS,
        maxRetryDelayMs: LOCAL_RETRY_MAX_MS,
      });
      this.localRetryDelayMs = action.nextRetryDelayMs;
      if (pendingRows >= 0) this.lastPendingRows = pendingRows;
      if (!action.sync) return;
      this.lastDirtySyncAt = nowMs();
      await this.runOnce(this.progressOpts()).catch(() => undefined);
    } finally {
      this.localBusy = false;
    }
  }

  private progressOpts(): RunSyncOpts {
    return {
      progress: {
        mode: 'incremental',
        startedAt: nowMs(),
        ...(this.onProgress ? { onProgress: this.onProgress } : {}),
      },
    };
  }

  /**
   * Синхронизация «по требованию». Параллельных синков по-прежнему нет, но занятость
   * больше НЕ отвечает чужим результатом.
   *
   * Было: при идущем синке возвращался `lastResult` ПРОШЛОГО прогона — то есть на вопрос
   * «синхронизируй и скажи, как прошло» приходило бодрое `ok: true` от работы, которая
   * закончилась раньше, чем вызывающий вообще что-то изменил. Вызывающий верил и читал
   * реплику, где его данных ещё нет. Так ломалась дефектовка: личные номера экземпляров
   * появлялись со второго-третьего нажатия — не потому, что «долго считается», а потому
   * что показ опережал синк (GOTCHAS M134).
   *
   * Стало: обращение во время чужого синка ЖДЁТ его и запускает свежий — идущий мог
   * стартовать до изменения, которого ждёт вызывающий, и его результат ничего не
   * доказывает. Очередь глубиной один: десять нажатий подряд дают один догоняющий
   * прогон, а не десять.
   */
  async runOnce(opts?: Parameters<typeof runSync>[3]): Promise<SyncRunResult> {
    const current = this.chain;
    if (current) {
      if (this.pending) return this.pending;
      // Цепляемся за `current` — это прогон ВМЕСТЕ с его уборкой, поэтому к моменту
      // рекурсии `this.chain` уже пуст и новый прогон стартует, а не встаёт в очередь.
      const queued = current
        .catch(() => undefined)
        .then(() => {
          this.pending = null;
          return this.runOnce(opts);
        });
      this.pending = queued;
      return queued;
    }
    const run = this.runNow(opts).finally(() => {
      if (this.chain === run) this.chain = null;
    });
    this.chain = run;
    return run;
  }

  private async runNow(opts?: Parameters<typeof runSync>[3]): Promise<SyncRunResult> {
    this.inFlight = true;

    this.state = 'syncing';
    this.lastError = null;
    try {
      // UI читает apiBaseUrl из SQLite, а менеджер живёт в памяти.
      // Перед каждым синком подхватываем актуальную конфигурацию.
      await this.refreshApiBaseUrlFromDb();
      const r = await runSync(this.db, this.clientId, this.apiBaseUrl, opts);
      const offline = !r.ok && isOfflineSyncError(r.error ?? '');
      this.lastResult = r;
      if (r.ok) this.lastSyncAt = nowMs();
      // Ф2: досылаем снятия резерва, сделанные оффлайн у станка. Сеть только что
      // была — момент лучший. БЕЗ await: флеш ходит по сети, а мы ещё под inFlight,
      // и его ретраи задержали бы следующий синк на всё время недоступности сервера.
      if (r.ok) {
        void flushPendingEngineReservationReleases(this.db, this.db, this.apiBaseUrl).catch(() => 0);
      }
      this.state = r.ok || offline ? 'idle' : 'error';
      this.lastError = !r.ok && !offline ? (r.error ?? 'unknown') : null;
      return r;
    } finally {
      this.inFlight = false;
    }
  }

  private async tick(baseIntervalMs: number) {
    const startedAt = nowMs();
    const r = await this.runOnce({
      progress: {
        mode: 'incremental',
        startedAt,
        ...(this.onProgress ? { onProgress: this.onProgress } : {}),
      },
    });

    const offline = !r.ok && isOfflineSyncError(r.error ?? '');
    const { nextDelayMs, nextConsecutiveErrors } = computeNextSyncDelayMs({
      baseIntervalMs,
      resultOk: r.ok,
      pulled: Number(r.pulled ?? 0),
      pushed: Number(r.pushed ?? 0),
      offline,
      consecutiveErrors: this.consecutiveErrors,
    });
    this.consecutiveErrors = nextConsecutiveErrors;
    // Только перепланируем страховочный тик: `startAuto` перезапустил бы заодно
    // пробуждение и сторожа, а ещё (как было до 09.2026) СДВИНУЛ бы базовый
    // интервал на только что посчитанную задержку — и база ползла вниз навсегда.
    this.scheduleNext(nextDelayMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    t.unref?.();
  });
}
