// PWAアイコンのバッジ(●)制御。
//
// チェック状態は localStorage にしかなくService Workerから読めないため、
// バッジ判定に必要な最小限のスナップショットをIndexedDBに書き出しておき、
// push受信時にSW側(public/sw.js)から同じ内容を読んで判定する。
// DB名 / ストア名 / キーは public/sw.js と揃えること。
import { isStandalone } from './platform';

const DB_NAME = 'rr';
const STORE_NAME = 'kv';
const BADGE_KEY = 'badge';

/** push通知に付けるtag。同じtagの通知は積み重ならず置き換わる。public/sw.js と揃えること */
export const NOTIFICATION_TAG = 'renewal-reminder';

/** ドット維持のために貼り直す通知の文言。public/sw.js と揃えること */
const KEEP_ALIVE_TITLE = '更新の手続きが残っています';
const KEEP_ALIVE_BODY = 'チェックリストの続きを確認してください';

export type BadgeSection = {
	/** 'YYYY-MM' 形式。チェックリストの各ステップの対象月 */
	ym: string;
	/** 未チェック件数(年金受給者で無効化された項目は除く) */
	remaining: number;
};

export type BadgeSnapshot = {
	sections: BadgeSection[];
	updatedAt: string;
};

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains(STORE_NAME)) {
				req.result.createObjectStore(STORE_NAME);
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function withStore(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => void): Promise<void> {
	return openDb().then(
		(db) =>
			new Promise<void>((resolve, reject) => {
				const tx = db.transaction(STORE_NAME, mode);
				fn(tx.objectStore(STORE_NAME));
				tx.oncomplete = () => {
					db.close();
					resolve();
				};
				tx.onerror = () => {
					db.close();
					reject(tx.error);
				};
			}),
	);
}

export async function saveBadgeSnapshot(sections: BadgeSection[]): Promise<void> {
	const snapshot: BadgeSnapshot = { sections, updatedAt: new Date().toISOString() };
	await withStore('readwrite', (store) => {
		store.put(snapshot, BADGE_KEY);
	});
}

export async function clearBadgeSnapshot(): Promise<void> {
	await withStore('readwrite', (store) => {
		store.delete(BADGE_KEY);
	});
}

/** 現在の年月(JST) を 'YYYY-MM' で返す */
export function todayYmJst(): string {
	return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

/** 対象月が到来しているステップの未チェック件数の合計(0ならバッジなし) */
export function pendingBadgeCount(sections: BadgeSection[], todayYm: string): number {
	return sections.reduce((sum, s) => (s.ym <= todayYm ? sum + s.remaining : sum), 0);
}

/**
 * このアプリが出した通知をすべて閉じる。
 *
 * AndroidはBadging API非対応で、代わりに「未読の通知が残っているか」でOSがアイコンに
 * ドットを付ける。そのため未チェックが0になったら通知を閉じないとドットが残り続ける。
 */
export async function closeNotifications(): Promise<void> {
	if (!('serviceWorker' in navigator)) return;
	try {
		// ready はSW未登録だと解決しないため getRegistration を使う
		const registration = await navigator.serviceWorker.getRegistration();
		if (!registration) return;
		const notifications = await registration.getNotifications();
		for (const notification of notifications) notification.close();
	} catch (err) {
		console.error('close notifications error:', err);
	}
}

/**
 * ドット維持用の通知が残っていなければ貼り直す。
 *
 * Androidは通知をタップするとその通知が閉じられるため、未チェックが残っていても
 * アイコンのドットが消えてしまう。Badging API非対応環境ではドットの根拠が通知しかないので、
 * 残件がある間は無音の通知を出し直してドットを保つ。
 */
export async function ensureBadgeNotification(): Promise<void> {
	if (!('serviceWorker' in navigator)) return;
	if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
	try {
		const registration = await navigator.serviceWorker.getRegistration();
		if (!registration) return;
		// 既に通知が残っていれば何もしない(貼り直すとトレイでの並び順が変わるため)
		const existing = await registration.getNotifications({ tag: NOTIFICATION_TAG });
		if (existing.length > 0) return;
		await registration.showNotification(KEEP_ALIVE_TITLE, {
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

/** このアプリが出している通知の件数(実機でドットの有無を診断するために使う) */
export async function countNotifications(): Promise<number> {
	if (!('serviceWorker' in navigator)) return 0;
	try {
		const registration = await navigator.serviceWorker.getRegistration();
		if (!registration) return 0;
		return (await registration.getNotifications()).length;
	} catch {
		return 0;
	}
}

export type BadgeResult = 'ok' | 'unsupported' | 'denied' | 'error';

/**
 * バッジを反映する。
 * iOSのBadging APIはホーム画面追加済み + 通知許可済みでないと拒否されるため、
 * 何が原因で反映できなかったかを呼び出し元へ返す(UIでの案内に使う)。
 *
 * 引数なしの setAppBadge() (●のみ) は環境によって描画されないため、必ず件数を渡す。
 */
export async function applyBadge(count: number): Promise<BadgeResult> {
	// Androidのドットは通知の有無で決まるので、Badging APIの対応可否に関わらず先に消す
	if (count === 0) await closeNotifications();
	if (typeof navigator.setAppBadge !== 'function') {
		// Badging API非対応(Android)ではドット = 未読通知。残件がある間は通知を貼り直して維持する。
		// ブラウザのタブで開いているときは通知トレイを汚すだけなので、ホーム画面から開いた場合のみ
		if (count > 0 && isStandalone()) await ensureBadgeNotification();
		return 'unsupported';
	}
	if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return 'denied';
	try {
		if (count > 0) {
			await navigator.setAppBadge(count);
		} else {
			await navigator.clearAppBadge?.();
		}
		return 'ok';
	} catch (err) {
		console.error('badge update error:', err);
		return 'error';
	}
}
