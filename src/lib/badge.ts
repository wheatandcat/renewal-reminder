// PWAアイコンのバッジ(●)制御。
//
// チェック状態は localStorage にしかなくService Workerから読めないため、
// バッジ判定に必要な最小限のスナップショットをIndexedDBに書き出しておき、
// push受信時にSW側(public/sw.js)から同じ内容を読んで判定する。
// DB名 / ストア名 / キーは public/sw.js と揃えること。
import { isAndroid, isStandalone } from './platform';

const DB_NAME = 'rr';
const STORE_NAME = 'kv';
const BADGE_KEY = 'badge';
const BADGE_DEBUG_KEY = 'badgeDebug';

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
	/**
	 * ドット維持のための通知の貼り直しが必要か(= Android)。
	 * SWスコープではUA判定を書き分けたくないため、ページ(window)側で測った値をSWへ渡す
	 */
	keepAlive: boolean;
	/** Badging APIが使えるか。診断表示用 */
	badgeApi: boolean;
};

/** SW側(public/sw.js)が書き残す判定ログ。実機での診断用 */
export type BadgeSwLog = {
	at?: string;
	force?: boolean;
	swBadgeApi?: string;
	badgeApi?: boolean | null;
	keepAlive?: boolean;
	count?: number;
	skipped?: string;
	shown?: number;
	error?: string;
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
	const snapshot: BadgeSnapshot = {
		sections,
		updatedAt: new Date().toISOString(),
		keepAlive: isAndroid(),
		badgeApi: typeof navigator.setAppBadge === 'function',
	};
	await withStore('readwrite', (store) => {
		store.put(snapshot, BADGE_KEY);
	});
}

/** SW側が書き残した判定ログを読む(診断表示用) */
export async function readBadgeSwLog(): Promise<BadgeSwLog | null> {
	try {
		const db = await openDb();
		return await new Promise<BadgeSwLog | null>((resolve, reject) => {
			const get = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(BADGE_DEBUG_KEY);
			get.onsuccess = () => {
				db.close();
				resolve((get.result as BadgeSwLog) ?? null);
			};
			get.onerror = () => {
				db.close();
				reject(get.error);
			};
		});
	} catch {
		return null;
	}
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
		// 貼り直しのたびに音やバイブが鳴るのを避けるため silent。
		// 通知は出ている(診断表示の notifications >= 1)のにドットが出ない場合は、
		// 端末が重要度の低い通知にドットを付けていない可能性があるので silent を外して試すこと
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

/**
 * ドット維持のための通知が必要な状況なら貼り直す。
 *
 * Androidは setAppBadge() が存在しても(Chrome 151で確認)ランチャーには描画されず、
 * 実際のドットは未読通知から出る。そのためAPIの対応可否ではなくAndroidかどうかで判定する。
 * ブラウザのタブで開いているときは通知トレイを汚すだけなので、ホーム画面から開いた場合のみ。
 */
export async function keepBadgeNotificationIfNeeded(count: number): Promise<void> {
	if (count <= 0) return;
	if (!isAndroid()) return;
	if (!isStandalone()) return;
	await ensureBadgeNotification();
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
 *
 * closeWhenEmpty: 件数0のときに通知を閉じるか。対象月がまだ1つも到来していない間は、
 * 届いた通知を消す理由がないためfalseを渡す(前倒しで届いたpushが即消えるのを防ぐ)
 */
export async function applyBadge(
	count: number,
	{ closeWhenEmpty = true }: { closeWhenEmpty?: boolean } = {},
): Promise<BadgeResult> {
	// Androidのドットは通知の有無で決まるので、Badging APIの対応可否に関わらず先に消す
	if (count === 0 && closeWhenEmpty) await closeNotifications();
	// Androidは setAppBadge() が成功してもドットが出ないため、通知でドットを維持する
	await keepBadgeNotificationIfNeeded(count);
	if (typeof navigator.setAppBadge !== 'function') return 'unsupported';
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
