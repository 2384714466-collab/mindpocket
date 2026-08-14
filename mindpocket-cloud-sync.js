/* =============================================================================
 * MindPocket 云同步适配器（前端 · GitHub 直连版）
 * -----------------------------------------------------------------------------
 * 目标：手机与电脑看到同一份数据。数据存放在你自己的 GitHub 仓库里。
 *
 * 用户只需填一样东西：GitHub PAT（细粒度、仅本仓库 Contents 读写）。
 * 仓库坐标已写死在下方 FIXED，无需填写。
 *
 * 同步范围：state 下全部用户数据集合
 *   - 顶层集合：habits/tasks/categories/settings/projects/...
 *   - 财务 Tab：state.finance.*（expenseModules / incomeModules / expenseEntries /
 *               incomeEntries / depositModules / depositEntries / fieldTemplates）
 *   - 职业 Tab：state.career.*（categories / entries / jds / resumes）
 *   说明：career.tags 是字符串数组（无 _id），且 UI 已改为从 entries 实时派生，
 *         故不同步，避免重复/无 _id 合并异常。
 *
 * 合并规则（解决「删除后又出现」）：
 *   push：本地为主，只补充「云端独有」项。本地删过的（墓碑）不补 → 云端真正删除。
 *   pull：云端为主，只补充「本地独有」项（未推送的新建）。云端删除的不复活。
 *   云端整体为空（首次）→ 不拉取，反而把本地推上去初始化，避免清空本地数据。
 *
 * 健壮性：
 *   - 写冲突（多设备同时改）自动重取 sha 重试，最多 3 次。
 *   - 推送失败进入退避重试（3s→10s→30s→60s），不会卡死同步。
 *   - dirty 锁最多阻塞拉取 60s，超时强制放行（墓碑保证删除不会被拉回）。
 *   - 所有失败都翻译成人话，显示在设置面板的「状态」区，不再只打控制台。
 *   - 面板内置「检测连接」：一键判断 PAT 是否有效/过期、仓库是否可写。
 *
 * 用法：随 index.html 一起部署，并在 </body> 前加
 *       <script src="./mindpocket-cloud-sync.js"></script>
 * ========================================================================== */
(function () {
  'use strict';
  var CFG_KEY = 'mp_cloud_cfg';
  var DELETED_KEY = 'mp_cloud_deleted';
  var PUSH_DEBOUNCE = 1500;
  var PULL_DEFAULT = 15;
  var DIRTY_MAX_BLOCK = 60000;   // dirty 最多阻塞拉取 60s
  var TOMBSTONE_MAX = 500;       // 墓碑上限，防无限增长

  /* ===== 固定配置（已写死，用户无需填写）===================================
   * 换仓库只改这 4 行。
   * ====================================================================== */
  var FIXED = {
    owner:  '2384714466-collab',
    repo:   'mindpocket-vaults',
    branch: 'main',
    path:   'data/mindpocket.json'
  };

  /* ===== 需要同步的集合（排除运行时计数器 revision）=====================
   * 每个集合用路径描述（p 为 state 下的访问路径），以支持嵌套的
   * finance.* / career.* 等子集合——它们与顶层集合一样走「按 _id 逐项合并」
   * 逻辑，避免整对象覆盖导致的并发编辑互相覆盖。
   * ====================================================================== */
  var SYNCS = [
    // —— 顶层集合 ——
    { p: ['habits'] },
    { p: ['tasks'] },
    { p: ['categories'] },
    { p: ['settings'] },                 // 对象，整值写入
    { p: ['projects'] },
    { p: ['project_subs'] },
    { p: ['project_records'] },
    { p: ['project_ideas'] },
    { p: ['project_folders'] },
    { p: ['sub_custom_statuses'] },
    { p: ['wish_items'] },
    { p: ['wish_records'] },
    // —— 财务 Tab（state.finance.*，均为带 _id 的集合）——
    { p: ['finance', 'expenseModules'] },
    { p: ['finance', 'incomeModules'] },
    { p: ['finance', 'expenseEntries'] },
    { p: ['finance', 'incomeEntries'] },
    { p: ['finance', 'depositModules'] },
    { p: ['finance', 'depositEntries'] },
    { p: ['finance', 'fieldTemplates'] },
    // —— 职业 Tab（state.career.*，均为带 _id 的集合）——
    { p: ['career', 'categories'] },
    { p: ['career', 'entries'] },
    { p: ['career', 'jds'] },
    { p: ['career', 'resumes'] }
    // 注：career.tags 为字符串数组（无 _id），且 UI 已改为从 entries 实时派生，故不同步
  ];

  /* 集合访问器：按路径读 / 写（兼容顶层与嵌套） */
  function collGet(s) {
    var o = window.MPStore && window.MPStore.state;
    for (var i = 0; o != null && i < s.p.length; i++) o = o[s.p[i]];
    return o;
  }
  function collSet(s, val) {
    var o = window.MPStore && window.MPStore.state;
    for (var i = 0; o != null && i < s.p.length - 1; i++) o = o[s.p[i]];
    if (o != null) o[s.p[s.p.length - 1]] = val;
  }
  function flatKey(s) { return s.p.join('.'); }

  /* ----------------------------- 配置读写 ----------------------------- */
  function loadCfg() {
    var c = {};
    try { c = JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch (e) { c = {}; }
    // 仓库坐标恒为固定值，忽略历史残留配置
    c.owner = FIXED.owner;
    c.repo = FIXED.repo;
    c.branch = FIXED.branch;
    c.path = FIXED.path;
    return c;
  }
  function saveCfg(c) { try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {} }
  function ready() {
    var c = loadCfg();
    if (!c.enabled || !c.token) return false;
    return !!(window.MPStore && window.MPStore.state);
  }

  /* ----------------------------- 状态（给 UI 看） ----------------------------- */
  var st = { lastSyncAt: 0, lastError: '', patExpire: '', busy: false };
  function human(ts) {
    if (!ts) return '还没同步过';
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 10) return '刚刚';
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  }
  // 把技术错误翻译成人话
  function explain(e) {
    var code = e && e.status;
    if (code === 401) return 'PAT 无效或已过期 → 请到 GitHub 重新生成一个，再回来粘贴';
    if (code === 403) return 'PAT 权限不足（需 Contents 读写）或被 GitHub 限流，稍后再试';
    if (code === 404) return '仓库 / 分支不存在，或这个 PAT 没被授权访问 ' + FIXED.owner + '/' + FIXED.repo;
    if (code === 409 || code === 422) return '和另一台设备同时修改冲突了，正在自动重试';
    if (code === 413) return '数据太大，超过 GitHub 单文件限制';
    if (code >= 500) return 'GitHub 服务器暂时故障，稍后自动重试';
    var m = (e && e.message) || '未知错误';
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return '连不上网络（离线或被网络拦截），联网后会自动补同步';
    return m;
  }

  /* ----------------------------- GitHub API ----------------------------- */
  function ghHeaders(token, method) {
    var h = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' };
    if (method === 'PUT') h['Content-Type'] = 'application/json';
    return h;
  }
  function contentsUrl(c, withRef) {
    var u = 'https://api.github.com/repos/' + c.owner + '/' + c.repo + '/contents/' + c.path;
    return withRef ? (u + '?ref=' + c.branch) : u;
  }
  function b64e(s) { return btoa(unescape(encodeURIComponent(s))); }
  function b64d(s) { return decodeURIComponent(escape(atob(String(s).replace(/\s/g, '')))); }
  function httpErr(status, msg) { var e = new Error(msg || ('HTTP ' + status)); e.status = status; return e; }
  // PAT 过期时间（GitHub 在响应头里给，取不到就忽略）
  function sniffPatExpire(r) {
    try {
      var v = r.headers && r.headers.get && r.headers.get('github-authentication-token-expiration');
      if (v) st.patExpire = String(v).slice(0, 10);
    } catch (e) {}
  }

  // 读取整个数据快照 {data, sha}；404 视为「文件还没建」（data=null）
  function getSnapshot() {
    var c = loadCfg();
    return fetch(contentsUrl(c, true), { headers: ghHeaders(c.token), cache: 'no-store' }).then(function (r) {
      sniffPatExpire(r);
      if (r.status === 404) return { data: null, sha: null, missing: true };
      if (!r.ok) throw httpErr(r.status);
      return r.json().then(function (j) {
        var data = {};
        try { data = JSON.parse(b64d(j.content)); } catch (e) { data = {}; }
        return { data: data, sha: j.sha };
      });
    });
  }
  function putSnapshot(snap, sha) {
    var c = loadCfg();
    var body = {
      message: 'mindpocket sync ' + new Date().toISOString(),
      content: b64e(JSON.stringify(snap)),
      branch: c.branch
    };
    if (sha) body.sha = sha;
    return fetch(contentsUrl(c, false), { method: 'PUT', headers: ghHeaders(c.token, 'PUT'), body: JSON.stringify(body) })
      .then(function (r) {
        sniffPatExpire(r);
        if (!r.ok) throw httpErr(r.status);
        return r.json();
      });
  }

  /* ----------------------------- 删除追踪（墓碑） -----------------------------
   * 数组模型无法区分「本地删了」与「本地从未有」，故用 deletedIds 记录被删的 _id。
   * 标记后：push 时云端对应项一并删除、pull 时不再拉回。
   * --------------------------------------------------------------------- */
  function loadDeleted() { try { return JSON.parse(localStorage.getItem(DELETED_KEY)) || {}; } catch (e) { return {}; } }
  function persistDeleted() {
    try {
      var keys = Object.keys(deletedIds);
      if (keys.length > TOMBSTONE_MAX) {                       // 裁剪最旧的
        var keep = keys.slice(keys.length - TOMBSTONE_MAX), nd = {};
        keep.forEach(function (k) { nd[k] = 1; });
        deletedIds = nd;
      }
      localStorage.setItem(DELETED_KEY, JSON.stringify(deletedIds));
    } catch (e) {}
  }
  // 所有同步集合当前 _id 快照（按 flatKey 分组），用于检测「项被删除」
  function snapshotIds() {
    var ids = {};
    SYNCS.forEach(function (s) {
      var fk = flatKey(s), arr = collGet(s);
      if (Array.isArray(arr)) arr.forEach(function (t) { if (t && t._id) { (ids[fk] = ids[fk] || {})[t._id] = 1; } });
    });
    return ids;
  }
  var deletedIds = loadDeleted();
  var prevIds = null;
  function onChange() {
    var cur = snapshotIds();
    if (prevIds) {
      SYNCS.forEach(function (s) {
        var fk = flatKey(s), pk = prevIds[fk] || {}, ck = cur[fk] || {};
        Object.keys(pk).forEach(function (id) { if (!ck[id]) deletedIds[id] = 1; });   // 消失 = 被删除
      });
      persistDeleted();
    }
    prevIds = cur;
    markDirty();
    schedulePush();
  }

  // 云端所有数组集合都为空 → 视为未初始化（不要据此清空本地）
  function isSnapshotEmpty(snap) {
    if (!snap) return true;
    var arrCols = SYNCS.filter(function (s) { return Array.isArray(snap[flatKey(s)]); });
    if (!arrCols.length) return true;
    return arrCols.every(function (s) { var a = snap[flatKey(s)]; return !a || a.length === 0; });
  }

  /* ----------------------------- 推送 / 拉取 ----------------------------- */
  var pushTimer = null, retryTimer = null, retryStep = 0;
  var pushing = false, dirty = false, dirtyAt = 0;
  var RETRY_MS = [3000, 10000, 30000, 60000];

  function markDirty() { dirty = true; if (!dirtyAt) dirtyAt = Date.now(); }
  function clearDirty() { dirty = false; dirtyAt = 0; retryStep = 0; if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } }
  // 本地有未推送变更时暂停拉取；但最多阻塞 60s，超时放行（墓碑保证删除不会被拉回）
  function pullBlocked() { return dirty && (Date.now() - dirtyAt) < DIRTY_MAX_BLOCK; }

  function scheduleRetry() {
    if (retryTimer) return;
    var wait = RETRY_MS[Math.min(retryStep, RETRY_MS.length - 1)];
    retryStep++;
    retryTimer = setTimeout(function () { retryTimer = null; pushLocal(); }, wait);
  }

  // 用「本地为主 + 补充云端独有（排除墓碑）」构造要写入的快照
  function buildSnapshot(remote) {
    var snap = {};
    SYNCS.forEach(function (s) {
      var fk = flatKey(s), local = collGet(s);
      if (!Array.isArray(local)) { snap[fk] = local; return; }   // settings 等对象整值写入
      var ids = {}; local.forEach(function (t) { if (t && t._id) ids[t._id] = 1; });
      var out = local.slice();
      ((remote.data && remote.data[fk]) ? remote.data[fk] : []).forEach(function (t) {
        if (!t || !t._id) { out.push(t); return; }   // 云端无 _id 项（极少见）→ 保留
        if (ids[t._id]) return;                        // 本地已有 → 以本地为准
        if (deletedIds[t._id]) return;                // 本地删过的 → 云端也删除
        out.push(t);                                  // 云端独有（别的设备新增）→ 保留
      });
      snap[fk] = out;
    });
    var ded = {};
    ((remote.data && remote.data.__deleted) || []).forEach(function (id) { ded[id] = 1; });
    Object.keys(deletedIds).forEach(function (id) { ded[id] = 1; });
    var list = Object.keys(ded);
    snap.__deleted = list.length > TOMBSTONE_MAX ? list.slice(list.length - TOMBSTONE_MAX) : list;
    return snap;
  }

  // 冲突（409/422）自动重取 sha 重试
  function attemptPush(n) {
    return getSnapshot()
      .then(function (remote) { return putSnapshot(buildSnapshot(remote), remote.sha); })
      .catch(function (e) {
        if ((e.status === 409 || e.status === 422) && n < 3) {
          return new Promise(function (res) { setTimeout(res, 400 + n * 400); }).then(function () { return attemptPush(n + 1); });
        }
        throw e;
      });
  }

  function pushLocal() {
    if (!ready() || pushing) return Promise.resolve();
    pushing = true; st.busy = true; renderStatus();
    return attemptPush(0).then(function () {
      clearDirty();
      st.lastSyncAt = Date.now(); st.lastError = '';
      setBadge('ok');
    }).catch(function (e) {
      st.lastError = explain(e);
      setBadge('err');
      scheduleRetry();                 // 保持 dirty，退避重试，不卡死
      console.warn('[MP云同步] 推送失败:', e.status || '', e.message);
    }).then(function () {
      pushing = false; st.busy = false; renderStatus();
    });
  }

  // 把合并结果写回 state（数组原地修改以保留 Vue 响应式引用；对象直接赋值）
  function applyToState(s, merged) {
    var cur = collGet(s);
    if (Array.isArray(cur)) {
      cur.length = 0;
      Array.prototype.push.apply(cur, [].concat(merged || []));
    } else {
      collSet(s, merged);
    }
  }

  function pullRemote() {
    if (!ready() || pushing || pullBlocked()) return Promise.resolve();
    st.busy = true; renderStatus();
    return getSnapshot().then(function (remote) {
      // 云端全空/文件不存在 → 把本地推上去做初始化，绝不反向清空本地
      if (isSnapshotEmpty(remote.data)) { st.busy = false; return pushLocal(); }
      SYNCS.forEach(function (s) {
        var fk = flatKey(s);
        var remoteArr = remote.data[fk], local = collGet(s);
        if (!Array.isArray(local)) { if (remoteArr !== undefined) applyToState(s, remoteArr); return; }
        var ids = {}; (remoteArr || []).forEach(function (t) { if (t && t._id) ids[t._id] = 1; });
        var out = [];
        (remoteArr || []).forEach(function (t) {
          if (t && t._id && deletedIds[t._id]) return;   // 本地曾删 → 不拉回（防复活）
          out.push(t);
        });
        (local || []).forEach(function (t) {
          if (!t || !t._id) { out.push(t); return; }
          if (ids[t._id]) return;                 // 云端已有 → 以云端为准
          if (deletedIds[t._id]) return;          // 本地删过的 → 不拉回（防复活）
          out.push(t);                            // 本地独有（未推送新建）→ 保留
        });
        applyToState(s, out);
      });
      ((remote.data && remote.data.__deleted) || []).forEach(function (id) { deletedIds[id] = 1; });
      persistDeleted();
      prevIds = snapshotIds();                    // 拉取造成的变化不算「删除」
      if (window.MPStore.persist) window.MPStore.persist();
      st.lastSyncAt = Date.now(); st.lastError = '';
      setBadge('ok');
    }).catch(function (e) {
      st.lastError = explain(e);
      setBadge('err');
      console.warn('[MP云同步] 拉取失败:', e.status || '', e.message);
    }).then(function () { st.busy = false; renderStatus(); });
  }

  function schedulePush() {
    if (!ready()) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(pushLocal, PUSH_DEBOUNCE);
  }

  /* ----------------------------- 连接自检 ----------------------------- */
  function testConnection() {
    var c = loadCfg();
    if (!c.token) return Promise.resolve('✗ 还没填 PAT');
    var lines = [];
    return fetch('https://api.github.com/repos/' + c.owner + '/' + c.repo, { headers: ghHeaders(c.token), cache: 'no-store' })
      .then(function (r) {
        sniffPatExpire(r);
        if (r.status === 401) throw httpErr(401);
        if (r.status === 404) throw httpErr(404);
        if (!r.ok) throw httpErr(r.status);
        return r.json();
      })
      .then(function (repo) {
        lines.push('✓ 仓库可访问：' + c.owner + '/' + c.repo);
        if (repo && repo.permissions && repo.permissions.push === false) lines.push('✗ 这个 PAT 只有只读权限，需勾选 Contents: Read and write');
        else lines.push('✓ 有写入权限');
        if (st.patExpire) lines.push('· PAT 到期日：' + st.patExpire);
        return getSnapshot();
      })
      .then(function (snap) {
        lines.push(snap.missing ? '· 数据文件还没建，首次同步会自动创建' : '✓ 数据文件已存在');
        return lines.join('\n');
      })
      .catch(function (e) { return (lines.length ? lines.join('\n') + '\n' : '') + '✗ ' + explain(e); });
  }

  /* ----------------------------- 启动 ----------------------------- */
  var started = false, pollTimer = null;
  function start() {
    if (started || !window.MPStore) return;
    started = true;
    var c = loadCfg();
    prevIds = snapshotIds();   // 以当前数据为基准，避免把初始/预置项误判为删除
    try {
      if (window.Vue && Vue.watch) {
        Vue.watch(function () { return SYNCS.map(function (s) { return collGet(s); }); },
          function () { onChange(); }, { deep: true });
      } else {
        var o = window.MPStore.persist;
        window.MPStore.persist = function () { var r = o.apply(this, arguments); onChange(); return r; };
      }
    } catch (e) { console.warn('[MP云同步] watch 初始化失败', e); }

    buildUI();
    ensureButton();
    setInterval(ensureButton, 1000);

    if (c.enabled && c.token) {
      pullRemote();
      restartPoll(c.pollSec || PULL_DEFAULT);
      // 回到前台 / 重新联网时补一次同步（移动端切后台会冻结定时器）
      try {
        document.addEventListener('visibilitychange', function () { if (!document.hidden) pullRemote(); });
        window.addEventListener('online', function () { pullRemote(); if (dirty) pushLocal(); });
      } catch (e2) {}
    } else {
      setBadge('idle');
    }
  }
  function restartPoll(sec) {
    if (pollTimer) clearInterval(pollTimer);
    if (sec > 0) pollTimer = setInterval(pullRemote, Math.max(5, sec) * 1000);
  }

  /* ----------------------------- UI ----------------------------- */
  var btnEl = null;   // 持有引用，避免切 tab 被移出文档后找不到
  var statusEl = null;
  function setBadge(s) {
    if (!btnEl) return;
    btnEl.textContent = s === 'ok' ? '☁ 已同步' : (s === 'err' ? '☁ 同步异常' : '☁ 未开启');
    btnEl.style.background = s === 'err' ? '#ff6b6b' : (s === 'ok' ? '#2ecc71' : '#9aa4ae');
  }
  function renderStatus() {
    if (!statusEl) return;
    var c = loadCfg();
    var h = '';
    h += '<div class="mp-st-row">上次同步：<b>' + (st.busy ? '同步中…' : human(st.lastSyncAt)) + '</b></div>';
    if (st.lastError) h += '<div class="mp-st-row mp-bad">问题：' + st.lastError + '</div>';
    else if (c.enabled && c.token) h += '<div class="mp-st-row mp-good">状态：正常</div>';
    else h += '<div class="mp-st-row">状态：未开启（填入 PAT 后保存即可）</div>';
    if (st.patExpire) h += '<div class="mp-st-row">PAT 到期日：' + st.patExpire + '</div>';
    if (dirty) h += '<div class="mp-st-row">有本地改动待上传' + (retryStep ? '（重试中）' : '') + '</div>';
    statusEl.innerHTML = h;
  }
  // 找到「统计」页容器（<div class="page"> 内含 <h2 class="page-title">统计</h2>）
  function findStatsPage() {
    var hs = document.querySelectorAll('.page-title');
    for (var i = 0; i < hs.length; i++) {
      if ((hs[i].textContent || '').trim() === '统计') {
        var p = hs[i].closest ? hs[i].closest('.page') : hs[i].parentElement;
        return p || hs[i].parentElement;
      }
    }
    return null;
  }
  function buildUI() {
    if (document.getElementById('mp-sync-btn')) return;
    var css = '#mp-sync-btn{position:absolute;top:8px;right:10px;z-index:99999;background:#2ecc71;color:#fff;border:none;font-size:13px;line-height:1;padding:7px 11px;border-radius:9px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.18)}' +
      '#mp-sync-btn:hover{filter:brightness(1.05)}' +
      '#mp-sync-modal{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center}' +
      '#mp-sync-box{background:#fff;color:#222;width:340px;max-width:92vw;max-height:88vh;overflow:auto;border-radius:12px;padding:18px;font:14px/1.5 system-ui}' +
      '#mp-sync-box h3{margin:0 0 10px}#mp-sync-box label{display:block;margin:8px 0 2px;font-size:12px;color:#555}' +
      '#mp-sync-box input{width:100%;box-sizing:border-box;padding:7px;border:1px solid #ccc;border-radius:7px}' +
      '#mp-sync-box .row{display:flex;gap:8px;margin-top:12px}#mp-sync-box button{flex:1;padding:8px;border:none;border-radius:7px;cursor:pointer;font-size:13px}' +
      '#mp-sync-box .pri{background:#2ecc71;color:#fff}#mp-sync-box .sec{background:#eee;color:#333}' +
      '#mp-sync-box input.fixed{background:#f1f3f5;color:#777;cursor:default}' +
      '#mp-c-status{margin-top:14px;padding:10px;background:#f7f8fa;border-radius:8px;font-size:12px;color:#444}' +
      '#mp-c-status .mp-st-row{margin:2px 0}#mp-c-status .mp-bad{color:#d93025}#mp-c-status .mp-good{color:#188038}' +
      '#mp-c-test-out{margin-top:8px;padding:9px;background:#fff8e1;border-radius:8px;font-size:12px;white-space:pre-wrap;display:none;color:#5f4b00}';
    var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

    var btn = document.createElement('button');
    btn.id = 'mp-sync-btn'; btn.textContent = '☁ 云同步'; btn.title = 'MindPocket 云同步设置';
    btnEl = btn;

    var modal = document.createElement('div'); modal.id = 'mp-sync-modal';
    modal.innerHTML = '<div id="mp-sync-box">' +
      '<h3>☁ 云同步（手机 / 电脑共用一份数据）</h3>' +
      '<label><input type="checkbox" id="mp-c-en" style="width:auto"> 启用同步</label>' +
      '<label>仓库（已固定，无需修改）</label>' +
      '<input id="mp-c-repofull" class="fixed" readonly value="' + FIXED.owner + '/' + FIXED.repo + '">' +
      '<label>数据文件（已固定）</label>' +
      '<input id="mp-c-pathfull" class="fixed" readonly value="' + FIXED.branch + ' : ' + FIXED.path + '">' +
      '<label><b>GitHub PAT</b>（唯一要你填的；细粒度、仅本仓库 Contents 读写）</label>' +
      '<input id="mp-c-token" placeholder="github_pat_..." autocomplete="off">' +
      '<label>自动检查间隔（秒）</label><input id="mp-c-poll" type="number" value="15">' +
      '<div id="mp-c-status"></div>' +
      '<div id="mp-c-test-out"></div>' +
      '<div class="row"><button class="sec" id="mp-c-test">检测连接</button><button class="sec" id="mp-c-pull">立即拉取</button><button class="sec" id="mp-c-push">立即上传</button></div>' +
      '<div class="row"><button class="sec" id="mp-c-cancel">关闭</button><button class="pri" id="mp-c-save">保存</button></div>' +
      '</div>';
    document.body.appendChild(btn); document.body.appendChild(modal);

    var $ = function (id) { return modal.querySelector(id); };
    statusEl = $('#mp-c-status');
    var out = $('#mp-c-test-out');

    btn.onclick = function () {
      var c = loadCfg();
      $('#mp-c-en').checked = (c.enabled === undefined) ? true : !!c.enabled;   // 默认勾选
      $('#mp-c-token').value = c.token || '';
      $('#mp-c-poll').value = c.pollSec || PULL_DEFAULT;
      out.style.display = 'none';
      renderStatus();
      modal.style.display = 'flex';
    };
    $('#mp-c-cancel').onclick = function () { modal.style.display = 'none'; };
    $('#mp-c-pull').onclick = function () { clearDirty(); pullRemote(); };
    $('#mp-c-push').onclick = function () { markDirty(); pushLocal(); };
    $('#mp-c-test').onclick = function () {
      // 用当前输入框里的值先落盘，便于「填完立刻测」
      var c = loadCfg(); c.token = $('#mp-c-token').value.trim(); saveCfg(c);
      out.style.display = 'block'; out.textContent = '检测中…';
      testConnection().then(function (txt) { out.textContent = txt; renderStatus(); });
    };
    $('#mp-c-save').onclick = function () {
      var c = loadCfg();
      c.enabled = $('#mp-c-en').checked;
      c.token = $('#mp-c-token').value.trim();
      c.pollSec = parseInt($('#mp-c-poll').value, 10) || PULL_DEFAULT;
      saveCfg(c);
      modal.style.display = 'none';
      st.lastError = '';
      if (c.enabled && c.token) { setBadge('ok'); restartPoll(c.pollSec); pullRemote(); }
      else { setBadge('idle'); restartPoll(0); }
    };

    var c0 = loadCfg();
    setBadge(c0.enabled && c0.token ? 'ok' : 'idle');
  }
  // 挂到「统计」页右上角；不在统计 tab 时隐藏（兼容 tab 用 v-if 销毁/重建）
  function ensureButton() {
    var btn = btnEl;
    if (!btn) return;
    var page = findStatsPage();
    if (!page) {
      if (btn.parentNode && btn.parentNode !== document.body) btn.parentNode.removeChild(btn);
      btn.style.display = 'none';
      return;
    }
    btn.style.display = '';
    if (getComputedStyle(page).position === 'static') page.style.position = 'relative';
    if (btn.parentNode !== page) page.appendChild(btn);
  }

  /* ----------------------------- 对外接口（调试用） ----------------------------- */
  window.MPCloud = {
    pushNow: pushLocal,
    pullNow: pullRemote,
    test: testConnection,
    status: function () { return { cfg: loadCfg(), state: st, dirty: dirty, tombstones: Object.keys(deletedIds).length }; },
    configure: function (c) { saveCfg(Object.assign(loadCfg(), c)); }
  };

  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(start, 300);
  else window.addEventListener('DOMContentLoaded', function () { setTimeout(start, 300); });
  var iv = setInterval(function () { if (window.MPStore) { clearInterval(iv); start(); } }, 500);
})();
