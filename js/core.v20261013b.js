/* ==========================================================================
   晚修值班费统计 — 核心逻辑（网页版 / 小程序版共用）
   数据全部存在本地，不上传任何服务器
   ========================================================================== */


const LS_KEY = 'wxduty.v1';

/* ---------- 内置默认排班表（来自 晚修值班.xlsx → Sheet「第三版(2)」）---------- */
const DEFAULT_DATA = {
  meta: {
    termName: '2026-2027 学年',
    /* 单双周起点（用于选排班模板）—— 一旦排班表定好就别改，改了单双周会全乱 */
    firstMonday: '2026-09-07',

    /* 周次起点（用于显示"第几周"）——
       开学报到那一周也算第 1 周，所以比单双周起点早一周。 */
    termWeek1Monday: '2026-08-31',

    /* 变更痕迹：最近 30 条改动，主页面显示"最近改了什么"
       { ts, post, date, what } */
    changeLog: [],

    /* 调休补课映射：{ 实际日期: 沿用哪一天的排班 }
       场景：10月10日(周六)调休上班 → 10月8日(周四)、10月9日(周五) 要上上周的课。
             学校把上周三的排班挪到本周五，就写 '2026-10-09': '2026-09-23'
       只借用「星期几」，单双周仍按实际日期算。
       不在表里的日期照常用自己那天的排班。 */
    scheduleMap: {
      '2026-10-08': '2026-09-24',
      '2026-10-09': '2026-09-23',
    },
    classes: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],
    defaultTemplate: 'T-S1',   // Sheet2 组：按单双周自动切 T-S1 / T-S2

    // 晚修分段。每段可由不同老师值班，单价独立
    segments: [
      { key:'s1', label:'晚修一段', short:'一段', time:'18:40~21:15', rate:15, on:true },
      { key:'s2', label:'晚修二段', short:'二段', time:'21:20~22:00', rate:15, on:true },
      { key:'s3', label:'晚修三段', short:'三段', time:'21:05~22:00', rate:15, on:false }
    ]
  },

  /* ⚠️【测试站专用改动】原为真实教师姓名，测试站一律替换为虚构占位名，
     避免公开测试地址泄露真实人员信息。正式部署时请还原真实名单。 */
  teachers: [
    '测试甲','测试乙','测试丙','测试丁','测试戊','测试己','测试庚','测试辛','测试壬','测试癸',
    '示例一','示例二','示例三','示例四','示例五','示例六','示例七','示例八','示例九','示例十',
    '占位一','占位二','占位三','占位四','占位五','占位六','占位七','占位八','占位九','占位十',
    '演示一','演示二','演示三','演示四','演示五','演示六','演示七','演示八','演示九','演示十',
    '样例一','样例二','样例三','样例四','样例五','样例六','样例七'
  ],

  // 宿管名单：晚修代班时费用记给宿管
  /* ⚠️【测试站专用改动】同上，替换为虚构占位名。 */
  dormStaff: ['宿管一','宿管二','宿管三','宿管四','宿管五','宿管六','宿管七','宿管八','宿管九','宿管十'],

  // 行政人员名单：可担任行政值班、校医等岗位（不参与晚修排班的老师）
  adminStaff: [],

  /* ============================================================
     七个值班栏目。每个栏目独立统计、独立导出。
     kind:
       'grid'  晚修 —— 矩阵排班（行=星期 列=班级），支持分段
       'roster' 名单制 —— 按"日期+老师+次数"登记，可从图片/Excel 识别
     ============================================================ */
  posts: {
    evening: {
      key:'evening', name:'教师晚修', short:'晚修',
      kind:'grid', icon:'📖', desc:'按班级排班，可分段由不同老师值班',
      rate:15, seg: true
    },
    admin: {
      key:'admin', name:'行政值班', short:'行政',
      kind:'roster', icon:'🏛', desc:'行政人员值班，一律按一段计',
      rate:25, seg: false, needPhoto: true
    },
    clinic: {
      key:'clinic', name:'校医', short:'校医',
      kind:'roster', icon:'⚕️', desc:'校医值班，可传截图识别',
      rate:20, seg: false, needPhoto: true
    },
    aide: {
      key:'aide', name:'教辅', short:'教辅',
      kind:'roster', icon:'🔬', desc:'教辅人员值班，可从 Excel 识别',
      rate:20, seg: false, needFile: true
    },
    noon: {
      key:'noon', name:'午休', short:'午休',
      kind:'roster', icon:'☀️', desc:'午休值班',
      rate:12, seg: false
    },
    overtime: {
      key:'overtime', name:'额外加班', short:'加班',
      kind:'roster', icon:'🌙', desc:'晚修之外的额外加班',
      rate:30, seg: false
    },
    weekend: {
      key:'weekend', name:'周末值班', short:'周末',
      kind:'roster', icon:'🏠',
      desc:'放假前一天的宿管值班，来值班的教师（通常两三位）。按一段 / 二段分别记次数',
      bySeg: true, isDutyOn: true, rate: 15, segRates: { s1: 15, s2: 15 }
    }
  },

  /* 名单制栏目的记录
     roster[postKey][date] = [{ id, teacher, times, note }]
     times = 该天值班次数（一段计1次）
  */
  roster: {
    admin:   {}, clinic: {}, aide: {}, noon: {}, overtime: {}, weekend: {}
  },

  // 岗位与单价：单价单位为「元/次」
  duties: {
    '行政值班': { rate: 25, sections: 1, color: '#d97706', desc: '行政值班' },
    '校医':    { rate: 20, sections: 1, color: '#dc2626', desc: '校医值班' },
    '午休':    { rate: 12, sections: 1, color: '#059669', desc: '午休值班' },
    '其他':    { rate: 0,  sections: 1, color: '#6b7280', desc: '临时性事务' }
  },

  /* 排班模板
     templateId: {
       label: '显示名',
       mode: 'all' | 'single' | 'double',
       // grid[星期(1=周一..7=周日)][班级] = 老师姓名
       //   支持两种写法：
       //     "张三"        → 表示该班所有分段都是张三（兼容旧表）
       //     ["张三","李四"] → 表示一段张三、二段李四
       grid: {...}
     }
  */
  templates: {
    'T-A': {
      label: '第三版(2)　不分单双周',
      mode: 'all',
      source: '晚修值班.xlsx → 第三版(2)',
      grid: {
        1: {1:'师06',2:'师22',3:'师04',4:'师05',5:'师18',6:'师37',7:'师38',8:'师27',9:'师32',10:'师41',11:'师35',12:'师23',13:'师24',14:'师07',15:'师28'},
        2: {1:'师32',2:'师17',3:'师30',4:'师36',5:'师46',6:'师43',7:'师13',8:'师33',9:'师01',10:'师16',11:'师21',12:'师42',13:'师03',14:'师15',15:'师29'},
        3: {1:'师09',2:'师05',3:'师31',4:'师47',5:'师23',6:'师38',7:'师24',8:'师37',9:'师18',10:'师28',11:'师45',12:'师27',13:'师12',14:'师07',15:'师03'},
        4: {1:'师06',2:'师17',3:'师44',4:'师09',5:'师14',6:'师01',7:'师42',8:'师22',9:'师19',10:'师20',11:'师43',12:'师42',13:'师29',14:'师16',15:'师33'}
      }
    },

    /* ---- 以下两份来自 晚修值班.xlsx → Sheet2 ----
       Sheet2 是「单周表 + 双周表」上下排的版式，两份数据几乎一致，
       只在个别班次有微调，故拆成两份独立模板，按单双周自动切换。 */
    'T-S1': {
      label: 'Sheet2 · 表一（单周）',
      mode: 'single',
      source: '晚修值班.xlsx → Sheet2 上半',
      note: '本年级部分班级单人、单班；每位老师一周一次晚修',
      grid: {
        1: {1:'师04',2:'师35',4:'师05',5:'师23',7:'师27',9:'师32',10:'师06',12:'师41',13:'师24',14:'师07'},
        2: {1:'师17',3:'师30',4:'师06',6:'师38',7:'师13',8:'师37',10:'师28',11:'师45',13:'师12',14:'师29'},
        3: {1:'师39',2:'师05',4:'师09',5:'师46',7:'师42',8:'师31',10:'师20',11:'师18',13:'师15',15:'师01'},
        4: {1:'师08',3:'师44',4:'师23',6:'师43',7:'师22',9:'师19',10:'师16',11:'师21',13:'师03',15:'师33'}
      }
    },
    'T-S2': {
      label: 'Sheet2 · 表二（双周）',
      mode: 'double',
      source: '晚修值班.xlsx → Sheet2 下半',
      note: '本年级部分班级单人、单班；每位老师一周一次晚修',
      grid: {
        1: {1:'师04',2:'师35',4:'师05',5:'师43',7:'师27',9:'师32',10:'师06',12:'师41',13:'师24',14:'师07'},
        2: {1:'师17',3:'师30',4:'师36',6:'师38',7:'师13',8:'师37',10:'师28',11:'师45',13:'师12',14:'师29'},
        3: {1:'师39',2:'师05',4:'师09',5:'师46',7:'师42',8:'师31',10:'师20',11:'师18',13:'师15',15:'师01'},
        4: {1:'师08',3:'师06',4:'师23',6:'师43',7:'师22',9:'师19',10:'师16',11:'师21',13:'师03',15:'师33'}
      }
    }
  },

  // 覆盖记录：overrides[日期][班级] = 老师姓名（覆盖模板）
  overrides: {},

  // 额外登记：extras[日期] = [{id, teacher, duty, note}]
  extras: {},

  /* 放假日：2026 年法定节假日（共 33 天）
     来源：国务院办公厅《关于 2026 年部分节假日安排的通知》（2025-11-04 发布）

     规则：只有「周一至周四 且 不在下面这份清单里」的日子才排晚修。
     考试日、校内活动日也可以加进来（设置页 → 标记放假）。 */
  holidays: [
    // ---- 元旦 1月1日(周四)至3日(周六) ----
    '2026-01-01', '2026-01-02', '2026-01-03',
    // ---- 春节 2月15日(周日)至23日(周一)，共 9 天 ----
    '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
    '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
    // ---- 清明 4月4日(周六)至6日(周一) ----
    '2026-04-04', '2026-04-05', '2026-04-06',
    // ---- 劳动节 5月1日(周五)至5日(周二)，共 5 天 ----
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
    // ---- 端午 6月19日(周五)至21日(周日) ----
    '2026-06-19', '2026-06-20', '2026-06-21',
    // ---- 中秋 9月25日(周五)至27日(周日) ----
    '2026-09-25', '2026-09-26', '2026-09-27',
    // ---- 国庆 10月1日(周四)至7日(周三)，共 7 天 ----
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
    '2026-10-05', '2026-10-06', '2026-10-07',
    // ---- 元旦 2027 ----
    '2027-01-01'
  ],

  /* 调休上班日（周末但要上班）
     来源同上。2026 年这 6 天全部落在周六/日，
     所以晚修本来就不排，列出仅供日历标记参考。 */
  makeUpWorkdays: [
    '2026-01-04',   // 元旦调休 · 周日
    '2026-02-14',   // 春节调休 · 周六
    '2026-02-28',   // 春节调休 · 周六
    '2026-05-09',   // 劳动节调休 · 周六
    '2026-09-20',   // 国庆调休 · 周日
    '2026-10-10'    // 国庆调休 · 周六
  ]
};

/* ============================ 工具函数 ============================ */
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const parseYmd = s => { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); };
const WEEK_CN = ['一','二','三','四','五','六','日'];
// JS getDay(): 0=周日 → 转为 1=周一..7=周日
const isoDow = d => (d.getDay() === 0 ? 7 : d.getDay());

function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

/** 某日期属于单周还是双周 */
function parityOf(dateStr) {
  const fm = parseYmd(DATA.meta.firstMonday);
  const d = parseYmd(dateStr);
  const diff = Math.round((d - fm) / 86400000);
  if (diff < 0) return 'single';
  return Math.floor(diff / 7) % 2 === 0 ? 'single' : 'double';
}

/** 取该日期应当使用的模板 id */
function templateFor(dateStr) {
  const cur = DATA.templates[DATA.meta.defaultTemplate]
    ? DATA.meta.defaultTemplate
    : Object.keys(DATA.templates)[0];

  // Sheet2 拆成了 T-S1(单周) / T-S2(双周) 两份，按日期自动切换
  if ((cur === 'T-S1' || cur === 'T-S2') && dateStr) {
    const par = parityOf(dateStr);
    return par === 'single' ? 'T-S1' : 'T-S2';
  }
  return cur;
}

/** 启用中的分段列表 */
function activeSegments() {
  return (DATA.meta.segments || []).filter(s => s.on !== false);
}

/**
 * 某天是否上晚修
 * 规则：周一至周四，且不在法定节假日列表里
 */
function isWorkday(dateStr) {
  if (!dateStr) return false;                       // 没有日期 → 不排
  const dw = isoDow(parseYmd(dateStr));
  // 调休补课日：周五/周六/日照样要上课（沿用别的星期的排班）
  if ((DATA.meta.scheduleMap || {})[dateStr]) return true;
  if (dw >= 5) return false;                        // 周五/六/日
  if ((DATA.holidays || []).includes(dateStr)) return false;   // 法定节假日
  return true;
}

/**
 * 某天是否可以安排「教师值班」
 * 与 isWorkday 的区别：周末值班 / 法定节假日的**前一天**可以安排教师来值班
 * （宿管值班，教师额外来两三位），所以这些日子允许有教师值班记录。
 */
function canDutyOn(dateStr) {
  if (!dateStr) return false;
  if (isWorkday(dateStr)) return true;
  // 周末、法定节假日都可以录入教师值班（如宿管值班日来两三位教师）
  const dw = isoDow(parseYmd(dateStr));
  return dw >= 5 || (DATA.holidays || []).includes(dateStr);
}

/** 某天是开学第几周（以 meta.firstMonday 为第 1 周的周一） */
function weekNoOf(dateStr) {
  if (!dateStr) return 0;
  const fm = DATA.meta.termWeek1Monday || DATA.meta.firstMonday;
  if (!fm) return 0;
  // 两边都对齐到各自那周的周一（周一=0偏移）
  const monOf = str => {
    const d = parseYmd(str);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (isoDow(d) - 1));
  };
  const a = monOf(dateStr), b = monOf(fm);
  return Math.round((a - b) / 604800000) + 1;
}

/** 某天是否是调休上班日（周末但要上班） */
function isMakeUpWorkday(dateStr) {
  return (DATA.makeUpWorkdays || []).includes(dateStr);
}

/**
 * 取某日某班某段落的排班老师
 * @param seg  's1'|'s2'|'s3'，不传则返回第一段（向后兼容旧调用）
 */
function teacherOn(dateStr, classNo, seg) {
  const key = seg || 's1';

  // 晚修只有「周一至周四的工作日」才排：
  //   1) 周五、周六、周日 一律不排
  //   2) 法定节假日（哪怕落在周一~周四）也不排、不计费
  //   3) 调休补课日（如 10/9 周五顶上周三的课）按映射表的星期几取排班
  if (!isWorkday(dateStr)) return null;

  /* 调休补课：沿用指定日期的星期几来取排班。
     单双周仍按今天(实际日期)算，只借用"星期几"这一维度。 */
  const map = DATA.meta.scheduleMap || {};
  const srcDate = map[dateStr] || dateStr;

  const ov = DATA.overrides[dateStr];
  let val = null;
  if (ov && Object.prototype.hasOwnProperty.call(ov, classNo)) val = ov[classNo];
  if (val == null) {
    const tpl = DATA.templates[templateFor(dateStr)];
    if (!tpl) return null;
    const par = parityOf(dateStr);
    if (tpl.mode === 'single' && par === 'double') return null;
    if (tpl.mode === 'double' && par === 'single') return null;
    const row = tpl.grid[isoDow(parseYmd(srcDate))];
    val = row ? (row[classNo] || null) : null;
  }
  return pickSeg(val, key);
}

/** 从格子取值中取出某一段的老师（兼容字符串与数组两种写法） */
function pickSeg(val, key) {
  if (val == null) return null;
  if (typeof val === 'string') return val || null;      // 旧写法：整晚同一人
  if (Array.isArray(val)) {
    const i = { s1: 0, s2: 1, s3: 2 }[key];
    return (i !== undefined && val[i]) ? val[i] : null;
  }
  if (typeof val === 'object') return val[key] || null;
  return null;
}

/** 取某日某班所有启用段落的老师 [{seg, teacher}] */
function allSegsOn(dateStr, classNo) {
  const out = [];
  for (const s of activeSegments()) {
    const t = teacherOn(dateStr, classNo, s.key);
    if (t) out.push({ seg: s.key, short: s.short, label: s.label, teacher: t });
  }
  return out;
}

/** 该日是否有晚修（用于日历标记） */
function hasEvening(dateStr) {
  if (!isWorkday(dateStr)) return false;
  return DATA.meta.classes.some(c => allSegsOn(dateStr, c).length > 0);
}

/** 某日是否被人工改动过 */
function isDayEdited(dateStr) {
  const ov = DATA.overrides[dateStr];
  const ex = DATA.extras[dateStr];
  const rs = rosterOn(dateStr);
  return !!(ov && Object.keys(ov).length) || !!(ex && ex.length) || rs.length > 0;
}

/* ============================ 名单制栏目 ============================ */
/** 所有名单制栏目 key */
function rosterPosts() {
  return Object.keys(DATA.posts || {}).filter(k => DATA.posts[k].kind === 'roster');
}

/** 取某栏目某日的记录 */
function rosterOn(dateStr, postKey) {
  const r = DATA.roster && DATA.roster[postKey];
  return (r && r[dateStr]) || [];
}

/** 某栏目某日是否被改过 */
function isRosterEdited(dateStr, postKey) {
  return rosterOn(dateStr, postKey).length > 0;
}

/** 写一条记录（新增或更新）。item.seg = 's1'|'s2'，用于按段计费的栏目 */
function setRosterItem(postKey, dateStr, item) {
  if (!DATA.roster[postKey]) DATA.roster[postKey] = {};
  const list = DATA.roster[postKey][dateStr] || (DATA.roster[postKey][dateStr] = []);
  const seg = item.seg || 's1';
  if (item.id) {
    const i = list.findIndex(x => x.id === item.id);
    if (i >= 0) list[i] = { ...list[i], ...item, seg };
  } else {
    list.push({ id: 'r' + Date.now().toString(36) + Math.floor(Math.random() * 100).toString(36),
                teacher: item.teacher, times: item.times || 1, note: item.note || '',
                seg });
  }
  if (!list.length) delete DATA.roster[postKey][dateStr];
}

/** 记一条变更痕迹（只留最近 30 条） */
function markChanged(what, post, date) {
  if (!Array.isArray(DATA.meta.changeLog)) DATA.meta.changeLog = [];
  DATA.meta.changeLog.unshift({
    ts: Date.now(), post: post || '', date: date || '', what: what || ''
  });
  if (DATA.meta.changeLog.length > 30) DATA.meta.changeLog.length = 30;
}

/** 取最近 n 条变更 */
function recentChanges(n) {
  const list = DATA.meta.changeLog || [];
  return n ? list.slice(0, n) : list.slice();
}

/** 取某条记录所属分段（未记录视为一段） */
function rosterSegOf(item) { return (item && item.seg) || 's1'; }

/**
 * 这一格里段别是不是"混着"的。
 *
 * 她提的需求：**全班都是同一段时不用标段别**（那是普遍安排，不是特殊情况），
 * 只有一段、二段**分成不同的人**时，才要分两行分别标清。
 * 之前是谁值了两段就标个"2段"，导致"某某2段"这种噪音满屏。
 *
 * ⚠️ 关键区别：**同一个人**同时值一段和二段（s1+s2 都是他），
 * 这是"一个人干两段"，不是"两个段分给两个人"，不该标段别 ——
 * 只有出现**两个及以上不同的人**且他们分属不同段时才分行标注。
 *
 * @param lines 该格的排班行 [{key,short,t}]，每项带 k（段标识）
 * @returns {mixed:boolean, groups:[{key,short,names:[…]}]}
 */
function segSplitOf(lines) {
  const list = lines || [];
  /* 先按人归并：一个人值几段都算他一个人 */
  const byTeacher = [];
  for (const l of list) {
    const f = byTeacher.find(x => x.t === l.t);
    if (f) f.keys.push(l.key);
    else byTeacher.push({ t: l.t, keys: [l.key] });
  }
  /* 一个人 → 无所谓分段，只写名字 */
  if (byTeacher.length <= 1) {
    return { mixed: false, byTeacher };
  }
  /* 多人时，看他们是不是分属不同段 */
  const keys = Array.from(new Set(list.map(l => l.key)));
  if (keys.length <= 1) {
    return { mixed: false, byTeacher };   /* 全员同一段 → 也不标 */
  }
  /* 真的分段了 → 按段分组，标清每段是谁 */
  const groups = [];
  for (const b of byTeacher) {
    /* 一个人占了多段时，归到他的第一段（这种极少，只在混排时出现） */
    const first = b.keys[0];
    const seg = list.find(l => l.key === first) || {};
    const g = groups.find(x => x.key === first);
    if (g) g.names.push(b.t);
    else groups.push({ key: first, short: seg.short, names: [b.t] });
  }
  return { mixed: true, groups, byTeacher };
}

/** 某栏目某段的单价 */
function rateOf(postKey, seg) {
  const list = segRateList(postKey, seg || 's1');
  return list.reduce((a, b) => a + b, 0);
}

/** 分段标识 → 显示名。s1=一段 / s2=二段 / s3=三段 / both=一二段 */
function segLabelOf(segKey) {
  if (segKey === 'both') return '一二段';
  if (segKey === 'both2') return '二一段';
  const s = (DATA.meta.segments || []).find(x => x.key === segKey);
  return s ? s.short : (segKey === 's2' ? '二段' : segKey === 's3' ? '三段' : '一段');
}

/** 该分段一共算几段（both = 2 段） */
function segCountOf(segKey) {
  if (segKey === 'both' || segKey === 'both2') return 2;
  return 1;
}

/** 取某分段涉及的单价清单（both 返回两段单价） */
function segRateList(postKey, seg) {
  const p = DATA.posts[postKey];
  if (!p) return [];
  const g = k => { const v = (p.segRates || {})[k]; return (v === null || v === undefined) ? (p.rate === null || p.rate === undefined ? 0 : p.rate) : v; };
  if (seg === 'both')  return [g('s1'), g('s2')];
  if (seg === 'both2') return [g('s2'), g('s1')];
  return [g(seg)];
}

/** 删一条 */
function delRosterItem(postKey, dateStr, id) {
  const r = DATA.roster && DATA.roster[postKey];
  if (!r || !r[dateStr]) return;
  r[dateStr] = r[dateStr].filter(x => x.id !== id);
  if (!r[dateStr].length) delete r[dateStr];
}

/** 某栏目单日合计（次数） */
function rosterSum(postKey, dateStr) {
  return rosterOn(dateStr, postKey).reduce((s, x) => s + (Number(x.times) || 0), 0);
}

/** 某栏目某月的全部记录（带日期） */
function rosterRange(postKey, from, to) {
  const r = DATA.roster && DATA.roster[postKey] || {};
  const out = [];
  const s = parseYmd(from), e = parseYmd(to);
  for (let cur = new Date(s); cur <= e; cur.setDate(cur.getDate() + 1)) {
    const ds = ymd(cur);
    for (const it of (r[ds] || [])) {
      const seg = rosterSegOf(it);
      const n = Number(it.times) || 0;
      out.push({ date: ds, ...it, seg, sections: n * segCountOf(seg),
                 amount: n * rateOf(postKey, seg) });
    }
  }
  return out;
}

/* ============================ 统计核心 ============================ */
/**
 * 计算某月（或自定义日期区间）的费用统计
 * 汇总全部七个栏目：晚修按分段计费，名单制按次数计费
 * 返回 { byTeacher, rows, detail, totals, anomalies, byPost }
 */
function computeStats(fromDate, toDate) {
  const byTeacher = {};
  const anomalies = [];
  const detail = [];
  const segs = activeSegments();

  const ensure = name => {
    if (!byTeacher[name]) {
      byTeacher[name] = { name, duty: {}, sections: 0, times: 0, amount: 0 };
    }
    return byTeacher[name];
  };

  const start = parseYmd(fromDate), end = parseYmd(toDate);

  for (let cur = new Date(start); cur <= end; cur.setDate(cur.getDate() + 1)) {
    const ds = ymd(cur);
    /* 法定节假日：晚修不计，但「周末值班」栏目的教师值班仍要算 */
    const isHol = (DATA.holidays || []).includes(ds);
    const weekendDuty = isHol ? (rosterOn(ds, 'weekend') || []).length > 0 : false;
    if (isHol && !weekendDuty) continue;

    /* ---- 1) 教师晚修（节假日与周末不排） ----
       统计规则：**同一天同一段，同一位老师只计 1 次**，无论他看几个班。
       例：某老师同时看 1 班和 2 班 → 只记 1 次，明细里列出他看的班级。
       ⚠️ 本项目只统计次数，不记录费用，所以下面不再有单价/金额的概念。 */
    const seen = {};
    for (const c of DATA.meta.classes) {
      for (const s of segs) {
        const t = teacherOn(ds, c, s.key);
        if (!t) continue;

        // 同人同段当天只记一次
        const k = t + '@' + s.key;
        if (!seen[k]) {
          seen[k] = { teacher: t, seg: s, classes: [], charged: false };
          const rec = ensure(t);
          rec.duty[s.label] = (rec.duty[s.label] || 0) + 1;
          rec.sections += 1;
          rec.times += 1;
          rec.amount += (s.rate || 0);
          seen[k].charged = true;
        }
        seen[k].classes.push(c);
      }
    }

    // 明细 + 一人多班提示（在计费之后生成，班级列表已完整）
    for (const k in seen) {
      const g = seen[k];
      detail.push({
        date: ds, teacher: g.teacher, duty: g.seg.label, post: 'evening', segKey: g.seg.key,
        classes: g.classes.join('、'), sections: 1, amount: g.seg.rate || 0,
        note: g.classes.length > 1 ? `一人带 ${g.classes.length} 个班，计 1 次` : ''
      });
      if (g.classes.length > 1) {
        anomalies.push({
          date: ds, teacher: g.teacher, classes: g.classes,
          msg: `${ds}　${g.teacher} ${g.seg.short}一人带 ${g.classes.join('、')} 班`
            + `（共 ${g.classes.length} 个班，只计 1 次）`
        });
      }
    }

    /* 空班不算异常。
       Sheet2 的原表注明「部分班级单人、单班，每位老师一周一次晚修」，
       所以有些班当天本来就没人带——这是安排，不是漏排。 */
    /* 同一人同一天上多个段 —— 这是正常安排（同一人值两段），不提示。
       只有一种情况需要提醒：同一天同一段被排到了多个班，
       但那已经由上面的「合并班」提示覆盖了。
       所以这里不再产生「多段」异常，避免刷屏误报。 */

    /* ---- 2) 名单制栏目 ----
       weekend 按分段计价（一段/二段各算各的），
       其他栏目按次数计价。 */
    for (const pk of rosterPosts()) {
      const p = DATA.posts[pk];
      for (const it of rosterOn(ds, pk)) {
        if (!it.teacher) continue;
        const n = Number(it.times) || 0;
        if (n <= 0) continue;
        const seg = rosterSegOf(it);
        const unit = rateOf(pk, seg);
        const nSeg = p.bySeg ? segCountOf(seg) : 1;
        // 分段栏目在汇总表里按「栏目·一段」拆列
        const colName = p.bySeg ? `${p.name}·${segLabelOf(seg)}` : p.name;

        const rec = ensure(it.teacher);
        rec.duty[colName] = (rec.duty[colName] || 0) + n;
        rec.sections += n * nSeg;
        rec.times += n * nSeg;
        rec.amount += n * unit;
        detail.push({
          date: ds, teacher: it.teacher, duty: colName, post: pk, segKey: p.bySeg ? seg : '',
          classes: '', sections: n, amount: n * unit, note: it.note || ''
        });
      }
    }

    /* ---- 3) 临时额外登记（挂在晚修下） ---- */
    for (const e of (DATA.extras[ds] || [])) {
      if (!e.teacher) continue;
      const dconf = DATA.duties[e.duty] || DATA.duties['其他'];
      const rec = ensure(e.teacher);
      rec.duty[e.duty] = (rec.duty[e.duty] || 0) + 1;
      rec.sections += dconf.sections;
      rec.times += 1;
      rec.amount += dconf.rate * dconf.sections;
      detail.push({
        date: ds, teacher: e.teacher, duty: e.duty, post: 'evening', segKey: '',
        classes: '', sections: dconf.sections,
        amount: dconf.rate * dconf.sections, note: e.note || ''
      });
    }
  }

  detail.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    a.teacher.localeCompare(b.teacher, 'zh') ||
    String(a.segKey).localeCompare(String(b.segKey)));

  const rowsOut = Object.values(byTeacher)
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'zh'));

  /* 各栏目小计（按段落的拆成「栏目·一段」「栏目·二段」） */
  const byPost = {};
  for (const key of Object.keys(DATA.posts || {})) {
    const p = DATA.posts[key];
    const rows = detail.filter(d => d.post === key);
    if (p.bySeg) {
      const seen = {};
      for (const d of rows) {
        const seg = d.segKey || 's1';
        const k = key + ':' + seg;
        if (!seen[k]) {
          seen[k] = { key, name: `${p.name}·${segLabelOf(seg)}`,
                      short: p.short, icon: p.icon, seg,
                      rate: rateOf(key, seg), kind: p.kind,
                      times: 0, amount: 0, headcount: 0, _names: new Set() };
        }
        seen[k].times += d.sections;
        seen[k].amount += d.amount;
        seen[k]._names.add(d.teacher);
      }
      // 没数据的段不列
      for (const k in seen) {
        const v = seen[k];
        v.headcount = v._names.size;
        delete v._names;
        byPost[k] = v;
      }
    } else {
      let times = 0, amount = 0;
      const names = new Set();
      for (const d of rows) { times += d.sections; amount += d.amount; names.add(d.teacher); }
      byPost[key] = { key, name: p.name, short: p.short, icon: p.icon,
                      rate: p.rate, kind: p.kind, times, amount, headcount: names.size };
    }
  }

  const totals = {
    amount: rowsOut.reduce((s, r) => s + r.amount, 0),
    sections: rowsOut.reduce((s, r) => s + r.sections, 0),
    times: rowsOut.reduce((s, r) => s + r.times, 0),
    headcount: rowsOut.length
  };
  return { byTeacher, rows: rowsOut, detail, totals, anomalies, byPost };
}

/* ============================ 名单识别引擎 ============================
   从 Excel 或图片 OCR 结果里提取「日期 / 老师 / 次数」
   用于行政值班、校医、教辅、午休、额外加班等名单制栏目
   ========================================================== */

/** 已知人员名单（用于校验识别出的名字） */
function knownPeople() {
  const s = new Set();
  (DATA.teachers || []).forEach(t => s.add(t));
  (DATA.adminStaff || []).forEach(t => s.add(t));
  (DATA.dormStaff || []).forEach(t => s.add(t));
  return [...s].filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh'));
}

/**
 * 模糊匹配：把 OCR 出来的字符串对到已知人名
 * 容忍错字：逐字比较取相似度最高的
 */
function matchPerson(text, pool) {
  const t = String(text || '').replace(/[\s:：]/g, '');
  if (!t) return null;
  // 完全匹配
  if (pool.includes(t)) return t;
  // 包含关系（"某某老师" → "某某"）
  for (const n of pool) if (t.includes(n)) return n;
  // 逐字比对，取最高分
  let best = null, bestScore = 0;
  for (const n of pool) {
    const score = _similar(t, n);
    if (score > bestScore) { bestScore = score; best = n; }
  }
  return bestScore >= 0.6 ? best : null;
}

/** 简单的字符相似度（0~1） */
function _similar(a, b) {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a), setB = new Set(b);
  let inter = 0;
  for (const c of setA) if (setB.has(c)) inter++;
  return inter / Math.max(setA.size, setB.size);
}

/** 从一行文本里抠出日期，返回 'YYYY-MM-DD' 或 null */
function extractDate(line) {
  // 2026-10-05 / 2026.10.5 / 2026/10/5 / 10月5日 / 10.5
  let m = line.match(/(20\d{2})\s*[-./年]\s*(\d{1,2})\s*[-./月]\s*(\d{1,2})/);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  // 只有月日（用当前年月补）
  m = line.match(/(\d{1,2})\s*[月./]\s*(\d{1,2})\s*日?/);
  if (m) {
    const y = DATA.meta.firstMonday.slice(0, 4);
    const mo = +m[1], d = +m[2];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad(mo)}-${pad(d)}`;
  }
  return null;
}

/** 从一行文本里抠出次数 */
function extractTimes(line) {
  // "3次" / "x3" / "3" / "共3"
  let m = line.match(/共\s*(\d+)\s*[次天]?/);
  if (m) return +m[1];
  m = line.match(/(\d+)\s*次/);
  if (m) return +m[1];
  m = line.match(/[×xX*]\s*(\d+)/);
  if (m) return +m[1];
  return 1;   // 出现名字但没写次数，默认 1 次
}

/**
 * 核心：从「纯文本行」里提取名单记录
 * @param lines 文本行数组（Excel 每行 / OCR 每行）
 * @param pool  可选：限定人员范围；不传则自动用已知人名 + 兜底
 * @returns [{line, date, teacher, times, raw}]
 */
function parseRosterLines(lines, pool) {
  const known = pool && pool.length ? pool : knownPeople();
  const out = [];
  for (const raw of lines) {
    const line = String(raw || '').trim();
    if (!line || line.length > 80) continue;

    // 取出所有可能的日期（同一行可能有多个）
    const dates = [];
    let m;
    const re = /(20\d{2})\s*[-./年]\s*(\d{1,2})\s*[-./月]\s*(\d{1,2})/g;
    while ((m = re.exec(line))) dates.push(`${m[1]}-${pad(+m[2])}-${pad(+m[3])}`);
    if (!dates.length) {
      const re2 = /(\d{1,2})\s*[月./]\s*(\d{1,2})\s*日?/g;
      const y = DATA.meta.firstMonday.slice(0, 4);
      while ((m = re2.exec(line))) {
        const mo = +m[1], d = +m[2];
        if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) dates.push(`${y}-${pad(mo)}-${pad(d)}`);
      }
    }

    // 找出这一行里所有认识的人
    const hits = [];
    for (const n of known) {
      if (line.includes(n)) hits.push(n);
    }
    // 没匹配到就试模糊
    if (!hits.length) {
      // 把行按分隔符切开，逐段模糊匹配
      const parts = line.split(/[\s,，、|;；:：*×\/\t]+/).filter(x => x.length >= 2 && x.length <= 4);
      for (const pt of parts) {
        const nm = matchPerson(pt, known);
        if (nm && !hits.includes(nm)) hits.push(nm);
      }
    }
    if (!hits.length) continue;

    const times = extractTimes(line);
    const date = dates[0] || null;

    if (dates.length > 1 && hits.length === 1) {
      // 一行里一个人名 + 多个日期 → 每天都记
      for (const d of dates) out.push({ line: raw, date: d, teacher: hits[0], times, raw });
    } else if (dates.length === 1 && hits.length > 1) {
      // 多个名字共享一个日期
      for (const t of hits) out.push({ line: raw, date: dates[0], teacher: t, times, raw });
    } else {
      for (const t of hits) out.push({ line: raw, date, teacher: t, times, raw });
    }
  }
  return out;
}

/**
 * 从 Excel 工作簿里识别名单制记录
 * 自动判断表式：
 *   rows 纵向：每行 = 日期 + 老师 + 次数（次数可能是独立列）
 *   cols 横向：行=老师，列头是日期
 */
function parseRosterWorkbook(wb) {
  const results = [];
  for (const sname of wb.SheetNames) {
    const ws = wb.Sheets[sname];
    if (!ws || !ws['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    const get = (r, c) => {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      return cell ? String(cell.v ?? '').trim() : '';
    };
    const width = range.e.c - range.s.c + 1;

    /* ---------- 横向表检测：某行有 ≥2 个日期 ---------- */
    let colsResult = null;
    for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 4); r++) {
      const headDates = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const d = extractDate(get(r, c));
        if (d) headDates.push({ col: c, date: d });
      }
      if (headDates.length < 2) continue;

      const items = [];
      for (let rr = r + 1; rr <= range.e.r; rr++) {
        // 老师可能在第一列，也可能在行首第一个非日期格
        let teacher = '';
        for (let c = range.s.c; c <= range.e.c; c++) {
          const v = get(rr, c);
          if (v && !extractDate(v) && !/^\d+(\.\d+)?$/.test(v) && !v.includes('次')) {
            teacher = v; break;
          }
        }
        if (!teacher) continue;
        const tn = matchPerson(teacher, knownPeople()) || teacher.trim();

        for (const hd of headDates) {
          const raw = get(rr, hd.col);
          if (!raw) continue;
          const num = parseFloat(raw.replace(/[^\d.]/g, ''));
          const times = isNaN(num) || num <= 0 ? 0 : Math.round(num);
          if (!times) continue;         // 0 次不记
          items.push({ date: hd.date, teacher: tn, times, raw });
        }
      }
      if (items.length) { colsResult = items; break; }
    }

    /* ---------- 纵向表：逐行读，次数取独立列 ---------- */
    const grid = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const row = [];
      for (let c = range.s.c; c <= range.e.c; c++) row.push(get(r, c));
      grid.push(row);
    }

    // 找出「次数」列：表头含"次数/次/天数"的列
    let timesCol = -1;
    for (let r = 0; r < Math.min(4, grid.length); r++) {
      for (let c = 0; c < width; c++) {
        if (/次数|次\s*数|天数|值班次数/.test(grid[r][c] || '')) { timesCol = c; break; }
      }
      if (timesCol >= 0) break;
    }

    const lines = [];
    for (const row of grid) {
      if (!row.some(x => x)) continue;
      let text = row.filter(Boolean).join(' ');
      // 次数独立列 → 拼到文本里，让 extractTimes 抓到
      if (timesCol >= 0 && row[timesCol] && /^\d+$/.test(row[timesCol])) {
        text += ` ${row[timesCol]}次`;
      }
      lines.push(text);
    }

    let rowResult = parseRosterLines(lines);

    /* ---------- 择优：横向识别更好就只用横向 ---------- */
    if (colsResult && colsResult.length >= rowResult.length) {
      results.push({ sheet: sname, mode: 'cols', items: colsResult });
    } else if (rowResult.length) {
      results.push({ sheet: sname, mode: 'rows', items: rowResult });
    } else if (colsResult) {
      results.push({ sheet: sname, mode: 'cols', items: colsResult });
    }
  }
  return results;
}

/** 从 OCR 文本识别名单制记录 */
function parseRosterText(text, pool) {
  const lines = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return parseRosterLines(lines, pool);
}

/** 把识别结果写入某个栏目（会先清掉该月旧数据，可选） */
function applyRosterItems(postKey, items, opts) {
  const o = opts || {};
  if (o.clearMonth) {
    const r = DATA.roster[postKey] || (DATA.roster[postKey] = {});
    const [y, m] = (o.month || DATA.meta.firstMonday.slice(0, 7)).split('-');
    Object.keys(r).forEach(ds => {
      if (ds.slice(0, 7) === `${y}-${m}`) delete r[ds];
    });
  }
  let n = 0;
  for (const it of items) {
    if (!it.teacher) continue;
    const ds = it.date || o.defaultDate;
    if (!ds) continue;
    setRosterItem(postKey, ds, { teacher: it.teacher, times: it.times || 1, note: it.note || '' });
    n++;
  }
  return n;
}

/** ============================ 导入 Excel ============================ */
/**
 * 识别"这一段属于什么周"的标签文字
 */
function _labelMode(txt) {
  if (!txt) return null;
  const t = String(txt).replace(/\s/g, '');
  if (/单周|表一|表1/.test(t)) return 'single';
  if (/双周|表二|表2/.test(t)) return 'double';
  return null;
}

const _DOW_MAP = {'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'日':7,'天':6,'末':6};
function _dowOf(txt) {
  const m = String(txt || '').trim().match(/^(?:周|星期)([一二三四五六日天末])/);
  return m ? _DOW_MAP[m[1]] : null;
}

/** 合并班级：把「5、6班」「5,6」这类写法拆成多个班号 */
function _expandClasses(v) {
  const s = String(v).trim();
  // 只在明确含分隔符时展开，避免把「10班」误拆
  if (/[、,，\/\s]/.test(s.replace(/班\s*$/, ''))) {
    const nums = s.match(/\d+/g);
    if (nums && nums.length > 1) return nums.map(Number);
  }
  return null;
}

/**
 * 解析 xlsx 工作簿，返回每个可用排班表 + 预检信息
 *
 * 兼容三种排班写法：
 *   1) 表一（单周）/ 表二（双周）上下并排，标签在表头行【上方】
 *   2) 单周 / 双周 两段式
 *   3) 完全不分单双周，一份排班走到底
 */
function parseWorkbook(wb) {
  const results = [];

  for (const sname of wb.SheetNames) {
    const ws = wb.Sheets[sname];
    if (!ws || !ws['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    const get = (r, c) => {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cell) return '';
      return String(cell.v ?? '').trim();
    };

    // ---- 步骤1：找出所有「班级表头行」（含 ≥3 个「N班」的整行） ----
    const headerRows = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const cols = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const m = get(r, c).match(/^(\d+)\s*班$/);
        if (m) cols.push({ classNo: +m[1], col: c });
      }
      if (cols.length >= 3) headerRows.push({ r, cols });
    }
    if (!headerRows.length) continue;

    const primary = headerRows.reduce((a, b) =>
      b.cols.length > a.cols.length ? b : a);
    const clsSet = primary.cols.map(x => x.classNo).sort((a, b) => a - b);

    // ---- 步骤2：扫描每一段（表头行 → 下一个表头行之前） ----
    const blocks = [];
    const extras = [];

    // 建立 row → 表头 映射，便于处理"标签在表头上方"的情况
    const headerAt = {};
    headerRows.forEach(h => { headerAt[h.r] = h; });

    for (const h of headerRows) {
      // 向上找这一段最近的段标签（最多回看 6 行，且不越过上一个表头）
      const prevHdr = Math.max(-1, ...Object.keys(headerAt).map(Number).filter(x => x < h.r));
      let mode = null;
      for (let r = h.r - 1; r > prevHdr && r >= h.r - 6; r--) {
        let hit = null;
        for (let c = range.s.c; c <= range.e.c; c++) {
          const v = get(r, c);
          if (v && _dowOf(v) === null && _labelMode(v)) { hit = _labelMode(v); break; }
        }
        if (hit) { mode = hit; break; }
      }
      // 没有显式标签：如果这是第 2 段及以后，沿用"通用"；如果是第 1 段，也通用
      if (!mode) mode = 'all';

      const block = {
        mode,
        label: mode === 'single' ? '单周' : mode === 'double' ? '双周' : '通用',
        grid: {}
      };

      // 该表头行往下，直到下一个表头行为止
      const nextHdr = Object.keys(headerAt).map(Number).filter(x => x > h.r).sort((a, b) => a - b)[0];
      const endRow = (nextHdr === undefined) ? range.e.r : nextHdr - 1;
      const maxCol = Math.max(...h.cols.map(x => x.col));

      for (let r = h.r + 1; r <= endRow; r++) {
        const dow = _dowOf(get(r, range.s.c));
        if (!dow) continue;
        block.grid[dow] = block.grid[dow] || {};
        for (const { classNo, col } of h.cols) {
          const v = get(r, col);
          if (!v) continue;
          const ex = _expandClasses(v);
          if (ex) { for (const n of ex) block.grid[dow][n] = v; }
          else block.grid[dow][classNo] = v;
        }
        // 最后一个班级列之后的非空 = 额外登记（午休/行政/校医等）
        for (let c = maxCol + 1; c <= range.e.c; c++) {
          const v = get(r, c);
          if (v) extras.push({
            sheet: sname, row: r + 1,
            col: XLSX.utils.encode_col(c), dow, value: v
          });
        }
      }

      if (Object.keys(block.grid).length) blocks.push(block);
    }

    if (!blocks.length) continue;

    // ---- 步骤3：合并两段里相同的"通用"段（避免同一份排班被拆成两段） ----
    const merged = [];
    for (const b of blocks) {
      const same = merged.find(x => x.mode === b.mode &&
        JSON.stringify(x.grid) === JSON.stringify(b.grid));
      if (same) continue;
      merged.push(b);
    }

    // 表头说明（第一行）
    let note = '';
    const firstCol = range.s.c;
    if (headerRows[0].r > range.s.r) {
      note = get(range.s.r, firstCol).slice(0, 80);
    }

    results.push({
      sheet: sname,
      classes: clsSet,
      blocks: merged,
      extras,
      note
    });
  }
  return results;
}

/** 把解析结果转成 templates 结构 */
function templatesFromParse(parsed) {
  const out = {};
  const base = Date.now().toString(36);
  parsed.blocks.forEach((b, i) => {
    const id = 'T-' + base + '-' + i;
    out[id] = {
      label: parsed.sheet + ' · ' + b.label,
      mode: b.mode,
      source: parsed.sheet,
      grid: b.grid
    };
  });
  return out;
}

/* ============================ 导出 Excel ============================ */
function exportStatsXlsx(stat, monthLabel) {
  const wb = XLSX.utils.book_new();

  /* Sheet1 汇总（只统计次数，不含金额） */
  const dutyNames = Object.keys(DATA.duties);
  const head1 = ['姓名', ...dutyNames.map(d => d + '(节)'), '合计节数', '合计次数'];
  const body1 = stat.rows.map(r => {
    const line = [r.name];
    for (const dn of dutyNames) line.push(Math.round((r.duty[dn]||0) * DATA.duties[dn].sections));
    line.push(r.sections, r.times);
    return line;
  });
  const foot1 = ['合计', ...dutyNames.map(dn => stat.rows.reduce((s,r)=>s+(r.duty[dn]||0)*DATA.duties[dn].sections,0)),
                  stat.totals.sections, stat.totals.times];
  const ws1 = XLSX.utils.aoa_to_sheet([head1, ...body1, foot1]);
  ws1['!cols'] = [{wch:12},...Array(dutyNames.length + 2).fill({wch:12})];
  XLSX.utils.book_append_sheet(wb, ws1, '次数汇总');

  // Sheet2 明细（不含金额）
  const head2 = ['日期','星期','单双周','姓名','岗位','班级数','次数','备注'];
  const body2 = stat.detail.map(d => {
    const d0 = parseYmd(d.date);
    return [d.date, '星期'+WEEK_CN[isoDow(d0)-1],
            parityOf(d.date)==='single'?'单周':'双周',
            d.teacher, d.duty, d.classes===''?'':d.classes, d.sections, d.note];
  });
  const ws2 = XLSX.utils.aoa_to_sheet([head2, ...body2]);
  ws2['!cols'] = [{wch:12},{wch:7},{wch:7},{wch:12},{wch:11},{wch:7},{wch:7},{wch:20}];
  XLSX.utils.book_append_sheet(wb, ws2, '值班明细');

  // Sheet3 异常
  if (stat.anomalies.length) {
    const body3 = stat.anomalies.map(a=>[a.date, a.teacher, a.classes.join('、'), a.msg]);
    const ws3 = XLSX.utils.aoa_to_sheet([['日期','姓名','涉及班级','提示'], ...body3]);
    ws3['!cols'] = [{wch:12},{wch:12},{wch:20},{wch:50}];
    XLSX.utils.book_append_sheet(wb, ws3, '需人工确认');
  }

  XLSX.writeFile(wb, `晚修值班次数_${monthLabel}.xlsx`);
}

/* ============================ 存储 ============================ */
// 存储实现由外部注入：网页用 localStorage，小程序用 wx.setStorageSync
let _local = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
};

let DATA;

/** 切换存储实现。小程序启动时调用 setStorage(wxAdapter) */
function setStorage(adapter) { _local = adapter; }

function load() {
  try {
    const raw = _local.getItem(LS_KEY);
    if (raw) { DATA = JSON.parse(raw); migrate(); return DATA; }
  } catch(e) { console.warn(e); }
  DATA = deepClone(DEFAULT_DATA);
  migrate();
  save();
  return DATA;
}

/** 补齐旧版本缺失的字段，保证老数据打开也能用 */
function migrate() {
  if (!DATA.meta) DATA.meta = deepClone(DEFAULT_DATA.meta);
  const dm = DEFAULT_DATA.meta;
  if (!Array.isArray(DATA.meta.segments) || !DATA.meta.segments.length) {
    DATA.meta.segments = deepClone(dm.segments);
  } else {
    // 补齐缺失的段
    dm.segments.forEach((d, i) => {
      const cur = DATA.meta.segments[i];
      if (!cur) DATA.meta.segments.push(deepClone(d));
      else {
        if (cur.key === undefined) cur.key = d.key;
        if (cur.short === undefined) cur.short = d.short;
        if (cur.label === undefined) cur.label = d.label;
        if (cur.time === undefined) cur.time = d.time;
        if (cur.rate === undefined) cur.rate = d.rate;
        if (cur.on === undefined) cur.on = false;
      }
    });
  }
  if (!Array.isArray(DATA.adminStaff)) DATA.adminStaff = [];
  if (!Array.isArray(DATA.meta.changeLog)) DATA.meta.changeLog = [];
  if (!DATA.meta.scheduleMap) DATA.meta.scheduleMap = {};
  if (!DATA.meta.termWeek1Monday) {
    DATA.meta.termWeek1Monday = DEFAULT_DATA.meta.termWeek1Monday || '2026-08-31';
  }
  // 并入内置的调休映射（用户自加的不会被覆盖）
  for (const k in (DEFAULT_DATA.meta.scheduleMap || {})) {
    if (!(k in DATA.meta.scheduleMap)) DATA.meta.scheduleMap[k] = DEFAULT_DATA.meta.scheduleMap[k];
  }
  // 补齐七个栏目
  if (!DATA.posts) DATA.posts = deepClone(DEFAULT_DATA.posts);
  else {
    const dp = DEFAULT_DATA.posts;
    Object.keys(dp).forEach(k => {
      if (!DATA.posts[k]) DATA.posts[k] = deepClone(dp[k]);
    });
  }
  /* 栏目说明文字跟着代码里的最新版走。
     只补字段、不更新已有字段的值 —— 所以改了 desc 之后，
     老设备上的旧文案（比如"计费"那种）会一直留着。
     这里统一对齐一次：只刷 desc，别的（name/icon/rate）不动，
     免得把她自己改过的设置冲掉。 */
  if (DATA.posts) {
    const dp = DEFAULT_DATA.posts;
    Object.keys(dp).forEach(k => {
      if (dp[k].desc && DATA.posts[k] && DATA.posts[k].desc !== dp[k].desc) {
        DATA.posts[k].desc = dp[k].desc;
      }
    });
  }
  if (!DATA.roster) DATA.roster = {};
  Object.keys(DEFAULT_DATA.roster).forEach(k => {
    if (!DATA.roster[k]) DATA.roster[k] = {};
  });
  // 旧数据迁移：extras 里的行政值班/校医/午休 → 对应栏目
  if (DATA.extras && Object.keys(DATA.extras).length && !DATA._migratedExtras) {
    Object.keys(DATA.extras).forEach(ds => {
      const list = DATA.extras[ds];
      if (!list) return;
      list.forEach(e => {
        let pk = null;
        if (e.duty === '行政值班') pk = 'admin';
        else if (e.duty === '校医') pk = 'clinic';
        else if (e.duty === '午休') pk = 'noon';
        if (!pk) return;
        if (!DATA.roster[pk]) DATA.roster[pk] = {};
        const arr = DATA.roster[pk][ds] || (DATA.roster[pk][ds] = []);
        arr.push({ id: 'r' + ds + Math.random().toString(36).slice(2,7),
                  teacher: e.teacher, times: 1, note: e.note || '' });
      });
      DATA.extras[ds] = list.filter(e => {
        const m = { '行政值班':'admin', '校医':'clinic', '午休':'noon' };
        return !m[e.duty];
      });
      if (!DATA.extras[ds].length) delete DATA.extras[ds];
    });
    DATA._migratedExtras = true;
  }
  if (!Array.isArray(DATA.dormStaff)) DATA.dormStaff = [];
  if (!Array.isArray(DATA.teachers)) DATA.teachers = [];
  if (!Array.isArray(DATA.meta.classes)) DATA.meta.classes = dm.classes.slice();
  if (!DATA.overrides) DATA.overrides = {};
  if (!DATA.extras) DATA.extras = {};
  if (!Array.isArray(DATA.holidays)) DATA.holidays = [];
  if (!Array.isArray(DATA.makeUpWorkdays)) DATA.makeUpWorkdays = [];
  /* 把国务院公布的法定节假日并进来。
     记录「已并入到哪一天」为版本戳：用户自己加的日子一律保留，
     以后官方发布新年度安排时也能自动补上。 */
  const OFF_STAMP = (DEFAULT_DATA.holidays || []).slice(-1)[0] || '';
  const MK_STAMP  = (DEFAULT_DATA.makeUpWorkdays || []).slice(-1)[0] || '';
  if (OFF_STAMP && DATA._offStamp !== OFF_STAMP) {
    DATA.holidays = [...new Set([...(DEFAULT_DATA.holidays || []), ...DATA.holidays])].sort();
    DATA._offStamp = OFF_STAMP;
  }
  if (MK_STAMP && DATA._mkStamp !== MK_STAMP) {
    DATA.makeUpWorkdays = [...new Set([...(DEFAULT_DATA.makeUpWorkdays || []), ...DATA.makeUpWorkdays])].sort();
    DATA._mkStamp = MK_STAMP;
  }
  if (!DATA.templates || !Object.keys(DATA.templates).length) {
    DATA.templates = deepClone(DEFAULT_DATA.templates);
    DATA.meta.defaultTemplate = DEFAULT_DATA.meta.defaultTemplate;
  }
  // 老版本把晚修当成普通岗位，清掉并把单价搬到分段上
  if (DATA.duties && DATA.duties['晚修']) {
    const oldRate = DATA.duties['晚修'].rate || 15;
    DATA.meta.segments.forEach(s => { if (s.rate === undefined) s.rate = oldRate; });
    delete DATA.duties['晚修'];
  }
  if (!DATA.duties) DATA.duties = deepClone(DEFAULT_DATA.duties);
}

function save() {
  try { _local.setItem(LS_KEY, JSON.stringify(DATA)); }
  catch(e) { console.warn(e); }
}

function resetAll() {
  DATA = deepClone(DEFAULT_DATA);
  migrate();
  save();
}

function getData() { return DATA; }
function setData(d) { DATA = d; save(); }

/* ---------- 备份（两端通用：返回 JSON 字符串） ---------- */
function backupJSON() { return JSON.stringify(DATA, null, 2); }

function restoreJSON(text) {
  const d = JSON.parse(text);
  if (!d.meta || !d.templates) throw new Error('备份格式不对');
  DATA = d; save();
  return true;
}

/* ---------- 导出 Excel（两端共用底层） ---------- */
/** 生成 Excel 工作簿对象（不落盘），由调用方决定怎么保存 */
function buildWorkbook(stat, monthLabel) {
  const wb = XLSX.utils.book_new();

  // 动态列：晚修分段 + 所有名单制栏目 + 临时岗位
  const segLabels = activeSegments().map(s => s.label);
  const rosterLabels = rosterPosts().map(k => DATA.posts[k].name);
  const rosterSet = new Set(rosterLabels);
  const tempLabels = Object.keys(DATA.duties).filter(d => !rosterSet.has(d));
  const cols = [...segLabels, ...rosterLabels, ...tempLabels];

  /* ---- Sheet1 次数汇总（每人一行，栏目分列，不含金额） ---- */
  const head1 = ['姓名', ...cols.map(d => d + '(次)'), '合计次数'];
  const body1 = stat.rows.map(r => {
    const line = [r.name];
    for (const d of cols) line.push(r.duty[d] || 0);
    line.push(r.times);
    return line;
  });
  const foot1 = ['合计',
    ...cols.map(d => stat.rows.reduce((s, r) => s + (r.duty[d] || 0), 0)),
    stat.totals.times];
  const ws1 = XLSX.utils.aoa_to_sheet([head1, ...body1, foot1]);
  ws1['!cols'] = [{ wch: 12 }, ...Array(cols.length + 1).fill({ wch: 11 })];
  XLSX.utils.book_append_sheet(wb, ws1, '次数汇总');

  /* ---- Sheet2 栏目小计（只列次数与人数，不列单价/金额） ---- */
  const head2 = ['栏目', '次数', '涉及人数', '占比'];
  const body2 = Object.values(stat.byPost)
    .filter(p => p.times > 0)
    .map(p => [p.name, p.times, p.headcount,
      stat.totals.times ? (p.times / stat.totals.times * 100).toFixed(1) + '%' : '0%']);
  const foot2 = ['合计', stat.totals.times, stat.totals.headcount, '100%'];
  const ws2 = XLSX.utils.aoa_to_sheet([head2, ...body2, foot2]);
  ws2['!cols'] = [{ wch: 14 }, { wch: 8 }, { wch: 10 }, { wch: 8 }];
  XLSX.utils.book_append_sheet(wb, ws2, '栏目小计');

  /* ---- Sheet3 值班明细（每条一行，标明栏目，不含金额） ---- */
  const head3 = ['日期', '星期', '单双周', '栏目', '姓名', '分段/班级', '次数', '备注'];
  const body3 = stat.detail.map(d => {
    const d0 = parseYmd(d.date);
    const postName = DATA.posts[d.post] ? DATA.posts[d.post].name : d.duty;
    return [
      d.date, '星期' + WEEK_CN[isoDow(d0) - 1],
      parityOf(d.date) === 'single' ? '单周' : '双周',
      postName, d.teacher,
      d.classes === '' ? (d.segKey ? d.duty : '') : d.classes + '班',
      d.sections, d.note
    ];
  });
  const ws3 = XLSX.utils.aoa_to_sheet([head3, ...body3]);
  ws3['!cols'] = [{ wch: 12 }, { wch: 7 }, { wch: 7 }, { wch: 11 }, { wch: 12 },
                   { wch: 11 }, { wch: 7 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, ws3, '值班明细');

  // ---- Sheet4 需人工确认 ----
  if (stat.anomalies.length) {
    const body4 = stat.anomalies.map(a => [a.date, a.teacher, a.classes.join('、'), a.msg]);
    const ws4 = XLSX.utils.aoa_to_sheet([['日期', '姓名', '涉及班级', '提示'], ...body4]);
    ws4['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 20 }, { wch: 54 }];
    XLSX.utils.book_append_sheet(wb, ws4, '需人工确认');
  }
  return wb;
}

/** 生成 CSV 文本（含栏目列，不含金额） */
function detailCSV(stat) {
  const head = '日期,星期,单双周,栏目,姓名,分段/班级,次数,备注';
  const lines = [head];
  stat.detail.forEach(d => {
    const postName = DATA.posts[d.post] ? DATA.posts[d.post].name : d.duty;
    lines.push([
      d.date, '星期' + WEEK_CN[isoDow(parseYmd(d.date)) - 1],
      parityOf(d.date) === 'single' ? '单周' : '双周',
      postName, d.teacher,
      d.classes === '' ? (d.segKey ? d.duty : '') : d.classes + '班',
      d.sections,
      '"' + String(d.note || '').replace(/"/g, '""') + '"'
    ].join(','));
  });
  return lines.join('\n');
}

/** 转成二进制（小程序写文件用） */
function workbookBinary(wb) {
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
}

/* ---------- CommonJS 导出（小程序端使用） ---------- */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_DATA, LS_KEY,
    pad, ymd, parseYmd, isoDow, deepClone, WEEK_CN,
    parityOf, templateFor, isWorkday, canDutyOn, isMakeUpWorkday, weekNoOf, teacherOn, pickSeg, allSegsOn, activeSegments,
    hasEvening, isDayEdited,
    computeStats, parseWorkbook, templatesFromParse,
    rosterPosts, rosterOn, isRosterEdited, setRosterItem, delRosterItem,
    rosterSum, rosterRange, rosterSegOf, rateOf, segLabelOf, segSplitOf,
    segCountOf, segRateList,
    markChanged, recentChanges,
    knownPeople, matchPerson, extractDate, extractTimes,
    parseRosterLines, parseRosterWorkbook, parseRosterText, applyRosterItems,
    setStorage, load, save, resetAll, getData, setData,
    backupJSON, restoreJSON,
    buildWorkbook, workbookBinary, detailCSV, exportStatsXlsx
  };
}