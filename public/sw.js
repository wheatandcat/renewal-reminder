const PAGE_CACHE = 'pages-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) =>
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== PAGE_CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  ),
);

// Chromeのインストールプロンプト(beforeinstallprompt)はfetchハンドラの存在を要求するため必須。
// ページ遷移のみネットワーク優先で扱い、オフライン時はキャッシュ済みのページを返す。
// (それ以外のリクエストは何もせずブラウザ標準の処理に任せる)
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.mode !== 'navigate' || request.method !== 'GET') return;

  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(PAGE_CACHE);
          cache.put(request, response.clone());
        }
        return response;
      } catch (err) {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        throw err;
      }
    })(),
  );
});

// バッジ判定用スナップショットの置き場所。src/lib/badge.ts と揃えること。
// (public/ 配下はバンドルされないため src からimportできず、読み取り部分のみ複製している)
const BADGE_DB_NAME = 'rr';
const BADGE_STORE_NAME = 'kv';
const BADGE_KEY = 'badge';
// 同じtagの通知は積み重ならず置き換わる。src/lib/badge.ts の NOTIFICATION_TAG と揃えること
const NOTIFICATION_TAG = 'renewal-reminder';
// ドット維持のために貼り直す通知の文言。src/lib/badge.ts と揃えること
const KEEP_ALIVE_TITLE = '更新の手続きが残っています';
const KEEP_ALIVE_BODY = 'チェックリストの続きを確認してください';

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

/** 対象月が到来しているステップの未チェック件数(src/lib/badge.ts の pendingBadgeCount と同じ) */
function pendingCount(sections) {
  const todayYm = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
  return sections.reduce((sum, s) => (s.ym <= todayYm ? sum + s.remaining : sum), 0);
}

async function updateBadgeFromIdb() {
  try {
    const snapshot = await readBadgeSnapshot();
    // まだ /checklist を開いていない場合は判定材料がないので何もしない
    if (!snapshot?.sections) return;
    // 引数なしの setAppBadge() は環境によって描画されないため件数を渡す(src/lib/badge.ts と同じ)
    const count = pendingCount(snapshot.sections);
    if (count > 0) {
      await self.navigator.setAppBadge?.(count);
    } else {
      await self.navigator.clearAppBadge?.();
    }
  } catch (err) {
    console.error('badge update error:', err);
  }
}

/**
 * ドット維持用の通知が残っていなければ貼り直す。
 *
 * Androidは通知をタップすると通知が閉じられ、未チェックが残っていてもアイコンのドットが
 * 消えてしまう。ドットの根拠が通知しかないため、残件がある間は無音の通知を出し直す。
 * (src/lib/badge.ts の ensureBadgeNotification と同じ役割)
 *
 * force: 直前に close() した通知が getNotifications() にまだ残って見えることがあるため、
 * タップ直後の貼り直しでは残存チェックを行わない(同じtagなので重複はしない)
 */
async function keepBadgeNotification(force = false) {
  // Badging APIが使える環境(iOS/デスクトップ)は通知と無関係にバッジを出せるので貼り直さない
  if (typeof self.navigator.setAppBadge === 'function') return;
  try {
    const snapshot = await readBadgeSnapshot();
    if (!snapshot?.sections) return;
    if (pendingCount(snapshot.sections) === 0) return;
    if (!force) {
      const existing = await self.registration.getNotifications({ tag: NOTIFICATION_TAG });
      if (existing.length > 0) return;
    }
    await self.registration.showNotification(KEEP_ALIVE_TITLE, {
      body: KEEP_ALIVE_BODY,
      icon: '/icons/icon-192.png',
      data: { url: '/checklist' },
      tag: NOTIFICATION_TAG,
      silent: true,
    });
  } catch (err) {
    console.error('keep-alive notification error:', err);
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
        // AndroidのアイコンのドットはOSが未読通知から出すため、
        // pushが複数回来ても通知が積み重ならないようtagで置き換える
        tag: NOTIFICATION_TAG,
      }),
      updateBadgeFromIdb(),
    ]),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? '/';
  event.waitUntil(
    Promise.all([
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        const existing = clients.find((c) => c.url === url);
        return existing ? existing.focus() : self.clients.openWindow(url);
      }),
      // タップで閉じた通知を、未チェックが残っていれば貼り直してドットを維持する
      keepBadgeNotification(true),
    ]),
  );
});
