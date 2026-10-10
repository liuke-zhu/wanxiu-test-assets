/** 时间转成「刚刚 / x 分钟前 / 昨天 / x月x日」 */
function timeText(ts) {
  const d = new Date(ts), n = new Date();
  const diff = (n - d) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 172800) return '昨天';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/* 轻提示（与 alert 区分，用于可恢复的错误） */
function wx_like_alert(msg) {
  const t = document.getElementById('toast');
  if (!t) { alert(msg); return; }
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(window._alertTT);
  window._alertTT = setTimeout(() => t.classList.remove('on'), 5200);
}

const THEMES = [
  { id:'rose',    name:'莫兰迪粉', desc:'灰藕粉 · 方格纸', color:'#c9a2ab',
    grid:'rgba(201,162,171,.18)', sw:1 },
  { id:'morandi', name:'莫兰迪蓝', desc:'雾霾蓝 · 方格纸', color:'#7e96ab',
    grid:'rgba(126,150,171,.17)', sw:1 },
  { id:'hex',     name:'蜂窝紫',   desc:'六边形 · 化学感', color:'#5b4b8a',
    grid:'rgba(91,75,138,.13)', sw:1 },
  { id:'indigo',  name:'靛蓝',     desc:'经典蓝 · 方格纸', color:'#2563eb',
    grid:'rgba(37,99,235,.13)', sw:1 },
  { id:'jade',    name:'松石绿',   desc:'温润 · 方格纸',   color:'#4a7c6f',
    grid:'rgba(74,124,111,.13)', sw:1 },
  { id:'amber',   name:'暖阳米',   desc:'纸纹 · 纸质感',   color:'#b06c3f',
    grid:'rgba(176,108,63,.12)', sw:1 },
  { id:'slate',   name:'墨玉灰',   desc:'纯色 · 无纹理',   color:'#334155',
    grid:'transparent', sw:0 }
];

/* ============================ 应用层 ============================ */
const App = {
  ym: null,          // 当前月份 'YYYY-MM'
  sel: null,         // 选中日期
  page: 'cal',
  view: 'grid',      // grid=矩阵(默认，按Excel) / day=当天列表

  init() {
    /* ⚠️ 必须先把 localStorage 注入给 core 的存储层，再 load()。
       core.js 里 _local 默认是个「空实现」（getItem 永远返回 null、
       setItem 什么也不做），本意是留给小程序用 wx.setStorageSync 的。
       网页端一直没调用 setStorage()，于是：
         load() 读不到任何东西 → 每次打开都是默认的空数据
         save() 写不进去         → 所有改动刷新即丢（登记、排班都一样）
       这是"登记晚一刷新就没有"的根因。 */
    if (typeof setStorage === 'function') {
      setStorage({
        getItem: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
        setItem: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { console.warn(e); } },
        removeItem: k => { try { localStorage.removeItem(k); } catch (e) {} }
      });
    }
    load();
    // 默认全名（老师名字要看得清，不截断）
    this.fullName = true;   // 始终显示完整姓名
    // 恢复上次选的主题
    let th = 'rose';
    try { th = localStorage.getItem('wx.theme') || 'rose'; } catch(e) {}
    if (th !== 'rose') {
      document.documentElement.setAttribute('data-theme', th);
      if ((THEMES.find(x => x.id === th) || {}).sw === 0) document.body.classList.add('nogrid');
    }
    this.showBuild();
    this.autoCheckVer();     // 自动检查更新（微信里缓存很顽固）
    this._theme = th;
    // 栏目偏好
    this.post = 'evening';
    try { this.post = localStorage.getItem('wx.post') || 'evening'; } catch(e) {}
    if (!DATA.posts[this.post]) this.post = 'evening';
    const n = new Date();
    /* 默认停在今天 */
    this.ym = `${n.getFullYear()}-${pad(n.getMonth()+1)}`;
    this.sel = ymd(n);
    /* 但如果她上次停在别的一天/别的一个月，就回到那里 ——
       刷新只是重新加载，不该把她拽回今天。 */
    let lastSel = '';
    try { lastSel = localStorage.getItem('wx.sel') || ''; } catch (e) {}
    if (lastSel && /^\d{4}-\d{2}-\d{2}$/.test(lastSel) && parseYmd(lastSel)) {
      this.sel = lastSel;
      const d0 = parseYmd(lastSel);
      this.ym = `${d0.getFullYear()}-${pad(d0.getMonth() + 1)}`;
    }
    this.renderCal();
    this._bindMain();     // 弹层里的当天明细（任何栏目都要能点）
    this.setPost(this.post);
    this.buildSettings();
    /* 最后回到她上次待的那一页（排班表 / 统计 / 设置）。
       放最后是因为 setPost、buildSettings 都会重画，必须让页面状态在它们之后再恢复。 */
    let lastPage = '';
    try { lastPage = localStorage.getItem('wx.page') || ''; } catch (e) {}
    this.tab(lastPage === 'st' || lastPage === 'set' ? lastPage : 'cal');
    /* 多设备同步：先拉云端（拿到别的设备上的改动），
       再把宿管登记自动写进去，最后把结果推回云端。 */
    this._syncNowInner({ quiet: true }).then(() => this.autoApplyDorm());
  },

  /* ---------- 导航 ---------- */
  /**
   * ‹ › 切的是**教学周**（第1周 → 第2 周 → …），不是月份。
   * 教学周的起点由设置里的「第 1 周的周一」决定。
   */
  go(d, what) {
    if (what === 'w') {
      const cur = weekNoOf(this.sel) || 1;
      const w = Math.max(1, cur + d);
      const mon = this._week1Monday();
      const dt = new Date(mon);
      dt.setDate(dt.getDate() + (w - 1) * 7);
      this.sel = ymd(dt);
      this.ym = dt.getFullYear() + '-' + pad(dt.getMonth() + 1);
    } else if (what === 'm') {
      const [y,m] = this.ym.split('-').map(Number);
      const dt = new Date(y, m-1+d, 1);
      this.ym = `${dt.getFullYear()}-${pad(dt.getMonth()+1)}`;
      this.sel = ymd(dt);
    }
    this._saveWhere();     // 记住翻到哪一页/哪一天
    this.renderAll();
  },

  /** 第 1 周那个周一（周次导航的锚点） */
  _week1Monday() {
    const s = (DATA.meta && (DATA.meta.termWeek1Monday || DATA.meta.firstMonday)) || '';
    return s ? parseYmd(s) : parseYmd(this.sel);
  },

  /** 这一学期的总周数（从第 1 周到今天所在周，向后多算 8 周方便排后面） */
  _totalWeeks() {
    const cur = weekNoOf(this.sel) || 1;
    return Math.max(cur + 8, 20);
  },

  /** 点周次文字 → 弹列表选任意一周 */
  weekPicker() {
    const total = this._totalWeeks();
    const cur = weekNoOf(this.sel) || 1;
    let h = '<div class="wk-pick">';
    for (let w = 1; w <= total; w++) {
      const mon = this._week1Monday();
      const dt = new Date(mon);
      dt.setDate(dt.getDate() + (w - 1) * 7);
      const d1 = new Date(dt);            d1.setDate(dt.getDate());
      const d7 = new Date(dt);            d7.setDate(dt.getDate() + 6);
      const f = x => `${x.getMonth() + 1}月${x.getDate()}日`;
      const isCur = w === cur;
      h += `<button class="wk-i${isCur ? ' on' : ''}" data-w="${w}">`
        + `<b>第${w}周</b>`
        + `<span>${f(d1)} – ${f(d7)}</span>`
        + (isCur ? '<i>当前</i>' : '')
        + '</button>';
    }
    h += '</div>';
    h += '<div class="wk-tip">周次从设置里的「第 1 周的周一」开始算</div>';
    this.openSheet('选择周次', h,
      '<button class="btn btn-p" onclick="App.closeSheet()">关闭</button>');
  },

  /** 选完周次 → 跳过去 */
  gotoWeek(w) {
    const mon = this._week1Monday();
    const dt = new Date(mon);
    dt.setDate(dt.getDate() + (Number(w) - 1) * 7);
    this.sel = ymd(dt);
    this.ym = dt.getFullYear() + '-' + pad(dt.getMonth() + 1);
    this.closeSheet();
    this._saveWhere();     // 记住翻到哪一周
    this.renderAll();
  },

  setView(v) {
    // 保留兼容：现在只有表格视图，当天明细改由行首日期弹出
    this.view = 'grid';
  },

  tab(p) {
    this.page = p;
    /* 记住"停在哪一页"，刷新/关掉重开后回到原处，而不是一律回到排班表 */
    try { localStorage.setItem('wx.page', p); } catch (e) {}
    // 页面容器
    document.querySelectorAll('.pg').forEach(g => g.classList.toggle('on', g.id === 'pg-' + p));
    // body 加标记，CSS 据此隐藏底部按钮
    document.body.classList.remove('pg-cal', 'pg-st', 'pg-set');
    document.body.classList.add('pg-' + p);
    // 底部统计按钮的选中态
    const bt = document.getElementById('btabSt');
    if (bt) bt.classList.toggle('on', p === 'st');
    // 齿轮高亮（在设置页时）
    document.querySelectorAll('.hd-gear').forEach(g =>
      g.classList.toggle('on', p === 'set'));
    this.renderAll();
    window.scrollTo(0, 0);
  },

  /** 让当前栏目在栏内横向居中（内容超宽时才需要滑动） */
  _centerPost() {
    const bar = document.getElementById('postbar');
    const cur = bar && bar.querySelector('button.on');
    if (!bar || !cur) return;
    // 内容装得下 → CSS 已经居中，不用滑
    if (bar.scrollWidth <= bar.clientWidth + 1) { bar.scrollLeft = 0; return; }
    const want = cur.offsetLeft - (bar.clientWidth - cur.offsetWidth) / 2;
    bar.scrollTo({ left: Math.max(0, want), behavior: 'smooth' });
  },

  /** 事件委托：当天明细里的所有操作（表格页与弹层共用） */
  _dayAction(e) {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const { act, ds } = t.dataset;
    const cls = t.dataset.gc;          // 只转发某一个班时才有值
    const sg  = t.dataset.sg || '';    // 从选人界面转发时=段别（s1/s2/…）
    const fn = ({
      pickT:     () => { this._pickClsList = String(t.dataset.c);
                          this.pickTeacher(ds, +t.dataset.c); },
      hol:       () => this.toggleHoliday(ds),
      resetDay:  () => this.resetDay(ds),
      addEx:     () => this.addExtra(ds),
      editEx:    () => this.editExtra(ds, t.dataset.id),
      copy:      () => this.copyDay(ds),
      stat:      () => this.stat(ds),
      share:     () => this.shareSheet(ds, cls, sg),
      dormApply: () => this.dormApply(ds),
      dormClear: () => this.dormClear(ds)
    })[act];
    if (!fn) return;
    e.stopPropagation();
    fn();
  },

  /** 事件委托：主面板按钮 */
  _bindMain() {
    const el = document.getElementById('daypanel');
    if (el._bound) return;
    el._bound = true;
    el.addEventListener('click', e => this._dayAction(e));

    /* 弹层里的当天明细（#sh-b）与底部按钮条（#sh-f）走同一套逻辑。
       #sh-f 必须单独绑 ——「转发给宿管」就放在弹层底部，
       只绑 #sh-b 的话点它没反应。 */
    for (const id of ['sh-b', 'sh-f']) {
      const el2 = document.getElementById(id);
      if (el2 && !el2._dayBound) {
        el2._dayBound = true;
        el2.addEventListener('click', e => this._dayAction(e));
      }
    }
  },

/** 事件委托：视图切换 + 矩阵格子 */
  _bindGrid() {
    // 切换按钮在 #pg-cal 里，格子在 #gridwrap 里，统一绑到 #pg-cal
    const el = document.getElementById('pg-cal');
    if (!el || el._gridBound) return;
    el._gridBound = true;

    el.addEventListener('click', e => {
      // 点行首日期 → 弹出当天明细
      const rh = e.target.closest('.gx-rowh[data-gxday]');
      if (rh) { this.openDaySheet(rh.dataset.gxday); return; }
      /* 已登记名字后面的 ✕ —— 先于「整行点击」处理，
         否则点删除会连带弹起编辑弹层，等于点了个寂寞。 */
      const xr = e.target.closest('[data-del-ro]');
      if (xr) {
        e.stopPropagation();
        this._delQuickFromTable = true;   /* 标记来源：主表格那几行 */
        this.delRosterQuick(xr.dataset.ids, xr.dataset.delRo);
        return;
      }
      // 放假 / 周末行 → 跳到「周末值班」栏目，定位到那一天
      const hd = e.target.closest('[data-gxduty]');
      if (hd && hd.dataset.gxduty) {
        this.post = 'weekend';
        try { localStorage.setItem('wx.post', 'weekend'); } catch (err) {}
        this.sel = hd.dataset.gxduty;
        this._saveWhere();
        this.renderCal();
        this.renderPostBar();
        this.renderChangeBar();
        this.renderRoster('weekend');
        this._bindRoster();
        this.rosterSheet('weekend', null, hd.dataset.gxduty);
        return;
      }
      const g = e.target.closest('.gx-cell[data-gx]');
      /* data-cls 是这一格覆盖的全部班级（相邻同一人会合并成一格） */
      if (g) this.gridPick(g.dataset.ds, +g.dataset.c, g.dataset.cls || '');
    });

    /* 原来的「长按格子清空」已去掉：
       手机上长按容易和滚动/选中文字冲突，误清空后很难察觉。
       现在清空只有一个明确入口：点格子 → 选人面板 → 清空此段。 */
  },

  /** 事件委托：顶部标签栏 + 月份切换 */
  _bindTabs() {
    const el = document.querySelector('.topbar');
    if (el && !el._tabBound) {
      el._tabBound = true;
      el.addEventListener('click', e => {
        // 右上角齿轮 → 设置
        const g = e.target.closest('.hd-gear[data-p]');
        if (g) { this.tab(g.dataset.p); return; }
        const n = e.target.closest('.hd-btn[data-move]');
        if (n) this.go(+n.dataset.move, 'w');
      });
    }
    /* 底部统计按钮 */
    const bs = document.getElementById('btabSt');
    if (bs && !bs._bound) {
      bs._bound = true;
      bs.addEventListener('click', () => this.tab('st'));
    }
    if (!document.body._moveBound) {
      document.body._moveBound = true;
      document.body.addEventListener('click', e => {
        const n = e.target.closest('.mbar [data-move]');
        if (n) this.go(+n.dataset.move, 'w');
      });
    }
  },

  /** 事件委托：栏目栏 + 统计页栏目小计卡（两处都在 topbar 之外） */
  _bindPost() {
    const bar = document.getElementById('postbar');
    if (bar && !bar._bound) {
      bar._bound = true;
      bar.addEventListener('click', e => {
        const b = e.target.closest('[data-post]');
        if (!b) return;
        this.setPost(b.dataset.post);
        this.tab('cal');
      });
    }
    const pg = document.getElementById('pg-st');
    if (pg && !pg._bound) {
      pg._bound = true;
      pg.addEventListener('click', e => {
        const c = e.target.closest('[data-go-post]');
        if (!c) return;
        this.post = c.dataset.goPost;
        try { localStorage.setItem('wx.post', this.post); } catch(e) {}
        this.tab('cal');
      });
    }
  },

  /** 事件委托：导入列表 */
  _bindImport() {
    const el = document.getElementById('mask');
    if (el._impBound) return;
    el._impBound = true;
    el.addEventListener('click', e => {
      const t = e.target.closest('[data-act="doImport"]');
      if (t) this.confirmImport(+t.dataset.i);
    });
  },

  renderAll() {
    if (this.page === 'cal') {
      this.renderPostBar();
      this.renderChangeBar();
      const p = DATA.posts[this.post || 'evening'];
      if (p && p.kind === 'roster') { this.renderRoster(this.post); this._bindRoster(); }
      else {
        this.renderCal();
        this.renderGrid(); this._bindGrid();
        this._bindMain();          // 弹层里的当天明细
      }
    }
    if (this.page === 'st')  this.renderStats();
    if (this.page === 'set') this.buildSettings();
  },

  toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('on');
    clearTimeout(this._tt);
    this._tt = setTimeout(()=>t.classList.remove('on'), 2100);
  },

  /* ---------- 月历 ---------- */
  renderCal() {
    /* ⭐ 关键：`ym` 决定表格渲染哪个月，`sel` 决定"选中哪天"。
       切周次时两个都会变，但任何只改 sel 不改 ym 的路径
       （日历点选、程序内部跳转）都会让它们脱节，
       表现是「标签写着第6周、表里却是上个月」。
       所以这里以 sel 为准，ym 永远跟着 sel 走。 */
    const selD0 = parseYmd(this.sel);
    if (selD0) {
      this.ym = selD0.getFullYear() + '-' + pad(selD0.getMonth() + 1);
    }
    const [y,m] = this.ym.split('-').map(Number);
    this._renderWeekLabel();

    const wd = ['一','二','三','四','五','六','日'];
    document.getElementById('cw').innerHTML =
      wd.map(d=>`<div>${d}</div>`).join('');

    const first = new Date(y, m-1, 1);
    let lead = first.getDay() - 1;          // 周一为首列
    if (lead < 0) lead = 6;
    const dim = new Date(y, m, 0).getDate();
    const today = ymd(new Date());

    let html = '';
    // 上月补白
    const pm = new Date(y, m-2, 1);
    const pdim = new Date(y, m-1, 0).getDate();
    for (let i=lead-1; i>=0; i--) {
      const d = new Date(y, m-2, pdim-i);
      html += `<div class="day out">${pdim-i}</div>`;
    }
    for (let d=1; d<=dim; d++) {
      const ds = `${y}-${pad(m)}-${pad(d)}`;
      const dow = new Date(y, m-1, d).getDay();
      const isWk = dow===0 || dow===6;
      const hol = DATA.holidays.includes(ds);
      const edited = isDayEdited(ds);
      const ex = (DATA.extras[ds]||[]).length;

      let dots = '';
      if (edited) {
        const t = DATA.templates[templateFor(ds)];
        const seen = {};
        DATA.meta.classes.forEach(c=>{ const x=teacherOn(ds,c); if(x) seen[x]=(seen[x]||0)+1; });
        const hasDorm = Object.keys(seen).some(k=>DATA.dormStaff.includes(k));
        const colors = [];
        if (ex) colors.push('var(--blue)');
        if (hasDorm) colors.push('var(--purple)');
        if (colors.length) dots = colors.slice(0,3).map(c=>`<i style="background:${c}"></i>`).join('');
        else dots = `<i></i>`;
      }

      const cls = ['day'];
      if (hol) cls.push('hol');
      else if (isWk) cls.push('wk');
      if (edited) cls.push('ed');
      if (ds===today) cls.push('today');
      if (ds===this.sel) cls.push('sel');
      html += `<div class="${cls.join(' ')}" onclick="App.pick('${ds}')">${d}<div class="dots">${dots}</div></div>`;
    }
    // 下月补白补满 7 的整数倍
    const total = lead + dim;
    const tail = (7 - total % 7) % 7;
    for (let i=1; i<=tail; i++) html += `<div class="day out">${i}</div>`;

    document.getElementById('cg').innerHTML = html;
  },

  /** 记住"停在哪一页 + 哪一天"，刷新后回到原处 */
  _saveWhere() {
    try {
      localStorage.setItem('wx.page', this.page || 'cal');
      localStorage.setItem('wx.sel', this.sel || '');
    } catch (e) { /* 无痕模式写不了就算了，不影响使用 */ }
  },

  pick(ds) { this.sel = ds; this._saveWhere(); this.renderCal(); this.renderGrid(); },

  /* ---------- 矩阵视图（按 Excel 布局：行=星期，列=班级）---------- */
  renderGrid() {
    const box = document.getElementById('gridbox');
    if (!box) return;
    const [y, m] = this.ym.split('-').map(Number);
    const classes = DATA.meta.classes;
    const tpl = DATA.templates[templateFor(this.sel)];
    const fullCls = ' gx-full';

    /* ---------- 找出「选中日所在那一周」的所有日期 ---------- */
    const dim = new Date(y, m, 0).getDate();
    const selD0 = parseYmd(this.sel);
    const selMon = new Date(selD0);
    selMon.setDate(selD0.getDate() - (isoDow(selD0) - 1));

    // dateByDow[dow] = 该周里这个星期几的日期
    const dateByDow = {};
    for (let d = 1; d <= dim; d++) {
      const ds = `${y}-${pad(m)}-${pad(d)}`;
      const dt = parseYmd(ds);
      const mon = new Date(dt);
      mon.setDate(dt.getDate() - (isoDow(dt) - 1));
      if (mon.getTime() !== selMon.getTime()) continue;
      dateByDow[isoDow(dt)] = ds;
    }

    // 本月首周可能不完整（比如 1 号是周四）→ 允许借用前后周的日期
    const borrow = !dateByDow[1] || !dateByDow[4] || !dateByDow[5];
    if (borrow) {
      const pmY = m === 1 ? y - 1 : y;
      const pmM = m === 1 ? 12 : m - 1;
      const pdim = new Date(pmY, pmM, 0).getDate();
      for (let d = 1; d <= pdim; d++) {
        const ds = `${pmY}-${pad(pmM)}-${pad(d)}`;
        const dt = parseYmd(ds);
        const mon = new Date(dt);
        mon.setDate(dt.getDate() - (isoDow(dt) - 1));
        if (mon.getTime() !== selMon.getTime()) continue;
        const dw = isoDow(dt);
        if (!dateByDow[dw]) dateByDow[dw] = ds;    // 只补空缺
      }
      const nmM = m === 12 ? 1 : m + 1;
      const nmY = m === 12 ? y + 1 : y;
      const ndim = new Date(nmY, nmM, 0).getDate();
      for (let d = 1; d <= ndim; d++) {
        const ds = `${nmY}-${pad(nmM)}-${pad(d)}`;
        const dt = parseYmd(ds);
        const mon = new Date(dt);
        mon.setDate(dt.getDate() - (isoDow(dt) - 1));
        if (mon.getTime() !== selMon.getTime()) continue;
        const dw = isoDow(dt);
        if (!dateByDow[dw]) dateByDow[dw] = ds;
      }
    }

    // 显示周一~周四（模板里有排班的星期几）
    const usedDows = new Set();
    for (let dw = 1; dw <= 4; dw++) if (tpl && tpl.grid && tpl.grid[dw]) usedDows.add(dw);
    const dows = [...usedDows].sort((a, b) => a - b);
    if (!dows.length) { for (let dw = 1; dw <= 4; dw++) dows.push(dw); }
    // 本周若有「调休补课」落在周五/周六，也要把那天显示出来
    for (const ds in (DATA.meta.scheduleMap || {})) {
      const dw = isoDow(parseYmd(ds));
      if (dw >= 5 && dateByDow[dw] === ds) dows.push(dw);
    }
    dows.sort((a, b) => a - b);

    // 单双周各覆盖哪几天
    const parOf = dw => (dateByDow[dw] ? parityOf(dateByDow[dw]) : null);
    /* 整周都显示，不隐藏任何一天。
       每一天标一个状态：
         ok  正常排班
         hol 法定节假日（置灰、不可点、不计费）
         mk  调休补课（周五/周六，照常排，但沿用别的星期的排班）
         off 本周没有这一天的日期 */
    const dayState = dw => {
      const ds = dateByDow[dw];
      if (!ds) return 'off';
      if ((DATA.holidays || []).includes(ds)) return 'hol';
      const d = parseYmd(ds);
      // 周五~周日：只有在调休映射里才上课
      if (isoDow(d) >= 5) return (DATA.meta.scheduleMap || {})[ds] ? 'mk' : 'off';
      return 'ok';
    };

    const singleDows = dows.filter(dw => parOf(dw) !== 'double');
    const doubleDows = dows.filter(dw => parOf(dw) === 'double');

    /* 该组覆盖的日期范围，如「10月5日–9日」 */
    const fmtRange = arr => {
      const ds = arr.map(dw => dateByDow[dw]).filter(Boolean).sort();
      if (!ds.length) return '';
      const a = ds[0], b = ds[ds.length - 1];
      const aTxt = `${+a.slice(5, 7)}月${+a.slice(8)}日`;
      const bTxt = a.slice(0, 7) === b.slice(0, 7)
        ? `${+b.slice(8)}日`
        : `${+b.slice(5, 7)}月${+b.slice(8)}日`;
      return `${aTxt}–${bTxt}`;
    };

    /* 原来这里有一条信息栏（左边模板名 + 右边操作提示），
       用户要求去掉 —— 表格直接贴上月份条更清爽。
       模板名在设置页「当前使用的排班模板」里照样能看到。 */
    let html = '';

    const groups = (tpl && tpl.mode !== 'all')
      ? [{ key:'single', label:'单周', cls:'g-s', dows:singleDows },
         { key:'double', label:'双周', cls:'g-d', dows:doubleDows }]
      : [{ key:'all', label:'本周排班', cls:'g-a', dows }];

    /* 原表排版的关键：相邻两班是同一位老师时，合并成一个格子、名字居中只写一次。
       例：1班李红该 2班（空） → 一个跨 2 列的格子写「李红该」 */
    const buildRow = (dw, g) => {
      const ds = dateByDow[dw] || null;
      const st = dayState(dw);

      // 逐班算出「这一格有哪些老师值哪几段」
      const cells = classes.map(c => {
        // 该格对应的真实日期
        let repDs = null;
        if (ds) {
          const par = parityOf(ds);
          if (g.key === 'all' || par === g.key) repDs = ds;
        }
        if (!repDs) {
          for (const dw2 of g.dows) {
            if (!dateByDow[dw2]) continue;
            const ds2 = dateByDow[dw2];
            if (g.key === 'all' || parityOf(ds2) === g.key) { repDs = ds2; break; }
          }
        }
        if (!repDs) return { c, repDs: null, lines: [] };

        const segs = activeSegments();
        const lines = segs.map(sg => ({
          key: sg.key, short: sg.short, t: teacherOn(repDs, c, sg.key)
        })).filter(l => l.t);
        return { c, repDs, lines };
      });

      /* 仿原表的合并规则：
         ① 相邻两班是同一位老师 → 合并（一人带两班）
         ② 老师后面跟着一个空班 → 空班并入这个老师的格子
            （原表里每位老师占 1~2 格，后面那个空格是"没排到"的意思，
              视觉上属于同一个人的地盘）
         一行里连续的空班不会全并给最后一个人 —— 超过 1 个连续空格就停止，
         剩下的空班独立显示，避免最后一个人占掉半张表。 */
      const merged = [];
      const keyOf = ls => {
        const u = [];
        for (const l of ls) { const f = u.find(x => x.t === l.t); if (f) f.n++; else u.push({ ...l, n: 1 }); }
        return u.map(x => `${x.t}#${x.n}`).sort().join('|');
      };
      for (const cell of cells) {
        const prev = merged[merged.length - 1];
        const myKey = keyOf(cell.lines);

        // ① 同一人相邻 → 合并
        if (prev && myKey && cell.lines.length && prev.key === myKey) {
          prev.span++; prev.classes.push(cell.c); prev.cells.push(cell);
          continue;
        }
        // ② 空班 → 并入前一个有老师的格子（只在连续空格不超过 1 个时）
        if (!cell.lines.length && prev && prev.key) {
          const trail = prev.trailingEmpty || 0;
          if (trail < 1) {
            prev.span++; prev.classes.push(cell.c); prev.cells.push(cell);
            prev.trailingEmpty = trail + 1;
            continue;
          }
        }
        merged.push({ key: myKey, span: 1, classes: [cell.c], cells: [cell],
                     trailingEmpty: 0 });
      }
      return { ds, st, merged };
    };

    for (const g of groups) {
      if (!g.dows.length) continue;
      html += `<div class="gx-group ${g.cls}">`;

      /* 原来这里有个日期范围标题（「10月5日–9日」），已按要求去掉。
         单双周仍靠底色区分（单周淡粉、双周淡绿）。 */

      html += `<div class="gx-scroll"><table class="gx">`;
      // colgroup 固定列宽，colspan 的合并格才能算对宽度
      html += `<colgroup><col class="gx-c-corner">${
        classes.map(() => '<col class="gx-c-cls">').join('')}</colgroup><thead>`;
      html += '<tr><th class="gx-corner gx-corner-b">班级</th>';
      for (const c of classes) html += `<th class="gx-cls">${c}班</th>`;
      html += '</tr></thead><tbody>';

      g.dows.forEach((dw, rowIdx) => {
        const { ds, st, merged } = buildRow(dw, g);

        /* 行首三行：
           第1行  星期几（周一）
           第2行  具体日期（10月6日）
           第3行  开学第几周（第6周）+ 状态标记（假 / 调） */
        const d0 = ds ? parseYmd(ds) : null;
        const wk = ds ? weekNoOf(ds) : 0;
        /* 今天：整行加 today 标记，行首显示「今天」而不是「周五」 */
        const isToday = ds && ds === ymd(new Date());
        let rowLabel = isToday
          ? '<b class="rh-wd rh-today">今天</b>'
          : `<b class="rh-wd">周${WEEK_CN[dw-1]}</b>`;
        if (d0) {
          /* 周次移到分组标题旁边了，这里只留日期 */
          rowLabel += `<em class="rh-dt">${d0.getMonth() + 1}月${d0.getDate()}日</em>`;
        } else {
          rowLabel += '<em class="rh-dt">—</em>';
        }
        if (isToday) {
          rowLabel += `<em class="rh-wd2">星期${WEEK_CN[dw-1]}</em>`;
        }
        if (st === 'hol') rowLabel += `<i class="gx-st hol">假</i>`;
        else if (st === 'mk') {
          const src = (DATA.meta.scheduleMap || {})[ds] || '';
          rowLabel += `<i class="gx-st mk" title="沿用 ${src} 的排班">调</i>`;
        }
        // 行首可点：点日期 → 打开当天明细
        rowLabel += '<span class="rh-more" aria-hidden="true">›</span>';
        // 隔行深色（原表的斑马纹）
        const zeb = rowIdx % 2 === 1 ? ' zeb' : '';
        html += `<tr class="gx-row st-${st}${zeb}${isToday ? ' today' : ''}"><th class="gx-rowh${
          ds ? ' rowh-tap' : ''}"${ds ? ` data-gxday="${ds}"` : ''} title="${
          ds ? esc(`${ds}　查看当天明细`) : ''}">${rowLabel}</th>`;

        /* 放假 / 周末：整行合并，显示当天来值班的老师 */
        if (st === 'hol' || st === 'off') {
          /* 所有名单制栏目都要能看到，不只是周末值班。
             哪一栏登记的都会体现在这里 —— 她在弹层里登记完，
             回到这个表格就该直接看到人名，不用再点进去确认。 */
          const duty = [];
          for (const _pk of rosterPosts()) {
            for (const it of (rosterOn(ds, _pk) || [])) {
              if (it.teacher) duty.push({ ...it, _pk });
            }
          }
          const names = duty.filter(x => x.teacher);
          if (names.length) {
            const uniqD = [];
            for (const it of names) {
              const f = uniqD.find(u => u.teacher === it.teacher);
              /* 只有按段计费的栏目才标段别，不分段的标出来是误导 */
              const sl = DATA.posts[it._pk] && DATA.posts[it._pk].bySeg
                ? segLabelOf(rosterSegOf(it)) : '';
              if (f) { if (sl) f.segs.add(sl); f.times += Number(it.times) || 0; }
              else uniqD.push({ teacher: it.teacher, times: Number(it.times) || 0,
                                segs: new Set(sl ? [sl] : []) });
            }
            /* 每个名字后面挂一个 ❎，点一下直接删掉这一条。
               登记错了要能马上改 —— 不用先点进弹层再点删除。 */
            const chips = uniqD.map(u => {
              /* 同一个人可能分了多笔登记（不同栏目/不同段），
                 那就把他的 id 都带上，删一次全清掉。 */
              const ids = duty.filter(x => x.teacher === u.teacher)
                             .map(x => x.id).filter(Boolean).join(',');
              return `<span class="hr-chip">
                  <b>${esc(u.teacher)}</b><i>${esc([...u.segs].join(''))}${
                    u.times > 1 ? ` ${u.times}次` : ''}</i>
                  <span class="hr-x" data-del-ro="${esc(ds)}"
                        data-ids="${esc(ids)}" title="删掉这条登记">✕</span>
                </span>`;
            }).join('');
            html += `<td class="gx-cell holrow" colspan="${classes.length}"
              data-gx="1" data-gxduty="${this.repDsKey(ds)}"
              title="${esc(`${ds}　已登记：${uniqD.map(u => u.teacher).join('、')}\n（点名字修改，点 ✕ 删除）`)}"><div class="hr-in">${chips}</div></td>`;
          } else {
            html += `<td class="gx-cell holrow none" colspan="${classes.length}" data-gx="1"
              data-gxduty="${this.repDsKey(ds)}"
              title="${esc(`${ds}　${st === 'hol' ? '放假不排晚修' : '非排班日'}\n（点击进行值班登记）`)}"><div class="hr-in">${
              st === 'hol' ? '<b>值班登记<i>›</i></b>' : '非排班日'}</div></td>`;
          }
          html += '</tr>';
          return;
        }

        for (const mg of merged) {
          const first = mg.cells[0];
          const repDs = first.repDs;
          const lines = first.lines;
          const isDorm = lines.some(l => DATA.dormStaff.includes(l.t));
          const ov = (repDs && DATA.overrides[repDs]) || {};
          const isOv = repDs && mg.classes.some(c =>
            Object.prototype.hasOwnProperty.call(ov, c));

          let cls = 'gx-cell';
          if (!lines.length) cls += ' empty';
          if (isOv) cls += ' ed';
          if (isDorm) cls += ' dorm';
          if (repDs === this.sel) cls += ' sel';
          if (mg.span > 1 && mg.cells.some(x => !x.lines.length)) cls += ' mixed';

          /* 同一人值多段 → 名字只写一次 */
          const uniq = [];
          for (const l of lines) {
            const f = uniq.find(u => u.t === l.t);
            if (f) f.n++; else uniq.push({ ...l, n: 1 });
          }

          /* 什么时候才写"n段"？
             全班都是同一段时不写（普遍安排，不是特殊情况）；
             只有一段二段分开时，才分成两行各自标清。 */
          const sp = segSplitOf(lines);

          let inner;
          if (!lines.length) {
            inner = `<span class="gx-blank"></span>`;
          } else if (sp.mixed) {
            /* 段别混着 → 分两行，各自标清是哪一段 */
            const groups = [];
            for (const u of uniq) {
              const g = groups.find(x => x.short === u.short);
              if (g) g.names.push(u.t);
              else groups.push({ short: u.short, names: [u.t] });
            }
            inner = '<span class="gx-multi">' + groups.map(g =>
              `<span class="ln"><b>${esc(g.short.replace('晚修', ''))}</b>${
                esc(g.names.join('、'))}</span>`).join('') + '</span>';
          } else if (uniq.length === 1) {
            inner = `<span class="gx-nm">${esc(uniq[0].t)}</span>`;
          } else {
            /* 全班同一段 → 名字平铺，不标段别 */
            inner = '<span class="gx-flat">' + uniq.map(u =>
              `<span>${esc(u.t)}</span>`).join('') + '</span>';
          }

          const clsTxt = mg.classes.join('、');
          // 这格覆盖了几个真有人值的班（空班不算）
          const realCnt = mg.cells.filter(x => x.lines.length).length;
          const extra = [];
          if (realCnt > 1) extra.push(`一人带 ${realCnt} 个班，只计 1 次`);
          if (mg.span > realCnt) extra.push(`含${mg.span - realCnt} 个未排班`);
          const tip = lines.length
            ? `${repDs} 周${WEEK_CN[dw-1]} ${clsTxt}班　`
              + lines.map(l => `${l.short} ${l.t}`).join(' / ')
              + (extra.length ? `\n（${extra.join('；')}）` : '')
              + '\n（点击可分别修改）'
            : `${repDs} 周${WEEK_CN[dw-1]} ${clsTxt}班　空缺`;

          html += `<td class="${cls}"${mg.span > 1 ? ` colspan="${mg.span}"` : ''}
            data-gx="1" data-ds="${repDs || ''}" data-c="${mg.classes[0]}"
            data-cls="${mg.classes.join(',')}"
            title="${esc(tip)}">${inner}</td>`;
        }
        html += '</tr>';
      });
      html += '</tbody></table></div></div>';
    }

    box.innerHTML = html;
  },


    /* ---------- 栏目（七个值班栏目）---------- */
  /** 渲染顶部栏目栏 */
  renderPostBar() {
    const bar = document.getElementById('postbar');
    if (!bar) return;
    const posts = DATA.posts || {};
    const keys = Object.keys(posts);
    bar.innerHTML = keys.map(k => {
      const p = posts[k];
      const on = (this.post || 'evening') === k;
      return `<button class="${on ? 'on' : ''}" data-post="${k}">
        <span class="pi">${p.icon}</span>
        <span class="pn">${esc(p.name)}</span>
      </button>`;
    }).join('');
    // 当前栏目横向居中显示（切栏目时不用手动滑）；装得下就不动
    requestAnimationFrame(() => {
      const bar2 = document.getElementById('postbar');
      if (bar2 && bar2.scrollWidth > bar2.clientWidth + 1) this._centerPost();
    });
  },

  setPost(k) {
    this.post = (DATA.posts && DATA.posts[k]) ? k : 'evening';
    try { localStorage.setItem('wx.post', this.post); } catch(e) {}
    this.renderPostBar();

    const p = DATA.posts[this.post];
    const isGrid = p.kind === 'grid';

    // 显隐各容器（不再有视图切换，gridwrap 常显）
    document.getElementById('gridwrap').style.display = isGrid ? '' : 'none';
    document.getElementById('rosterwrap').style.display = isGrid ? 'none' : '';
    document.getElementById('calwrap').style.display = 'none';

    this.renderChangeBar();
    this._centerPost();
    if (isGrid) {
      this.renderGrid(); this._bindGrid();
      this._bindMain();
    } else {
      this.renderRoster(this.post);
      this._bindRoster();
    }
  },

  /** 名单制栏目页面 */
  renderRoster(pk) {
    const box = document.getElementById('rosterbox');
    if (!box) return;
    const p = DATA.posts[pk];
    const [y, m] = this.ym.split('-').map(Number);
    const dim = new Date(y, m, 0).getDate();
    const from = `${y}-${pad(m)}-01`, to = `${y}-${pad(m)}-${pad(dim)}`;
    const items = rosterRange(pk, from, to);

    /* 周末值班常常跨月（国庆前一天可能在 9 月底），
       所以额外把「相邻月份」的记录也列出来，避免录完看不见。 */
    let nearItems = [];
    if (pk === 'weekend' || pk === 'overtime') {
      const r = DATA.roster[pk] || {};
      const pmY = m === 1 ? y - 1 : y, pmM = m === 1 ? 12 : m - 1;
      const nmY = m === 12 ? y + 1 : y, nmM = m === 12 ? 1 : m + 1;
      for (const d in r) {
        if (d.slice(0, 7) === `${y}-${pad(m)}`) continue;      // 本月已在 items 里
        if (d.slice(0, 7) !== `${pmY}-${pad(pmM)}` && d.slice(0, 7) !== `${nmY}-${pad(nmM)}`) continue;
        (r[d] || []).forEach(it => {
          if (!it.teacher) return;
          const sg = rosterSegOf(it);
          nearItems.push({ date: d, ...it, seg: sg, amount: (it.times || 0) * rateOf(pk, sg) });
        });
      }
    }

    // 本月汇总（只统计次数与人数，不涉及金额）
    const times = items.reduce((s, x) => s + x.times, 0);
    const people = new Set(items.map(x => x.teacher)).size;

    let h = `<div class="ro-head">
      <div class="ro-title">
        <span class="ro-icon">${p.icon}</span>
        <span class="ro-name">${esc(p.name)}</span>
        <span class="ro-sum"><b>${times}</b>次 · <b>${people}</b>人</span>
      </div>
      <div class="ro-desc">${esc(p.desc)}</div>
      ${p.bySeg ? `<div class="ro-segbar">${
        this.rosterSegOptions(pk).map(o =>
          `<span>${esc(o.label)}</span>`).join('')}</div>` : ''}
    </div>`;

    // 周末值班的特别说明
    if (pk === 'weekend') {
      h += '<div class="ro-tip">放假前一天（或周末）晚修由<b>宿管值班</b>，'
        + '通常会额外叫两三位教师来协助。日期可以选任意一天，直接在这里登记。</div>';
    }

    // 导入入口（说明文字已按要求删除，只留两个按钮）
    h += `<div class="card" style="margin-top:0">
      <div class="imp-btns">
        <button class="btn btn-p" data-act="impFile" data-pk="${pk}">上传 Excel / 图片</button>
        <button class="btn btn-s" data-act="impText" data-pk="${pk}">粘贴文字</button>
      </div>
      <input type="file" id="impFile${pk}" accept=".xlsx,.xls,.csv,image/*" class="file-h">
    </div>`;

    // 记录列表
    h += '<div class="card"><div class="card-h">本月记录'
      + `<span class="sub">${items.length} 条</span></div><div class="card-b" style="padding:0">`;
    if (!items.length) {
      /* 原来是"本月还没有记录" + "点下面的按钮添加"两行字，
         下面又有一个「＋ 添加××记录」按钮 —— 说了三遍同一件事。
         现在只留「手动添加」一个按钮。 */
      h += '<div class="ro-empty">还没有记录</div>';
    } else {
      // 按日期倒序
      const sorted = items.slice().sort((a, b) => b.date.localeCompare(a.date));
      for (const it of sorted) {
        const d0 = parseYmd(it.date);
        const isToday = it.date === ymd(new Date());
        /* 每行右边挂一个 ✕ —— 登记错了当场就能删，
           不用先点进去再点「删除」。跟表格里那个 ✕ 一个用途。 */
        h += `<div class="ro-item" data-rit="${it.id}" data-rpk="${pk}" data-rds="${it.date}">
          <div class="ro-day"><b>${d0.getMonth()+1}/${d0.getDate()}</b>星期${WEEK_CN[isoDow(d0)-1]}</div>
          <div class="ro-who">${p.bySeg ? `<i class="ro-seg">${esc(segLabelOf(rosterSegOf(it)))}</i>` : ''}${esc(it.teacher)}${it.note ? `<em>${esc(it.note)}</em>` : ''}</div>
          <div class="ro-times">${it.times} 次</div>
          <span class="ro-x" data-del-ro="${esc(it.date)}" data-ids="${esc(it.id)}"
                data-pk="${esc(pk)}" title="删掉这条记录">✕</span>
        </div>`;
      }
    }
    h += `<button class="ro-add" data-act="rosterAdd" data-pk="${pk}">${items.length ? '＋ 添加记录' : '手动添加'}</button>`;
    h += '</div></div>';

    /* 相邻月份的记录（跨月录入时能看到） */
    if (nearItems.length) {
      const near = nearItems.slice().sort((a, b) => b.date.localeCompare(a.date));
      h += '<div class="card"><div class="card-h">相邻月份'
        + `<span class="sub">${near.length} 条</span></div><div class="card-b" style="padding:0">`;
      for (const it of near) {
        const d0 = parseYmd(it.date);
        /* 相邻月份的记录同样能删 —— 跨月登记时录错了也得能改 */
        h += `<div class="ro-item" data-rit="${it.id}" data-rpk="${pk}" data-rds="${it.date}">
          <div class="ro-day"><b>${d0.getMonth()+1}/${d0.getDate()}</b>星期${WEEK_CN[isoDow(d0)-1]}</div>
          <div class="ro-who">${p.bySeg ? `<i class="ro-seg">${esc(segLabelOf(rosterSegOf(it)))}</i>` : ''}${esc(it.teacher)}${it.note ? `<em>${esc(it.note)}</em>` : ''}</div>
          <div class="ro-times">${it.times} 次</div>
          <span class="ro-x" data-del-ro="${esc(it.date)}" data-ids="${esc(it.id)}"
                data-pk="${esc(pk)}" title="删掉这条记录">✕</span>
        </div>`;
      }
      h += '</div></div>';
    }

    box.innerHTML = h;
  },

  _bindRoster() {
    const box = document.getElementById('rosterbox');
    if (!box || box._bound) return;
    box._bound = true;
    box.addEventListener('click', e => {
      const imp = e.target.closest('[data-act="impFile"]');
      if (imp) { this.pickFile(imp.dataset.pk); return; }
      const txt = e.target.closest('[data-act="impText"]');
      if (txt) { this.promptText(txt.dataset.pk); return; }
      const add = e.target.closest('[data-act="rosterAdd"]');
      if (add) { this.rosterSheet(add.dataset.pk, null); return; }
      /* ✕ 删除 —— 必须排在 [data-rit] 之前：
         点在✕ 上时 closest('[data-rit]') 也能命中那一行，
         顺序反了就会同时弹起"编辑记录"，等于点了个寂寞。 */
      const xr = e.target.closest('[data-del-ro]');
      if (xr) {
        e.stopPropagation();
        this._delQuickFromTable = false;   /* 标记来源：栏目页的记录列表 */
        this.delRosterQuick(xr.dataset.ids, xr.dataset.delRo);
        return;
      }
      const it = e.target.closest('[data-rit]');
      if (it) this.rosterSheet(it.dataset.rpk, it.dataset.rit, it.dataset.rds);
    });
    box.addEventListener('change', e => {
      const f = e.target.closest('[data-pv] input[type=file]');
      const f2 = e.target.closest('input[type="file"]');
      if (f2) {
        const pk = (f2.id || '').replace('impFile', '');
        if (pk) this.onFileChosen(pk, f2);
      }
    });
  },

  /* ---------- 上传识别：Excel / 图片 / 粘贴 ---------- */

  /** 点了「上传 Excel / 图片」 */
  pickFile(pk) {
    const inp = document.getElementById('impFile' + pk);
    if (inp) inp.click();
  },

  /** 文件选中后 */
  async onFileChosen(pk, el) {
    const f = el.files && el.files[0];
    el.value = '';
    if (!f) return;

    const name = f.name || '';
    if (/\.(xlsx|xls|csv)$/i.test(name)) return this.readExcelFile(pk, f);
    if (/^image\//.test(f.type) || /\.(png|jpe?g|webp|bmp|gif)$/i.test(name)) return this.readImageFile(pk, f);
    // 类型不认识，试着按 Excel 读
    return this.readExcelFile(pk, f);
  },

  /** 读 Excel */
  async readExcelFile(pk, file) {
    this.showProgress('正在解析 Excel…', 0.15);
    try {
      if (typeof XLSX === 'undefined') await this.loadXLSX();
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      this.showProgress('识别中…', 0.6);

      const results = parseRosterWorkbook(wb);
      if (!results.length || !results.some(r => r.items.length)) {
        this.hideProgress();
        wx_like_alert('没识别出名单。请确认文件里有「日期 + 老师 + 次数」，'
          + '或者表头一行是日期、第一列是老师姓名。');
        return;
      }
      this.hideProgress();
      // 多个 sheet 让用户选
      this.showImportPreview(pk, results);
    } catch (e) {
      console.error(e);
      this.hideProgress();
      alert('文件读不出来：' + (e.message || e));
    }
  },

  /** 读图片 → OCR */
  async readImageFile(pk, file) {
    this.showProgress('正在加载识别引擎…', 0.05);
    try {
      await this.loadTesseract();
      this.showProgress('正在识别图片…', 0.3);
      const text = await this.runOCR(file);
      this.showProgress('正在对名单…', 0.85);

      const items = parseRosterText(text);
      this.hideProgress();

      if (!items.length) {
        this.showOCRText(pk, text);
        alert('没能从图片里认出名字。\n'
          + '可能原因：图片太模糊、字太小，或者表格线太密。\n'
          + '你可以用「粘贴文字」把名字手动贴进来。');
        return;
      }
      this.showImportPreview(pk, [{ sheet: file.name, mode: 'ocr', items }]);
    } catch (e) {
      console.error(e);
      this.hideProgress();
      alert('图片识别失败：' + (e.message || e));
    }
  },

  /** 跑 tesseract */
  async runOCR(file) {
    const T = window.Tesseract || (await import('./ocr/tesseract.min.js'));
    const res = await T.recognize(file, 'chi_sim', {
      logger: m => {
        if (m.status === 'recognizing text') {
          this.showProgress('正在识别图片…', 0.3 + (m.progress || 0) * 0.5);
        }
      }
    });
    return (res && res.data && res.data.text) || '';
  },

  async loadTesseract() {
    if (window.Tesseract) return;
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'js/ocr/tesseract.min.js';
      s.onload = res;
      s.onerror = () => rej(new Error('识别引擎加载失败，请检查网络'));
      document.head.appendChild(s);
    });
  },

  async loadXLSX() {
    if (typeof XLSX !== 'undefined') return;
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'js/xlsx.full.min.js';
      s.onload = res;
      s.onerror = () => rej(new Error('Excel 解析库加载失败'));
      document.head.appendChild(s);
    });
  },

  /** 粘贴文字 */
  promptText(pk) {
    this._impPk = pk;
    const p = DATA.posts[pk];
    this.openSheet(`粘贴${p.name}名单`, `
      <div style="padding:12px 16px 0;font-size:12.5px;color:var(--txt2);line-height:1.7">
        每行一条，可以这样写：<br>
        <code style="display:block;margin-top:6px;padding:8px 10px;background:var(--rowh);
          border-radius:7px;font-size:12.5px;line-height:1.8">
10月5日 王梅 2次<br>
10月6日 李鹏 1次<br>
10月7日 王梅 张伟 各1次
        </code>
        日期可以不写，会归到当前选中的日期。
      </div>
      <div style="padding:12px 16px">
        <textarea id="rawText" rows="9" placeholder="在这里粘贴…"
          style="width:100%;padding:11px 12px;border:1px solid var(--line);
            border-radius:9px;font-size:14px;font-family:inherit;resize:vertical;line-height:1.6"></textarea>
      </div>`, `
      <button class="btn btn-s" onclick="App.closeSheet()">取消</button>
      <button class="btn btn-p" id="btnParseText">识别</button>`);
  },

  parsePastedText() {
    const ta = document.getElementById('rawText');
    const text = ta ? ta.value : '';
    if (!text.trim()) { this.toast('先粘贴点内容'); return; }
    const items = parseRosterText(text);
    if (!items.length) { this.toast('没认出老师名字'); return; }
    this.closeSheet();
    this.showImportPreview(this._impPk, [{ sheet: '粘贴内容', mode: 'text', items }]);
  },

  /** 识别结果预览（可改可存） */
  showImportPreview(pk, results) {
    const p = DATA.posts[pk];
    // 合并所有结果
    let items = [];
    results.forEach(r => items.push(...r.items));
    items = items.filter(x => x.teacher);
    if (!items.length) { this.toast('没识别到记录'); return; }

    // 没日期的排在最后，用当前选中日期兜底
    const defDate = this.sel;
    items.forEach(x => { if (!x.date) x.date = defDate; });
    items.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    const totalTimes = items.reduce((s, x) => s + x.times, 0);
    // 金额只在统计页汇总，这里不显示
    const people = new Set(items.map(x => x.teacher)).size;
    const noDate = items.filter(x => !x.date).length;

    let body = '';
    if (results.length > 1) {
      body += `<div class="pv-tip">识别到 ${results.length} 个工作表，已全部合并</div>`;
    }
    items.forEach((it, i) => {
      body += `<div class="pv new" data-pv="${i}">
        <div class="pv-dt">${it.date ? it.date.slice(5) : '未填'}</div>
        <div class="pv-nm"><input value="${esc(it.teacher)}" data-pv-f="teacher" data-i="${i}"></div>
        <div class="pv-tm"><input type="number" min="1" value="${it.times}" data-pv-f="times" data-i="${i}"></div>
        <div class="pv-amt" data-pv-amt="${i}" hidden></div>
      </div>`;
    });

    this._impItems = items;
    this._impPk = pk;
    this._impY = this.ym;

    this.openSheet(`${p.name} · 识别结果`, `
      <div class="pv-sum">
        <span>共 <b>${items.length}</b> 条</span>
        <span><b>${totalTimes}</b> 次</span>
        <span><b>${people}</b> 人</span>

      </div>
      <div id="pvList">${body}</div>`, `
      <button class="btn btn-s" onclick="App.closeSheet()">取消</button>
      <button class="btn btn-p" id="btnSaveImp">保存 ${items.length} 条</button>`);
  },

  /** 取该行对应的真实日期（用于放假行跳转到周末值班录入） */
  repDsKey(ds) { return ds || ''; },

  /** 周末值班的分段选项：一段 / 二段 / 一二段 */
  rosterSegOptions(pk) {
    const p = DATA.posts[pk] || {};
    const segs = activeSegments();
    const opts = segs.map(sg => ({
      key: sg.key,
      label: segLabelOf(sg.key),          // 一段 / 二段 / 三段
      rate: (p.segRates || {})[sg.key] ?? p.rate ?? 0
    }));
    // 只有两段时，额外提供「一二段」（同一人两段都值）
    if (segs.length >= 2) {
      opts.push({
        key: 'both',
        label: segLabelOf('both'),         // 一二段
        rate: ((p.segRates || {})[segs[0].key] ?? p.rate ?? 0)
            + ((p.segRates || {})[segs[1].key] ?? p.rate ?? 0)
      });
    }
    return opts;
  },

  /** 在录入弹层里切换分段 */
  pickRosterSeg(segKey) {
    if (!this._roCtx) return;
    this._roSeg = segKey;
    /* 只切换按钮的选中态，不重开整个弹层 ——
       重开会把已经选好的老师和填好的备注全丢掉。 */
    document.querySelectorAll('.segpick2 button').forEach(b => {
      b.classList.toggle('on', b.dataset.seg2 === segKey);
    });
  },

  /** 在录入弹层里改日期 */
  pickRosterDate(v) {
    if (!v || !this._roCtx) return;
    this._roCtx.dateStr = v;
    const pk = this._roCtx.pk;
    const id = this._roCtx.id;
    this.closeSheet();
    this.rosterSheet(pk, id || null, v);
  },

  /** 刷新预览表的金额与汇总 */
  refreshPreviewAmount() {
    const items = this._impItems;
    if (!items) return;
    // 单价由配置决定，此处不展示
    items.forEach((it, i) => {
      const el = document.querySelector(`[data-pv-amt="${i}"]`);
      // 金额只在统计页汇总，不在预览表显示
    });
    const totalTimes = items.reduce((s, x) => s + (Number(x.times) || 0), 0);
    const people = new Set(items.map(x => x.teacher).filter(Boolean)).size;
    const sum = document.querySelector('.pv-sum');
    if (sum) {
      sum.innerHTML = `共 <b>${items.length}</b> 条`
        + `<span><b>${totalTimes}</b> 次</span>`
        + `<span><b>${people}</b> 人</span>`
        
    }
  },

  /** 保存识别结果 */
  saveImported() {
    const pk = this._impPk;
    const items = this._impItems;
    if (!items || !items.length) return;
    const p = DATA.posts[pk];
    // 合并同一天同一个人的次数
    const merged = {};
    items.forEach(it => {
      const k = it.date + '|' + it.teacher;
      merged[k] = merged[k] || { date: it.date, teacher: it.teacher, times: 0, note: '' };
      merged[k].times += (Number(it.times) || 0);
    });
    const list = Object.values(merged).filter(x => x.times > 0);
    const n = applyRosterItems(pk, list, {});
    save();
    markChanged(`导入 ${n} 条`, pk, '');
    this.closeSheet();
    this.setPost(pk);
    this.renderChangeBar();
    this.toast(`已导入 ${n} 条${p.name}记录`);
  },

  /** OCR 原文（识别失败时让人手动挑） */
  showOCRText(pk, text) {
    this.openSheet('图片识别到的文字', `
      <div style="padding:12px 16px">
        <div style="font-size:12.5px;color:var(--txt2);margin-bottom:7px">
          没匹配到已知的老师名字。你可以核对后，用「复制」转到「粘贴文字」里改一改。</div>
        <textarea rows="12" readonly
          style="width:100%;padding:11px 12px;border:1px solid var(--line);
            border-radius:9px;font-size:13px;line-height:1.6">${esc(text)}</textarea>
      </div>`, `<button class="btn btn-p" onclick="App.closeSheet()">知道了</button>`);
  },

  /* ---------- 进度条 ---------- */
  showProgress(text, pct) {
    let box = document.getElementById('impProg');
    if (!box) {
      box = document.createElement('div');
      box.id = 'impProg';
      box.className = 'mask on';
      box.innerHTML = `<div class="sheet" style="max-height:auto">
        <div class="imp-prog">
          <span style="font-size:13.5px;color:var(--txt);flex:0 0 auto" id="impProgTxt">…</span>
          <span class="bar"><span id="impProgBar"></span></span>
          <span class="pct" id="impProgPct">0%</span>
        </div></div>`;
      document.body.appendChild(box);
    }
    document.getElementById('impProgTxt').textContent = text;
    document.getElementById('impProgBar').style.width = Math.round((pct || 0) * 100) + '%';
    document.getElementById('impProgPct').textContent = Math.round((pct || 0) * 100) + '%';
  },

  hideProgress() {
    const b = document.getElementById('impProg');
    if (b) b.remove();
  },

  /* ---------- 名单制记录编辑 ---------- */
  rosterSheet(pk, id, dateStr) {
    this._roCtx = { pk, id: id || '', dateStr: dateStr || this.sel };
    if (!this._roSeg) this._roSeg = 's1';
    const p = DATA.posts[pk];
    const list = rosterOn(this._roCtx.dateStr, pk);
    const it = id ? list.find(x => x.id === id) : null;

    const names = [...new Set([...DATA.teachers, ...DATA.adminStaff, ...DATA.dormStaff,
                                ...(it ? [it.teacher] : [])])]
      .filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh'));

    const ds0 = this._roCtx.dateStr;
    const d0 = parseYmd(ds0);
    let h = `<div class="pane-hd">
      <span class="ph-lbl">${esc(p.icon)} ${esc(p.name)}</span>
      <span class="ph-time">按次数登记</span>
    </div>
    <div class="datepick">
      <label>日期</label>
      <input type="date" id="roDate" value="${esc(ds0)}" onchange="App.pickRosterDate(this.value)">
      <span class="dp-w">星期${WEEK_CN[isoDow(d0)-1]}${
        !isWorkday(ds0) ? '<span class="warn">非排班日</span>' : ''}</span>
    </div>
    ${p.bySeg ? `<div class="segpick2">
      ${this.rosterSegOptions(pk).map(o => `
        <button class="${((it && it.seg) || this._roSeg || 's1') === o.key ? 'on' : ''}"
                data-seg2="${o.key}" onclick="App.pickRosterSeg('${o.key}')">
          ${esc(o.label)}
        </button>`).join('')}
    </div>` : ''}
    <div class="search"><input id="kw" placeholder="搜索老师姓名…" oninput="App.filterOpt(this.value)"></div>
    <div class="opt-list" id="optlist">
      <div class="sec-t">选择老师</div>`;
    for (const t of names) {
      const on = t === (it && it.teacher);
      const isD = DATA.dormStaff.includes(t) || DATA.adminStaff.includes(t);
      /* 只留姓名。之前这里还有个 <div class="av">${t.slice(-2)}</div> 头像，
         但项目 CSS 里从来没有 .av 的定义 —— 裸 div 占了整行，
         把右边真正的姓名挤成"影子"，看起来像名字被划掉又重复了一遍。已删除。 */
      h += `<div class="opt ${on ? 'sel' : ''} ${isD ? 'dorm' : ''}" data-n="${esc(t)}" data-teacher="${esc(t)}">
        <div class="nm">${esc(t)}</div>${on ? '<div class="ck">✓</div>' : ''}</div>`;
    }
    h += `</div>
    <div style="padding:12px 16px">
      <div style="font-size:12px;color:var(--txt2);margin-bottom:6px">值班次数</div>
      <div class="stepper">
        <button data-act="tm" data-d="-1">−</button>
        <input id="rtimes" type="number" min="1" step="1" value="${it ? it.times : 1}">
        <button data-act="tm" data-d="1">＋</button>
        <span class="unit">次</span>
      </div>
      <div style="font-size:12px;color:var(--txt2);margin:12px 0 6px">备注（可选）</div>
      <input id="rnote" value="${esc((it && it.note) || '')}" placeholder="如：代会 / 病假"
        style="width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font-size:15px">
    </div>`;

    this.openSheet(id ? '编辑记录' : `添加${p.name}`, h, `
      <button class="btn btn-d" id="btnDelRo">${id ? '删除' : '取消'}</button>
      <button class="btn btn-p" id="btnSaveRo">保存</button>`);
  },

  saveRoster() {
    const { pk, id, dateStr } = this._roCtx;
    const teacher = this._roTeacher;
    if (!teacher) { this.toast('请先选一位老师'); return; }
    const times = Math.max(1, parseInt((document.getElementById('rtimes') || {}).value) || 1);
    const note = ((document.getElementById('rnote') || {}).value || '').trim();
    const p = DATA.posts[pk];
    const seg = p.bySeg ? (this._roSeg || 's1') : undefined;
    setRosterItem(pk, dateStr, { id: id || undefined, teacher, times, note, seg });
    // 记录变更痕迹，给主页面显示
    markChanged(`${p.name}：${teacher}`, pk, dateStr);
    /* 必须用 saveAndSync（存本地 + 推云端），不能只 save()。
       只存本地的话：电脑看不到这份登记，而且一旦本地被覆盖/清掉就再也找不回来。 */
    this.saveAndSync();
    this._roCtx = null;
    this.closeSheet();
    /* 三处都要刷新，缺一个就会出现"存了但看不到"：
       1. renderRoster —— 栏目自己的列表页
       2. renderCal     —— 主表格那几行的「值班登记 / 老师名字」
       3. buildSettings —— 设置页（如果在设置页登记的）
       之前我判断"当前是不是停在该栏目页"来决定只刷一个，
       但从主表格点「值班登记」进来时 post 已经被设成 weekend，
       结果每次都只走了 renderRoster，表格永远不更新。不判断，全刷。 */
    this.renderRoster(pk);
    this.renderCal();
    this.renderGrid();
    if (this.page === 'set') this.buildSettings();
    const _rd = parseYmd(dateStr);
    this.toast(`已保存，${_rd.getMonth() + 1}月${_rd.getDate()}日的${p.name}已记入表格`);
  },

  /**
   * 表格里点 ✎ 快速删除一条登记。
   * 登记错了要能马上改掉 —— 不必先进弹层、再点删除。
   * ids 是逗号分隔的（同一个老师可能分了多笔：不同栏目 / 不同段）。
   */
  delRosterQuick(idsStr, dateStr) {
    const ids = String(idsStr || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length || !dateStr) return;
    const set = new Set(ids);
    /* 先把这几条登记的内容找出来，确认弹层里要显示谁 */
    const hit = [];
    for (const pk of rosterPosts()) {
      for (const it of (rosterOn(dateStr, pk) || [])) {
        if (it.id && set.has(String(it.id))) hit.push({ ...it, pk });
      }
    }
    if (!hit.length) { this.toast('这条登记已经不在了'); return; }
    const names = hit.map(x => `${x.teacher}${segLabelOf(rosterSegOf(x))}`);
    const uniqNames = Array.from(new Set(names));
    const d0 = parseYmd(dateStr);
    const dateTxt = `${d0.getMonth() + 1}月${d0.getDate()}日`;
    /* 提示语要看是从哪儿点的：
       从表格那几行点 → 删完会变回「值班登记」；
       从栏目页的记录列表点 → 删完这条记录就没了（列表会少一行）。 */
    const fromTable = !!this._delQuickFromTable;
    this.openSheet('删掉这条登记？',
      `<div style="padding:16px;font-size:14px;line-height:1.8;color:var(--txt)">
         <div style="margin-bottom:10px">${dateTxt}　要删掉的是：</div>
         <div style="font-size:16px;font-weight:600;color:var(--red);
           background:var(--red-bg);border-radius:10px;padding:11px 13px">
           ${esc(uniqNames.join('　'))}
         </div>
         <div style="margin-top:12px;font-size:12.5px;color:var(--txt2)">
           ${fromTable ? '删掉后这一格会恢复成「值班登记」，随时可以重新登记。'
                        : '删掉后这条记录就没有了，随时可以重新添加。'}</div>
       </div>`,
      `<button class="btn btn-d" id="btnDelRoQuick">删掉</button>
       <button class="btn btn-p" onclick="App.closeSheet()">不删了</button>`);
    this._delQuickCtx = { ids: Array.from(set), dateStr };
  },

  /** 确认：执行快速删除 */
  doDelRosterQuick() {
    const c = this._delQuickCtx;
    this._delQuickCtx = null;
    if (!c) return;
    const { ids, dateStr } = c;
    const set = new Set(ids);
    for (const pk of rosterPosts()) {
      const day = DATA.roster && DATA.roster[pk] && DATA.roster[pk][dateStr];
      if (!day || !day.length) continue;
      const keep = day.filter(x => !(x && x.id && set.has(String(x.id))));
      if (keep.length === day.length) continue;
      if (keep.length) DATA.roster[pk][dateStr] = keep;
      else delete DATA.roster[pk][dateStr];
      /* 删除记录簿必须写上，否则云端那份会在下次合并时被并集带回来 */
      DATA.meta.rosterDel = (DATA.meta.rosterDel || []).concat(ids).slice(-200);
      const who = day.filter(x => x && x.id && set.has(String(x.id)))
                      .map(x => x.teacher).join('、');
      if (who) markChanged(`删除 ${who}`, pk, dateStr);
    }
    this.saveAndSync();
    this.closeSheet();
    this.renderRoster(this.post);
    this.renderCal();
    this.renderGrid();
    if (this.page === 'set') this.buildSettings();
    const d0 = parseYmd(dateStr);
    const wasTable = this._delQuickFromTable;
    this._delQuickFromTable = false;
    this.toast(wasTable
      ? `已删掉，${d0.getMonth() + 1}月${d0.getDate()}日恢复成「值班登记」`
      : '已删掉这条记录');
  },

  delRoster() {
    const { pk, id, dateStr } = this._roCtx;
    const it = rosterOn(dateStr, pk).find(x => x.id === id);
    if (id) {
      delRosterItem(pk, dateStr, id);
      if (it) markChanged(`删除 ${it.teacher}`, pk, dateStr);
      /* 记下"这笔被删过"，合并时云端那份同名 id 才不会被带回来 */
      DATA.meta.rosterDel = (DATA.meta.rosterDel || []).concat([String(id)]).slice(-200);
    }
    /* 同 saveRoster：删除也要推云端，不然另一台设备上还在 */
    this.saveAndSync();
    this._roCtx = null;
    this.closeSheet();
    /* 同 saveRoster：删完也要让主表格重画，否则表格里还留着已删的人 */
    this.renderRoster(pk);
    this.renderCal();
    this.renderGrid();
    if (this.page === 'set') this.buildSettings();
    if (id) this.toast('已删除，表格里也去掉了');
  },

  /** 当前构建号（与 index.html 里的文件名一致） */
  get buildId() { return '20261011n'; },

  /** 检查版本 / 强制清缓存刷新 */
  /** 点左下角版本徽章：手动检查（同样走线上那份，才是真的） */
  async checkVer() {
    this.toast('正在检查…');
    let remote = '';
    try {
      const res = await fetch(location.pathname + '?cv=' + Date.now(),
        { cache: 'no-store', credentials: 'omit' });
      if (res && res.ok) {
        const html = await res.text();
        const m = html.match(/name=["']build["']\s+content=["']([^"']+)["']/i);
        if (m) remote = m[1];
      }
    } catch (e) { /* 忽略 */ }
    if (remote && remote !== this.buildId) {
      this.toast(`发现新版本 ${remote}，正在刷新…`);
      setTimeout(() => this.forceRefresh(), 500);
      return;
    }
    this.toast(remote ? `已是最新 v${remote}` : `当前版本 v${this.buildId}（没连上网络）`);
  },

  /**
   * 自动检查更新（真正能用的那种）。
   * 原来的 checkVer 是拿「JS 里的版本」比「HTML meta 里的版本」——
   * 但这两个文件是**一起被缓存**的，永远相等，等于检测不出任何东西。
   * 这里改成：**绕过缓存去线上抓一份 index.html**，解析它的 meta build，
   * 和当前代码的版本比。线上那份是新鲜的，才是真的。
   */
  async autoCheckVer() {
    /* 同一个会话只自动刷一次，避免万一服务端出问题导致反复重载 */
    let done = false;
    try { done = sessionStorage.getItem('wx.verChecked') === this.buildId; } catch (e) {}
    if (done) return;
    try { sessionStorage.setItem('wx.verChecked', this.buildId); } catch (e) {}

    let remote = '';
    try {
      const url = location.pathname + '?cv=' + Date.now();
      const res = await fetch(url, { cache: 'no-store', credentials: 'omit' });
      if (res && res.ok) {
        const html = await res.text();
        const m = html.match(/name=["']build["']\s+content=["']([^"']+)["']/i);
        if (m) remote = m[1];
      }
    } catch (e) { /* 网络不通就算了，不打扰用户 */ }

    if (remote && remote !== this.buildId) {
      this._pendingVer = remote;
      /* 左下角徽章标出来：万一自动刷新没成功（比如微信拦了），她一点就能刷 */
      const b = document.querySelector('.bver');
      if (b) { b.textContent = '新'; b.classList.add('dot'); b.title = '点此更新到 ' + remote; }
      this.toast('发现新版本，点左下角圆点更新');
    }
  },

  /** 清掉所有可能的缓存并重新加载 */
  forceRefresh() {
    try {
      localStorage.setItem('wx.forceReload', String(Date.now()));
    } catch (e) {}
    // 重新加载，且跳过 HTTP 缓存
    location.replace(location.pathname + '?r=' + Date.now());
  },

  /**
   * 右上角的刷新按钮。
   *
   * ⚠️ **不能直接 forceRefresh()** —— 刷新后init 会先把**本地**数据推上云端，
   * 如果本机的本地数据是旧的（比如另一台设备刚改过），一刷新就会把
   * 别人的新改动覆盖掉。所以顺序必须是：**先拉云端 → 再刷新**。
   *
   * 按钮会转一圈表示正在处理，云端没连上就直接刷新（至少能更新版本）。
   */
  async reloadNow() {
    const btn = document.getElementById('btnReload');
    if (btn) btn.classList.add('spin');
    clearTimeout(this._syncTimer);
    this.toast('正在刷新…');
    /* 给云端一点时间（最多 4 秒），拉完再刷新 */
    try { await Promise.race([
      this._syncNowInner({ quiet: true }),
      new Promise(r => setTimeout(r, 4000))
    ]); } catch (e) { /* 连不上也照样刷新 */ }
    /* 至少显示 0.6 秒转圈，否则网络快的话根本看不到"点了没反应" */
    await new Promise(r => setTimeout(r, 600));
    /* 把这次同步的结果记下来，刷新完显示出来 */
    const sum = this.dataSummary();
    try { sessionStorage.setItem('wx.lastSync',
      JSON.stringify({ days: sum.days, applied: sum.applied })); } catch (e) {}
    this.forceRefresh();
  },

  /* ---------- 变更痕迹 ---------- */
  /** 主页面顶部的「最近改动」条 */
  showBuild() {
    // 徽章在底部左下角
    const el = document.querySelector('.bver');
    if (el) el.textContent = this.buildId.replace(/^v/, '');
  },

  renderChangeBar() {
    const bar = document.getElementById('changebar');
    if (!bar) return;
    const list = recentChanges(3);
    if (!list.length) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    bar.innerHTML = `<button class="cb-t" onclick="App.showChangeLog()">
        最近改动</button>`
      + list.map(x => {
        const post = DATA.posts[x.post];
        const pn = post ? post.name : '';
        const t = timeText(x.ts);
        return `<span class="cb-i">${esc(pn || '')}${x.date ? ` ${esc(x.date.slice(5))}` : ''} ${esc(x.what)}</span>`;
      }).join('')
      + `<button class="cb-more" onclick="App.showChangeLog()">全部 ${recentChanges().length} 条 ›</button>`;
  },

  showChangeLog() {
    const list = recentChanges();
    let h = '<div class="cl-list">';
    if (!list.length) h += '<div class="ro-empty">还没有改动记录</div>';
    for (const x of list) {
      const post = DATA.posts[x.post];
      const pn = post ? post.name : '—';
      const d0 = x.date ? parseYmd(x.date) : null;
      const dsTxt = d0 ? `${d0.getMonth() + 1}月${d0.getDate()}日 星期${WEEK_CN[isoDow(d0) - 1]}` : '';
      h += `<div class="cl-i">
        <div class="cl-t">${esc(timeText(x.ts))}</div>
        <div class="cl-b">
          <span class="cl-p">${esc(pn)}</span>
          ${dsTxt ? `<span class="cl-d">${dsTxt}</span>` : ''}
          <span class="cl-w">${esc(x.what)}</span>
        </div>
      </div>`;
    }
    h += '</div>';
    this.openSheet('改动记录', h, '<button class="btn btn-p" onclick="App.closeSheet()">关闭</button>');
  },

  /* ---------- 主题 ---------- */
applyTheme(id) {
  const t = THEMES.find(x => x.id === id) || THEMES[0];
  if (id === 'rose') {
    document.documentElement.removeAttribute('data-theme');   // 粉色是 :root 默认
  } else {
    document.documentElement.setAttribute('data-theme', id);
  }
  if (t.sw === 0) document.body.classList.add('nogrid');
  else document.body.classList.remove('nogrid');
  try { localStorage.setItem('wx.theme', t.id); } catch(e) {}
  this._theme = t.id;
  this.renderAll();
},

  /** 从矩阵格子改人 */
  gridPick(ds, c, clsList) {
    // 把选中日期同步过去，切到当天视图也能对上
    this.sel = ds;
    this._saveWhere();
    /* 这一格覆盖的全部班级（相邻同一人会合并成一格，转发时要一起发） */
    this._pickClsList = clsList || String(c);
    this.renderCal();
    this.pickTeacher(ds, c);
  },

  /* ---------- 当天面板 ---------- */
  /** 生成某一天的明细 HTML（表格页与弹层共用） */
  dayHtml(ds) {
    if (!ds) return '';
    const d0 = parseYmd(ds);
    const dow = isoDow(d0);
    const hol = DATA.holidays.includes(ds);
    const exs = DATA.extras[ds] || [];
    const tplId = templateFor(ds);

    let h = '<div class="card"><div class="d-head">';
    h += `<div><div class="d-date">${d0.getMonth()+1}月${d0.getDate()}日 <span class="d-w">星期${WEEK_CN[dow-1]}</span></div></div>`;
    if (hol) h += '<span class="pill rd">放假</span>';
    else if (dow>=6) h += '<span class="pill am">周末</span>';
    h += `<button class="d-holbtn" data-act="hol" data-ds="${ds}">${hol?'取消放假':'标记放假'}</button>`;
    h += '</div>';

    // 班级排班
    const base = DATA.templates[tplId];
    const baseRow = base ? (base.grid[dow]||{}) : {};
    let changed = 0;
    DATA.meta.classes.forEach(c=>{
      const baseT = baseRow[c];
      if (DATA.overrides[ds] && Object.prototype.hasOwnProperty.call(DATA.overrides[ds], c)) changed++;
      else if (baseT === undefined && !teacherOn(ds,c)) {}
    });
    const realChanged = DATA.overrides[ds] ? Object.keys(DATA.overrides[ds]).length : 0;

    if (hol) {
      h += '<div style="padding:26px 14px;text-align:center;color:var(--txt3);font-size:13.5px">'
        + '这一天已标记为放假，不计入统计</div>';
    } else if (dow>=6 && !DATA.meta.classes.some(c=>teacherOn(ds,c))) {
      h += '<div style="padding:26px 14px;text-align:center;color:var(--txt3);font-size:13.5px">'
        + '非排班日 · 无晚修安排</div>';
    } else {
      for (const c of DATA.meta.classes) {
        const segs = activeSegments();
        const lines = segs.map(s => ({ key: s.key, short: s.short, t: teacherOn(ds, c, s.key) }))
                         .filter(l => l.t);
        const isOv = DATA.overrides[ds] && Object.prototype.hasOwnProperty.call(DATA.overrides[ds], c);
        const hasDorm = lines.some(l => DATA.dormStaff.includes(l.t));
        h += `<div class="cls" data-act="pickT" data-ds="${ds}" data-c="${c}">`;
        h += `<div class="cls-no">${c}班</div>`;
        if (!lines.length) {
          h += '<div class="cls-t empty">— 空缺 —</div>';
        } else {
          /* 同一人值多段 → 名字只写一次 */
          const uniq = [];
          for (const l of lines) {
            const f = uniq.find(u => u.t === l.t);
            if (f) f.n++; else uniq.push({ ...l, n: 1 });
          }
          /* 同表格一个规则：全班同一段不标段别，段别分开才标 */
          const sp = segSplitOf(lines);
          h += `<div class="cls-t ${hasDorm?'dorm':''}">`;
          if (sp.mixed) {
            h += sp.groups.map(g =>
              `<span class="cl"><b class="lnb">${esc(g.short.replace('晚修', ''))}</b>${
                esc(g.names.join('、'))}</span>`).join('');
          } else {
            h += uniq.map(u =>
              `<span class="cl ${DATA.dormStaff.includes(u.t)?'nm':''}">${esc(u.t)}</span>`
            ).join('');
          }
          h += '</div>';
          if (isOv) h += '<div class="chg">改</div>';
        }
        h += '</div>';
      }
      if (realChanged > 0) {
        h += `<div class="cls-chg">已改 ${realChanged} 处与模板不同`
          + `<button data-act="resetDay" data-ds="${ds}">恢复模板</button></div>`;
      }
    }

    // 额外登记
    h += '</div>'; // /card

    // 额外登记卡片
    h += '<div class="card"><div class="card-h">额外登记'
      + `<span class="sub">${exs.length} 项</span></div><div class="card-b" style="padding:0">`;
    if (exs.length === 0) {
      h += '<div style="padding:16px 14px;color:var(--txt3);font-size:13px;text-align:center">'
        + '暂无登记。午休 / 行政值班 / 校医 在这里记</div>';
    } else {
      for (const e of exs) {
        const dc = DATA.duties[e.duty] || DATA.duties['其他'];
        // 金额只在统计页汇总
        h += `<div class="ex" data-act="editEx" data-ds="${ds}" data-id="${e.id}">`;
        h += `<span class="ex-tag" style="background:${dc.color}">${esc(e.duty)}</span>`;
        h += `<span class="ex-nm">${esc(e.teacher||'未指定')}`;
        if (e.note) h += ` <span class="ex-nt">${esc(e.note)}</span>`;
        h += '</span></div>';
      }
    }
    h += `<button class="ex-add" data-act="addEx" data-ds="${ds}">＋ 添加额外登记</button>`;
    h += '</div></div>';

    // 快捷操作
    h += '<div class="card"><div class="card-h">快捷操作</div><div class="btn-row">';
    h += `<button class="btn btn-share" data-act="share" data-ds="${ds}">`
       + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
       + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
       + '<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="M16 6l-4-4-4 4"/>'
       + '<path d="M12 2v13"/></svg><span>转发给宿管</span></button>';
    h += `<button class="btn btn-s" data-act="copy" data-ds="${ds}">复制这一天</button>`;
    h += `<button class="btn btn-p" data-act="stat" data-ds="${ds}">看当天次数</button>`;
    h += '</div></div>';

    // 宿管代班登记入口（点进去能看到宿管填了谁，并写进排班表）
    h += '<div class="card" id="dormCard"></div>';

    return h;
  },

  /* ---------- 多设备同步（手机 ↔ 电脑） ----------
   *
   * 为什么要做：数据原来只存浏览器本地（localStorage），
   * 手机上改的排班，电脑上完全看不到 —— 两个人看到两份表。
   *
   * 现在整份 DATA 存到云端，同一个 syncCode 下的设备共用一份。
   * 关键：**syncCode 必须两台设备一致**，否则读的不是同一份数据。
   * 它用「固定常量 + 本机可覆盖」，而不是每台设备随机生成 ——
   * 随机的话手机和电脑永远对不上（这正是原来同步不了的原因之一）。
   */

  /** 同步码：同一个值 = 同一份数据。存在 localStorage 供特殊场景覆盖。 */
  syncCode() {
    try {
      const v = localStorage.getItem('wx.syncCode');
      if (v) return v;
    } catch (e) {}
    /* 固定常量 —— 不要改成随机，否则各设备互不相认 */
    return 'wanxiu-main';
  },

  /** 拉云端数据；没有就返回 null */
  async cloudLoad() {
    if (!window.CloudDuty) return null;
    try { return await window.CloudDuty.loadState(this.syncCode()); }
    catch (e) { return null; }
  },

  /** 把当前 DATA 推上云端 */
  async cloudPush() {
    if (!window.CloudDuty) return false;
    try { await window.CloudDuty.saveState(this.syncCode(), JSON.stringify(DATA)); return true; }
    catch (e) { return false; }
  },

  /**
   * 合并云端与本地数据。
   *
   *规则很简单：**谁新用谁**。
   * 本地有meta.syncedAt（上次同步时间），云端也有更新时间，
   * 只在云端明显更新时才覆盖本地，避免把本机刚改的东西冲掉。
   *
   * 首次接入（有本地数据、云端为空）→ 直接把本地推上去，
   * 不要反过来用空云端覆盖，否则她本机的排班就没了。
   */
  async _syncNowInner(opts) {
    if (!window.CloudDuty) {
      if (!(opts && opts.quiet)) this.toast('云服务没加载好，稍后再试');
      return { ok: false, why: 'no-sdk' };
    }
    const quiet = opts && opts.quiet;
    const cloud = await this.cloudLoad();
    const localTs = (DATA.meta && DATA.meta.syncedAt) || 0;

    if (!cloud) {
      /* 云端还没有 → 本机就是第一份，推上去 */
      DATA.meta.syncedAt = Date.now();
      save();
      await this.cloudPush();
      if (!quiet) this.toast('已把本机数据存到云端');
      return { ok: true, why: 'first-upload', pushed: true };
    }

    const cloudTs = Date.parse(cloud.updatedAt) || 0;
    if (cloudTs > localTs + 1500) {
      try {
        const remote = JSON.parse(cloud.payload);
        if (remote && remote.meta && remote.templates) {
          /* ⚠️ 这里**绝不能整体覆盖本地**。
             典型事故：手机还是旧版本（没有同步功能），本地攒了真实改动；
             电脑是新版本，把空数据推上了云端。
             手机一升级就连到云端 -> 云端"更新"-> 整体覆盖 -> **本地改动全没了**。
             所以这里必须**合并**：本机已有的改动永远优先，只补云端多出来的。 */
          const before = this.dataSummary();
          const merged = this._mergeData(DATA, remote);
          DATA = merged;
          DATA.meta.syncedAt = Date.now();
          save();
          this.renderCal();
          this.renderGrid();
          this.renderChangeBar();
          if (!document.getElementById('mask').classList.contains('on')) {
            this.setPost(this.post);
          }
          const after = this.dataSummary();
          const gained = after.cells - before.cells;
          if (!quiet) {
            this.toast(gained > 0
              ? `已合并云端数据（新增 ${gained} 处改动）`
              : '已合并云端数据');
          }
          await this.cloudPush();      // 合并完推回去，让另一台也拿到
          return { ok: true, why: 'merged', gained };
        }
      } catch (e) { /* 云端数据坏了，保守起见不动本地 */ }
    }

    /* 本机更新（或一样）→ 推上去 */
    DATA.meta.syncedAt = Date.now();
    save();
    await this.cloudPush();
    return { ok: true, why: 'pushed', pushed: true };
  },

  /**
   * 合并两份数据，**本机已有的改动永远优先**。
   *
   * 为什么不能直接用云端覆盖：
   *   手机（旧版本、没同步功能）攒了真实排班 → 电脑（新版本）推了空数据上云
   *   → 手机升级后拉到云端 → 整体覆盖 → 她的改动凭空消失。
   *
   * 合并规则（按重要性从高到低）：
   *   1. overrides：同一天同一个班，**本机有值就以本机为准**；云端独有的补进来
   *   2. dormApplied / appliedShifts：并集
   *   3. holidays / extras：本机有值以本机为准，云端独有的日期补进来
   *   4. changeLog：按 ts 去重后按时间倒序（两边都留，保证改动痕迹完整）
   *   5. 其余字段：模板等以本机为准（模板是从 Excel 来的，本机更新）
   */
  _mergeData(local, remote) {
    const L = local && local.meta ? local : JSON.parse(JSON.stringify(local));
    const R = remote && remote.meta ? remote : {};

    /* 1. 排班改动 —— 本机优先
     *
     * 要按「日期 → 班号 → 段」三层的**并集**来遍历。
     * 踩过的坑：一开始只遍历本机已有的键，结果"云端有、本机没有"的
     * 那个班被整个丢掉了（比如云端把 3 班改成张占辉，本机 overrides 里
     * 只有 1 班，合并后 3 班又变回模板里的张建锋）。
     */
    const ov = {};
    const rOv = R.overrides || {};
    const lOv = L.overrides || {};
    /* 日期取并集 */
    const allDays = new Set(Object.keys(rOv).concat(Object.keys(lOv)));
    allDays.forEach(ds => {
      const rd = rOv[ds] || {};
      const ld = lOv[ds] || {};
      /* 班号也要取并集 */
      const allCls = new Set(Object.keys(rd).concat(Object.keys(ld)));
      const day = {};
      allCls.forEach(c => {
        const Lc = ld[c];
        const Rc = rd[c];
        if (Array.isArray(Lc)) { day[c] = Lc.slice(); return; }
        if (Array.isArray(Rc)) { day[c] = Rc.slice(); return; }
        const lo = Lc || null, ro = Rc || null;
        const lHas = !!(lo && Object.keys(lo).length);
        const rHas = !!(ro && Object.keys(ro).length);
        if (lHas && rHas) {
          /* 两边都有：逐段比，本机有值的段以本机为准，云端独有的段补进来。
             注意"本机是空串"也算有意清空，要保留。 */
          const merged = {};
          const segs = new Set(Object.keys(lo).concat(Object.keys(ro)));
          segs.forEach(k => {
            if (Object.prototype.hasOwnProperty.call(lo, k)) merged[k] = lo[k];
            else merged[k] = ro[k];
          });
          day[c] = merged;
        } else if (lHas) {
          day[c] = Object.assign({}, lo);
        } else if (rHas) {
          day[c] = Object.assign({}, ro);
        }
        /* 两边都没有就不写这个键 */
      });
      if (Object.keys(day).length) ov[ds] = day;
    });
    L.overrides = ov;

    /* 2. 宿管登记已写入标记 —— 并集 */
    const da = Object.assign({}, R.meta.dormApplied || {});
    Object.keys(L.meta.dormApplied || {}).forEach(ds => {
      const a = da[ds] || [];
      const b = (L.meta.dormApplied[ds] || []).map(String);
      da[ds] = Array.from(new Set(a.concat(b).map(String)));
    });
    L.meta.dormApplied = da;

    /* 3. 假期 / 额外登记 —— 本机优先 + 补云端独有 */
    ['holidays', 'userHolidays'].forEach(k => {
      const a = (L[k] || []).slice();
      const b = R[k] || [];
      L[k] = Array.from(new Set(a.concat(b)));
    });
    if (R.extras && typeof R.extras === 'object') {
      L.extras = Object.assign({}, R.extras, L.extras || {});
    }

    /* 3b. 名单制登记（周末值班 / 午休 / 教辅…）—— **按条目并集，两边都留**
     *
     * ⚠️ 这段之前**整个漏掉了**，后果很严重：
     *   本机登记了周末值班 → 只存了本地（没推云端，见 saveRoster 里的 save()）
     *   → 刷新时从云端拉回数据 → _mergeData 里没有 roster 的处理逻辑
     *   → 合并结果等于"本机那一份"，云端那份被无视；
     *   而下次本机再登记又只存本地… 来回折腾，登记看起来"刷新就没了"。
     *
     * 登记条目都有唯一 id，所以直接按 id 做并集最稳妥：
     * 同一个 id（同一台设备同一笔）以本机为准，云端独有的补进来。 */
    /* 删除也要能同步：光"本地删掉"是不够的 —— 云端那份还在，
       下次合并又会被并集带回来，表现为"删掉的人又出现了"。
       所以删除时把 id 记进 meta.rosterDel，合并时按它过滤。 */
    const dels = new Set([].concat(L.meta.rosterDel || [], R.meta.rosterDel || []).map(String));
    const mergeRoster = (a, b) => {
      const out = {};
      const days = new Set(Object.keys(a || {}).concat(Object.keys(b || {})));
      days.forEach(ds => {
        const la = (a && a[ds]) || [];
        const lb = (b && b[ds]) || [];
        if (!la.length && !lb.length) return;
        /* 没有 id 的老数据兜底：用 姓名+段 做 key，避免重复 */
        const key = x => x.id || `${x.teacher}|${x.seg || 's1'}|${x.times || 1}`;
        const seen = new Set();
        const list = [];
        la.concat(lb).forEach(x => {
          if (x && x.id && dels.has(String(x.id))) return;   /* 已被删掉的，跳过 */
          const k = key(x);
          if (seen.has(k)) return;
          seen.add(k);
          list.push(x);
        });
        if (list.length) out[ds] = list;      /* 空了就不留这个日期 */
      });
      return out;
    };
    const lRoster = L.roster && typeof L.roster === 'object' ? L.roster : {};
    const rRoster = R.roster && typeof R.roster === 'object' ? R.roster : {};
    const mergedRoster = {};
    new Set(Object.keys(lRoster).concat(Object.keys(rRoster))).forEach(pk => {
      const m = mergeRoster(lRoster[pk], rRoster[pk]);
      if (Object.keys(m).length) mergedRoster[pk] = m;
    });
    L.roster = mergedRoster;
    /* 保留删除记录（只留最近 200 条，防止无限膨胀） */
    L.meta.rosterDel = Array.from(dels).slice(-200);

    /* 4. 改动痕迹 —— 按 ts 去重后倒序 */
    const seenTs = new Set();
    const log = [];
    (L.meta.changeLog || []).concat(R.meta.changeLog || []).forEach(x => {
      const key = [x.ts, x.what, x.date].join('|');
      if (!seenTs.has(key)) { seenTs.add(key); log.push(x); }
    });
    log.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    L.meta.changeLog = log.slice(0, 30);

    /* 5. 时间戳取较新的 */
    L.meta.syncedAt = Date.now();
    return L;
  },

  /** 现在有几处排班改动、几条宿管登记 —— 用来判断"到底有没有东西可同步" */
  dataSummary() {
    const ov = DATA.overrides || {};
    const days = Object.keys(ov).length;
    let cells = 0;
    Object.values(ov).forEach(v => { cells += Object.keys(v || {}).length; });
    const applied = DATA.meta && DATA.meta.dormApplied
      ? Object.values(DATA.meta.dormApplied).reduce((n, a) => n + (a ? a.length : 0), 0)
      : 0;
    /* 名单制登记也要算进去 —— 之前漏了，导致"只登记了周末值班"时
       它会说"两台设备数据一致（都没有改动）"，让人以为白存了。 */
    let roster = 0;
    const rs = DATA.roster || {};
    Object.keys(rs).forEach(pk => {
      Object.keys(rs[pk] || {}).forEach(ds => { roster += (rs[pk][ds] || []).length; });
    });
    return { days, cells, applied, roster };
  },

  /** 本地数据改动后延迟推云端（合并短时间内的多次改动） */
  syncSoon() {
    if (!window.CloudDuty) return;
    clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => this._syncNowInner({ quiet: true }), 1200);
  },

  /**
   * 包一层 save()：本地存盘 + 顺手推云端。
   * 全项目所有改动都走这个入口，不用在每个地方都记得同步。
   */
  saveAndSync() {
    save();
    this.syncSoon();
  },

  /**
   * 月份下面那行：「今天 · 10月9日 星期五」。
   * 表格行首已经有"周一/10月12日/第6周"三行，但月份条上缺一个
   * "今天是几号星期几"的锚点 —— 尤其当月翻到别的月份时尤其需要。
   */
  /**
   * 顶部标签：「第N周」+ 这一周的日期区间。
   * 周次是主信息（她要看的是"第几周排什么"），日期区间是辅助。
   * 点它可以弹列表选周次。
   */
  _renderWeekLabel() {
    const el = document.getElementById('mlabel');
    if (!el) return;
    const wk = weekNoOf(this.sel) || 1;
    const mon = this._week1Monday();
    const d1 = new Date(mon);
    d1.setDate(mon.getDate() + (wk - 1) * 7);
    const d7 = new Date(d1);
    d7.setDate(d1.getDate() + 6);
    const f = x => `${x.getMonth() + 1}月${x.getDate()}日`;
    el.innerHTML = `<b>第${wk}周</b><em>${f(d1)}–${f(d7)}</em>`;
  },

  /* 原来这里有个 _renderToday()，渲染月份条上的「今天 10月9日 星期五」，
     已按要求删除。表头那一行的「今天」高亮仍然保留（那是定位今天用的，不是这块）。 */

  /* ---------- 宿管代班登记 ---------- */
  /** 当天明细里的「宿管代班登记」卡片 */
  async renderDormCard(ds) {
    const box = document.getElementById('dormCard');
    if (!box) return;
    const hd = `<div class="card-h">宿管代班登记`
      + `<span class="sub">宿管自己填的名字</span></div>`;
    box.innerHTML = hd + '<div class="card-b" style="padding:0 14px 14px">'
      + '<div style="padding:6px 0;color:var(--txt3);font-size:12.5px">正在读取…</div></div>';
    let rows = [];
    try {
      rows = await window.CloudDuty.loadShift(this.shareToken(), ds);
    } catch (e) {
      box.innerHTML = hd + '<div class="card-b" style="padding:0 14px 14px">'
        + `<div style="padding:6px 0;color:var(--txt3);font-size:12.5px">`
        + `读不到云端记录（${esc(e && e.message ? e.message : '网络异常')}）</div></div>`;
      return;
    }
    if (!rows.length) {
      box.innerHTML = hd + '<div class="card-b" style="padding:0 14px 14px">'
        + '<div style="padding:6px 0;color:var(--txt3);font-size:12.5px">'
        + '还没有宿管登记。把上面的链接发给宿管，他填完名字这里就会出现。</div></div>';
      return;
    }
    const applied = new Set(((DATA.meta.dormApplied || {})[ds] || []).map(String));
    let pending = 0;
    let h = hd + '<div class="card-b" style="padding:0">';
    for (const r of rows) {
      let d = {};
      try { d = JSON.parse(r.detail || '{}'); } catch (e) {}
      const names = (d.names || []).filter(Boolean);
      const cls = String(r.classes || '').split(',').filter(Boolean);
      const when = (r.submitted_at || '').slice(5, 16).replace('T', ' ');
      const isIn = applied.has(String(r.id));
      if (!isIn) pending++;
      h += '<div class="rx' + (isIn ? ' done' : '') + '">'
        + `<div class="who">${esc(names.join('、') || '未填名字')}`
        + (isIn ? '<span class="ok">已进排班表</span>' : '<span class="wait">待写入</span>')
        + '</div>'
        + `<div class="what">代 ${esc(cls.join('、')) || '—'} 班</div>`
        + `<div class="tm">${esc(when)}</div></div>`;
    }
    h += '</div>';
    h += '<div class="rx-act">'
      + (pending
          ? `<button data-act="dormApply" data-ds="${ds}">写入 ${pending} 条到排班表</button>`
          : '<button disabled>已全部写入排班表</button>')
      + `<button data-act="dormClear" data-ds="${ds}">清空登记</button>`
      + '</div>';
    h += '<div class="tip" style="padding:9px 14px 12px;font-size:11.5px;color:var(--txt3)">'
      + (pending
          ? '宿管登记后名字会自动填进对应班级（紫色显示），一位老师一班算一次。'
          : '宿管的名字已经填进对应班级了，排班表里是紫色显示。')
      + '</div>';
    h += '</div>';
    box.innerHTML = h;
  },

  /**
   * 把宿管登记的姓名写进当天的排班表（作为宿管顶班）。
   * silent=true 时不弹提示、也不重新打开当天明细（自动写入用）。
   *
   * ⚠️ 这里必须save()—— 以前漏了，导致「写入了但一刷新就还原」，
   *看起来像按钮没生效。数据只存在内存里是最容易被忽略的坑。
   *
   * 幂等：已写入过的记录（按记录 id 记在 DATA.meta.dormApplied）
   * 不会重复写入，也不会重复记改动痕迹。
   */
  async dormApply(ds, silent) {
    let rows = [];
    try { rows = await window.CloudDuty.loadShift(this.shareToken(), ds); }
    catch (e) {
      if (!silent) this.toast('读取失败：' + (e.message || '网络异常'));
      return 0;
    }
    if (!rows.length) { if (!silent) this.toast('没有可写入的登记'); return 0; }

    if (!DATA.meta.dormApplied || typeof DATA.meta.dormApplied !== 'object') {
      DATA.meta.dormApplied = {};
    }
    const done = new Set((DATA.meta.dormApplied[ds] || []).map(String));

    let n = 0;
    const segs = activeSegments();
    for (const r of rows) {
      const rid = String(r.id);
      if (done.has(rid)) continue;              // 已写过，跳过（幂等）
      let d = {};
      try { d = JSON.parse(r.detail || '{}'); } catch (e) {}
      const names = (d.names || []).filter(Boolean);
      const cls = String(r.classes || '').split(',').filter(Boolean)
                    .map(Number).filter(Boolean);
      if (!names.length || !cls.length) { done.add(rid); continue; }

      /* 一个名字按顺序认领一个班；名字多、班少时循环用 */
      cls.forEach((c, i) => {
        const who = names[i % names.length];
        segs.forEach(s => this._setTQuiet(ds, c, who, s.key));
        n++;
      });
      done.add(rid);
    }
    if (!n) { if (!silent) this.toast('没有新的登记要写入'); return 0; }

    DATA.meta.dormApplied[ds] = Array.from(done);
    markChanged(`宿管代班写入 ${n} 个班`, 'evening', ds);
    this.saveAndSync();    // ← 关键：存本地 + 推云端（否则刷新就没了、电脑也看不到）
    this.renderCal();
    this.renderGrid();
    this.renderChangeBar();

    if (silent) {
      /* 自动写入：只提示，不抢走当前界面 */
      this.toast(`宿管登记已自动写入 ${n} 个班`);
    } else {
      this.closeSheet();
      this.openDaySheet(ds);
      this.toast(`已写入 ${n} 个班的宿管代班`);
    }
    return n;
  },

  /**
   * 页面打开时把「已登记但还没写入」的宿管记录补上。
   * 之前要她手动点「写入排班表」，很容易忘；而且万一漏点，
   * 表格里就一直显示原老师，看不出宿管已经接手了。
   */
  async autoApplyDorm() {
    if (!window.CloudDuty) return;
    let dates = [];
    try { dates = await window.CloudDuty.listDates(this.shareToken()); }
    catch (e) { return; }
    if (!dates.length) return;

    let total = 0;
    for (const ds of dates) {
      total += await this.dormApply(ds, true) || 0;
    }
    if (total) this.renderChangeBar();
  },

  /** 清空某天的宿管登记 */
  async dormClear(ds) {
    try {
      const n = await window.CloudDuty.deleteShift(null, this.shareToken(), ds);
      /* 记录删了，已写标记也要清掉 —— 否则宿管重新登记时
         会被当成"已经写过"，新名字再也进不了排班表。 */
      if (DATA.meta.dormApplied) delete DATA.meta.dormApplied[ds];
      this.saveAndSync();
      this.renderChangeBar();
      this.openDaySheet(ds);
      this.toast(n ? '已清空登记' : '没有需要清空的');
    } catch (e) { this.toast('清空失败：' + (e.message || '网络异常')); }
  },

  /* ---------- 转发给宿管 ---------- */
  /**
   * 转发文案的抬头：宿管最关心的三件事 —— 几月几号星期几、几班、哪几段。
   * 缺一段宿管就不知道自己被叫去顶的是哪一段时间，所以这里一律写全。
   */
  _shareHead(ds, only, segKey) {
    const d0 = parseYmd(ds);
    const dateTxt = `${d0.getMonth() + 1}月${d0.getDate()}日 星期${WEEK_CN[isoDow(d0) - 1]}`;
    const clsList = only
      ? String(only).split(',').map(x => x.trim()).filter(Boolean)
      : [];
    const clsTxt = clsList.length ? clsList.join('、') + '班' : '';
    const _sg = segKey ? activeSegments().find(x => x.key === segKey) : null;
    const segTxt = _sg ? _sg.short : '';
    const parts = [dateTxt, clsTxt, segTxt].filter(Boolean);
    return { dateTxt, clsTxt, segTxt, head: parts.join(' · ') + ' 晚修代班登记' };
  },

  /**
   * 生成发给宿管的文字：几班要代晚修、各段是谁、什么时间。
   * 只含班级与代班信息，不含任何金额。
   */
  shareText(ds, only, segKey) {
    const H = this._shareHead(ds, only, segKey);
    const labelCls = H.clsTxt;
    const d0 = parseYmd(ds);
    const dow = isoDow(d0);
    const segs = activeSegments();
    const L = [];

    L.push(`【${H.head}】`);
    const wk = weekNoOf(ds);
    if (wk) L.push(`（第${wk}周）`);

    const rows = [];
    /* only 有值 → 只列这几个班（从班级弹层「转发给宿管」进来时，可能是 "1" 或 "1,2"） */
    const onlySet = only
      ? new Set(String(only).split(',').map(s => s.trim()).filter(Boolean))
      : null;
    const pool = onlySet
      ? DATA.meta.classes.filter(c => onlySet.has(String(c)))
      : DATA.meta.classes;
    for (const c of pool) {
      const lines = segs.map(s => ({ s, t: teacherOn(ds, c, s.key) })).filter(x => x.t);
      /* 合并格里后面的班本来就没排班，但既然点名要这几个班，就列出来，
         让看的人知道这一格到底覆盖了哪几个班（没人的标「待定」）。*/
      if (!lines.length) {
        if (only) rows.push({ c, uniq: [], blank: true });
        continue;
      }
      // 同一人值多段 → 只写一次名字（段别不标，下面"分段时间"那行会说清）
      const uniq = [];
      for (const l of lines) {
        const f = uniq.find(u => u.t === l.t);
        if (f) f.n++; else uniq.push({ t: l.t, n: 1 });
      }
      rows.push({ c, uniq });
    }

    if (!rows.length) {
      L.push('');
      L.push(only ? `${labelCls}这一天没有安排晚修，无需代班。`
                  : '这一天没有安排晚修，无需代班。');
      return L.join('\n');
    }

    L.push('');
    L.push(only ? `${labelCls}代晚修安排：` : '各班代晚修安排：');
    for (const r of rows) {
      if (r.blank) { L.push(`${r.c}班：待定（并入上一格一起代）`); continue; }
      const names = r.uniq.map(u => u.t).join('、');
      L.push(`${r.c}班：${names}`);
    }

    // 分段时间一目了然，宿管最关心这个
    L.push('');
    L.push(`分段时间：${segs.map(s => `${s.short} ${s.time || ''}`.trim()).join('　')}`);

    const dormHere = rows.filter(r => r.uniq.some(u => DATA.dormStaff.includes(u.t)));
    if (dormHere.length) {
      L.push(`其中宿管已安排：${dormHere.map(r => r.c + '班').join('、')}`);
    }

    L.push('');
    L.push('（本条为晚修代班通知，具体次数以学校安排为准）');
    return L.join('\n');
  },

  /**
   * 是不是「桌面浏览器」。
   * macOS 的系统分享面板里根本没有微信（微信没装成系统分享扩展），
   * 弹出来只有隔空投送/邮件/信息/备忘录这些，用不上。
   * 所以桌面上一律不走 navigator.share。
   */
  _isDesktop() {
    const ua = navigator.userAgent || '';
    if (/Mobi|Android|iPhone|iPad/i.test(ua)) return false;
    /* iPadOS 13+ 的 UA 伪装成 Macintosh，靠触摸点数区分 */
    if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return false;
    return true;
  },

  /** 唤起微信桌面端。装了微信才会跳过去，没装就静默失败（不影响已复制的内容）。 */
  _openWeixin() {
    /* 先给微信一点反应时间，避免刚复制完就被这次跳转打断 */
    setTimeout(() => {
      try { window.location.href = 'weixin://'; } catch (e) { /* 忽略 */ }
    }, 120);
  },

  /**
   * 电脑端的发送指引：把「复制好 → 打开微信 → 选人 → 粘贴」一步步说清楚。
   * 微信桌面端没有「粘贴并发送」的接口，能做的最顺的就是把内容备好，
   * 剩下的两步由她按快捷键完成 —— 但必须说清楚，否则她会以为没成功。
   */
  _desktopGuide(msg, ok) {
    const steps = ok
      ? [`整段话已经复制好了（<b>${esc(msg.split('\n')[0])}</b>…）`,
         '微信已经帮你打开',
         '在微信里选中那个宿管的聊天窗口',
         '按 <b>⌘V</b>（Windows 按 <b>Ctrl+V</b>）粘贴，然后发送']
      : ['自动复制没成功（可能是浏览器拦了）',
         '上面的文字框已经全选好了',
         '手动按 <b>⌘C</b>（Windows <b>Ctrl+C</b>）复制',
         '到微信里选住宿管的聊天窗口，按 <b>⌘V</b> 粘贴并发送'];
    this.openSheet('发到微信 · 电脑端',
      `<div style="padding:14px 16px 4px">
        <div style="font-size:13px;color:var(--txt);line-height:1.85">
          ${steps.map((s, i) =>
            `<div style="display:flex;gap:9px;margin-bottom:9px">
               <span style="flex:0 0 19px;height:19px;border-radius:50%;
                 background:var(--blue);color:#fff;font-size:11.5px;
                 display:flex;align-items:center;justify-content:center;
                 margin-top:2px">${i + 1}</span>
               <span style="flex:1">${s}</span></div>`).join('')}
        </div>
        <textarea id="guideTxt" readonly style="width:100%;min-height:104px;
          margin-top:4px;padding:11px 12px;border:1px solid var(--line);
          border-radius:10px;font-size:12.5px;line-height:1.7;
          font-family:inherit;color:var(--txt);background:var(--rowh);
          resize:none">${esc(msg)}</textarea>
        <div style="font-size:11.5px;color:var(--txt3);margin-top:7px">
          微信每次只能粘贴一条，转几个宿管就重复操作几次。</div>
      </div>`,
      `<button class="btn btn-p" id="btnGuideCopy">再复制一次</button>
       <button class="btn btn-s" id="btnGuideClose">关闭</button>`);
    /* 文字框预选好，Cmd+C 一次就能拿到 */
    const ta = document.getElementById('guideTxt');
    if (ta) { ta.removeAttribute('readonly'); ta.focus(); ta.setSelectionRange(0, ta.value.length); }
  },

  /**
   * 发到微信。
   * 手机上（尤其微信里打开）→ 调系统分享，微信就在第一项。
   * 电脑上 → 系统分享面板里没有微信，改成「复制整段话 + 唤起微信桌面端 + 一步步指引」。
   */
  async shareToWx(ds, only, segKey) {
    if (!ds) return;
    let link = this._shareLink;
    if (!link) {
      /* 链接还没生成出来 → 直接帮他触发生成，省得再点一次「转发给宿管」 */
      this.toast('链接正在生成，请稍等…');
      await this.retryShareLink();
      link = this._shareLink;
      if (!link) return;
    }
    /* 抬头写全：几月几号星期几 · 几班 · 第几段。
       宿管在微信里只看得到这一段文字，缺一项就得回头问一遍。 */
    const H = this._shareHead(ds, only, segKey || this._shareSeg);
    const head = H.head;
    /* 链接必须写进文字里（宿管要点开），所以这份文字是完整的，不能省。
       措辞改成"直接点下面这个链接"—— 明确告诉宿管点链接就能用，
       不用复制到浏览器折腾一圈，他就不会去试那些有的没的。 */
    const msg = `${head}：\n直接点下面这个链接，填上你的名字就行：\n${link}`;

    /* 微信内置浏览器 / 手机 → 系统分享，微信在列表里 */
    const ua = navigator.userAgent || '';
    const inWeixin = /MicroMessenger/i.test(ua);
    if (inWeixin || (navigator.share && !this._isDesktop())) {
      try {
        /*⚠️ 只能传 text，绝对不能传 url / title。
           微信只要看到 url，就把整条分享渲染成「标题 + 纯网址」的链接卡片，
           text 里写的内容会被整段丢掉 —— 宿管就只看到一个光秃秃的网址。
           只传文字，微信才按普通消息发出去，日期/班级/段别全都看得见。 */
        await navigator.share({ text: msg });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        /* 其它错误 → 落到复制 */
      }
    }

    /* 电脑端：先把整段话复制好，再唤起微信桌面端，然后一步步告诉她怎么发 */
    const ok = await this.copyText(msg);
    this._shareMsg = msg;
    /* 原来的转发弹层如果还开着，把文字栏也换成完整整段话（全选好），
       这样即使她没看指引，也能直接在那个弹层里 Cmd+C。 */
    const ta = document.getElementById('shareTxt');
    if (ta) {
      ta.removeAttribute('readonly');
      ta.value = msg;
    }
    this._openWeixin();
    this._desktopGuide(msg, ok);
  },

  /** 复制到剪贴板（兼容旧浏览器 / 非https 环境） */
  async copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* 继续走兜底 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:0;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  },

  /** 本机的分享码（第一次用时随机生成，之后一直不变） */
  /**
   * 分享码。
   *
   * ⚠️ 这里**不能每台设备随机生成** —— 那样手机和电脑是两个不同的码，
   * 宿管在手机上登记，电脑读不到，就出现"手机同步了电脑没同步"。
   * 改成和 syncCode 同一个固定值，各设备才认同一份数据。
   * 老版本发出去的链接仍然能用（历史登记还在）。
   */
  shareToken() {
    return this.syncCode();
  },

  /** 宿管登记页的基础地址（与 index.html 同目录） */
  dormBase() {
    return location.origin + location.pathname.replace(/[^/]*$/, '') + 'dorm.html';
  },

  /** 某一天的宿管登记短链（先把排班快照存云端，链接只带 code）
   *  only 有值 → 只发这一个班（从班级弹层转发） */
  async shareLink(ds, only, segKey) {
    const segs = activeSegments();
    /* 只把「有排班」的班级给出去，宿管不用为没排班的班勾选 */
    /*only 有值 → 就用这几个班，不要再按「有排班」过滤。
       合并格里后面的班本来是没排班的（所以才并进前一个格子），
       但它恰恰也是要宿管接手的一部分 —— 过滤掉就漏班了。
       没有 only（当天明细转发）才过滤掉完全没排班的班。 */
    let pool;
    if (only) {
      const onlySet = new Set(String(only).split(',').map(x => x.trim()).filter(Boolean));
      pool = DATA.meta.classes.filter(c => onlySet.has(String(c)));
    } else {
      pool = DATA.meta.classes.filter(c => segs.some(s => teacherOn(ds, c, s.key)));
    }
    const payload = {
      v: 1,
      d: ds,
      t: this.shareToken(),
      c: pool.join(','),
      /* 从选人界面（分段面板）转发时带上段别，宿管页能显示"第几段"。
         没带就不显示 —— 从当天明细转发时是整个班，不该限定某段。 */
      sg: segKey || '',
      /* one=1 表示只登记一个班，宿管页就不用再勾选了 */
      one: only ? 1 : 0,
      g: segs.map(s => `${s.short} ${s.time || ''}`.trim()).join('　'),
      n: (DATA.dormStaff || []).join(',')
    };
    const code = await window.CloudDuty.saveLink(payload);
    return `${this.mPEntry()}?k=${code}`;
  },

  /**
   * 宿管登记的入口地址。
   *
   * ⚠️ 微信会拦未加白的域名：点网页链接会弹「请在浏览器中打开」，
   *   所以最终要切到小程序入口（走微信自己的运行环境，不受那条限制）。
   *
   * 现在小程序还没绑定/发布（appid 还是 touristappid），拿不到可用的
   * 小程序码，所以默认仍走网页链接，等发布完只要把下面这行改成
   * 小程序入口即可，全站转发、分享文案都会跟着切。
   *
   * 例：改成小程序页面路径时，形如
   *   'weixin://dl/business/?t=<小程序码>'  或  小程序分享链接
   */
  mPEntry() {
    /* ↓↓↓ 小程序发布后，把这里换成小程序入口，宿管就能点开直接填 ↓↓↓ */
    // return '小程序入口地址';
    return this.dormBase();
  },

  /** 转发弹层：链接 + 文字两种都给，宿管想用哪个用哪个 */
  async shareSheet(ds, only, segKey) {
    const text = this.shareText(ds, only, segKey);
    const H = this._shareHead(ds, only, segKey);
    /* 标题和提示语都带日期+班级+段别 —— 宿管一眼知道是哪天、哪几班、哪一段 */
    const title = `转发给宿管 · ${H.head}`;
    const tip = `这是<b>${H.head}</b>。发给宿管，他点开填上自己名字就行。`;

    /* 先把弹层骨架画出来，链接要等云端返回 */
    this.openSheet(title, `
      <div style="padding:12px 16px 4px">
        <div style="font-size:12.5px;color:var(--txt2);margin-bottom:9px">${tip}</div>
        <div style="font-size:11.5px;color:var(--txt3);margin:-4px 0 10px">
          点「转到微信」：手机直接进微信，电脑会替你复制好并打开微信。</div>
        <div class="lk-box" id="linkBox">
          <div class="lk-lab">登记链接</div>
          <textarea id="shareLink" rows="2" readonly
            style="width:100%;padding:10px 11px;border:1px solid var(--line);
              border-radius:9px;font-size:12px;line-height:1.5;
              font-family:inherit;color:var(--txt2);background:var(--rowh);
              resize:none">正在生成…</textarea>
        </div>
        <div class="lk-box" style="margin-top:12px">
          <div class="lk-lab">或者发文字（不想点链接时）</div>
          <textarea id="shareTxt" rows="8" readonly
            style="width:100%;padding:11px 12px;border:1px solid var(--line);
              border-radius:10px;font-size:13px;line-height:1.7;
              font-family:inherit;color:var(--txt);background:var(--rowh);
              resize:none">${esc(text)}</textarea>
        </div>
      </div>`, `
      <button class="btn btn-wx" id="btnShareWx">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
          style="width:17px;height:17px;flex:0 0 17px">
          <path d="M8.7 3C4.9 3 1.8 5.6 1.8 8.8c0 1.8 1 3.4 2.6 4.5l-.7 2.1 2.5-1.3c.8.2 1.6.4 2.5.4h.6a5.3 5.3 0 0 1-.2-1.4c0-3.1 3-5.6 6.7-5.6h.6C15.4 4.8 12.4 3 8.7 3zM6.3 7.4a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8zm4.9 0a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8z"/>
          <path d="M22.2 13.1c0-2.6-2.7-4.7-5.9-4.7s-5.9 2.1-5.9 4.7 2.6 4.7 5.9 4.7c.7 0 1.4-.1 2-.3l2.1 1.1-.6-1.8c1.5-.9 2.5-2.2 2.5-3.7zm-7.8-1.2a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6zm4 0a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6z"/>
        </svg><span>转到微信</span></button>
      <button class="btn btn-s" id="btnShareCopy">复制链接</button>`);
    this._shareDs = ds;
    this._shareOnly = only || '';
    this._shareSeg = segKey || '';
    this._shareText = text;
    this._shareLink = '';

    /* 生成短链并回填 */
    try {
      const link = await this.shareLink(ds, only, segKey);
      this._shareLink = link;
      const la = document.getElementById('shareLink');
      if (la) { la.value = link; la.style.color = ''; }
    } catch (e) {
      this._shareLinkFail = true;
      const msg = this.linkFailMsg(e);
      const box = document.getElementById('linkBox');
      if (box) {
        box.innerHTML = `<div class="lk-lab">登记链接</div>`
          + `<div class="lk-err">${esc(msg)}</div>`
          + '<button class="lk-retry" id="btnLinkRetry">重新生成</button>';
      }
      this.toast(msg);
    }
  },

  /** 生成失败的原因要说人话，并给出自救办法 */
  linkFailMsg(e) {
    const raw = (e && e.message) || '';
    /* 云服务组件没加载出来 = 页面版本太旧（老版本走的是被墙的 CDN） */
    if (!window.WorkBuddyCloud) {
      return '页面版本太旧了：请点右上角「···」→ 刷新，或在网址后加 ?r=1';
    }
    if (/超时|timeout|network|Failed to fetch|load/i.test(raw)) {
      return '网络太慢没赶上，链接没生成出来。请点「重新生成」再试一次';
    }
    return '生成失败：' + (raw || '网络异常') + '（可点「重新生成」再试）';
  },

  /** 点「立即同步」：手动同步一次，并把结果说清楚 */
  async syncNow(opts) {
    const r = await this._syncNowInner(opts || {});
    const sum = this.dataSummary();

    /* 光说"已同步"没用 —— 遇到"两边都是空的"这种时候，
       她会以为同步坏了，其实是真的没内容可同步。必须说清楚。 */
    let msg;
    if (!r || !r.ok) {
      msg = '连不上云服务，请检查网络后重试';
    } else if (r.pulled) {
      msg = `已拉到云端最新（${sum.days} 天有改动）`;
    } else if (sum.days === 0 && sum.applied === 0) {
      msg = '两台设备数据一致（目前都没有改动）';
    } else {
      msg = `已上传本机数据（${sum.days} 天有改动）`;
    }
    this.toast(msg);
    if (this.page === 'set') this.buildSettings();
    return r;
  },

  /** 点「重新生成」：重新取链接，不关弹层 */
  async retryShareLink() {
    const ds = this._shareDs, only = this._shareOnly, segKey = this._shareSeg;
    const box = document.getElementById('linkBox');
    if (box) {
      box.innerHTML = '<div class="lk-lab">登记链接</div>'
        + '<div class="lk-wait">正在重新生成…</div>';
    }
    try {
      const link = await this.shareLink(ds, only, segKey);
      this._shareLink = link;
      this._shareLinkFail = false;
      if (box) {
        box.innerHTML = '<div class="lk-lab">登记链接</div>'
          + `<textarea id="shareLink" rows="2" readonly
             style="width:100%;padding:10px 11px;border:1px solid var(--line);
               border-radius:9px;font-size:12px;line-height:1.5;
               font-family:inherit;color:var(--txt2);background:var(--rowh);
               resize:none">${esc(link)}</textarea>`;
      }
      this.toast('链接已生成');
    } catch (e) {
      if (box) {
        box.innerHTML = '<div class="lk-lab">登记链接</div>'
          + `<div class="lk-err">${esc(this.linkFailMsg(e))}</div>`
          + '<button class="lk-retry" id="btnLinkRetry">重新生成</button>';
      }
      this.toast(this.linkFailMsg(e));
    }
  },

  /** 把某一天渲染进calwrap 里的 #daypanel（旧路径，保留） */
  renderDay() {
    const el = document.getElementById('daypanel');
    if (!el) return;
    el.innerHTML = this.dayHtml(this.sel);
  },

  /** 点行首日期 → 用弹层显示当天明细（不再切换视图） */
  openDaySheet(ds) {
    if (!ds) return;
    this.sel = ds;
    this._saveWhere();
    this.renderCal();
    this.renderGrid();
    const d0 = parseYmd(ds);
    this.openSheet(`${d0.getMonth() + 1}月${d0.getDate()}日 星期${WEEK_CN[isoDow(d0) - 1]}`,
      this.dayHtml(ds),
      `<button class="btn btn-p" onclick="App.closeSheet()">关闭</button>`);
    /* 宿管登记是异步的，先渲染骨架再填内容 */
    if (window.CloudDuty) this.renderDormCard(ds);
  },

  toggleHoliday(ds) {
    const i = DATA.holidays.indexOf(ds);
    if (i>=0) DATA.holidays.splice(i,1);
    else { DATA.holidays.push(ds); DATA.holidays.sort(); }
    save(); this.renderAll();
    this.toast(i>=0 ? '已取消放假标记' : '已标记放假，不计入统计');
  },

  resetDay(ds) {
    delete DATA.overrides[ds];
    save(); this.renderAll();
    this.toast('已恢复为模板排班');
  },

  copyDay(ds) {
    const tplId = templateFor(ds);
    const base = DATA.templates[tplId];
    const dow = isoDow(parseYmd(ds));
    const baseRow = base ? (base.grid[dow]||{}) : {};
    const cur = {};
    DATA.meta.classes.forEach(c=>{ const t=teacherOn(ds,c); if(t) cur[c]=t; });
    if (Object.keys(cur).length===0) { this.toast('这天没有排班可复制'); return; }
    this._copy = { cur, baseRow, label: base ? base.label : '当前模板' };
    this.openSheet('复制到其他日期',
      this._copyOptsHtml(ds), '');
  },

  _copyOptsHtml(ds) {
    const [y,m] = this.ym.split('-').map(Number);
    const dim = new Date(y,m,0).getDate();
    let h = '<div class="sec-t">选择目标日期（按目标日期的单双周决定用哪一版）</div>';
    for (let d=1; d<=dim; d++) {
      const tds = `${y}-${pad(m)}-${pad(d)}`;
      if (tds===ds) continue;
      const dow = new Date(y,m-1,d).getDay();
      if (dow===0||dow===6) continue;
      const par = parityOf(tds);
      h += `<div class="opt" data-copy="${tds}">
        <div class="nm">${m}月${d}日 <em>星期${WEEK_CN[dow-1]} · ${par==='single'?'单周':'双周'}</em></div>
      </div>`;
    }
    return h;
  },

  doCopy(target) {
    const { cur } = this._copy;
    if (!DATA.overrides[target]) DATA.overrides[target] = {};
    // 先按目标日期自己的单双周铺模板，再覆盖源内容
    const tpl = DATA.templates[templateFor(target)];
    const dow = isoDow(parseYmd(target));
    if (tpl) {
      const row = tpl.grid[dow]||{};
      DATA.meta.classes.forEach(c=>{
        if (row[c]) DATA.overrides[target][c] = row[c];
      });
    }
    Object.assign(DATA.overrides[target], cur);
    save();
    this._copy = null;
    this.closeSheet();
    this.pick(target);
    this.toast(`已复制到 ${target}`);
  },

  /* ---------- 选择老师（支持分段） ---------- */
  pickTeacher(ds, c) {
    this._pickCtx = { ds, c };
    const segs = activeSegments();

    let h = '';

    // 分段选择器：每个分段显示当前老师，点进去单独换
    h += '<div class="segpick">';
    for (const s of segs) {
      const cur = teacherOn(ds, c, s.key);
      const isD = cur && DATA.dormStaff.includes(cur);
      h += `<div class="segrow ${isD ? 'dorm' : ''}" data-segpick="${s.key}">
        <div class="seg-lbl">
          <b>${esc(s.short)}</b>
          <em>${esc(s.time)}</em>
        </div>
        <div class="seg-cur">${cur ? esc(cur) : '<span class="none">未排</span>'}</div>
        <div class="seg-arrow">›</div>
      </div>`;
    }
    h += '</div>';

    // 底部：「转发给宿管」 + 「确认」
    // 转发放在这里，是因为宿管常常是「看到某班缺人」时直接被叫来的，
    // 不用先退回当天明细再找转发。
    /* 从哪个格点的就转发那几格：王文燕带 1+2 班时，转发出去也是 1+2 班，
       只发第一个班会让宿管漏掉后面的班。 */
    const shareCls = this._pickClsList || String(c);
    this.openSheet(`${c}班 · ${ds.slice(5)} 星期${WEEK_CN[isoDow(parseYmd(ds))-1]}`, h, `
      <button class="btn btn-share" data-act="share" data-ds="${ds}" data-gc="${shareCls}">`
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
      + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="M16 6l-4-4-4 4"/>'
      + '<path d="M12 2v13"/></svg><span>转发给宿管</span></button>'
      + `<button class="btn btn-p" onclick="App.closeSheet()">确认</button>`);
  },

  /** 从弹层里选一段，返回该段 key */
  pickSegPane(segKey) {
    const { ds, c } = this._pickCtx;
    this._segCtx = segKey;
    const s = activeSegments().find(x => x.key === segKey);
    const cur = teacherOn(ds, c, segKey);

    let h = `<div class="pane-hd">
      <span class="ph-lbl">${esc(s ? s.label : segKey)}</span>
      <span class="ph-time">${esc(s ? s.time : '')}</span>
      
    </div>
    <div class="search"><input id="kw" placeholder="搜索老师姓名…" oninput="App.filterOpt(this.value)"></div>
    <div id="optlist">${this.optsHtml(cur, null)}</div>`;

    /* 底部只留「转发给宿管」+「返回」。
       「清空此段」已按要求去掉 —— 要清空时在分段一览里选「未排」即可，
       不给一个会直接抹掉数据的按钮。 */
    const clsList = this._pickClsList || String(c);
    this.openSheet(`${c}班 · ${esc(s ? s.label : segKey)}`, h, `
      <button class="btn btn-share" data-act="share" data-ds="${ds}" data-gc="${clsList}" data-sg="${segKey}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="M16 6l-4-4-4 4"/>
          <path d="M12 2v13"/></svg><span>转发给宿管</span></button>
      <button class="btn btn-p" style="flex:0 0 92px" onclick="App.closeSheet()">返回</button>`);
  },

  /** 把任意写法的排班值摊平成「老师名」列表（字符串 / 数组 / {s1,s2} 都支持） */
  _flatTeachers(v, out) {
    if (v == null) return;
    if (typeof v === 'string') { if (v) out.add(v); return; }
    if (Array.isArray(v)) { v.forEach(x => this._flatTeachers(x, out)); return; }
    if (typeof v === 'object') Object.values(v).forEach(x => this._flatTeachers(x, out));
  },

  optsHtml(cur, baseT) {
    const sel = new Set();
    DATA.teachers.forEach(t => sel.add(t));
    DATA.dormStaff.forEach(t => { if (t) sel.add(t); });
    DATA.adminStaff.forEach(t => { if (t) sel.add(t); });
    /* override /模板里可能存着 {s1:'A', s2:'B'} 这种分段对象，
       必须逐段摊开，否则会把整个对象当成一个"老师名"塞进列表，
       后面 localeCompare 会炸掉。 */
    Object.keys(DATA.overrides).forEach(k => {
      Object.values(DATA.overrides[k]).forEach(v => this._flatTeachers(v, sel));
    });
    Object.values(DATA.templates).forEach(t =>
      Object.values(t.grid).forEach(r => Object.values(r).forEach(v =>
        this._flatTeachers(v, sel))));

    let h = '';
    const dorm = [...sel].filter(t => DATA.dormStaff.includes(t)).sort((a, b) => a.localeCompare(b, 'zh'));
    const admin = [...sel].filter(t => !DATA.dormStaff.includes(t) && DATA.adminStaff.includes(t))
      .sort((a, b) => a.localeCompare(b, 'zh'));
    const norm = [...sel].filter(t => !DATA.dormStaff.includes(t) && !DATA.adminStaff.includes(t))
      .sort((a, b) => a.localeCompare(b, 'zh'));

    if (dorm.length) {
      h += '<div class="sec-t">宿管</div>';
      for (const t of dorm) h += this.optRow(t, cur, baseT, true);
    }
    if (admin.length) {
      h += '<div class="sec-t">行政人员</div>';
      for (const t of admin) h += this.optRow(t, cur, baseT, false);
    }
    h += '<div class="sec-t">任课老师</div>';
    for (const t of norm) h += this.optRow(t, cur, baseT, false);
    return h;
  },

  /* 只留姓名 —— 原来的圆形头像（取名字后两字）已按要求去掉。
     isDorm 改成给名字加紫色，保留"这是宿管"的视觉区分。 */
  optRow(t, cur, baseT, isDorm) {
    const on = t===cur;
    return `<div class="opt ${on?'sel':''}${isDorm?' dorm':''}" data-n="${esc(t)}" data-t="${esc(t)}">
      <div class="nm">${esc(t)}${baseT===t?' <em>模板原值</em>':''}</div>
      ${on?'<div class="ck">✓</div>':''}
    </div>`;
  },

  /** 事件委托：弹层内所有交互 */
  _bindDelegate() {
    const mask = document.getElementById('mask');
    if (mask._bound) return;
    mask._bound = true;

    // 预览表里的输入框：input 与 change 都要响应
    const onEdit = e => {
      const pvT = e.target.closest('[data-pv-f="times"]');
      if (pvT && this._impItems) {
        const i = +pvT.dataset.i;
        const v = Math.max(1, parseInt(pvT.value) || 1);
        pvT.value = v;
        this._impItems[i].times = v;
        this.refreshPreviewAmount();
        return;
      }
      const pvN = e.target.closest('[data-pv-f="teacher"]');
      if (pvN && this._impItems) {
        this._impItems[+pvN.dataset.i].teacher = pvN.value.trim();
        this.refreshPreviewAmount();
        return;
      }
    };
    mask.addEventListener('input', onEdit);
    mask.addEventListener('change', onEdit);

    mask.addEventListener('click', e => {
      // 点遮罩空白处关闭
      if (e.target === mask) { this.closeSheet(); return; }

      // 关闭按钮
      if (e.target.classList.contains('sh-x')) { this.closeSheet(); return; }

      // 点分段行 → 进入该段选人
      const segRow = e.target.closest('[data-segpick]');
      if (segRow) { this.pickSegPane(segRow.dataset.segpick); return; }

      // 选人（带 data-t）
      const pickOpt = e.target.closest('.opt[data-t]');
      if (pickOpt && this._pickCtx) {
        this.setT(this._pickCtx.ds, this._pickCtx.c, pickOpt.dataset.t);
        return;
      }

      // 转发弹层：发到微信 / 复制链接
      if (e.target.id === 'btnShareWx')    { this.shareToWx(this._shareDs, this._shareOnly, this._shareSeg); return; }
      if (e.target.id === 'btnLinkRetry')  { this.retryShareLink(); return; }
      /* 电脑端发送指引弹层里的「再复制一次」 */
      if (e.target.id === 'btnGuideCopy')  {
        const m = this._shareMsg || '';
        this.copyText(m).then(ok => {
          this.toast(ok ? '已复制，去微信里粘贴' : '复制没成功，长按上面的文字手动复制');
        });
        return;
      }
      if (e.target.id === 'btnDelRoQuick') { this.doDelRosterQuick(); return; }
      if (e.target.id === 'btnGuideClose') { this.closeSheet(); return; }
      /* 周次列表：点某一周直接跳过去 */
      const wki = e.target.closest('.wk-i[data-w]');
      if (wki) { this.gotoWeek(wki.dataset.w); return; }
      if (e.target.id === 'btnShareCopy') {
        const la = document.getElementById('shareLink');
        const ta = document.getElementById('shareTxt');
        const target = la || ta;
        if (!target) return;
        const isLink = !!la;
        target.removeAttribute('readonly');
        this.copyText(this._shareLink || this._shareText || '').then(ok => {
          /* 复制兜底方案会临时建textarea 再删掉，焦点会被带走，
             这里把焦点还给正文，用户可以直接长按全选复制。 */
          target.focus(); target.setSelectionRange(0, target.value.length);
          this.toast(ok ? (isLink ? '链接已复制，粘贴给宿管即可' : '文字已复制')
                        : '请长按上面的内容全选复制');
        });
        return;
      }

      // 复制到日期
      const copyOpt = e.target.closest('.opt[data-copy]');
      if (copyOpt) { this.doCopy(copyOpt.dataset.copy); return; }

      // 名单制：选老师
      const roT = e.target.closest('#optlist .opt[data-teacher]');
      if (roT && this._roCtx) {
        this._roTeacher = roT.dataset.teacher;
        document.querySelectorAll('#optlist .opt').forEach(o => o.classList.remove('sel'));
        roT.classList.add('sel');
        return;
      }
      // 名单制：次数 ±
      const tm = e.target.closest('[data-act="tm"]');
      if (tm) {
        const inp = document.getElementById('rtimes');
        const d = parseInt(tm.dataset.d) || 0;
        inp.value = Math.max(1, (parseInt(inp.value) || 1) + d);
        return;
      }
      if (e.target.id === 'btnSaveRo') { this.saveRoster(); return; }
      if (e.target.id === 'btnDelRo')  { this.delRoster(); return; }
      if (e.target.id === 'btnParseText') { this.parsePastedText(); return; }
      if (e.target.id === 'btnSaveImp')   { this.saveImported(); return; }

      // 额外登记：岗位类型
      const dutyOpt = e.target.closest('#dutylist .opt[data-d]');
      if (dutyOpt) {
        this._duty = dutyOpt.dataset.d;
        document.querySelectorAll('#dutylist .opt').forEach(o => o.classList.remove('sel'));
        dutyOpt.classList.add('sel');
        return;
      }
      // 额外登记：老师
      const etOpt = e.target.closest('#optlist .opt[data-n]');
      if (etOpt) {
        this._eteacher = etOpt.dataset.n;
        document.querySelectorAll('#optlist .opt').forEach(o => o.classList.remove('sel'));
        etOpt.classList.add('sel');
        return;
      }
      if (e.target.id === 'btnSaveEx') { this.saveExtra(); return; }
      if (e.target.id === 'btnDelEx')  { this.delExtra(); return; }
    });
  },

  filterOpt(kw) {
    kw = (kw||'').trim().toLowerCase();
    document.querySelectorAll('#optlist .opt').forEach(o=>{
      o.style.display = !kw || (o.dataset.n||'').toLowerCase().includes(kw) ? '' : 'none';
    });
  },

  /** 取该班「当前生效」的全部分段值（override 优先，否则回落模板） */
  _segBag(ds, c) {
    const cur = (DATA.overrides[ds] || {})[c];
    if (cur != null && typeof cur === 'object' && !Array.isArray(cur)) {
      const o = {}; activeSegments().forEach(s => { o[s.key] = cur[s.key] || ''; });
      return o;
    }
    // 没有 override（或旧写法）→ 用当前实际值（已含模板回落）打底
    const bag = {};
    activeSegments().forEach(s => { bag[s.key] = teacherOn(ds, c, s.key) || ''; });
    return bag;
  },

  /** 把某个班某一段的值写进 overrides；返回是否真的变了 */
  _applySeg(ds, c, name, seg) {
    if (!DATA.overrides[ds]) DATA.overrides[ds] = {};

    /* 一定要从「当前生效值」打底，不能从空对象起手——
       否则只改一段会写出一条残缺的 override，把其他段的模板值顶掉。 */
    const before = this._segBag(ds, c);
    const bag = { ...before };
    bag[seg] = (name === null || name === '') ? '' : name;

    // 全空、或与改动前完全一致 → 删掉这条 override，让它继续跟随模板
    const segKeys = activeSegments().map(s => s.key);
    const hasContent = segKeys.some(k => bag[k]);
    const unchanged = segKeys.every(k => (bag[k] || '') === (before[k] || ''));
    if (!hasContent || unchanged) {
      delete DATA.overrides[ds][c];
    } else {
      DATA.overrides[ds][c] = bag;
    }
    if (!Object.keys(DATA.overrides[ds]).length) delete DATA.overrides[ds];
    return !unchanged;
  },

  setT(ds, c, name, segKey) {
    const seg = segKey || this._segCtx || 's1';

    /* 一个格子可能覆盖多个班（相邻同一人会合并）。
       在这个格子里选人 = 这几个班都是这个人，必须都写进去，
       否则后面的班会一直是空的、每次渲染又被并回来，看着像"带了"其实没记。 */
    const list = (this._pickCtx && this._pickClsList)
      ? String(this._pickClsList).split(',').map(x => x.trim()).filter(Boolean)
      : [String(c)];
    const targets = list.length ? list : [String(c)];

    let changed = false;
    targets.forEach(cc => { if (this._applySeg(ds, cc, name, seg)) changed = true; });

    this.saveAndSync();
    const segTxt = seg === 's2' ? '二段' : seg === 's3' ? '三段' : '一段';
    const label = targets.length > 1 ? targets.join('、') + '班' : (c + '班');
    /* 值没变就别写改动痕迹，避免选人面板里点同一个名字也留下一条记录 */
    if (changed) {
      markChanged(name ? `${label}${segTxt} → ${name}` : `${label}${segTxt}清空`,
                  'evening', ds);
    }
    this.renderCal();
    this.renderGrid();
    this.renderChangeBar();
    /* 选完人不直接关弹层，退回「分段一览」，方便接着选另一段；
       没有分段上下文时（如代码内部调用）才彻底关闭。 */
    if (this._pickCtx) {
      this._segCtx = null;
      this.pickTeacher(ds, c);
      this.toast(name ? `${label} ${segTxt} → ${name}` : `${label} ${segTxt} 已清空`);
      return;
    }
    this._pickCtx = null; this._segCtx = null;
    this.closeSheet();
    this.toast(name ? `${label} ${segTxt} → ${name}` : `${label} 已清空`);
  },

  /**
   * 静默写入某个分段（不弹层、不toast、不记改动痕迹）。
   * 给「宿管代班一键写入排班表」用——那里要连续写很多班，
   * 走 setT 会反复弹提示，噪音太大。
   */
  _setTQuiet(ds, c, name, segKey) {
    const seg = segKey || 's1';
    if (!DATA.overrides[ds]) DATA.overrides[ds] = {};
    const before = this._segBag(ds, c);
    const bag = { ...before, [seg]: (name == null || name === '') ? '' : name };
    const segKeys = activeSegments().map(s => s.key);
    const hasContent = segKeys.some(k => bag[k]);
    const unchanged = segKeys.every(k => (bag[k] || '') === (before[k] || ''));
    if (!hasContent || unchanged) delete DATA.overrides[ds][c];
    else DATA.overrides[ds][c] = bag;
    if (!Object.keys(DATA.overrides[ds]).length) delete DATA.overrides[ds];
  },

  /* ---------- 额外登记 ---------- */
  addExtra(ds) { this.extraSheet(ds, null); },
  editExtra(ds, id) { this.extraSheet(ds, id); },

  extraSheet(ds, id) {
    const exs = DATA.extras[ds] || [];
    const e = id ? exs.find(x=>x.id===id) : null;
    const duties = Object.keys(DATA.duties);
    this._exCtx = { ds, id };
    this._duty = (e && e.duty) || '午休';
    this._eteacher = (e && e.teacher) || '';

    let h = '<div class="search"><input id="exkw" placeholder="搜索老师姓名…" oninput="App.filterEx(this.value)"></div>';

    h += '<div class="sec-t">岗位类型</div><div id="dutylist">';
    for (const d of duties) {
      const dc = DATA.duties[d];
      const on = this._duty === d;
      h += `<div class="opt ${on?'sel':''}" data-d="${esc(d)}">
        <div class="nm">${esc(d)} <em>${esc(dc.desc)}</em></div>
        <div class="amt" style="font-size:12.5px;color:var(--txt2)">${dc.sections} 节/次</div>
      </div>`;
    }
    h += '</div>';

    h += '<div class="sec-t">老师</div><div id="optlist">';
    const names = [...new Set([...DATA.teachers, ...DATA.dormStaff, ...(e?[e.teacher]:[])])]
      .filter(Boolean).sort((a,b)=>a.localeCompare(b,'zh'));
    for (const t of names) {
      const on = t === this._eteacher;
      const isD = DATA.dormStaff.includes(t);
      /* 同上：去掉无样式的 .av 头像，只留姓名。宿管的紫色靠 .dorm 类。 */
      h += `<div class="opt ${on?'sel':''} ${isD?'dorm':''}" data-n="${esc(t)}">
        <div class="nm">${esc(t)}</div>
        ${on?'<div class="ck">✓</div>':''}</div>`;
    }
    h += '</div>';

    h += '<div style="padding:12px 16px"><div style="font-size:12px;color:var(--txt2);margin-bottom:6px">备注（可选）</div>'
      + `<input id="enote" value="${esc((e && e.note)||'')}" placeholder="如：代会 / 病假"
          style="width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font-size:15px"></div>`;

    this.openSheet(id ? '编辑额外登记' : '添加额外登记', h,
      `<button class="btn btn-d" id="btnDelEx">${id?'删除':'取消'}</button>
       <button class="btn btn-p" id="btnSaveEx">保存</button>`);
  },

  filterEx(kw) {
    kw = (kw||'').trim().toLowerCase();
    document.querySelectorAll('#optlist .opt').forEach(o=>{
      o.style.display = !kw || (o.dataset.n||'').toLowerCase().includes(kw) ? '' : 'none';
    });
  },

  saveExtra() {
    const { ds, id } = this._exCtx;
    if (!this._eteacher) { this.toast('请先选一位老师'); return; }
    if (!DATA.extras[ds]) DATA.extras[ds] = [];
    const note = ((document.getElementById('enote') || {}).value||'').trim();
    if (id) {
      const e = DATA.extras[ds].find(x=>x.id===id);
      if (e) Object.assign(e, {teacher:this._eteacher, duty:this._duty, note});
    } else {
      DATA.extras[ds].push({ id:'e'+Date.now().toString(36), teacher:this._eteacher, duty:this._duty, note });
    }
    save();
    this._exCtx = null;
    this.closeSheet();
    this.renderCal(); this.renderGrid();
    this.toast('已保存');
  },

  delExtra() {
    const { ds, id } = this._exCtx;
    if (id) {
      DATA.extras[ds] = (DATA.extras[ds]||[]).filter(x=>x.id!==id);
      if (!DATA.extras[ds].length) delete DATA.extras[ds];
      save();
    }
    this._exCtx = null;
    this.closeSheet();
    this.renderCal(); this.renderGrid();
    if (id) this.toast('已删除');
  },

  /* ---------- 当天次数 ---------- */
  stat(ds) {
    const s = computeStats(ds, ds);
    if (!s.rows.length) { this.toast('这一天没有可统计的记录'); return; }
    let h = `<div style="padding:12px 16px;font-size:12.5px;color:var(--txt2)">
      ${ds} 星期${WEEK_CN[isoDow(parseYmd(ds))-1]} · ${parityOf(ds)==='single'?'单周':'双周'}</div>`;
    h += '<div class="tw"><table><thead><tr><th>姓名</th><th>岗位</th><th style="text-align:right">次数</th></tr></thead><tbody>';
    s.rows.forEach(r=>{
      const ds2 = Object.entries(r.duty).map(([k,v])=>`${k}×${v}`).join('<br>');
      h += `<tr><td class="n">${esc(r.name)}</td><td class="z" style="font-size:12px">${ds2}</td>
        <td style="text-align:right;font-weight:600">${r.times}</td></tr>`;
    });
    h += `</tbody><tfoot><tr><td class="n">合计</td><td></td>
      <td style="text-align:right">${s.totals.times}</td></tr></tfoot></table></div>`;
    this.openSheet('当天次数', h, `<button class="btn btn-s" onclick="App.closeSheet()">关闭</button>`);
  },

  /* ---------- 统计页 ---------- */
  renderStats() {
    const [y,m] = this.ym.split('-').map(Number);
    const dim = new Date(y,m,0).getDate();
    const from = `${y}-${pad(m)}-01`, to = `${y}-${pad(m)}-${pad(dim)}`;
    const s = computeStats(from, to);

    /* 顶部那四张汇总卡（值班总次数 / 涉及人数 / 启用分段 / 涉及栏目）已按要求删除，
       统计页直接从下面的「栏目小计」开始，不再有概览数字块。 */
    let h = '';

    // 异常提示
    if (s.anomalies.length) {
      const shown = s.anomalies.slice(0,6);
      h += `<div class="anom"><h4>需人工确认 ${s.anomalies.length} 处</h4><ul>`;
      shown.forEach(a=>h+=`<li>· ${esc(a.msg)}</li>`);
      if (s.anomalies.length>6) h+=`<li>· 还有 ${s.anomalies.length-6} 处，导出 Excel 可看全部</li>`;
      h += '</ul></div>';
    }

    // 列 = 晚修各分段 + 名单制栏目 + 临时岗位（同名去重）
    const segCols = activeSegments().map(x => x.label);
    const rosterCols = rosterPosts().map(k => DATA.posts[k].name);
    const rosterSet = new Set(rosterCols);
    const dutyCols = Object.keys(DATA.duties).filter(d =>
      DATA.duties[d].rate > 0 && !rosterSet.has(d));
    const cols = [...segCols, ...rosterCols, ...dutyCols];

    // 栏目小计卡（只统计次数，不出现任何金额）
    const posts = Object.values(s.byPost).filter(p => p.times > 0);
    if (posts.length) {
      h += '<div class="card"><div class="card-h">栏目小计'
        + '<span class="sub">共 ' + posts.length + ' 个栏目</span></div>'
        + '<div class="card-b" style="padding:0">';
      for (const p of posts) {
        /* 占比改成「次数占比」—— 原来比的是金额，去掉金额后按次数才合理 */
        const pct = s.totals.times ? (p.times / s.totals.times * 100) : 0;
        h += `<div class="po-sum" data-go-post="${p.key}">
          <div class="po-ic">${p.icon}</div>
          <div class="po-mid">
            <div class="po-nm">${esc(p.name)}</div>
            <div class="po-bar"><span style="width:${pct.toFixed(1)}%"></span></div>
          </div>
          <div class="po-txt">${p.times}次 · ${p.headcount}人</div>
        </div>`;
      }
      h += '</div></div>';
    }

    // 汇总表（只统计次数）
    h += `<div class="card"><div class="card-h">次数汇总
      <span class="sub">${y}年${m}月</span></div><div class="tw"><table><thead><tr>
      <th>姓名</th>${cols.map(d=>`<th>${esc(d)}</th>`).join('')}
      <th>合计</th></tr></thead><tbody>`;
    for (const r of s.rows) {
      h += `<tr><td class="n">${esc(r.name)}</td>`;
      cols.forEach(d=>{
        const v = r.duty[d]||0;
        h += `<td class="${v?'':'z'}">${v||'—'}</td>`;
      });
      h += `<td><b>${r.times}</b></td></tr>`;
    }
    h += `</tbody><tfoot><tr><td class="n">合计</td>`;
    cols.forEach(d=>{
      h += `<td>${s.rows.reduce((a,r)=>a+(r.duty[d]||0),0)}</td>`;
    });
    h += `<td>${s.totals.times}</td></tr></tfoot>
      </table></div></div>`;

    // 按栏目拆分（只统计次数）
    h += '<div class="card"><div class="card-h">按栏目拆分</div><div class="tw"><table><thead><tr>'
      + '<th>栏目 / 分段</th><th>次数</th><th>说明</th>'
      + '</tr></thead><tbody>';
    for (const sg of activeSegments()) {
      let n=0;
      s.rows.forEach(r=>{ const v=r.duty[sg.label]||0; n+=v; });
      if (!n) continue;
      h += `<tr><td class="n">${esc(sg.label)}</td><td>${n}</td>
        <td class="z" style="font-size:12px">${esc(sg.time||'')}</td></tr>`;
    }
    for (const k of rosterPosts()) {
      const p = DATA.posts[k];
      let n=0;
      s.rows.forEach(r=>{ const v=r.duty[p.name]||0; n+=v; });
      if (!n) continue;
      h += `<tr><td class="n">${p.icon} ${esc(p.name)}</td><td>${n}</td>
        <td class="z" style="font-size:12px">${esc(p.desc||'')}</td></tr>`;
    }
    for (const d of dutyCols) {
      const dc = DATA.duties[d];
      let n=0;
      s.rows.forEach(r=>{ const v=r.duty[d]||0; n+=v; });
      if (!n) continue;
      h += `<tr><td class="n">${esc(d)}</td><td>${n}</td>
        <td class="z" style="font-size:12px">${esc(dc.desc||'')}</td></tr>`;
    }
    h += '</tbody></table></div></div>';

    // 操作
    h += `<div class="card"><div class="card-h">导出</div><div class="btn-row">
      <button class="btn btn-p" onclick="App.exportXls('${y}-${pad(m)}')">导出 Excel</button>
      <button class="btn btn-s" onclick="App.exportCsv('${y}-${pad(m)}')">导出 CSV</button>
    </div><div class="btn-row" style="padding-top:0">
      <button class="btn btn-s" onclick="App.showDetail('${y}-${pad(m)}')">查看明细</button>
      <button class="btn btn-s" onclick="App.printStat()">打印报表</button>
    </div></div>`;

    document.getElementById('pg-st').innerHTML = h;
  },

  exportXls(ym) {
    const [y,m] = ym.split('-').map(Number);
    const dim = new Date(y,m,0).getDate();
    const s = computeStats(`${y}-${pad(m)}-01`, `${y}-${pad(m)}-${pad(dim)}`);
    exportStatsXlsx(s, `${y}年${m}月`);
    this.toast('已导出 3 个工作表');
  },

  exportCsv(ym) {
    const [y,m] = ym.split('-').map(Number);
    const dim = new Date(y,m,0).getDate();
    const s = computeStats(`${y}-${pad(m)}-01`, `${y}-${pad(m)}-${pad(dim)}`);
    const lines = [['日期','星期','单双周','姓名','岗位','班级数','次数','备注'].join(',')];
    s.detail.forEach(d=>{
      lines.push([d.date,'星期'+WEEK_CN[isoDow(parseYmd(d.date))-1],
        parityOf(d.date)==='single'?'单周':'双周',
        d.teacher,d.duty,d.classes,d.sections,
        '"'+String(d.note||'').replace(/"/g,'""')+'"'].join(','));
    });
    const blob = new Blob(['﻿'+lines.join('\n')], {type:'text/csv;charset=utf-8'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `值班明细_${y}年${m}月.csv`;
    a.click();
    this.toast('已导出 CSV');
  },

  showDetail(ym) {
    const [y,m] = ym.split('-').map(Number);
    const dim = new Date(y,m,0).getDate();
    const s = computeStats(`${y}-${pad(m)}-01`, `${y}-${pad(m)}-${pad(dim)}`);
    let h = `<div style="padding:10px 14px;font-size:12px;color:var(--txt2)">
      共 ${s.detail.length} 条记录</div><div class="tw"><table>
      <thead><tr><th>日期</th><th>姓名</th><th>岗位</th><th>次数</th></tr></thead><tbody>`;
    s.detail.forEach(d=>{
      h += `<tr><td class="z" style="font-size:12px;white-space:nowrap">${d.date.slice(5)}</td>
        <td class="n" style="font-size:13px">${esc(d.teacher)}</td>
        <td class="z" style="font-size:12px">${esc(d.duty)}</td>
        <td style="font-size:12.5px;text-align:right">${d.sections}</td></tr>`;
    });
    h += '</tbody></table></div>';
    this.openSheet(`${y}年${m}月 值班明细`, h, `<button class="btn btn-s" onclick="App.closeSheet()">关闭</button>`);
  },

  printStat() {
    const [y,m] = this.ym.split('-').map(Number);
    const dim = new Date(y,m,0).getDate();
    const s = computeStats(`${y}-${pad(m)}-01`, `${y}-${pad(m)}-${pad(dim)}`);
    const segCols = activeSegments().map(x=>x.label);
    const dn = Object.keys(DATA.duties).filter(d=>DATA.duties[d].rate>0);
    const allCols = [...segCols, ...dn];
    let t = `<html><head><meta charset="utf-8"><title>晚修值班次数表 ${y}年${m}月</title>
      <style>
      body{font:13px/1.6 -apple-system,"PingFang SC",sans-serif;padding:26px;color:#000}
      h1{font-size:19px;text-align:center;margin:0 0 4px}
      .sub{text-align:center;color:#666;font-size:12px;margin-bottom:18px}
      table{width:100%;border-collapse:collapse;font-size:12.5px;margin-bottom:22px}
      th,td{border:1px solid #999;padding:6px 8px;text-align:center}
      th{background:#f0f0f0;font-weight:600}
      td.n{text-align:left;font-weight:600}
      .tf{background:#f7f7f7;font-weight:700}
      .sg{margin-top:34px;font-size:12.5px;display:flex;gap:56px}
      @media print{@page{size:A4;margin:14mm}}
      </style></head><body>
      <h1>${DATA.meta.termName}　晚修值班次数发放表</h1>
      <div class="sub">${y} 年 ${m} 月　共 ${s.totals.headcount} 人　${s.totals.times} 次</div>
      <table><thead><tr><th>姓名</th>${allCols.map(d=>`<th>${esc(d)}</th>`).join('')}<th>合计次数</th></tr></thead><tbody>`;
    s.rows.forEach(r=>{
      t += `<tr><td class="n">${esc(r.name)}</td>`;
      allCols.forEach(d=>{ const v=r.duty[d]||0; t+=`<td>${v||''}</td>`; });
      t += `<td>${r.times}</td></tr>`;
    });
    t += `<tr class="tf"><td class="n">合计</td>`;
    allCols.forEach(d=>{ t+=`<td>${s.rows.reduce((a,r)=>a+(r.duty[d]||0),0)}</td>`; });
    t += `<td>${s.totals.times}</td></tr></tbody></table>
      <div class="sg"><div>制表人：莫雅君</div><div>审核：____________</div><div>年级组长：____________</div></div>
      <script>window.onload=()=>window.print()<\/script></body></html>`;
    const w = window.open('', '_blank');
    if (!w) { this.toast('浏览器拦截了弹窗，请允许后重试'); return; }
    w.document.write(t); w.document.close();
  },

  /* ---------- 设置页 ---------- */
  /** 刷新后说明上次同步到底同步了什么（避免"看不出有没有生效"） */
  _lastSyncNote() {
    let info = null;
    try { info = JSON.parse(sessionStorage.getItem('wx.lastSync') || 'null'); }
    catch (e) { return ''; }
    if (!info) return '';
    sessionStorage.removeItem('wx.lastSync');
    if (!info.days && !info.applied) {
      return `<div class="wk-now" style="color:var(--txt3)">`
        + `上次同步时：两台设备都没有改动记录</div>`;
    }
    return `<div class="wk-now">同步到的改动：`
      + `${info.days} 天排班有改动`
      + (info.applied ? ` · ${info.applied} 条宿管登记` : '')
      + `</div>`;
  },

  buildSettings() {
    const tplIds = Object.keys(DATA.templates);
    let h = '';

    /* 岗位设置 —— 不再有任何金额/单价字段。
       全站只统计次数，所以这里只保留岗位名、说明、颜色和"节数"
       （节数决定一次值班记几次，跟次数直接相关，保留有用）。 */
    h += '<div class="set-g"><div class="set-i"><div class="k">岗位类型</div>'
      + '<div class="v">只统计值班次数，不记录费用。节数决定一次值班记几次</div></div>';
    for (const d of Object.keys(DATA.duties)) {
      const dc = DATA.duties[d];
      h += `<div class="duty-row">
        <div class="duty-h">
          <span class="duty-tag" style="background:${dc.color}">${esc(d)}</span>
          <span class="duty-desc">${esc(dc.desc)}</span>
        </div>
        <div class="rate-row">
          <label>节数</label>
          <input type="number" step="1" min="1" value="${dc.sections}"
                 data-d="${esc(d)}" data-k="sections" oninput="App.setRate(this)">
          <span class="u">节/次</span>
        </div>
      </div>`;
    }
    h += '</div>';

    /* ---------- 外观 ---------- */
    h += '<div class="set-g"><div class="set-i"><div class="k">外观</div>'
      + '<div class="v">选一个顺眼的配色，切完立刻生效，下次打开还在</div>'
      + '<div class="palette">';
    THEMES.forEach(t => {
      const on = (this._theme || 'rose') === t.id;
      h += `<div class="swatch ${on ? 'on' : ''}" data-theme-pick="${t.id}" onclick="App.applyTheme('${t.id}')">
        <div class="sw-bar" style="background:${t.color}"></div>
        <div class="sw-txt">
          <div class="sw-name">${t.name}</div>
          <div class="sw-desc">${t.desc}</div>
        </div>
        <div class="sw-ck">${on ? '✓' : ''}</div>
      </div>`;
    });
    h += '</div></div>';

    // 显示密度
    h += `<div class="set-i"><div class="k">姓名显示</div>
      <div class="v">已固定为完整姓名</div>
      <div class="hint" style="margin-top:8px">表格、名单、统计里一律显示完整姓名，不截断。格子窄时可左右滑动表格</div>
      </div></div>`;

    /* ---------- 晚修分段 ---------- */
    h += '<div class="set-g"><div class="set-i"><div class="k">晚修分段</div>'
      + '<div class="v">同一班可以分段由不同老师值班。关掉不用的分段，点右侧开关启用</div></div>';
    DATA.meta.segments.forEach((sg, i) => {
      h += `<div class="seg-cfg">
        <div class="sc-l">
          <div class="sc-name">${esc(sg.label)}</div>
          <div class="sc-time">${esc(sg.time || '')}</div>
        </div>
        <div class="sc-r">
          <input class="sc-amt" type="number" step="0.5" min="0" value="${sg.rate}"
                 data-seg="${sg.key}" data-k="rate" oninput="App.setSeg(this)" />
          <span class="sc-u">元/次</span>
        </div>
        <button class="sc-sw ${sg.on ? 'on' : ''}" data-segtoggle="${i}"
                onclick="App.toggleSeg(${i})">${sg.on ? '启用' : '停用'}</button>
      </div>`;
    });
    h += `<div class="set-i"><div class="v" style="margin-top:8px">
      一次值班 = 一个分段。启用的分段数越多，每位老师的晚修次数也越多。改完立刻影响统计。</div></div></div>`;

    // 晚修分段计时说明
    h += '<div class="set-g"><div class="set-i"><div class="k">时段设置</div>'
      + '<div class="v">按学校实际时间改，只影响显示，不影响计算</div></div>';
    DATA.meta.segments.forEach(sg => {
      h += `<div class="rate-row" style="display:flex;gap:8px;margin-top:7px;align-items:center">
        <label style="font-size:12px;color:var(--txt2);width:52px;flex:0 0 52px">${esc(sg.short)}</label>
        <input value="${esc(sg.time || '')}" style="flex:1;min-width:0"
               data-segtime="${sg.key}" oninput="App.setSegTime(this)" placeholder="如：18:40~19:40" />
      </div>`;
    });
    h += '</div>';

    // 行政人员名单
    h += `<div class="set-g"><div class="set-i"><div class="k">行政人员名单</div>
      <div class="v">这些人在选择老师时会单独分组显示，方便快速找到。不会自动排晚修</div>
      <input value="${esc(DATA.adminStaff.join('、'))}" onchange="App.setAdmin(this.value)"
        placeholder="用、或逗号分隔，如：王梅、李鹏">
      <div class="hint">行政人员也可以上晚修班，只需在表格里点对应格子就能安排</div>
    </div></div>`;

    // 宿管
    h += `<div class="set-g"><div class="set-i"><div class="k">宿管名单</div>
      <div class="v">填了之后，选择老师时会单独分组显示、紫色标识，值班次数记给宿管</div>
      <input value="${esc(DATA.dormStaff.join('、'))}" onchange="App.setDorm(this.value)"
        placeholder="用、或逗号分隔，如：宿管、王梅"></div>
    </div>`;

    // 学期设置
    /* 多设备同步：放在设置页最前面，因为这是"数据在哪"的第一件事 */
    const _st = DATA.meta.syncedAt
      ? new Date(DATA.meta.syncedAt).toLocaleString('zh-CN', { hour12: false }).slice(0, 16)
      : '还没同步过';
    h += `<div class="set-g"><div class="set-i"><div class="k">多设备同步（手机 ↔ 电脑）</div>
      <div class="v">排班表现在存在云端，<b>手机和电脑看到的是同一份</b>。
      任意一台上改了，另一台刷新页面就同步。</div>
      <div class="wk-now">上次同步：${esc(_st)}</div>
      ${this._lastSyncNote()}
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn btn-p" style="flex:1" onclick="App.syncNow()">立即同步</button>
        <button class="btn btn-s" style="flex:0 0 96px" onclick="App.forceRefresh()">刷新页面</button>
      </div>
      <div class="fld-lb">同步码：${esc(this.syncCode())}<i>两台设备码相同才算同一份数据</i></div>
      ${(() => {
        const sum = this.dataSummary();
        if (sum.days === 0 && sum.applied === 0) {
          return `<div class="wk-now" style="color:var(--amber);margin-top:8px">
            本机还没有任何排班改动。<br>表格里显示的都是 Excel 模板里的原始安排 ——
            两台设备本来就一样，不是不同步。</div>`;
        }
        return `<div class="wk-now" style="margin-top:8px">
          本机有 ${sum.days} 天排班改动${sum.applied ? ` · ${sum.applied} 条宿管登记` : ''}，
          会同步到另一台设备。</div>`;
      })()}
      </div></div>`;

    const _fm = DATA.meta.firstMonday;
    const _wm = DATA.meta.termWeek1Monday || _fm;
    const _nowWk = weekNoOf(ymd(new Date()));
    /* 改动记录：原来放在首页顶部，现在首页不显示了，挪到这里（数据一条没丢） */
    const _logN = recentChanges().length;
    h += `<div class="set-g"><div class="set-i"><div class="k">改动记录</div>
      <div class="v">改过哪些班、什么时候改的，都记在这里。</div>
      <button class="btn btn-s" style="width:100%;margin-top:9px" onclick="App.showChangeLog()">
        查看改动记录${_logN ? `（${_logN} 条）` : ''}</button>
      </div></div>`;

    h += '<div class="set-g"><div class="set-i"><div class="k">学年与周次</div>'
      + `<input type="text" value="${esc(DATA.meta.termName)}" onchange="App.setMeta('termName',this.value)" placeholder="学年名称">`
      + `<div class="fld-lb">第 1 周的周一<i>表格里「第几周」按这个算</i></div>`
      + `<input type="date" value="${_wm}" onchange="App.setMeta('termWeek1Monday',this.value)">`
      + `<div class="wk-now">本周是第 <b>${_nowWk}</b> 周（今天 ${ymd(new Date()).slice(5)}）</div>`
      + '</div>';

    h += `<div class="set-i"><div class="k">单双周起点</div>
      <div class="v">用来判断某天用单周表还是双周表。<b>排班表定好后不要改</b>，改了整个单双周会乱</div>
      <input type="date" value="${_fm}" onchange="App.setMeta('firstMonday',this.value)">
      </div>`;

    // 当前模板
    h += `<div class="set-i"><div class="k">当前使用的排班模板</div>
      <div class="v">这份文件里有多个版本的排班表时，在这里选当前生效的那份</div>`;
    tplIds.forEach(id=>{
      const t = DATA.templates[id];
      let n=0; Object.values(t.grid).forEach(r=>n+=Object.keys(r).length);
      h += `<div style="padding:9px 0;border-bottom:1px solid var(--line2)">
      <div style="display:flex;align-items:center;gap:8px">
        <button class="ex-tag" style="background:${id===DATA.meta.defaultTemplate?'#2563eb':'#e5e7eb'};color:${id===DATA.meta.defaultTemplate?'#fff':'#6b7280'}"
              data-id="${id}" onclick="App.useTpl('${id}')">
          ${id===DATA.meta.defaultTemplate?'使用中':'切用它'}
        </button>
        <span style="flex:1;font-size:13px">${esc(t.label)}</span>
        ${tplIds.length>1?`<span style="color:var(--red);font-size:12px" data-id="${id}" onclick="App.delTpl('${id}')">删除</span>`:''}
      </div>
      <div style="font-size:11.5px;color:var(--txt3);margin-top:3px;padding-left:2px">
        ${esc(t.source||'内置')} · ${n} 条排班 · ${t.mode==='all'?'不分单双周':t.mode==='single'?'仅单周':'仅双周'}
      </div></div>`;
    });
    h += '</div></div>';

    // 导入导出
    h += '<div class="set-g"><div class="set-i"><div class="k">导入 Excel 值班表</div>'
      + '<div class="v">支持你现在的格式：单双周两段式 / 表一表二并排式 / 不分单双周</div>'
      + '<input type="file" id="xls" accept=".xlsx,.xls,.csv" class="file-h" onchange="App.doImport(this)">'
      + '<div class="btn-row" style="padding:12px 0 0">'
      + '<button class="btn btn-p" onclick="document.getElementById(\'xls\').click()">选择 Excel 文件</button>'
      + '<button class="btn btn-s" onclick="App.useDefault()">用内置表</button></div>'
      + '<div class="hint">一次可导入多个排班表，导入后在上方「当前使用的排班模板」里切换。'
      + '已有改动不会丢。</div></div>';

    h += `<div class="set-i"><div class="k">数据备份</div>
      <div class="v">数据只存在这台设备的浏览器里。换手机、清缓存前务必先导出备份</div>
      <div class="btn-row" style="padding:12px 0 0">
        <button class="btn btn-s" onclick="App.backup()">导出备份</button>
        <button class="btn btn-s" onclick="document.getElementById('bak').click()">恢复备份</button>
        <input type="file" id="bak" accept=".json" class="file-h" onchange="App.doRestore(this)"></div></div>`;

    h += `<div class="set-i"><div class="k" style="color:var(--red)">重置全部数据</div>
      <div class="v">清空所有改动、额外登记和放假标记，回到初始状态</div>
      <div class="btn-row" style="padding:12px 0 0">
        <button class="btn btn-d" onclick="App.reset()">确认重置</button></div></div>`;
    h += '</div>';

    // 已加载模板列表
    h += `<div class="set-g"><div class="set-i"><div class="k">已加载的模板（${tplIds.length} 个）</div>`;
    tplIds.forEach(id=>{
      const t = DATA.templates[id];
      let n=0; Object.values(t.grid).forEach(r=>n+=Object.keys(r).length);
      h += `<div style="padding:9px 0;border-bottom:1px solid var(--line2);display:flex;align-items:center;gap:8px">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.label)}</div>
          <div style="font-size:11.5px;color:var(--txt3)">${esc(t.source||'内置')} · ${n} 条排班 ·
            ${t.mode==='all'?'不分单双周':t.mode==='single'?'仅单周':'仅双周'}</div>
        </div>
        ${tplIds.length>1?`<button style="color:var(--red);font-size:12px;flex:0 0 auto" onclick="App.delTpl('${id}')">删除</button>`:''}
      </div>`;
    });
    h += '</div></div>';

    document.getElementById('pg-set').innerHTML = h;
  },

  setRate(el) {
    const { d: duty, k } = el.dataset;
    const v = parseFloat(el.value);
    DATA.duties[duty][k] = (k === 'rate' ? (isNaN(v) ? 0 : v) : (isNaN(v) ? 1 : v));
    save();
  },

  /* ---------- 晚修分段 ---------- */
  setSeg(el) {
    const { seg, k } = el.dataset;
    const s = DATA.meta.segments.find(x => x.key === seg);
    if (!s) return;
    s[k] = parseFloat(el.value) || 0;
    save();
  },

  setSegTime(el) {
    const key = el.dataset.segtime;
    const s = DATA.meta.segments.find(x => x.key === key);
    if (!s) return;
    s.time = el.value;
    save();
  },

  toggleSeg(i) {
    const s = DATA.meta.segments[i];
    if (!s) return;
    // 至少保留一段
    if (s.on && activeSegments().length <= 1) {
      this.toast('至少要保留一个分段');
      return;
    }
    s.on = !s.on;
    save();
    this.buildSettings();
    this.toast(s.on ? `已启用${s.label}` : `已停用${s.label}`);
  },

  /* ---------- 名单 ---------- */
  setAdmin(v) {
    DATA.adminStaff = v.split(/[、,，\s]+/).map(s => s.trim()).filter(Boolean);
    save(); this.toast('行政人员名单已更新');
  },
  setMeta(k, v) {
    DATA.meta[k] = v; save();
    // 周次 / 单双周改了，表格要立刻重画
    if (k === 'termWeek1Monday' || k === 'firstMonday') {
      this.renderCal();
      this.renderGrid();
      this.buildSettings();
    }
  },
  setDorm(v) {
    DATA.dormStaff = v.split(/[、,，\s]+/).map(s=>s.trim()).filter(Boolean);
    save(); this.toast('宿管名单已更新');
  },

  useTpl(id) {
    if (DATA.meta.defaultTemplate === id) return;
    DATA.meta.defaultTemplate = id;
    this.saveAndSync(); this.buildSettings();
    this.toast(`已切换到「${DATA.templates[id].label}」`);
  },

  useDefault() {
    DATA.templates = deepClone(DEFAULT_DATA.templates);
    DATA.meta.defaultTemplate = DEFAULT_DATA.meta.defaultTemplate;
    DATA.teachers = DEFAULT_DATA.teachers.slice();
    this.saveAndSync(); this.buildSettings();
    this.toast('已切换到内置表');
  },

  delTpl(id) {
    delete DATA.templates[id];
    if (DATA.meta.defaultTemplate===id) DATA.meta.defaultTemplate = Object.keys(DATA.templates)[0];
    this.saveAndSync(); this.buildSettings(); this.toast('已删除');
  },

  doImport(el) {
    const f = el.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = e => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), {type:'array'});
        const found = parseWorkbook(wb);
        if (!found.length) { this.toast('没找到值班表结构，请确认文件里有「星期X」和「N班」'); return; }
        this._imp = found;
        let h = '<div class="sec-t">这份文件里有 '+found.length+' 个可用的排班表，请选择</div>';
        found.forEach((p,i)=>{
          const total = p.blocks.reduce((s,b)=>s+Object.values(b.grid).reduce((a,r)=>a+Object.keys(r).length,0),0);
          h += `<div class="opt" data-act="doImport" data-i="${i}">
            <div class="nm">${esc(p.sheet)}
              <em>${p.classes.length}个班 · ${p.blocks.length}段 · ${total}条排班</em></div>
          </div>
          <div style="padding:0 16px 10px 58px;font-size:11.5px;color:var(--txt3)">
            ${p.blocks.map(b=>esc(b.label)+'('+Object.keys(b.grid).length+'天)').join('　')}
            ${p.extras.length?`　· 右侧发现 ${p.extras.length} 条额外登记`:''}
            ${p.note?`<br>表头备注：${esc(p.note)}`:''}
          </div>`;
        });
        this.openSheet('选择要导入的排班表', h, `<button class="btn btn-s" onclick="App.closeSheet()">取消</button>`);
      } catch(err) {
        console.error(err);
        this.toast('文件读不出来，请确认是 .xlsx 格式');
      }
    };
    rd.readAsArrayBuffer(f);
    el.value = '';
  },

  confirmImport(i) {
    const p = this._imp[i];
    const tpls = templatesFromParse(p);
    Object.assign(DATA.templates, tpls);
    DATA.meta.classes = p.classes;
    // 第一个模板设为默认；若只有一段且 mode=all 直接用
    const ids = Object.keys(tpls);
    // 优先选通用模板，否则第一个
    DATA.meta.defaultTemplate = ids.find(id=>DATA.templates[id].mode==='all') || ids[0];

    // 补齐老师名单
    const names = new Set(DATA.teachers);
    Object.values(tpls).forEach(t=>Object.values(t.grid).forEach(r=>Object.values(r).forEach(v=>{
      if (v && v!=='宿管') names.add(v);
    })));
    DATA.teachers = [...names];

    this.saveAndSync(); this.closeSheet(); this.buildSettings();
    this.toast(`已导入 ${p.sheet}，共 ${ids.length} 段排班`);
  },

  backup() { exportBackup(); this.toast('已导出备份文件'); },

  doRestore(el) {
    const f = el.files[0];
    if (!f) return;
    if (!confirm('恢复备份会覆盖当前所有数据，确定吗？')) { el.value=''; return; }
    importBackup(f).then(()=>{ this.toast('已恢复'); this.tab('cal'); })
      .catch(()=>this.toast('备份文件格式不对'));
    el.value = '';
  },

  reset() {
    if (!confirm('确定重置？所有改动、额外登记、放假标记都会清空，且无法撤销')) return;
    resetAll(); this.tab('cal'); this.toast('已重置');
  },

  /* ---------- 弹层 ---------- */
  openSheet(title, bodyHtml, footerHtml) {
    document.getElementById('sh-t').textContent = title;
    document.getElementById('sh-b').innerHTML = bodyHtml;
    document.getElementById('sh-f').innerHTML = footerHtml || '<button class="btn btn-s" onclick="App.closeSheet()">关闭</button>';
    document.getElementById('mask').classList.add('on');
    document.getElementById('sh-b').scrollTop = 0;
    this.bindSheetKeyboard();
  },

  /**
   * 键盘避让。
   *
   * 之前的问题：在手机上点「搜索老师姓名」，键盘一弹起来就把弹层下半截盖住了，
   * 而**选人列表正好在最下面** —— 名单被遮得只剩一两行，看不清都有谁。
   *
   * 做法：盯 visualViewport（它报的才是键盘上方的真实可视高度），
   * 键盘占多高就把 sheet 的 maxHeight 压到多少，并让它贴着键盘上沿。
   * 这样名单区还剩多少空间，就有多少可用，可以正常滚动。
   */
  bindSheetKeyboard() {
    if (this._kbBound) return;
    const vv = window.visualViewport;
    if (!vv) return;                       /* 老浏览器没这个 API，跳过即可 */
    this._kbBound = true;

    const apply = () => {
      const sh = document.querySelector('.sheet');
      if (!sh) return;
      const open = document.getElementById('mask').classList.contains('on');
      if (!open) { sh.style.maxHeight = ''; sh.style.transform = ''; sh.classList.remove('kb'); return; }
      /* 键盘盖住的高度 = 布局视口高度 - 实际可视高度 */
      const covered = Math.max(0, (window.innerHeight || 0) - vv.height - vv.offsetTop);
      if (covered > 60) {
        /* ⚠️ 光压高度不够 —— 手机上键盘弹出时，页面视口本身会上移，
           但我们这个 .mask 是 position:fixed inset:0，**不会跟着上移**，
           弹层底边还停在屏幕最下面，正好被键盘压住。
           所以还要用 transform 把它整体顶到键盘上沿。 */
        const usable = Math.max(vv.height - vv.offsetTop, 200);
        sh.classList.add('kb');
        sh.style.maxHeight = Math.max(usable - 16, 180) + 'px';
        sh.style.transform = `translateY(-${Math.max(covered, 0)}px)`;
      } else {
        sh.classList.remove('kb');
        sh.style.maxHeight = '';
        sh.style.transform = '';
      }
    };
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    /* 键盘收起/弹出有动画，收尾再算一次把高度修正回来 */
    let t;
    vv.addEventListener('resize', () => {
      clearTimeout(t);
      t = setTimeout(apply, 260);
    });

    /* 点搜索框时，确保它自己还在可视区内。
       否则键盘弹起那一瞬间，搜索框可能被顶到屏幕外，看不见自己敲了什么。 */
    document.addEventListener('focusin', e => {
      if (!e.target || !/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      if (!document.getElementById('mask').classList.contains('on')) return;
      setTimeout(() => {
        apply();
        try { e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
        catch (err) { /* 老浏览器不支持 scrollIntoView 参数，忽略 */ }
      }, 280);
    });

    /* 键盘弹起后，把选人列表滚进视野。
       头部（栏目名 / 日期 / 段别 / 搜索框）在键盘上方就占掉一大截，
       不主动滚一下的话，姓名列表全在折叠区以下 —— 正是"看不见姓名"的原因。 */
    document.addEventListener('focusin', e => {
      if (!e.target || e.target.id !== 'kw') return;
      setTimeout(() => {
        const box = document.getElementById('optlist');
        if (!box) return;
        const b = document.getElementById('sh-b');
        /* 让列表的第一条刚好露在底部按钮上方 */
        const top = box.getBoundingClientRect().top - b.getBoundingClientRect().top + b.scrollTop;
        b.scrollTo({ top: Math.max(top - 8, 0), behavior: 'smooth' });
      }, 320);
    });
  },
  /* 关闭弹层：清掉选人上下文，避免下次误把选人弹层弹回来 */
  closeSheet() {
    document.getElementById('mask').classList.remove('on');
    /* 键盘避让留下的 inline 高度必须清掉，否则下次开别的弹层会顶着这个高度 */
    const sh = document.querySelector('.sheet');
    if (sh) { sh.style.maxHeight = ''; sh.style.transform = ''; sh.classList.remove('kb'); }
    this._pickCtx = null; this._segCtx = null; this._shareDs = null;
    this._pickClsList = '';
  }
};

/* 选老师时需要记住班级号 —— 已改为在 pickTeacher 内用 this._pickCtx，无需包装 */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, m =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

// 调试 / 自动化入口
window.App = App;

document.addEventListener('DOMContentLoaded', () => {
  App.init();
  App._bindDelegate();
  App._bindImport();
  App._bindTabs();
  App._bindPost();
});