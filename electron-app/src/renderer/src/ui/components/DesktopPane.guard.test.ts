import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Сторож разметки Верстака.
//
// У компонента нет ни одного CSS-класса — всё инлайн, поэтому единственные стабильные
// зацепки для CDP-смоуков это `data-desktop-*`. Переименование любой из них не ломает ни
// типы, ни линт, ни один юнит-тест — ломается только приёмка Windows-клиента, и молча.
//
// Отдельно держится stopPropagation у приёмников дропа. До этапа C его не было, и это был
// не теоретический риск: корневой обработчик доигрывал поверх обработчика папки со СТАРОГО
// снимка Верстака, поэтому ярлык, брошенный на папку из корзины, оказывался на Верстаке. Теперь
// полотно ещё и назначает координату — всплывший дроп папки записал бы её ярлыку в папке.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const PANE = src('./DesktopPane.tsx');
const PANEL = src('./DesktopFileActionsPanel.tsx');
const TARGET = src('./DesktopAttachTargetDialog.tsx');
const INTENT = src('./DesktopAttachIntent.ts');
const BUS = src('./DesktopTrashBus.ts');
const APP = src('../App.tsx');
const MENU = src('../shellV2/menuActions.ts');

describe('якоря смоуков на месте', () => {
  const ANCHORS = [
    'data-desktop-pane',
    'data-desktop-canvas',
    'data-desktop-shortcut',
    'data-desktop-selected',
    'data-desktop-folder',
    'data-desktop-folder-window',
    'data-desktop-folder-close',
    'data-desktop-trash',
    'data-desktop-lasso',
    'data-desktop-drop-marker',
    'data-desktop-upload',
    'data-desktop-watermark',
  ];

  it('каждый якорь ставится компонентом', () => {
    for (const a of ANCHORS) expect(PANE, `нет якоря ${a}`).toContain(a);
  });
});

describe('приёмники дропа гасят всплытие', () => {
  it('каждый вложенный onDrop зовёт stopPropagation', () => {
    const chunks: string[] = [];
    let from = 0;
    for (;;) {
      const at = PANE.indexOf('onDrop={(e) => {', from);
      if (at < 0) break;
      chunks.push(PANE.slice(at, at + 420));
      from = at + 1;
    }
    // Папка на Верстаке, корзина, окно открытой папки — три приёмника поверх полотна; плюс
    // сам приёмник полотна (он тоже гасит всплытие в файловой ветке).
    expect(chunks.length, 'обработчики дропа исчезли — сторож смотрит не туда').toBe(4);
    for (const c of chunks) {
      expect(c, `приёмник дропа без stopPropagation: ${c.slice(0, 120)}`).toContain('e.stopPropagation()');
    }
  });

  it('полотно отдаёт дроп ярлыка отдельной функции, а не разбирает его на месте', () => {
    expect(PANE).toContain('dropOnSurface(e)');
  });

  it('подсветка приёмника тоже гасит всплытие, иначе её перезаписывает полотно', () => {
    const at = PANE.indexOf('function allowDrop');
    expect(at).toBeGreaterThan(0);
    expect(PANE.slice(at, at + 320)).toContain('e.stopPropagation()');
  });
});

describe('раскладка считается доменом, а не вёрсткой', () => {
  it('места плиток берутся из desktopLayoutGrid', () => {
    expect(PANE).toContain('desktopLayoutGrid(');
  });

  it('размеры плитки берутся из метрик шага, а не зашиты числами', () => {
    expect(PANE).toContain('desktopTileMetrics(');
    // 92/30/11 были зашиты трижды и разъезжались между ярлыком, папкой и корзиной.
    expect(PANE).not.toContain('width: 92');
    expect(PANE).not.toContain('fontSize: 30');
  });

  it('шаг приходит снаружи — компонент не решает размер сам', () => {
    expect(PANE).toContain('stepOf?: Record<string, number>');
    expect(PANE).toContain('props.stepOf?.[shortcutId] ?? 0');
  });

  it('открытие ярлыка сообщает наверх ЕГО id — иначе счётчику нечего считать', () => {
    expect(PANE).toContain('onOpenLink: (link: unknown, shortcutId: string) => void');
    expect(PANE).not.toContain('props.onOpenLink(s.link)');
  });

  it('число колонок меряется по факту — Верстак резиновый', () => {
    expect(PANE).toContain('ResizeObserver');
  });
});

describe('файлы из Проводника', () => {
  it('дроп файлов ОС отличается от дропа ярлыка по типу, а не по догадке', () => {
    expect(PANE).toContain("e.dataTransfer.types.includes('Files')");
  });

  it('на планшете приём файлов не перехватывается — путей ОС там нет', () => {
    // Обе ветки (dragover и drop) обязаны спрашивать платформу: перехватить дроп и не
    // суметь его обработать хуже, чем не перехватывать вовсе.
    const branches = PANE.split("e.dataTransfer.types.includes('Files')");
    expect(branches.length - 1, 'веток приёма файлов не две — сторож смотрит не туда').toBe(2);
    for (const before of branches.slice(0, -1)) expect(before.slice(-40)).toContain('!isAndroid');
  });

  // Одна строка file_assets обслуживает всех, кто загрузил те же байты (дедуп по sha256),
  // а счётчика ссылок нет. Поэтому Верстак убирает СВОЙ ЯРЛЫК и никогда не трогает файл —
  // иначе «убрал с Верстака» выбивало бы вложение с чужой карточки.
  it('Верстак никогда не удаляет сам файл — только свой ярлык', () => {
    expect(PANE).not.toContain('files.delete');
    expect(PANE).toContain('файл останется');
  });

  it('плитка, которая не откроется, не кладётся на Верстак', () => {
    expect(PANE).toContain('up.deduped && up.canOpen === false');
  });

  it('отказ в праве загрузки объясняется, а не проглатывается', () => {
    expect(PANE).toContain('canUploadFiles === false');
  });
});

describe('фоновая подпись «ВЕРСТАК» не мешает работать', () => {
  // Подпись растянута на всю панель. Такой слой без `pointer-events: none` съел бы и лассо
  // выделения, и ПКМ по свободному месту, и перетаскивание — причём молча: жест просто
  // перестал бы работать, а виноватым выглядел бы Верстак, а не украшение поверх него.
  const block = PANE.slice(PANE.indexOf("data-desktop-watermark"), PANE.indexOf("Полотно сетки"));

  it('слой не перехватывает мышь', () => {
    expect(block).toContain("pointerEvents: 'none'");
  });

  it('подпись не выделяется и не читается экранным диктором как содержимое', () => {
    expect(block).toContain("userSelect: 'none'");
    expect(block).toContain('aria-hidden');
  });

  it('содержимое лежит выше подписи', () => {
    // Полотно с плитками получает свой слой явно: иначе порядок решался бы случаем разметки.
    expect(PANE).toContain("position: 'relative', zIndex: 1 }}");
  });

  it('цвет берётся от темы, а не задан серым по белому', () => {
    // У половины парка тёмная тема — фиксированный серый превратился бы там в грязное пятно.
    expect(block).toContain("color: 'var(--text)'");
    expect(block).toContain('opacity: 0.07');
  });
});

describe('действия над выделенными файлами (промт КАРМАНА #144)', () => {
  it('панель действий рисуется порталом — меню внутри контекста наложения уезжает под интерфейс', () => {
    expect(PANEL).toContain('PopupLayer');
    expect(PANEL).toContain('<PopupLayer>');
  });

  it('панель появляется только когда выделены файлы, а не когда выделен любой ярлык', () => {
    expect(PANE).toContain('desktopSelectedFileShortcuts');
    expect(PANEL).toContain('props.count <= 0');
  });

  it('панель действий остаётся ВНУТРИ окна — привязана к низу полотна, а не уходит под него', () => {
    // Живая приёмка 26.11.2026: панель считалась как «низ полотна + 12», а низ
    // полотна — это 1019 px при высоте окна 1025 px, и панель уезжала на 1031 px,
    // ЗА нижний край окна. Оператор выделял файлы и панели не видел: в DOM кнопки
    // были (клик срабатывал), но на экране их не было. Привязка — `bottom`.
    expect(PANEL).toContain('window.innerHeight');
    expect(PANEL).toContain('Math.max(8,');
    expect(PANEL).toContain('bottom,');
    expect(PANEL).not.toContain('top,');
  });

  it('копирование и перенос идут через файловый слой, а не путём на диск из рендерера', () => {
    // Прямой путь с диска в рендерере — это мост «прочитай/запиши любой файл» и обход
    // проверки доступа: `files.copyToFolder` внутри спрашивает карточку файла (files.meta).
    expect(PANE).toContain('window.matrica.files.copyToFolder');
    expect(PANE).not.toContain('files.downloadDirGet');
  });

  it('«перенести» убирает только СВОЙ ярлык — файл в программе остаётся', () => {
    // Правило проекта: Верстак убирает свой ярлык и никогда не удаляет файл.
    expect(PANE).not.toContain('files.delete');
    expect(PANE).toContain('desktopMoveToTrashMany');
  });

  it('оператору сказано, что оригиналы остаются, а не молча', () => {
    expect(PANE).toContain('Оригиналы на месте');
    expect(PANE).toContain('Оригиналы в программе не тронуты');
  });

  it('почтой файлы не отправляются — и это сказано словами', () => {
    // Своего почтового сервера нет, `mailto:` вложений не умеет. Молча отправить пустое
    // письмо — значит солгать оператору, что файл ушёл.
    expect(PANE).toContain('window.matrica.files.revealForShare');
    expect(PANE).toContain('window.matrica.mail.openDraft');
    expect(PANE).toContain('Письмо открыто без вложений');
  });

  it('прикрепление к карточке идёт через записку — карточка пишет вложения сама', () => {
    // Верстак не пишет в карточку: у трёх карточек из девяти список вложений живёт в памяти
    // открытой карточки, и внешняя запись потерялась бы молча.
    expect(PANE).toContain('setDesktopAttachIntent');
    expect(INTENT).toContain('takeDesktopAttachIntent');
  });

  it('цель прикрепления выбирается поиском и берётся только из списка карточек-приёмников', () => {
    expect(TARGET).toContain('window.matrica.search.global');
    expect(TARGET).toContain('desktopAttachTarget');
  });

  it('цель прикрепления ищется и по СПРАВОЧНИКАМ, а не только серверным поиском', () => {
    // Живая приёмка 26.11.2026: серверный поиск (`GET /search`) смотрит только
    // номенклатуру и складские документы — ДВИГАТЕЛЯ в нём нет никогда, и выбор
    // карточки-цели по двигателю не находил ничего. Слой справочников (L2) —
    // тот же, что у палитры Ctrl+K — обязателен.
    expect(TARGET).toContain('globalSearchSources');
    expect(TARGET).toContain('L2_SOURCES');
    expect(TARGET).toContain('prepareRecordSearch');
  });

  it('на планшете действия без файловой системы не показываются, а причина названа', () => {
    expect(PANE).toContain('canUseDisk={!isAndroid}');
    expect(PANEL).toContain('На планшете файлы не копируются на диск');
  });

  it('присланный файл помечен как присланный — от кого и когда', () => {
    expect(PANE).toContain('desktopFileOriginText');
    expect(PANE).toContain('data-desktop-file-origin');
  });
});

// Корзина Верстака (промт КАРМАНА #145).
//
// Главный дефект был не в логике корзины, а в СЛОЁ: полотно несёт `zIndex: 1`, а кнопка
// корзины стояла абсолютным положением без своего слоя (`z-index: auto` → слой 0).
// По правилу painting полотно рисуется ПОВЕРХ кнопки и перехватывает hit-test, а его фон
// прозрачен — ярлык было видно и он не нажимался. Клик, ПКМ и дроп в корзину не доходили
// ни на одном клиенте сразу: код-то один и тот же.
//
// Лечение — не «поднять z-index», а перевести корзину в ту же модель, что и остальные
// плитки: она рисуется ВНУТРИ полотна, клеткой сетки, и перекрыть её теперь нечем.
describe('корзина — плитка Верстака, а не прибитый угол (промт КАРМАНА #145)', () => {
  const TILE = PANE.slice(PANE.indexOf('function trashTile'), PANE.indexOf('const lassoBox'));

  it('корзина рисуется плиткой сетки, а не элементом, прибитым в угол', () => {
    expect(PANE).toContain('trashTile(grid.trash)');
    expect(TILE).toContain('tileOrigin(place, m)');
    // Прежние «right: 16 / bottom: 12» — то самое абсолютное положение, из-за которого
    // место корзины не переживало перезапуск и её нельзя было переставить.
    expect(TILE).not.toContain('right: 16');
    expect(TILE).not.toContain('bottom: 12');
  });

  it('корзина живёт в одном слое с остальными плитками — её нечем перекрыть', () => {
    // Свой слой внутри полотна = тот самый баг с перехватом клика.
    expect(TILE).not.toContain('zIndex');
  });

  it('место корзины пишется в профиль отдельным полем, а не координатой ярлыка', () => {
    expect(PANE).toContain('desktopSetTrashPos');
    expect(PANE).toContain('desktopResetTrashPos');
  });

  it('содержимое корзины рисуется порталом — иначе всплывашка режется краем полотна', () => {
    expect(PANE).toContain('data-desktop-trash-popup');
    expect(PANE).toContain('<PopupLayer>');
  });

  it('пустая корзина тоже открывается и говорит, что она пуста', () => {
    // Прежде условие было «trashOpen && trash.length > 0»: клик по пустой корзине не
    // делал ровно ничего, и оператор видел «неработающую» кнопку.
    expect(PANE).not.toContain('trashOpen && trash.length > 0');
    expect(PANE).toContain('Корзина пуста');
  });

  it('очистка говорит, что удаляются только ярлыки: файлы остаются', () => {
    // Правило проекта: Верстак убирает свой ярлык и никогда не удаляет файл. Оператор,
    // ждущий обратного, должен видеть это ДО подтверждения.
    expect(PANE).toContain('Файлы при этом НЕ удаляются');
    expect(PANE).toContain('файл останется');
  });

  it('корзину нельзя положить в саму себя — её можно было бы потерять', () => {
    expect(PANE).toContain('isDesktopTrashShortcut');
    expect(PANE).toContain('Корзину нельзя положить в саму себя');
  });

  it('пункт МЕНЮ «Корзина» открывает ВЕРСТАЧНУЮ корзину, а не пустоту', () => {
    // Раньше у пункта был свой `trashOpen` в оболочке, который НИЧЕГО НЕ РИСОВАЛ
    // (исторически — «Корзина кнопок», фичу убрали, пункт остался).
    expect(MENU).toContain("id: 'basket'");
    expect(APP).toContain('openDesktopTrash()');
    expect(APP).not.toContain('trashButtonRef');
    expect(APP).not.toContain('trashPopupRef');
    expect(BUS).toContain('openDesktopTrash');
  });
});
