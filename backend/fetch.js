/**
 * 抓数据这一层：只负责「去外部网站把比赛抓回来」，不碰数据库。
 *
 * 两个来源：
 *   1. 足球 —— football-data.org（需要 FOOTBALL_DATA_KEY）
 *   2. 电竞 —— PandaScore（需要 PANDASCORE_KEY）
 *
 * 抓取逻辑是从老的 api/matches.js 搬过来的，尽量保持不变，
 * 只多做两件事：① 足球的联赛名/球队名转成中文；② 按来源分组，方便数据库整体替换。
 */
import './env.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zhLeague, zhTeamDeep, zhStage } from './zh.js';
import { fetchBWF } from './bwf.js';

const here = fileURLToPath(new URL('.', import.meta.url));

const FB_KEY = process.env.FOOTBALL_DATA_KEY || '';
const PS_KEY = process.env.PANDASCORE_KEY || '';

// football-data.org 免费版【每分钟仅 10 次请求】，所以默认只留 6 个联赛
const FB_COMPETITIONS = (process.env.FB_COMPETITIONS || 'PL,PD,SA,BL1,FL1,CL')
  .split(',').map(s => s.trim()).filter(Boolean);
// 电竞项目（不含 csgo：半个月窗口下 past 有 800+ 场低级别赛事）
const PS_GAMES = (process.env.PS_GAMES || 'lol,valorant,dota2')
  .split(',').map(s => s.trim()).filter(Boolean);

// 赛程窗口：今天 0 点 ~ 未来 15 天；赛果回溯 15 天
const LOOKAHEAD_DAYS = Number(process.env.LOOKAHEAD_DAYS || 15);
const RESULT_LOOKBACK_DAYS = Number(process.env.RESULT_LOOKBACK_DAYS || 15);
const RESULT_MAX = Number(process.env.RESULT_MAX || 260);

// PandaScore 单页上限 100 条，半个月窗口必须翻页
const PS_MAX_PAGES = Number(process.env.PS_MAX_PAGES || 3);
const PS_MAX_PAGES_PAST = Number(process.env.PS_MAX_PAGES_PAST || 8);
const PS_MAX_PER_DAY = Number(process.env.PS_MAX_PER_DAY || 12);
const PS_RESULT_PER_DAY = Number(process.env.PS_RESULT_PER_DAY || 3);

// 知名赛事，用来把「用户更可能想看的比赛」排在前面
const TOP_LEAGUE_RE = /LPL|LCK|LEC|LCS|EMEA Masters|Worlds|MSI|VCT|Champions|Major|The International|BLAST|IEM|ESL|Premier League|Champions League|Serie A|Bundesliga|Ligue 1|Primera|Brasileiro|中超/i;

/**
 * 读观赛渠道映射表（channels.json）。
 * 依次尝试几个可能的位置，找不到就用空表（只是没有渠道信息，不影响别的）。
 */
function loadChannels() {
  const candidates = [
    join(here, 'channels.json'),          // backend/channels.json（本文件同目录）
    join(process.cwd(), 'channels.json'), // 从别处启动时的兜底
  ];
  for (const p of candidates) {
    try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { /* 换下一个 */ }
  }
  console.warn('[channels] 没找到 channels.json，本次不附观赛渠道');
  return {};
}
const CHANNELS = loadChannels();

/** 按赛事关键词从渠道表里挑渠道；长度 <= 4 的短 key（联赛 code）只做精确匹配 */
function pickChannels(keys) {
  const out = [], seen = new Set();
  const platforms = CHANNELS._platforms || {};   // 平台名 → 网址（集中一处维护）
  for (const key of keys.filter(Boolean)) {
    for (const [pat, list] of Object.entries(CHANNELS)) {
      if (pat.startsWith('_')) continue;
      const hit = pat.length <= 4 ? key === pat : (key === pat || key.includes(pat));
      if (!hit) continue;
      for (const ch of list) {
        if (seen.has(ch.n)) continue;
        seen.add(ch.n);
        out.push({ ...ch, url: platforms[ch.n] || null });
      }
    }
  }
  return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 带 429 重试的 fetch：football-data 免费版超频就返回 429，不退避就整场抓不到 */
async function fetchWithRetry(url, opts, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, opts);
    if (res.status !== 429) return res;
    if (attempt >= retries) return res;
    await sleep(1500 * (attempt + 1));   // 退避 1.5s → 3s
  }
}

/** ============ 数据源 1：足球 ============ */
async function fetchFootball() {
  if (!FB_KEY) return { ok: false, upcoming: [], results: [] };

  const out = [], results = [];
  const now = Date.now();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const lo = dayStart.getTime();
  const hi = now + LOOKAHEAD_DAYS * 86400000;
  const resLo = now - RESULT_LOOKBACK_DAYS * 86400000;
  let success = 0;

  await Promise.all(FB_COMPETITIONS.map(async comp => {
    try {
      const url = `https://api.football-data.org/v4/competitions/${comp}/matches`;
      const res = await fetchWithRetry(url, { headers: { 'X-Auth-Token': FB_KEY } });
      if (!res.ok) return;
      success++;
      const { matches = [] } = await res.json();

      for (const m of matches) {
        const ts = new Date(m.utcDate).getTime();
        const compName = m.competition?.name || comp;
        const ft = m.score?.fullTime;
        const stageLabel = m.matchday ? `第 ${m.matchday} 轮` : (zhStage(m.stage) || m.stage || '');
        const league = [zhLeague(compName), stageLabel].filter(Boolean).join(' · ');
        const home = zhTeamDeep(m.homeTeam);
        const away = zhTeamDeep(m.awayTeam);
        const top = TOP_LEAGUE_RE.test(compName) ? 1 : 0;
        // 渠道用英文原名去查（渠道表里存的是官方名）
        const channels = pickChannels([compName, m.competition?.code, comp]);

        // ① 已结束 → 赛果
        if (m.status === 'FINISHED' || m.status === 'AWARDED') {
          if (ts < resLo || ts > now || ft?.home == null) continue;
          results.push({
            id: `fb-${m.id}`, sport: 'football', league, home, away,
            utcDate: m.utcDate, status: 'FINISHED',
            score: `${ft.home} : ${ft.away}`, channels: [], info: null, top,
          });
          continue;
        }

        // ② 进行中 / 未开赛 → 赛程
        const live = m.status === 'IN_PLAY' || m.status === 'PAUSED';
        if (!live && !(ts >= lo && ts <= hi)) continue;
        out.push({
          id: `fb-${m.id}`, sport: 'football', league, home, away,
          utcDate: m.utcDate, status: m.status,
          score: ft?.home != null ? `${ft.home} : ${ft.away}` : null,
          channels, info: null, top,
        });
      }
    } catch { /* 单个联赛失败不影响其它联赛 */ }
  }));

  // 一个联赛都没成功（多半是限流/断网）→ 标记失败，调用方保留旧数据
  return { ok: success > 0, upcoming: out, results };
}

/** ============ 数据源 2：电竞（PandaScore） ============ */
async function psFetch(game, kind, from, to, maxPages, extraQuery = '') {
  const out = [], seen = new Set();
  const t0 = new Date(from).toISOString().slice(0, 16);
  const t1 = new Date(to).toISOString().slice(0, 16);
  let ok = false;

  for (let page = 1; page <= maxPages; page++) {
    const url = `https://api.pandascore.co/${game}/matches/${kind}` +
                `?per_page=100&page=${page}&range[begin_at]=${t0},${t1}${extraQuery}&token=${PS_KEY}`;
    try {
      const res = await fetch(url);
      if (!res.ok) break;
      ok = true;
      const arr = await res.json();
      if (!Array.isArray(arr) || !arr.length) break;
      for (const m of arr) if (!seen.has(m.id)) { seen.add(m.id); out.push(m); }
      if (arr.length < 100) break;   // 不满一页 = 已到末尾
    } catch { break; }
  }
  return { items: out, ok };
}

/** 把一场 PandaScore 原始数据转成内部结构；对阵未定/拿不到队名返回 null */
function psNormalize(m, game, status) {
  const home = m.opponents?.[0]?.opponent?.name || m.opponents?.[0]?.opponent?.acronym;
  const away = m.opponents?.[1]?.opponent?.name || m.opponents?.[1]?.opponent?.acronym;
  if (!home || !away) return null;
  if (/^tbd$/i.test(home) && /^tbd$/i.test(away)) return null;

  const score = (m.results || []).map(r => r.score).join(' : ');
  if (status === 'FINISHED' && !score) return null;   // 没有比分的不算赛果

  const lg = m.league?.name || '';
  const se = m.serie?.full_name || m.serie?.name || '';
  return {
    id: `ps-${m.id}`, sport: 'esports',
    league: [lg, se].filter(Boolean).join(' · ') || m.tournament?.name || m.name || '电竞赛事',
    home, away,
    utcDate: m.begin_at, status,
    score: score || null,
    channels: pickChannels([lg, se, m.tournament?.name, m.videogame?.name, game]),
    info: null,
    bo: m.number_of_games ? `BO${m.number_of_games}` : null,
    game,
    top: TOP_LEAGUE_RE.test(`${lg} ${se}`) ? 1 : 0,
  };
}

/** 赛果采样：按「相对天 × 项目」分组，每组只留知名赛事优先的前 perDay 场 */
function sampleResults(list, perDay) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const buckets = new Map();
  for (const m of list) {
    const d = new Date(m.utcDate); d.setHours(0, 0, 0, 0);
    const k = Math.round((d - today) / 86400000);
    const key = `${m.game}|${k}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(m);
  }
  const kept = [];
  for (const arr of buckets.values()) {
    arr.sort((a, b) => {
      if (a.top !== b.top) return b.top - a.top;
      return new Date(b.utcDate) - new Date(a.utcDate);
    });
    kept.push(...arr.slice(0, perDay));
  }
  return kept;
}

async function fetchEsports() {
  if (!PS_KEY) return { ok: false, upcoming: [], results: [] };

  const now = Date.now();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const lo = dayStart.getTime();
  const hi = now + LOOKAHEAD_DAYS * 86400000;
  const resLo = now - RESULT_LOOKBACK_DAYS * 86400000;
  const todayKey0 = new Date(); todayKey0.setHours(0, 0, 0, 0);
  let success = 0;

  const groups = await Promise.all(PS_GAMES.map(async game => {
    let out = [];
    const pastRaw = [];
    try {
      // 未开赛 / 进行中：下界往前多放 1 天，兜住「昨晚开打、现在还在打」的场次
      const up = await psFetch(game, 'upcoming', lo - 86400000, hi, PS_MAX_PAGES, '&sort=begin_at');
      if (up.ok) success++;
      for (const m of up.items) {
        const ts = new Date(m.begin_at).getTime();
        const live = m.status === 'running';
        if (!live && !(ts >= lo && ts <= hi)) continue;
        const item = psNormalize(m, game, m.status === 'not_started' ? 'SCHEDULED' : m.status);
        if (!item) continue;
        item._ts = ts;
        out.push(item);
      }
      // 按「相对天」分组，每天最多留 PS_MAX_PER_DAY 场（取开赛最早的）
      const byDay = new Map();
      for (const m of out) {
        const dk = Math.round((m._ts - todayKey0) / 86400000);
        if (!byDay.has(dk)) byDay.set(dk, []);
        byDay.get(dk).push(m);
      }
      const kept = [];
      for (const list of byDay.values()) {
        list.sort((a, b) => a._ts - b._ts);
        kept.push(...list.slice(0, PS_MAX_PER_DAY));
      }
      out = kept;

      // 已结束 → 赛果（不加 sort=-begin_at：会把 begin_at 为 null 的取消场次排到最前）
      const past = await psFetch(game, 'past', resLo, now, PS_MAX_PAGES_PAST);
      if (past.ok) success++;
      for (const m of past.items) {
        if (m.status !== 'finished' || !m.begin_at) continue;
        const ts = new Date(m.end_at || m.begin_at).getTime();
        if (ts < resLo || ts > now) continue;
        const item = psNormalize(m, game, 'FINISHED');
        if (!item) continue;
        item._ts = ts;
        pastRaw.push(item);
      }
    } catch { /* 单个游戏失败不影响其它 */ }
    return { out, past: sampleResults(pastRaw, PS_RESULT_PER_DAY) };
  }));

  const strip = ({ _ts, ...rest }) => rest;   // 内部排序字段不外传
  return {
    ok: success > 0,
    upcoming: groups.flatMap(g => g.out).map(strip),
    results: groups.flatMap(g => g.past)
      .sort((a, b) => b._ts - a._ts)
      .slice(0, RESULT_MAX)
      .map(strip),
  };
}

/**
 * 抓取全部来源。返回：
 *   ok      —— 每个源这次是否成功（失败时调用方保留数据库里的旧数据）
 *   sources —— 按来源分组的赛程/赛果，方便按源整体替换
 */
export async function fetchAll() {
  const [football, pandascore, bwf] = await Promise.all([
    fetchFootball(),
    fetchEsports(),
    fetchBWF(pickChannels(['羽毛球', 'Badminton', 'BWF'])),
  ]);
  return {
    ok: { football: football.ok, pandascore: pandascore.ok, bwf: bwf.ok },
    sources: {
      football: { upcoming: football.upcoming, results: football.results },
      pandascore: { upcoming: pandascore.upcoming, results: pandascore.results },
      bwf: { upcoming: bwf.upcoming, results: bwf.results },
    },
  };
}
