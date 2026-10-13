// Редактируемый PPTX из тех же макетов, что HTML/PDF: координаты 1:1 (144 px = 1"),
// заголовки — в плейсхолдерах раскладки, графики и таблицы — нативные (правятся в PowerPoint).

import PptxGenJS from 'pptxgenjs';
import { layoutDeck } from './render-html.js';
import { createLayout, PX_PER_INCH, PT_PER_PX } from './layout.js';

const inch = (px) => +(px / PX_PER_INCH).toFixed(4);
const pt = (px) => +(px * PT_PER_PX).toFixed(1);
const hex = (c) => String(c).replace('#', '').toUpperCase();

export async function renderDeckPptx(deck, brand) {
  const L = createLayout(brand);
  const pres = new PptxGenJS();
  pres.layout = 'LAYOUT_WIDE'; // 13.333" × 7.5" = 1920 × 1080 px
  pres.theme = { headFontFace: brand.typography.heading.family, bodyFontFace: brand.typography.body.family };
  pres.title = deck.meta?.title ?? 'Презентация';
  pres.author = deck.meta?.author ?? brand.brand;
  pres.company = brand.brand.replace(/&/g, '&amp;');
  pres.subject = brand.label;

  const color = (name) => hex(brand.color[name] ?? name ?? brand.color.ink);
  const font = (styleName) => {
    const s = L.styles[styleName];
    return { fontFace: s.font, fontSize: pt(s.size), bold: s.weight >= 600, lineSpacingMultiple: s.lineHeight };
  };

  // Раскладки: светлая (контентные слайды) и тёмная (титул, разделы, финал)
  pres.defineSlideMaster({
    title: 'SOROKA_LIGHT',
    background: { color: color('paper') },
    objects: [
      {
        placeholder: {
          options: {
            name: 'title', type: 'title',
            x: inch(L.titleBox.x), y: inch(L.titleBox.y), w: inch(L.titleBox.w), h: inch(L.titleBox.h),
            ...font('title'), color: color('ink'), align: 'left', valign: 'top', margin: 0,
          },
          text: '',
        },
      },
    ],
  });
  pres.defineSlideMaster({ title: 'SOROKA_DARK', background: { color: color('ink') } });

  for (const s of layoutDeck(deck, brand)) {
    const slide = pres.addSlide({ masterName: s.theme === 'dark' ? 'SOROKA_DARK' : 'SOROKA_LIGHT' });
    for (const el of s.elements) addElement(slide, el, s.theme);
    if (s.notes) slide.addNotes(s.notes);
  }

  return pres.write({ outputType: 'nodebuffer' });

  function addElement(slide, el, theme) {
    const pos = { x: inch(el.x), y: inch(el.y), w: inch(el.w ?? 0), h: inch(el.h ?? 0) };
    switch (el.kind) {
      case 'rect': {
        const rounded = el.radius > 0;
        slide.addShape(rounded ? pres.shapes.ROUNDED_RECTANGLE : pres.shapes.RECTANGLE, {
          ...pos,
          fill: { color: color(el.fill) },
          line: { color: color(el.fill), width: 0 },
          ...(rounded ? { rectRadius: inch(el.radius) } : {}),
          objectName: el.name,
        });
        return;
      }

      case 'text': {
        const opts = {
          ...pos, ...font(el.style), color: color(el.color),
          align: el.align ?? 'left', valign: el.valign ?? 'top', margin: 0, isTextBox: true, fit: 'none', objectName: el.name,
        };
        if (el.placeholder === 'title' && theme === 'light') {
          slide.addText(el.text, { placeholder: 'title' });
          return;
        }
        if (el.bullets) {
          const runs = el.bullets.map((b, i) => ({
            text: b,
            options: {
              bullet: el.numbered ? { type: 'number' } : { characterCode: '25A0', indent: pt(L.styles[el.style].size * 1.1) },
              breakLine: i < el.bullets.length - 1,
              paraSpaceAfter: pt(L.styles[el.style].size * 0.45),
            },
          }));
          slide.addText(runs, opts);
          return;
        }
        slide.addText(String(el.text ?? ''), opts);
        return;
      }

      case 'chart':
        addChart(slide, el);
        return;

      case 'table':
        addTable(slide, el);
        return;

      case 'image': {
        if (!String(el.src).startsWith('data:')) throw new Error(`Изображение «${el.name}» не встроено в документ`);
        // pptxgenjs вписывает картинку в блок сам: w/h — пропорции исходника, sizing — размер блока
        const ratio = el.ih / el.iw;
        slide.addImage({
          data: el.src.slice(5),
          x: pos.x, y: pos.y, w: pos.w, h: +(pos.w * ratio).toFixed(4),
          sizing: { type: el.fit === 'contain' ? 'contain' : 'cover', w: pos.w, h: pos.h },
          objectName: el.name,
        });
        return;
      }

      case 'logo': {
        const asset = brand.logo[el.variant] ?? (el.variant === 'onDark' ? null : brand.logo.onLight);
        if (asset) {
          const ratio = imageRatio(asset);
          slide.addImage({ data: `${asset.mime};base64,${asset.data.toString('base64')}`, x: pos.x, y: pos.y, h: inch(el.h), w: inch(el.h * ratio), objectName: el.name });
        } else {
          slide.addText(brand.voice.wordmark, {
            x: pos.x, y: pos.y, w: inch(520), h: inch(el.h), ...font('wordmark'),
            charSpacing: pt(L.styles.wordmark.size) * 0.08, color: theme === 'dark' ? color('onDark') : color('ink'),
            valign: 'middle', margin: 0, isTextBox: true, objectName: el.name,
          });
        }
        return;
      }

      default:
        throw new Error(`Неизвестный элемент «${el.kind}»`);
    }
  }

  function addChart(slide, el) {
    const c = el.chart;
    const type = c.type ?? 'column';
    const data = c.series.map((s) => ({ name: s.name, labels: c.categories, values: s.values }));
    const caption = pt(brand.typography.slideScalePx.caption);
    const common = {
      x: inch(el.x), y: inch(el.y), w: inch(el.w), h: inch(el.h),
      // Один ряд — один цвет: при нескольких цветах PowerPoint красит каждый столбец по-своему
      chartColors: c.series.length > 1 ? brand.dataviz.categorical.slice(0, c.series.length).map(hex) : [hex(brand.dataviz.categorical[0])],
      showValue: true,
      dataLabelFontSize: caption,
      dataLabelFontFace: '+mn-lt',
      dataLabelColor: color('ink'),
      catAxisLabelFontSize: caption,
      catAxisLabelFontFace: '+mn-lt',
      catAxisLabelColor: hex(brand.dataviz.axisText),
      valAxisLabelFontSize: caption,
      valAxisLabelFontFace: '+mn-lt',
      valAxisLabelColor: hex(brand.dataviz.axisText),
      valGridLine: { color: hex(brand.dataviz.grid), size: 0.75 },
      catGridLine: { style: 'none' },
      catAxisLineShow: false,
      valAxisLineShow: false,
      showLegend: c.series.length > 1,
      legendPos: 't',
      legendFontSize: caption,
      legendFontFace: '+mn-lt',
      dataLabelFormatCode: '#,##0',
      valAxisLabelFormatCode: '#,##0',
      objectName: el.name,
    };
    if (type === 'line') {
      slide.addChart(pres.charts.LINE, data, { ...common, lineSize: 3, lineDataSymbolSize: 8, dataLabelPosition: 't' });
      return;
    }
    const stacked = type === 'stacked';
    slide.addChart(pres.charts.BAR, data, {
      ...common,
      barDir: type === 'bar' ? 'bar' : 'col',
      // горизонтальные столбцы PowerPoint рисует снизу вверх — разворачиваем, как в HTML
      ...(type === 'bar' ? { catAxisOrientation: 'maxMin', valAxisHidden: true, valGridLine: { style: 'none' } } : {}),
      barGrouping: stacked ? 'stacked' : 'clustered',
      barGapWidthPct: 70,
      // на стопке подписи внутри сегментов: outEnd в стопке повреждает файл
      dataLabelPosition: stacked ? 'ctr' : 'outEnd',
      ...(stacked ? { dataLabelColor: 'FFFFFF' } : {}),
    });
  }

  function addTable(slide, el) {
    const t = brand.typography.slideScalePx;
    const align = (i) => el.align?.[i] ?? 'left';
    const border = { type: 'solid', pt: 0.75, color: color('line') };
    const cellText = (v) => {
      const [main, ...rest] = String(v ?? '').split('\n');
      if (!rest.length) return main;
      return [
        { text: main, options: { breakLine: true } },
        { text: rest.join(' '), options: { fontSize: pt(t.caption), color: color('steel'), bold: false } },
      ];
    };
    const head = el.header.map((h, i) => ({
      text: h,
      options: { bold: true, fontSize: pt(t.caption), color: color('steel'), align: align(i), border: [null, null, { type: 'solid', pt: 1.5, color: color('ink') }, null] },
    }));
    const body = el.rows.map((r) => r.map((v, i) => ({ text: cellText(v), options: { align: align(i), border: [null, null, border, null] } })));
    const total = el.total
      ? [el.total.map((v, i) => ({ text: String(v ?? ''), options: { bold: true, align: align(i), border: [{ type: 'solid', pt: 1.5, color: color('ink') }, null, null, null] } }))]
      : [];
    slide.addTable([head, ...body, ...total], {
      x: inch(el.x), y: inch(el.y), w: inch(el.w), colW: el.colW.map(inch), rowH: inch(el.rowH),
      fontFace: brand.typography.body.family, fontSize: pt(t.small), color: color('ink'),
      // отступы ячеек в дюймах (pptxgenjs считает дюймами значения меньше 1)
      valign: 'middle', margin: [0, inch(16), 0, inch(16)], autoPage: false, objectName: el.name,
    });
  }
}

/** Ширина / высота логотипа: PNG — из заголовка IHDR, SVG — из viewBox или width/height. */
export function imageRatio(asset) {
  if (asset.mime === 'image/png') {
    return asset.data.readUInt32BE(16) / asset.data.readUInt32BE(20);
  }
  const svg = asset.data.toString('utf8');
  const vb = svg.match(/viewBox="\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (vb) return Number(vb[1]) / Number(vb[2]);
  const w = svg.match(/\bwidth="([\d.]+)/);
  const h = svg.match(/\bheight="([\d.]+)/);
  return w && h ? Number(w[1]) / Number(h[1]) : 4;
}
