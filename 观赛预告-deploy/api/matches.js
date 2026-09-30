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
// 羽毛球（BWF）必须走 curl 子进程取数 —— Node 的 fetch/https 会被 Cloudflare 按 TLS 指纹 403
// （Amazon Linux 运行时自带 curl；万一没有，bwfCurl 会捕获 ENOENT 并在 sources.bwf_error 里报 no-curl）
import { execFile } from 'node:child_process';
// 足球赛事中文化：联赛名 / 球队名 / 赛制阶段（映射表见 lib/zh.js，与 server.js 共用同一份）
// ⚠️ 部署时 lib/ 目录必须一起上传，否则本函数会因模块缺失直接 500
import { zhLeague, zhTeam, zhTeamDeep, zhStage } from '../lib/zh.js';

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
const RESULT_MAX = Number(process.env.RESULT_MAX || 420);
// PandaScore 翻页参数：
// ⚠️ 单页上限 100 条，半个月窗口必然溢出（csgo 未来 15 天 187 条、过去 15 天 800+ 条），
//    不翻页会丢掉时间轴后半段的比赛。
const PS_MAX_PAGES = Number(process.env.PS_MAX_PAGES || 3);
const PS_MAX_PAGES_PAST = Number(process.env.PS_MAX_PAGES_PAST || 8);
// ============ 数据源 3：UEFA 官方接口（免费、无需注册、无需 Key）============
// 补 football-data.org 免费版拿不到的赛事 —— 目前是欧国联（UEFA Nations League）。
// ⚠️ 三个实测要点：
//   1. `offset` 和 `limit` 都是**必需参数**，缺一个就 404（报 "null is not valid for offset"）
//   2. 不加 `status=FINISHED` 时返回体里**没有 score 字段**，赛果必须单独拉一次
//   3. `seasonYear` 是「赛季结束年」：2026-27 赛季 = 2027
const UEFA_API = 'https://match.uefa.com/v5/matches';
const UEFA_COMP_ID = process.env.UEFA_COMP_ID || '2014';        // 2014 = UEFA Nations League
const UEFA_SEASON = Number(process.env.UEFA_SEASON || 2027);
const UEFA_PAGE = 100;
const UEFA_MAX_PAGES = Number(process.env.UEFA_MAX_PAGES || 3);

// ============ 数据源 4：BWF 官方内部接口（羽毛球）============
// BWF 没有公开开发者 API，但这套是它自己前端在调的（零 Key，只需官网 Referer）：
//   https://extranet-lv.bwfbadminton.com/api/*
// ⚠️ 三个实测坑（与 server.js 保持一致，改一处要同步改两处）：
//   1. **必须走 curl**：Cloudflare 按 TLS 指纹拦截 —— 同 URL 同请求头，
//      curl(Schannel) 200 / Node fetch(OpenSSL) 一律 403，改请求头绕不过去。
//   2. 短时 IP 限流（连刷几十次 403，冷却 30~60s 自愈）。实测并发 4 拉 41 个赛事零失败。
//   3. 抽签未出的赛事 `by_court` 为 null → 降级成「赛事级卡片」（只有赛事名+日期+地点）。
const BWF_API = process.env.BWF_API || 'https://extranet-lv.bwfbadminton.com/api';
const BWF_ON = String(process.env.BWF_ON || '1') !== '0';
const BWF_CONCURRENCY = Number(process.env.BWF_CONCURRENCY || 4);
const BWF_MAX_TOURNAMENTS = Number(process.env.BWF_MAX_TOURNAMENTS || 30);
const BWF_MAX_MATCHES = Number(process.env.BWF_MAX_MATCHES || 300);
// ⚠️ 单独给赛果设上限：过去半月的羽毛球实测 989 场，共用 RESULT_MAX 会把足球/电竞全挤出去
//    （320 的池子里羽毛球占 300，足球只剩 20）。这里按「赛事级别优先 → 时间倒序」取前 N。
const BWF_RESULT_MAX = Number(process.env.BWF_RESULT_MAX || 120);
// ⚠️ 羽毛球是最慢的一环（二十多个赛事 × curl 子进程）。超时就把它当空数据，
//    宁可少一个源，也不能让整个函数超时 → 504 → 整站白屏。
const BWF_DEADLINE_MS = Number(process.env.BWF_DEADLINE_MS || 25000);
const BWF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const BWF_SKIP_RE = new RegExp(process.env.BWF_SKIP_RE ||
  'Junior|Youth|U1[0-9]|U2[0-9]|Veteran|Future Series|AirBadminton|Cancelled', 'i');
const BWF_KEEP_RE = /World Junior|World Championships|Asian Games|Olympic|Thomas Cup|Uber Cup|Sudirman|Super (1000|750|500|300|100)|World Tour|Continental Championships/i;
const BWF_PREFIX_RE = /^(?:VICTOR|YONEX|LI-NING|LI NING|HSBC|TOYOTA|DAIHATSU|ALLIANZ|NAVEK|ROKETTO|CLASH OF CLAHS|CLASH OF CLANS|BARFOOT|PETRONAS|MITSUBISHI|DAIKIN|KIA|PIONEER|SATHIO|PERODUA|CELCOM|AIRASIA|CLASH)\s+/i;

// 赛事级别 → 中文（枚举值翻译，成本极低；与「球员名中文化」是两回事）
const BWF_CAT = {
  'International Challenge': '国际挑战赛',
  'International Series': '国际系列赛',
  'Future Series': '未来系列赛',
  'Junior International Series': '青年国际系列赛',
  'Junior Future Series': '青年未来系列赛',
  'BWF Tour Super 100': '世界巡回赛 Super 100',
  'HSBC BWF World Tour Super 300': '世界巡回赛 Super 300',
  'HSBC BWF World Tour Super 500': '世界巡回赛 Super 500',
  'HSBC BWF World Tour Super 750': '世界巡回赛 Super 750',
  'HSBC BWF World Tour Super 1000': '世界巡回赛 Super 1000',
  'Multi-Sport Games': '综合运动会',
  'Multi-Sport Games - Team Tournaments': '综合运动会 · 团体',
  'Grade 1 – Individual Junior Tournaments': '世青赛 · 单项',
  'Grade 1 – Junior Team Tournaments': '世青赛 · 团体',
  'Continental Championships': '洲际锦标赛',
};
const bwfCat = (c) => BWF_CAT[String(c || '').trim()] || String(c || '').trim() || '世界羽联巡回赛';
// 高关注度赛事 → 排同一时间段前面（Super 300 及以下不算「知名」）
const BWF_TOP_RE = /Super (1000|750|500)|World Championships|Asian Games|Olympic|Thomas Cup|Uber Cup|Sudirman/i;

// Vercel 函数最长执行时间。冷启动时要并发请求 10 个上游，默认 10s 偏紧。
// 60s：羽毛球要拉二十多个赛事的对阵（curl 子进程），30s 会被拖到超时返回 504
export const config = { maxDuration: 60 };
// 每个电竞项目每天最多保留多少场赛程（避免低级别预选赛淹没页面）
const PS_MAX_PER_DAY = Number(process.env.PS_MAX_PER_DAY || 12);
// 每个电竞项目每天最多保留多少场赛果
// ⚠️ 半个月的电竞赛果实测 778+ 场（csgo 单项目 400+），不采样会把前端灌爆
const PS_RESULT_PER_DAY = Number(process.env.PS_RESULT_PER_DAY || 3);
// 知名赛事优先级：同一时间段里让用户更可能想看的比赛排在前面
// ⚠️ 足球联赛名已全部中文化（见 lib/zh.js），所以这里**必须同时列出中文别名**，
//    否则 top 标记会全部失配，知名赛事优先排序会静默失效。
const TOP_LEAGUE_RE = /LPL|LCK|LEC|LCS|EMEA Masters|Worlds|MSI|VCT|Champions|Major|The International|BLAST|IEM|ESL|英超|英冠|西甲|意甲|德甲|法甲|欧冠|欧联杯|欧协联|巴甲|欧国联|中超|Premier League|Champions League|Serie A|Bundesliga|Ligue 1|Primera|Brasileiro|Nations League/i;

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
  '欧国联': [{ n: '央视体育', free: 1 }, { n: '咪咕视频', free: 1 }],
  'Nations League': [{ n: '央视体育', free: 1 }, { n: '咪咕视频', free: 1 }],
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
  'Badminton': [{ n: 'BWF TV（YouTube）', free: 1 }, { n: '央视体育', free: 1 }],
  '羽毛球': [{ n: 'BWF TV（YouTube）', free: 1 }, { n: '央视体育', free: 1 }, { n: '优酷体育', free: 0 }],
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
// 足球球队名 → 中文（含去后缀兜底）：实现在 lib/zh.js 的 zhTeamDeep，
// 与 server.js 共用同一份，避免两边逻辑漂移。
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 版本标记 —— 让「线上跑的到底是哪一版函数」一眼可见。
// 前端徽章会显示它，/api/selfcheck 也会回传它；改了 api/ 下的代码就顺手 +1。
// 起因：中文化只改了函数层，线上没 Redeploy，页面就一直显示英文，
//       而「函数是旧版」和「函数是新的但上游取不到数」在前端长得一模一样。
const BUILD = 'zh-bwf-20260930b';

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
        const compName = m.competition?.name || comp;   // 保留英文原名：渠道映射（channels.json）按英文 key 匹配
        const ft = m.score?.fullTime;
        // 展示用赛事名 = 中文联赛名 + 轮次/阶段，如「英超 · 第 5 轮」「欧冠 · 小组赛」
        const stageLabel = m.matchday ? `第 ${m.matchday} 轮` : (zhStage(m.stage) || m.stage || '');
        const league = [zhLeague(compName), stageLabel].filter(Boolean).join(' · ');
        const home = zhTeamDeep(m.homeTeam);
        const away = zhTeamDeep(m.awayTeam);

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

// ============ 数据源 3：UEFA 官方（欧国联）============
async function uefaFetch(params) {
  const out = [];
  for (let page = 0; page < UEFA_MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      competitionId: UEFA_COMP_ID,
      offset: String(page * UEFA_PAGE),
      limit: String(UEFA_PAGE),
      seasonYear: String(UEFA_SEASON),
      ...params,
    });
    try {
      const res = await fetch(`${UEFA_API}?${qs}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) break;
      const j = await res.json();
      const list = Array.isArray(j) ? j : (j.data || []);
      out.push(...list);
      if (list.length < UEFA_PAGE) break;
    } catch { break; }
  }
  return out;
}

function uefaNormalize(m, withScore) {
  const dt = m.kickOffTime?.dateTime;
  if (!dt) return null;
  const homeEN = m.homeTeam?.internationalName || m.homeTeam?.translations?.displayName?.EN;
  const awayEN = m.awayTeam?.internationalName || m.awayTeam?.translations?.displayName?.EN;
  // 中文优先：本地映射表 → UEFA 自带官方中文（translations.displayName.ZH）→ 英文原名
  const home = zhTeam(homeEN) || m.homeTeam?.translations?.displayName?.ZH || homeEN;
  const away = zhTeam(awayEN) || m.awayTeam?.translations?.displayName?.ZH || awayEN;
  if (!home || !away) return null;

  const leagueName = m.group?.league?.metaData?.leagueName || '';   // "League A" / "League B" …
  const matchday = m.matchday?.longName || '';                      // "Matchday 3"
  const reg = m.score?.regular;

  return {
    id: `uefa-${m.id}`,
    sport: 'football',
    league: ['欧国联', zhStage(leagueName) || leagueName].filter(Boolean).join(' · '),  // →「欧国联 · A级」
    home, away,
    utcDate: dt,
    status: m.status === 'UPCOMING' ? 'SCHEDULED' : m.status,
    score: (withScore && reg) ? `${reg.home} : ${reg.away}` : null,
    channels: pickChannels(['欧国联', 'UEFA Nations League', 'Nations League', leagueName]),
    info: null,
    stage: matchday || null,
  };
}

async function fetchUEFA() {
  const now = Date.now();
  const todayKey0 = new Date(); todayKey0.setHours(0, 0, 0, 0);
  const t0 = todayKey0.getTime();
  // -1：含第 N 天整天，但不把第 N+1 天的数据也带回来（前端按天过滤，多出来的就是脏数据）
  const hi = t0 + (FB_LOOKAHEAD_DAYS + 1) * 86400000 - 1;
  const resLo = t0 - RESULT_LOOKBACK_DAYS * 86400000;

  try {
    // 两次请求：① 全量（含状态）② 已结束（只有这个带比分）
    const [allRaw, finishedRaw] = await Promise.all([
      uefaFetch({}),
      uefaFetch({ status: 'FINISHED' }),
    ]);

    const scoreById = new Map();
    for (const m of finishedRaw) {
      const reg = m.score?.regular;
      if (reg) scoreById.set(String(m.id), `${reg.home} : ${reg.away}`);
    }

    const upcoming = [];
    const results = [];
    for (const raw of allRaw) {
      if (Number(raw.seasonYear) !== UEFA_SEASON) continue;
      const ts = new Date(raw.kickOffTime?.dateTime || 0).getTime();
      if (!ts) continue;

      if (raw.status === 'FINISHED') {
        if (ts < resLo || ts > now) continue;
        const m = uefaNormalize(raw, true);
        if (!m) continue;
        m.score = scoreById.get(String(raw.id)) || null;
        if (!m.score) continue;
        results.push(m);
      } else {
        if (ts < t0 || ts > hi) continue;
        const m = uefaNormalize(raw, false);
        if (m) upcoming.push(m);
      }
    }
    return { upcoming, results };
  } catch {
    return { upcoming: [], results: [] };
  }
}

// ============ 数据源 4：BWF（羽毛球）============
// 本次调用里 BWF 的失败原因（'no-curl' / 'rate_limited' / 'http-xxx'），线上排障用
let bwfErr = null;

/** 走 curl 取 JSON。Node 的 fetch/https 会被 Cloudflare 按 TLS 指纹 403（见上方常量区注释） */
function bwfCurl(path, params, timeout = 20) {
  const qs = new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v != null && v !== ''));
  const url = `${BWF_API}${path}${qs.toString() ? '?' + qs : ''}`;
  return new Promise((resolve) => {
    execFile('curl', [
      // ⚠️ 不要加 --compressed：Windows 自带 curl 8.0.1 不带该选项，加了直接报错退出
      '-s', '-m', String(timeout),
      '-H', 'Accept: application/json, text/plain, */*',
      '-H', 'Referer: https://bwfbadminton.com/',
      '-H', 'Origin: https://bwfbadminton.com',
      '-H', `User-Agent: ${BWF_UA}`,
      '-w', '\n__HTTP__%{http_code}',
      url,
    ], { maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      if (err) {
        bwfErr = err.code === 'ENOENT' ? 'no-curl' : `exec-${String(err.code || err.message).slice(0, 40)}`;
        return resolve(null);
      }
      const m = stdout.match(/\n__HTTP__(\d+)\s*$/);
      const code = m ? Number(m[1]) : 0;
      if (code !== 200) { bwfErr = code === 403 ? 'rate_limited' : `http-${code}`; return resolve(null); }
      try { resolve(JSON.parse(stdout.replace(/\n__HTTP__\d+\s*$/, ''))); }
      catch { bwfErr = 'bad-json'; resolve(null); }
    });
  });
}

function bwfWorth(t) {
  const s = `${t?.name || ''} ${t?.category || ''}`;
  // 硬排除放最前：AirBadminton 是户外玩法（不是标准羽毛球），取消的赛事也没必要展示。
  // ⚠️ 顺序不能反 —— KEEP 里的 "Continental Championships" 会把
  //    "BWF AirBadminton European Continental Championships" 一起放行（实测踩过）。
  if (/AirBadminton|Cancelled/i.test(s)) return false;
  if (BWF_KEEP_RE.test(s)) return true;
  return !BWF_SKIP_RE.test(s);
}

function bwfShortName(name) {
  let s = String(name || '').trim();
  s = s.replace(/\s+powered by[\s\S]*$/i, '');
  s = s.replace(BWF_PREFIX_RE, '');
  s = s.replace(/^\d+(?:st|nd|rd|th)\s+/i, '');       // "20th Asian Games …" → "Asian Games …"
  s = s.replace(/\s*\b(?:19|20)\d{2}\b/g, '');
  s = s.replace(/\s*\(([^)]*)\)\s*$/, '');
  return s.replace(/\s{2,}/g, ' ').trim() || String(name || '').trim();
}

function bwfSide(m, side) {
  return [m?.[`${side}p1_detail`], m?.[`${side}p2_detail`]]
    .filter(Boolean)
    .map(p => p.name_display || [p.first_name, p.last_name].filter(Boolean).join(' ') || p.name_short1 || '')
    .filter(Boolean)
    .join(' / ');
}

/** 逐局比分：上游给的是 HTML 片段（`<span>21</span><span>21</span>`），剥标签后拼成 "21-18 21-15" */
function bwfScore(m) {
  const strip = (h) => String(h || '').replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean);
  const a = strip(m?.team1Score), b = strip(m?.team2Score);
  if (!a.length || !b.length) return null;
  return a.map((x, i) => `${x}-${b[i] ?? '?'}`).join(' ');
}

/** 开赛时刻在 `oop_text` 里（"Starting at 9:00 AM" 等），且是场馆当地时间 —— 只当文本展示 */
function bwfOopTime(oop) {
  const m = String(oop || '').match(/(?:Starting at|Not before)\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (/PM/i.test(m[3])) h += 12;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

const BWF_DISC = { MS: '男单', WS: '女单', MD: '男双', WD: '女双', XD: '混双' };
const BWF_ROUND = {
  F: '决赛', Final: '决赛', Finals: '决赛', SF: '半决赛', 'Semi Finals': '半决赛',
  QF: '1/4决赛', 'Quarter Finals': '1/4决赛',
  R16: '16强', R32: '32强', R64: '64强', R128: '128强',
};
function bwfRound(roundName, roundKey) {
  const r = String(roundName || roundKey || '').trim();
  if (!r) return null;
  if (BWF_ROUND[r]) return BWF_ROUND[r];
  const q = r.match(/^Qual\.?\s*(.*)$/i);
  if (q) return `资格赛${BWF_ROUND[q[1]] || q[1] || ''}`;
  return r;
}

async function fetchBWF() {
  const empty = { upcoming: [], results: [], tournaments: 0 };
  if (!BWF_ON) return empty;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const t0 = today.getTime();
  // -1：含第 N 天整天，但不把第 N+1 天的数据也带回来（前端按天过滤，多出来的就是脏数据）
  const hi = t0 + (FB_LOOKAHEAD_DAYS + 1) * 86400000 - 1;
  const resLo = t0 - RESULT_LOOKBACK_DAYS * 86400000;
  const d2 = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  try {
    bwfErr = null;
    const listJson = await bwfCurl('/vue-tournaments-search', {
      startDate: d2(resLo - 86400000), endDate: d2(hi + 86400000),
      page: 1, perPage: 100, drawCount: 1, activeTab: 1,
    });
    const listErr = bwfErr;
    let list = listJson?.results?.data || [];
    if (!list.length) return empty;
    list = list.filter(bwfWorth).slice(0, BWF_MAX_TOURNAMENTS);

    // 并发拉对阵（限流靠并发度 + 请求间短间隔压住，实测并发 4 安全）
    const detail = new Array(list.length).fill(null);
    let cursor = 0, fails = 0;
    await Promise.all(Array.from({ length: Math.min(BWF_CONCURRENCY, list.length) }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= list.length) return;
        const j = await bwfCurl('/vue-tournament-matches', { tmtId: list[i].id });
        if (!j) fails++;
        detail[i] = j?.results?.by_court || null;
        await sleep(120 + Math.random() * 180);
      }
    }));

    // 个别赛事上游 500（实测过，如 BWF AirBadminton 某站）不代表这个数据源坏了；
    // 只有大面积失败才算异常，否则 sources.bwf_error 会天天误报，反而掩盖真问题。
    bwfErr = (fails > 2 && fails > list.length * 0.4) ? 'partial-fail' : listErr;

    const upcoming = [];
    const results = [];
    const channels = pickChannels(['羽毛球', 'BWF']);

    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const bc = detail[i];
      const tmtName = bwfShortName(t.name);

      if (!bc || !Object.keys(bc).length) {
        // 抽签未出 → 赛事级卡片（只有赛事名 + 日期 + 地点）
        const sd = new Date(String(t.start_date || '').replace(' ', 'T'));
        if (isNaN(sd.getTime()) || sd.getTime() < t0 || sd.getTime() > hi) continue;
        upcoming.push({
          id: `bwf-t${t.id}`,
          sport: 'badminton',
          league: `羽毛球 · ${bwfCat(t.category)}`,
          home: tmtName,                  // 大字是赛事名，小字是级别 —— 避免同一个名字重复两遍
          away: null,
          top: BWF_TOP_RE.test(`${t.category || ''} ${t.name || ''}`) ? 1 : 0,
                     // 无对手 → 前端只渲染赛事名，不显示 "vs"
          utcDate: sd.toISOString(),
          status: 'SCHEDULED',
          score: null,
          timeText: '全天',               // 赛事级卡片代表「这几天有这项赛事」，谈不上具体时刻
          channels,
          info: null,
          stage: String(t.location || '').trim() || null,
          pending: true,
        });
        continue;
      }

      for (const [roundKey, ms] of Object.entries(bc)) {
        for (const m of Object.values(ms)) {
          const ts = Number(m?.start_time) * 1000;
          if (!ts || isNaN(ts)) continue;
          const home = bwfSide(m, 't1'), away = bwfSide(m, 't2');
          if (!home || !away) continue;

          const drawRaw = String(m.draw_name || '');
          const discCode = drawRaw.split(/\s+-\s+/)[0].trim();
          const round = bwfRound(m.round_name, roundKey);
          const finished = Number(m.winner) > 0;

          const base = {
            id: `bwf-${t.id}-${m.id}`,
            sport: 'badminton',
            league: [tmtName, BWF_DISC[discCode] || discCode].filter(Boolean).join(' · '),
            home, away,
            utcDate: new Date(ts).toISOString(),
            channels,
            info: null,
            bo: round,
            stage: round,
            top: BWF_TOP_RE.test(`${t.category || ''} ${t.name || ''}`) ? 1 : 0,
          };

          if (finished) {
            if (ts < resLo || ts > Date.now()) continue;
            results.push({ ...base, status: 'FINISHED', score: bwfScore(m) || 'W/O', timeText: '—' });
          } else {
            if (ts < t0 || ts > hi) continue;
            // ⚠️ oop_text 里的时间是**场馆当地时间**（BWF 不给时区），直接当北京时间显示会让人错过比赛，
            //    所以统一显示「待定」，把当地时间放进弹窗的情报卡里说明清楚。
            const local = bwfOopTime(m.oop_text);
            upcoming.push({
              ...base, status: 'SCHEDULED', score: null, timeText: '待定',
              info: local ? { note: `${String(t.location || '').trim()} · 开赛 ${local}（场馆当地时间，非北京时间）` }
                          : (String(t.location || '').trim() ? { note: String(t.location).trim() } : null),
            });
          }
        }
      }
    }
    return { upcoming, results, tournaments: list.length };
  } catch {
    return empty;
  }
}

// 截止时间保护：Vercel 函数有 maxDuration，BWF 同步最慢，超时先放弃。
// ⚠️⚠️ 必须 clearTimeout —— 之前用 sleep()+Promise.race，计时器不会取消：
//   fetchBWF 已成功返回后，到点时仍会把 bwfErr 覆写成 'timeout'，误报（数据其实是好的）。
function bwfWithDeadline() {
  let timer = null;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => {
      bwfErr = 'timeout';
      resolve({ upcoming: [], results: [], tournaments: 0 });
    }, BWF_DEADLINE_MS);
  });
  return Promise.race([fetchBWF(), guard]).finally(() => { if (timer) clearTimeout(timer); });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  fb429 = 0;                                     // 每次调用重置限流计数
  bwfErr = null;
  try {
    const [fb, ps, uefa, bwf] = await Promise.all([
      fetchFootball(), fetchEsports(), fetchUEFA(), bwfWithDeadline(),
    ]);
    // 羽毛球一个赛事动辄上百场，不设上限会把响应体撑大、也会挤掉足球电竞的位置
    const bwfUpcoming = [...bwf.upcoming].sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate)).slice(0, BWF_MAX_MATCHES);
    const bwfResults = [...bwf.results]
      .sort((a, b) => (b.top || 0) - (a.top || 0) || new Date(b.utcDate) - new Date(a.utcDate))
      .slice(0, BWF_RESULT_MAX);
    const matches = [...fb.upcoming, ...ps.upcoming, ...uefa.upcoming, ...bwfUpcoming]
      .filter(m => m.utcDate)
      // 羽毛球自带 top（按赛事级别判定，联赛名里看不出级别），别覆盖掉
      .map(m => (m.top === undefined ? { ...m, top: TOP_LEAGUE_RE.test(String(m.league || '')) ? 1 : 0 } : m))
      .sort((a, b) => {
        const t = new Date(a.utcDate) - new Date(b.utcDate);
        return t !== 0 ? t : (b.top || 0) - (a.top || 0);   // 同一时间，知名赛事优先
      });
    // 赛果回顾：合并四个源，按结束时间倒序，覆盖最近半个月
    const results = [...fb.results, ...ps.results, ...uefa.results, ...bwfResults]
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
      build: BUILD,                     // 前端徽章直接显示，用来判断「部署生效了没」
      sources: {
        football: fb.upcoming.length,
        esports: ps.upcoming.length,
        // 欧国联（UEFA 官方接口，免费无需 Key）。为 0 通常是「窗口内确实没有欧国联比赛」，
        // 欧洲国家联赛只在 9/10/11 三个国际比赛窗口进行。
        uefa_nations_league: uefa.upcoming.length,
        // 羽毛球（BWF 内部接口，免费无需 Key）。pending = 抽签未出、只给了赛事名+日期的卡片
        badminton: bwfUpcoming.filter(m => m.sport === 'badminton').length,
        badminton_pending: bwfUpcoming.filter(m => m.pending).length,
        results: results.length,
        // >0 表示本次足球源被限流（不是 Key 的问题），赛程可能偏少
        football_rate_limited: fb429,
        // 非 null 说明羽毛球这一轮没取到数：
        //   no-curl = 运行时没有 curl 命令；rate_limited = 被 Cloudflare 403（等 30~60s 自愈）
        bwf_error: bwfErr,
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
