import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = path.join(projectRoot, 'assets');
const bgJpg = path.join(assetsDir, 'competitive-programming-berserk-background-v3.jpg');
const bgWebp = path.join(assetsDir, 'competitive-programming-berserk-background-v3.webp');
const backgroundPath = existsSync(bgJpg) ? bgJpg : bgWebp;
const overlayPath = path.join(assetsDir, 'competitive-programming-stats-overlay-v3.svg');
const outputPath = path.join(assetsDir, 'competitive-programming-live.svg');
const statsPath = path.join(projectRoot, 'data', 'competitive-programming-stats.json');
const logoPaths = {
  leetcode: path.join(assetsDir, 'leetcode-logo.svg'),
  codechef: path.join(assetsDir, 'codechef-logo.svg'),
};

const xmlEscape = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;');

function getSvgBody(svgSource) {
  const rootStart = svgSource.indexOf('<svg');
  const openingTagEnd = rootStart < 0 ? -1 : svgSource.indexOf('>', rootStart);
  const rootEnd = svgSource.lastIndexOf('</svg>');
  if (openingTagEnd < 0 || rootEnd < openingTagEnd) return null;
  return svgSource.slice(openingTagEnd + 1, rootEnd);
}

const stats = {
  leetcodeSolved: '—',
  leetcodeRating: '—',
  codechefSolved: '—',
  codechefRating: '—',
  codeforcesSolved: '—',
  codeforcesRating: '—',
};
const displayKeys = Object.keys(stats);

try {
  Object.assign(stats, JSON.parse(await readFile(statsPath, 'utf8')));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const background = await readFile(backgroundPath);
let overlay = await readFile(overlayPath, 'utf8');
const overlayBody = getSvgBody(overlay);
if (!overlayBody) throw new Error(`Could not parse the SVG overlay at ${overlayPath}`);

const logoData = {
  leetcode: `data:image/svg+xml;base64,${(await readFile(logoPaths.leetcode)).toString('base64')}`,
  codechef: `data:image/svg+xml;base64,${(await readFile(logoPaths.codechef)).toString('base64')}`,
};

for (const [name, uri] of Object.entries(logoData)) {
  overlay = overlay.replaceAll(`__${name.toUpperCase()}_LOGO__`, uri);
}

for (const key of displayKeys) {
  const value = stats[key];
  const id = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  const textPattern = new RegExp(`(<text\\b[^>]*\\bid="${id}"[^>]*>)[\\s\\S]*?(<\\/text>)`);
  if (!textPattern.test(overlayBody)) throw new Error(`Missing SVG text node: ${id}`);
  const displayValue = value === null || value === undefined || value === ''
    ? '—'
    : typeof value === 'number'
      ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)
      : value;
  overlay = overlay.replace(textPattern, (_match, start, end) => `${start}${xmlEscape(displayValue)}${end}`);
}

const updatedBody = getSvgBody(overlay);
if (!updatedBody) throw new Error(`Could not parse the updated SVG overlay at ${overlayPath}`);
const imageData = background.toString('base64');
const mimeType = backgroundPath.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1774" height="887" viewBox="0 0 1774 887" role="img" aria-labelledby="title description">
  <title id="title">Shivang's competitive programming stats</title>
  <desc id="description">A code-generated SVG overlay on the Berserk-themed art, with live values supplied by the stats updater.</desc>
  <image x="0" y="0" width="1774" height="887" preserveAspectRatio="none" xlink:href="data:${mimeType};base64,${imageData}" />
  ${updatedBody}
</svg>
`;

await writeFile(outputPath, svg, 'utf8');
console.log(`Wrote ${path.relative(projectRoot, outputPath)}`);

// Also generate individual sliced card SVGs for interactive README layout
const defsMatch = updatedBody.match(/<defs>[\s\S]*?<\/defs>/);
const defs = defsMatch ? defsMatch[0] : '';
const leetcodeCard = updatedBody.match(/<a id="leetcode-link"[\s\S]*?<\/a>/)?.[0] || '';
const codechefCard = updatedBody.match(/<a id="codechef-link"[\s\S]*?<\/a>/)?.[0] || '';
const codeforcesCard = updatedBody.match(/<a id="codeforces-link"[\s\S]*?<\/a>/)?.[0] || '';

const sliceBgPaths = {
  leetcode: path.join(assetsDir, 'cp-bg-leetcode.jpg'),
  codechef: path.join(assetsDir, 'cp-bg-codechef.jpg'),
  codeforces: path.join(assetsDir, 'cp-bg-codeforces.jpg'),
};

if (existsSync(sliceBgPaths.leetcode) && existsSync(sliceBgPaths.codechef) && existsSync(sliceBgPaths.codeforces)) {
  const [lcBg, ccBg, cfBg] = await Promise.all([
    readFile(sliceBgPaths.leetcode),
    readFile(sliceBgPaths.codechef),
    readFile(sliceBgPaths.codeforces),
  ]);

  const lcSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="365" height="887" viewBox="0 0 365 887" role="img" aria-label="LeetCode Stats">
  ${defs}
  <image x="0" y="0" width="365" height="887" preserveAspectRatio="none" xlink:href="data:image/jpeg;base64,${lcBg.toString('base64')}" />
  ${leetcodeCard}
</svg>
`;

  const ccSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="335" height="887" viewBox="365 0 335 887" role="img" aria-label="CodeChef Stats">
  ${defs}
  <image x="365" y="0" width="335" height="887" preserveAspectRatio="none" xlink:href="data:image/jpeg;base64,${ccBg.toString('base64')}" />
  ${codechefCard}
</svg>
`;

  const cfSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="335" height="887" viewBox="700 0 335 887" role="img" aria-label="Codeforces Stats">
  ${defs}
  <image x="700" y="0" width="335" height="887" preserveAspectRatio="none" xlink:href="data:image/jpeg;base64,${cfBg.toString('base64')}" />
  ${codeforcesCard}
</svg>
`;

  await Promise.all([
    writeFile(path.join(assetsDir, 'competitive-programming-leetcode.svg'), lcSvg, 'utf8'),
    writeFile(path.join(assetsDir, 'competitive-programming-codechef.svg'), ccSvg, 'utf8'),
    writeFile(path.join(assetsDir, 'competitive-programming-codeforces.svg'), cfSvg, 'utf8'),
  ]);
  console.log('Wrote sliced platform card SVGs: LeetCode, CodeChef, Codeforces');
}

