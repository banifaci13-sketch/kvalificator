// Медиаплан в Excel с живыми формулами: менеджер меняет бюджет или CTR — пересчитываются все листы.
// Синие ячейки — исходные данные, чёрные — формулы, зелёные — ссылки на другой лист,
// жёлтая заливка — ключевые допущения. Файл собирается без сторонних библиотек для Excel (OOXML + zip).

import JSZip from 'jszip';

const FONT = 'Arial';
const NUM = '#,##0;-#,##0;"-"';
const MONEY2 = '#,##0.00;-#,##0.00;"-"';
const PCT = '0.0%;-0.0%;"-"';

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
  const style = ({ size = 10, bold = false, italic = false, color = '000000', fill = null, border = null, fmt = null, wrap = false, align = null } = {}) => {
    const font = index(fonts, `<font>${bold ? '<b/>' : ''}${italic ? '<i/>' : ''}<sz val="${size}"/><color rgb="FF${color}"/><name val="${FONT}"/></font>`);
    const fillId = fill ? index(fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${fill}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const borderId = border
      ? index(borders, `<border><left/><right/>${border === 'top' ? '<top style="thin"><color rgb="FF20252A"/></top>' : '<top/>'}${border === 'bottom' ? '<bottom style="thin"><color rgb="FF20252A"/></bottom>' : '<bottom/>'}<diagonal/></border>`)
      : 0;
    const fmtId = fmt ? 164 + index(fmts, fmt) : 0;
    const alignment = wrap || align ? `<alignment${wrap ? ' wrapText="1" vertical="top"' : ''}${align ? ` horizontal="${align}"` : ''}/>` : '';
    return index(
      xfs,
      `<xf numFmtId="${fmtId}" fontId="${font}" fillId="${fillId}" borderId="${borderId}" xfId="0"${fmtId ? ' applyNumberFormat="1"' : ''}${fillId ? ' applyFill="1"' : ''}${borderId ? ' applyBorder="1"' : ''}${alignment ? ' applyAlignment="1"' : ''}>${alignment}</xf>`,
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

/** Лист: set(колонка, строка, значение | {f: формула}, стиль). */
function createSheet(name) {
  const rows = new Map();
  const sheet = {
    name,
    widths: [],
    validations: [],
    freezeRow: 0,
    set(col, row, value, s = 0) {
      if (!rows.has(row)) rows.set(row, new Map());
      rows.get(row).set(col, { value, s });
      return sheet;
    },
    xml() {
      const body = [...rows.keys()]
        .sort((a, b) => a - b)
        .map((r) => {
          const cells = [...rows.get(r).entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([c, { value, s }]) => {
              const at = `${colName(c)}${r}`;
              if (value == null) return `<c r="${at}" s="${s}"/>`;
              if (typeof value === 'object') return `<c r="${at}" s="${s}"><f>${xml(value.f)}</f></c>`;
              if (typeof value === 'number') return `<c r="${at}" s="${s}"><v>${value}</v></c>`;
              return `<c r="${at}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
            })
            .join('');
          return `<row r="${r}">${cells}</row>`;
        })
        .join('');
      const cols = sheet.widths.length ? `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
      const pane = sheet.freezeRow
        ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${sheet.freezeRow}" topLeftCell="A${sheet.freezeRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
        : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
      const dv = sheet.validations.length
        ? `<dataValidations count="${sheet.validations.length}">${sheet.validations.map((v) => `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="${v.sqref}"><formula1>"${v.list.join(',')}"</formula1></dataValidation>`).join('')}</dataValidations>`
        : '';
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>${pane}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${body}</sheetData>${dv}<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
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

/**
 * plan — { title, client, spec }; benchmarks — нормативы, использованные в плане (для листа допущений).
 * Возвращает Buffer .xlsx.
 */
export async function mediaplanXlsx(plan, { benchmarks = [], author = '' } = {}) {
  const spec = plan.spec;
  const st = createStyles();
  const S = {
    title: st.style({ size: 14, bold: true }),
    note: st.style({ size: 9, italic: true, color: '595959' }),
    head: st.style({ bold: true, fill: 'F3F6F7', border: 'bottom', wrap: true }),
    label: st.style(),
    labelBold: st.style({ bold: true }),
    inText: st.style({ color: '0000FF' }),
    inNum: st.style({ color: '0000FF', fmt: NUM }),
    inMoney2: st.style({ color: '0000FF', fmt: MONEY2 }),
    inPct: st.style({ color: '0000FF', fmt: PCT }),
    keyNum: st.style({ color: '0000FF', fill: 'FFFF00', fmt: NUM }),
    keyPct: st.style({ color: '0000FF', fill: 'FFFF00', fmt: PCT }),
    num: st.style({ fmt: NUM }),
    money2: st.style({ fmt: MONEY2 }),
    pct: st.style({ fmt: PCT }),
    totLabel: st.style({ bold: true, border: 'top' }),
    totNum: st.style({ bold: true, border: 'top', fmt: NUM }),
    totMoney2: st.style({ bold: true, border: 'top', fmt: MONEY2 }),
    totBlank: st.style({ border: 'top' }),
    boldNum: st.style({ bold: true, fmt: NUM }),
    linkNum: st.style({ color: '008000', fmt: NUM }),
    linkPct: st.style({ color: '008000', fmt: PCT }),
    wrap: st.style({ wrap: true }),
  };

  const names = sheetNames(spec.scenarios.map((s) => s.name));
  const A = 'Допущения';
  const a = ref(A);

  // ---------- допущения ----------
  const ecom = spec.kind === 'ecom';
  const as = createSheet(A);
  as.widths = [52, 16, 12, 10, 10, 12, 60];
  as.set(0, 1, 'Допущения медиаплана', S.title);
  as.set(0, 2, 'Жёлтые ячейки — исходные данные: измените их, и пересчитаются все листы.', S.note);
  const settings = spec.settings ?? {};
  const inputs = [
    [4, 'Период, месяцев', Math.max(1, spec.months ?? 1), S.keyNum],
    [5, 'Комиссия агентства', frac(settings.agencyFee) ?? 0, S.keyPct],
    [6, 'НДС (0 — без НДС)', frac(settings.vat) ?? 0, S.keyPct],
    [7, ecom ? 'Не используется в интернет-магазине' : 'Конверсия лида в продажу', ecom ? 0 : frac(settings.saleRate) ?? 0, S.keyPct],
    [8, ecom ? 'Средний чек по умолчанию, ₽' : 'Средний чек, ₽', settings.avgCheck ?? 0, S.keyNum],
    [9, 'Бюджеты в таблицах указаны с НДС (1 — да, 0 — нет)', settings.budgetWithVat ? 1 : 0, S.keyNum],
  ];
  for (const [r, label, v, s] of inputs) as.set(0, r, label, S.label).set(1, r, v, s);
  as.set(0, 11, 'На чём основан прогноз', S.labelBold);
  as.set(0, 12, spec.assumptions || 'Не указано', S.wrap);
  let r = 14;
  if (benchmarks.length) {
    as.set(0, r, 'Нормативы агентства по каналам', S.labelBold);
    r += 1;
    ['Канал', 'CPC, ₽', 'CPM, ₽', 'CTR', 'Конверсия в лид', 'Обновлено', 'Основание'].forEach((t, c) => as.set(c, r, t, S.head));
    for (const b of benchmarks) {
      r += 1;
      as.set(0, r, b.channel, S.inText).set(1, r, b.cpc, S.inMoney2).set(2, r, b.cpm, S.inMoney2).set(3, r, frac(b.ctr), S.inPct).set(4, r, frac(b.cr), S.inPct);
      as.set(5, r, String(b.updated_at ?? '').slice(0, 10), S.label).set(6, r, b.note, S.label);
    }
  }
  // бюджет без НДС: если в таблице введён с НДС, делим на (1 + НДС)
  const VAT = `${a}$B$6`;
  const netOf = (cell) => `${cell}/(1+${VAT}*${a}$B$9)`;

  // ---------- сценарии ----------
  const totals = [];
  const scenarioSheets = spec.scenarios.map((sc, si) => (ecom ? ecomSheet(sc, si) : leadsSheet(sc, si)));

  function leadsSheet(sc, si) {
    const sh = createSheet(names[si]);
    sh.widths = [36, 9, 16, 11, 11, 9, 13, 14, 12, 10, 13, 13];
    sh.freezeRow = 4;
    sh.set(0, 1, `Медиаплан: ${plan.client || plan.title} — ${sc.name}`, S.title);
    sh.set(0, 2, `Синие ячейки — исходные данные; чёрные — формулы; бюджеты в месяц, ${settings.budgetWithVat ? 'с НДС' : 'без НДС'}, без комиссии.`, S.note);
    ['Канал', 'Модель', 'Бюджет в месяц, ₽', 'CPC, ₽', 'CPM, ₽', 'CTR', 'Конверсия в лид', 'Показы', 'Клики', 'Лиды', 'Цена клика, ₽', 'CPL, ₽'].forEach((t, c) => sh.set(c, 4, t, S.head));
    const first = 5;
    const rows = sc.rows.length ? sc.rows : [{ model: 'cpc' }];
    rows.forEach((row, i) => {
      const n = first + i;
      const net = netOf(`C${n}`);
      sh.set(0, n, row.channel || '', S.inText)
        .set(1, n, row.model === 'cpm' ? 'CPM' : 'CPC', S.inText)
        .set(2, n, row.budget ?? null, S.inNum)
        .set(3, n, row.cpc ?? null, S.inMoney2)
        .set(4, n, row.cpm ?? null, S.inMoney2)
        .set(5, n, frac(row.ctr), S.inPct)
        .set(6, n, frac(row.cr), S.inPct)
        .set(7, n, { f: `IF(B${n}="CPM",IF(E${n}>0,${net}/E${n}*1000,0),IF(AND(D${n}>0,F${n}>0),${net}/D${n}/F${n},0))` }, S.num)
        .set(8, n, { f: `IF(B${n}="CPM",IF(E${n}>0,${net}/E${n}*1000*F${n},0),IF(D${n}>0,${net}/D${n},0))` }, S.num)
        .set(9, n, { f: `I${n}*G${n}` }, S.num)
        .set(10, n, { f: `IF(I${n}>0,${net}/I${n},0)` }, S.money2)
        .set(11, n, { f: `IF(J${n}>0,${net}/J${n},0)` }, S.num);
    });
    const last = first + rows.length - 1;
    const t = last + 1;
    sh.validations.push({ sqref: `B${first}:B${last + 20}`, list: ['CPC', 'CPM'] });
    sh.set(0, t, 'Итого в месяц', S.totLabel).set(1, t, null, S.totBlank);
    sh.set(2, t, { f: `SUM(C${first}:C${last})` }, S.totNum);
    for (const c of [3, 4, 5, 6]) sh.set(c, t, null, S.totBlank);
    for (const [c, L] of [[7, 'H'], [8, 'I'], [9, 'J']]) sh.set(c, t, { f: `SUM(${L}${first}:${L}${last})` }, S.totNum);
    sh.set(10, t, { f: `IF(I${t}>0,${netOf(`C${t}`)}/I${t},0)` }, S.totMoney2).set(11, t, { f: `IF(J${t}>0,${netOf(`C${t}`)}/J${t},0)` }, S.totNum);

    // за период: комиссия, НДС, продажи — по допущениям
    const p = t + 2;
    sh.set(0, p, 'За период', S.labelBold);
    const lines = [
      ['Месяцев', { f: `${a}$B$4` }, S.linkNum],
      ['Медиабюджет без НДС, ₽', { f: `${netOf(`C${t}`)}*C${p + 1}` }, S.num],
      ['Комиссия агентства, ₽', { f: `C${p + 2}*${a}$B$5` }, S.num],
      ['НДС, ₽', { f: `(C${p + 2}+C${p + 3})*${VAT}` }, S.num],
      ['Итого к оплате, ₽', { f: `SUM(C${p + 2}:C${p + 4})` }, S.boldNum],
      ['Лиды за период', { f: `J${t}*C${p + 1}` }, S.num],
      ['Стоимость лида с комиссией и НДС, ₽', { f: `IF(C${p + 6}>0,C${p + 5}/C${p + 6},0)` }, S.num],
      ['Продажи', { f: `C${p + 6}*${a}$B$7` }, S.num],
      ['Выручка, ₽', { f: `C${p + 8}*${a}$B$8` }, S.num],
      ['ДРР (доля рекламных расходов в выручке)', { f: `IF(C${p + 9}>0,C${p + 5}/C${p + 9},0)` }, S.pct],
    ];
    lines.forEach(([label, f, st], i) => sh.set(0, p + 1 + i, label, i === 4 ? S.labelBold : S.label).set(2, p + 1 + i, f, st));
    totals.push({ sheet: names[si], cells: [`C${t}`, `J${t}`, `L${t}`, `C${p + 5}`, `C${p + 6}`, `C${p + 10}`] });
    return sh;
  }

  // Интернет-магазин: как в медиапланах агентства для e-com — корзины, продажи, выручка, ДРР по строкам
  function ecomSheet(sc, si) {
    const sh = createSheet(names[si]);
    sh.widths = [18, 40, 8, 15, 10, 10, 8, 11, 11, 12, 15, 15, 11, 10, 12, 10, 12, 15, 9];
    sh.freezeRow = 4;
    sh.set(0, 1, `Медиаплан: ${plan.client || plan.title} — ${sc.name}`, S.title);
    sh.set(0, 2, `Синие ячейки — исходные данные; чёрные — формулы. Бюджет в месяц ${settings.budgetWithVat ? 'с НДС' : 'без НДС'}; CPC и CPM — без НДС; CR1 и CR2 — от кликов.`, S.note);
    [
      'Площадка', 'Таргетинг', 'Модель', 'Бюджет в месяц, ₽', 'CPC, ₽', 'CPM, ₽', 'CTR', 'CR1 (в корзину)', 'CR2 (в продажу)', 'Ср. чек, ₽',
      'Стоимость без НДС, ₽', 'Стоимость с НДС, ₽', 'Клики', 'Корзины', 'CPA (цена корзины), ₽', 'Продажи', 'CPS (цена продажи), ₽', 'Выручка, ₽', 'ДРР',
    ].forEach((t, c) => sh.set(c, 4, t, S.head));
    const first = 5;
    const rows = sc.rows.length ? sc.rows : [{ model: 'cpc' }];
    rows.forEach((row, i) => {
      const n = first + i;
      sh.set(0, n, row.channel || '', S.inText)
        .set(1, n, String(row.targeting ?? '').replace(/\n+/g, '; '), S.inText)
        .set(2, n, row.model === 'cpm' ? 'CPM' : 'CPC', S.inText)
        .set(3, n, row.budget ?? null, S.inNum)
        .set(4, n, row.cpc ?? null, S.inMoney2)
        .set(5, n, row.cpm ?? null, S.inMoney2)
        .set(6, n, frac(row.ctr), S.inPct)
        .set(7, n, frac(row.cart), S.inPct)
        .set(8, n, frac(row.sale), S.inPct)
        .set(9, n, row.check ?? null, S.inNum)
        .set(10, n, { f: netOf(`D${n}`) }, S.money2)
        .set(11, n, { f: `K${n}*(1+${VAT})` }, S.money2)
        .set(12, n, { f: `IF(C${n}="CPM",IF(F${n}>0,K${n}/F${n}*1000*G${n},0),IF(E${n}>0,K${n}/E${n},0))` }, S.num)
        .set(13, n, { f: `M${n}*H${n}` }, S.num)
        .set(14, n, { f: `IF(N${n}>0,L${n}/N${n},0)` }, S.money2)
        .set(15, n, { f: `M${n}*I${n}` }, S.num)
        .set(16, n, { f: `IF(P${n}>0,L${n}/P${n},0)` }, S.num)
        .set(17, n, { f: `P${n}*IF(J${n}>0,J${n},${a}$B$8)` }, S.money2)
        .set(18, n, { f: `IF(R${n}>0,L${n}/R${n},0)` }, S.pct);
    });
    const last = first + rows.length - 1;
    const t = last + 1;
    sh.validations.push({ sqref: `C${first}:C${last + 20}`, list: ['CPC', 'CPM'] });
    sh.set(0, t, 'Итого в месяц', S.totLabel);
    for (const c of [1, 2, 5, 6, 7, 8, 9]) sh.set(c, t, null, S.totBlank);
    for (const [c, L] of [[3, 'D'], [10, 'K'], [11, 'L'], [12, 'M'], [13, 'N'], [15, 'P'], [17, 'R']]) sh.set(c, t, { f: `SUM(${L}${first}:${L}${last})` }, c >= 10 && c !== 12 && c !== 13 && c !== 15 ? S.totMoney2 : S.totNum);
    sh.set(4, t, { f: `IF(M${t}>0,K${t}/M${t},0)` }, S.totMoney2);
    sh.set(14, t, { f: `IF(N${t}>0,L${t}/N${t},0)` }, S.totMoney2);
    sh.set(16, t, { f: `IF(P${t}>0,L${t}/P${t},0)` }, S.totNum);
    sh.set(18, t, { f: `IF(R${t}>0,L${t}/R${t},0)` }, S.pct);

    const p = t + 2;
    sh.set(0, p, 'За период', S.labelBold);
    const lines = [
      ['Месяцев', { f: `${a}$B$4` }, S.linkNum],
      ['Медиабюджет без НДС, ₽', { f: `K${t}*D${p + 1}` }, S.num],
      ['Комиссия агентства, ₽', { f: `D${p + 2}*${a}$B$5` }, S.num],
      ['НДС, ₽', { f: `(D${p + 2}+D${p + 3})*${VAT}` }, S.num],
      ['Итого к оплате, ₽', { f: `SUM(D${p + 2}:D${p + 4})` }, S.boldNum],
      ['Продажи за период', { f: `P${t}*D${p + 1}` }, S.num],
      ['Выручка за период, ₽', { f: `R${t}*D${p + 1}` }, S.num],
      ['Цена продажи с комиссией и НДС, ₽', { f: `IF(D${p + 6}>0,D${p + 5}/D${p + 6},0)` }, S.num],
      ['ДРР с комиссией', { f: `IF(D${p + 7}>0,D${p + 5}/D${p + 7},0)` }, S.pct],
    ];
    lines.forEach(([label, f, st], i) => sh.set(0, p + 1 + i, label, i === 4 ? S.labelBold : S.label).set(3, p + 1 + i, f, st));
    totals.push({ sheet: names[si], cells: [`L${t}`, `P${t}`, `R${t}`, `D${p + 5}`, `D${p + 7}`, `D${p + 9}`] });
    return sh;
  }

  // ---------- сводка ----------
  const sum = createSheet('Сводка');
  sum.widths = [34, 20, 16, 16, 24, 18, 12];
  sum.set(0, 1, `Медиаплан: ${plan.client || plan.title}`, S.title);
  const dateStr = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' });
  sum.set(0, 2, `Прогноз агентства, ${dateStr}${author ? `. Подготовил: ${author}` : ''}. Цифры — расчёт по нормативам, не обещание результата.`, S.note);
  const heads = ecom
    ? ['Сценарий', 'Бюджет в месяц с НДС, ₽', 'Продажи в месяц', 'Выручка в месяц, ₽', 'Итого к оплате за период, ₽', 'Выручка за период, ₽', 'ДРР']
    : ['Сценарий', 'Бюджет в месяц, ₽', 'Лиды в месяц', 'CPL, ₽', 'Итого к оплате за период, ₽', 'Лиды за период', 'ДРР'];
  heads.forEach((t, c) => sum.set(c, 4, t, S.head));
  totals.forEach((x, i) => {
    const rr = 5 + i;
    const sr = ref(x.sheet);
    sum.set(0, rr, spec.scenarios[i].name, S.label);
    x.cells.forEach((cell, c) => sum.set(c + 1, rr, { f: `${sr}${cell}` }, c === 5 ? S.linkPct : S.linkNum));
  });

  const sheets = [sum, ...scenarioSheets, as];
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
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
  sheets.forEach((sh, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, sh.xml()));
  zip.file('xl/styles.xml', st.xml());
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
