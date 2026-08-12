/**
 * MindPocket 云同步代理（薄层）
 * ----------------------------------------------------------------------------
 * 数据库 = 你的 GitHub 仓库里的 data/mindpocket.json（符合「GitHub 仓库当数据库」的选择）
 * 本 Worker 只做一件事：把干净的 JSON 请求，转成 GitHub Contents API 的读写（处理 base64 / sha / 冲突合并）。
 * 持有 GitHub PAT（存为 Worker Secret，不暴露给浏览器 / 豆包）。
 *
 * 部署（Cloudflare 控制台 → Workers → 新建 → 粘贴本文件）：
 *   需设置的 Secret / 变量（Settings → Variables）：
 *     GH_TOKEN   细粒度 PAT，仅授予目标仓库的 Contents: read&write
 *     GH_OWNER   仓库所有者（用户名或组织名）
 *     GH_REPO    仓库名
 *     GH_PATH    数据文件路径，默认 data/mindpocket.json
 *     GH_BRANCH  分支，默认 main
 *     MP_TOKEN   应用令牌（自定义字符串），前端与豆包插件都靠它鉴权
 *
 * 如果你不想用 Cloudflare，也可以用任意 serverless（Vercel/Netlify/Fly…）跑同一份逻辑，数据库仍是 GitHub。
 */

const DEFAULT_PATH = 'data/mindpocket.json';
const DEFAULT_BRANCH = 'main';
const UA = 'mindpocket-sync';

/* ----------------------------- 工具 ----------------------------- */
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
  });
}
function noCors() {
  return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,OPTIONS', 'access-control-allow-headers': 'content-type,authorization,x-mp-token' } });
}

/* 读取仓库文件 → { tasks: [], sha }；文件不存在返回 { tasks: [], sha: null } */
async function ghRead(env) {
  const path = env.GH_PATH || DEFAULT_PATH;
  const branch = env.GH_BRANCH || DEFAULT_BRANCH;
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/${path}?ref=${branch}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': UA } });
  if (r.status === 404) return { tasks: [], sha: null };
  if (!r.ok) {
    const t = await r.text();
    throw new Error('GitHub 读取失败 ' + r.status + ': ' + t.slice(0, 200));
  }
  const j = await r.json();
  let tasks = [];
  try { tasks = JSON.parse(b64decode(j.content)).tasks || []; } catch (e) { tasks = []; }
  return { tasks, sha: j.sha };
}

/* 写入仓库文件（合并后整体提交） */
async function ghWrite(env, tasks, sha) {
  const path = env.GH_PATH || DEFAULT_PATH;
  const branch = env.GH_BRANCH || DEFAULT_BRANCH;
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/${path}`;
  const body = {
    message: 'mindpocket sync ' + new Date().toISOString(),
    content: b64encode(JSON.stringify({ tasks }, null, 0)),
    branch,
  };
  if (sha) body.sha = sha;
  const r = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error('GitHub 写入失败 ' + r.status + ': ' + t.slice(0, 200));
  }
  return r.json();
}

/* 按 _id 合并两个任务数组：b 覆盖 a（同 id 时取 b） */
function mergeTasks(a, b) {
  const map = new Map();
  for (const t of (a || [])) if (t && t._id) map.set(t._id, t);
  for (const t of (b || [])) if (t && t._id) map.set(t._id, t);
  return Array.from(map.values());
}

/* 构造一个符合 mindpocket 结构的任务对象（缺省字段与 index.html 的 addTask 对齐） */
function makeTask(input) {
  const id = 'task_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const base = {
    _id: id, title: (input && input.title) || '新任务', desc: '', category_id: null,
    parent_category: '', category: '', is_archived: false, execute_date: null, cycle: null,
    enable_remind: false, deadline_time: '', remind_option: 'none', add_to_calendar: false,
    date_mode: 'single', date_start: '', date_end: '',
    sub_tasks: [], progress_info: { enable: false, media_type: 'book', progress_value: '' },
    material_notes: '', cycle_history: [], expect_hint_date: null, create_at: Date.now(),
    plan_year: null, plan_month: null, plan_week: null, time_mode: null, week_offset: null,
    cycle_end_date: '', cycle_end_mode: '', cycle_end_count: 0,
    doneDates: [], doneOverdueDates: [],
    is_template: false, is_collection: false, material_link: '', isEmergency: false,
  };
  // 覆盖调用方提供的字段（仅接受白名单，避免脏数据）
  const allow = ['title', 'desc', 'category_id', 'parent_category', 'category', 'execute_date',
    'deadline_time', 'date_mode', 'date_start', 'date_end', 'sub_tasks', 'isEmergency', 'cycle', 'remind_option'];
  for (const k of allow) if (input && input[k] !== undefined) base[k] = input[k];
  return base;
}

/* 判断任务是否在近 N 天内完成（doneDates 最新一条在窗口内，或已归档） */
function isDoneRecently(t, days) {
  if (!t) return false;
  if (t.is_archived) return true;
  const ds = t.doneDates || [];
  if (!ds.length) return false;
  const latest = ds.reduce((a, b) => (b > a ? b : a));
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return latest >= cutoff;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return noCors();

    // 鉴权：Authorization: Bearer <MP_TOKEN> 或 x-mp-token 头
    if (env.MP_TOKEN) {
      const auth = request.headers.get('authorization') || '';
      const tok = request.headers.get('x-mp-token') || '';
      if (auth.replace(/^Bearer\s+/i, '') !== env.MP_TOKEN && tok !== env.MP_TOKEN) {
        return jsonResp({ error: 'unauthorized' }, 401);
      }
    }

    try {
      if (url.pathname === '/health') return jsonResp({ ok: true });

      if (url.pathname === '/tasks' && request.method === 'GET') {
        const { tasks } = await ghRead(env);
        const done = url.searchParams.get('done');
        const days = parseInt(url.searchParams.get('days') || '7', 10);
        let out = tasks;
        if (done === '1' || done === 'true') out = tasks.filter((t) => isDoneRecently(t, days));
        return jsonResp({ tasks: out, total: tasks.length });
      }

      if (url.pathname === '/tasks' && request.method === 'POST') {
        const input = await request.json().catch(() => ({}));
        if (!input || !input.title) return jsonResp({ error: 'title required' }, 400);
        const created = makeTask(input);
        const { tasks, sha } = await ghRead(env);
        const merged = mergeTasks(tasks, [created]);
        await ghWrite(env, merged, sha);
        return jsonResp({ task: created }, 201);
      }

      if (url.pathname === '/tasks' && request.method === 'PUT') {
        // 客户端已合并好的全量任务，服务端再做一次 id 合并以防并发覆盖
        const input = await request.json().catch(() => ({}));
        const incoming = Array.isArray(input) ? input : (input.tasks || []);
        const { tasks, sha } = await ghRead(env);
        const merged = mergeTasks(tasks, incoming);
        await ghWrite(env, merged, sha);
        return jsonResp({ tasks: merged, total: merged.length });
      }

      return jsonResp({ error: 'not found', hint: 'supported: GET/POST/PUT /tasks, /health' }, 404);
    } catch (e) {
      return jsonResp({ error: String(e && e.message || e) }, 500);
    }
  },
};
