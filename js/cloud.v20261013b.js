/* ============================================================
 * 云服务客户端（宿管代班登记用）
 * 只负责：初始化 SDK + 提交/读取代班记录
 * ============================================================ */
(function () {
  'use strict';

  /* ⚠️【测试站专用改动】已移除真实凭据与真实服务地址。
     本测试站只验证「换域名后微信能否打开页面」，
     故此处填占位值，且下方所有云端出口已强制短路 —— 不可能连到生产环境。
     正式部署时请换回真实 publicConfig。 */
  var CFG = {
    resourceId:      'TEST_PLACEHOLDER',
    endpoint:         'https://example.invalid',
    oauthRelayBaseUrl:'https://example.invalid',
    publishableKey:   'TEST_PLACEHOLDER'
  };

  var _cloud = null;
  var _ready = null;

  /** 懒初始化：SDK 脚本可能还没加载完 */
  function ready() {
    if (_ready) return _ready;
    _ready = new Promise(function (resolve, reject) {
      function boot() {
        if (!window.WorkBuddyCloud) {
          reject(new Error('云服务组件加载失败，请检查网络后刷新'));
          return;
        }
        try {
          _cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
            endpoint: CFG.endpoint,
            oauthRelayBaseUrl: CFG.oauthRelayBaseUrl,
            publishableKey: CFG.publishableKey
          });
          resolve(_cloud);
        } catch (e) { reject(e); }
      }
      if (window.WorkBuddyCloud) { boot(); return; }
      /* SDK 是本地脚本（不走 CDN），正常情况下早就到了；
         万一没到，也别无限等——8秒后降级，主应用仍可离线用。 */
      var t0 = Date.now();
      var iv = setInterval(function () {
        if (window.WorkBuddyCloud) { clearInterval(iv); boot(); }
        else if (Date.now() - t0 > 8000) {
          clearInterval(iv);
          reject(new Error('云服务组件加载超时，请刷新重试'));
        }
      }, 120);
    });
    return _ready;
  }

  /* ---------------- 对外接口 ---------------- */

  /**
   * 提交代班登记
   * @param {{token:string,date:string,classes:number[],names:string[],note?:string}} p
   */
  async function submitShift(p) {
    var c = await ready();
    var row = {
      token: p.token,
      duty_date: p.date,
      classes: p.classes.join(','),
      detail: JSON.stringify({ names: p.names || [], note: p.note || '' })
    };
    var res = await c.database.from('duty_shifts').insert(row).select();
    if (res.error) throw new Error(res.error.message || '提交失败');
    if (!res.data || !res.data.length) throw new Error('提交没有生效，请重试');
    return res.data[0];
  }

  /**
   * 读取某一天的代班登记（老师端用）
   * @param {string} token
   * @param {string} date
   */
  async function loadShift(token, date) {
    var c = await ready();
    var q = c.database.from('duty_shifts').select('*').eq('token', token);
    if (date) q = q.eq('duty_date', date);
    var res = await q;
    if (res.error) throw new Error(res.error.message || '读取失败');
    return res.data || [];
  }

  /** 删除某条登记（传 id；不传则删该 token+日期的全部） */
  async function deleteShift(id, token, date) {
    var c = await ready();
    var q = c.database.from('duty_shifts').delete();
    if (id) q = q.eq('id', id);
    else q = q.eq('token', token).eq('duty_date', date);
    var res = await q.select();
    if (res.error) throw new Error(res.error.message || '删除失败');
    return (res.data || []).length;
  }

  /* ---------------- 短链接 ---------------- */

  /** 生成一个短码（去掉易混字符 0O1lI） */
  function shortCode(n) {
    var AB = 'abcdefghjkmnpqrstuvwxyz23456789';   // 去掉 i l o 0 1
    var s = '';
    for (var i = 0; i < (n || 10); i++) {
      s += AB[Math.floor(Math.random() * AB.length)];
    }
    return s;
  }

  /**
   * 把排班快照存到云端，换一个短码。
   * 链接里只带 code —— 微信不会把长链接截断。
   */
  async function saveLink(payload) {
    var c = await ready();
    var json = JSON.stringify(payload);
    /* 只走 **1 次** 网络往返：直接插，撞码（23505）才换码重试。
       原来为了"先查重再插"多发一次请求，手机网络慢时容易超时失败。 */
    var last = null;
    for (var i = 0; i < 4; i++) {
      var res = await c.database.from('duty_links')
        .insert({ code: shortCode(10), payload: json }).select();
      if (!res.error) return (res.data && res.data[0]) ? res.data[0].code : '';
      last = res.error;
      /* 只有撞码才换码重来；其它错误直接抛，别白白重试 */
      var code = res.error && (res.error.code === '23505' ||
                /duplicate|unique/i.test(res.error.message || ''));
      if (!code) break;
    }
    throw new Error((last && last.message) || '生成链接失败');
  }

  /** 按短码取回排班快照 */
  async function loadLink(code) {
    var c = await ready();
    var res = await c.database.from('duty_links')
      .select('payload').eq('code', code).maybeSingle();
    if (res.error) throw new Error(res.error.message || '链接读取失败');
    if (!res.data) return null;
    try { return JSON.parse(res.data.payload); }
    catch (e) { throw new Error('链接内容损坏'); }
  }

  /** 这个 token 有登记过哪些日期（自动写入用；同一 token 通常就一两天） */
  async function listDates(token) {
    var c = await ready();
    var res = await c.database.from('duty_shifts')
      .select('duty_date').eq('token', token);
    if (res.error) throw new Error(res.error.message || '读取失败');
    var seen = {};
    (res.data || []).forEach(function (r) {
      if (r && r.duty_date) seen[r.duty_date] = 1;
    });
    return Object.keys(seen).sort();
  }

  /* ---------- 排班表全量数据（多设备同步） ----------
     原来数据只存浏览器本地（localStorage），手机改的电脑看不到。
     现在把整份 DATA 存到云端，同一个 code（分享码）下的设备共用一份。 */

  /** 取云端数据；没有就返回 null */
  async function loadState(code) {
    var c = await ready();
    var res = await c.database.from('duty_state')
      .select('payload, updated_at').eq('code', code).maybeSingle();
    if (res.error) throw new Error(res.error.message || '读取失败');
    if (!res.data || !res.data.payload) return null;
    return { payload: res.data.payload, updatedAt: res.data.updated_at };
  }

  /** 覆盖写入云端数据 */
  async function saveState(code, json) {
    var c = await ready();
    var res = await c.database.from('duty_state')
      .upsert({ code: code, payload: json, updated_at: new Date().toISOString() })
      .select();
    if (res.error) throw new Error(res.error.message || '保存失败');
    return true;
  }

  /* ⚠️【测试站专用改动】硬切断云端：所有方法直接 reject，
     不发起任何网络请求，确保不可能碰到生产数据。 */
  function blocked() {
    return Promise.reject(new Error('测试站已禁用云同步（隔离生产数据）'));
  }

  window.CloudDuty = {
    ready: ready,
    loadState: loadState,
    saveState: saveState,
    submitShift: submitShift,
    loadShift: loadShift,
    listDates: listDates,
    deleteShift: deleteShift,
    saveLink: saveLink,
    loadLink: loadLink,
    shortCode: shortCode,
    /* 测试站：全部短路 */
    _disabled: true
  };

  /* 覆盖掉上面所有会联网的出口 */
  ['loadState','saveState','submitShift','loadShift','listDates',
   'deleteShift','saveLink','loadLink'].forEach(function (k) {
    window.CloudDuty[k] = blocked;
  });
})();
