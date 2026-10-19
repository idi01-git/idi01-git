import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const previewMode = process.argv.includes('--mock-preview');
const emptyMode = process.argv.includes('--empty-bootstrap');
const outputDir = previewMode
  ? path.resolve(projectRoot, '..', 'profile-preview-assets')
  : path.join(projectRoot, 'assets');
const dataPath = path.join(projectRoot, 'data', 'github-contributions.json');
const readmePath = path.join(projectRoot, 'README.md');
const username = 'idi01-git';

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]);
}

function computeThresholds(days) {
  const active = days.map((d) => d.contributionCount).filter((c) => c > 0).sort((a, b) => a - b);
  if (active.length === 0) return [1, 2, 3, 4];
  const q1 = active[Math.floor(active.length * 0.25)];
  const q2 = active[Math.floor(active.length * 0.50)];
  const q3 = active[Math.floor(active.length * 0.75)];
  const t1 = Math.max(1, q1);
  const t2 = Math.max(t1 + 1, q2);
  const t3 = Math.max(t2 + 1, q3);
  const t4 = Math.max(t3 + 1, active[Math.floor(active.length * 0.92)]);
  return [t1, t2, t3, t4];
}

function getLevel(count, thresholds) {
  if (!count || count <= 0) return 0;
  if (count < thresholds[1]) return 1;
  if (count < thresholds[2]) return 2;
  if (count < thresholds[3]) return 3;
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
  if (!token) {
    try {
      const cached = JSON.parse(await readFile(dataPath, 'utf8'));
      if (cached?.days?.length) {
        console.log(`Using cached contribution data from ${dataPath} (${cached.days.length} days).`);
        return {
          totalContributions: cached.totalContributions,
          days: cached.days,
          isCached: true,
        };
      }
    } catch { }
    throw new Error('GITHUB_TOKEN is required to fetch the public contribution calendar.');
  }

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
  const height = 376;
  const pitch = 31;
  const cell = 23;
  const gap = pitch - cell; // 8
  const top = 120;
  const rx = 4.5;
  const colors = ['#171316', '#4c1018', '#871522', '#cb1b2a', '#ff3648'];
  const thresholds = computeThresholds(calendar.days);

  const first = new Date(`${calendar.days[0].date}T00:00:00Z`);
  first.setUTCDate(first.getUTCDate() - first.getUTCDay());

  const last = new Date(`${calendar.days[calendar.days.length - 1].date}T00:00:00Z`);
  const lastSunday = new Date(last);
  lastSunday.setUTCDate(lastSunday.getUTCDate() - lastSunday.getUTCDay());
  const columns = Math.max(52, Math.floor((lastSunday - first) / (7 * 86_400_000)) + 1);

  const gridWidth = columns * pitch - gap;
  const labelWidth = 43;
  const labelGap = 16;
  const totalContentWidth = labelWidth + labelGap + gridWidth;
  const margin = Math.floor((width - totalContentWidth) / 2);
  const contentLeft = margin;
  const contentRight = width - margin;
  const gridLeft = contentRight - gridWidth;
  const weekdayAnchorX = gridLeft - labelGap;

  const cells = calendar.days.map((day) => {
    const date = new Date(`${day.date}T00:00:00Z`);
    const sunday = new Date(date);
    sunday.setUTCDate(sunday.getUTCDate() - sunday.getUTCDay());
    const week = Math.floor((sunday - first) / (7 * 86_400_000));
    const x = gridLeft + week * pitch;
    const y = top + day.weekday * pitch;
    const level = getLevel(day.contributionCount, thresholds);
    const unit = day.contributionCount === 1 ? 'contribution' : 'contributions';
    const label = `${day.contributionCount} ${unit} on ${day.date}`;
    return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="${rx}" fill="${colors[level]}"><title>${escapeXml(label)}</title></rect>`;
  }).join('\n    ');

  const monthLabels = [];
  let lastMonth = '';
  calendar.days.forEach((day) => {
    const date = new Date(`${day.date}T00:00:00Z`);
    const month = date.toLocaleString('en', { month: 'short', timeZone: 'UTC' });
    if (date.getUTCDate() <= 7 && month !== lastMonth) {
      const sunday = new Date(date);
      sunday.setUTCDate(sunday.getUTCDate() - sunday.getUTCDay());
      const week = Math.floor((sunday - first) / (7 * 86_400_000));
      if (week >= 0 && week < columns) {
        const x = gridLeft + week * pitch;
        monthLabels.push(`<text class="month" x="${x}" y="104">${month.toUpperCase()}</text>`);
        lastMonth = month;
      }
    }
  });

  const total = Number(calendar.totalContributions ?? calendar.days.reduce((sum, day) => sum + day.contributionCount, 0));
  const updateStamp = previewMode ? 'PREVIEW DATA' : emptyMode ? 'FIRST LIVE REFRESH PENDING' : `UPDATED ${new Date().toISOString().slice(0, 10)}`;
  const legendWidth = 191;
  const legendLeft = contentRight - legendWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="GitHub contribution heatmap for ${username}">
  <defs>
    <linearGradient id="taper-glow" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#e51d2b" stop-opacity="0.05"/>
      <stop offset="12%" stop-color="#e51d2b" stop-opacity="0.3"/>
      <stop offset="35%" stop-color="#ff2238" stop-opacity="0.85"/>
      <stop offset="50%" stop-color="#ff3345" stop-opacity="1"/>
      <stop offset="65%" stop-color="#ff2238" stop-opacity="0.85"/>
      <stop offset="88%" stop-color="#e51d2b" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#e51d2b" stop-opacity="0.05"/>
    </linearGradient>
    <linearGradient id="taper-core" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#e51d2b" stop-opacity="0.1"/>
      <stop offset="20%" stop-color="#ff2238" stop-opacity="0.75"/>
      <stop offset="42%" stop-color="#ff5967" stop-opacity="1"/>
      <stop offset="50%" stop-color="#ffffff" stop-opacity="1"/>
      <stop offset="58%" stop-color="#ff5967" stop-opacity="1"/>
      <stop offset="80%" stop-color="#ff2238" stop-opacity="0.75"/>
      <stop offset="100%" stop-color="#e51d2b" stop-opacity="0.1"/>
    </linearGradient>
    <linearGradient id="taper-white" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#ff3345" stop-opacity="0"/>
      <stop offset="25%" stop-color="#ff5967" stop-opacity="0.7"/>
      <stop offset="50%" stop-color="#ffffff" stop-opacity="1"/>
      <stop offset="75%" stop-color="#ff5967" stop-opacity="0.7"/>
      <stop offset="100%" stop-color="#ff3345" stop-opacity="0"/>
    </linearGradient>
    <filter id="header-glow" x="-20%" y="-400%" width="140%" height="900%">
      <feGaussianBlur stdDeviation="3.5" result="blur1"/>
      <feGaussianBlur stdDeviation="1.5" result="blur2"/>
      <feMerge>
        <feMergeNode in="blur1"/>
        <feMergeNode in="blur2"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <rect width="100%" height="100%" rx="14" fill="#080708" stroke="#251619" stroke-width="1.2"/>
  <text class="eyebrow" x="${contentLeft}" y="52">CONTRIBUTION CALENDAR</text>
  <text class="meta" x="${contentRight}" y="52" text-anchor="end"><tspan class="meta-count">${total.toLocaleString('en-US')}</tspan> <tspan class="meta-unit">contributions</tspan>   <tspan class="meta-badge">${updateStamp}</tspan></text>
  <line x1="${contentLeft}" y1="70" x2="${contentRight}" y2="70" stroke="#e51d2b" stroke-width="0.8" stroke-opacity="0.35"/>
  <path d="M${contentLeft} 70 Q${(contentLeft + contentRight) / 2} 62 ${contentRight} 70 Q${(contentLeft + contentRight) / 2} 78 ${contentLeft} 70 Z" fill="url(#taper-glow)" filter="url(#header-glow)" opacity="0.65"/>
  <path d="M${contentLeft} 70 Q${(contentLeft + contentRight) / 2} 66.5 ${contentRight} 70 Q${(contentLeft + contentRight) / 2} 73.5 ${contentLeft} 70 Z" fill="url(#taper-glow)" filter="url(#header-glow)" opacity="0.95"/>
  <path d="M${contentLeft + 30} 70 Q${(contentLeft + contentRight) / 2} 68.4 ${contentRight - 30} 70 Q${(contentLeft + contentRight) / 2} 71.6 ${contentLeft + 30} 70 Z" fill="url(#taper-core)"/>
  <path d="M${(contentLeft + contentRight) / 2 - 380} 70 Q${(contentLeft + contentRight) / 2} 69.1 ${(contentLeft + contentRight) / 2 + 380} 70 Q${(contentLeft + contentRight) / 2} 70.9 ${(contentLeft + contentRight) / 2 - 380} 70 Z" fill="url(#taper-white)" opacity="0.95"/>
  <g class="months">${monthLabels.join('')}</g>
  <g class="weekdays">
    <text class="weekday" x="${weekdayAnchorX}" y="167" text-anchor="end">MON</text>
    <text class="weekday" x="${weekdayAnchorX}" y="229" text-anchor="end">WED</text>
    <text class="weekday" x="${weekdayAnchorX}" y="291" text-anchor="end">FRI</text>
  </g>
  <g class="cells">${cells}</g>
  <g class="legend" transform="translate(${legendLeft}, 356)">
    <text class="legend-text" x="0" y="0">LESS</text>
    <rect x="42" y="-12" width="15" height="15" rx="3.5" fill="${colors[0]}"/>
    <rect x="63" y="-12" width="15" height="15" rx="3.5" fill="${colors[1]}"/>
    <rect x="84" y="-12" width="15" height="15" rx="3.5" fill="${colors[2]}"/>
    <rect x="105" y="-12" width="15" height="15" rx="3.5" fill="${colors[3]}"/>
    <rect x="126" y="-12" width="15" height="15" rx="3.5" fill="${colors[4]}"/>
    <text class="legend-text" x="151" y="0">MORE</text>
  </g>
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", Roboto, "Arial Black", sans-serif; }
    .eyebrow { fill: #f1ede1; font-size: 24px; font-weight: 800; letter-spacing: 2.2px; }
    .meta-count { fill: #f1ede1; font-size: 24px; font-weight: 800; letter-spacing: 0.5px; }
    .meta-unit { fill: #9e9598; font-size: 16px; font-weight: 400; letter-spacing: 0.5px; }
    .meta-badge { fill: #ff2238; font-size: 14px; font-weight: 700; letter-spacing: 1.2px; }
    .month { fill: #b4abb0; font-size: 14px; font-weight: 700; letter-spacing: 1px; }
    .weekday { fill: #7d7377; font-size: 13px; font-weight: 600; letter-spacing: 0.7px; }
    .legend-text { fill: #7d7377; font-size: 12px; font-weight: 600; letter-spacing: 1.2px; }
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
  const height = 540;
  const plot = { x: 122, y: 128, width: width - 190, height: 320 };
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
      monthLabels.push(`<text class="x-label" x="${x}" y="${plot.y + plot.height + 34}">${month.toUpperCase()}</text>`);
      lastMonth = month;
    }
  });
  const total = Number(calendar.totalContributions ?? calendar.days.reduce((sum, day) => sum + day.contributionCount, 0));
  const peak = Math.max(...counts, 0);
  const updateStamp = previewMode ? 'PREVIEW DATA' : emptyMode ? 'FIRST LIVE REFRESH PENDING' : `UPDATED ${new Date().toISOString().slice(0, 10)}`;
  const hoverTargets = points.map((point) => {
    const weekOf = new Date(point.weekStart).toISOString().slice(0, 10);
    const unit = point.count === 1 ? 'contribution' : 'contributions';
    return `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="12" fill="transparent"><title>Week of ${weekOf}: ${point.count} ${unit}</title></circle>`;
  }).join('\n    ');
  const pointsMarkup = points.filter((point, index) => index % 5 === 0 || index === points.length - 1)
    .map((point) => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="5.5" fill="#f1ede1" stroke="#e51d2b" stroke-width="3"/>`).join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Weekly GitHub activity graph for ${username}">
  <defs>
    <linearGradient id="area-fill" x1="0" y1="0" x2="0" y2="1">
      <stop stop-color="#e51d2b" stop-opacity=".42"/>
      <stop offset="0.6" stop-color="#e51d2b" stop-opacity=".12"/>
      <stop offset="1" stop-color="#e51d2b" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="taper-glow" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#e51d2b" stop-opacity="0.05"/>
      <stop offset="12%" stop-color="#e51d2b" stop-opacity="0.3"/>
      <stop offset="35%" stop-color="#ff2238" stop-opacity="0.85"/>
      <stop offset="50%" stop-color="#ff3345" stop-opacity="1"/>
      <stop offset="65%" stop-color="#ff2238" stop-opacity="0.85"/>
      <stop offset="88%" stop-color="#e51d2b" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#e51d2b" stop-opacity="0.05"/>
    </linearGradient>
    <linearGradient id="taper-core" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#e51d2b" stop-opacity="0.1"/>
      <stop offset="20%" stop-color="#ff2238" stop-opacity="0.75"/>
      <stop offset="42%" stop-color="#ff5967" stop-opacity="1"/>
      <stop offset="50%" stop-color="#ffffff" stop-opacity="1"/>
      <stop offset="58%" stop-color="#ff5967" stop-opacity="1"/>
      <stop offset="80%" stop-color="#ff2238" stop-opacity="0.75"/>
      <stop offset="100%" stop-color="#e51d2b" stop-opacity="0.1"/>
    </linearGradient>
    <linearGradient id="taper-white" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#ff3345" stop-opacity="0"/>
      <stop offset="25%" stop-color="#ff5967" stop-opacity="0.7"/>
      <stop offset="50%" stop-color="#ffffff" stop-opacity="1"/>
      <stop offset="75%" stop-color="#ff5967" stop-opacity="0.7"/>
      <stop offset="100%" stop-color="#ff3345" stop-opacity="0"/>
    </linearGradient>
    <filter id="header-glow" x="-20%" y="-400%" width="140%" height="900%">
      <feGaussianBlur stdDeviation="3.5" result="blur1"/>
      <feGaussianBlur stdDeviation="1.5" result="blur2"/>
      <feMerge>
        <feMergeNode in="blur1"/>
        <feMergeNode in="blur2"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <rect width="100%" height="100%" rx="14" fill="#080708" stroke="#251619" stroke-width="1.2"/>
  <text class="eyebrow" x="40" y="52">ACTIVITY TRACE · LAST 12 MONTHS</text>
  <text class="meta" x="1734" y="52" text-anchor="end"><tspan class="meta-peak">PEAK ${peak}/WK</tspan>   <tspan class="meta-badge">${updateStamp}</tspan></text>
  <line x1="40" y1="70" x2="1734" y2="70" stroke="#e51d2b" stroke-width="0.8" stroke-opacity="0.35"/>
  <path d="M40 70 Q887 62 1734 70 Q887 78 40 70 Z" fill="url(#taper-glow)" filter="url(#header-glow)" opacity="0.65"/>
  <path d="M40 70 Q887 66.5 1734 70 Q887 73.5 40 70 Z" fill="url(#taper-glow)" filter="url(#header-glow)" opacity="0.95"/>
  <path d="M70 70 Q887 68.4 1704 70 Q887 71.6 70 70 Z" fill="url(#taper-core)"/>
  <path d="M507 70 Q887 69.1 1267 70 Q887 70.9 507 70 Z" fill="url(#taper-white)" opacity="0.95"/>
  <g>${grid}</g>
  <path d="${area}" fill="url(#area-fill)"/>
  <path d="${line}" fill="none" stroke="#f12638" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  <g>${hoverTargets}</g>
  <g>${pointsMarkup}</g>
  <g>${monthLabels.join('')}</g>
  <text class="footer" x="1734" y="${height - 26}" text-anchor="end">WEEKLY CONTRIBUTIONS</text>
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", Roboto, "Arial Black", sans-serif; fill: #aaa1a4; font-size: 18px; letter-spacing: .8px; }
    .eyebrow { fill: #f1ede1; font-size: 24px; font-weight: 800; letter-spacing: 2.2px; }
    .meta-peak { fill: #ff2238; font-size: 16px; font-weight: 800; letter-spacing: 1.4px; }
    .meta-count { fill: #f1ede1; font-size: 24px; font-weight: 800; letter-spacing: 0.5px; }
    .meta-unit { fill: #9e9598; font-size: 16px; font-weight: 400; letter-spacing: 0.5px; }
    .meta-badge { fill: #ff2238; font-size: 14px; font-weight: 700; letter-spacing: 1.2px; }
    .y-label, .x-label { fill: #7d7377; font-size: 14px; font-weight: 600; letter-spacing: 0.8px; }
    .footer { fill: #7d7377; font-size: 14px; font-weight: 600; letter-spacing: 1.2px; }
  </style>
</svg>`;
}

const calendar = previewMode ? createMockCalendar() : emptyMode ? createEmptyCalendar() : await fetchCalendar();
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, 'github-contribution-heatmap.svg'), makeHeatmap(calendar), 'utf8');
await writeFile(path.join(outputDir, 'github-activity-graph.svg'), makeActivityGraph(calendar), 'utf8');
if (!previewMode && !emptyMode && !calendar.isCached) {
  const cacheVersion = (process.env.GITHUB_RUN_ID || new Date().toISOString()).replace(/[^0-9A-Za-z]/g, '');
  const readme = await readFile(readmePath, 'utf8');
  const cacheBustedReadme = readme.replace(
    /(\.\/assets\/(?:github-(?:contribution-heatmap|activity-graph)|divider-red)\.svg)(?:\?v=[^"&\s]*)?/g,
    `$1?v=${cacheVersion}`,
  );
  if (cacheBustedReadme !== readme) await writeFile(readmePath, cacheBustedReadme, 'utf8');
  await mkdir(path.dirname(dataPath), { recursive: true });
  await writeFile(dataPath, `${JSON.stringify({ username, ...calendar, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
}
console.log(`Generated GitHub activity visuals in ${outputDir}${previewMode ? ' (mock preview data only)' : ''}.`);
