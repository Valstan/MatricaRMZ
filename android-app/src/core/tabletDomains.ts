// Реестр доменов IPC: десктоп ↔ планшет (промт КАРМАНА #142).
//
// Правило владельца (зачитка 25.11.2026): «планшетная версия — полный функционал,
// все модули; версия для компьютера — копия планшетной». Значит, список доменов
// десктопа и планшета должен СОВПАДАТЬ, кроме оговорённого списка исключений.
//
// Этот файл — единственное место, где исключения объявлены. Их читают:
//   * мост (`ipcWiring.ts`) — чтобы не регистрировать домен целиком и чтобы
//     перекрыть каналы, которые зарегистрировать можно, но работать они не будут;
//   * шим (`shims/electron.ts`) — чтобы отказ называл причину, а не молчал;
//   * гейт паритета (`domainParity.guard.test.ts`) — чтобы расхождение ловилось
//     на следующей правке, а не по жалобе владельца.
//
// Причина обязательна у каждого исключения: «на планшете этого нет» без причины —
// не причина. Молчаливое исключение выглядит для оператора так же, как «не
// хватает прав», — а это ровно тот диагноз, который владелец поставил неверно.

/** Домен десктопа, которого на планшете нет целиком. */
export type TabletDomainException = {
  /**
   * Имя домена как в `electron-app/src/main/ipc/registerIpc.ts` — имя
   * register-модуля без слова `register` и `Ipc` (`Files`, `FileSearch`,
   * `Exports`, …). Сверяется гейтом паритета.
   */
  domain: string;
  /** Префиксы каналов домена — по ним отказ находит свою причину. */
  channelPrefixes: readonly string[];
  /** Почему домена нет на планшете — правда, а не отписка. */
  reason: string;
};

/**
 * Домены десктопа, которых на планшете нет.
 *
 * Все они — про ФИЗИЧЕСКИ невозможное на планшете: файлы на диске, бэкапы,
 * установщик обновления, перенос на десктоп, скрипты Windows-машины, почта
 * (вложение готовится файлом и уходит в почтовую программу ОС), служебный
 * канал стенда. Всё остальное переносится целиком.
 */
export const TABLET_DOMAIN_EXCEPTIONS: readonly TabletDomainException[] = [
  {
    domain: 'Files',
    // Четыре канала вложений на планшете ЕСТЬ — но через свой узкий мост
    // (filesBridge.ts, тот же REST API). Остальные — диск, диалоги, печать.
    channelPrefixes: [
      'files:assemblePdf',
      'files:clipboard:copyImage',
      'files:clipboardRead',
      'files:clipboardText',
      'files:copyToFolder',
      'files:download',
      'files:downloadDir:get',
      'files:downloadDir:pick',
      'files:meta',
      'files:open',
      'files:openObjectDir',
      'files:pick',
      'files:pickText',
      'files:print',
      // Системный мастер печати фотографий для вложений (промт КАРМАНА #159 + #160):
      // мастер — это окно Windows, у планшета его нет.
      'files:printWizard',
      'files:progress:list',
      'files:registerDropped',
      'files:revealForShare',
      // Сборка копий для почты/чата/ИИваныча — пути на диске (промт КАРМАНА #160).
      'files:stageForShare',
      'files:upload',
    ],
    reason:
      'десктопный домен вложений построен вокруг путей на диске и файловых диалогов, а у планшета файловой системы нет; вложения на планшете идут через узкий мост android-app/src/core/filesBridge.ts (свой набор каналов поверх того же REST API)',
  },
  {
    domain: 'Scanner',
    // Сканер документов — промт КАРМАНА #148.
    channelPrefixes: ['scan:'],
    // Причина написана языком оператора, а не инженера: «драйвера WIA у вас нет»
    // — это правда, но оператор от неё ничего не поймёт и решит, что программа
    // сломалась. Надо сказать, что делать: сканировать на компьютере.
    reason:
      'на планшете нет сканера: документ сканируется на компьютере, где сканер подключён, и приезжает на планшет как обычное вложение',
  },
  {
    domain: 'FileSearch',
    channelPrefixes: ['fileSearch:', 'engine:findExactByNumber', 'engine:characteristics'],
    reason:
      'поиск по своей файловой папке на диске (папки источников, метки, печать картинок) — у планшета файловой системы нет',
  },
  {
    domain: 'Exports',
    channelPrefixes: ['exports:'],
    reason:
      'выгрузка списка/формы пишет файл в папку на диске через нативный диалог «Сохранить как» — у планшета файловой системы нет',
  },
  {
    domain: 'Backups',
    channelPrefixes: ['backups:'],
    reason:
      'резервная копия — это локальный файл БД на диске плюс режим просмотра бэкапа; у планшета файловой системы нет',
  },
  {
    domain: 'Update',
    channelPrefixes: ['update:'],
    reason:
      'канал обновления ставит инсталлятор .exe на Windows-машину; планшет обновляется APK-ом (отдельный тег android-v*), установщика для него нет',
  },
  {
    domain: 'ClientOps',
    channelPrefixes: ['clientOps:'],
    reason:
      'скрипты обслуживания Windows-машины (PowerShell, антивирус, брандмауэр) — на планшете запускать нечего, архива со скриптами в сборке тоже нет',
  },
  {
    domain: 'Mail',
    channelPrefixes: ['mail:'],
    reason:
      'письмо готовится файлом-вложением на диске и открывается почтовой программой ОС; у планшета файловой системы нет',
  },
  {
    domain: 'E2eKeys',
    channelPrefixes: ['e2e:'],
    reason:
      'ключи e2e-канала синка — служебный канал стенда, оператору не нужен',
  },
  {
    domain: 'PpeOneCExport',
    channelPrefixes: ['ppe:onec:'],
    reason:
      'выгрузка СИЗ в формате 1С идёт через общий модуль выгрузки (файл на диске); у планшета файловой системы нет',
  },
];

/**
 * Канал зарегистрированного домена, который на планшете физически не работает.
 *
 * Таких каналов два класса:
 *   * печать/PDF — считается в скрытом окне Electron (`new BrowserWindow`),
 *     которого у WebView нет;
 *   * Windows-специфичное — синхронизация часов службой времени Windows.
 *
 * Канал не «молчит»: мост перекрывает его явным отказом с причиной.
 */
export type TabletChannelRule = {
  /** Точное имя канала. */
  channel: string;
  /** Почему канал на планшете не работает. */
  reason: string;
};

export const TABLET_CHANNEL_RULES: readonly TabletChannelRule[] = [
  {
    channel: 'reports:presetPdf',
    reason: 'PDF считается в скрытом окне Electron — у планшета такого окна нет; выгрузка в CSV/XML доступна',
  },
  {
    channel: 'reports:presetPrint',
    reason: 'печать идёт через скрытое окно Electron — у планшета такого окна нет; выгрузка в CSV/XML доступна',
  },
  {
    channel: 'reports:customPrint',
    reason: 'печать идёт через скрытое окно Electron — у планшета такого окна нет; выгрузка в CSV доступна',
  },
  {
    channel: 'reports:defectSupplyPdf',
    reason: 'PDF считается в скрытом окне Electron — у планшета такого окна нет',
  },
  {
    channel: 'reports:defectSupplyPrint',
    reason: 'печать идёт через скрытое окно Electron — у планшета такого окна нет',
  },
  {
    channel: 'reportsBuilder:exportPdf',
    reason: 'PDF считается в скрытом окне Electron — у планшета такого окна нет; выгрузка в HTML/Excel доступна',
  },
  {
    channel: 'reportsBuilder:print',
    reason: 'печать идёт через скрытое окно Electron — у планшета такого окна нет',
  },
  {
    channel: 'tools:exportPdf',
    reason: 'PDF карточки инструмента считается в скрытом окне Electron — у планшета такого окна нет',
  },
  {
    channel: 'chat:export',
    reason: 'выгрузка переписки пишет файл на диск — у планшета файловой системы нет; переписка видна в чате',
  },
  {
    channel: 'chat:sendFile',
    reason: 'отправка файла берёт его из локальной папки на диске — у планшета файловой системы нет',
  },
  {
    channel: 'system:clockSync',
    reason: 'синхронизация часов службой времени Windows (w32tm) — на планшете время выставляется в настройках устройства',
  },
  {
    channel: 'system:openDateTimeSettings',
    reason: 'открытие настроек даты и времени Windows — на планшете время выставляется в настройках устройства',
  },
  {
    channel: 'app:navigateDeepLink',
    reason: 'deep-link десктопного клиента (внешний протокол) — на планшете нет',
  },
];

/**
 * Причина, по которой канала нет на планшете, — или null, если канал должен работать.
 *
 * Ищется по двум спискам: сначала точный канал (зарегистрированный домен, но
 * физически невозможный на планшете), потом префиксы каналов доменов-исключений
 * (домен на планшете не подключён целиком).
 */
export function tabletChannelRefusalReason(channel: string): string | null {
  const rule = TABLET_CHANNEL_RULES.find((r) => r.channel === channel);
  if (rule) return rule.reason;
  for (const ex of TABLET_DOMAIN_EXCEPTIONS) {
    for (const prefix of ex.channelPrefixes) {
      if (channel === prefix || channel.startsWith(prefix)) return ex.reason;
    }
  }
  return null;
}

/** Имена доменов-исключений (для гейта паритета). */
export function tabletExceptionDomains(): ReadonlySet<string> {
  return new Set(TABLET_DOMAIN_EXCEPTIONS.map((e) => e.domain));
}
