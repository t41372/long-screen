/** Service worker (built to dist/sw.js, at the site root so its scope is the whole app): lets an installed copy open
 *  and run without a connection. TS shell only — it moves files, nothing else.
 *
 *  Network first, the cache only as a fallback. Online the page loads exactly as it does without a service worker:
 *  every request goes to the network and revalidates (static/_headers sends `no-cache`, and dist/assets/* keep the
 *  same names across deploys), so a deploy reaches visitors on their next load. The cache answers when the network
 *  fails or has not sent headers within NETWORK_WAIT_MS, as on a weak mobile signal.
 *
 *  The cache holds one build, whole: scripts/build.ts replaces PRECACHE below with every file a run needs (the
 *  page, styles, fonts, bundles, all three core builds, the sample recording) and a hash of their contents. Install
 *  stores them under that hash and activation deletes older builds' caches, so the offline copy is never part one
 *  deploy and part another. No skipWaiting() or clients.claim(): a page keeps the worker it loaded with until every
 *  tab of the app is closed, so a page that goes offline mid-session still finds files from its own build. */
const PRECACHE = JSON.parse('__LONG_SCREEN_PRECACHE__') as { version: string; files: string[] };
const PREFIX = 'long-screen-';
const CACHE = PREFIX + PRECACHE.version;
const NETWORK_WAIT_MS = 4000;

interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
}
const scope = globalThis as unknown as {
  registration: { scope: string };
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
};
// PRECACHE paths are relative to the scope; '' is the page itself, which Cloudflare Pages serves at `/` (and
// answers `/index.html` with a redirect), so it is cached and looked up under the scope URL.
const root = scope.registration.scope;
const cached = new Set(PRECACHE.files.map((file) => new URL(file, root).href));

scope.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([...cached])));
});

scope.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key.startsWith(PREFIX) && key !== CACHE).map((key) => caches.delete(key)))
    ),
  );
});

scope.addEventListener('fetch', (event) => {
  const { request } = event;
  // Range requests (media seeking) and anything not in the build go straight to the network, untouched.
  if (request.method !== 'GET' || request.headers.has('range')) {
    return;
  }
  const url = new URL(request.url);
  url.search = url.hash = '';
  const key = request.mode === 'navigate' && url.href === new URL('index.html', root).href ? root : url.href;
  if (cached.has(key)) {
    event.respondWith(networkFirst(request, key));
  }
});

async function networkFirst(request: Request, key: string): Promise<Response> {
  const network = fetch(request);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => timer = setTimeout(() => reject(new Error('network slow')), NETWORK_WAIT_MS));
  try {
    return await Promise.race([network, late]);
  } catch {
    // Offline or slow: this build's copy if there is one, otherwise keep waiting on the network (and fail as it fails).
    const copy = await caches.open(CACHE).then((cache) => cache.match(key));
    if (copy) {
      network.catch(() => {});
      return copy;
    }
    return network;
  } finally {
    clearTimeout(timer);
  }
}
