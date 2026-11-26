/**
 * Сторож модуля «Поиск по файлам».
 *
 * Три правила, которые легко сломать правкой страницы и которые потом стоят
 * оператору дорого:
 * 1. Файлы читает главный процесс. В renderer не должно быть ни `exceljs`,
 *    ни `jszip`, ни доступа к диску — иначе страница станет мостом «прочитай
 *    любой файл с диска» (прецедент — `filesReadPastableText`).
 * 2. Модуль только читает: в выбранные файлы не пишет ничего.
 * 3. Запись в карточку идёт через единственную дверь `engines:card:save`
 *    (с гейтами дублей и авто-этапами). Второй вход разошёлся бы с ней —
 *    класс brain G363.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { matchPrefixRule } from '../../../../main/ipc/sectionGate.js';

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('../pages/FileSearchPage.tsx');
const APP = src('../App.tsx');
const SECTIONS = src('../../../../../../shared/src/domain/uiSections.ts');

describe('модуль «Поиск по файлам»: сторож формы', () => {
  it('файлы читает главный процесс — в renderer нет ни сборщиков, ни диска', () => {
    expect(PAGE).not.toMatch(/from 'exceljs'/);
    expect(PAGE).not.toMatch(/from 'jszip'/);
    expect(PAGE).not.toMatch(/node:fs/);
    expect(PAGE).not.toMatch(/readFileSync|writeFileSync/);
  });

  it('модуль не пишет в выбранные файлы', () => {
    expect(PAGE).not.toMatch(/writeFile|createWriteStream|showSaveDialog/);
  });

  it('запись в карточку идёт через единственную дверь engines:card:save', () => {
    expect(PAGE).toContain('window.matrica.engines.card.save');
    expect(PAGE).not.toContain('engines.setAttr');
  });

  it('перед переносом показывается предпросмотр «что → куда»', () => {
    expect(PAGE).toContain('buildEngineCardTransferPreview');
    expect(PAGE).toContain('Что будет скопировано');
  });

  it('недоступный файл виден оператору с полным путём', () => {
    expect(PAGE).toContain('item.path');
    expect(PAGE).toContain('Файлы, которые не прочитались');
  });

  it('раздел зарегистрирован: вкладка, подпись и меню', () => {
    expect(APP).toContain("t === 'file_search'");
    expect(APP).toContain("['file_search'] as const");
    expect(SECTIONS).toContain("file_search: 'Поиск по файлам'");
  });

  it('каналы модуля гейтятся разделом «Производство»', () => {
    expect(matchPrefixRule('fileSearch:pick')).toBe('production');
    expect(matchPrefixRule('fileSearch:search')).toBe('production');
    expect(matchPrefixRule('fileSearch:context')).toBe('production');
    expect(matchPrefixRule('fileSearch:resolveLabels')).toBe('production');
  });

  // Правка 16.11.2026: оператор увидел в карточке uuid вместо номера договора и
  // не смог понять, где данные разошлись с файлом. Обе вещи легко теряются
  // молча: типы и линт останутся зелёными.
  it('ссылки карточки расшифровываются в названия, а не показываются как id', () => {
    expect(PAGE).toContain('resolveLabels');
    expect(PAGE).toContain('UUID_RE');
  });

  it('найденное сверяется с карточкой: видно, что совпало, что разошлось и что переносить', () => {
    expect(PAGE).toContain('compareFindingsWithCard');
    expect(PAGE).toContain('Сверка с файлами');
    expect(PAGE).toContain('Расходится');
  });

  it('находки лежат списком «подпись — значение», а не squeezed-таблицей', () => {
    expect(PAGE).toContain('renderFindingRow');
    expect(PAGE).not.toContain('<th key={`${header}-${i}`}>');
  });

  // Правка 24.11.2026 (промт КАРМАНА #88): поиск по папкам — по НАЗВАНИЮ.
  // Четыре правила, которые легко сломать правкой страницы:
  // 1. Диск читает главный процесс. Renderer не должен ни читать папки, ни
  //    просить «картинку по произвольному пути» — только по id, который main
  //    выдал сам (иначе канал становится мостом «прочитай любой файл»).
  // 2. Превью — крупные: оператор должен разглядеть, что на фото.
  // 3. Печать идёт через существующий путь печати фотографий.
  // 4. Модуль ничего не пишет: ни в папки, ни в файлы.
  it('рендерер не читает диск и не просит картинку по пути', () => {
    expect(PAGE).not.toMatch(/readdir|readFileSync|writeFileSync/);
    expect(PAGE).not.toMatch(/fileSearch\.imagePreview\(\{\s*path/);
    // Превью запрашивается по id, а не по пути на диске.
    expect(PAGE).toContain('imagePreview({ id: image.id })');
  });

  it('папки ищутся по названию, а превью крупные', () => {
    expect(PAGE).toContain('searchFolders');
    expect(PAGE).toContain('В папках по названию');
    // Крупное превью: 220×220 и contain — картинка не обрезается.
    expect(PAGE).toContain('width: 220');
    expect(PAGE).toContain('objectFit: \'contain\'');
  });

  it('печать отобранного идёт через существующий путь печати фотографий', () => {
    expect(PAGE).toContain('printImages');
    expect(PAGE).toContain('Отправить на печать');
  });

  // Промт КАРМАНА #102: «Microsoft Picture Manager» — это НЕ Chromium-диалог,
  // а системный мастер печати фотографий (photowiz.dll), где оператор правит
  // размер и раскладку. Значит, у отобранных картинок ДВЕ кнопки, а кнопка
  // системного мастера прячется, если машина его не умеет.
  it('есть вторая кнопка — печать через системный мастер печати фотографий', () => {
    expect(PAGE).toContain("mode: 'os'");
    expect(PAGE).toContain('Через мастер печати фотографий');
    expect(PAGE).toContain('printCapabilities');
    // Кнопка рисуется только если мастер на машине есть.
    expect(PAGE).toContain('osPrintWizard ?');
  });

  it('модуль не пишет ни в папки, ни в файлы', () => {
    expect(PAGE).not.toMatch(/writeFile|createWriteStream|showSaveDialog|mkdir|rmSync|unlink/);
  });

  // Промт КАРМАНА #155: подсказки номера двигателя и три режима поиска.
  // Пять правил, которые легко сломать правкой страницы:
  // 1. Режимы — кнопками рядом со строкой поиска, и выбранный виден.
  // 2. «Фото двигателя» — совпадение ТОЛЬКО по названию папки: папка целиком.
  // 3. Подсказки номера — из базы, с задержкой, и только когда ввод похож на номер.
  // 4. Выбор подсказки подставляет ПОЛНЫЙ номер, а не дописывает его.
  // 5. Переключение режимов не сбрасывает отбор и не теряет отмеченные картинки.
  it('режимы переключаются кнопками рядом со строкой поиска, выбранный виден', () => {
    expect(PAGE).toContain('SEARCH_MODES.map');
    expect(PAGE).toContain("label: 'В файлах'");
    expect(PAGE).toContain("label: 'В папках по названию'");
    expect(PAGE).toContain("label: 'Фото двигателя'");
    // Выбранный режим — залитая кнопка.
    expect(PAGE).toContain("variant={mode === item.code ? 'primary' : 'outline'}");
  });

  it('режим «Фото двигателя» ищет по названию папки и берёт её целиком', () => {
    expect(PAGE).toContain("mode === 'photos' ? 'folder' : 'any'");
    expect(PAGE).toContain('scope: folderScopeOfMode(mode)');
  });

  it('подсказки номера приходят из базы и только когда ввод похож на номер', () => {
    expect(PAGE).toContain('engineNumberSuggestions');
    expect(PAGE).toContain('isFileSearchEngineNumberLike');
    expect(PAGE).toContain('SUGGEST_DEBOUNCE_MS');
    // Выпадашка — готовая компонента проекта, не самодельная.
    expect(PAGE).toContain('SuggestInput');
  });

  it('выбор подсказки подставляет полный номер в строку', () => {
    expect(PAGE).toContain('onChange={setQuery}');
    expect(PAGE).toContain('value: item.engineNumber');
  });

  it('переключение режимов не сбрасывает отбор картинок', () => {
    // Смена режима — только setMode: отметки и превью остаются.
    expect(PAGE).toContain('onClick={() => setMode(item.code)}');
    const modeSwitch = PAGE.split('onClick={() => setMode(item.code)}')[1]?.split('/>')[0] ?? '';
    expect(modeSwitch).not.toContain('setPicked');
    expect(modeSwitch).not.toContain('setPreviews');
    // А сброс отметок живёт только в самом поиске (старые id не печатаются).
    expect(PAGE).toContain('setPicked(new Set())');
  });

  // Промт КАРМАНА #158: над отмеченными картинками — одно меню действий, и оно
  // ОБЩЕЕ с панелью вложений карточки (набор в `components/FileActionsMenu.tsx`).
  // Три правила:
  // 1. меню открывается и правой кнопкой по картинке, и отдельной кнопкой;
  // 2. меню — из общего компонента, а не нарисованное здесь же (иначе две
  //    реализации разъедутся);
  // 3. пункт «удалить файл» в наборе невозможен — программа не удаляет файлы
  //    оператора (сторож самого набора — `FileActionsMenu.test.ts`).
  it('меню действий одно и общее — открывается и по правой кнопке, и кнопкой', () => {
    expect(PAGE).toContain('FileActionsMenu');
    expect(PAGE).toContain('onContextMenu');
    expect(PAGE).toContain('Действия…');
  });

  it('действия доводят файл до конца и говорят результат', () => {
    expect(PAGE).toContain('runFileAction');
    expect(PAGE).toContain('fileSearch.printWizard');
    expect(PAGE).toContain('fileSearch.assemblePdf');
    expect(PAGE).toContain('fileSearch.stageForShare');
    expect(PAGE).toContain('fileSearch.copyPaths');
  });
});