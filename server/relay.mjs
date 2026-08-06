#!/usr/bin/env node
/**
 * MindPocket 提醒代发器（GitHub Actions 侧「哑投递器」）
 * =========================================================================
 * 为什么需要它：ntfy.sh 免费服务只接受约 3 天内的定时消息（超出返回 400/40006），
 * 更远的提醒浏览器发不出去。本脚本定时把「即将进入投递窗口」的提醒补投给 ntfy。
 *
 * 投递通道：ntfy —— 清单带 server + topic，本脚本 POST 消息（沿用 ntfy 的 Delay 头精确定时）。
 *
 * 设计原则：
 *  1. 浏览器是唯一真相源。日期 / 周期 / 时区全部由浏览器算好，清单里的 ts 是
 *     Unix 秒，本脚本绝不做任何日期推算 —— 从根本上杜绝前后端规则漂移与时区错位。
 *  2. 尽晚投递。ntfy 只处理 now+60s ~ now+18h，窗口须宽于 cron 间隔以保证每个
 *     提醒至少被命中一次。
 *  3. 自适应窗口。遇 ntfy 40006（还太远）就跳过，下轮再试，不依赖硬编码 ntfy 上限。
 *  4. 不用 git。全部走 Contents API + sha 乐观锁，不存在 non-fast-forward 冲突。
 *  5. 凭据不下发到浏览器：ntfy 私有令牌只存在于仓库 Secret，清单里永不存放令牌。
 *
 * 环境变量：
 *   GITHUB_TOKEN        必填，Actions 自动注入（permissions: contents: write）
 *   GITHUB_REPOSITORY   必填，形如 owner/repo，Actions 自动注入
 *   NTFY_TOKEN          可选，私有 ntfy 的访问令牌（走 repo secret，绝不存进清单）
 *   DRY_RUN             可选，'1' 时只打印不实际投递 / 不写回仓库
 *   NOW_MS              可选，覆盖当前时刻（仅供测试）
 */

const API = (process.env.GITHUB_API_ROOT || 'https://api.github.com').replace(/\/+$/, '');
const DIR = 'schedules';

// 安全：只允许投递到白名单主机。否则任何能写该仓库的人都可以让本 Action
// 带着 NTFY_TOKEN 去打任意地址（SSRF + 凭据外泄）。
const SERVER_ALLOWLIST = [
  'https://ntfy.sh',
  'https://ntfy.envs.net',
];

const LEAD_MIN_MS = 60 * 1000;            // 太近的不投（避免与浏览器抢投 / 已过期）
const LEAD_MAX_MS = 18 * 60 * 60 * 1000;  // 只投未来 18 小时内（cron 6h 的 3 倍余量）
const PRUNE_BEFORE_MS = 60 * 60 * 1000;   // sent 记录保留到过期后 1 小时再剪
const MAX_ITEMS = 2000;                   // 单份清单硬上限
const MAX_SENT = 5000;                    // sent 记录硬上限
const MANIFEST_TTL_MS = 45 * 24 * 3600 * 1000; // 清单兜底有效期（防废弃 vault 被永远投递）

const token = process.env.GITHUB_TOKEN;
const repoFull = process.env.GITHUB_REPOSITORY || '';
const ntfyToken = process.env.NTFY_TOKEN || '';
const dryRun = process.env.DRY_RUN === '1';
const NOW = Number(process.env.NOW_MS) || Date.now();

if (!token || !repoFull) {
  console.error('缺少 GITHUB_TOKEN 或 GITHUB_REPOSITORY');
  process.exit(1);
}
const [owner, repo] = repoFull.split('/');

/* ---------------------------------------------------------------- GitHub */

async function gh(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'mindpocket-relay',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

function contentsPath(file) {
  return `/repos/${owner}/${repo}/contents/${encodeURIComponent(file)}`;
}

async function readJson(file) {
  const res = await gh('GET', contentsPath(file));
  if (res.status === 404) return { data: null, sha: null };
  if (!res.ok) throw new Error(`读取 ${file} 失败: ${res.status} ${await res.text()}`);
  const meta = await res.json();
  const text = Buffer.from(meta.content || '', 'base64').toString('utf8');
  let data = null;
  try { data = JSON.parse(text); } catch (e) { console.warn(`  ⚠ ${file} 不是合法 JSON，忽略`); }
  return { data, sha: meta.sha };
}

// 乐观锁写入：409/422 说明 sha 过期（浏览器同时在写），重新取 sha 重试一次
async function writeJson(file, obj, sha, message) {
  if (dryRun) { console.log(`  [DRY] 将写入 ${file}`); return; }
  const put = (s) => gh('PUT', contentsPath(file), {
    message,
    content: Buffer.from(JSON.stringify(obj, null, 2), 'utf8').toString('base64'),
    branch: 'main',
    ...(s ? { sha: s } : {}),
  });
  let res = await put(sha);
  if (res.status === 409 || res.status === 422) {
    const fresh = await readJson(file);
    res = await put(fresh.sha);
  }
  if (!res.ok) throw new Error(`写入 ${file} 失败: ${res.status} ${await res.text()}`);
}

async function deleteFile(file, sha, message) {
  if (!sha) return;
  if (dryRun) { console.log(`  [DRY] 将删除 ${file}`); return; }
  const res = await gh('DELETE', contentsPath(file), { message, sha, branch: 'main' });
  if (!res.ok) console.warn(`  ⚠ 删除 ${file} 失败: ${res.status}`);
}

async function listSchedules() {
  const res = await gh('GET', `/repos/${owner}/${repo}/contents/${DIR}`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`列目录失败: ${res.status} ${await res.text()}`);
  const arr = await res.json();
  return arr
    .filter((f) => f.type === 'file' && f.name.endsWith('.json') && !f.name.endsWith('.sent.json'))
    .map((f) => f.name.replace(/\.json$/, ''));
}

/* ------------------------------------------------------------------ ntfy */

async function publish(server, topic, item) {
  const body = {
    topic,
    title: '⏰ ' + (item.title || '提醒'),
    message: (item.msg || '提醒时间到'),
    tags: ['alarm'],
    priority: 4,
    delay: String(Math.floor(item.ts / 1000)),
    ...(item.click ? { click: item.click } : {}),
  };
  let url = server + '/';
  if (ntfyToken) {
    const auth = Buffer.from('Bearer ' + ntfyToken, 'utf8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    url += '?auth=' + auth;
  }
  let res;
  try {
    res = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
    return { ok: false, reason: 'net', err: String(e && e.message ? e.message : e) };
  }
  if (res.ok) return { ok: true };
  const txt = await res.text();
  let code = 0;
  try { code = (JSON.parse(txt) || {}).code || 0; } catch (e) { /* 非 JSON 响应 */ }
  // 40006 = 延迟超出服务端上限：不算失败，等它进入窗口后下一轮再投
  if (code === 40006) return { ok: false, reason: 'window' };
  return { ok: false, reason: 'http', err: `${res.status} ${txt.slice(0, 160)}` };
}

/* ------------------------------------------------------------------ 主流程 */

async function processOne(id) {
  const file = `${DIR}/${id}.json`;
  const sentFile = `${DIR}/${id}.sent.json`;
  console.log(`\n▶ ${id}`);

  const { data: manifest, sha: manifestSha } = await readJson(file);
  if (!manifest || !Array.isArray(manifest.items)) {
    console.log('  清单为空或格式不符，跳过');
    return { sent: 0, skipped: 0, failed: 0 };
  }

  // 清单兜底有效期：浏览器长期不更新（用户弃用该 vault）则连同 sent 一起清理，
  // 否则一份废弃清单会被永远投递下去。
  const updated = Date.parse(manifest.updated || '') || 0;
  const expires = Date.parse(manifest.expires || '') || (updated ? updated + MANIFEST_TTL_MS : 0);
  if (expires && NOW > expires) {
    console.log(`  清单已过期（${manifest.expires || '未标注'}），清理`);
    await deleteFile(file, manifestSha, 'relay: 清理过期提醒清单');
    const s = await readJson(sentFile);
    await deleteFile(sentFile, s.sha, 'relay: 清理过期投递记录');
    return { sent: 0, skipped: 0, failed: 0 };
  }

  const server = String(manifest.server || '').replace(/\/+$/, '');
  if (!SERVER_ALLOWLIST.includes(server)) {
    console.warn(`  ⚠ 服务器 ${server || '(空)'} 不在白名单内，拒绝投递`);
    return { sent: 0, skipped: 0, failed: 0, rejected: true };
  }
  if (!manifest.topic) {
    console.warn('  ⚠ 缺少 topic，跳过');
    return { sent: 0, skipped: 0, failed: 0 };
  }

  // 严格顺序：读 → 去重判定 → 投递 → 合并 → 剪枝 → 写
  const { data: sentRaw, sha: sentSha } = await readJson(sentFile);
  const sent = (sentRaw && typeof sentRaw.sent === 'object' && sentRaw.sent) || {};

  const items = manifest.items.slice(0, MAX_ITEMS);
  const due = items.filter((it) => {
    if (!it || !it.mid || !Number.isFinite(it.ts)) return false;
    if (sent[it.mid]) return false;                      // 已投过
    if (it.ts <= NOW + LEAD_MIN_MS) return false;        // 太近 / 已过期
    if (it.ts > NOW + LEAD_MAX_MS) return false;         // 还太远，下轮再说
    return true;
  }).sort((a, b) => a.ts - b.ts);

  console.log(`  清单 ${items.length} 条 · 渠道 ntfy · 本轮到期 ${due.length} 条`);

  let ok = 0, skipped = 0, failed = 0, lastErr = '';
  for (const it of due) {
    const r = await publish(server, manifest.topic, { ...it, click: manifest.click });
    if (r.ok) {
      sent[it.mid] = it.ts;
      ok++;
      console.log(`  ✅ ${new Date(it.ts).toISOString()} ${it.title || ''}`);
    } else if (r.reason === 'window') {
      skipped++;   // ntfy 说还太远，保持未投状态，下轮重试
    } else {
      failed++; lastErr = r.err || '';
      console.warn(`  ❌ ${it.mid}: ${r.err}`);
    }
  }

  // 剪枝：只在「过期满 1 小时」后才丢弃记录。留这段间隙是为了避免
  // 记录刚被剪掉、而清单里同一条目还没过投递过滤线，导致同一提醒被复活重投。
  let pruned = 0;
  for (const [mid, ts] of Object.entries(sent)) {
    if (!Number.isFinite(ts) || ts < NOW - PRUNE_BEFORE_MS) { delete sent[mid]; pruned++; }
  }
  // 硬上限兜底：极端情况下按时间保留最近的 MAX_SENT 条
  const keys = Object.keys(sent);
  if (keys.length > MAX_SENT) {
    keys.sort((a, b) => sent[a] - sent[b]).slice(0, keys.length - MAX_SENT).forEach((k) => delete sent[k]);
  }

  const nextSent = {
    v: 1,
    last_run: new Date(NOW).toISOString(),  // 心跳：前端据此判断后端是否还活着
    last_sent: ok,
    last_error: failed ? lastErr.slice(0, 200) : '',
    sent,
  };
  await writeJson(sentFile, nextSent, sentSha, `relay: 投递 ${ok} 条提醒`);
  console.log(`  投递 ${ok} · 未到窗口 ${skipped} · 失败 ${failed} · 剪枝 ${pruned}`);
  return { sent: ok, skipped, failed };
}

async function main() {
  console.log(`MindPocket 提醒代发器 · ${new Date(NOW).toISOString()}${dryRun ? ' [DRY RUN]' : ''}`);
  const ids = await listSchedules();
  if (!ids.length) { console.log('没有找到任何提醒清单，退出'); return; }
  console.log(`发现 ${ids.length} 份清单: ${ids.join(', ')}`);

  let total = 0, totalFailed = 0;
  for (const id of ids) {
    try {
      const r = await processOne(id);
      total += r.sent; totalFailed += r.failed;
    } catch (e) {
      totalFailed++;
      console.error(`✗ ${id} 处理失败:`, e.message);
    }
  }
  console.log(`\n合计投递 ${total} 条，失败 ${totalFailed} 条`);
  // 单份清单失败不应让整个 workflow 变红（会掩盖真正的问题），仅在全部失败时退出非零
  if (totalFailed && !total) process.exit(1);
}

main().catch((e) => { console.error('致命错误:', e); process.exit(1); });
