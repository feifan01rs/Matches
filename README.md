# 海风看球 · 观赛预告

一个自己用的观赛信息页：把 **足球 / 电竞 / 羽毛球** 的赛程预告、赛果回顾、观赛渠道
聚合在一处，时间按你本地时区显示。

- **前端**：一个 HTML 页面（`frontend/index.html`），纯静态、无框架
- **后端**：一个常驻的 Node 小程序（`backend/`），定时去外部抓数据、存进 SQLite
- **数据库**：就是 `backend/data.db` 一个文件，由后端读写

## 结构

```
Matches/
├─ frontend/
│   └─ index.html       ← 前端：页面和交互（日期条 / 筛选 / 防剧透 / 提醒）
├─ backend/
│   ├─ server.js        ← 启动入口：发页面 + 提供接口 + 定时抓取
│   ├─ fetch.js         ← 抓足球、电竞
│   ├─ bwf.js           ← 抓羽毛球（BWF 官方站内接口）
│   ├─ bwf-zh.js        ← 羽毛球「赛事名 / 赛事级别」中文对照表
│   ├─ zh.js            ← 足球「联赛 / 球队」中文对照表
│   ├─ channels.json    ← 观赛渠道映射（平台名 + 网址）
│   ├─ db.js            ← 读写 SQLite
│   ├─ env.js           ← 读取 backend/.env
│   ├─ package.json     ← 只声明 type: module，没有任何第三方依赖
│   ├─ .env.example     ← 配置模板
│   └─ data.db          ← 数据库文件（第一次运行时自动生成，不进版本库）
├─ README.md
└─ .gitignore
```

## 怎么跑起来

1. 配数据源的 Key：把 `backend/.env.example` 复制成 `backend/.env`，填上
   `FOOTBALL_DATA_KEY` 和 `PANDASCORE_KEY`。（不填也能启动，只是足球 / 电竞没数据）

2. 启动后端（在项目根目录）：

   ```
   node backend/server.js
   ```

   或者进 `backend/` 目录后 `npm start`（等价）。

3. 打开浏览器访问 http://localhost:8787/

后端启动时先抓一次，之后每隔 10 分钟抓一次，结果写进 `backend/data.db`。
**前端只从后端读数据，不直接访问外部网站。**

## 数据从哪来

| 项目 | 来源 | 要不要注册 | 备注 |
| --- | --- | --- | --- |
| ⚽ 足球 | football-data.org | 要（免费 Key） | 免费版限流很严，只配了 6 个联赛 |
| 🎮 电竞 | PandaScore | 要（免费 Key） | lol / valorant / dota2 |
| 🏸 羽毛球 | BWF 官网站内接口 | **不用** | 需要系统里有 `curl`（见下） |

## 数据流

```
浏览器 ──▶ 后端 /api/matches ──▶ SQLite 数据库
              ▲
              └── 每 10 分钟去外部网站抓一次
```

## 后端接口

| 接口 | 作用 |
| --- | --- |
| `GET /api/matches` | 取赛程 + 赛果（前端首页用） |
| `GET /api/follows` | 取「我的提醒」 |
| `POST /api/follows` | 保存某场的提醒状态，body：`{ "matchId": "…", "reminded": true }` |
| `GET /api/selfcheck` | 自检：后端是否正常、各来源抓到多少数据 |

## 几个「看着奇怪、其实正常」的地方

- **羽毛球未来几天只有「赛事卡」**：BWF 是**逐日发布**赛程的，未来的具体对阵要等那天才出现。
  所以后端会给每个赛事、在它举行的每一天放一张赛事卡（只写赛事名 / 级别 / 地点）；
  哪天有了真实对阵，那天的卡会自动换成真实场次。
- **羽毛球场次时间显示「待定」**：上游给的是「场馆当地时间」且不带时区，直接换算会错，
  所以只保证日期，具体时刻放在点开的弹窗里说明。
- **页面每天最多显示 10 场羽毛球**：一项赛事一天动辄上百场，全列会把页面撑爆。
  想改就调 `frontend/index.html` 里的 `BADMINTON_PER_DAY`。
- **「去观赛」跳的是平台首页**：各家没有公开的「某场比赛直播间」直达链接，只能跳到平台自己找。
  网址都集中在 `backend/channels.json` 的 `_platforms` 里。

## 常见位置（想改东西先看这里）

| 想改什么 | 去哪个文件 |
| --- | --- |
| 抓取间隔 / 端口 | `backend/.env`（`FETCH_INTERVAL_MINUTES`、`PORT`） |
| 抓哪些联赛 / 游戏 | `backend/fetch.js` 顶部常量 |
| 足球中文名 | `backend/zh.js` |
| 羽毛球赛事中文名 | `backend/bwf-zh.js` |
| 观赛渠道 / 平台网址 | `backend/channels.json` |
| 每天显示多少场羽毛球 | `frontend/index.html` 的 `BADMINTON_PER_DAY` |
| 页面样式 / 交互 | `frontend/index.html` |

## 说明

- **Node 版本**：需要 23.4 以上（用了 Node 自带的 `node:sqlite`）。开发环境是 Node 24。
- **端口**：默认 8787；如果环境变量里设了 `PORT`，以 `PORT` 为准（部署到平台时会用到）。
- **零依赖**：不需要 `npm install`，直接 `node backend/server.js` 就能跑。
