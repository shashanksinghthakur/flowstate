// Inlines public/ into one self-contained HTML file (dist/preview.html).
// With no server behind it, the page runs in clearly-labelled demo mode.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const html = await readFile('public/index.html', 'utf8');
const css = await readFile('public/styles.css', 'utf8');
const js = await readFile('public/app.js', 'utf8');
const out = html
  .replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${css}\n</style>`)
  .replace('<script src="app.js"></script>', () => `<script>window.FLOWSTATE_DEMO = true;</script>\n<script>\n${js}\n</script>`);
await mkdir('dist', { recursive: true });
await writeFile('dist/preview.html', out);
console.log('dist/preview.html', out.length, 'bytes');
