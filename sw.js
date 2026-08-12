/* MindPocket —— Service Worker（v2：联网必最新 + 断网可用）
 * 相比 v1 的改动：
 *  1) 缓存版本升到 mindpocket-v2 —— 新版接管时自动清掉 v1 旧缓存，并触发页面自动刷新一次
 *  2) 同源请求（页面 + 所有静态资源，含 mindpocket-cloud-sync.js）统一改为「网络优先」：
 *       联网 → 永远拿服务器最新版，并顺手更新缓存
 *       断网/超时 → 回退最近一次缓存，离线仍可打开
 *     这样以后任何文件更新，移动端联网打开就会自动变最新，无需手动清缓存
 *  3) 跨域请求（api.github.com / ntfy.sh 等）继续直接放行、不进缓存
 */
const CACHE = 'mindpocket-v2';
const NET_TIMEOUT = 3500; // 网络优先的超时（ms），超时则回退缓存，避免弱网久等
const ASSETS = [
  './',
  './index.html',
  './mindpocket-cloud-sync.js',
  './manifest.webmanifest',
  './assets/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()) // 个别资源缺失也不阻断安装
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 网络优先：先请求网络（带超时），成功则更新缓存并返回；失败/超时则回退缓存
function networkFirst(req, fallbackToShell) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      caches.match(req)
        .then((c) => resolve(c || (fallbackToShell ? caches.match('./index.html').then((r) => r || caches.match('./')) : undefined)))
        .then((r) => resolve(r || Response.error()));
    }, NET_TIMEOUT);

    fetch(req)
      .then((res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // 只缓存正常的、可缓存的同源响应
        try {
          if (res && res.status === 200 && (res.type === 'basic' || res.type === 'default')) {
            const cp = res.clone();
            caches.open(CACHE).then((c) => c.put(req, cp)).catch(() => {});
          }
        } catch (e) { /* ignore */ }
        resolve(res);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        caches.match(req)
          .then((c) => c || (fallbackToShell ? caches.match('./index.html').then((r) => r || caches.match('./')) : undefined))
          .then((r) => resolve(r || Response.error()));
      });
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // POST（ntfy 推送等）一律透传

  // 只对本站同源请求做缓存策略。跨域请求（api.github.com / ntfy.sh 等）直接放行、不进缓存，
  // 否则会把后端投递记录 sent.json 等永久留存，导致读到陈旧版本而重复投递。
  if (req.url.startsWith(self.location.origin)) {
    const isNavigate = req.mode === 'navigate';
    event.respondWith(networkFirst(req, isNavigate));
  }
  // 跨域 GET：不调用 respondWith，交给浏览器默认网络栈（尊重 cache:'no-store'）
});
