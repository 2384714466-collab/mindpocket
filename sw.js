/* MindPocket —— Service Worker（P0：离线缓存 + 应用壳）
 * 单文件应用，缓存核心资源即可实现离线可用与「安装到主屏幕」。
 * 策略：
 *  - 安装即缓存应用壳（index.html / manifest / 图标）
 *  - 导航请求：网络优先，失败回退缓存（离线仍可打开）
 *  - 静态资源：缓存优先，缺失则网络拉取并补缓存
 */
const CACHE = 'mindpocket-v1';
const ASSETS = [
  './',
  './index.html',
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

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // POST（ntfy 推送等）一律透传

  // 只对本站同源请求做「缓存壳」策略。跨域请求（api.github.com / ntfy.sh 等）
  // 直接放行、不进 SW 缓存——否则后端投递记录 sent.json 会被 SW 缓存层永久留存，
  // 浏览器读到陈旧版本而重复投递。这一层缓存会无视 fetch 的 cache:'no-store'。
  if (req.url.startsWith(self.location.origin)) {
    if (req.mode === 'navigate') {
      event.respondWith(
        fetch(req)
          .then((res) => {
            const cp = res.clone();
            // 按真实请求 URL 缓存（含子路径根地址），确保离线导航精确命中
            caches.open(CACHE).then((c) => c.put(req, cp)).catch(() => {});
            return res;
          })
          .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')).then((r) => r || caches.match('./')))
      );
      return;
    }

    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req)
          .then((res) => {
            const cp = res.clone();
            caches.open(CACHE).then((c) => c.put(req, cp)).catch(() => {});
            return res;
          })
          .catch(() => cached);
      })
    );
  }
  // 跨域 GET：不调用 event.respondWith，交给浏览器默认网络栈（尊重 cache:'no-store'）
});
