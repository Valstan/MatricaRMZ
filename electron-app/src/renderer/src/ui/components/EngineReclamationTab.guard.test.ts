import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Сторож вкладки «Рекламация» (план reclamation-tab-redesign-2026-08).
//
// Вкладка рвётся молча: панель не размонтируется, а прячется через `hidden`, поля
// сохраняются отложенным батчем при закрытии карточки, а высота текстового поля
// считается по scrollHeight, который у скрытого элемента равен нулю. Ни один из этих
// разрывов не ломает ни типы, ни линт — их держит этот тест.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const TAB = src('./EngineReclamationTab.tsx');
const TEXTAREA = src('./AutoGrowTextarea.tsx');
const CARD = src('../pages/EngineDetailsPage.tsx');
const PRELOAD = src('../../../../preload/index.ts');
const FILES_IPC = src('../../../../main/ipc/register/files.ts');
const ENGINES_IPC = src('../../../../main/ipc/register/enginesOpsAudit.ts');

const NEW_CODES = [
  'reclamation_actual_defect',
  'reclamation_defect_nature',
  'reclamation_act_number',
  'reclamation_attachments',
];

describe('вкладка «Рекламация»: панель живёт, состояние — в карточке', () => {
  it('панель скрывается, а не размонтируется', () => {
    // Размонтирование обнулило бы состояние: пропало бы сохранение при закрытии,
    // черновик и сводная печать, которая читает state карточки.
    expect(CARD).toContain("hidden={activeTab !== 'reclamation'}");
    expect(CARD).toContain('<EngineReclamationTab');
  });

  it('состояние остаётся в карточке, компонент шлёт патчи', () => {
    expect(CARD).toContain('onPatch={applyReclamationPatch}');
    expect(CARD).toContain('function applyReclamationPatch');
    // Любая правка обязана поднять флаг сессии, иначе карточка закроется без сохранения.
    expect(CARD).toMatch(/function applyReclamationPatch[\s\S]{0,120}setSessionChanged\(true\)/);
    expect(TAB).not.toContain('useState<ReclamationDraft');
  });

  it('поле знает, видима ли вкладка', () => {
    // У скрытого элемента scrollHeight равен нулю: без пересчёта при показе поле
    // осталось бы схлопнутым на три строки, сколько бы текста в нём ни лежало.
    expect(CARD).toContain("visible={activeTab === 'reclamation'}");
    expect(TAB).toContain('visible={props.visible}');
    expect(TEXTAREA).toContain('props.visible');
    expect(TEXTAREA).toMatch(/useEffect\([\s\S]{0,400}\[props\.value, props\.visible, ref\]\)/);
  });
});

describe('новые поля доезжают до базы', () => {
  it('каждое новое поле и пишется, и читается для сравнения', () => {
    // Запись без чтения = поле никогда не «изменилось» и не сохранится:
    // saveAllAndClose пишет только то, что отличается от currentValues.
    for (const code of NEW_CODES.filter((c) => c !== 'reclamation_attachments')) {
      expect(CARD).toContain(`nextValues.${code} =`);
      expect(CARD).toContain(`currentValues.${code} =`);
    }
  });

  it('каждое новое поле зарегистрировано определением атрибута', () => {
    for (const code of NEW_CODES) {
      expect(CARD).toContain(`code: '${code}'`);
    }
  });

  it('подписи определений совпадают с тем, что видит оператор', () => {
    expect(CARD).toContain("name: 'Описание дефекта изделия'");
    expect(CARD).toContain("name: 'Фактически установленный дефект'");
    expect(CARD).toContain("name: 'Установленный характер дефекта'");
    expect(CARD).toContain("name: 'Номер акта исследования'");
    expect(CARD).toContain("name: 'Дата акта исследования'");
  });

  it('выведенные из обращения поля карточка больше не трогает', () => {
    expect(CARD).not.toContain('nextValues.reclamation_verdict =');
    expect(CARD).not.toContain('nextValues.reclamation_repair_status =');
    expect(CARD).not.toContain('RECLAMATION_VERDICT_LABELS');
    expect(CARD).not.toContain('RECLAMATION_REPAIR_STATUS_LABELS');
  });

  it('вложения рекламации — свой список, а не общий с «Фото и документами»', () => {
    expect(CARD).toContain('saveReclamationAttachments');
    expect(CARD).toContain("saveAttr('reclamation_attachments'");
    expect(CARD).toContain("category: 'reclamation'");
  });
});

describe('вставка текста: цепочка кнопка → мост → обработчик', () => {
  it('кнопки зовут мосты, а не читают буфер сами', () => {
    // navigator.clipboard.readText в renderer не работает без разрешения сессии;
    // чтение живёт в главном процессе.
    expect(TAB).toContain('window.matrica.files.clipboardText()');
    expect(TAB).toContain('window.matrica.files.pickText()');
    expect(TAB).not.toContain('navigator.clipboard.readText');
  });

  it('мосты объявлены в preload и обработаны в главном процессе', () => {
    expect(PRELOAD).toContain("ipcRenderer.invoke('files:clipboardText')");
    expect(PRELOAD).toContain("ipcRenderer.invoke('files:pickText')");
    expect(FILES_IPC).toContain("ipcMain.handle('files:clipboardText'");
    expect(FILES_IPC).toContain("ipcMain.handle('files:pickText'");
  });

  it('путь к файлу наружу не отдаётся', () => {
    // Мост, возвращающий путь, был бы примитивом «прочитай любой файл с диска».
    expect(FILES_IPC).toMatch(/files:pickText[\s\S]{0,700}filesReadPastableText\(picked\)/);
    expect(TAB).not.toContain('filePath');
  });

  it('вставка идёт в позицию курсора, а не затирает поле', () => {
    expect(TAB).toContain('insertTextAtSelection');
    expect(TAB).toContain('setSelectionRange');
  });

  it('отменённый диалог не показывают оператору как ошибку', () => {
    expect(TAB).toContain("r.error !== 'cancelled'");
  });
});

describe('сводная печать трёх разделов', () => {
  it('кнопка печати на вкладке «Рекламация» уходит в свою ветку', () => {
    expect(CARD).toContain("if (activeTab === 'reclamation')");
    expect(CARD).toContain('handlePrintReclamationTab');
  });

  it('печать берёт модель из отдельного модуля, а не собирает html внутри карточки', () => {
    // Прежняя печать двигателя жила замыканием внутри страницы на 2500 строк и потому
    // не проверялась ничем; новая — чистый билдер с юнит-тестом.
    expect(CARD).toContain('buildEngineReclamationPrintModel');
    expect(CARD).toContain("from '../utils/enginePrintModel.js'");
  });

  it('история ремонта дочитывается в момент печати', () => {
    // Панель истории грузит ленту сама и наружу её не отдаёт — без дочитывания
    // раздел «История ремонта» напечатался бы пустым.
    expect(CARD).toMatch(/handlePrintReclamationTab[\s\S]{0,600}operations\.list\(props\.engineId\)/);
    expect(CARD).toMatch(/handlePrintReclamationTab[\s\S]{0,600}buildEngineTimeline/);
  });
});

describe('справочник характера дефекта', () => {
  it('список приходит мостом, а обработчик его отдаёт', () => {
    expect(CARD).toContain('window.matrica.engines');
    expect(CARD).toContain('reclamationNatures()');
    expect(PRELOAD).toContain("ipcRenderer.invoke('engine:reclamationNatures')");
    expect(ENGINES_IPC).toContain("ipcMain.handle('engine:reclamationNatures'");
  });

  it('пока список не приехал, встроенные четыре пункта уже есть', () => {
    // Иначе поле было бы пустым до конца загрузки и оператор решил бы, что оно сломано.
    expect(CARD).toContain('useState<string[]>([...DEFECT_NATURE_SEED_LABELS])');
  });

  it('кнопка добавления есть и не плодит дубли-опечатки', () => {
    expect(TAB).toContain('Добавить новый характер дефекта');
    expect(TAB).toContain('normalizeLookupCompact');
  });
});
