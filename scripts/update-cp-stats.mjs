import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const statsPath = path.join(projectRoot, 'data', 'competitive-programming-stats.json');
const usernames = {
  leetcode: 'idi01',
  codechef: 'idi01',
  codeforces: 'idi01',
};

const defaults = {
  leetcodeSolved: null,
  leetcodeRating: null,
  codechefSolved: null,
  codechefRating: null,
  codeforcesSolved: null,
  codeforcesRating: null,
  updatedAt: null,
};

async function getJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(30_000),
    headers: {
      'user-agent': 'idi01-git-profile-stats/1.0',
      accept: 'application/json,text/plain,*/*',
      ...options.headers,
    },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} from ${url}`);
  return response.json();
}

async function getText(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; idi01-git-profile-stats/1.0)',
      accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} from ${url}`);
  return response.text();
}

function numeric(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
}

async function fetchLeetCode() {
  const username = usernames.leetcode;
  const query = `query userProfile($username: String!) {
    matchedUser(username: $username) {
      submitStats { acSubmissionNum { difficulty count } }
    }
    userContestRanking(username: $username) { rating }
  }`;
  const payload = await getJson('https://leetcode.com/graphql', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://leetcode.com',
      referer: `https://leetcode.com/u/${username}/`,
    },
    body: JSON.stringify({ query, variables: { username } }),
  });
  if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.message).join('; '));
  const profile = payload.data?.matchedUser;
  if (!profile) throw new Error(`No public LeetCode profile returned for ${username}`);
  const allSolved = profile.submitStats?.acSubmissionNum?.find((entry) => entry.difficulty === 'All')?.count;
  return {
    solved: numeric(allSolved),
    rating: numeric(payload.data?.userContestRanking?.rating),
  };
}

async function fetchCodeforces() {
  const handle = usernames.codeforces;
  const profile = await getJson(`https://codeforces.com/api/user.info?handles=${encodeURIComponent(handle)}`);
  if (profile.status !== 'OK' || !profile.result?.[0]) {
    throw new Error(profile.comment || `No public Codeforces profile returned for ${handle}`);
  }

  // Codeforces documents a two-second minimum interval between API calls.
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  const submissions = await getJson(
    `https://codeforces.com/api/user.status?handle=${encodeURIComponent(handle)}&from=1&count=10000`,
  );
  if (submissions.status !== 'OK' || !Array.isArray(submissions.result)) {
    throw new Error(submissions.comment || `Could not read Codeforces submissions for ${handle}`);
  }
  const solvedProblems = new Set(
    submissions.result
      .filter((submission) => submission.verdict === 'OK' && submission.problem?.contestId != null)
      .map((submission) => `${submission.problem.contestId}/${submission.problem.index}`),
  );
  return {
    solved: solvedProblems.size,
    rating: numeric(profile.result[0].rating),
  };
}

function pickNumber(object, candidates) {
  for (const candidate of candidates) {
    const value = candidate.split('.').reduce((current, key) => current?.[key], object);
    const found = numeric(value);
    if (found !== null) return found;
  }
  return null;
}

async function fetchCodeChef() {
  const handle = usernames.codechef;
  const providers = [
    `https://codechef-api-oaus.onrender.com/api/v1/users/${encodeURIComponent(handle)}`,
    `https://codechef-api.vercel.app/handle/${encodeURIComponent(handle)}`,
  ];

  for (const url of providers) {
    try {
      const profile = await getJson(url);
      const solved = pickNumber(profile, [
        'problemsSolved.practice.total',
        'problems_solved.practice.total',
        'totalProblemsSolved',
        'problemsSolved',
        'solvedCount',
        'fullySolved',
      ]);
      const rating = pickNumber(profile, ['rating', 'currentRating', 'current_rating', 'ratingNumber']);
      if (solved !== null || rating !== null) return { solved, rating };
    } catch (error) {
      console.warn(`CodeChef provider unavailable (${url}): ${error.message}`);
    }
  }

  // CodeChef has no stable public profile API. A best-effort page parse is used
  // only when the public HTML exposes its rating; absent data stays unavailable.
  try {
    const html = await getText(`https://www.codechef.com/users/${encodeURIComponent(handle)}`);
    const ratingMatch = html.match(/class=["']rating-number["'][^>]*>\s*(\d+)/i);
    const solvedMatch = html.match(/(?:fully\s*solved|problems\s*solved)[^\d]{0,80}(\d+)/i);
    return {
      solved: numeric(solvedMatch?.[1]),
      rating: numeric(ratingMatch?.[1]),
    };
  } catch (error) {
    console.warn(`CodeChef profile page unavailable: ${error.message}`);
    return null;
  }
}

async function readPreviousStats() {
  try {
    return { ...defaults, ...JSON.parse(await readFile(statsPath, 'utf8')) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { ...defaults };
  }
}

async function updateProvider(label, fetcher, keys, stats) {
  try {
    const result = await fetcher();
    if (!result) return;
    stats[keys.solved] = result.solved;
    stats[keys.rating] = result.rating;
    console.log(`${label}: updated public stats`);
  } catch (error) {
    console.warn(`${label}: keeping previous values (${error.message})`);
  }
}

const stats = await readPreviousStats();
const previousValues = JSON.stringify({
  leetcodeSolved: stats.leetcodeSolved,
  leetcodeRating: stats.leetcodeRating,
  codechefSolved: stats.codechefSolved,
  codechefRating: stats.codechefRating,
  codeforcesSolved: stats.codeforcesSolved,
  codeforcesRating: stats.codeforcesRating,
});
await Promise.all([
  updateProvider('LeetCode', fetchLeetCode, { solved: 'leetcodeSolved', rating: 'leetcodeRating' }, stats),
  updateProvider('CodeChef', fetchCodeChef, { solved: 'codechefSolved', rating: 'codechefRating' }, stats),
  updateProvider('Codeforces', fetchCodeforces, { solved: 'codeforcesSolved', rating: 'codeforcesRating' }, stats),
]);
const currentValues = JSON.stringify({
  leetcodeSolved: stats.leetcodeSolved,
  leetcodeRating: stats.leetcodeRating,
  codechefSolved: stats.codechefSolved,
  codechefRating: stats.codechefRating,
  codeforcesSolved: stats.codeforcesSolved,
  codeforcesRating: stats.codeforcesRating,
});
if (currentValues !== previousValues || !stats.updatedAt) {
  stats.updatedAt = new Date().toISOString();
}

await mkdir(path.dirname(statsPath), { recursive: true });
await writeFile(statsPath, `${JSON.stringify(stats, null, 2)}\n`, 'utf8');
await import('./build-cp-svg.mjs');
