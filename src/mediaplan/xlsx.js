// Медиаплан в Excel — как рабочие таблицы агентства: в первой строке логотип и заголовок, сразу под
// ними голубая шапка таблицы, тонкие чёрные рамки, цветные сегменты таргетинга, голубая строка «Итого»,
// Calibri 10, ₽ и %. Формулы живые — менеджер меняет бюджет или конверсию, пересчитываются все
// листы; рядом с формулами записаны готовые значения, чтобы цифры были видны и без пересчёта.
// Файл собирается без сторонних библиотек для Excel (OOXML + zip).

import JSZip from 'jszip';

import { calcPlan } from './calc.js';

// Оформление повторяет медиапланы агентства (пример — «МП Таллер СберЭдс»)
const FONT = 'Calibri';
const HEAD_FILL = '00B0F0'; // голубая шапка и строка «Итого»
const INK = '000000';
const STEEL = '595959';
const GRID = '000000'; // тонкие чёрные рамки
const INPUT = 'FFF2CC'; // исходные данные на листе «Допущения»
const LOGO_GRAY = '8C8C8C';
// сегменты таргетинга — насыщенные заливки, как в таблицах агентства
const TINTS = ['00FF00', 'FFFF00', 'F6B26B', 'EA9999', 'A4C2F4', 'B4A7D6'];
const NUM = '#,##0;-#,##0;"–"';
const MONEY2 = '#,##0.00 "₽";-#,##0.00 "₽";"–"';
const MONEY0 = '#,##0 "₽";-#,##0 "₽";"–"';
const PCT1 = '0.0%;-0.0%;"–"';
const PCT2 = '0.00%;-0.00%;"–"';
const div = (a, b) => (a != null && b ? a / b : 0);

const xml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const colName = (i) => (i < 26 ? String.fromCharCode(65 + i) : colName(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));
const ref = (sheet) => `'${sheet.replace(/'/g, "''")}'!`;
const frac = (v) => (typeof v === 'number' ? v / 100 : null);

/** Стили: собираются по описанию и нумеруются при первом использовании. */
function createStyles() {
  const fonts = [];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  const fmts = [];
  const xfs = [];
  const index = (list, value) => {
    const i = list.indexOf(value);
    return i >= 0 ? i : list.push(value) - 1;
  };
  const line = (side, style, color) => (style ? `<${side} style="${style}"><color rgb="FF${color}"/></${side}>` : `<${side}/>`);
  const style = ({ size = 10, bold = false, italic = false, color = INK, fill = null, border = null, fmt = null, wrap = false, align = null, valign = 'center' } = {}) => {
    const font = index(fonts, `<font>${bold ? '<b/>' : ''}${italic ? '<i/>' : ''}<sz val="${size}"/><color rgb="FF${color}"/><name val="${FONT}"/></font>`);
    const fillId = fill ? index(fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${fill}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    // all — тонкая рамка вокруг ячейки, как в таблицах агентства; total — плюс жирная линия сверху
    const borderId = border
      ? index(
          borders,
          `<border>${line('left', 'thin', GRID)}${line('right', 'thin', GRID)}${line('top', border === 'total' ? 'medium' : 'thin', border === 'total' ? INK : GRID)}${line('bottom', 'thin', GRID)}<diagonal/></border>`,
        )
      : 0;
    const fmtId = fmt ? 164 + index(fmts, fmt) : 0;
    const alignment = `<alignment vertical="${valign}"${wrap ? ' wrapText="1"' : ''}${align ? ` horizontal="${align}"` : ''}/>`;
    return index(
      xfs,
      `<xf numFmtId="${fmtId}" fontId="${font}" fillId="${fillId}" borderId="${borderId}" xfId="0"${fmtId ? ' applyNumberFormat="1"' : ''}${fillId ? ' applyFill="1"' : ''}${borderId ? ' applyBorder="1"' : ''} applyAlignment="1">${alignment}</xf>`,
    );
  };
  style(); // 0 — обычный текст
  const xmlOut = () =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="${fmts.length}">${fmts.map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${xml(f)}"/>`).join('')}</numFmts>
<fonts count="${fonts.length}">${fonts.join('')}</fonts>
<fills count="${fills.length}">${fills.join('')}</fills>
<borders count="${borders.length}">${borders.join('')}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  return { style, xml: xmlOut };
}

/**
 * Лист: set(колонка, строка, значение | {f: формула, v: готовое значение}, стиль).
 * Готовое значение пишется рядом с формулой: Excel в защищённом просмотре формулы не считает,
 * и без него ячейки были бы пустыми.
 */
function createSheet(name) {
  const rows = new Map();
  const sheet = {
    name,
    widths: [],
    heights: {},
    merges: [],
    validations: [],
    freezeRow: 0,
    drawing: false,
    set(col, row, value, s = 0) {
      if (!rows.has(row)) rows.set(row, new Map());
      rows.get(row).set(col, { value, s });
      return sheet;
    },
    merge(c1, r1, c2, r2) {
      if (c1 !== c2 || r1 !== r2) sheet.merges.push(`${colName(c1)}${r1}:${colName(c2)}${r2}`);
      return sheet;
    },
    xml() {
      const rowNums = new Set([...rows.keys(), ...Object.keys(sheet.heights).map(Number)]);
      const body = [...rowNums]
        .sort((a, b) => a - b)
        .map((r) => {
          const cells = [...(rows.get(r)?.entries() ?? [])]
            .sort((a, b) => a[0] - b[0])
            .map(([c, { value, s }]) => {
              const at = `${colName(c)}${r}`;
              if (value == null) return `<c r="${at}" s="${s}"/>`;
              if (typeof value === 'object' && value.rich) {
                const runs = value.rich
                  .map((r) => `<r><rPr>${r.bold ? '<b/>' : ''}<sz val="${r.size ?? 10}"/><color rgb="FF${r.color ?? INK}"/><rFont val="${FONT}"/></rPr><t xml:space="preserve">${xml(r.text)}</t></r>`)
                  .join('');
                return `<c r="${at}" s="${s}" t="inlineStr"><is>${runs}</is></c>`;
              }
              if (typeof value === 'object') {
                const v = value.v;
                if (typeof v === 'string') return `<c r="${at}" s="${s}" t="str"><f>${xml(value.f)}</f><v>${xml(v)}</v></c>`;
                return `<c r="${at}" s="${s}"><f>${xml(value.f)}</f>${typeof v === 'number' && Number.isFinite(v) ? `<v>${v}</v>` : ''}</c>`;
              }
              if (typeof value === 'number') return `<c r="${at}" s="${s}"><v>${value}</v></c>`;
              return `<c r="${at}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
            })
            .join('');
          const ht = sheet.heights[r];
          return `<row r="${r}"${ht ? ` ht="${ht}" customHeight="1"` : ''}>${cells}</row>`;
        })
        .join('');
      const cols = sheet.widths.length ? `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
      const pane = sheet.freezeRow
        ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${sheet.freezeRow}" topLeftCell="A${sheet.freezeRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
        : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
      const merges = sheet.merges.length ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
      const dv = sheet.validations.length
        ? `<dataValidations count="${sheet.validations.length}">${sheet.validations.map((v) => `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="${v.sqref}"><formula1>"${v.list.join(',')}"</formula1></dataValidation>`).join('')}</dataValidations>`
        : '';
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>${pane}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${body}</sheetData>${merges}${dv}<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>${sheet.drawing ? '<drawing r:id="rId1"/>' : ''}</worksheet>`;
    },
  };
  return sheet;
}

/** Имя листа Excel: до 31 символа, без []:*?/\ и уникальное. */
function sheetNames(names) {
  const used = new Set(['Сводка', 'Допущения']);
  return names.map((n, i) => {
    let base = String(n || `Сценарий ${i + 1}`).replace(/[[\]:*?/\\']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 28) || `Сценарий ${i + 1}`;
    let name = base;
    for (let k = 2; used.has(name); k++) name = `${base.slice(0, 26)} ${k}`;
    used.add(name);
    return name;
  });
}

/** Размер PNG из заголовка — чтобы логотип встал без искажений. */
function pngSize(buf) {
  if (!buf || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * plan — { title, client, spec }; benchmarks — нормативы, использованные в плане (для листа допущений);
 * logo — утверждённый логотип бренда (PNG): встаёт в шапку каждого листа. Без него — текстовая подпись.
 * Возвращает Buffer .xlsx.
 */
export async function mediaplanXlsx(plan, { benchmarks = [], author = '', logo = null } = {}) {
  const spec = plan.spec;
  const st = createStyles();
  const cell = { border: 'all' };
  const HF = HEAD_FILL;
  const S = {
    logoCell: st.style({ wrap: true, valign: 'center' }),
    title: st.style({ size: 18, align: 'center' }),
    note: st.style({ size: 9, italic: true, color: STEEL }),
    head: st.style({ bold: true, fill: HF, border: 'all', wrap: true, align: 'center' }),
    text: st.style({ ...cell, wrap: true }),
    textC: st.style({ ...cell, align: 'center', wrap: true }),
    label: st.style({ ...cell }),
    labelBold: st.style({ ...cell, bold: true }),
    num: st.style({ ...cell, fmt: NUM, align: 'center' }),
    money: st.style({ ...cell, fmt: MONEY2, align: 'center' }),
    money0: st.style({ ...cell, fmt: MONEY0, align: 'center' }),
    pct: st.style({ ...cell, fmt: PCT2, align: 'center' }),
    pct1: st.style({ ...cell, fmt: PCT1, align: 'center' }),
    totLabel: st.style({ bold: true, fill: HF, border: 'all', align: 'center' }),
    totNum: st.style({ bold: true, fill: HF, border: 'all', fmt: NUM, align: 'center' }),
    totMoney: st.style({ bold: true, fill: HF, border: 'all', fmt: MONEY2, align: 'center' }),
    totMoney0: st.style({ bold: true, fill: HF, border: 'all', fmt: MONEY0, align: 'center' }),
    totPct: st.style({ bold: true, fill: HF, border: 'all', fmt: PCT1, align: 'center' }),
    totPct2: st.style({ bold: true, fill: HF, border: 'all', fmt: PCT2, align: 'center' }),
    totBlank: st.style({ fill: HF, border: 'all' }),
    keyNum: st.style({ ...cell, fill: INPUT, fmt: NUM, align: 'center' }),
    keyMoney: st.style({ ...cell, fill: INPUT, fmt: MONEY0, align: 'center' }),
    keyPct: st.style({ ...cell, fill: INPUT, fmt: PCT1, align: 'center' }),
    wrap: st.style({ wrap: true, valign: 'top' }),
    sectionHead: st.style({ bold: true, size: 11 }),
    tints: TINTS.map((fill) => st.style({ ...cell, fill, wrap: true, align: 'center' })),
  };
  const logoSize = pngSize(logo);

  /**
   * Первая строка листа — как в таблицах агентства: слева логотип (колонки A–B), справа крупный
   * заголовок. Шапка таблицы — сразу во второй строке. Без утверждённого файла логотипа —
   * текстовая подпись, знак-птицу не рисуем.
   */
  function brandHeader(sh, title, lastCol) {
    sh.heights[1] = 48;
    sh.merge(0, 1, 1, 1);
    if (logoSize) sh.drawing = true;
    else
      sh.set(0, 1, {
        rich: [
          { text: 'SOROKA', size: 22, bold: true, color: LOGO_GRAY },
          { text: '\nАГЕНТСТВО ', size: 7, color: LOGO_GRAY },
          { text: 'ИНТЕРНЕТ-МАРКЕТИНГА', size: 7, bold: true, color: HEAD_FILL },
        ],
      }, S.logoCell);
    sh.set(2, 1, title, S.title).merge(2, 1, Math.max(2, lastCol), 1);
  }
  /** Пояснения под таблицей — мелким курсивом, чтобы не мешать самой таблице. */
  const footnote = (sh, row, text, col = 0) => sh.set(col, row, text, S.note);

  const names = sheetNames(spec.scenarios.map((s) => s.name));
  const A = 'Допущения';
  const a = ref(A);
  const settings = spec.settings ?? {};
  const ecom = spec.kind === 'ecom';
  const withVat = Boolean(settings.budgetWithVat);
  const months = Math.max(1, spec.months ?? 1);
  const results = calcPlan(spec);
  const clientName = plan.client || plan.title;
  const dateStr = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' }).replace(/\s*г\.$/, '');

  // ---------- допущения: исходные данные всего файла ----------
  const as = createSheet(A);
  as.widths = [16, 50, 16, 12, 12, 12, 50];
  brandHeader(as, `Допущения: ${clientName}`, 4);
  // параметры — в колонках B (название) и C (значение): A и B заняты логотипом в первой строке
  const AR = { months: 3, fee: 4, fixed: 5, vat: 6, sale: 7, check: 8 };
  as.heights[2] = 30;
  as.set(1, 2, 'Параметр', S.head).set(2, 2, 'Значение', S.head);
  const inputs = [
    [AR.months, 'Период, месяцев', months, S.keyNum],
    [AR.fee, 'Комиссия агентства, % от медиабюджета', frac(settings.agencyFee) ?? 0, S.keyPct],
    [AR.fixed, 'Комиссия агентства, фиксированная часть в месяц, ₽ без НДС', settings.agencyFixed ?? 0, S.keyMoney],
    [AR.vat, 'НДС (0 — без НДС)', frac(settings.vat) ?? 0, S.keyPct],
    [AR.sale, ecom ? 'Конверсия в продажу — задаётся по строкам (CR2)' : 'Конверсия лида в продажу', ecom ? 0 : frac(settings.saleRate) ?? 0, S.keyPct],
    [AR.check, ecom ? 'Средний чек по умолчанию, ₽' : 'Средний чек, ₽', settings.avgCheck ?? 0, S.keyMoney],
  ];
  for (const [r, label, v, s] of inputs) as.set(1, r, label, S.label).set(2, r, v, s);
  footnote(as, 9, 'Жёлтые ячейки — исходные данные: измените их, и пересчитаются все листы.', 1);
  as.set(1, 11, 'На чём основан прогноз', S.sectionHead);
  as.set(1, 12, spec.assumptions || 'Не указано', S.wrap).merge(1, 12, 6, 12);
  as.heights[12] = 48;
  let r = 14;
  if (benchmarks.length) {
    as.set(1, r, 'Нормативы агентства по каналам', S.sectionHead);
    r += 1;
    ['Канал', 'CPC, ₽', 'CPM, ₽', 'CTR', 'Конверсия в лид', 'Основание'].forEach((t, c) => as.set(c + 1, r, t, S.head));
    for (const b of benchmarks) {
      r += 1;
      as.set(1, r, b.channel, S.label).set(2, r, b.cpc, S.money).set(3, r, b.cpm, S.money).set(4, r, frac(b.ctr), S.pct).set(5, r, frac(b.cr), S.pct);
      as.set(6, r, [b.note, b.updated_at ? `обновлено ${String(b.updated_at).slice(0, 10)}` : null].filter(Boolean).join('; '), S.text);
    }
  }
  const VAT = `${a}$C$${AR.vat}`;
  const CHECK = `${a}$C$${AR.check}`;

  // ---------- сценарии ----------
  const HEAD = 2;
  const totals = [];
  const scenarioSheets = spec.scenarios.map((sc, si) => scenarioSheet(sc, si));

  function scenarioSheet(sc, si) {
    const res = results[si];
    const rows = sc.rows.length ? sc.rows : [{ model: 'cpc' }];
    const calc = sc.rows.length ? res.rows : [{}];
    const anyCpm = rows.some((x) => x.model === 'cpm');
    // колонки собираются под план: модель, CPM и CTR — только если есть закупка по показам
    const cols = [
      { key: 'channel', head: 'Площадка', w: 16 },
      { key: 'targeting', head: 'Таргетинг', w: 40 },
      ...(anyCpm ? [{ key: 'model', head: 'Модель', w: 8 }, { key: 'cpm', head: 'CPM, ₽', w: 10 }, { key: 'ctr', head: 'CTR', w: 8 }] : []),
      { key: 'clicks', head: 'Клики', w: 10 },
      { key: 'cpc', head: anyCpm ? 'CPC (для CPM — итоговая), ₽' : 'CPC', w: 11 },
      { key: 'net', head: 'Стоимость без НДС', w: 14 },
      { key: 'gross', head: 'Стоимость с НДС', w: 14 },
      ...(ecom
        ? [
            { key: 'cart', head: 'CR1 (в корзину)', w: 10 },
            { key: 'carts', head: 'Кол-во корзин', w: 10 },
            { key: 'cpa', head: 'CPA (цена доб. в корз.)', w: 12 },
            { key: 'sale', head: 'CR2 (конверсия в продажу)', w: 12 },
            { key: 'sales', head: 'Кол-во продаж', w: 10 },
            { key: 'cps', head: 'CPS (цена продажи)', w: 11 },
            { key: 'check', head: 'Ср. чек', w: 12 },
            { key: 'revenue', head: 'Выручка', w: 14 },
            { key: 'drr', head: 'ДРР', w: 9 },
          ]
        : [
            { key: 'cr', head: 'Конверсия в лид', w: 11 },
            { key: 'leads', head: 'Лиды', w: 9 },
            { key: 'cpl', head: 'CPL без НДС', w: 12 },
          ]),
    ];
    const C = Object.fromEntries(cols.map((c, i) => [c.key, i]));
    const L = Object.fromEntries(cols.map((c, i) => [c.key, colName(i)]));
    const sh = createSheet(names[si]);
    sh.widths = cols.map((c) => c.w);
    sh.freezeRow = HEAD;
    brandHeader(sh, `Медиаплан: ${clientName}${spec.scenarios.length > 1 ? ` — ${sc.name}` : ''}`, cols.length - 1);
    sh.heights[HEAD] = 42;
    cols.forEach((c, i) => sh.set(i, HEAD, c.head, S.head));

    const first = HEAD + 1;
    rows.forEach((row, i) => {
      const n = first + i;
      const k = calc[i] ?? {};
      const at = (key) => `${L[key]}${n}`;
      const set = (key, v, s) => sh.set(C[key], n, v, s);
      // высота строки — под перенос длинного таргетинга
      const lines = Math.max(1, Math.ceil(String(row.targeting ?? '').length / (cols[C.targeting].w * 1.15)) + (String(row.targeting ?? '').match(/\n/g)?.length ?? 0));
      sh.heights[n] = Math.max(20, lines * 13 + 6);
      set('channel', row.channel || '', S.textC);
      set('targeting', String(row.targeting ?? '').trim(), S.tints[i % S.tints.length]);
      if (anyCpm) {
        set('model', row.model === 'cpm' ? 'CPM' : 'CPC', S.textC);
        set('cpm', row.cpm ?? null, S.money);
        set('ctr', frac(row.ctr), S.pct);
      }
      // бюджет: вводится в одной из колонок «без НДС» / «с НДС», вторая считается
      if (withVat) {
        set('gross', row.budget ?? null, S.money);
        set('net', { f: `${at('gross')}/(1+${VAT})`, v: k.net ?? 0 }, S.money);
      } else {
        set('net', row.budget ?? null, S.money);
        set('gross', { f: `${at('net')}*(1+${VAT})`, v: k.gross ?? 0 }, S.money);
      }
      if (row.model === 'cpm') {
        set('cpc', { f: `IF(${at('clicks')}>0,${at('net')}/${at('clicks')},0)`, v: k.cpc ?? 0 }, S.money);
        set('clicks', { f: `IF(${at('cpm')}>0,${at('net')}/${at('cpm')}*1000*${at('ctr')},0)`, v: k.clicks ?? 0 }, S.num);
      } else {
        set('cpc', row.cpc ?? null, S.money);
        set('clicks', { f: `IF(${at('cpc')}>0,${at('net')}/${at('cpc')},0)`, v: k.clicks ?? 0 }, S.num);
      }
      if (ecom) {
        set('cart', frac(row.cart), S.pct);
        set('carts', { f: `${at('clicks')}*${at('cart')}`, v: k.carts ?? 0 }, S.num);
        set('cpa', { f: `IF(${at('carts')}>0,${at('gross')}/${at('carts')},0)`, v: k.cpa ?? 0 }, S.money);
        set('sale', frac(row.sale), S.pct);
        set('sales', { f: `${at('clicks')}*${at('sale')}`, v: k.sales ?? 0 }, S.num);
        set('cps', { f: `IF(${at('sales')}>0,${at('gross')}/${at('sales')},0)`, v: k.cps ?? 0 }, S.money0);
        // свой чек строки или общий из допущений
        set('check', row.check != null ? row.check : { f: CHECK, v: k.check ?? 0 }, S.money);
        set('revenue', { f: `${at('sales')}*${at('check')}`, v: k.revenue ?? 0 }, S.money);
        set('drr', { f: `IF(${at('revenue')}>0,${at('gross')}/${at('revenue')},0)`, v: k.drr ?? 0 }, S.pct);
      } else {
        set('cr', frac(row.cr), S.pct);
        set('leads', { f: `${at('clicks')}*${at('cr')}`, v: k.leads ?? 0 }, S.num);
        set('cpl', { f: `IF(${at('leads')}>0,${at('net')}/${at('leads')},0)`, v: k.cpl ?? 0 }, S.money0);
      }
    });
    const last = first + rows.length - 1;
    // одна площадка на несколько строк — объединённая ячейка, как в таблицах агентства
    for (let i = 0; i < rows.length; ) {
      let j = i;
      while (j + 1 < rows.length && rows[j + 1].channel && rows[j + 1].channel === rows[i].channel) j++;
      if (j > i) {
        sh.merge(C.channel, first + i, C.channel, first + j);
        for (let x = i + 1; x <= j; x++) sh.set(C.channel, first + x, null, S.textC);
      }
      i = j + 1;
    }
    if (anyCpm) sh.validations.push({ sqref: `${L.model}${first}:${L.model}${last + 20}`, list: ['CPC', 'CPM'] });

    // итог в месяц: суммы и средневзвешенные ставки
    const t = last + 1;
    const m = res.month;
    const T = (key) => `${L[key]}${t}`;
    const SUM = (key) => `SUM(${L[key]}${first}:${L[key]}${last})`;
    sh.heights[t] = 22;
    cols.forEach((_, i) => sh.set(i, t, null, S.totBlank));
    sh.set(C.channel, t, 'Итого в месяц', S.totLabel).merge(C.channel, t, C.targeting, t);
    sh.set(C.clicks, t, { f: SUM('clicks'), v: m.clicks ?? 0 }, S.totNum);
    sh.set(C.net, t, { f: SUM('net'), v: m.net ?? 0 }, S.totMoney);
    sh.set(C.gross, t, { f: SUM('gross'), v: m.gross ?? 0 }, S.totMoney);
    sh.set(C.cpc, t, { f: `IF(${T('clicks')}>0,${T('net')}/${T('clicks')},0)`, v: m.cpc ?? 0 }, S.totMoney);
    if (ecom) {
      sh.set(C.carts, t, { f: SUM('carts'), v: m.carts ?? 0 }, S.totNum);
      sh.set(C.sales, t, { f: SUM('sales'), v: m.sales ?? 0 }, S.totNum);
      sh.set(C.revenue, t, { f: SUM('revenue'), v: m.revenue ?? 0 }, S.totMoney);
      sh.set(C.cart, t, { f: `IF(${T('clicks')}>0,${T('carts')}/${T('clicks')},0)`, v: div(m.carts, m.clicks) }, S.totPct2);
      sh.set(C.sale, t, { f: `IF(${T('clicks')}>0,${T('sales')}/${T('clicks')},0)`, v: div(m.sales, m.clicks) }, S.totPct);
      sh.set(C.cpa, t, { f: `IF(${T('carts')}>0,${T('gross')}/${T('carts')},0)`, v: m.cpa ?? 0 }, S.totMoney);
      sh.set(C.cps, t, { f: `IF(${T('sales')}>0,${T('gross')}/${T('sales')},0)`, v: m.cps ?? 0 }, S.totMoney0);
      sh.set(C.check, t, { f: `IF(${T('sales')}>0,${T('revenue')}/${T('sales')},0)`, v: div(m.revenue, m.sales) }, S.totMoney);
      sh.set(C.drr, t, { f: `IF(${T('revenue')}>0,${T('gross')}/${T('revenue')},0)`, v: m.drr ?? 0 }, S.totPct);
    } else {
      sh.set(C.leads, t, { f: SUM('leads'), v: m.leads ?? 0 }, S.totNum);
      sh.set(C.cr, t, { f: `IF(${T('clicks')}>0,${T('leads')}/${T('clicks')},0)`, v: div(m.leads, m.clicks) }, S.totPct2);
      sh.set(C.cpl, t, { f: `IF(${T('leads')}>0,${T('net')}/${T('leads')},0)`, v: m.cpl ?? 0 }, S.totMoney0);
    }

    // за период: комиссия (процент + фикс), НДС, итог к оплате и результат
    const p = t + 2;
    const P = res.period;
    const V = 2; // колонка значений
    const at = (i) => `${colName(V)}${p + 1 + i}`;
    sh.heights[p] = 20;
    sh.set(0, p, `За период (${P.months} мес.)`, S.head).set(1, p, null, S.head).merge(0, p, 1, p);
    sh.set(V, p, 'Сумма', S.head).set(V + 1, p, null, S.head).set(V + 2, p, null, S.head).merge(V, p, V + 2, p);
    const lines = [
      ['Месяцев', { f: `${a}$C$${AR.months}`, v: P.months }, S.num],
      ['Медиабюджет без НДС, ₽', { f: `${T('net')}*${at(0)}`, v: P.media }, S.money],
      ['Комиссия агентства, ₽', { f: `${at(1)}*${a}$C$${AR.fee}+${a}$C$${AR.fixed}*${at(0)}`, v: P.fee }, S.money],
      ['НДС, ₽', { f: `(${at(1)}+${at(2)})*${VAT}`, v: P.vat }, S.money],
      ['Итого к оплате, ₽', { f: `SUM(${at(1)}:${at(3)})`, v: P.total }, 'total'],
      ...(ecom
        ? [
            ['Продажи за период', { f: `${T('sales')}*${at(0)}`, v: P.sales ?? 0 }, S.num],
            ['Выручка за период, ₽', { f: `${T('revenue')}*${at(0)}`, v: P.revenue ?? 0 }, S.money],
            ['Цена продажи с комиссией и НДС, ₽', { f: `IF(${at(5)}>0,${at(4)}/${at(5)},0)`, v: P.cps ?? 0 }, S.money0],
            ['ДРР с комиссией и НДС', { f: `IF(${at(6)}>0,${at(4)}/${at(6)},0)`, v: P.drr ?? 0 }, S.pct],
          ]
        : [
            ['Лиды за период', { f: `${T('leads')}*${at(0)}`, v: P.leads ?? 0 }, S.num],
            ['Стоимость лида с комиссией и НДС, ₽', { f: `IF(${at(5)}>0,${at(4)}/${at(5)},0)`, v: P.cpl ?? 0 }, S.money0],
            ['Продажи', { f: `${at(5)}*${a}$C$${AR.sale}`, v: P.sales ?? 0 }, S.num],
            ['Выручка, ₽', { f: `${at(7)}*${CHECK}`, v: P.revenue ?? 0 }, S.money],
            ['ДРР (доля рекламных расходов в выручке)', { f: `IF(${at(8)}>0,${at(4)}/${at(8)},0)`, v: P.drr ?? 0 }, S.pct],
          ]),
    ];
    lines.forEach(([label, f, style], i) => {
      const row = p + 1 + i;
      const total = style === 'total';
      sh.heights[row] = total ? 22 : 18;
      sh.set(0, row, label, total ? S.totLabel : S.label).set(1, row, null, total ? S.totBlank : S.label).merge(0, row, 1, row);
      sh.set(V, row, f, total ? S.totMoney : style);
      // значение — на три колонки, чтобы большие суммы не превращались в ###
      sh.set(V + 1, row, null, total ? S.totBlank : style).set(V + 2, row, null, total ? S.totBlank : style).merge(V, row, V + 2, row);
    });
    footnote(
      sh,
      p + lines.length + 2,
      `Бюджеты в месяц ${withVat ? 'с НДС' : 'без НДС'}; ставки CPC и CPM — без НДС; ${ecom ? 'CR1 и CR2 — от кликов' : 'конверсия — от кликов'}. Прогноз агентства от ${dateStr}${author ? `, подготовил ${author}` : ''}. Цифры — расчёт по нормативам, не обещание результата.`,
    );
    totals.push({
      sheet: names[si],
      cells: ecom
        ? [[T('gross'), m.gross], [T('sales'), m.sales], [T('revenue'), m.revenue], [at(4), P.total], [at(6), P.revenue], [at(8), P.drr]]
        : [[T('net'), m.net], [T('leads'), m.leads], [T('cpl'), m.cpl], [at(4), P.total], [at(5), P.leads], [at(9), P.drr]],
    });
    return sh;
  }

  // ---------- сводка ----------
  // сводка нужна, только когда сценариев несколько
  const sum = createSheet('Сводка');
  sum.widths = [26, 20, 16, 18, 24, 20, 14];
  brandHeader(sum, `Медиаплан: ${clientName} — сравнение сценариев`, 6);
  sum.heights[HEAD] = 34;
  const heads = ecom
    ? ['Сценарий', 'Бюджет в месяц с НДС, ₽', 'Продажи в месяц', 'Выручка в месяц, ₽', 'Итого к оплате за период, ₽', 'Выручка за период, ₽', 'ДРР с комиссией и НДС']
    : ['Сценарий', 'Бюджет в месяц без НДС, ₽', 'Лиды в месяц', 'CPL без НДС, ₽', 'Итого к оплате за период, ₽', 'Лиды за период', 'ДРР с комиссией и НДС'];
  heads.forEach((t, c) => sum.set(c, HEAD, t, S.head));
  const sumStyles = ecom ? [S.money, S.num, S.money, S.money, S.money, S.pct] : [S.money, S.num, S.money0, S.money, S.num, S.pct];
  totals.forEach((x, i) => {
    const rr = HEAD + 1 + i;
    const sr = ref(x.sheet);
    sum.heights[rr] = 20;
    sum.set(0, rr, spec.scenarios[i].name, S.labelBold);
    x.cells.forEach(([cellRef, v], c) => sum.set(c + 1, rr, { f: `${sr}${cellRef}`, v: v ?? 0 }, sumStyles[c]));
  });
  footnote(sum, HEAD + totals.length + 2, `Прогноз агентства от ${dateStr}${author ? `, подготовил ${author}` : ''}. Цифры — расчёт по нормативам, не обещание результата.`);

  // первым открывается сам медиаплан, как в рабочих файлах агентства
  const sheets = [...scenarioSheets, ...(spec.scenarios.length > 1 ? [sum] : []), as];
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${logoSize ? `<Default Extension="png" ContentType="image/png"/>${sheets.map((_, i) => `<Override PartName="/xl/drawings/drawing${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`).join('')}` : ''}</Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
  );
  zip.file(
    'docProps/core.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(plan.title)}</dc:title><dc:creator>${xml(author || 'Soroka Marketing')}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().slice(0, 19)}Z</dcterms:created></cp:coreProperties>`,
  );
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheets.map((sh, i) => `<sheet name="${xml(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  // логотип — оригинальный файл бренда; у каждого листа своя «рисовалка» со ссылкой на один файл
  const EMU = 9525;
  const logoH = 56;
  const logoW = logoSize ? Math.round((logoSize.width / logoSize.height) * logoH) : 0;
  if (logoSize) zip.file('xl/media/logo.png', logo);
  sheets.forEach((sh, i) => {
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, sh.xml());
    if (!sh.drawing) return;
    zip.file(
      `xl/worksheets/_rels/sheet${i + 1}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${i + 1}.xml"/></Relationships>`,
    );
    zip.file(
      `xl/drawings/_rels/drawing${i + 1}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/logo.png"/></Relationships>`,
    );
    zip.file(
      `xl/drawings/drawing${i + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>${6 * EMU}</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>${4 * EMU}</xdr:rowOff></xdr:from><xdr:ext cx="${logoW * EMU}" cy="${logoH * EMU}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Логотип"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${logoW * EMU}" cy="${logoH * EMU}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>`,
    );
  });
  zip.file('xl/styles.xml', st.xml());
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
