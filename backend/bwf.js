/**
 * 数据源：羽毛球（BWF 官方站内接口，免注册）
 *
 * BWF 没有公开的开发者接口，但这套是它自己网页在用的：
 *   https://extranet-lv.bwfbadminton.com/api/*
 *
 * 两个实测过的坑：
 *   1. 必须走 curl。Cloudflare 按 TLS 指纹拦人 —— 同样的地址和请求头，
 *      curl 能过，Node 自己的 fetch 一律 403。所以这里用子进程调 curl。
 *      （Windows 10/11 自带的 curl 就够用，不用额外安装。）
 *   2. 短时 IP 限流：连续猛刷会被 403，冷却 30~60 秒自愈。
 *      所以并发压到 4，并在每次请求之间加一点随机间隔。
 */
import { execFile } from 'node:child_process';
import { zhBwfTour, zhBwfCat } from './bwf-zh.js';

const BWF_API = process.env.BWF_API || 'https://extranet-lv.bwfbadminton.com/api';
const BWF_ON = String(process.env.BWF_ON || '1') !== '0';
const BWF_CONCURRENCY = Number(process.env.BWF_CONCURRENCY || 4);
const BWF_MAX_TOURNAMENTS = Number(process.env.BWF_MAX_TOURNAMENTS || 30);
const BWF_MAX_MATCHES = Number(process.env.BWF_MAX_MATCHES || 300);
const BWF_RESULT_MAX = Number(process.env.BWF_RESULT_MAX || 120);
const BWF_TIMEOUT = Number(process.env.BWF_TIMEOUT || 20);   // 单条 curl 最长等多少秒

const LOOKAHEAD_DAYS = Number(process.env.LOOKAHEAD_DAYS || 15);
const RESULT_LOOKBACK_DAYS = Number(process.env.RESULT_LOOKBACK_DAYS || 15);

const BWF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// 过滤：青少年/元老/未来系列/户外羽毛球/已取消 —— 除非是重点赛事
const BWF_SKIP_RE = /Junior|Youth|U1[0-9]|U2[0-9]|Veteran|Future Series|AirBadminton|Cancelled/i;
const BWF_KEEP_RE = /World Junior|World Championships|Asian Games|Olympic|Thomas Cup|Uber Cup|Sudirman|Super (1000|750|500|300|100)|World Tour|Continental Championships/i;
const BWF_PREFIX_RE = /^(?:CLASH OF CLAHS|CLASH OF CLANS|VICTOR|YONEX|LI-NING|LI NING|HSBC|TOYOTA|DAIHATSU|ALLIANZ|NAVEK|ROKETTO|BARFOOT|PETRONAS|MITSUBISHI|DAIKIN|KIA|PIONEER|SATHIO|PERODUA|CELCOM|AIRASIA|CLASH)\s+/i;
// 高关注度赛事 → 同一时间段里排前面
const BWF_TOP_RE = /Super (1000|750|500)|World Championships|Asian Games|Olympic|Thomas Cup|Uber Cup|Sudirman/i;

const BWF_DISC = { MS: '男单', WS: '女单', MD: '男双', WD: '女双', XD: '混双' };
const BWF_ROUND = {
  F: '决赛', Final: '决赛', Finals: '决赛',
  SF: '半决赛', 'Semi Finals': '半决赛',
  QF: '1/4决赛', 'Quarter Finals': '1/4决赛',
  R16: '16强', R32: '32强', R64: '64强', R128: '128强',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 用 curl 取一段 JSON。
 * 返回 { data, err }：err 为空表示成功；否则是一句简短的原因，方便排障。
 */
function bwfCurl(path, params) {
  const qs = new URLSearchParams(
    Object.entries(params || {}).filter(([, v]) => v != null && v !== '')
  );
  const url = `${BWF_API}${path}${qs.toString() ? '?' + qs : ''}`;

  return new Promise((resolve) => {
    execFile('curl', [
      '-s', '-m', String(BWF_TIMEOUT),
      '-H', 'Accept: application/json, text/plain, */*',
      '-H', 'Referer: https://bwfbadminton.com/',
      '-H', 'Origin: https://bwfbadminton.com',
      '-H', `User-Agent: ${BWF_UA}`,
      '-w', '\n__HTTP__%{http_code}',
      url,
    ], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      if (err) {
        const why = err.code === 'ENOENT' ? 'no-curl' : String(err.code || err.message).slice(0, 40);
        return resolve({ data: null, err: why });
      }
      const m = String(stdout).match(/\n__HTTP__(\d+)\s*$/);
      const code = m ? Number(m[1]) : 0;
      if (code !== 200) return resolve({ data: null, err: code === 403 ? 'rate_limited' : `http-${code}` });
      try { resolve({ data: JSON.parse(String(stdout).replace(/\n__HTTP__\d+\s*$/, '')), err: null }); }
      catch { resolve({ data: null, err: 'bad-json' }); }
    });
  });
}

/** 这个赛事值不值得展示 */
function bwfWorth(t) {
  const s = `${t?.name || ''} ${t?.category || ''}`;
  if (/AirBadminton|Cancelled/i.test(s)) return false;   // 硬排除放最前
  if (BWF_KEEP_RE.test(s)) return true;
  return !BWF_SKIP_RE.test(s);
}

/** 把赛事名的赞助商前缀、年份、括号之类收拾干净 */
function bwfShortName(name) {
  let s = String(name || '').trim();
  s = s.replace(/\s+powered by[\s\S]*$/i, '');
  s = s.replace(BWF_PREFIX_RE, '');
  s = s.replace(/^\d+(?:st|nd|rd|th)\s+/i, '');
  s = s.replace(/\s*\b(?:19|20)\d{2}\b/g, '');
  s = s.replace(/\s*\(([^)]*)\)\s*$/, '');
  return s.replace(/\s{2,}/g, ' ').trim() || String(name || '').trim();
}

/** 取一方的选手名（单打一个人，双打两个人拼成 "A / B"） */
function bwfSide(m, side) {
  return [m?.[`${side}p1_detail`], m?.[`${side}p2_detail`]]
    .filter(Boolean)
    .map((p) => p.name_display || [p.first_name, p.last_name].filter(Boolean).join(' ') || p.name_short1 || '')
    .filter(Boolean)
    .join(' / ');
}

/** 逐局比分：上游给的是 HTML 片段，剥掉标签后拼成 "21-18 21-15" */
function bwfScore(m) {
  const strip = (h) => String(h || '').replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean);
  const a = strip(m?.team1Score), b = strip(m?.team2Score);
  if (!a.length || !b.length) return null;
  return a.map((x, i) => `${x}-${b[i] ?? '?'}`).join(' ');
}

/** 开赛时刻藏在 oop_text 里（"Starting at 9:00 AM"），是场馆当地时间，只当文本用 */
function bwfOopTime(oop) {
  const m = String(oop || '').match(/(?:Starting at|Not before)\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (/PM/i.test(m[3])) h += 12;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/**
 * BWF 的 start_time 是「场馆当地时刻」伪装成 UTC（当地 18:00 会存成 18:00Z）。
 * 直接交给前端，会被再按浏览器时区换算一次，傍晚的场次就被推到第二天。
 * 这里统一压成「当天中午」：日期不变，任何时区换算都不会跨天；
 * 具体时刻本来也不可靠（前端显示「待定」）。
 */
function bwfNoon(tsMs) {
  const d = new Date(tsMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0)).toISOString();
}
/**
 * 列出赛事在 [minDay, maxDay] 这段窗口里覆盖的每一天（返回 "YYYY-MM-DD"）。
 * 用日期字符串比较，不掺时区，避免边界那天被挪走。
 */
function bwfDaysInWindow(startStr, endStr, minDay, maxDay) {
  const s = String(startStr || '').slice(0, 10);
  const e = String(endStr || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(e)) return [];
  const out = [];
  const end = new Date(`${e}T12:00:00Z`).getTime();
  for (let cur = new Date(`${s}T12:00:00Z`).getTime(); cur <= end && out.length < 60; cur += 86400000) {
    const day = new Date(cur).toISOString().slice(0, 10);
    if (day >= minDay && day <= maxDay) out.push(day);
  }
  return out;
}

function bwfRound(roundName, roundKey) {
  const r = String(roundName || roundKey || '').trim();
  if (!r) return null;
  if (BWF_ROUND[r]) return BWF_ROUND[r];
  const q = r.match(/^Qual\.?\s*(.*)$/i);
  if (q) return `资格赛${BWF_ROUND[q[1]] || q[1] || ''}`;
  return r;
}

/**
 * 抓羽毛球：先拿「赛事清单」，再逐个赛事拿「对阵」，最后转成统一结构。
 * @param {Array} channels 观赛渠道（由调用方查表后传进来）
 */
export async function fetchBWF(channels = []) {
  if (!BWF_ON) return { ok: false, skipped: true, upcoming: [], results: [] };

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const t0 = today.getTime();
  const hi = t0 + (LOOKAHEAD_DAYS + 1) * 86400000 - 1;
  const resLo = t0 - RESULT_LOOKBACK_DAYS * 86400000;
  const d2 = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  // 赛事卡允许落在「今天 ~ 未来 15 天」之内
  const minDay = d2(t0);
  const lastDay = new Date(today); lastDay.setDate(lastDay.getDate() + LOOKAHEAD_DAYS);
  const maxDay = d2(lastDay.getTime());

  // ① 赛事清单
  const listRes = await bwfCurl('/vue-tournaments-search', {
    startDate: d2(resLo - 86400000), endDate: d2(hi + 86400000),
    page: 1, perPage: 100, drawCount: 1, activeTab: 1,
  });
  if (listRes.err) return { ok: false, error: listRes.err, upcoming: [], results: [] };

  let list = (listRes.data?.results?.data || []).filter(bwfWorth);

  // 上游给的清单是按「开始日期」排的，直接截断会把后面（更未来）的赛事丢掉。
  // 所以先重排：还没结束的赛事优先（赛程要用），其次是最近的已结束赛事（赛果要用）。
  const startTs = (t) => new Date(String(t?.start_date || '').replace(' ', 'T')).getTime() || 0;
  const endTs = (t) => new Date(String(t?.end_date || '').replace(' ', 'T')).getTime() || 0;
  const active = list.filter((t) => endTs(t) >= t0).sort((a, b) => startTs(a) - startTs(b));
  const past = list.filter((t) => endTs(t) < t0).sort((a, b) => endTs(b) - endTs(a));
  list = [...active, ...past].slice(0, BWF_MAX_TOURNAMENTS);
  if (!list.length) return { ok: true, upcoming: [], results: [] };

  // ② 并发拉对阵（并发压到 4，请求之间加随机间隔，避免被限流）
  const detail = new Array(list.length).fill(null);
  let cursor = 0, fails = 0;
  await Promise.all(Array.from({ length: Math.min(BWF_CONCURRENCY, list.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= list.length) return;
      const { data, err } = await bwfCurl('/vue-tournament-matches', { tmtId: list[i].id });
      if (err) fails++;
      detail[i] = data?.results?.by_court || null;
      await sleep(120 + Math.random() * 180);
    }
  }));

  // ③ 转成统一结构，分两遍走：
  //    BWF 是「逐日发布」赛程的 —— 未来某天的对阵要等那天到了才出现，
  //    所以只靠真实对阵，未来的日子会全是空的、全挤在今天。
  //    第一遍：收下已有的对阵，并记下「这个赛事的哪些天已经有对阵」；
  //    第二遍：给「还没排到对阵」的日子补一张赛事级卡片（只写赛事名/级别/地点）。
  const upcoming = [];
  const results = [];
  const daysWithMatches = new Map();   // 赛事 id -> Set('YYYY-MM-DD')

  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const byCourt = detail[i];
    if (!byCourt || !Object.keys(byCourt).length) continue;

    const tmtName = zhBwfTour(bwfShortName(t.name));   // 赛事名中文化（没收录的原样保留）
    const top = BWF_TOP_RE.test(`${t.category || ''} ${t.name || ''}`) ? 1 : 0;
    const daySet = new Set();

    for (const [roundKey, matches] of Object.entries(byCourt)) {
      for (const m of Object.values(matches)) {
        const ts = Number(m?.start_time) * 1000;
        if (!ts || isNaN(ts)) continue;
        const home = bwfSide(m, 't1'), away = bwfSide(m, 't2');
        if (!home || !away) continue;

        const discCode = String(m.draw_name || '').split(/\s+-\s+/)[0].trim();
        const round = bwfRound(m.round_name, roundKey);
        const finished = Number(m.winner) > 0;

        const base = {
          id: `bwf-${t.id}-${m.id}`,
          sport: 'badminton',
          league: [tmtName, BWF_DISC[discCode] || discCode].filter(Boolean).join(' · '),
          home, away,
          utcDate: bwfNoon(ts),
          channels,
          info: null,
          bo: round,          // 借用 bo 字段显示轮次
          stage: round,
          top,
        };

        if (finished) {
          if (ts < resLo || ts > Date.now()) continue;
          results.push({ ...base, status: 'FINISHED', score: bwfScore(m) || 'W/O', timeText: '—' });
        } else {
          if (ts < t0 || ts > hi) continue;
          daySet.add(base.utcDate.slice(0, 10));
          // 上游不给时区，时间是场馆当地时间 → 直接显示会误导，统一写「待定」，
          // 把当地时间放进情报卡里说明。
          const local = bwfOopTime(m.oop_text);
          const loc = String(t.location || '').trim();
          upcoming.push({
            ...base, status: 'SCHEDULED', score: null, timeText: '待定',
            info: local ? { note: `${loc} · 开赛 ${local}（场馆当地时间，非北京时间）` }
                        : (loc ? { note: loc } : null),
          });
        }
      }
    }
    daysWithMatches.set(t.id, daySet);
  }

  // 第二遍：把「某个赛事举行的每一天」都补上，已经有真实对阵的日子跳过
  for (const t of list) {
    const have = daysWithMatches.get(t.id) || new Set();
    const tmtName = zhBwfTour(bwfShortName(t.name));
    const top = BWF_TOP_RE.test(`${t.category || ''} ${t.name || ''}`) ? 1 : 0;
    const loc = String(t.location || '').trim();

    for (const day of bwfDaysInWindow(t.start_date, t.end_date, minDay, maxDay)) {
      if (have.has(day)) continue;
      upcoming.push({
        id: `bwf-t${t.id}-${day}`,
        sport: 'badminton',
        league: `羽毛球 · ${zhBwfCat(t.category)}`,
        home: tmtName,
        away: null,                       // 没有对手 → 前端只显示赛事名，不显示 "vs"
        top,
        utcDate: `${day}T12:00:00.000Z`,  // 中午：日期怎么换算都不会跨天
        status: 'SCHEDULED',
        score: null,
        timeText: '全天',
        channels,
        info: null,
        stage: loc || null,
        pending: true,
      });
    }
  }

  const failed = fails > 2 && fails > list.length * 0.4;
  return {
    ok: true,
    warning: failed ? 'partial-fail' : null,
    upcoming: upcoming.sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate)).slice(0, BWF_MAX_MATCHES),
    results: results.sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate)).slice(0, BWF_RESULT_MAX),
  };
}
