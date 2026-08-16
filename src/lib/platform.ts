export const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const isAndroid = () => /android/i.test(navigator.userAgent);

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;

// UAでChromeを名乗るがChromeではないブラウザ(Chromium系の派生・アプリ内ブラウザ)
const NON_CHROME_UA =
  /(Edg|EdgA|EdgiOS|OPR|OPT|OPiOS|SamsungBrowser|MiuiBrowser|HeyTapBrowser|YaBrowser|Whale|Vivaldi|DuckDuckGo|UCBrowser|QQBrowser|CriOS|FxiOS|Firefox|Line|FBAV|FB_IAB|Instagram)/i;

const isChromeUA = () =>
  /Chrome\//.test(navigator.userAgent) && !NON_CHROME_UA.test(navigator.userAgent);

// BraveはUAをChromeと同一にするためUAでは判別できない。Brave独自のAPIで判定する
const isBrave = async () => {
  const brave = (navigator as any).brave;
  if (!brave || typeof brave.isBrave !== 'function') return false;
  try {
    return (await brave.isBrave()) === true;
  } catch {
    return false;
  }
};

/**
 * Android の Google Chrome かどうか。
 * Chrome以外のブラウザでホーム画面に追加してもPWA(Web Push等)が正しく動作しないため、
 * インストール導線はこの判定を通った場合のみ表示する。
 */
export const isAndroidChrome = async () =>
  isAndroid() && isChromeUA() && !(await isBrave());

/** 現在のURLをChromeで開くためのintent URL(Android専用) */
export const chromeIntentUrl = (url: string = location.href) => {
  const u = new URL(url);
  const scheme = u.protocol.replace(':', '');
  return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${scheme};package=com.android.chrome;end`;
};

export const iosSupportsWebPush = () => {
  const m = navigator.userAgent.match(/OS (\d+)_(\d+)/);
  if (!m) return true;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 16 || (major === 16 && minor >= 4);
};
