/* ============================================================
 * 宿管代班登记页（dorm.html）
 * 老师分享 ?k=<短码>，短码对应的排班快照存在云端 duty_links。
 * 链接短到微信不会截断，宿管打开就能看到几班要代、填自己的名字。
 * ============================================================ */
(function () {
  'use strict';

  var qs = new URLSearchParams(location.search);
  var CODE = (qs.get('k') || '').trim();
  var TOKEN = '', DATE = '', CLS = [], SEGS = [], TIMES = '', NAMES = '', ONE = false;
  var SEG_KEY = '', SEG_TXT = '';      // 第几段（从选人界面转发时才有）

  var app = document.getElementById('app');
  var toastEl = document.getElementById('toast');

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(window.__tt);
    window.__tt = setTimeout(function () { toastEl.classList.remove('on'); }, 2200);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }
  function parseYmd(s) {
    var p = String(s).split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }
  function isoDow(dt) { var n = dt.getDay(); return n === 0 ? 7 : n; }

  /* ---------------- 是不是在微信里打开 ---------------- */
  var IN_WX = /MicroMessenger/i.test(navigator.userAgent || '');

  /**
   * 宿管如果是在系统浏览器 / 桌面浏览器里打开的，页面照常能用，
   * 但顶部给一条提示：微信里打开可以直接发消息回来，省事。
   * 不阻断流程（万一有人就是想在外面填），只是提一句。
   */
  function wxHint() {
    if (IN_WX) return '';
    return '<div class="wx-tip">'
      + '在<b>微信里</b>打开这个链接，填完名字可以直接发回给老师，不用复制来复制去。'
      + '</div>';
  }

  /* ---------------- 骨架 ---------------- */
  function skeleton(msg) {
    return '<div class="hd"><h1>晚修代班登记</h1></div>'
      + '<div class="load">'
      + '<div class="spin"></div>'
      + '<div>' + esc(msg) + '</div></div>';
  }
  function fail(title, msg) {
    app.innerHTML = '<div class="hd"><h1>晚修代班登记</h1></div>'
      + '<div class="err"><b>' + esc(title) + '</b><br>' + esc(msg) + '</div>';
  }

  /* ---------------- 主流程 ---------------- */
  var picked = {}, dormName = '', customName = '', submitting = false, d0 = null, wd = '';

  async function boot() {
    /* 卡死兜底：8 秒还没渲染出内容，就换成"重试"入口。
       之前实测遇到过 cloud.database 在页面初始化时序下静默挂起，
       表现是永远转圈 —— 用户只会以为链接坏了。 */
    var watchdog = setTimeout(function () {
      if (app.getAttribute('data-booted')) return;
      app.innerHTML = '<div class="err"><b>还在加载…</b><br>'
        + '网络可能较慢，点下面重试一次。</div>'
        + '<div style="margin:0 14px"><button class="btn btn-p"'
        + ' onclick="location.reload()">重新加载</button></div>';
    }, 8000);

    app.innerHTML = skeleton('正在打开…');
    if (!CODE) {
      fail('链接不完整', '请让老师在应用里重新转发一次链接。');
      return;
    }
    var payload = null;
    try {
      /* 加超时保护：网络卡住时不要一直转圈，给一句人话 + 重试入口。
         （SDK 内部已有 8 秒加载超时，这里再兜一层网络请求） */
      payload = await Promise.race([
        window.CloudDuty.loadLink(CODE),
        new Promise(function (_, rej) {
          setTimeout(function () { rej(new Error('网络太慢，请重试')); }, 12000);
        })
      ]);
    } catch (e) {
      fail('打不开', (e && e.message ? e.message : '网络异常')
        + '。请检查网络，或让老师重新发一次链接。');
      return;
    }
    if (!payload || !payload.d) {
      fail('链接已失效', '这个登记链接找不到了，可能已被清空。请让老师重新转发一次。');
      return;
    }
    TOKEN = payload.t || '';
    DATE = payload.d;
    CLS = String(payload.c || '').split(',').filter(Boolean).map(Number);
    SEGS = String(payload.g || '').split('　').filter(Boolean);
    TIMES = SEGS.join('　');
    NAMES = payload.n || '';
    /* one=1 → 老师是从某个班的弹层转发的，宿管不用再选班，直接认领这一班 */
    ONE = !!payload.one && CLS.length >= 1;
  SEG_KEY = payload.sg || '';      // 从选人界面转发时带过来的段别
  /* 把 's1' 变成「一段」；也容错 payload 直接传中文 */
  SEG_TXT = SEG_KEY
    ? (/^[sS]\d+$/.test(SEG_KEY)
        ? ({ s1: '一段', s2: '二段', s3: '三段' })[SEG_KEY.toLowerCase()] || ''
        : SEG_KEY)
    : '';
    d0 = parseYmd(DATE);
    wd = ({ 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '日' })[isoDow(d0)] || '';

    if (!CLS.length) {
      fail('这一天没有晚修', '不用登记，辛苦你了。');
      return;
    }
    /* 上面这一段只是给 payload 字段赋值，理论上不会抛；
       真抛了也应该给出人话而不是白屏。 */
    /* 指定班级模式：先默认全勾上，宿管只要填名字就行 */
    if (ONE) CLS.forEach(function (c) { picked[c] = true; });
    app.setAttribute('data-booted', '1');
    clearTimeout(watchdog);
    render();
  }

  function render() {
    var h = '';
    h += '<div class="hd">';
    /* 标题行要一眼看清：几班、周几、第几段 —— 宿管最关心的三件事 */
    const segTail = SEG_TXT || '';
    h += '<h1>' + (ONE ? (CLS.join('、') + '班' + segTail + '晚修代班') : '晚修代班登记')
       + '</h1>';
    h += '<p><b class="hd-wd">' + (d0.getMonth() + 1) + '月' + d0.getDate()
         + '日 星期' + wd + '</b>'
         + (segTail ? '<span class="hd-seg">' + esc(segTail) + '</span>' : '')
         + (TIMES ? '<br>' + esc(TIMES) : '') + '</p>';
    h += '</div><div class="wrap">';
    /* 非微信环境才提示"在微信里打开更省事"（在微信里就不啰嗦了） */
    h += wxHint();

    /* 1. 选班级：单班模式不用选，直接把班号亮出来 */
    if (ONE) {
      h += '<div class="card"><div class="one-cls">'
         + '<div class="one-nm">' + CLS.join('、') + '班' + segTail + '</div>'
         + '<div class="one-sub">'
         + (segTail ? '这一段的' + esc(segTail) + '由你代晚修'
                    : (CLS.length > 1 ? '这几个班由你代晚修' : '这一班由你代晚修'))
         + '</div>'
         + '</div></div>';
    } else {
      h += '<div class="card"><div class="card-h">我能代这几个班' +
           '<span class="sub">已选 <b id="cnt">0</b> 个</span></div><div id="clsList">';
      CLS.forEach(function (c) {
        h += '<div class="cls" data-c="' + c + '">' +
             '<div class="box"></div>' +
             '<div class="nm">' + c + '班</div>' +
             '<div class="tm">晚修代班</div></div>';
      });
      h += '</div><div class="tip">点一下选中 / 取消。没排到的班可以不选。</div></div>';
    }

    /* 2. 填名字 */
    h += '<div class="card"><div class="card-h">我的名字' +
         '<span class="sub">登记后自动记入值班表</span></div><div id="dormList">';
    if (NAMES) {
      NAMES.split(',').filter(Boolean).forEach(function (nm) {
        /* 这里的头像保留 —— dorm.html 的 CSS 里 .dorm .av 有定义
           （32px 圆形），是有意设计，不是主页那种没样式的裸 div。 */
        var last2 = nm.length > 2 ? nm.slice(-2) : nm.slice(0, 1);
        h += '<div class="dorm" data-n="' + esc(nm) + '">' +
             '<div class="av">' + esc(last2) + '</div>' +
             '<div class="nm">' + esc(nm) + '</div>' +
             '<div class="ck">✓</div></div>';
      });
    }
    h += '</div><div class="card-b" style="padding-top:10px">' +
         '<input id="customIn" placeholder="名单里没有？输入你的名字" ' +
         'style="width:100%;padding:11px 12px;border:1px solid var(--line);' +
         'border-radius:9px;font-size:15px;font-family:inherit;background:var(--rowh)">' +
         '</div></div>';

    /* 3. 提交 */
    h += '<button class="btn" id="submitBtn" style="margin:0 12px 12px">提交登记</button>';

    /* 4. 说明 */
    h += '<div class="card"><div class="card-h">说明</div>' +
         '<div class="tip" style="padding-top:0">' +
         '· 提交后老师那边会看到你的名字，自动更新值班表' +
         (TIMES ? '<br>· 分段时间：' + esc(TIMES) : '') +
         '<br>· 名字填错了，重新选一次提交就行' +
         '<br>· 代班费用按学校标准另算' +
         '</div></div></div>';
    app.innerHTML = h;
    bind();
  }

  function renderDone() {
    var mine = Object.keys(picked).map(Number).sort(function (a, b) { return a - b; });
    var who = dormName || customName;
    var h = '';
    h += '<div class="hd"><h1>登记好了</h1><p>谢谢，已通知老师</p></div>';
    h += '<div class="wrap"><div class="card"><div class="done">';
    h += '<div class="ic">✓</div>';
    h += '<h2>' + esc(who) + '，已登记</h2>';
    h += '<p>' + (d0.getMonth() + 1) + '月' + d0.getDate() + '日 星期' + wd + ' 代晚修</p>';
    h += '<div class="sum-box">';
    mine.forEach(function (c) {
      h += '<div class="r"><span>' + c + '班</span><b>晚修代班</b></div>';
    });
    h += '</div><p style="margin-top:14px">可以把这个页面截图发给老师留底。</p>';
    h += '</div></div></div>';
    app.innerHTML = h;
  }

  /* ---------------- 交互 ---------------- */
  function bind() {
    var list = document.getElementById('clsList');
    if (list) list.addEventListener('click', function (e) {
      var row = e.target.closest('.cls[data-c]');
      if (!row) return;
      var c = Number(row.dataset.c);
      if (picked[c]) delete picked[c]; else picked[c] = true;
      row.classList.toggle('on', !!picked[c]);
      row.querySelector('.box').textContent = picked[c] ? '✓' : '';
      var cnt = document.getElementById('cnt');
      if (cnt) cnt.textContent = Object.keys(picked).length;
      updSubmit();
    });

    var dl = document.getElementById('dormList');
    if (dl) dl.addEventListener('click', function (e) {
      var row = e.target.closest('.dorm[data-n]');
      if (!row) return;
      dormName = row.dataset.n;
      customName = '';
      render();
    });

    var ci = document.getElementById('customIn');
    if (ci) ci.addEventListener('input', function () {
      var v = ci.value.trim();
      if (v === customName) return;
      customName = v;
      dormName = '';
      var dl2 = document.getElementById('dormList');
      if (dl2) dl2.querySelectorAll('.dorm').forEach(function (r) {
        r.classList.remove('on');
      });
      updSubmit();
    });

    document.getElementById('submitBtn').addEventListener('click', doSubmit);
    updSubmit();
  }

  function updSubmit() {
    var sb = document.getElementById('submitBtn');
    if (!sb) return;
    var who = dormName || customName;
    var n = Object.keys(picked).length;
    sb.disabled = submitting || !n || !who;
    /* 单班模式：班已经定了，只要填名字 */
    if (submitting) sb.textContent = '提交中…';
    else if (!who) sb.textContent = ONE ? '请填你的名字' : (!n ? '请先勾选班级' : '请先填你的名字');
    else if (!n) sb.textContent = '请先勾选班级';
    else sb.textContent = ONE ? `提交登记（代 ${CLS.join('、')} 班）` : `提交登记（${n} 个班）`;
  }

  async function doSubmit() {
    var who = dormName || customName;
    var mine = Object.keys(picked).map(Number);
    if (!mine.length || !who || submitting) return;
    submitting = true;
    updSubmit();
    try {
      await window.CloudDuty.submitShift({
        token: TOKEN, date: DATE, classes: mine, names: [who]
      });
      renderDone();
    } catch (e) {
      submitting = false;
      updSubmit();
      toast(e && e.message ? e.message : '提交失败，请稍后重试');
    }
  }

  boot();
})();