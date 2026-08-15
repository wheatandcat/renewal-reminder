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

/** 対象月が到来しているステップに未チェックが残っていればバッジ表示 */
export function hasPendingBadge(sections: BadgeSection[], todayYm: string): boolean {
	return sections.some((s) => s.ym <= todayYm && s.remaining > 0);
}

/** 非対応環境(未インストール・通知未許可など)では黙って何もしない */
export async function applyBadge(show: boolean): Promise<void> {
	try {
		if (show) {
			await navigator.setAppBadge?.();
		} else {
			await navigator.clearAppBadge?.();
		}
	} catch (err) {
		console.error('badge update error:', err);
	}
}
