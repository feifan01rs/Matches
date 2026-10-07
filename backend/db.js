/**
 * 数据库这一层：只负责「往硬盘上的一个文件里存东西、取东西」。
 *
 * 用 Node 自带的 SQLite（node:sqlite）——不用装任何第三方库。
 * 数据库就是本文件同目录下的 data.db，一个普通文件，能直接看到、备份、删除。
 *
 * 两张表（表 = 数据库里的一张清单）：
 *   matches —— 所有比赛（赛程和赛果都放这里，用 kind 区分）
 *   follows —— 你自己的操作（关注了哪场、有没有设提醒）
 */
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(here, 'data.db');

export const dbPath = DB_PATH;
export const db = new DatabaseSync(DB_PATH);

// IF NOT EXISTS：重复启动不会报错，也不会把已有数据冲掉
db.exec(`
  CREATE TABLE IF NOT EXISTS matches (
    id         TEXT PRIMARY KEY,
    source     TEXT,     -- 来自哪个数据源：football / pandascore
    kind       TEXT,     -- 'upcoming'(赛程) 或 'result'(赛果)
    sport      TEXT,     -- football / esports / badminton
    game       TEXT,     -- 电竞子项目 lol / valorant / dota2
    league     TEXT,
    home       TEXT,
    away       TEXT,
    utc_date   TEXT,
    status     TEXT,
    score      TEXT,
    channels   TEXT,     -- 观赛渠道，存成 JSON 文本
    bo         TEXT,
    is_top     INTEGER DEFAULT 0,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS follows (
    match_id   TEXT PRIMARY KEY,
    reminded   INTEGER DEFAULT 0,
    created_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_matches_kind ON matches(kind);
`);

/** 把一条比赛整理成数据库里的 15 个字段（顺序要和下面的 INSERT 一致） */
function toRow(m, source, kind, updatedAt) {
  return [
    m.id,
    source,
    kind,
    m.sport ?? null,
    m.game ?? null,
    m.league ?? null,
    m.home ?? null,
    m.away ?? null,
    m.utcDate ?? null,
    m.status ?? null,
    m.score ?? null,
    JSON.stringify(m.channels ?? []),
    m.bo ?? null,
    m.top ? 1 : 0,
    updatedAt,
  ];
}

/** 把数据库里的一行变回前端需要的比赛对象 */
function fromRow(r) {
  let channels = [];
  try { channels = JSON.parse(r.channels || '[]'); } catch { channels = []; }
  return {
    id: r.id,
    sport: r.sport,
    game: r.game,
    league: r.league,
    home: r.home,
    away: r.away,
    utcDate: r.utc_date,
    status: r.status,
    score: r.score,
    channels,
    bo: r.bo,
    top: r.is_top || 0,
  };
}

/**
 * 用一个数据源的最新结果，整体替换掉这个源在库里的旧数据。
 *
 * 为什么整源替换：某个源这次抓失败了（限流/断网）时，调用方会直接跳过，
 * 这样旧数据还在；抓到新的就整批换新，不用一条条比对。
 * 用事务包起来：要么全换成功，要么一条都不动。
 */
export function replaceSource(source, upcoming, results) {
  const del = db.prepare('DELETE FROM matches WHERE source = ?');
  const ins = db.prepare(`
    INSERT OR REPLACE INTO matches
      (id, source, kind, sport, game, league, home, away, utc_date,
       status, score, channels, bo, is_top, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const updatedAt = new Date().toISOString();

  db.exec('BEGIN');
  try {
    del.run(source);
    for (const m of upcoming) ins.run(...toRow(m, source, 'upcoming', updatedAt));
    for (const m of results) ins.run(...toRow(m, source, 'result', updatedAt));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 取赛程（还没结束的比赛），按开赛时间从早到晚 */
export function getUpcoming() {
  return db.prepare(
    `SELECT * FROM matches WHERE kind = 'upcoming' ORDER BY utc_date ASC`
  ).all().map(fromRow);
}

/** 取赛果（已结束的比赛），按结束时间从新到旧 */
export function getResults(limit = 420) {
  return db.prepare(
    `SELECT * FROM matches WHERE kind = 'result' ORDER BY utc_date DESC LIMIT ?`
  ).all(limit).map(fromRow);
}

/** 各类数量，给 /api/matches 和自检用 */
export function getCounts() {
  const one = (sql) => db.prepare(sql).get()?.n || 0;
  return {
    football: one(`SELECT COUNT(*) AS n FROM matches WHERE kind='upcoming' AND source='football'`),
    esports: one(`SELECT COUNT(*) AS n FROM matches WHERE kind='upcoming' AND source='pandascore'`),
    results: one(`SELECT COUNT(*) AS n FROM matches WHERE kind='result'`),
    total: one(`SELECT COUNT(*) AS n FROM matches`),
  };
}

/** 上一次成功写入数据库的时间 */
export function lastUpdated() {
  return db.prepare(`SELECT MAX(updated_at) AS t FROM matches`).get()?.t || null;
}

/** 我标记过的比赛（关注 / 提醒） */
export function listFollows() {
  return db.prepare(`SELECT match_id, reminded, created_at FROM follows`).all()
    .map(r => ({ matchId: r.match_id, reminded: !!r.reminded, createdAt: r.created_at }));
}

/** 打开 / 关闭某场比赛的提醒：打开 = 写一行，关闭 = 删掉这行 */
export function setFollow(matchId, reminded) {
  if (!matchId) return;
  if (reminded) {
    db.prepare(`INSERT OR REPLACE INTO follows (match_id, reminded, created_at) VALUES (?, 1, ?)`)
      .run(matchId, new Date().toISOString());
  } else {
    db.prepare(`DELETE FROM follows WHERE match_id = ?`).run(matchId);
  }
}
