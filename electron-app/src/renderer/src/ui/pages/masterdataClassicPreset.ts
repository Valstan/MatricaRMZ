type EntityTypeRow = { id: string; code: string; name: string };
type AttrDefRow = { id: string; code: string };

type DefSeed = {
  code: string;
  name: string;
  dataType: 'text' | 'number' | 'boolean' | 'date' | 'json' | 'link';
  sortOrder: number;
  metaJson?: string | null;
};

type EntrySeed = {
  name: string;
  attrs?: Record<string, unknown>;
};

type TypeSeed = {
  code: string;
  name: string;
  defs: DefSeed[];
  entries: EntrySeed[];
};

type EnsureCtx = {
  setStatus?: (message: string) => void;
  createdTypes: number;
  createdDefs: number;
  createdEntries: number;
};

const CLASSIC_PRESET: TypeSeed[] = [
  {
    code: 'unit',
    name: 'Единицы измерения',
    defs: [
      { code: 'name', name: 'Название', dataType: 'text', sortOrder: 10 },
      { code: 'short_code', name: 'Краткое обозначение', dataType: 'text', sortOrder: 20 },
    ],
    entries: [
      { name: 'штука', attrs: { short_code: 'шт' } },
      { name: 'комплект', attrs: { short_code: 'компл' } },
      { name: 'пара', attrs: { short_code: 'пар' } },
      { name: 'килограмм', attrs: { short_code: 'кг' } },
      { name: 'грамм', attrs: { short_code: 'г' } },
      { name: 'тонна', attrs: { short_code: 'т' } },
      { name: 'литр', attrs: { short_code: 'л' } },
      { name: 'миллилитр', attrs: { short_code: 'мл' } },
      { name: 'метр', attrs: { short_code: 'м' } },
      { name: 'сантиметр', attrs: { short_code: 'см' } },
      { name: 'миллиметр', attrs: { short_code: 'мм' } },
      { name: 'метр квадратный', attrs: { short_code: 'м2' } },
      { name: 'метр кубический', attrs: { short_code: 'м3' } },
      { name: 'час', attrs: { short_code: 'ч' } },
      { name: 'человеко-час', attrs: { short_code: 'чел*ч' } },
      { name: 'смена', attrs: { short_code: 'смн' } },
    ],
  },
  {
    code: 'department',
    name: 'Подразделения / службы',
    defs: [
      { code: 'name', name: 'Название', dataType: 'text', sortOrder: 10 },
      { code: 'code', name: 'Код', dataType: 'text', sortOrder: 20 },
    ],
    entries: [
      { name: 'Производство', attrs: { code: 'PROD' } },
      { name: 'Склад', attrs: { code: 'WH' } },
      { name: 'Снабжение', attrs: { code: 'SUP' } },
      { name: 'Бухгалтерия', attrs: { code: 'ACC' } },
      { name: 'Кадры и зарплата', attrs: { code: 'HRP' } },
      { name: 'ОТК', attrs: { code: 'QC' } },
      { name: 'Планово-экономический отдел', attrs: { code: 'PEO' } },
    ],
  },
  {
    code: 'section',
    name: 'Участки',
    defs: [
      { code: 'name', name: 'Название', dataType: 'text', sortOrder: 10 },
      { code: 'code', name: 'Код', dataType: 'text', sortOrder: 20 },
    ],
    entries: [
      { name: 'Механообработка', attrs: { code: 'MACH' } },
      { name: 'Сборка', attrs: { code: 'ASSY' } },
      { name: 'Дефектация', attrs: { code: 'DEF' } },
      { name: 'Испытания', attrs: { code: 'TEST' } },
      { name: 'Покраска', attrs: { code: 'PAINT' } },
      { name: 'Склад готовой продукции', attrs: { code: 'FG' } },
    ],
  },
  {
    code: 'workshop_ref',
    name: 'Цеха',
    defs: [
      { code: 'name', name: 'Название', dataType: 'text', sortOrder: 10 },
      { code: 'code', name: 'Код', dataType: 'text', sortOrder: 20 },
    ],
    entries: [
      { name: 'Цех механической обработки', attrs: { code: 'CEX-01' } },
      { name: 'Сборочный цех', attrs: { code: 'CEX-02' } },
      { name: 'Ремонтный цех', attrs: { code: 'CEX-03' } },
    ],
  },
  {
    code: 'position_ref',
    name: 'Должности',
    defs: [
      { code: 'name', name: 'Название', dataType: 'text', sortOrder: 10 },
      { code: 'category', name: 'Категория', dataType: 'text', sortOrder: 20 },
    ],
    entries: [
      { name: 'Инженер-технолог', attrs: { category: 'ИТР' } },
      { name: 'Мастер участка', attrs: { category: 'Руководитель' } },
      { name: 'Слесарь-ремонтник', attrs: { category: 'Рабочий' } },
      { name: 'Токарь', attrs: { category: 'Рабочий' } },
      { name: 'Кладовщик', attrs: { category: 'Рабочий' } },
      { name: 'Бухгалтер', attrs: { category: 'Специалист' } },
      { name: 'Инспектор по кадрам', attrs: { category: 'Специалист' } },
    ],
  },
  {
    code: 'payroll_item',
    name: 'Статьи начислений и удержаний',
    defs: [
      { code: 'name', name: 'Название', dataType: 'text', sortOrder: 10 },
      { code: 'kind', name: 'Вид', dataType: 'text', sortOrder: 20 },
    ],
    entries: [
      { name: 'Оклад', attrs: { kind: 'Начисление' } },
      { name: 'Премия производственная', attrs: { kind: 'Начисление' } },
      { name: 'Ночные часы', attrs: { kind: 'Начисление' } },
      { name: 'Сверхурочные', attrs: { kind: 'Начисление' } },
      { name: 'НДФЛ', attrs: { kind: 'Удержание' } },
      { name: 'Алименты', attrs: { kind: 'Удержание' } },
      { name: 'Прочие удержания', attrs: { kind: 'Удержание' } },
    ],
  },
  {
    code: 'cost_center',
    name: 'Центры затрат',
    defs: [
      { code: 'name', name: 'Название', dataType: 'text', sortOrder: 10 },
      { code: 'code', name: 'Код', dataType: 'text', sortOrder: 20 },
    ],
    entries: [
      { name: 'Основное производство', attrs: { code: 'CC-100' } },
      { name: 'Вспомогательное производство', attrs: { code: 'CC-200' } },
      { name: 'Общепроизводственные расходы', attrs: { code: 'CC-300' } },
      { name: 'Административные расходы', attrs: { code: 'CC-400' } },
      { name: 'Сбыт', attrs: { code: 'CC-500' } },
    ],
  },
  {
    code: 'warehouse_ref',
    name: 'Склады',
    defs: [
      { code: 'name', name: 'Название', dataType: 'text', sortOrder: 10 },
      { code: 'code', name: 'Код', dataType: 'text', sortOrder: 20 },
      { code: 'address', name: 'Адрес', dataType: 'text', sortOrder: 30 },
    ],
    entries: [
      { name: 'Основной склад', attrs: { code: 'WH-01' } },
      { name: 'Склад инструмента', attrs: { code: 'WH-02' } },
      { name: 'Склад ГСМ', attrs: { code: 'WH-03' } },
      { name: 'Склад готовой продукции', attrs: { code: 'WH-04' } },
    ],
  },
  {
    code: 'nomenclature_group',
    name: 'Номенклатурные группы',
    defs: [
      { code: 'name', name: 'Название', dataType: 'text', sortOrder: 10 },
      { code: 'kind', name: 'Вид', dataType: 'text', sortOrder: 20 },
    ],
    entries: [
      { name: 'Сырье и материалы', attrs: { kind: 'Материалы' } },
      { name: 'Покупные комплектующие', attrs: { kind: 'Материалы' } },
      { name: 'Инструмент и оснастка', attrs: { kind: 'Инструмент' } },
      { name: 'Запасные части', attrs: { kind: 'Запчасти' } },
      { name: 'Услуги подрядчиков', attrs: { kind: 'Услуги' } },
      { name: 'Готовая продукция', attrs: { kind: 'Продукция' } },
    ],
  },
  {
    code: 'service',
    name: 'Услуги',
    defs: [
      { code: 'name', name: 'Название', dataType: 'text', sortOrder: 10 },
      { code: 'code', name: 'Код услуги', dataType: 'text', sortOrder: 20 },
      { code: 'unit', name: 'Единица измерения', dataType: 'text', sortOrder: 30 },
      { code: 'price', name: 'Цена, ₽', dataType: 'number', sortOrder: 40 },
    ],
    entries: [
      { name: 'Диагностика', attrs: { code: 'SRV-001', unit: 'шт', price: 1200 } },
      { name: 'Дефектация', attrs: { code: 'SRV-002', unit: 'шт', price: 1800 } },
      { name: 'Механообработка', attrs: { code: 'SRV-003', unit: 'компл', price: 3500 } },
      { name: 'Сборка и испытания', attrs: { code: 'SRV-004', unit: 'компл', price: 4200 } },
      { name: 'Выездной ремонт', attrs: { code: 'SRV-005', unit: 'шт', price: 6000 } },
    ],
  },
  {
    code: 'supplier_ref',
    name: 'Поставщики',
    defs: [
      { code: 'name', name: 'Наименование', dataType: 'text', sortOrder: 10 },
      { code: 'inn', name: 'ИНН', dataType: 'text', sortOrder: 20 },
      { code: 'phone', name: 'Телефон', dataType: 'text', sortOrder: 30 },
    ],
    entries: [
      { name: 'ООО Техснаб' },
      { name: 'ООО Промресурс' },
      { name: 'ООО Инструмент-Сервис' },
    ],
  },
  {
    code: 'machine_operation',
    name: 'Операции машиностроения',
    defs: [
      { code: 'name', name: 'Операция', dataType: 'text', sortOrder: 10 },
      { code: 'norm_hours', name: 'Норма, ч', dataType: 'number', sortOrder: 20 },
    ],
    entries: [
      { name: 'Токарная обработка', attrs: { norm_hours: 1 } },
      { name: 'Фрезерная обработка', attrs: { norm_hours: 1 } },
      { name: 'Шлифовка', attrs: { norm_hours: 1 } },
      { name: 'Сборка узла', attrs: { norm_hours: 2 } },
      { name: 'Контроль ОТК', attrs: { norm_hours: 1 } },
    ],
  },
];

async function listTypes(): Promise<EntityTypeRow[]> {
  return await window.matrica.admin.entityTypes.list();
}

async function ensureType(seed: TypeSeed, ctx: EnsureCtx): Promise<string> {
  const types = await listTypes();
  const existing = types.find((t) => String(t.code) === seed.code);
  if (existing?.id) return String(existing.id);
  const result = await window.matrica.admin.entityTypes.upsert({ code: seed.code, name: seed.name });
  if (!result.ok || !result.id) {
    throw new Error(`Не удалось создать раздел "${seed.name}": ${result.error ?? 'unknown'}`);
  }
  ctx.createdTypes += 1;
  return String(result.id);
}

async function ensureDefs(typeId: string, defs: DefSeed[], ctx: EnsureCtx) {
  const existing = await window.matrica.admin.attributeDefs.listByEntityType(typeId);
  const byCode = new Map(existing.map((d) => [String(d.code), d]));
  for (const def of defs) {
    if (byCode.has(def.code)) continue;
    const result = await window.matrica.admin.attributeDefs.upsert({
      entityTypeId: typeId,
      code: def.code,
      name: def.name,
      dataType: def.dataType,
      sortOrder: def.sortOrder,
      metaJson: def.metaJson ?? null,
    });
    if (!result.ok) throw new Error(`Не удалось добавить поле "${def.name}": ${result.error ?? 'unknown'}`);
    ctx.createdDefs += 1;
  }
}

function normalizeName(v: unknown) {
  return String(v ?? '')
    .trim()
    .toLowerCase();
}

async function ensureEntries(typeId: string, entries: EntrySeed[], ctx: EnsureCtx) {
  const list = await window.matrica.admin.entities.listByEntityType(typeId);
  const nameSet = new Set(list.map((r) => normalizeName(r.displayName)));
  for (const entry of entries) {
    const nameKey = normalizeName(entry.name);
    if (!nameKey || nameSet.has(nameKey)) continue;
    const created = await window.matrica.admin.entities.create(typeId);
    if (!created.ok || !created.id) throw new Error(`Не удалось создать запись "${entry.name}"`);
    const entityId = created.id;
    await window.matrica.admin.entities.setAttr(entityId, 'name', entry.name);
    if (entry.attrs) {
      for (const [key, value] of Object.entries(entry.attrs)) {
        await window.matrica.admin.entities.setAttr(entityId, key, value);
      }
    }
    nameSet.add(nameKey);
    ctx.createdEntries += 1;
  }
}

export async function applyClassicMasterdataPreset(setStatus?: (message: string) => void) {
  const ctx: EnsureCtx = { setStatus, createdTypes: 0, createdDefs: 0, createdEntries: 0 };
  for (const seed of CLASSIC_PRESET) {
    ctx.setStatus?.(`Настройка: ${seed.name}...`);
    const typeId = await ensureType(seed, ctx);
    await ensureDefs(typeId, seed.defs, ctx);
    await ensureEntries(typeId, seed.entries, ctx);
  }
  ctx.setStatus?.(
    `Классический шаблон применен: разделов +${ctx.createdTypes}, полей +${ctx.createdDefs}, записей +${ctx.createdEntries}`,
  );
  return {
    ok: true as const,
    createdTypes: ctx.createdTypes,
    createdDefs: ctx.createdDefs,
    createdEntries: ctx.createdEntries,
  };
}

