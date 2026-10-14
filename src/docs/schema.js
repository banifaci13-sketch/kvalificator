// Поля каждого типа слайда: по ним админка строит формы редактора, проверка — подписи ошибок.
// Типы полей: text, textarea, number, select, checkbox, lines (по строке на пункт),
// repeater (список карточек с полями), group (вложенный объект), chart (данные графика).
// image — картинка из медиатеки (номер), layout — вариант расположения элементов на слайде.
// figure: true — факт (значение KPI, результат кейса, источник, период, клиент, дата): ИИ-правка его не меняет.

import { SLIDE_TYPES, LAYOUTS } from './templates.js';

const DATA_STATUS = {
  key: 'dataStatus',
  label: 'Статус данных',
  type: 'select',
  options: [
    ['fact', 'Факт'],
    ['estimate', 'Оценка'],
    ['forecast', 'Прогноз'],
    ['hypothesis', 'Гипотеза'],
    ['plan', 'План'],
  ],
};
const SOURCE = { key: 'source', label: 'Источник данных', type: 'text', figure: true, hint: 'Откуда цифры: Метрика клиента, CRM, расчёт агентства…' };
const PERIOD = { key: 'period', label: 'Период', type: 'text', figure: true, hint: 'Например: январь — март 2027' };
const TITLE = { key: 'title', label: 'Заголовок', type: 'text', max: 90 };
const layout = (type) => ({ key: 'layout', label: 'Расположение', type: 'layout', options: LAYOUTS[type] });
const FIT = (def) => ({
  key: 'fit', label: 'Как вписать', type: 'select',
  options: def === 'contain'
    ? [['contain', 'Показать целиком'], ['cover', 'Заполнить блок, обрезав края']]
    : [['cover', 'Заполнить блок, обрезав края'], ['contain', 'Показать целиком']],
});
const CHART = { key: 'chart', label: 'График', type: 'chart' };

export const SLIDE_FIELDS = {
  cover: [
    layout('cover'),
    TITLE,
    { key: 'subtitle', label: 'Подзаголовок', type: 'textarea', max: 160 },
    { key: 'client', label: 'Клиент', type: 'text', figure: true },
    { key: 'date', label: 'Дата', type: 'text', figure: true },
    { key: 'author', label: 'Автор', type: 'text', figure: true },
    { key: 'image', label: 'Фото (для раскладки «С фото справа»)', type: 'image' },
  ],
  section: [
    { key: 'number', label: 'Номер раздела', type: 'number' },
    TITLE,
    { key: 'subtitle', label: 'Подзаголовок', type: 'textarea' },
  ],
  kpi: [
    TITLE,
    { key: 'lead', label: 'Пояснение', type: 'text' },
    {
      key: 'kpis', label: 'Показатели', type: 'repeater', max: 4, item: 'Показатель',
      fields: [
        { key: 'value', label: 'Значение', type: 'text', hint: '1 200 или 1 850 ₽', figure: true },
        { key: 'label', label: 'Что это', type: 'text' },
        { key: 'delta', label: 'Сравнение', type: 'text', hint: 'сейчас 640' },
      ],
    },
    DATA_STATUS, SOURCE, PERIOD,
  ],
  chart: [
    layout('chart'),
    TITLE, CHART,
    { key: 'takeaway', label: 'Главный вывод', type: 'textarea', max: 140 },
    { key: 'points', label: 'Пояснения', type: 'lines', max: 4 },
    DATA_STATUS, SOURCE, PERIOD,
  ],
  analytics: [
    TITLE, CHART,
    {
      key: 'insights', label: 'Выводы', type: 'repeater', max: 3, item: 'Вывод',
      fields: [
        { key: 'title', label: 'Вывод', type: 'text' },
        { key: 'text', label: 'Пояснение', type: 'textarea' },
      ],
    },
    DATA_STATUS, SOURCE, PERIOD,
  ],
  case: [
    TITLE,
    { key: 'client', label: 'Клиент', type: 'text', figure: true },
    { key: 'industry', label: 'Сфера', type: 'text' },
    { key: 'task', label: 'Задача', type: 'textarea' },
    { key: 'solution', label: 'Что сделали', type: 'lines', max: 5 },
    {
      key: 'results', label: 'Результаты', type: 'repeater', max: 3, item: 'Результат',
      fields: [
        { key: 'value', label: 'Значение', type: 'text', hint: '−38%', figure: true },
        { key: 'label', label: 'Что это', type: 'text' },
      ],
    },
    { key: 'verified', label: 'Кейс реальный, клиент согласен на публикацию', type: 'checkbox' },
    SOURCE, PERIOD,
  ],
  strategy: [
    layout('strategy'),
    TITLE,
    { key: 'lead', label: 'Пояснение', type: 'textarea' },
    {
      key: 'pillars', label: 'Направления', type: 'repeater', max: 4, item: 'Направление',
      fields: [
        { key: 'title', label: 'Направление', type: 'text' },
        { key: 'text', label: 'Что делаем', type: 'textarea' },
        { key: 'channels', label: 'Каналы', type: 'csv', hint: 'Через запятую' },
      ],
    },
  ],
  mediaplan: [
    TITLE,
    {
      key: 'rows', label: 'Каналы', type: 'repeater', max: 8, item: 'Канал',
      fields: [
        { key: 'channel', label: 'Канал', type: 'text' },
        { key: 'budget', label: 'Бюджет, ₽', type: 'number' },
        { key: 'impressions', label: 'Показы', type: 'number' },
        { key: 'clicks', label: 'Клики', type: 'number' },
        { key: 'leads', label: 'Лиды', type: 'number' },
      ],
    },
    { key: 'assumptions', label: 'Допущения', type: 'textarea', hint: 'На чём основан прогноз' },
    DATA_STATUS, SOURCE, PERIOD,
  ],
  ecomplan: [
    TITLE,
    {
      key: 'rows', label: 'Площадки', type: 'repeater', max: 8, item: 'Площадка',
      fields: [
        { key: 'channel', label: 'Площадка', type: 'text' },
        { key: 'targeting', label: 'Таргетинг', type: 'text', hint: 'Сегменты через запятую' },
        { key: 'budget', label: 'Бюджет с НДС, ₽', type: 'number' },
        { key: 'clicks', label: 'Клики', type: 'number' },
        { key: 'carts', label: 'Корзины', type: 'number' },
        { key: 'sales', label: 'Продажи', type: 'number' },
        { key: 'revenue', label: 'Выручка, ₽', type: 'number' },
      ],
    },
    { key: 'assumptions', label: 'Допущения', type: 'textarea', hint: 'Конверсии в корзину и в продажу, средний чек — откуда' },
    DATA_STATUS, SOURCE, PERIOD,
  ],
  image: [
    layout('image'),
    TITLE,
    { key: 'image', label: 'Фото или креатив', type: 'image' },
    FIT('cover'),
    { key: 'text', label: 'Текст', type: 'textarea', max: 400 },
    { key: 'points', label: 'Пункты', type: 'lines', max: 4 },
    { key: 'caption', label: 'Подпись к фото', type: 'text', max: 120 },
  ],
  gallery: [
    layout('gallery'),
    TITLE,
    {
      key: 'items', label: 'Креативы', type: 'repeater', max: 6, item: 'Креатив',
      fields: [
        { key: 'image', label: 'Изображение', type: 'image' },
        { key: 'caption', label: 'Подпись', type: 'text', hint: 'Площадка, формат, результат' },
      ],
    },
    FIT('contain'),
  ],
  proposal: [
    TITLE,
    { key: 'lead', label: 'Пояснение', type: 'text' },
    {
      key: 'items', label: 'Состав работ', type: 'repeater', max: 7, item: 'Работа',
      fields: [
        { key: 'name', label: 'Работа', type: 'text' },
        { key: 'description', label: 'Что входит', type: 'text' },
        { key: 'price', label: 'Стоимость, ₽', type: 'number' },
      ],
    },
    { key: 'priceUnit', label: 'Единица стоимости', type: 'text', hint: 'в месяц' },
    { key: 'terms', label: 'Условия', type: 'lines', max: 6 },
    { key: 'validUntil', label: 'Действует до', type: 'text' },
  ],
  brief: [
    TITLE,
    { key: 'lead', label: 'Пояснение', type: 'text', hint: 'Например: «Ответы помогут точнее посчитать бюджет»' },
    layout('brief'),
    {
      key: 'questions', label: 'Вопросы', type: 'repeater', max: 4, item: 'Вопрос',
      fields: [
        { key: 'question', label: 'Вопрос', type: 'text', max: 90 },
        { key: 'hint', label: 'Подсказка', type: 'text', max: 110, hint: 'Пример ответа или что важно указать' },
        { key: 'answer', label: 'Ответ клиента', type: 'textarea', hint: 'Пусто — на слайде останется поле для ответа' },
      ],
    },
    { key: 'start', label: 'Нумерация с', type: 'number', hint: 'Если вопросы продолжаются с прошлого слайда' },
  ],
  closing: [
    TITLE,
    { key: 'steps', label: 'Следующие шаги', type: 'lines', max: 4 },
    {
      key: 'contacts', label: 'Контакты', type: 'group',
      fields: [
        { key: 'name', label: 'Имя', type: 'text' },
        { key: 'role', label: 'Должность', type: 'text' },
        { key: 'phone', label: 'Телефон', type: 'text' },
        { key: 'email', label: 'E-mail', type: 'text' },
        { key: 'telegram', label: 'Telegram', type: 'text' },
        { key: 'site', label: 'Сайт', type: 'text' },
      ],
    },
  ],
};

export const CHART_TYPES = [
  ['column', 'Столбцы'],
  ['bar', 'Горизонтальные столбцы'],
  ['line', 'Линия'],
  ['stacked', 'Столбцы с накоплением'],
];

/** Описание для админки: типы слайдов, их поля и пустой слайд каждого типа. */
export function slideCatalog() {
  return Object.entries(SLIDE_TYPES).map(([type, t]) => ({
    type,
    label: t.label,
    theme: t.theme,
    data: Boolean(t.data),
    required: t.required,
    fields: [...SLIDE_FIELDS[type], { key: 'notes', label: 'Заметки докладчика', type: 'textarea' }],
  }));
}

export function emptySlide(type) {
  const base = { type, title: '' };
  if (SLIDE_TYPES[type]?.data) base.dataStatus = type === 'mediaplan' || type === 'ecomplan' ? 'forecast' : 'fact';
  if (type === 'chart' || type === 'analytics') base.chart = { type: 'column', categories: [], series: [{ name: '', values: [] }] };
  // списки — пустые, у повторяющихся блоков одна пустая карточка: так форму сразу видно целиком
  for (const f of SLIDE_FIELDS[type] ?? []) {
    if (f.type === 'layout') base.layout = f.options[0][0];
    if (f.type === 'lines' || f.type === 'csv') base[f.key] = [];
    if (f.type === 'repeater') base[f.key] = [Object.fromEntries(f.fields.map((x) => [x.key, x.type === 'number' ? null : x.type === 'csv' ? [] : '']))];
    if (f.type === 'group') base[f.key] = {};
  }
  return base;
}
