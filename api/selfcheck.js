/**
 * 自检端点 /api/selfcheck
 * ------------------------------------------------------------
 * 存在的意义：把两类「看起来一模一样」的故障彻底拆开。
 *
 *   ① 函数层没通   → Vercel 项目里压根没有 api/ 函数（只传了 index.html）
 *                    页面就只是个静态网页，/api/matches 返回 404。
 *   ② 函数通了但取不到数 → 环境变量缺失 / Key 无效 / 上游限流。
 *
 *   这两种情况在前端都表现为「显示演示数据」，肉眼无法区分，
 *   所以单独开一个不依赖任何上游的端点，先证明「函数层活着」。
 *
 * 用法：
 *   /api/selfcheck            只看函数层（零上游请求，不消耗额度）
 *   /api/selfcheck?probe=1    额外真实请求一次两个上游，验证 Key 是否有效
 *
 * ⚠️ 本端点不回传任何 Key 明文，只回传「是否配置」和长度。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const FB_KEY = process.env.FOOTBALL_DATA_KEY || '';
const PS_KEY = process.env.PANDASCORE_KEY || '';

const splitList = (s, dft) => (s || dft).split(',').map(x => x.trim()).filter(Boolean);
const FB_COMPETITIONS = splitList(process.env.FB_COMPETITIONS, 'PL,PD,SA,BL1,FL1,CL');
const PS_GAMES = splitList(process.env.PS_GAMES, 'lol,valorant,dota2');

/** 渠道表是否真的随函数打包了（Vercel 打包器不保证追踪动态读法） */
function loadChannelsFile() {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    new URL('../channels.json', import.meta.url),   // 项目根
    join(process.cwd(), 'channels.json'),           // cwd 兜底
    join(here, 'channels.json'),                    // 与函数同目录
  ];
  for (const p of candidates) {
    try {
      const j = JSON.parse(readFileSync(p, 'utf-8'));
      return { ok: true, entries: Object.keys(j).length, path: String(p) };
    } catch { /* 换下一个 */ }
  }
  return { ok: false, entries: 0, path: null,
           note: 'channels.json 未随函数打包，将使用函数内置兜底副本' };
}

/** 最小化探测：只发 1 个请求，用来判断 Key 有效性和上游可达性 */
async function probe(url, headers) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers });
    const txt = await res.text();
    return { ok: res.ok, status: res.status, ms: Date.now() - t0, bytes: txt.length };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: e.message };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');   // 自检结果必须实时，绝不缓存

  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const doProbe = url.searchParams.get('probe') === '1';
  const channels = loadChannelsFile();

  const payload = {
    ok: true,
    endpoint: '/api/selfcheck',
    message: '函数层正常。若本页能打开但页面仍显示演示数据，请看下面 env 与 /api/matches',
    runtime: 'vercel-serverless',
    node: process.version,
    host: req.headers.host || null,
    time: new Date().toISOString(),
    env: {
      FOOTBALL_DATA_KEY: FB_KEY ? `已配置（${FB_KEY.length} 字符）` : '❌ 缺失',
      PANDASCORE_KEY: PS_KEY ? `已配置（${PS_KEY.length} 字符）` : '❌ 缺失',
      FB_COMPETITIONS: FB_COMPETITIONS.join(','),
      PS_GAMES: PS_GAMES.join(','),
    },
    channels,
  };

  if (doProbe) {
    const [football, pandascore] = await Promise.all([
      FB_KEY
        ? probe(`https://api.football-data.org/v4/competitions/${FB_COMPETITIONS[0]}/matches`,
                { 'X-Auth-Token': FB_KEY })
        : Promise.resolve({ skipped: '缺 FOOTBALL_DATA_KEY，未探测' }),
      PS_KEY
        ? probe(`https://api.pandascore.co/${PS_GAMES[0]}/matches/upcoming?per_page=1&token=${PS_KEY}`)
        : Promise.resolve({ skipped: '缺 PANDASCORE_KEY，未探测' }),
    ]);
    payload.probe = { football, pandascore };
    payload.probe_hint = 'football: 200=Key 有效 / 403=Key 无效或过期 / 429=限流（不是 Key 的问题，稍后再试）';
  } else {
    payload.next = '在地址后加 ?probe=1 可真实探测两个上游 Key 是否有效';
  }

  res.status(200).json(payload);
}
