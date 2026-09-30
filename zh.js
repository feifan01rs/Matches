/**
 * 足球赛事中文化映射（单一数据源）
 * ------------------------------------------------------------
 * 为什么放在独立模块：
 *   server.js（本地）与 api/matches.js（Vercel）是同一套逻辑的两份实现，
 *   映射表如果各写一份，早晚会不一致 —— 所以抽到这里，两边 import。
 *
 * 覆盖三类文本：
 *   1. 联赛名   "Premier League"          → "英超"
 *   2. 赛制阶段 "League A" / "GROUP_STAGE" → "A级" / "小组赛"
 *   3. 球队名   "Bayern" / "Türkiye"       → "拜仁慕尼黑" / "土耳其"
 *
 * 两个设计要点（都踩过）：
 *   a) 球队名用**归一化索引**匹配：去掉重音符号 + 小写 + 统一全半角。
 *      否则 "Türki̇ye"（UEFA 返回体里带组合上点 U+0307）、"Málaga"、"São Paulo"
 *      这些带变音符号的名字查表必然查不到。
 *   b) 联赛名只做**开头**匹配（startsWith），且长 key 优先。
 *      否则 "Championship"（英冠）会去匹配 "UEFA Champions League"（欧冠）。
 */

// ============ 归一化：查表前统一处理 ============
// NFD 拆出组合符号后剥掉，再补几个 NFD 处理不了的字母（ø/ł/đ/ß/æ），最后去非字母数字
const SPECIAL = { 'ø': 'o', 'ł': 'l', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ı': 'i' };
export function norm(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[øłđðþßæœı]/g, c => SPECIAL[c] || c)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');   // 空格/./-/& 全部忽略，容错更强
}

// ============ 1. 联赛名 ============
// 只匹配开头，长 key 优先（见 zhLeague）
export const LEAGUE_ZH = {
  // —— 欧战 / 国际 ——
  'UEFA Champions League': '欧冠',
  'UEFA Europa League': '欧联杯',
  'UEFA Conference League': '欧协联',
  'UEFA Nations League': '欧国联',
  'UEFA European Championship': '欧洲杯',
  'FIFA World Cup': '世界杯',
  'Copa America': '美洲杯',
  'Africa Cup of Nations': '非洲杯',
  // —— 各国顶级联赛 ——
  'Campeonato Brasileiro Série A': '巴甲',
  'Campeonato Brasileiro': '巴甲',
  'Premier League': '英超',
  'Primera Division': '西甲',
  'Primera División': '西甲',
  'Championship': '英冠',
  'Bundesliga': '德甲',
  'Ligue 1': '法甲',
  'Ligue 2': '法乙',
  'Serie A': '意甲',
  'Serie B': '意乙',
  'Eredivisie': '荷甲',
  'Primeira Liga': '葡超',
  'Süper Lig': '土超',
  'Jupiler Pro League': '比甲',
  'Scottish Premiership': '苏超',
  'Saudi Pro League': '沙特联',
  'Major League Soccer': '美职联',
  'Liga MX': '墨超',
  'Liga Profesional': '阿甲',
  // —— 杯赛 ——
  'FA Cup': '足总杯',
  'League Cup': '联赛杯',
  'Copa del Rey': '国王杯',
  'DFB-Pokal': '德国杯',
  'Coupe de France': '法国杯',
  'Coppa Italia': '意大利杯',
  'Supercopa': '超级杯',
  'Super Cup': '超级杯',
};

// ============ 2. 赛制阶段 ============
export const STAGE_ZH = {
  'GROUP_STAGE': '小组赛',
  'LEAGUE_STAGE': '联赛阶段',
  'ROUND_OF_32': '1/16 决赛',
  'ROUND_OF_16': '1/8 决赛',
  'LAST_16': '1/8 决赛',
  'QUARTER_FINALS': '1/4 决赛',
  'SEMI_FINALS': '半决赛',
  'THIRD_PLACE': '三四名决赛',
  'FINAL': '决赛',
  'PLAYOFFS': '附加赛',
  'PLAYOFF': '附加赛',
  'PLAY_OFF_ROUND': '附加赛',
  'PRELIMINARY_ROUND': '预选赛',
  'QUALIFICATION': '资格赛',
  'FIRST_QUALIFYING_ROUND': '资格赛第一轮',
  'SECOND_QUALIFYING_ROUND': '资格赛第二轮',
  'THIRD_QUALIFYING_ROUND': '资格赛第三轮',
  'REGULAR_SEASON': '常规赛',
  // 欧国联分组（UEFA 返回 "League A"…"League D"）
  'League A': 'A级',
  'League B': 'B级',
  'League C': 'C级',
  'League D': 'D级',
};

// ============ 3. 球队名 ============
// 一个中文名可以挂多个英文写法（shortName / name / 常见变体）；
// 表里写反了也没关系 —— 下面会自动反向建索引，但为可读性仍按「英文: 中文」书写。
export const TEAM_ZH = {
  // ---------- 英超 ----------
  'Arsenal': '阿森纳',
  'Aston Villa': '阿斯顿维拉',
  'Bournemouth': '伯恩茅斯',
  'Brentford': '布伦特福德',
  'Brighton': '布莱顿',
  'Brighton Hove': '布莱顿',
  'Brighton & Hove Albion': '布莱顿',
  'Burnley': '伯恩利',
  'Chelsea': '切尔西',
  'Crystal Palace': '水晶宫',
  'Everton': '埃弗顿',
  'Fulham': '富勒姆',
  'Leeds United': '利兹联',
  'Liverpool': '利物浦',
  'Man City': '曼城',
  'Manchester City': '曼城',
  'Man United': '曼联',
  'Manchester United': '曼联',
  'Newcastle': '纽卡斯尔联',
  'Newcastle United': '纽卡斯尔联',
  'Nottingham': '诺丁汉森林',
  'Nottingham Forest': '诺丁汉森林',
  'Sunderland': '桑德兰',
  'Tottenham': '热刺',
  'Tottenham Hotspur': '热刺',
  'West Ham': '西汉姆联',
  'West Ham United': '西汉姆联',
  'Wolverhampton': '狼队',
  'Wolverhampton Wanderers': '狼队',

  // ---------- 英冠 / 英格兰低级别 ----------
  'Birmingham': '伯明翰',
  'Birmingham City': '伯明翰',
  'Blackburn': '布莱克本',
  'Blackburn Rovers': '布莱克本',
  'Bolton': '博尔顿',
  'Bolton Wanderers': '博尔顿',
  'Bristol City': '布里斯托尔城',
  'Cardiff': '卡迪夫城',
  'Cardiff City': '卡迪夫城',
  'Charlton': '查尔顿',
  'Charlton Athletic': '查尔顿',
  'Coventry City': '考文垂',
  'Derby County': '德比郡',
  'Hull City': '赫尔城',
  'Ipswich Town': '伊普斯维奇',
  'Leicester': '莱斯特城',
  'Leicester City': '莱斯特城',
  'Lincoln City': '林肯城',
  'Luton': '卢顿',
  'Luton Town': '卢顿',
  'Middlesbrough': '米德尔斯堡',
  'Millwall': '米尔沃尔',
  'Norwich': '诺维奇',
  'Norwich City': '诺维奇',
  'Oxford United': '牛津联',
  'Portsmouth': '朴茨茅斯',
  'Preston NE': '普雷斯顿',
  'Preston North End': '普雷斯顿',
  'QPR': '女王公园巡游者',
  'Queens Park Rangers': '女王公园巡游者',
  'Sheffield Utd': '谢菲尔德联',
  'Sheffield United': '谢菲尔德联',
  'Sheffield Wednesday': '谢周三',
  'Southampton': '南安普顿',
  'Stoke': '斯托克城',
  'Stoke City': '斯托克城',
  'Swansea': '斯旺西',
  'Swansea City': '斯旺西',
  'Watford': '沃特福德',
  'West Brom': '西布罗姆维奇',
  'West Bromwich Albion': '西布罗姆维奇',
  'Wrexham': '雷克瑟姆',
  'Huddersfield': '哈德斯菲尔德',
  'Barnsley': '巴恩斯利',
  'Blackpool': '布莱克浦',
  'Rotherham': '罗瑟勒姆',
  'Plymouth': '普利茅斯',
  'Reading': '雷丁',
  'Wigan': '维冈',
  'Peterborough': '彼得堡联',
  'Milton Keynes Dons': '米尔顿凯恩斯',
  'Wycombe': '韦康比',
  'Leyton Orient': '莱顿东方',
  'Mansfield': '曼斯菲尔德',
  'Doncaster': '唐卡斯特',
  'Burton': '伯顿',

  // ---------- 德甲 / 德乙 ----------
  'Augsburg': '奥格斯堡',
  'FC Augsburg': '奥格斯堡',
  'Bayern': '拜仁慕尼黑',
  'Bayern München': '拜仁慕尼黑',
  'Bayern Munich': '拜仁慕尼黑',
  'Bremen': '云达不来梅',
  'Werder Bremen': '云达不来梅',
  'Dortmund': '多特蒙德',
  'Borussia Dortmund': '多特蒙德',
  'Frankfurt': '法兰克福',
  'Eintracht Frankfurt': '法兰克福',
  'Freiburg': '弗赖堡',
  'SC Freiburg': '弗赖堡',
  'Hoffenheim': '霍芬海姆',
  'TSG Hoffenheim': '霍芬海姆',
  'Leverkusen': '勒沃库森',
  'Bayer Leverkusen': '勒沃库森',
  "M'gladbach": '门兴格拉德巴赫',
  'Borussia Mönchengladbach': '门兴格拉德巴赫',
  'Mainz': '美因茨',
  'Mainz 05': '美因茨',
  'RB Leipzig': '莱比锡红牛',
  'Schalke': '沙尔克04',
  'Schalke 04': '沙尔克04',
  'Stuttgart': '斯图加特',
  'VfB Stuttgart': '斯图加特',
  'Union Berlin': '柏林联合',
  '1. FC Köln': '科隆',
  'FC Köln': '科隆',
  'Köln': '科隆',
  'Heidenheim': '海登海姆',
  'St. Pauli': '圣保利',
  'Wolfsburg': '沃尔夫斯堡',
  'VfL Wolfsburg': '沃尔夫斯堡',
  'Hamburger SV': '汉堡',
  'HSV': '汉堡',
  'Hertha': '柏林赫塔',
  'Hertha BSC': '柏林赫塔',
  'Elversberg': '埃尔弗斯堡',
  'SC Paderborn': '帕德博恩',
  'Paderborn': '帕德博恩',
  'Hannover': '汉诺威96',
  'Kaiserslautern': '凯泽斯劳滕',
  'Nürnberg': '纽伦堡',
  'Karlsruhe': '卡尔斯鲁厄',
  'Düsseldorf': '杜塞尔多夫',
  'Darmstadt': '达姆施塔特',
  'Bochum': '波鸿',
  'Holstein Kiel': '荷尔斯泰因基尔',
  'Greuther Fürth': '格雷特霍夫',
  'Magdeburg': '马格德堡',
  'Braunschweig': '布伦瑞克',
  'Ulm': '乌尔姆',
  'Preußen Münster': '明斯特普鲁士',

  // ---------- 西甲 / 西乙 ----------
  'Alavés': '阿拉维斯',
  'Deportivo Alavés': '阿拉维斯',
  'Athletic': '毕尔巴鄂竞技',
  'Athletic Club': '毕尔巴鄂竞技',
  'Atleti': '马德里竞技',
  'Atlético Madrid': '马德里竞技',
  'Atlético de Madrid': '马德里竞技',
  'Barça': '巴塞罗那',
  'Barcelona': '巴塞罗那',
  'FC Barcelona': '巴塞罗那',
  'Celta': '塞尔塔',
  'Celta Vigo': '塞尔塔',
  'Deportivo': '拉科鲁尼亚',
  'Deportivo La Coruña': '拉科鲁尼亚',
  'Elche': '埃尔切',
  'Espanyol': '西班牙人',
  'Getafe': '赫塔菲',
  'Levante': '莱万特',
  'Málaga': '马拉加',
  'Osasuna': '奥萨苏纳',
  'Rayo Vallecano': '巴列卡诺',
  'Real Betis': '皇家贝蒂斯',
  'Real Madrid': '皇家马德里',
  'Real Sociedad': '皇家社会',
  'Santander': '桑坦德竞技',
  'Racing Santander': '桑坦德竞技',
  'Sevilla': '塞维利亚',
  'Sevilla FC': '塞维利亚',
  'Valencia': '瓦伦西亚',
  'Villarreal': '比利亚雷亚尔',
  'Girona': '赫罗纳',
  'Las Palmas': '拉斯帕尔马斯',
  'Almería': '阿尔梅里亚',
  'Valladolid': '巴拉多利德',
  'Cádiz': '加的斯',
  'Granada': '格拉纳达',
  'Real Zaragoza': '萨拉戈萨',
  'Sporting Gijón': '希洪竞技',
  'Eibar': '埃瓦尔',
  'Huesca': '韦斯卡',
  'Mirandés': '米兰德斯',
  'Oviedo': '奥维耶多',
  'Albacete': '阿尔瓦塞特',
  'Burgos': '布尔戈斯',
  'Castellón': '卡斯特利翁',
  'Córdoba': '科尔多瓦',
  'Racing': '桑坦德竞技',

  // ---------- 意甲 / 意乙 ----------
  'Atalanta': '亚特兰大',
  'Bologna': '博洛尼亚',
  'Cagliari': '卡利亚里',
  'Como 1907': '科莫',
  'Como': '科莫',
  'Fiorentina': '佛罗伦萨',
  'Frosinone': '弗罗西诺内',
  'Genoa': '热那亚',
  'Inter': '国际米兰',
  'Internazionale': '国际米兰',
  'Juventus': '尤文图斯',
  'Lazio': '拉齐奥',
  'Lecce': '莱切',
  'Milan': 'AC米兰',
  'AC Milan': 'AC米兰',
  'Monza': '蒙扎',
  'Napoli': '那不勒斯',
  'Parma': '帕尔马',
  'Roma': '罗马',
  'Sassuolo': '萨索洛',
  'Torino': '都灵',
  'Udinese': '乌迪内斯',
  'Venezia': '威尼斯',
  'Venezia FC': '威尼斯',
  'Empoli': '恩波利',
  'Verona': '维罗纳',
  'Pisa': '比萨',
  'Cremonese': '克雷莫纳',
  'Palermo': '巴勒莫',
  'Sampdoria': '桑普多利亚',
  'Spezia': '斯佩齐亚',
  'Bari': '巴里',
  'Reggiana': '雷贾纳',
  'Modena': '摩德纳',
  'Catanzaro': '卡坦扎罗',
  'Salernitana': '萨勒尼塔纳',
  'Frosinone Calcio': '弗罗西诺内',

  // ---------- 法甲 / 法乙 ----------
  'Angers SCO': '昂热',
  'Angers': '昂热',
  'Auxerre': '欧塞尔',
  'Brest': '布雷斯特',
  'Le Havre': '勒阿弗尔',
  'Le Mans': '勒芒',
  'Lille': '里尔',
  'Lorient': '洛里昂',
  'Marseille': '马赛',
  'Monaco': '摩纳哥',
  'Nice': '尼斯',
  'Olympique Lyon': '里昂',
  'Lyon': '里昂',
  'Paris': '巴黎圣日耳曼',
  'PSG': '巴黎圣日耳曼',
  'Paris Saint-Germain': '巴黎圣日耳曼',
  // ⚠️ 别和上面的巴黎圣日耳曼搞混：Paris FC 是另一支球队（巴黎足球俱乐部）
  'Paris FC': '巴黎FC',
  'RC Lens': '朗斯',
  'Lens': '朗斯',
  'Stade Rennais': '雷恩',
  'Rennes': '雷恩',
  'Strasbourg': '斯特拉斯堡',
  'Toulouse': '图卢兹',
  'Troyes': '特鲁瓦',
  'Nantes': '南特',
  'Montpellier': '蒙彼利埃',
  'Reims': '兰斯',
  'Saint-Étienne': '圣埃蒂安',
  'Metz': '梅斯',
  'Clermont': '克莱蒙',
  'Ajaccio': '阿雅克肖',
  'Bastia': '巴斯蒂亚',
  'Caen': '卡昂',
  'Guingamp': '甘冈',
  'Grenoble': '格勒诺布尔',
  'Laval': '拉瓦勒',
  'Red Star': '红星',
  'Rodez': '罗德兹',
  'Amiens': '亚眠',
  'Dunkerque': '敦刻尔克',
  'Pau': '波城',
  'Annecy': '阿讷西',

  // ---------- 巴甲 / 南美 ----------
  'Bahia': '巴伊亚',
  'Botafogo': '博塔弗戈',
  'Bragantino': '布拉甘蒂诺',
  'Chapecoense': '沙佩科恩斯',
  'Clube do Remo': '雷莫',
  'Corinthians': '科林蒂安',
  'Coritiba': '科里蒂巴',
  'Cruzeiro': '克鲁塞罗',
  'Flamengo': '弗拉门戈',
  'Fluminense': '弗鲁米嫩塞',
  'Grêmio': '格雷米奥',
  'Internacional': '巴西国际',
  'Mineiro': '米内罗竞技',
  'Atlético Mineiro': '米内罗竞技',
  'Mirassol': '米拉索尔',
  'Palmeiras': '帕尔梅拉斯',
  'Paranaense': '巴拉那竞技',
  'Athletico Paranaense': '巴拉那竞技',
  'Athletico': '巴拉那竞技',
  'Santos': '桑托斯',
  'São Paulo': '圣保罗',
  'Vasco da Gama': '瓦斯科达伽马',
  'Vitória': '维多利亚',
  'América Mineiro': '米内罗美洲',
  'Fortaleza': '福塔莱萨',
  'Goiás': '戈亚斯',
  'Juventude': '尤文图德',
  'Sport Recife': '累西腓体育',
  'Ceará': '塞阿拉',
  'Cuiabá': '库亚巴',
  'Atlético Goianiense': '戈亚尼亚竞技',
  'Avaí': '阿瓦伊',
  'Criciúma': '克里西乌马',
  'Ponte Preta': '蓬特普雷塔',
  'Novorizontino': '新里索廷蒂诺',
  'Amazonas': '亚马孙',
  'Volta Redonda': '沃尔塔雷东达',

  // ---------- 其他欧洲俱乐部（欧冠/欧联常见）----------
  'Fenerbahçe': '费内巴切',
  'Galatasaray': '加拉塔萨雷',
  'Beşiktaş': '贝西克塔斯',
  'Trabzonspor': '特拉布宗体育',
  'Feyenoord': '费耶诺德',
  'Ajax': '阿贾克斯',
  'PSV': '埃因霍温',
  'AZ': '阿尔克马尔',
  'Twente': '特温特',
  'Club Brugge': '布鲁日',
  'Anderlecht': '安德莱赫特',
  'Genk': '亨克',
  'Porto': '波尔图',
  'Benfica': '本菲卡',
  'Sporting CP': '里斯本竞技',
  'Braga': '布拉加',
  'Celtic': '凯尔特人',
  'Rangers': '格拉斯哥流浪者',
  'LASK': '林茨',
  'RB Salzburg': '萨尔茨堡红牛',
  'Rapid Wien': '维也纳快速',
  'Sturm Graz': '格拉茨风暴',
  'Sl. Bratislava': '布拉迪斯拉发斯洛万',
  'Slovan Bratislava': '布拉迪斯拉发斯洛万',
  'Slavia Praha': '布拉格斯拉维亚',
  'Viktoria Plzeň': '比尔森胜利',
  'Sparta Praha': '布拉格斯巴达',
  'Sabah FK': '萨巴',
  'Qarabağ': '卡拉巴赫',
  'Shaktar': '顿涅茨克矿工',
  'Shakhtar': '顿涅茨克矿工',
  'Shakhtar Donetsk': '顿涅茨克矿工',
  'Dynamo Kyiv': '基辅迪纳摩',
  'Viking': '维京',
  'Bodø/Glimt': '博多闪耀',
  'Molde': '莫尔德',
  'Rosenborg': '罗森博格',
  'Malmö': '马尔默',
  'Copenhagen': '哥本哈根',
  'Midtjylland': '中日德兰',
  'Young Boys': '伯尔尼年轻人',
  'Basel': '巴塞尔',
  'Zürich': '苏黎世',
  'Red Star Belgrade': '贝尔格莱德红星',
  'Partizan': '贝尔格莱德游击',
  'Legia Warsaw': '华沙军团',
  'Lech Poznań': '波兹南莱赫',
  'Maccabi Tel Aviv': '特拉维夫马卡比',
  'Olimpija': '卢布尔雅那奥林匹亚',
  'PAE AEK': '雅典AEK',
  'AEK': '雅典AEK',
  'Olympiacos': '奥林匹亚科斯',
  'Panathinaikos': '帕纳辛奈科斯',
  'APOEL': '阿普尔',
  'Ferencváros': '费伦茨瓦罗斯',
  'Sheriff': '蒂拉斯波尔谢里夫',

  // ---------- 欧洲国家队（欧国联 54 队）----------
  'Albania': '阿尔巴尼亚',
  'Andorra': '安道尔',
  'Armenia': '亚美尼亚',
  'Austria': '奥地利',
  'Azerbaijan': '阿塞拜疆',
  'Belarus': '白俄罗斯',
  'Belgium': '比利时',
  'Bosnia and Herzegovina': '波黑',
  'Bulgaria': '保加利亚',
  'Croatia': '克罗地亚',
  'Cyprus': '塞浦路斯',
  'Czechia': '捷克',
  'Czech Republic': '捷克',
  'Denmark': '丹麦',
  'England': '英格兰',
  'Estonia': '爱沙尼亚',
  'Faroe Islands': '法罗群岛',
  'Finland': '芬兰',
  'France': '法国',
  'Georgia': '格鲁吉亚',
  'Germany': '德国',
  'Gibraltar': '直布罗陀',
  'Greece': '希腊',
  'Hungary': '匈牙利',
  'Iceland': '冰岛',
  'Israel': '以色列',
  'Italy': '意大利',
  'Kazakhstan': '哈萨克斯坦',
  'Kosovo': '科索沃',
  'Latvia': '拉脱维亚',
  'Liechtenstein': '列支敦士登',
  'Lithuania': '立陶宛',
  'Luxembourg': '卢森堡',
  'Malta': '马耳他',
  'Moldova': '摩尔多瓦',
  'Montenegro': '黑山',
  'Netherlands': '荷兰',
  'North Macedonia': '北马其顿',
  'Northern Ireland': '北爱尔兰',
  'Norway': '挪威',
  'Poland': '波兰',
  'Portugal': '葡萄牙',
  'Republic of Ireland': '爱尔兰',
  'Ireland': '爱尔兰',
  'Romania': '罗马尼亚',
  'San Marino': '圣马力诺',
  'Scotland': '苏格兰',
  'Serbia': '塞尔维亚',
  'Slovakia': '斯洛伐克',
  'Slovenia': '斯洛文尼亚',
  'Spain': '西班牙',
  'Sweden': '瑞典',
  'Switzerland': '瑞士',
  'Türkiye': '土耳其',
  'Türki̇ye': '土耳其',
  'Turkey': '土耳其',
  'Ukraine': '乌克兰',
  'Wales': '威尔士',
};

// ============ 索引（模块加载时构建一次）============
const TEAM_IDX = new Map();
for (const [en, cn] of Object.entries(TEAM_ZH)) {
  const k = norm(en);
  if (k && !TEAM_IDX.has(k)) TEAM_IDX.set(k, cn);
}
// 联赛 key 按长度降序，保证 "UEFA Champions League" 先于 "Serie A" 之类被尝试
const LEAGUE_KEYS = Object.keys(LEAGUE_ZH).map(k => [k, norm(k)]).sort((a, b) => b[1].length - a[1].length);
const STAGE_IDX = new Map(Object.entries(STAGE_ZH).map(([k, v]) => [norm(k), v]));

// ============ 对外接口 ============

/** 球队名 → 中文；未收录时返回 ''（由调用方决定兜底策略） */
export function zhTeam(name) {
  if (!name) return '';
  return TEAM_IDX.get(norm(name)) || '';
}

/** 去掉队尾的俱乐部后缀词（FC / CF / AC / SC / SV / Calcio …）
 *  ⚠️ 后缀前必须要求分隔符：否则 "HSV" 会被砍成 "H"、"PSV" 砍成 "P"
 *     （football-data 的 shortName 里 HSV / PSV 是常见写法，这个坑真的踩过）*/
export function stripSuffix(name) {
  const s = String(name || '');
  return s.replace(/(?:^|\s)(FC|CF|AC|SC|BC|SV|AFC|CFC|Club|Calcio|de|the)$/i, '').trim() || s;
}

/** 从 football-data 的 team 对象取中文名（推荐入口）
 *  依次尝试：shortName → name → 去后缀的 shortName → 去后缀的 name
 *  ⚠️ 顺序不能颠倒：必须精确匹配优先。像 "Paris FC"（巴黎足球俱乐部）与
 *     "Paris"（巴黎圣日耳曼）是两支不同球队，先查全名才不会张冠李戴。
 *  全部落空时返回缩短后的英文原名，保证调用方永远拿到非空字符串。*/
export function zhTeamDeep(t) {
  const shortName = t?.shortName || '';
  const fullName = t?.name || '';
  for (const c of [shortName, fullName, stripSuffix(shortName), stripSuffix(fullName)]) {
    const hit = zhTeam(c);
    if (hit) return hit;
  }
  return stripSuffix(shortName || fullName) || shortName || fullName || '';
}

/** 赛制阶段 → 中文；未收录时返回 '' */
export function zhStage(name) {
  if (!name) return '';
  return STAGE_IDX.get(norm(name)) || '';
}

/** 联赛全名 → 中文。如 "Premier League" → "英超"、"UEFA Champions League" → "欧冠"
 *  未收录的联赛原样返回（不猜，避免误译）。 */
export function zhLeague(name) {
  const s = String(name || '').trim();
  if (!s) return s;
  // 以中文**开头**的联赛（如「欧国联」）不猜英文表 —— norm() 会把中文整段剥掉，
  // 剩下 "leaguea" 之类去和英文 key 比对纯属自找麻烦。
  // ⚠️ 只判断开头：不能整串判断，因为「Bundesliga · 第 5 轮」里也有中文（第/轮），
  //    整串判断会让所有联赛名都被当成「已是中文」而漏翻。
  if (/^[\u3400-\u9fff]/.test(s)) {
    // 中英混排时至少把尾巴的阶段名换掉：「欧国联 · League A」→「欧国联 · A级」
    return s.replace(/([·\u00b7]\s*)([A-Za-z][A-Za-z _]*)\s*$/, (m, sep, tail) => sep + (zhStage(tail) || tail));
  }
  const n = norm(s);
  for (const [en, cnKey] of LEAGUE_KEYS) {
    if (n.startsWith(cnKey)) return LEAGUE_ZH[en] + s.slice(en.length);
  }
  return s;
}

/** 转换一条足球比赛的 league / home / away 三个字段（原地不修改，返回新对象）
 *  @param {{league?:string, home?:string, away?:string, homeEN?:string, awayEN?:string}} m
 */
export function toChinese(m) {
  const out = { ...m };
  if (typeof m.league === 'string' && m.league) out.league = zhLeague(m.league);
  if (typeof m.home === 'string' && m.home) out.home = zhTeam(m.home) || m.home;
  if (typeof m.away === 'string' && m.away) out.away = zhTeam(m.away) || m.away;
  return out;
}
