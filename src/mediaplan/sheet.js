// Медиаплан для PDF и картинок (PNG, JPG): та же таблица, что в Excel — логотип и заголовок,
// голубая шапка, сегменты таргетинга цветом, строка «Итого», блок «За период». Страница
// самодостаточная: шрифты и логотип встроены, внешних запросов нет. Рисует встроенный Chromium.

import { calcPlan } from './calc.js';
import { scenarioColumns } from './xlsx.js';
import { fontFaces } from '../docs/render-html.js';
import { withPage } from '../docs/browser.js';

export const SHEET_FORMATS = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg' };

const TINTS = ['#00FF00', '#FFFF00', '#F6B26B', '#EA9999', '#A4C2F4', '#B4A7D6'];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const nf = (d) => new Intl.NumberFormat('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt = {
  num: (v) => (v ? nf(0).format(v) : '–'),
  money: (v) => (v ? `${nf(2).format(v)} ₽` : '–'),
  money0: (v) => (v ? `${nf(0).format(v)} ₽` : '–'),
  pct: (v) => (v ? `${nf(2).format(v * 100)} %` : '–'),
  pct1: (v) => (v ? `${nf(1).format(v * 100)} %` : '–'),
};
const div = (a, b) => (a != null && b ? a / b : 0);
const frac = (v) => (typeof v === 'number' ? v / 100 : null);

/** Значение ячейки строки по ключу колонки — те же правила, что у формул в Excel. */
function cell(key, row, k, settings) {
  switch (key) {
    case 'channel': return esc(row.channel);
    case 'targeting': return esc(String(row.targeting ?? '').trim()).replace(/\n/g, '<br>');
    case 'model': return row.model === 'cpm' ? 'CPM' : 'CPC';
    case 'cpm': return row.model === 'cpm' ? fmt.money(row.cpm) : '–';
    case 'ctr': return fmt.pct(frac(row.ctr));
    case 'clicks': return fmt.num(k.clicks);
    case 'cpc': return fmt.money(row.model === 'cpm' ? k.cpc : row.cpc);
    case 'net': return fmt.money(k.net);
    case 'gross': return fmt.money(k.gross);
    case 'cart': return fmt.pct(frac(row.cart));
    case 'carts': return fmt.num(k.carts);
    case 'cpa': return fmt.money(k.cpa);
    case 'sale': return fmt.pct(frac(row.sale));
    case 'sales': return fmt.num(k.sales);
    case 'cps': return fmt.money0(k.cps);
    case 'check': return fmt.money(row.check ?? settings.avgCheck);
    case 'revenue': return fmt.money(k.revenue);
    case 'drr': return fmt.pct(k.drr);
    case 'cr': return fmt.pct(frac(row.cr));
    case 'leads': return fmt.num(k.leads);
    case 'cpl': return fmt.money0(k.cpl);
    default: return '';
  }
}

function totalCell(key, m) {
  switch (key) {
    case 'clicks': return fmt.num(m.clicks);
    case 'cpc': return fmt.money(m.cpc);
    case 'net': return fmt.money(m.net);
    case 'gross': return fmt.money(m.gross);
    case 'cart': return fmt.pct(div(m.carts, m.clicks));
    case 'carts': return fmt.num(m.carts);
    case 'cpa': return fmt.money(m.cpa);
    case 'sale': return fmt.pct1(div(m.sales, m.clicks));
    case 'sales': return fmt.num(m.sales);
    case 'cps': return fmt.money0(m.cps);
    case 'check': return fmt.money(div(m.revenue, m.sales));
    case 'revenue': return fmt.money(m.revenue);
    case 'drr': return fmt.pct1(m.drr);
    case 'cr': return fmt.pct(div(m.leads, m.clicks));
    case 'leads': return fmt.num(m.leads);
    case 'cpl': return fmt.money0(m.cpl);
    default: return '';
  }
}

function scenarioHtml(plan, sc, res, { title, logo, author, dateStr }) {
  const spec = plan.spec;
  const settings = spec.settings ?? {};
  const ecom = spec.kind === 'ecom';
  const rows = sc.rows.length ? sc.rows : [{ model: 'cpc' }];
  const calc = sc.rows.length ? res.rows : [{}];
  const cols = scenarioColumns(ecom, rows.some((r) => r.model === 'cpm'));
  // одна площадка на несколько строк — объединённая ячейка
  const span = rows.map(() => 1);
  for (let i = 0; i < rows.length; ) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1].channel && rows[j + 1].channel === rows[i].channel) j++;
    span[i] = j - i + 1;
    for (let x = i + 1; x <= j; x++) span[x] = 0;
    i = j + 1;
  }
  const body = rows
    .map((row, i) =>
      `<tr>${cols
        .map((c) => {
          if (c.key === 'channel') return span[i] ? `<td class="c-channel"${span[i] > 1 ? ` rowspan="${span[i]}"` : ''}>${cell('channel', row, calc[i] ?? {}, settings)}</td>` : '';
          if (c.key === 'targeting') return `<td class="c-targeting" style="background:${TINTS[i % TINTS.length]}">${cell('targeting', row, calc[i] ?? {}, settings)}</td>`;
          return `<td>${cell(c.key, row, calc[i] ?? {}, settings)}</td>`;
        })
        .join('')}</tr>`,
    )
    .join('');
  const total = `<tr class="total"><td colspan="2">Итого в месяц</td>${cols.slice(2).map((c) => `<td>${totalCell(c.key, res.month)}</td>`).join('')}</tr>`;
  const P = res.period;
  const period = [
    ['Месяцев', fmt.num(P.months)],
    ['Медиабюджет без НДС', fmt.money(P.media)],
    ['Комиссия агентства', fmt.money(P.fee)],
    ['НДС', fmt.money(P.vat)],
    ['Итого к оплате', fmt.money(P.total), true],
    ...(ecom
      ? [['Продажи за период', fmt.num(P.sales)], ['Выручка за период', fmt.money(P.revenue)], ['Цена продажи с комиссией и НДС', fmt.money0(P.cps)], ['ДРР с комиссией и НДС', fmt.pct(P.drr)]]
      : [['Лиды за период', fmt.num(P.leads)], ['Стоимость лида с комиссией и НДС', fmt.money0(P.cpl)], ['Продажи', fmt.num(P.sales)], ['Выручка', fmt.money(P.revenue)], ['ДРР', fmt.pct(P.drr)]]),
  ]
    .map(([l, v, t]) => `<tr${t ? ' class="total"' : ''}><td>${l}</td><td>${v}</td></tr>`)
    .join('');
  const note = `Бюджеты в месяц ${settings.budgetWithVat ? 'с НДС' : 'без НДС'}; ставки CPC и CPM — без НДС; ${ecom ? 'CR1 и CR2 — от кликов' : 'конверсия — от кликов'}. Прогноз агентства от ${dateStr}${author ? `, подготовил ${esc(author)}` : ''}. Цифры — расчёт по нормативам, не обещание результата.`;
  return `<section class="sheet">
  <header>${logo ? `<img class="logo" src="${logo}" alt="SOROKA — агентство интернет-маркетинга">` : '<div class="wordmark">SOROKA<small>агентство <b>интернет-маркетинга</b></small></div>'}<h1>${esc(title)}</h1></header>
  <table class="plan"><thead><tr>${cols.map((c) => `<th>${esc(c.head)}</th>`).join('')}</tr></thead><tbody>${body}${total}</tbody></table>
  <table class="period"><thead><tr><th>За период (${P.months} мес.)</th><th>Сумма</th></tr></thead><tbody>${period}</tbody></table>
  ${spec.assumptions ? `<p class="assume"><b>На чём основан прогноз.</b> ${esc(spec.assumptions)}</p>` : ''}
  <p class="note">${note}</p>
</section>`;
}

/** HTML медиаплана: все сценарии или один (scenario — номер). */
export function mediaplanSheetHtml(plan, { brand, logo = null, author = '', scenario = null } = {}) {
  const spec = plan.spec;
  const results = calcPlan(spec);
  const client = plan.client || plan.title;
  const dateStr = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' }).replace(/\s*г\.$/, '');
  const many = spec.scenarios.length > 1;
  const indexes = scenario != null ? [scenario] : spec.scenarios.map((_, i) => i);
  const sections = indexes.map((i) => scenarioHtml(plan, spec.scenarios[i], results[i], { title: `Медиаплан: ${client}${many ? ` — ${spec.scenarios[i].name}` : ''}`, logo, author, dateStr }));
  const font = brand ? `'${brand.typography.body.family}', ${brand.typography.body.fallback}` : 'Arial, sans-serif';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(plan.title)}</title><style>
${brand ? fontFaces(brand) : ''}
@page { size: A4 landscape; margin: 9mm; }
* { box-sizing: border-box; }
body { margin: 0; background: #fff; color: #000; font-family: ${font}; font-size: 10px; }
.sheet { padding: 18px 20px 14px; width: max-content; min-width: 100%; }
.sheet + .sheet { break-before: page; }
header { display: flex; align-items: center; gap: 28px; margin-bottom: 10px; }
.logo { height: 46px; width: auto; }
.wordmark { font-weight: 800; font-size: 24px; color: #8C8C8C; line-height: 1; }
.wordmark small { display: block; font-size: 7px; font-weight: 400; letter-spacing: .04em; text-transform: uppercase; margin-top: 3px; }
.wordmark small b { color: #00B0F0; }
h1 { flex: 1; margin: 0; font-size: 20px; font-weight: 400; text-align: center; }
table { border-collapse: collapse; }
th, td { border: 1px solid #000; padding: 4px 6px; text-align: center; vertical-align: middle; }
th { background: #00B0F0; font-weight: 700; font-size: 9.5px; line-height: 1.2; }
.plan td { white-space: nowrap; font-variant-numeric: tabular-nums; }
.plan td.c-targeting { white-space: normal; min-width: 180px; max-width: 280px; }
.plan td.c-channel { white-space: normal; max-width: 120px; }
tr.total td { background: #00B0F0; font-weight: 700; }
.period { margin-top: 14px; min-width: 380px; }
.period td:first-child { text-align: left; }
.period td:last-child { min-width: 140px; }
.assume { margin: 12px 0 0; max-width: 900px; }
.note { margin: 6px 0 0; font-size: 8.5px; font-style: italic; color: #595959; max-width: 1100px; }
</style></head><body>${sections.join('\n')}${many && scenario == null ? compareHtml(spec, results, client) : ''}</body></html>`;
}

function compareHtml(spec, results, client) {
  const ecom = spec.kind === 'ecom';
  const heads = ecom
    ? ['Сценарий', 'Бюджет в месяц с НДС', 'Продажи в месяц', 'Выручка в месяц', 'Итого к оплате за период', 'Выручка за период', 'ДРР с комиссией и НДС']
    : ['Сценарий', 'Бюджет в месяц без НДС', 'Лиды в месяц', 'CPL без НДС', 'Итого к оплате за период', 'Лиды за период', 'ДРР с комиссией и НДС'];
  const rows = results
    .map((r, i) => {
      const m = r.month;
      const P = r.period;
      const v = ecom
        ? [fmt.money(m.gross), fmt.num(m.sales), fmt.money(m.revenue), fmt.money(P.total), fmt.money(P.revenue), fmt.pct(P.drr)]
        : [fmt.money(m.net), fmt.num(m.leads), fmt.money0(m.cpl), fmt.money(P.total), fmt.num(P.leads), fmt.pct(P.drr)];
      return `<tr><td style="text-align:left;font-weight:700">${esc(spec.scenarios[i].name)}</td>${v.map((x) => `<td>${x}</td>`).join('')}</tr>`;
    })
    .join('');
  return `<section class="sheet"><header><h1>Медиаплан: ${esc(client)} — сравнение сценариев</h1></header><table class="plan"><thead><tr>${heads.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></section>`;
}

/** Файл медиаплана: PDF (все сценарии) или картинка (один сценарий). */
export async function mediaplanSheetFile(plan, format, opts = {}) {
  if (!(format in SHEET_FORMATS)) throw new Error('Неизвестный формат');
  const html = mediaplanSheetHtml(plan, { ...opts, scenario: format === 'pdf' ? null : (opts.scenario ?? 0) });
  return withPage(
    async (page) => {
      await page.setContent(html, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      if (format === 'pdf') {
        // широкая таблица интернет-магазина — уменьшаем, чтобы влезла в ширину листа A4
        await page.evaluate(() => {
          for (const el of document.querySelectorAll('.sheet')) if (el.scrollWidth > 1040) el.style.zoom = String(1040 / el.scrollWidth);
        });
        return Buffer.from(await page.pdf({ printBackground: true, preferCSSPageSize: true }));
      }
      const box = page.locator('.sheet').first();
      return Buffer.from(await box.screenshot({ type: format === 'png' ? 'png' : 'jpeg', ...(format === 'jpg' ? { quality: 92 } : {}) }));
    },
    { viewport: { width: 1500, height: 900 }, scale: 2 },
  );
}
