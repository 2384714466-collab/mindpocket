/* =============================================================================
 * MindPocket 云同步适配器（前端）
 * -----------------------------------------------------------------------------
 * 两种后端模式（在 ☁ 设置面板里切换）：
 *   - worker ：经 Cloudflare Worker 代理（数据库仍是 GitHub 仓库）。浏览器只持 MP_TOKEN。
 *   - github ：前端直连 GitHub API（不依赖 Cloudflare）。浏览器持 GitHub PAT（细粒度、单仓库）。
 * 数据流：
 *   豆包建待办 → 落 GitHub → 本适配器轮询拉取 → 出现在页面
 *   你勾掉任务 → 本地变更被 Vue.watch 捕获 → 防抖推送 → 落 GitHub → 豆包可复盘
 *
 * 用法：随 index.html 一起部署，并在 </body> 前加 <script src="./mindpocket-cloud-sync.js"></script>
 * ========================================================================== */
(function () {
  'use strict';
  var CFG_KEY = 'mp_cloud_cfg';
  var PUSH_DEBOUNCE = 1500;
  var PULL_DEFAULT = 15;

  function loadCfg() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveCfg(c) { localStorage.setItem(CFG_KEY, JSON.stringify(c)); }
  function ready() {
    var c = loadCfg();
    if (!c.enabled || !window.MPStore || !window.MPStore.state) return false;
    return c.mode === 'github' ? !!(c.owner && c.repo && c.token) : !!(c.apiBase && c.token);
  }

  /* ----------------------------- GitHub 直连 ----------------------------- */
  function ghHeaders(token, method) {
    var h = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'mindpocket' };
    if (method === 'PUT') h['Content-Type'] = 'application/json';
    return h;
  }
  function ghUrl(c) {
    return 'https://api.github.com/repos/' + c.owner + '/' + c.repo + '/contents/' +
      (c.path || 'data/mindpocket.json') + '?ref=' + (c.branch || 'main');
  }
  function b64e(s) { return btoa(unescape(encodeURIComponent(s))); }
  function b64d(s) { return decodeURIComponent(escape(atob(s.replace(/\s/g, '')))); }

  function ghGetTasks(c) {
    return fetch(ghUrl(c), { headers: ghHeaders(c.token) }).then(function (r) {
      if (r.status === 404) return { tasks: [], sha: null };
      if (!r.ok) throw new Error('GitHub GET ' + r.status);
      return r.json().then(function (j) {
        var tasks = [];
        try { tasks = JSON.parse(b64d(j.content)).tasks || []; } catch (e) { tasks = []; }
        return { tasks: tasks, sha: j.sha };
      });
    });
  }
  function ghPutTasks(c, tasks, sha) {
    var body = { message: 'mindpocket sync ' + new Date().toISOString(), content: b64e(JSON.stringify({ tasks: tasks })), branch: c.branch || 'main' };
    if (sha) body.sha = sha;
    return fetch(ghUrl(c).split('?')[0], { method: 'PUT', headers: ghHeaders(c.token, 'PUT'), body: JSON.stringify(body) })
      .then(function (r) { if (!r.ok) throw new Error('GitHub PUT ' + r.status); return r.json(); });
  }

  /* ----------------------------- Worker 模式 ----------------------------- */
  function wApi(c, path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'content-type': 'application/json', 'x-mp-token': c.token }, opts.headers || {});
    return fetch((c.apiBase || '').replace(/\/+$/, '') + path, opts).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 120)); });
      return r.json();
    });
  }

  /* ----------------------------- 统一读写 ----------------------------- */
  function getTasks() {
    var c = loadCfg();
    if (c.mode === 'github') return ghGetTasks(c).then(function (x) { return x.tasks; });
    return wApi(c, '/tasks').then(function (j) { return j.tasks || []; });
  }
  function putTasks(tasks) {
    var c = loadCfg();
    if (c.mode === 'github') return ghGetTasks(c).then(function (x) { return ghPutTasks(c, tasks, x.sha); });
    return wApi(c, '/tasks', { method: 'PUT', body: JSON.stringify({ tasks: tasks }) });
  }

  function mergeTasks(a, b, preferB) {
    var map = {};
    (a || []).forEach(function (t) { if (t && t._id) map[t._id] = t; });
    (b || []).forEach(function (t) {
      if (!t || !t._id) return;
      if (map[t._id] && !preferB) return;
      map[t._id] = t;
    });
    return Object.keys(map).map(function (k) { return map[k]; });
  }

  /* ----------------------------- 推送 / 拉取 ----------------------------- */
  var lastPullAt = 0, pushTimer = null, pushing = false;

  function pushLocal() {
    if (!ready() || pushing) return Promise.resolve();
    pushing = true;
    return getTasks().then(function (remote) {
      var local = window.MPStore.state.tasks.map(function (t) { return JSON.parse(JSON.stringify(t)); });
      return putTasks(mergeTasks(remote, local, true));
    }).catch(function (e) { console.warn('[MP云同步] 推送失败:', e.message); })
      .then(function () { pushing = false; });
  }
  function pullRemote() {
    if (!ready()) return Promise.resolve();
    return getTasks().then(function (remote) {
      var local = window.MPStore.state.tasks;
      local.length = 0;
      Array.prototype.push.apply(local, mergeTasks(local, remote, true));
      lastPullAt = Date.now();
      setBadge('ok');
    }).catch(function (e) { console.warn('[MP云同步] 拉取失败:', e.message); setBadge('err'); });
  }
  function schedulePush() {
    if (!ready()) return;
    if (Date.now() - lastPullAt < 2000) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(pushLocal, PUSH_DEBOUNCE);
  }

  /* ----------------------------- 启动 ----------------------------- */
  var started = false;
  function start() {
    if (started || !window.MPStore) return;
    started = true;
    var c = loadCfg();
    try {
      if (window.Vue && Vue.watch) Vue.watch(function () { return window.MPStore.state.tasks; }, function () { schedulePush(); }, { deep: true });
      else { var o = window.MPStore.persist; window.MPStore.persist = function () { var r = o.apply(this, arguments); schedulePush(); return r; }; }
    } catch (e) { console.warn('[MP云同步] watch 初始化失败', e); }
    if (c.enabled) {
      pullRemote();
      if (c.pollSec && c.pollSec > 0) setInterval(pullRemote, Math.max(5, c.pollSec) * 1000);
    }
    buildUI();
  }

  /* ----------------------------- 浮层 UI ----------------------------- */
  function setBadge(s) {
    var b = document.getElementById('mp-sync-badge'); if (!b) return;
    b.textContent = s === 'ok' ? '☁ 已同步' : (s === 'err' ? '☁ 同步异常' : '☁');
    b.style.background = s === 'err' ? '#ff6b6b' : '#2ecc71';
  }
  function buildUI() {
    if (document.getElementById('mp-sync-root')) return;
    var css = '#mp-sync-fab{position:fixed;right:14px;bottom:14px;z-index:99999;width:42px;height:42px;border-radius:50%;background:#2ecc71;color:#fff;border:none;font-size:20px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)}' +
      '#mp-sync-badge{position:fixed;right:14px;bottom:62px;z-index:99999;background:#2ecc71;color:#fff;font-size:11px;padding:2px 8px;border-radius:10px;display:none;pointer-events:none}' +
      '#mp-sync-modal{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center}' +
      '#mp-sync-box{background:#fff;color:#222;width:330px;max-width:92vw;border-radius:12px;padding:18px;font:14px/1.5 system-ui}' +
      '#mp-sync-box h3{margin:0 0 10px}#mp-sync-box label{display:block;margin:8px 0 2px;font-size:12px;color:#555}' +
      '#mp-sync-box input,#mp-sync-box select{width:100%;box-sizing:border-box;padding:7px;border:1px solid #ccc;border-radius:7px}' +
      '#mp-sync-box .row{display:flex;gap:8px;margin-top:14px}#mp-sync-box button{flex:1;padding:8px;border:none;border-radius:7px;cursor:pointer}' +
      '#mp-sync-box .pri{background:#2ecc71;color:#fff}#mp-sync-box .sec{background:#eee;color:#333}.mp-hide{display:none}';
    var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

    var fab = document.createElement('button'); fab.id = 'mp-sync-fab'; fab.textContent = '☁'; fab.title = 'MindPocket 云同步设置';
    var badge = document.createElement('div'); badge.id = 'mp-sync-badge'; badge.textContent = '☁';
    var modal = document.createElement('div'); modal.id = 'mp-sync-modal';
    modal.innerHTML = '<div id="mp-sync-box">' +
      '<h3>☁ MindPocket 云同步</h3>' +
      '<label><input type="checkbox" id="mp-c-en"> 启用同步</label>' +
      '<label>模式</label><select id="mp-c-mode"><option value="github">直连 GitHub（无需 Cloudflare）</option><option value="worker">Cloudflare Worker 代理</option></select>' +
      '<div id="mp-github">' +
      '  <label>GitHub 用户名 / 组织</label><input id="mp-c-owner" placeholder="owner">' +
      '  <label>仓库名</label><input id="mp-c-repo" placeholder="repo">' +
      '  <label>分支</label><input id="mp-c-branch" value="main">' +
      '  <label>数据文件路径</label><input id="mp-c-path" value="data/mindpocket.json">' +
      '  <label>GitHub PAT（细粒度，仅本仓库 Contents:rw）</label><input id="mp-c-token" placeholder="ghp_... 或 github_pat_...">' +
      '</div>' +
      '<div id="mp-worker" class="mp-hide">' +
      '  <label>Worker 地址</label><input id="mp-c-base" placeholder="https://xxx.workers.dev">' +
      '  <label>MP_TOKEN</label><input id="mp-c-wtoken" placeholder="应用令牌">' +
      '</div>' +
      '<label>轮询间隔（秒）</label><input id="mp-c-poll" type="number" value="15">' +
      '<div class="row"><button class="sec" id="mp-c-pull">立即拉取</button><button class="sec" id="mp-c-push">立即推送</button></div>' +
      '<div class="row"><button class="sec" id="mp-c-cancel">取消</button><button class="pri" id="mp-c-save">保存</button></div>' +
      '</div>';
    document.body.appendChild(fab); document.body.appendChild(badge); document.body.appendChild(modal);
    var $ = function (id) { return modal.querySelector(id); };

    function syncModeUI(mode) {
      $('#mp-github').classList.toggle('mp-hide', mode !== 'github');
      $('#mp-worker').classList.toggle('mp-hide', mode !== 'worker');
    }
    $('#mp-c-mode').onchange = function () { syncModeUI(this.value); };

    fab.onclick = function () {
      var c = loadCfg();
      $('#mp-c-en').checked = !!c.enabled;
      $('#mp-c-mode').value = c.mode || 'github'; syncModeUI(c.mode || 'github');
      $('#mp-c-owner').value = c.owner || ''; $('#mp-c-repo').value = c.repo || '';
      $('#mp-c-branch').value = c.branch || 'main'; $('#mp-c-path').value = c.path || 'data/mindpocket.json';
      $('#mp-c-token').value = c.mode === 'github' ? (c.token || '') : '';
      $('#mp-c-base').value = c.apiBase || ''; $('#mp-c-wtoken').value = c.mode === 'worker' ? (c.token || '') : '';
      $('#mp-c-poll').value = c.pollSec || PULL_DEFAULT;
      modal.style.display = 'flex';
    };
    $('#mp-c-cancel').onclick = function () { modal.style.display = 'none'; };
    $('#mp-c-pull').onclick = function () { pullRemote(); };
    $('#mp-c-push').onclick = function () { pushLocal(); };
    $('#mp-c-save').onclick = function () {
      var mode = $('#mp-c-mode').value;
      var c = loadCfg();
      c.enabled = $('#mp-c-en').checked;
      c.mode = mode;
      c.owner = $('#mp-c-owner').value.trim();
      c.repo = $('#mp-c-repo').value.trim();
      c.branch = $('#mp-c-branch').value.trim() || 'main';
      c.path = $('#mp-c-path').value.trim() || 'data/mindpocket.json';
      c.apiBase = $('#mp-c-base').value.trim();
      c.token = mode === 'github' ? $('#mp-c-token').value.trim() : $('#mp-c-wtoken').value.trim();
      c.pollSec = parseInt($('#mp-c-poll').value, 10) || PULL_DEFAULT;
      saveCfg(c); modal.style.display = 'none';
      if (c.enabled) { badge.style.display = 'block'; pullRemote(); }
      else badge.style.display = 'none';
    };
    if (loadCfg().enabled) badge.style.display = 'block';
  }

  window.MPCloud = { pushNow: pushLocal, pullNow: pullRemote, configure: function (c) { saveCfg(Object.assign(loadCfg(), c)); }, status: function () { return loadCfg(); } };

  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(start, 300);
  else window.addEventListener('DOMContentLoaded', function () { setTimeout(start, 300); });
  var iv = setInterval(function () { if (window.MPStore) { clearInterval(iv); start(); } }, 500);
})();
