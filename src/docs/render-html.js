// HTML-представление презентации: из него получаются PDF (печать в Chromium), превью
// в админке и проверки перед экспортом. Шрифты и логотип встраиваются — файл самодостаточный.

import { readFileSync } from 'node:fs';
import { createLayout } from './layout.js';
import { renderSlide } from './templates.js';
import { chartSvg } from './charts-svg.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Слайды презентации со служебными элементами (подвал, номер страницы). */
export function layoutDeck(deck, brand) {
  const L = createLayout(brand);
  const total = deck.slides.length;
  return deck.slides.map((slide, index) => {
    let built;
    try {
      built = renderSlide(slide, { brand, L, deck, index, total });
    } catch (err) {
      // Недозаполненный слайд не роняет превью всего документа; проверка не пустит его в выгрузку
      built = {
        theme: 'light',
        buildError: err.message,
        elements: [
          { kind: 'text', name: 'title', placeholder: 'title', ...L.titleBox, style: 'title', color: 'ink', text: 'Слайд не собран' },
          { kind: 'text', name: 'body', x: L.M, y: L.contentTop, w: L.CW, h: 120, style: 'body', color: 'steel', text: 'Заполните обязательные поля слайда — после этого он появится здесь.' },
        ],
      };
    }
    if (built.theme === 'light') built.elements.push(...footer(brand, L, deck, index));
    return { ...built, index, source: slide };
  });
}

function footer(brand, L, deck, index) {
  const note = deck.meta?.footer ?? brand.documents.footer;
  return [
    { kind: 'logo', name: 'footer-logo', x: L.M, y: L.footerY - 6, h: 40, variant: 'onLight', chrome: true },
    note ? { kind: 'text', name: 'footer-text', x: L.W - L.M - 640, y: L.footerY + 2, w: 560, h: 32, style: 'caption', color: 'steel', align: 'right', text: note, chrome: true } : null,
    { kind: 'text', name: 'page', x: L.W - L.M - 64, y: L.footerY + 2, w: 64, h: 32, style: 'caption', color: 'ink', align: 'right', text: String(index + 1), chrome: true },
  ].filter(Boolean);
}

/**
 * mode: screen — для просмотра (масштаб под окно); print — для PDF; qa — для проверок (без масштаба).
 * only — индексы слайдов (превью одного слайда в редакторе).
 */
export function renderDeckHtml(deck, brand, { mode = 'screen', only = null } = {}) {
  const L = createLayout(brand);
  const slides = layoutDeck(deck, brand).filter((s) => !only || only.includes(s.index));
  const body = slides.map((s) => slideHtml(s, brand, L)).join('\n');
  const title = esc(deck.meta?.title ?? 'Презентация');

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${esc(brand.label)}">
<title>${title}</title>
<style>
${fontFaces(brand)}
${baseCss(brand, L, mode)}
</style>
</head>
<body class="mode-${mode}${only?.length === 1 ? ' single' : ''}">
<main class="deck">
${body}
</main>
${mode === 'screen' ? SCALE_SCRIPT : ''}
</body>
</html>`;
}

function slideHtml(slide, brand, L) {
  const bg = slide.theme === 'dark' ? brand.color.ink : brand.color.paper;
  const els = slide.elements.map((el) => elementHtml(el, brand, L, slide.theme)).join('\n');
  return `<div class="frame"><section class="slide" data-index="${slide.index}" data-type="${slide.type}" data-theme="${slide.theme}" style="background:${bg}">
${els}
</section></div>`;
}

const box = (el) => `left:${el.x}px;top:${el.y}px;width:${el.w}px;${el.h != null ? `height:${el.h}px;` : ''}`;

function elementHtml(el, brand, L, theme) {
  const attrs = `data-el="${el.kind}" data-name="${esc(el.name)}"${el.chrome ? ' data-chrome="1"' : ''}`;
  switch (el.kind) {
    case 'rect':
      return `<div class="el" ${attrs} style="${box(el)}background:${brand.color[el.fill] ?? el.fill};border-radius:${el.radius ?? 0}px"></div>`;

    case 'text': {
      const color = brand.color[el.color] ?? el.color ?? brand.color.ink;
      const valign = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[el.valign ?? 'top'];
      let content;
      if (el.bullets) {
        const tag = el.numbered ? 'ol' : 'ul';
        content = `<${tag}>${el.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</${tag}>`;
      } else {
        content = esc(el.text).replace(/\n/g, '<br>');
      }
      return `<div class="el t t-${el.style}" ${attrs} data-fit="1" style="${box(el)}color:${color};text-align:${el.align ?? 'left'};justify-content:${valign}"><div class="tc">${content}</div></div>`;
    }

    case 'chart':
      return `<div class="el" ${attrs} style="${box(el)}">${chartSvg(el.chart, { w: el.w, h: el.h, brand })}</div>`;

    case 'table': {
      const cols = el.colW.map((w) => `<col style="width:${w}px">`).join('');
      const align = (i) => el.align?.[i] ?? 'left';
      const cell = (tag, v, i) => `<${tag} style="text-align:${align(i)};height:${el.rowH}px">${esc(v).replace(/\n/g, '<br><span class="sub">').replace(/(<span class="sub">.*)$/, '$1</span>')}</${tag}>`;
      const head = `<thead><tr>${el.header.map((h, i) => cell('th', h, i)).join('')}</tr></thead>`;
      const rows = el.rows.map((r) => `<tr>${r.map((v, i) => cell('td', v, i)).join('')}</tr>`).join('');
      const total = el.total ? `<tfoot><tr>${el.total.map((v, i) => cell('td', v, i)).join('')}</tr></tfoot>` : '';
      return `<table class="el tbl" ${attrs} style="${box(el)}"><colgroup>${cols}</colgroup>${head}<tbody>${rows}</tbody>${total}</table>`;
    }

    case 'image': {
      // object-fit: «cover» обрезает края, «contain» показывает целиком; пропорции не искажаются
      return `<img class="el" ${attrs} data-objfit="${el.fit}" src="${esc(el.src)}" alt="" style="${box(el)}object-fit:${el.fit};border-radius:${el.radius ?? 0}px">`;
    }

    case 'logo': {
      const asset = brand.logo[el.variant] ?? (el.variant === 'onDark' ? null : brand.logo.onLight);
      if (asset) {
        return `<img class="el logo" ${attrs} data-sha="${asset.sha256}" src="${asset.dataUri}" alt="${esc(brand.voice.name_en)}" style="left:${el.x}px;top:${el.y}px;height:${el.h}px;width:auto">`;
      }
      // Оригинального логотипа нет — нейтральная текстовая подпись (знак не рисуем)
      const color = theme === 'dark' ? brand.color.onDark : brand.color.ink;
      return `<div class="el t t-wordmark" data-el="wordmark" data-name="${esc(el.name)}"${el.chrome ? ' data-chrome="1"' : ''} data-fit="1" style="left:${el.x}px;top:${el.y}px;width:520px;height:${el.h}px;color:${color};justify-content:center"><div class="tc">${esc(brand.voice.wordmark)}</div></div>`;
    }

    default:
      throw new Error(`Неизвестный элемент «${el.kind}»`);
  }
}

export function fontFaces(brand) {
  const out = [];
  for (const role of ['heading', 'body']) {
    const t = brand.typography[role];
    for (const f of t.files) {
      const data = readFileSync(brand.fontFile(f)).toString('base64');
      out.push(`@font-face{font-family:'${t.family}';src:url(data:font/woff2;base64,${data}) format('woff2');font-weight:200 800;font-display:block}`);
    }
  }
  return out.join('\n');
}

function baseCss(brand, L, mode) {
  const styles = Object.entries(L.styles)
    .map(([name, s]) => {
      const fam = s.role === 'heading' ? brand.typography.heading : brand.typography.body;
      return `.t-${name}{font-family:'${fam.family}',${fam.fallback};font-size:${s.size}px;font-weight:${s.weight};line-height:${s.lineHeight};letter-spacing:${s.letterSpacing ?? 0}em}`;
    })
    .join('\n');
  const body = `'${brand.typography.body.family}',${brand.typography.body.fallback}`;
  const t = brand.typography.slideScalePx;
  return `
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:#E4E9EC;-webkit-font-smoothing:antialiased;font-family:${body}}
@page{size:${L.W}px ${L.H}px;margin:0}
.slide{position:relative;width:${L.W}px;height:${L.H}px;overflow:hidden;break-after:page;page-break-after:always}
.el{position:absolute;margin:0}
.t{display:flex;flex-direction:column;overflow:hidden;white-space:normal;overflow-wrap:break-word;hyphens:manual}
.tc{min-height:0}
.t ul,.t ol{margin:0;padding:0;list-style:none}
.t li{position:relative;padding-left:1.1em;margin:0 0 .45em}
.t li:last-child{margin-bottom:0}
.t ul li::before{content:'';position:absolute;left:0;top:.55em;width:.32em;height:.32em;border-radius:2px;background:${brand.color.accent}}
.t ol{counter-reset:n}
.t ol li{padding-left:1.6em;counter-increment:n}
.t ol li::before{content:counter(n);position:absolute;left:0;top:0;color:${brand.color.accent};font-weight:700}
.tbl{border-collapse:collapse;table-layout:fixed;font-size:${t.small}px;line-height:1.25;color:${brand.color.ink}}
.tbl th{font-weight:700;font-size:${t.caption}px;color:${brand.color.steel};border-bottom:2px solid ${brand.color.ink};padding:0 16px;vertical-align:middle}
.tbl td{border-bottom:1px solid ${brand.color.line};padding:0 16px;vertical-align:middle;font-variant-numeric:tabular-nums}
.tbl tfoot td{font-weight:700;border-top:2px solid ${brand.color.ink};border-bottom:0}
.tbl .sub{display:block;font-size:${t.caption}px;color:${brand.color.steel};font-weight:400}
.logo{object-fit:contain}
${styles}
${
  mode === 'screen'
    ? `.deck{display:flex;flex-direction:column;align-items:center;gap:24px;padding:24px}
.frame{width:100%;max-width:1280px;aspect-ratio:16/9;overflow:hidden;box-shadow:0 8px 30px rgba(32,37,42,.18);border-radius:6px}
.frame .slide{transform-origin:0 0;transform:scale(var(--s,0.6667))}
.single .deck{padding:0}.single .frame{max-width:none;border-radius:0;box-shadow:none}
@media print{.deck{padding:0;gap:0}.frame{max-width:none;width:auto;aspect-ratio:auto;box-shadow:none;border-radius:0}.frame .slide{transform:none}}`
    : `.deck{display:block}.frame{display:block}`
}
`;
}

// Масштаб слайдов под ширину окна (только в режиме просмотра)
const SCALE_SCRIPT = `<script>
(function(){function f(){document.querySelectorAll('.frame').forEach(function(fr){fr.style.setProperty('--s',fr.clientWidth/1920)})}
addEventListener('resize',f);f();})();
</script>`;
