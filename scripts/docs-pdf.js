'use strict';

// Generator PDF-ow z dokumentacji (docs/*.md, POMYSLY.md) - to samo, co widac na GitHubie,
// tylko do wyslania komus, kto nie ma dostepu do repo.
//
//   node scripts/docs-pdf.js                 # odswieza wszystkie pliki z LISTA
//   node scripts/docs-pdf.js docs/zasady.md  # tylko wskazane
//
// Wymaga: internetu przy pierwszym uruchomieniu (npx marked + pobranie mermaid.js do cache
// w os.tmpdir()) oraz Google Chrome (drukowanie do PDF). Zadnych nowych zaleznosci w package.json
// - to narzedzie deweloperskie, nie czesc aplikacji.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KORZEN = path.join(__dirname, '..');
const LISTA = ['docs/opis.md', 'docs/architektura.md', 'docs/zasady.md', 'POMYSLY.md'];
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';
const MERMAID_CACHE = path.join(os.tmpdir(), 'wms-mermaid-11.min.js');

// Mermaid trzymamy w cache na dysku, a nie linkiem z CDN: Chrome drukuje z file://, a strona
// z file:// nie zawsze dociagnie skrypt z sieci na czas (i nie chcemy zaleznosci od CDN
// w momencie generowania).
function mermaidJs() {
  if (!fs.existsSync(MERMAID_CACHE)) {
    console.log('Pobieram mermaid...');
    execFileSync('curl', ['-sSL', '-o', MERMAID_CACHE, MERMAID_URL], { stdio: 'inherit' });
  }
  return fs.readFileSync(MERMAID_CACHE, 'utf8');
}

function markdownNaHtml(sciezka) {
  return execFileSync('npx', ['--yes', 'marked@15', '--gfm', '-i', sciezka], { encoding: 'utf8' });
}

// marked zamienia ```mermaid na <pre><code class="language-mermaid">. Mermaid oczekuje
// <pre class="mermaid"> z golym tekstem diagramu - i to BEZ encji HTML (&gt; w strzalkach
// psuje parser), stad odwrocenie escape'u.
function wyjmijMermaid(html) {
  return html.replace(
    /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
    (_, kod) => `<pre class="mermaid">${kod
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')}</pre>`
  );
}

const STYL = `
  @page { size: A4; margin: 18mm 16mm; }
  body { font: 11pt/1.55 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #1b1b1f; }
  h1 { font-size: 20pt; border-bottom: 2px solid #d8d8de; padding-bottom: 6px; }
  h2 { font-size: 14pt; margin-top: 22px; border-bottom: 1px solid #e6e6ea; padding-bottom: 4px; }
  h3 { font-size: 12pt; margin-top: 16px; }
  h1, h2, h3 { break-after: avoid; }
  table { border-collapse: collapse; width: 100%; font-size: 9.5pt; break-inside: avoid; }
  th, td { border: 1px solid #d8d8de; padding: 5px 8px; text-align: left; vertical-align: top; }
  th { background: #f4f4f7; }
  code { font-family: "SF Mono", Menlo, monospace; font-size: 9pt; background: #f4f4f7;
         padding: 1px 4px; border-radius: 3px; }
  pre { background: #f4f4f7; padding: 10px 12px; border-radius: 5px; overflow: hidden;
        break-inside: avoid; }
  pre code { background: none; padding: 0; font-size: 8.5pt; line-height: 1.4; }
  pre.mermaid { background: none; text-align: center; padding: 4px 0; }
  pre.mermaid svg { max-width: 100%; height: auto; }
  blockquote { border-left: 3px solid #c9c9d1; margin: 12px 0; padding: 2px 0 2px 14px; color: #4a4a52; }
  li { margin: 3px 0; }
  a { color: #2b5fd9; text-decoration: none; }
  hr { border: 0; border-top: 1px solid #e6e6ea; margin: 20px 0; }
`;

function zbudujHtml(tresc, mermaid) {
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8">
<style>${STYL}</style></head><body>${tresc}
<script>${mermaid}<\/script>
<script>mermaid.initialize({ startOnLoad: true, theme: 'neutral', securityLevel: 'loose' });<\/script>
</body></html>`;
}

function zrobPdf(wzgledna, mermaid) {
  const wejscie = path.join(KORZEN, wzgledna);
  const wyjscie = wejscie.replace(/\.md$/, '.pdf');
  const tmpHtml = path.join(os.tmpdir(), `wms-doc-${path.basename(wzgledna, '.md')}.html`);

  fs.writeFileSync(tmpHtml, zbudujHtml(wyjmijMermaid(markdownNaHtml(wejscie)), mermaid));
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--no-pdf-header-footer',
    // mermaid rysuje asynchronicznie - budzet czasu wirtualnego daje mu dokonczyc przed drukiem
    '--virtual-time-budget=20000',
    `--print-to-pdf=${wyjscie}`, `file://${tmpHtml}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const kb = Math.round(fs.statSync(wyjscie).size / 1024);
  console.log(`  ${wzgledna} -> ${path.relative(KORZEN, wyjscie)} (${kb} kB)`);
}

const pliki = process.argv.slice(2).length ? process.argv.slice(2) : LISTA;
const mermaid = mermaidJs();
console.log(`Generuje ${pliki.length} PDF-ow...`);
for (const p of pliki) zrobPdf(p, mermaid);
