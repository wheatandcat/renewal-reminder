// PWAアイコンのバッジ(●)制御。
//
// チェック状態は localStorage にしかなくService Workerから読めないため、
// バッジ判定に必要な最小限のスナップショットをIndexedDBに書き出しておき、
// push受信時にSW側(public/sw.js)から同じ内容を読んで判定する。
// DB名 / ストア名 / キーは public/sw.js と揃えること。
const DB_NAME = 'rr';
const STORE_NAME = 'kv';
const BADGE_KEY = 'badge';

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

export type BadgeResult = 'ok' | 'unsupported' | 'denied' | 'error';

/**
 * バッジを反映する。
 * iOSのBadging APIはホーム画面追加済み + 通知許可済みでないと拒否されるため、
 * 何が原因で反映できなかったかを呼び出し元へ返す(UIでの案内に使う)。
 *
 * 引数なしの setAppBadge() (●のみ) は環境によって描画されないため、必ず件数を渡す。
 */
export async function applyBadge(count: number): Promise<BadgeResult> {
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
