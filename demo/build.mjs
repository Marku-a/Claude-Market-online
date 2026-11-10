// Builds a single-file DEMO of the extension UI: the real app code (app.js, orchestrator, engine)
// bundled with demo/overrides/{rpc,store}.js, which simulate the three sites inside the page.
// Usage: node demo/build.mjs <path-to-esbuild-binary> [outFile]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const esbuild = process.argv[2];
const out = process.argv[3] || path.join(here, 'dist', 'sal-hacham-demo.html');
if (!esbuild) { console.error('usage: node demo/build.mjs <esbuild binary> [outFile]'); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-demo-'));
for (const dir of ['app', 'engine', 'sites']) fs.cpSync(path.join(root, 'extension', dir), path.join(tmp, dir), { recursive: true });
for (const f of ['rpc.js', 'store.js']) fs.copyFileSync(path.join(here, 'overrides', f), path.join(tmp, 'app', f));
const js = execFileSync(esbuild, [path.join(tmp, 'app', 'app.js'), '--bundle', '--format=iife', '--target=es2020', '--log-level=warning'],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
fs.rmSync(tmp, { recursive: true, force: true });
if (js.includes('</script')) throw new Error('bundle contains a closing script tag');
if (/chrome\.(runtime|storage|tabs)/.test(js)) throw new Error('demo bundle must not use chrome.* APIs');

// The extension stylesheet, with its few literal colours turned into tokens so the page follows the theme.
const css = fs.readFileSync(path.join(root, 'extension', 'app', 'app.css'), 'utf8')
  .replace(/background: #fff\b/g, 'background: var(--card)')
  .replace(/color: #fff\b/g, 'color: var(--on-primary)')
  .replace(/#7a857e/g, 'var(--field-line)')
  .replace(/#0b57d0/g, 'var(--focus)');
if (/#[0-9a-fA-F]{3,6}\b/.test(css.replace(/:root\s*{[^}]*}/, ''))) throw new Error('untokenised colour left in app.css');

const dark = `--primary: #2f7d36; --primary-dark: #a9dbad; --primary-soft: #1c3220; --ink: #e8ede9; --muted: #a8b3ac;
  --line: #3a4640; --bg: #131915; --card: #1c241f; --warn-bg: #46380f; --warn-ink: #ffe29a; --err-bg: #4a2020; --err-ink: #ffb9b9;
  --on-primary: #ffffff; --field-line: #7d8a82; --focus: #8ab4ff; color-scheme: dark;`;

const html = `<title>סל חכם הדגמה</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
${css}
/* layout: one centred column, the extension's own screens; a slim banner marks the page as a demo */
:root { --on-primary: #ffffff; --field-line: #7a857e; --focus: #0b57d0; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${dark} } }
:root[data-theme="dark"] { ${dark} }
body { background: var(--bg); color: var(--ink); }
.top, main, .foot, .demo-banner > div { padding-block: 16px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
.demo-banner { background: var(--warn-bg); color: var(--warn-ink); border-bottom: 1px solid var(--line); }
.demo-banner > div { max-width: 1100px; margin: 0 auto; padding-block: 10px; }
.demo-banner strong { font-weight: 700; }
main, .card, td, th { min-width: 0; }
[data-testid="btn-clear"] { display: none; }
dialog#demo-dialog { border: 1px solid var(--line); border-radius: var(--radius); background: var(--card); color: var(--ink); padding: 20px; max-width: min(560px, calc(100% - 32px)); }
dialog#demo-dialog::backdrop { background: rgba(0, 0, 0, .45); }
dialog#demo-dialog .actions { margin-top: 16px; }
</style>
<div dir="rtl" lang="he">
  <div class="demo-banner" role="note"><div><strong>הדגמה.</strong> זה הממשק של התוסף "סל חכם", שרץ כאן על שלוש רשתות מדומות עם מוצרים ומחירים מומצאים. שום דבר לא נשלח לאתרים האמיתיים, ואין צורך בהתחברות.</div></div>
  <header class="top">
    <h1>סל חכם</h1>
    <ol id="steps" class="steps" aria-label="שלבים"></ol>
    <button type="button" id="btn-settings" class="link-btn">הגדרות</button>
  </header>
  <main id="main" tabindex="-1"></main>
  <div id="live" class="sr-only" aria-live="polite" role="status"></div>
  <footer class="foot">
    <p>התוסף לא משלם, לא נכנס לדפי תשלום ולא רואה פרטי אשראי. התשלום נעשה על ידך באתר.</p>
  </footer>
  <dialog id="demo-dialog" aria-labelledby="demo-dialog-title">
    <h2 id="demo-dialog-title"></h2>
    <div class="demo-body"></div>
    <div class="actions"><button type="button" id="demo-dialog-close" class="primary">סגור</button></div>
  </dialog>
</div>
<script>
document.documentElement.lang = 'he';
document.documentElement.dir = 'rtl';
document.getElementById('demo-dialog-close').addEventListener('click', function () { document.getElementById('demo-dialog').close(); });
// Demo convenience: the shopping-list box opens with an example list instead of empty.
var SAMPLE = "2 חלב 3%\\nלחם אחיד\\nביצים L\\n2 קוטג' 5%\\nעגבניות\\nמלפפונים\\nפסטה\\nקפה נמס\\nבמבה x3";
new MutationObserver(function () {
  var area = document.getElementById('list-input');
  if (area && !area.dataset.demoFilled) {
    area.dataset.demoFilled = '1';
    if (!area.value) { area.value = SAMPLE; area.dispatchEvent(new Event('input', { bubbles: true })); }
  }
}).observe(document.getElementById('main'), { childList: true, subtree: true });
</script>
<script>
${js}
</script>
`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log('wrote', out, (html.length / 1024).toFixed(0) + ' KB');
