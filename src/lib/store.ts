export type Settings = {
	expiryYear: number;
	expiryMonth: number;
	diagnosisMonths: number;
	hasPension: boolean;
};

export type YearMonth = { year: number; month: number };

const SETTINGS_KEY = 'rr:settings';
const CHECKS_KEY = 'rr:checks';

export function loadSettings(): Settings | null {
	try {
		const raw = localStorage.getItem(SETTINGS_KEY);
		return raw ? (JSON.parse(raw) as Settings) : null;
	} catch {
		return null;
	}
}

export function saveSettings(settings: Settings): void {
	localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function loadChecks(): Record<string, boolean> {
	try {
		const raw = localStorage.getItem(CHECKS_KEY);
		return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
	} catch {
		return {};
	}
}

export function saveCheck(id: string, checked: boolean): void {
	const checks = loadChecks();
	checks[id] = checked;
	localStorage.setItem(CHECKS_KEY, JSON.stringify(checks));
}

export function clearChecks(): void {
	localStorage.removeItem(CHECKS_KEY);
}

export function addMonths(ym: YearMonth, delta: number): YearMonth {
	const index = ym.year * 12 + (ym.month - 1) + delta;
	return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

// 更新期間: 有効期限月の2ヶ月前 〜 1ヶ月後(東京都の基準)
// 準備開始: 更新期間開始月から診断書の所要月数をさかのぼった月
// 受け取り: 更新期間終了月から約3ヶ月後
export function renewalPlan(settings: Settings): {
	start: YearMonth;
	end: YearMonth;
	prepare: YearMonth;
	receive: YearMonth;
} {
	const expiry = { year: settings.expiryYear, month: settings.expiryMonth };
	const start = addMonths(expiry, -2);
	const end = addMonths(expiry, 1);
	return {
		start,
		end,
		prepare: addMonths(start, -settings.diagnosisMonths),
		receive: addMonths(end, 3),
	};
}

export function ymToDateString(ym: YearMonth): string {
	return `${ym.year}-${String(ym.month).padStart(2, '0')}-01`;
}
