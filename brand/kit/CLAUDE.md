# Claude Code — Soroka Marketing brand assistant

Read `docs/BRANDBOOK.md` and `tokens/brand.tokens.json` before generating any slide, proposal, dashboard, report, social visual or presentation.

## Source hierarchy
1. User-supplied approved brand assets / actual site CSS inspected in browser.
2. Verified website text and documented positioning from soroka-marketing.ru.
3. Proposed design tokens in this kit **only as temporary defaults**.

Never promote proposed values to official ones without evidence. Before each export, record which brand version is in use.

## Logo policy
Use only an original, approved asset in `assets/logo/` once acquired. Do not treat third-party catalog images as official sources. Do not generate an ersatz paper-bird icon. Until an authentic logo is provided, place a neutral text wordmark `SOROKA MARKETING`.

## Presentation pipeline
1. Clarify audience, objective, format, source data and expected number of slides.
2. Build storyline: problem → evidence → strategy → forecast assumptions → action.
3. Prepare data and chart source manifests. Do not invent metrics.
4. Use the template/grid from `templates/slide-cover.html` and current verified token set.
5. Render each slide to PNG preview, run visual QA (cropping, contrasts, legibility, consistent spacing), export PPTX/PDF if requested.
6. Deliver editable source files and a changelog/asset manifest.

## Brand guardrails
- Work in Russian by default; no unexplained English labels.
- Keep one principal point per slide and visual hierarchy that prioritizes results and numbers.
- Distinguish observed, estimated, hypothetical data.
- Keep source links for claims and metrics.
- No fabricated case studies, awards or client logos.

## Asset acquisition task
Run `scripts/extract-brand-assets.mjs` in the Claude Code project environment with network access, inspect output, confirm site asset ownership and current usage, move verified original logo into `assets/logo/`, and update token files with inspected CSS/font values. Review manually before marking `verified`.
