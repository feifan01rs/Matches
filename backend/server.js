/**
 * 后端入口：一个小程序，同时做三件事
 *   1. 定时去外部网站抓比赛，写进 SQLite 数据库（backend/data.db）
 *   2. 提供数据接口（/api/matches 等），让前端来取
 *   3. 把前端页面（frontend/index.html）发给浏览器
 *
 * 启动：node backend/server.js   （默认 http://localhost:8787）
 */
import './env.js';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';

import {
  replaceSource, getUpcoming, getResults, getCounts, lastUpdated, dbPath,
  listFollows, setFollow,
} from './db.js';
import { fetchAll } from './fetch.js';

const here = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = join(here, '..', 'frontend');
const PORT = Number(process.env.PORT || 8787);
// 抓取间隔（分钟）：想让数据更新更勤/更省额度，改这个数字就行
const FETCH_INTERVAL_MINUTES = Number(process.env.FETCH_INTERVAL_MINUTES || 10);
// 版本号：前端会显示它，用来确认「跑的是哪一版」
const BUILD = 'local-sqlite-1';

const MISSING_KEYS = [];
if (!process.env.FOOTBALL_DATA_KEY) MISSING_KEYS.push('FOOTBALL_DATA_KEY');
if (!process.env.PANDASCORE_KEY) MISSING_KEYS.push('PANDASCORE_KEY');

/* ================= 定时抓取 ================= */

let fetching = false;

async function doFetch(reason = '手动') {
  if (fetching) {
    console.log('[抓取] 上一次还没跑完，本次跳过');
    return;
  }
  fetching = true;
  const t0 = Date.now();
  try {
    const result = await fetchAll();
    for (const src of ['football', 'pandascore', 'bwf']) {
      if (!result.ok[src]) {
        console.log(`[抓取] ${src} 这次没成功，保留数据库里的旧数据`);
        continue;
      }
      const { upcoming, results } = result.sources[src];
      replaceSource(src, upcoming, results);
      console.log(`[抓取] ${src}: 赛程 ${upcoming.length} 场，赛果 ${results.length} 场`);
    }
    console.log(`[抓取] 完成（${reason}），用时 ${Date.now() - t0}ms`);
  } catch (e) {
    console.error('[抓取] 出错：', e.message);
  } finally {
    fetching = false;
  }
}

/* ================= 接口处理 ================= */

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

function handleMatches(res) {
  const counts = getCounts();
  sendJson(res, 200, {
    updatedAt: lastUpdated() || new Date().toISOString(),
    build: BUILD,
    sources: {
      football: counts.football,
      esports: counts.esports,
      results: counts.results,
      missing_keys: MISSING_KEYS,
    },
    matches: getUpcoming(),
    results: getResults(),
  });
}

function handleSelfcheck(res) {
  sendJson(res, 200, {
    ok: true,
    endpoint: '/api/selfcheck',
    build: BUILD,
    message: '后端在运行。若页面显示演示数据，多半是还没配 .env 里的 Key，或还没抓到数据。',
    time: new Date().toISOString(),
    node: process.version,
    db: dbPath,
    counts: getCounts(),
    last_updated: lastUpdated(),
    missing_keys: MISSING_KEYS,
  });
}

/** 把 POST 请求体里发来的 JSON 读出来（前端保存提醒时用） */
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf-8')); }
  catch { return {}; }
}

/* ================= 静态文件（前端页面） ================= */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function serveFrontend(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = normalize(join(FRONTEND_DIR, pathname));

  // 防止用 ../ 跳出 frontend 目录
  if (!filePath.startsWith(FRONTEND_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
  res.end(readFileSync(filePath));
}

/* ================= 启动 ================= */

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  try {
    if (pathname === '/api/matches') return handleMatches(res);
    if (pathname === '/api/selfcheck') return handleSelfcheck(res);
    if (pathname === '/api/follows' && req.method === 'GET') {
      return sendJson(res, 200, { follows: listFollows() });
    }
    if (pathname === '/api/follows' && req.method === 'POST') {
      const body = await readJsonBody(req);
      setFollow(String(body.matchId || ''), !!body.reminded);
      return sendJson(res, 200, { ok: true, follows: listFollows() });
    }
    return serveFrontend(req, res);
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n海风看球 · 后端已启动`);
  console.log(`  页面：   http://localhost:${PORT}/`);
  console.log(`  数据：   http://localhost:${PORT}/api/matches`);
  console.log(`  自检：   http://localhost:${PORT}/api/selfcheck`);
  console.log(`  数据库： ${dbPath}`);
  if (MISSING_KEYS.length) {
    console.log(`\n注意：还没配置 ${MISSING_KEYS.join(', ')}（写在 backend/.env 里），暂时抓不到对应数据。`);
  }
  console.log('');

  doFetch('启动时');                                  // 启动就先抓一次
  setInterval(() => doFetch('定时'), FETCH_INTERVAL_MINUTES * 60 * 1000);
});
