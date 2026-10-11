/** Installing the app as a PWA, and keeping an installed copy usable offline. Registers the service worker
 *  (src/sw.ts) and shows the header's install key only where this browser can install the page and it is not
 *  already running installed. Chromium (Android Chrome, desktop Chrome and Edge) has its own install prompt behind
 *  `beforeinstallprompt`; Safari has none, so on iPhone, iPad and Mac the key opens the steps instead. Elsewhere
 *  (Firefox, or a portable copy opened from file://, which can have neither a manifest nor a service worker) the
 *  key stays hidden. */
import { $ } from './dom.ts';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** Which of Apple's install routes this browser has: the share sheet's Add to Home Screen on iPhone and iPad (every
 *  browser there is WebKit and has it), Safari 17+'s File → Add to Dock on a Mac, or neither. */
function appleRoute(): 'ios' | 'mac' | undefined {
  const ua = navigator.userAgent;
  // iPadOS Safari reports itself as a Mac; the touch screen gives it away.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) {
    return 'ios';
  }
  const safari = /Version\/(\d+)[\d.]* Safari\//.exec(ua);
  if (/Macintosh/.test(ua) && safari && Number(safari[1]) >= 17 && !/Chrome|Chromium|Edg|OPR|Firefox/.test(ua)) {
    return 'mac';
  }
  return undefined;
}

export function wireInstall(): void {
  if (location.protocol === 'file:') {
    return;
  }
  // After load, so storing the offline copy (every file a run needs) never competes with the page's own loading.
  if ('serviceWorker' in navigator) {
    addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('Service worker not registered:', error));
    });
  }
  if (matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true) {
    return;
  }
  const button = $<HTMLButtonElement>('install-btn');
  const route = appleRoute();
  let pending: InstallPromptEvent | undefined;
  addEventListener('beforeinstallprompt', (event) => {
    // Keeps Chromium's own mini-infobar from showing as well: the key asks instead, when the user wants it.
    event.preventDefault();
    pending = event as InstallPromptEvent;
    button.hidden = false;
  });
  addEventListener('appinstalled', () => {
    pending = undefined;
    button.hidden = true;
  });
  if (route) {
    $('install-ios').hidden = route !== 'ios';
    $('install-mac').hidden = route !== 'mac';
    button.hidden = false;
  }
  button.onclick = () => {
    if (pending) {
      // A prompt shows once. If the user declines, the key goes away until Chromium offers a new one.
      const prompt = pending;
      pending = undefined;
      button.hidden = true;
      void prompt.prompt();
    } else if (route) {
      $<HTMLDialogElement>('install-dialog').showModal();
    }
  };
}
