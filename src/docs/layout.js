// Общая геометрия слайда и текстовые стили из бренда. Единицы — пиксели холста 1920×1080;
// HTML рисует их как есть, PPTX переводит: 144 px = 1 дюйм, 1 px = 0.5 pt.

export const PX_PER_INCH = 144;
export const PT_PER_PX = 0.5;

const HEADING_STYLES = new Set(['display', 'title', 'subtitle', 'kpi', 'kpiSmall', 'wordmark']);
// Крупные цифры — акцент, а не текст: в проверке иерархии их не сравниваем с заголовком
export const FIGURE_STYLES = new Set(['kpi', 'kpiSmall', 'display', 'subtitle']);

export function createLayout(brand) {
  const s = brand.slide;
  const t = brand.typography.slideScalePx;
  const W = s.width;
  const H = s.height;
  const M = s.margin;
  const CW = W - 2 * M;

  const styles = {
    display: { size: t.display, weight: 800, lineHeight: 1.04, letterSpacing: -0.02 },
    title: { size: t.title, weight: 800, lineHeight: 1.1, letterSpacing: -0.015 },
    subtitle: { size: t.subtitle, weight: 600, lineHeight: 1.2 },
    lead: { size: t.lead, weight: 400, lineHeight: 1.35 },
    kpi: { size: t.kpi, weight: 800, lineHeight: 1.1, letterSpacing: -0.02 },
    kpiSmall: { size: t.title, weight: 800, lineHeight: 1.1, letterSpacing: -0.015 },
    body: { size: t.body, weight: 400, lineHeight: 1.4 },
    bodyStrong: { size: t.body, weight: 700, lineHeight: 1.3 },
    small: { size: t.small, weight: 400, lineHeight: 1.4 },
    smallStrong: { size: t.small, weight: 700, lineHeight: 1.3 },
    caption: { size: t.caption, weight: 400, lineHeight: 1.35 },
    wordmark: { size: t.caption, weight: 800, lineHeight: 1, letterSpacing: 0.08 },
  };
  for (const [name, st] of Object.entries(styles)) {
    st.font = HEADING_STYLES.has(name) ? brand.typography.heading.family : brand.typography.body.family;
    st.role = HEADING_STYLES.has(name) ? 'heading' : 'body';
  }

  return {
    W, H, M, CW,
    top: s.marginTop,
    grid: s.grid,
    gutter: s.gutter,
    // Заголовок контентного слайда: до двух строк
    titleBox: { x: M, y: s.marginTop - 8, w: CW, h: 152 },
    contentTop: 288,
    contentBottom: 920,
    sourceY: 936,
    footerY: H - 80,
    styles,
    /** Ширины колонок по сетке: cols(3) → x и w для трёх равных колонок. */
    cols(n, { x = M, w = CW, gap = s.gutter } = {}) {
      const cw = (w - gap * (n - 1)) / n;
      return Array.from({ length: n }, (_, i) => ({ x: Math.round(x + i * (cw + gap)), w: Math.round(cw) }));
    },
  };
}
