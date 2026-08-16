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
// SW側の判定結果の記録(実機にコンソールがないため、チェックリストの診断表示から読む)
const BADGE_DEBUG_KEY = 'badgeDebug';
// 同じtagの通知は積み重ならず置き換わる。src/lib/badge.ts の NOTIFICATION_TAG と揃えること
const NOTIFICATION_TAG = 'renewal-reminder';
// ドット維持のために貼り直す通知の文言。src/lib/badge.ts と揃えること
const KEEP_ALIVE_TITLE = '更新の手続きが残っています';
const KEEP_ALIVE_BODY = 'チェックリストの続きを確認してください';

function openBadgeDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BADGE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(BADGE_STORE_NAME)) {
        req.result.createObjectStore(BADGE_STORE_NAME);
      }
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

async function readKv(key) {
  const db = await openBadgeDb();
  return new Promise((resolve, reject) => {
    const get = db.transaction(BADGE_STORE_NAME, 'readonly').objectStore(BADGE_STORE_NAME).get(key);
    get.onsuccess = () => {
      db.close();
      resolve(get.result ?? null);
    };
    get.onerror = () => {
      db.close();
      reject(get.error);
    };
  });
}

async function writeKv(key, value) {
  const db = await openBadgeDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BADGE_STORE_NAME, 'readwrite');
    tx.objectStore(BADGE_STORE_NAME).put(value, key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

function readBadgeSnapshot() {
  return readKv(BADGE_KEY);
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
 *
 * 判定結果は BADGE_DEBUG_KEY に残し、チェックリストの診断表示から実機で確認できるようにする。
 */
async function keepBadgeNotification(force = false) {
  /** @type {Record<string, unknown>} */
  const log = { at: new Date().toISOString(), force, swBadgeApi: typeof self.navigator.setAppBadge };
  try {
    const snapshot = await readBadgeSnapshot();
    log.badgeApi = snapshot?.badgeApi ?? null;
    // Androidは setAppBadge() が使えてもランチャーに描画されず、ドットは未読通知から出る。
    // 判定はページ側で測った値を使う(古いスナップショットしかない場合はUAで代替)
    log.keepAlive = snapshot?.keepAlive ?? /android/i.test(self.navigator.userAgent);
    if (!log.keepAlive) {
      log.skipped = 'not-needed';
      return;
    }
    if (!snapshot?.sections) {
      log.skipped = 'no-snapshot';
      return;
    }
    log.count = pendingCount(snapshot.sections);
    if (log.count === 0) {
      log.skipped = 'count-0';
      return;
    }
    if (!force) {
      const existing = await self.registration.getNotifications({ tag: NOTIFICATION_TAG });
      if (existing.length > 0) {
        log.skipped = 'existing';
        return;
      }
    }
    // 貼り直しのたびに音やバイブが鳴るのを避けるため silent(src/lib/badge.ts と揃えること)
    await self.registration.showNotification(KEEP_ALIVE_TITLE, {
      body: KEEP_ALIVE_BODY,
      icon: '/icons/icon-192.png',
      data: { url: '/checklist' },
      tag: NOTIFICATION_TAG,
      silent: true,
    });
    log.shown = (await self.registration.getNotifications({ tag: NOTIFICATION_TAG })).length;
  } catch (err) {
    log.error = String(err);
    console.error('keep-alive notification error:', err);
  } finally {
    await writeKv(BADGE_DEBUG_KEY, log).catch(() => {});
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
