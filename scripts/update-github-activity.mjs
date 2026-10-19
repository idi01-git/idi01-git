import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const previewMode = process.argv.includes('--mock-preview');
const emptyMode = process.argv.includes('--empty-bootstrap');
const outputDir = previewMode
  ? path.resolve(projectRoot, '..', 'profile-preview-assets')
  : path.join(projectRoot, 'assets');
const dataPath = path.join(projectRoot, 'data', 'github-contributions.json');
const username = 'idi01-git';

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]);
}

function levelFor(count, max) {
  if (!count) return 0;
  const ratio = count / Math.max(1, max);
  if (ratio < 0.2) return 1;
  if (ratio < 0.42) return 2;
  if (ratio < 0.68) return 3;
  return 4;
}

function createMockCalendar() {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 364);
  const firstSunday = new Date(start);
  firstSunday.setUTCDate(firstSunday.getUTCDate() - firstSunday.getUTCDay());
  const days = [];
  for (let date = new Date(firstSunday); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
    const dayIndex = Math.floor((date - firstSunday) / 86_400_000);
    const wave = (Math.sin(dayIndex * 0.18) + Math.cos(dayIndex * 0.047) + 2) / 4;
    const busy = (dayIndex * 17 + Math.floor(dayIndex / 7) * 13) % 23;
    const count = busy < 8 ? 0 : Math.round(wave * 8 + ((dayIndex * 7) % 4));
    if (date > end) break;
    days.push({ date: date.toISOString().slice(0, 10), contributionCount: count, weekday: date.getUTCDay() });
  }
  return { totalContributions: days.reduce((total, day) => total + day.contributionCount, 0), days };
}

function createEmptyCalendar() {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 364);
  const firstSunday = new Date(start);
  firstSunday.setUTCDate(firstSunday.getUTCDate() - firstSunday.getUTCDay());
  const days = [];
  for (let date = new Date(firstSunday); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
    days.push({ date: date.toISOString().slice(0, 10), contributionCount: 0, weekday: date.getUTCDay() });
  }
  return { totalContributions: 0, days };
}

async function fetchCalendar() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required to fetch the public contribution calendar.');

  const to = new Date();
  const from = new Date(to.getTime() - 365 * 24 * 60 * 60 * 1000);
  const query = `query ContributionCalendar($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays { date contributionCount weekday }
          }
        }
      }
    }
  }`;
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'idi01-git-profile-activity/1.0',
    },
    body: JSON.stringify({ query, variables: { login: username, from: from.toISOString(), to: to.toISOString() } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub GraphQL returned ${response.status} ${response.statusText}`);
  const payload = await response.json();
  if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.message).join('; '));
  const calendar = payload.data?.user?.contributionsCollection?.contributionCalendar;
  if (!calendar) throw new Error(`Could not read the public contribution calendar for ${username}.`);
  return {
    totalContributions: calendar.totalContributions,
    days: calendar.weeks.flatMap((week) => week.contributionDays),
  };
}

function makeHeatmap(calendar) {
  const width = 1774;
  const height = 264;
  const cell = 17;
  const gap = 7;
  const pitch = cell + gap;
  const columns = Math.ceil(calendar.days.length / 7);
  const gridWidth = columns * pitch - gap;
  const left = Math.round((width - gridWidth) / 2);
  const top = 88;
  const max = Math.max(1, ...calendar.days.map((day) => day.contributionCount));
  const colors = ['#171316', '#3a1016', '#71131d', '#b21c29', '#f12a39'];
  const cells = calendar.days.map((day) => {
    const date = new Date(`${day.date}T00:00:00Z`);
    const sunday = new Date(date);
    sunday.setUTCDate(sunday.getUTCDate() - sunday.getUTCDay());
    const first = new Date(`${calendar.days[0].date}T00:00:00Z`);
    first.setUTCDate(first.getUTCDate() - first.getUTCDay());
    const week = Math.floor((sunday - first) / (7 * 86_400_000));
    const x = left + week * pitch;
    const y = top + day.weekday * pitch;
    const unit = day.contributionCount === 1 ? 'contribution' : 'contributions';
    const label = `${day.contributionCount} ${unit} on ${day.date}`;
    return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" fill="${colors[levelFor(day.contributionCount, max)]}"><title>${escapeXml(label)}</title></rect>`;
  }).join('\n    ');

  const monthLabels = [];
  let lastMonth = '';
  calendar.days.forEach((day) => {
    const date = new Date(`${day.date}T00:00:00Z`);
    const month = date.toLocaleString('en', { month: 'short', timeZone: 'UTC' });
    if (date.getUTCDate() <= 7 && month !== lastMonth) {
      const week = Math.floor((date - new Date(`${calendar.days[0].date}T00:00:00Z`)) / (7 * 86_400_000));
      monthLabels.push(`<text x="${left + week * pitch}" y="70">${month.toUpperCase()}</text>`);
      lastMonth = month;
    }
  });
  const weekdays = [
    ['MON', 1], ['WED', 3], ['FRI', 5],
  ].map(([label, day]) => `<text class="weekday" x="${left - 20}" y="${top + day * pitch + 13}" text-anchor="end">${label}</text>`).join('\n    ');
  const total = Number(calendar.totalContributions ?? calendar.days.reduce((sum, day) => sum + day.contributionCount, 0));
  const updateStamp = previewMode ? 'PREVIEW DATA' : emptyMode ? 'FIRST LIVE REFRESH PENDING' : `UPDATED ${new Date().toISOString().slice(0, 10)}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="GitHub contribution heatmap for ${username}">
  <defs><linearGradient id="rule" x1="0" x2="1"><stop stop-color="#e51d2b" stop-opacity="0"/><stop offset=".5" stop-color="#e51d2b" stop-opacity=".85"/><stop offset="1" stop-color="#e51d2b" stop-opacity="0"/></linearGradient></defs>
  <rect width="100%" height="100%" rx="14" fill="#080708"/>
  <text class="eyebrow" x="44" y="42">CONTRIBUTION CALENDAR</text>
  <text class="meta" x="${width - 44}" y="42" text-anchor="end">${total.toLocaleString('en-US')} CONTRIBUTIONS · ${updateStamp}</text>
  <path d="M44 54H${width - 44}" stroke="url(#rule)" stroke-width="1"/>
  <g class="months">${monthLabels.join('')}</g>
  <g>${weekdays}</g>
  <g>${cells}</g>
  <g class="legend" transform="translate(${width - 238},${height - 20})">
    <text x="0" y="0">LESS</text><rect x="43" y="-11" width="13" height="13" rx="3" fill="${colors[0]}"/><rect x="62" y="-11" width="13" height="13" rx="3" fill="${colors[1]}"/><rect x="81" y="-11" width="13" height="13" rx="3" fill="${colors[2]}"/><rect x="100" y="-11" width="13" height="13" rx="3" fill="${colors[3]}"/><rect x="119" y="-11" width="13" height="13" rx="3" fill="${colors[4]}"/><text x="141" y="0">MORE</text>
  </g>
  <style>
    text{font-family:Arial,Helvetica,sans-serif;fill:#817b7e;font-size:10px;letter-spacing:1.35px}
    .eyebrow{fill:#f1ede1;font-size:13px;font-weight:700;letter-spacing:2.3px}
    .meta{font-size:10px;letter-spacing:1.15px}
    .weekday{font-size:8px;letter-spacing:.8px}
  </style>
</svg>`;
}

function smoothPath(points) {
  if (points.length < 2) return '';
  return points.slice(0, -1).map((point, index) => {
    const next = points[index + 1];
    const previous = points[Math.max(0, index - 1)];
    const after = points[Math.min(points.length - 1, index + 2)];
    const c1x = point.x + (next.x - previous.x) / 6;
    const c1y = point.y + (next.y - previous.y) / 6;
    const c2x = next.x - (after.x - point.x) / 6;
    const c2y = next.y - (after.y - point.y) / 6;
    return `${index ? '' : `M${point.x.toFixed(1)} ${point.y.toFixed(1)}`} C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${next.x.toFixed(1)} ${next.y.toFixed(1)}`;
  }).join(' ');
}

function makeActivityGraph(calendar) {
  const width = 1774;
  const height = 340;
  const plot = { x: 96, y: 94, width: width - 150, height: 190 };
  const weekly = new Map();
  calendar.days.forEach((day) => {
    const date = new Date(`${day.date}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - date.getUTCDay());
    const weekStart = date.getTime();
    weekly.set(weekStart, (weekly.get(weekStart) ?? 0) + day.contributionCount);
  });
  const weekStarts = [...weekly.keys()].sort((a, b) => a - b);
  const counts = weekStarts.map((weekStart) => weekly.get(weekStart));
  const max = Math.max(1, ...counts);
  const points = counts.map((count, index) => ({
    x: plot.x + (index / Math.max(1, counts.length - 1)) * plot.width,
    y: plot.y + plot.height - (count / max) * plot.height,
    count,
    weekStart: weekStarts[index],
  }));
  const line = smoothPath(points);
  const area = `${line} L${points.at(-1)?.x.toFixed(1)} ${plot.y + plot.height} L${points[0]?.x.toFixed(1)} ${plot.y + plot.height} Z`;
  const grid = [0, 0.33, 0.66, 1].map((part) => {
    const y = plot.y + plot.height * part;
    return `<path d="M${plot.x} ${y}H${plot.x + plot.width}" stroke="#2b2023" stroke-width="1"/><text class="y-label" x="${plot.x - 18}" y="${y + 4}" text-anchor="end">${Math.round(max * (1 - part))}</text>`;
  }).join('\n    ');
  const monthLabels = [];
  let lastMonth = '';
  calendar.days.forEach((day, index) => {
    const date = new Date(`${day.date}T00:00:00Z`);
    const month = date.toLocaleString('en', { month: 'short', timeZone: 'UTC' });
    if (date.getUTCDate() <= 7 && month !== lastMonth) {
      const sunday = new Date(date);
      sunday.setUTCDate(sunday.getUTCDate() - sunday.getUTCDay());
      const weekIndex = weekStarts.indexOf(sunday.getTime());
      const x = plot.x + (weekIndex / Math.max(1, counts.length - 1)) * plot.width;
      monthLabels.push(`<text class="x-label" x="${x}" y="${plot.y + plot.height + 25}">${month.toUpperCase()}</text>`);
      lastMonth = month;
    }
  });
  const total = Number(calendar.totalContributions ?? calendar.days.reduce((sum, day) => sum + day.contributionCount, 0));
  const peak = Math.max(...counts, 0);
  const updateStamp = previewMode ? 'PREVIEW DATA' : emptyMode ? 'FIRST LIVE REFRESH PENDING' : `UPDATED ${new Date().toISOString().slice(0, 10)}`;
  const hoverTargets = points.map((point) => {
    const weekOf = new Date(point.weekStart).toISOString().slice(0, 10);
    const unit = point.count === 1 ? 'contribution' : 'contributions';
    return `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="8" fill="transparent"><title>Week of ${weekOf}: ${point.count} ${unit}</title></circle>`;
  }).join('\n    ');
  const pointsMarkup = points.filter((point, index) => index % 5 === 0 || index === points.length - 1)
    .map((point) => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3.2" fill="#f1ede1" stroke="#e51d2b" stroke-width="2"/>`).join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Weekly GitHub activity graph for ${username}">
  <defs>
    <linearGradient id="area-fill" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#e51d2b" stop-opacity=".36"/><stop offset="1" stop-color="#e51d2b" stop-opacity="0"/></linearGradient>
    <linearGradient id="rule" x1="0" x2="1"><stop stop-color="#e51d2b" stop-opacity="0"/><stop offset=".5" stop-color="#e51d2b" stop-opacity=".85"/><stop offset="1" stop-color="#e51d2b" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="100%" height="100%" rx="14" fill="#080708"/>
  <text class="eyebrow" x="44" y="42">ACTIVITY TRACE</text>
  <text class="meta" x="${width - 44}" y="42" text-anchor="end">${total.toLocaleString('en-US')} CONTRIBUTIONS · PEAK WEEK ${peak} · ${updateStamp}</text>
  <path d="M44 54H${width - 44}" stroke="url(#rule)" stroke-width="1"/>
  <g>${grid}</g>
  <path d="${area}" fill="url(#area-fill)"/>
  <path d="${line}" fill="none" stroke="#e51d2b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <g>${hoverTargets}</g>
  <g>${pointsMarkup}</g>
  <g>${monthLabels.join('')}</g>
  <text class="footer" x="${width - 44}" y="${height - 17}" text-anchor="end">WEEKLY CONTRIBUTIONS</text>
  <style>
    text{font-family:Arial,Helvetica,sans-serif;fill:#817b7e;font-size:10px;letter-spacing:1.25px}
    .eyebrow{fill:#f1ede1;font-size:13px;font-weight:700;letter-spacing:2.3px}
    .meta{font-size:10px;letter-spacing:1.05px}
    .y-label,.x-label{font-size:9px;letter-spacing:1px}
    .footer{font-size:9px;letter-spacing:1.6px}
  </style>
</svg>`;
}

const calendar = previewMode ? createMockCalendar() : emptyMode ? createEmptyCalendar() : await fetchCalendar();
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, 'github-contribution-heatmap.svg'), makeHeatmap(calendar), 'utf8');
await writeFile(path.join(outputDir, 'github-activity-graph.svg'), makeActivityGraph(calendar), 'utf8');
if (!previewMode && !emptyMode) {
  await mkdir(path.dirname(dataPath), { recursive: true });
  await writeFile(dataPath, `${JSON.stringify({ username, ...calendar, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
}
console.log(`Generated GitHub activity visuals in ${outputDir}${previewMode ? ' (mock preview data only)' : ''}.`);
