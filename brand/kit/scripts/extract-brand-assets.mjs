// Run in a trusted, network-enabled Node.js environment (Node 20+, Playwright installed).
// npm install playwright && npx playwright install chromium
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await page.goto('https://soroka-marketing.ru/', { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.screenshot({ path: 'soroka-desktop.png', fullPage: true });
const audit = await page.evaluate(() => {
 const pick = el => { const s=getComputedStyle(el); return {tag:el.tagName, className: typeof el.className==='string'?el.className:'', text:el.innerText?.slice(0,100), color:s.color, background:s.backgroundColor, fontFamily:s.fontFamily, fontSize:s.fontSize, fontWeight:s.fontWeight} };
 return {title:document.title, url:location.href, fonts:[...document.fonts].map(f=>({family:f.family,style:f.style,weight:f.weight})), typography:[...document.querySelectorAll('h1,h2,h3,p,button')].slice(0,30).map(pick), images:[...document.images].map(x=>({src:x.currentSrc||x.src,alt:x.alt,className:x.className})), svg:[...document.querySelectorAll('svg')].slice(0,20).map(x=>({outerHTML:x.outerHTML.slice(0,10000)})), cssVariables: [...document.styleSheets].map(x=>x.href).filter(Boolean)};
});
await fs.writeFile('soroka-site-audit.json', JSON.stringify(audit,null,2));
console.log('Created soroka-site-audit.json and soroka-desktop.png; review actual logo and CSS before approving.');
await browser.close();
