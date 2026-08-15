self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// バッジ判定用スナップショットの置き場所。src/lib/badge.ts と揃えること。
// (public/ 配下はバンドルされないため src からimportできず、読み取り部分のみ複製している)
const BADGE_DB_NAME = 'rr';
const BADGE_STORE_NAME = 'kv';
const BADGE_KEY = 'badge';

function readBadgeSnapshot() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BADGE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(BADGE_STORE_NAME)) {
        req.result.createObjectStore(BADGE_STORE_NAME);
      }
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const get = db.transaction(BADGE_STORE_NAME, 'readonly').objectStore(BADGE_STORE_NAME).get(BADGE_KEY);
      get.onsuccess = () => {
        db.close();
        resolve(get.result ?? null);
      };
      get.onerror = () => {
        db.close();
        reject(get.error);
      };
    };
  });
}

async function updateBadgeFromIdb() {
  try {
    const snapshot = await readBadgeSnapshot();
    // まだ /checklist を開いていない場合は判定材料がないので何もしない
    if (!snapshot?.sections) return;
    const todayYm = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
    // 引数なしの setAppBadge() は環境によって描画されないため件数を渡す(src/lib/badge.ts と同じ)
    const count = snapshot.sections.reduce(
      (sum, s) => (s.ym <= todayYm ? sum + s.remaining : sum),
      0,
    );
    if (count > 0) {
      await self.navigator.setAppBadge?.(count);
    } else {
      await self.navigator.clearAppBadge?.();
    }
  } catch (err) {
    console.error('badge update error:', err);
  }
}

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title ?? 'Reminder', {
        body: data.body ?? '',
        icon: '/icons/icon-192.png',
        data: { url: data.url ?? '/' },
        requireInteraction: true,
      }),
      updateBadgeFromIdb(),
    ]),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((c) => c.url === url);
      return existing ? existing.focus() : self.clients.openWindow(url);
    }),
  );
});
