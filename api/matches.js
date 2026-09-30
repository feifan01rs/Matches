/**
 * Vercel Serverless 版本 —— 把 server.js 的同步逻辑搬到 Vercel 函数
 * 路径：/api/matches.js → 访问 https://你的域名/api/matches
 *
 * 在 Vercel 项目设置里配好环境变量：
 *   FOOTBALL_DATA_KEY, PANDASCORE_KEY
 * 然后把 channels.json 一并提交到仓库（函数里会读取）
 *
 * 注意：Serverless 是无状态的，文件缓存写不进（/tmp 除外且不共享），
 * 所以这里用 Vercel 的 CDN 缓存头（s-maxage）替代本地缓存 —— 效果一样：
 * 10 分钟内所有用户共享一次上游请求。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FB_KEY = process.env.FOOTBALL_DATA_KEY || '';
const PS_KEY = process.env.PANDASCORE_KEY || '';
// ⚠️ football-data.org 免费版限流极严：【每分钟 10 次请求】。
//    本函数每同步一次就要为每个联赛各发 1 次请求，所以默认只留 6 个，必须留余量。
//    否则会 429，表现为「足球一场都取不到」且没有任何报错。
const FB_COMPETITIONS = (process.env.FB_COMPETITIONS || 'PL,PD,SA,BL1,FL1,CL')
  .split(',').map(s => s.trim()).filter(Boolean);
// ⚠️ 不含 csgo：CS2 半个月窗口下 past 有 800+ 场，且多为低级别线上赛，按需求排除
const PS_GAMES = (process.env.PS_GAMES || 'lol,valorant,dota2')
  .split(',').map(s => s.trim()).filter(Boolean);
// 赛程下界固定为「今天 0 点（本地）」，由各 fetch 函数内部计算，不再需要配置项
const FB_LOOKAHEAD_DAYS = Number(process.env.FB_LOOKAHEAD_DAYS || 15);
// 赛果回顾：往前回溯几天（半个月）、最多返回几条
const RESULT_LOOKBACK_DAYS = Number(process.env.RESULT_LOOKBACK_DAYS || 15);
const RESULT_MAX = Number(process.env.RESULT_MAX || 260);
// PandaScore 翻页参数：
// ⚠️ 单页上限 100 条，半个月窗口必然溢出（csgo 未来 15 天 187 条、过去 15 天 800+ 条），
//    不翻页会丢掉时间轴后半段的比赛。
const PS_MAX_PAGES = Number(process.env.PS_MAX_PAGES || 3);
const PS_MAX_PAGES_PAST = Number(process.env.PS_MAX_PAGES_PAST || 8);
// Vercel 函数最长执行时间。冷启动时要并发请求 10 个上游，默认 10s 偏紧。
export const config = { maxDuration: 30 };
// 每个电竞项目每天最多保留多少场赛程（避免低级别预选赛淹没页面）
const PS_MAX_PER_DAY = Number(process.env.PS_MAX_PER_DAY || 12);
// 每个电竞项目每天最多保留多少场赛果
// ⚠️ 半个月的电竞赛果实测 778+ 场（csgo 单项目 400+），不采样会把前端灌爆
const PS_RESULT_PER_DAY = Number(process.env.PS_RESULT_PER_DAY || 3);
// 知名赛事优先级：同一时间段里让用户更可能想看的比赛排在前面
const TOP_LEAGUE_RE = /LPL|LCK|LEC|LCS|EMEA Masters|Worlds|MSI|VCT|Champions|Major|The International|BLAST|IEM|ESL|Premier League|Champions League|Serie A|Bundesliga|Ligue 1|Primera|Brasileiro|中超/i;

/**
 * 渠道表兜底副本 —— 与项目根目录的 channels.json 内容一致。
 *
 * 为什么要内联一份：Vercel 的 Node 函数只会把「被依赖分析追踪到的文件」打包进函数体，
 * `readFileSync` + `new URL(..., import.meta.url)` 这种动态读法**不保证**被追踪到。
 * 一旦 channels.json 没被打进函数，线上就会静默变成「所有比赛都没有观赛渠道」——
 * 拿不到任何报错，只能靠肉眼发现，很难排查。所以这里留一份内置副本兜底：
 * 优先用真实文件（改 channels.json 立即生效），读不到才用这份。
 */
let CHANNELS_SOURCE = 'fallback';   // file = 读到了 channels.json；fallback = 用了内置副本
const FALLBACK_CHANNELS = {
  'Premier League': [{ n: '咪咕视频', free: 1 }, { n: '爱奇艺体育', free: 0 }],
  'PD': [{ n: '爱奇艺体育', free: 0 }, { n: '咪咕视频', free: 1 }],
  'Primera Division': [{ n: '爱奇艺体育', free: 0 }, { n: '咪咕视频', free: 1 }],
  'SA': [{ n: '爱奇艺体育', free: 0 }],
  'Serie A': [{ n: '爱奇艺体育', free: 0 }],
  'BL1': [{ n: '咪咕视频', free: 1 }],
  'Bundesliga': [{ n: '咪咕视频', free: 1 }],
  'FL1': [{ n: '咪咕视频', free: 1 }],
  'Ligue 1': [{ n: '咪咕视频', free: 1 }],
  'Champions League': [{ n: '咪咕视频', free: 1 }, { n: '爱奇艺体育', free: 0 }],
  'CL': [{ n: '咪咕视频', free: 1 }, { n: '爱奇艺体育', free: 0 }],
  'ELC': [{ n: '咪咕视频', free: 1 }],
  'Championship': [{ n: '咪咕视频', free: 1 }],
  'Eredivisie': [{ n: '咪咕视频', free: 1 }],
  'Primeira Liga': [{ n: '咪咕视频', free: 1 }],
  'BSA': [{ n: '咪咕视频', free: 1 }],
  'Brasileirao': [{ n: '咪咕视频', free: 1 }],
  'Campeonato Brasileiro': [{ n: '咪咕视频', free: 1 }],
  'EC': [{ n: '央视体育', free: 1 }, { n: '咪咕视频', free: 1 }],
  'European Championship': [{ n: '央视体育', free: 1 }, { n: '咪咕视频', free: 1 }],
  'World Cup': [{ n: '央视体育', free: 1 }, { n: '咪咕视频', free: 1 }],
  '中超': [{ n: '央视频', free: 1 }, { n: '咪咕视频', free: 1 }],
  'Chinese Super League': [{ n: '央视频', free: 1 }, { n: '咪咕视频', free: 1 }],
  'LPL': [{ n: 'B站', free: 1 }, { n: '虎牙', free: 1 }, { n: '斗鱼', free: 1 }],
  'LCK': [{ n: '虎牙', free: 1 }],
  'LEC': [{ n: 'B站', free: 1 }],
  'LCS': [{ n: '虎牙', free: 1 }],
  'EMEA Masters': [{ n: 'B站', free: 1 }, { n: '虎牙', free: 1 }],
  'Worlds': [{ n: 'B站', free: 1 }, { n: '虎牙', free: 1 }],
  'MSI': [{ n: 'B站', free: 1 }, { n: '虎牙', free: 1 }],
  'Valorant': [{ n: 'B站', free: 1 }, { n: '斗鱼', free: 1 }],
  'VCT': [{ n: 'B站', free: 1 }, { n: '斗鱼', free: 1 }],
  'Champions': [{ n: 'B站', free: 1 }, { n: '斗鱼', free: 1 }],
  'Dota': [{ n: 'B站', free: 1 }],
  'The International': [{ n: 'B站', free: 1 }],
  'DOTA2': [{ n: 'B站', free: 1 }],
  'BLAST': [{ n: 'B站', free: 1 }, { n: '虎牙', free: 1 }],
  'IEM': [{ n: '虎牙', free: 1 }, { n: '斗鱼', free: 1 }],
  'ESL': [{ n: '虎牙', free: 1 }, { n: '斗鱼', free: 1 }],
  'League of Legends': [{ n: 'B站', free: 1 }, { n: '虎牙', free: 1 }],
  'EPL World Series': [{ n: 'B站', free: 1 }],
  'Badminton': [{ n: '央视体育', free: 1 }],
  '羽毛球': [{ n: '央视体育', free: 1 }, { n: '优酷体育', free: 0 }],
};

/**
 * 读取渠道映射表。
 * Vercel 上函数的工作目录是 /var/task，本地是项目根，两者结构一致但 cwd 不一定可靠，
 * 所以依次尝试多个候选路径，命中即用 —— 避免线上静默变成「所有比赛都没有观赛渠道」。
 */
function loadChannels() {
  const here = fileURLToPath(new URL('.', import.meta.url));   // .../api/
  const candidates = [
    new URL('../channels.json', import.meta.url),               // 项目根（Vercel /var/task/channels.json）
    join(process.cwd(), 'channels.json'),                       // cwd 兜底
    join(here, 'channels.json'),                                // 与函数同目录
  ];
  for (const p of candidates) {
    try {
      const table = JSON.parse(readFileSync(p, 'utf-8'));
      CHANNELS_SOURCE = 'file';
      return table;
    } catch { /* 换下一个 */ }
  }
  console.warn('[channels] 渠道表文件未随函数打包，改用内置兜底副本');
  return FALLBACK_CHANNELS;
}
const CHANNELS = loadChannels();

function pickChannels(keys) {
  const out = [], seen = new Set();
  for (const key of keys.filter(Boolean)) {
    for (const [pat, list] of Object.entries(CHANNELS)) {
      if (pat.startsWith('_')) continue;
      // 长度 <= 4 的短 code 只做精确匹配，避免 'BSA'.includes('SA') 误伤
      const hit = pat.length <= 4 ? key === pat : (key === pat || key.includes(pat));
      if (!hit) continue;
      for (const ch of list) if (!seen.has(ch.n)) { seen.add(ch.n); out.push(ch); }
    }
  }
  return out;
}

const isoDate = d => d.toISOString().slice(0, 10);
const dayOffset = n => { const d = new Date(); d.setDate(d.getDate() + n); return isoDate(d); };
const short = n => String(n || '').replace(/\s*(FC|CF|AC|SC|BC|SV|Club|de|the)\s*$/i, '').trim() || n;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 本次调用里 football-data.org 被限流（429）的次数，用于线上排障
let fb429 = 0;

/**
 * 带 429 退避重试的 fetch。
 * football-data.org 免费版【每分钟仅 10 次请求】，超过即 429。
 * 若不重试，症状是「足球一场都取不到，且日志没有任何报错」—— 极易被误判成 Key 失效。
 */
async function fetchWithRetry(url, opts, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, opts);
    if (res.status !== 429) return res;
    fb429++;
    if (attempt >= retries) return res;
    await sleep(1500 * (attempt + 1));        // 退避 1.5s → 3s
  }
}

async function fetchFootball() {
  if (!FB_KEY) return { upcoming: [], results: [] };
  const out = [];        // 未开赛 / 进行中
  const results = [];    // 已结束 → 赛果（复用同一份整季数据，零额外请求）
  const now = Date.now();
  // 赛程下界 = 今天 0 点（本地）：往前不留已过去的场次
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const lo = dayStart.getTime();
  const hi = now + FB_LOOKAHEAD_DAYS * 86400000;
  const resLo = now - RESULT_LOOKBACK_DAYS * 86400000;

  await Promise.all(FB_COMPETITIONS.map(async comp => {
    try {
      // ⚠️ 免费版会忽略 dateFrom/dateTo，必须拉整季再用本地日期过滤
      const url = `https://api.football-data.org/v4/competitions/${comp}/matches`;
      const res = await fetchWithRetry(url, { headers: { 'X-Auth-Token': FB_KEY } });
      if (!res.ok) return;
      const { matches = [] } = await res.json();
      for (const m of matches) {
        const ts = new Date(m.utcDate).getTime();
        const compName = m.competition?.name || comp;
        const ft = m.score?.fullTime;
        const league = compName + (m.matchday ? ` · 第 ${m.matchday} 轮` : (m.stage ? ` · ${m.stage}` : ''));
        const home = short(m.homeTeam?.shortName || m.homeTeam?.name);
        const away = short(m.awayTeam?.shortName || m.awayTeam?.name);

        // ① 已结束 → 赛果
        if (m.status === 'FINISHED' || m.status === 'AWARDED') {
          if (ts < resLo || ts > now || ft?.home == null) continue;
          results.push({
            id: `fb-${m.id}`, sport: 'football', league, home, away,
            utcDate: m.utcDate, status: 'FINISHED',
            score: `${ft.home} : ${ft.away}`,
            channels: [], info: null,
          });
          continue;
        }

        // ② 进行中 / 未开赛 → 赛程（进行中的不受「往前 1 天」窗口限制）
        const live = m.status === 'IN_PLAY' || m.status === 'PAUSED';
        if (!live && !(ts >= lo && ts <= hi)) continue;
        out.push({
          id: `fb-${m.id}`, sport: 'football', league, home, away,
          utcDate: m.utcDate, status: m.status,
          score: ft?.home != null ? `${ft.home} : ${ft.away}` : null,
          channels: pickChannels([compName, m.competition?.code, comp]),
          info: null,
        });
      }
    } catch { /* 单个赛事失败不影响整体 */ }
  }));
  return { upcoming: out, results };
}

/** 按 begin_at 窗口翻页拉取原始场次（自动按 id 去重，最多 maxPages 页）
 *  ⚠️ PandaScore 单页上限 100 条，半个月窗口必然溢出，必须靠 range + page 翻页拿全。 */
async function psFetch(game, kind, from, to, maxPages, extraQuery = '') {
  const out = [], seen = new Set();
  const t0 = new Date(from).toISOString().slice(0, 16);
  const t1 = new Date(to).toISOString().slice(0, 16);
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://api.pandascore.co/${game}/matches/${kind}` +
                `?per_page=100&page=${page}&range[begin_at]=${t0},${t1}${extraQuery}&token=${PS_KEY}`;
    try {
      const res = await fetch(url);
      if (!res.ok) break;
      const arr = await res.json();
      if (!Array.isArray(arr) || !arr.length) break;
      for (const m of arr) if (!seen.has(m.id)) { seen.add(m.id); out.push(m); }
      if (arr.length < 100) break;                     // 不满一页 = 已到末尾
    } catch { break; }
  }
  return out;
}

/** 把一场 PandaScore 原始数据转成内部结构；对阵未定 / 拿不到队名返回 null */
function psNormalize(m, game, status) {
  const home = m.opponents?.[0]?.opponent?.name || m.opponents?.[0]?.opponent?.acronym;
  const away = m.opponents?.[1]?.opponent?.name || m.opponents?.[1]?.opponent?.acronym;
  if (!home || !away) return null;                        // 对阵未定 → 丢弃
  if (/^tbd$/i.test(home) && /^tbd$/i.test(away)) return null;
  const score = (m.results || []).map(r => r.score).join(' : ');
  if (status === 'FINISHED' && !score) return null;       // 没有比分的不算赛果

  const lg = m.league?.name || '', se = m.serie?.full_name || m.serie?.name || '';
  return {
    id: `ps-${m.id}`, sport: 'esports',
    league: [lg, se].filter(Boolean).join(' · ') || m.tournament?.name || m.name || '电竞赛事',
    home, away,
    utcDate: m.begin_at,
    status,
    score: score || null,
    channels: pickChannels([lg, se, m.tournament?.name, m.videogame?.name, game]),
    info: null,
    bo: m.number_of_games ? `BO${m.number_of_games}` : null,
    game,
  };
}

/** 赛果采样：按「相对天 × 项目」分组，每天每项目最多 perDay 场，组内知名赛事优先。
 *  半个月的电竞赛果有 700+ 场，全量返回会把前端灌爆，也会让用户看不到重点。 */
function sampleResults(list, perDay) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const buckets = new Map();
  for (const m of list) {
    const d = new Date(m.utcDate); d.setHours(0, 0, 0, 0);
    const k = Math.round((d - today) / 86400000);         // 相对天（负数 = 过去）
    const key = `${m.game}|${k}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(m);
  }
  const kept = [];
  for (const arr of buckets.values()) {
    arr.sort((a, b) => {
      const ta = TOP_LEAGUE_RE.test(a.league) ? 1 : 0;
      const tb = TOP_LEAGUE_RE.test(b.league) ? 1 : 0;
      if (ta !== tb) return tb - ta;                      // 知名赛事排前面
      return new Date(b.utcDate) - new Date(a.utcDate);   // 再按时间新 → 旧
    });
    kept.push(...arr.slice(0, perDay));
  }
  return kept;
}

async function fetchEsports() {
  if (!PS_KEY) return { upcoming: [], results: [] };
  const now = Date.now();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const lo = dayStart.getTime();                       // 只留今天及以后的赛程
  const hi = now + FB_LOOKAHEAD_DAYS * 86400000;
  const resLo = now - RESULT_LOOKBACK_DAYS * 86400000;
  const todayKey0 = new Date(); todayKey0.setHours(0, 0, 0, 0);

  const groups = await Promise.all(PS_GAMES.map(async game => {
    let out = [];
    const pastRaw = [];
    try {
      // ① 未开赛 / 进行中：range 限定窗口 + 翻页（单页 100 条装不下半个月）
      //    下界往前多放 1 天，只为兜住「昨晚开打、现在还在进行」的场次，本地会再收紧
      const rawUp = await psFetch(game, 'upcoming', lo - 86400000, hi, PS_MAX_PAGES, '&sort=begin_at');
      for (const m of rawUp) {
        const ts = new Date(m.begin_at).getTime();
        const live = m.status === 'running';
        if (!live && !(ts >= lo && ts <= hi)) continue;     // 双保险：本地再按窗口过滤
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

      // ② 已结束 → 赛果（过去半个月）
      // ⚠️ 实测坑：不能加 `sort=-begin_at` —— 会把 begin_at 为 null 的 canceled
      //    场次排到最前，真赛果全被挤掉。默认顺序本身按时间新→旧。
      const rawPast = await psFetch(game, 'past', resLo, now, PS_MAX_PAGES_PAST);
      for (const m of rawPast) {
        if (m.status !== 'finished' || !m.begin_at) continue;  // 排除 canceled / 未开赛
        const ts = new Date(m.end_at || m.begin_at).getTime(); // 用结束时间判断新旧
        if (ts < resLo || ts > now) continue;
        const item = psNormalize(m, game, 'FINISHED');
        if (!item) continue;
        item._ts = ts;
        pastRaw.push(item);
      }
    } catch { /* 单个游戏失败不影响其他 */ }
    return { out, past: sampleResults(pastRaw, PS_RESULT_PER_DAY) };
  }));

  const strip = ({ _ts, ...r }) => r;               // 内部排序字段不对外输出
  return {
    upcoming: groups.flatMap(g => g.out).map(strip),
    results: groups.flatMap(g => g.past)
      .sort((a, b) => b._ts - a._ts)                 // 最新结束的排前面
      .slice(0, RESULT_MAX)
      .map(strip),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  fb429 = 0;                                     // 每次调用重置限流计数
  try {
    const [fb, ps] = await Promise.all([fetchFootball(), fetchEsports()]);
    const matches = [...fb.upcoming, ...ps.upcoming]
      .filter(m => m.utcDate)
      .map(m => ({ ...m, top: TOP_LEAGUE_RE.test(String(m.league || '')) ? 1 : 0 }))
      .sort((a, b) => {
        const t = new Date(a.utcDate) - new Date(b.utcDate);
        return t !== 0 ? t : (b.top || 0) - (a.top || 0);   // 同一时间，知名赛事优先
      });
    // 赛果回顾：合并两个源，按结束时间倒序，覆盖最近半个月
    const results = [...fb.results, ...ps.results]
      .filter(m => m.utcDate && m.score)
      .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
      .slice(0, RESULT_MAX);
    // 让 Vercel CDN 缓存 10 分钟，所有用户共享 → 免费额度不会被击穿。
    // 但若这次足球源被限流（拿不到数据），只缓存 1 分钟，尽快自愈，
    // 否则「限流导致的空足球」会被 CDN 固化住 10 分钟。
    res.setHeader('Cache-Control',
      fb429 > 0 ? 's-maxage=60, stale-while-revalidate=30'
                : 's-maxage=600, stale-while-revalidate=60');
    // sources 用于线上排障：某个数据源返回 0 时，
    // 一眼能区分「上游限流/失败」还是「这个时间段本来就没比赛」
    // 缺 Key 时函数不会报错，只会静默返回空数组 —— 线上最容易被误判成「前端坏了/没接入」。
    // 所以把配置状态一起回传，打开 /api/matches 就能一眼看出到底缺什么。
    const missingKeys = [];
    if (!FB_KEY) missingKeys.push('FOOTBALL_DATA_KEY');
    if (!PS_KEY) missingKeys.push('PANDASCORE_KEY');

    res.status(200).json({
      updatedAt: new Date().toISOString(),
      sources: {
        football: fb.upcoming.length,
        esports: ps.upcoming.length,
        results: results.length,
        // >0 表示本次足球源被限流（不是 Key 的问题），赛程可能偏少
        football_rate_limited: fb429,
        // file = channels.json 已随函数打包；fallback = 用了内置副本
        channels_table: CHANNELS_SOURCE,
        // 未配置的环境变量名（.env 不会上传，必须去 Vercel 后台配）
        missing_keys: missingKeys,
      },
      matches,
      results,
    });
  } catch (e) {
    res.status(502).json({ error: e.message, matches: [], results: [] });
  }
}
