// SVG-графики для HTML и PDF. Правила те же, что в PPTX: цвета из палитры бренда в
// фиксированном порядке, тонкие столбцы, подписи значений, сетка приглушена, без 3D.

import { fmtNumber } from './templates.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function chartSvg(chart, { w, h, brand }) {
  const palette = brand.dataviz.categorical;
  const context = brand.dataviz.context;
  const grid = brand.dataviz.grid;
  const axis = brand.dataviz.axisText;
  const ink = brand.color.ink;
  const font = `'${brand.typography.body.family}', ${brand.typography.body.fallback}`;
  const fs = brand.typography.slideScalePx.caption;
  const unit = chart.unit ? ` ${chart.unit}` : '';
  const series = chart.series;
  const multi = series.length > 1;
  const colorOf = (si, ci) => {
    if (!multi && chart.highlight != null) return ci === chart.highlight ? palette[0] : context;
    return palette[si % palette.length];
  };

  const legendH = multi ? 48 : 0;
  const parts = [];
  if (multi) {
    let lx = 0;
    series.forEach((s, i) => {
      parts.push(`<rect x="${lx}" y="8" width="20" height="20" rx="4" fill="${palette[i % palette.length]}"/>`);
      parts.push(`<text x="${lx + 30}" y="25" font-size="${fs}" fill="${axis}">${esc(s.name)}</text>`);
      lx += 30 + s.name.length * fs * 0.6 + 40;
    });
  }

  const type = chart.type ?? 'column';
  if (type === 'bar') parts.push(...barChart());
  else if (type === 'line') parts.push(...lineChart());
  else parts.push(...columnChart(type === 'stacked'));

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="${esc(font)}" role="img" aria-label="${esc(chart.title ?? series.map((s) => s.name).join(', '))}">${parts.join('')}</svg>`;

  function niceMax(v) {
    if (v <= 0) return 1;
    const mag = 10 ** Math.floor(Math.log10(v));
    return [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * mag).find((x) => x >= v);
  }

  function valueAxis(top, bottom, left, right, max) {
    const out = [];
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i;
      const y = bottom - ((bottom - top) * i) / 4;
      out.push(`<line x1="${left}" x2="${right}" y1="${y}" y2="${y}" stroke="${grid}" stroke-width="${i === 0 ? 2 : 1}"/>`);
      out.push(`<text x="${left - 12}" y="${y + fs * 0.35}" text-anchor="end" font-size="${fs}" fill="${axis}">${fmtNumber(+v.toFixed(2))}</text>`);
    }
    return out;
  }

  function columnChart(stacked) {
    const out = [];
    const cats = chart.categories;
    const totals = cats.map((_, ci) => (stacked ? series.reduce((n, s) => n + (s.values[ci] ?? 0), 0) : Math.max(...series.map((s) => s.values[ci] ?? 0))));
    const max = niceMax(Math.max(...totals));
    const left = 96;
    const top = legendH + 40;
    const bottom = h - 48;
    const plotW = w - left;
    out.push(...valueAxis(top, bottom, left, w, max));
    const step = plotW / cats.length;
    const groupW = Math.min(step * 0.6, stacked ? 96 : 64 * series.length);
    const barW = stacked ? groupW : (groupW - 4 * (series.length - 1)) / series.length;
    const y = (v) => bottom - ((bottom - top) * v) / max;
    cats.forEach((cat, ci) => {
      const gx = left + ci * step + (step - groupW) / 2;
      let acc = 0;
      series.forEach((s, si) => {
        const v = s.values[ci] ?? 0;
        if (!v) return;
        const x = stacked ? gx : gx + si * (barW + 4);
        const y0 = stacked ? y(acc + v) : y(v);
        const y1 = stacked ? y(acc) : bottom;
        // зазор 2px между сегментами стопки
        const hgt = Math.max(0, y1 - y0 - (stacked && acc ? 2 : 0));
        out.push(`<rect x="${x.toFixed(1)}" y="${y0.toFixed(1)}" width="${barW.toFixed(1)}" height="${hgt.toFixed(1)}" rx="4" fill="${colorOf(si, ci)}"/>`);
        if (stacked) {
          if (hgt > fs * 1.6) out.push(`<text x="${(x + barW / 2).toFixed(1)}" y="${(y0 + hgt / 2 + fs * 0.35).toFixed(1)}" text-anchor="middle" font-size="${fs}" fill="#FFFFFF">${fmtNumber(v)}</text>`);
        } else {
          out.push(`<text x="${(x + barW / 2).toFixed(1)}" y="${(y0 - 10).toFixed(1)}" text-anchor="middle" font-size="${fs}" fill="${ink}">${fmtNumber(v)}${multi ? '' : unit}</text>`);
        }
        acc += v;
      });
      if (stacked) out.push(`<text x="${(gx + groupW / 2).toFixed(1)}" y="${(y(acc) - 10).toFixed(1)}" text-anchor="middle" font-size="${fs}" font-weight="700" fill="${ink}">${fmtNumber(acc)}${unit}</text>`);
      out.push(`<text x="${(left + ci * step + step / 2).toFixed(1)}" y="${h - 12}" text-anchor="middle" font-size="${fs}" fill="${axis}">${esc(cat)}</text>`);
    });
    return out;
  }

  function barChart() {
    const out = [];
    const cats = chart.categories;
    const s = series[0];
    const max = niceMax(Math.max(...s.values));
    const labelW = Math.min(360, Math.max(...cats.map((c) => c.length)) * fs * 0.58 + 16);
    const top = legendH;
    const rowH = (h - top) / cats.length;
    const barH = Math.min(40, rowH * 0.6);
    const plotW = w - labelW - 160;
    cats.forEach((cat, ci) => {
      const v = s.values[ci] ?? 0;
      const cy = top + ci * rowH + rowH / 2;
      const bw = (plotW * v) / max;
      out.push(`<text x="${labelW - 16}" y="${(cy + fs * 0.35).toFixed(1)}" text-anchor="end" font-size="${fs}" fill="${ink}">${esc(cat)}</text>`);
      out.push(`<rect x="${labelW}" y="${(cy - barH / 2).toFixed(1)}" width="${Math.max(4, bw).toFixed(1)}" height="${barH.toFixed(1)}" rx="4" fill="${colorOf(0, ci)}"/>`);
      out.push(`<text x="${(labelW + Math.max(4, bw) + 12).toFixed(1)}" y="${(cy + fs * 0.35).toFixed(1)}" font-size="${fs}" fill="${ink}">${fmtNumber(v)}${unit}</text>`);
    });
    return out;
  }

  function lineChart() {
    const out = [];
    const cats = chart.categories;
    const max = niceMax(Math.max(...series.flatMap((s) => s.values)));
    const left = 96;
    const top = legendH + 40;
    const bottom = h - 48;
    const right = w - 120;
    out.push(...valueAxis(top, bottom, left, right, max));
    const x = (i) => left + (cats.length === 1 ? 0 : ((right - left) * i) / (cats.length - 1));
    const y = (v) => bottom - ((bottom - top) * v) / max;
    series.forEach((s, si) => {
      const color = palette[si % palette.length];
      const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
      out.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>`);
      s.values.forEach((v, i) => out.push(`<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="7" fill="${color}" stroke="#FFFFFF" stroke-width="2"/>`));
      const last = s.values.length - 1;
      out.push(`<text x="${(x(last) + 16).toFixed(1)}" y="${(y(s.values[last]) + fs * 0.35).toFixed(1)}" font-size="${fs}" font-weight="700" fill="${ink}">${fmtNumber(s.values[last])}${unit}</text>`);
    });
    cats.forEach((cat, i) => out.push(`<text x="${x(i).toFixed(1)}" y="${h - 12}" text-anchor="middle" font-size="${fs}" fill="${axis}">${esc(cat)}</text>`));
    return out;
  }
}
