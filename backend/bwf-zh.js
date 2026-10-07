/**
 * 羽毛球的中文化对照表 —— 只做两类：赛事名、赛事级别。
 *
 * 为什么只做这两类：
 *   赛事名和级别是「有限的清单」，整理一次就长期有效；
 *   选手名没有标准中文译名（上游给的是罗马拼音，如 CHI Yu Jen），
 *   机器翻译必错，所以选手名保留原文。
 *
 * 赛事名的匹配规则：**包含**匹配、不区分大小写、长 key 优先。
 *   这样上游带什么赞助商前缀都能命中，例如
 *   "CLASH OF CLANS Arctic Open 2026 powered by YONEX" → 命中 "Arctic Open"。
 *
 * 想加新赛事：在 BWF_TOUR_ZH 里加一行就行（key 是英文片段，value 是中文）。
 */

// ---------- 1. 赛事名 ----------
export const BWF_TOUR_ZH = {
  // —— 世界巡回赛（高级别，常看的那批）——
  'All England': '全英公开赛',
  'China Open': '中国公开赛',
  'China Masters': '中国大师赛',
  'Indonesia Open': '印尼公开赛',
  'Kudus Indonesia Masters': '印尼大师赛（库杜斯）',
  'Indonesia Masters': '印尼大师赛',
  'Malaysia Open': '马来西亚公开赛',
  'Malaysia Masters': '马来西亚大师赛',
  'Malaysia Super 100': '马来西亚 Super 100',
  'Japan Open': '日本公开赛',
  'Japan Masters': '日本大师赛',
  'Korea Open': '韩国公开赛',
  'Korea Masters': '韩国大师赛',
  'Singapore Open': '新加坡公开赛',
  'Thailand Open': '泰国公开赛',
  'Thailand Masters': '泰国大师赛',
  'India Open': '印度公开赛',
  'Australian Open': '澳大利亚公开赛',
  'Hong Kong Open': '香港公开赛',
  'Macau Open': '澳门公开赛',
  'Chinese Taipei Open': '中国台北公开赛',
  'Vietnam Open': '越南公开赛',
  'Denmark Open': '丹麦公开赛',
  'French Open': '法国公开赛',
  'Arctic Open': '北极公开赛',
  'Dutch Open': '荷兰公开赛',
  'German Open': '德国公开赛',
  'Swiss Open': '瑞士公开赛',
  'Spain Masters': '西班牙大师赛',
  'Orleans Masters': '奥尔良大师赛',
  'Czech Open': '捷克公开赛',
  'Scottish Open': '苏格兰公开赛',
  'Irish Open': '爱尔兰公开赛',
  'Polish Open': '波兰公开赛',
  'US Open': '美国公开赛',
  'Canada Open': '加拿大公开赛',
  'New Zealand Open': '新西兰公开赛',
  'Brazil Open': '巴西公开赛',
  'Santo Domingo Open': '圣多明各公开赛',

  // —— 综合运动会 / 大赛 ——
  'Asian Para Games': '亚残运会',
  'ASIAN Para Games': '亚残运会',
  'Para Games': '亚残运会',
  'Asian Games': '亚运会',
  'Olympic Games': '奥运会',
  'Commonwealth Games': '英联邦运动会',
  'World Tour Finals': '世界巡回赛总决赛',
  'World Junior Team Championships': '世界青年团体锦标赛',
  'World Junior Championships': '世界青年锦标赛',
  'World Championships': '世界锦标赛',
  'Thomas Cup': '汤姆斯杯',
  'Uber Cup': '尤伯杯',
  'Sudirman Cup': '苏迪曼杯',
  'European Senior Championships': '欧洲元老锦标赛',
  'European Championships': '欧洲锦标赛',
  'Asian Championships': '亚洲锦标赛',
  'Pan Am Championships': '泛美锦标赛',

  // —— 国际挑战赛 / 国际系列赛 / 其它（多半是低级别）——
  'Guatemala International Challenge': '危地马拉国际挑战赛',
  'Peru International Challenge': '秘鲁国际挑战赛',
  'Türkiye International Challenge': '土耳其国际挑战赛',
  'Surabaya International Challenge': '泗水国际挑战赛',
  'Arise International Challenge': 'Arise 国际挑战赛',
  'Uganda International Series': '乌干达国际系列赛',
  'Venezuela International Series': '委内瑞拉国际系列赛',
  'Iran International Future Series': '伊朗国际未来系列赛',
  'Bulgarian International Championship': '保加利亚国际锦标赛',
  'Croatian International': '克罗地亚国际赛',
  'Kampala International': '坎帕拉国际赛',
  'Bendigo International': '本迪戈国际赛',
  'North Harbour International': '北港国际赛',
  'Sydney International': '悉尼国际赛',
  'Hellas International': '希腊国际赛',
  'Abu Dhabi Masters': '阿布扎比大师赛',
  'Senegal Junior International': '塞内加尔青年国际赛',
  'Slovak Youth U17 International': '斯洛伐克 U17 青年国际赛',
  'All Africa Junior Championships': '非洲青年锦标赛',
  'Copa Regatas Junior International': '雷加塔斯杯青年国际赛',
  'German Ruhr U19 International': '德国鲁尔 U19 国际赛',
  'German Ruhr U17 International': '德国鲁尔 U17 国际赛',
  'Denmark Junior U17': '丹麦青年 U17',
  'DENMARK Junior': '丹麦青年赛',
  'Denmark Junior': '丹麦青年赛',
  'Luxembourg U17': '卢森堡 U17',
  'Finnish U17 Open': '芬兰 U17 公开赛',
};

// 按 key 长度从长到短排一次，保证「长名字优先」
// （否则 "Kudus Indonesia Masters" 会被更短的 "Indonesia Masters" 抢走）
const TOUR_KEYS = Object.keys(BWF_TOUR_ZH)
  .map((k) => [k.toLowerCase(), k])
  .sort((a, b) => b[0].length - a[0].length);

/** 赛事名 → 中文；没收录的原样返回（不猜，避免翻错） */
export function zhBwfTour(name) {
  const s = String(name || '').trim();
  if (!s) return s;
  const lower = s.toLowerCase();
  for (const [k, orig] of TOUR_KEYS) {
    if (lower.includes(k)) return BWF_TOUR_ZH[orig];
  }
  return s;
}

// ---------- 2. 赛事级别 ----------
export const BWF_CAT_ZH = {
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
  'Continental Junior Individual Championships': '洲际青年单项锦标赛',
  'Continental Junior Team Championships': '洲际青年团体锦标赛',
  'Para Badminton Continental Multi-Sport Games': '残羽 · 洲际综合运动会',
  'AirBadminton Team': '户外羽毛球 · 团体',
};

/** 赛事级别 → 中文；没收录的原样返回 */
export function zhBwfCat(cat) {
  const s = String(cat || '').trim();
  if (!s) return '世界羽联巡回赛';
  return BWF_CAT_ZH[s] || s;
}
