export const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const isAndroid = () => /android/i.test(navigator.userAgent);

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;

export const iosSupportsWebPush = () => {
  const m = navigator.userAgent.match(/OS (\d+)_(\d+)/);
  if (!m) return true;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 16 || (major === 16 && minor >= 4);
};
