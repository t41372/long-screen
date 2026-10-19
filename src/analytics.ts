/** The hosted site's usage counter (built to assets/analytics.js): PostHog's SDK, configured to send only what
 *  src/ui/analytics.ts queues plus one page view. main.js adds this script only on the hosted site and only without
 *  Do Not Track or Global Privacy Control; see that file for what is sent and why.
 *
 *  The SDK is bundled from npm into this same-origin file rather than loaded from PostHog's CDN: the page is
 *  cross-origin isolated (COEP require-corp, for the threads core), and PostHog's CDN scripts send no
 *  Cross-Origin-Resource-Policy header, so the browser would refuse them. The `slim.no-external` build carries no
 *  autocapture, session recording, surveys or toolbar and never loads further scripts; `advanced_disable_flags` skips
 *  the remote config call, so nothing configured in PostHog's dashboard can switch those on. Cookieless mode stores
 *  nothing in the browser (no cookie, no localStorage) and lets PostHog count a day's distinct visitors from a
 *  salted hash that it rotates daily; the PostHog project must have cookieless mode enabled, or it drops the events. */
import { posthog } from 'posthog-js/dist/module.slim.no-external.js';
import type { AnalyticsEvent } from './ui/analytics.ts';

/** PostHog project API key: public by design, it can only send events to the project. */
const PROJECT_KEY = 'phc_qebpUVBUZRPLFs9FSSm4ERNAuhDzDc6E2wAmHV2fnBRq';
export const API_HOST = 'https://us.i.posthog.com';

posthog.init(PROJECT_KEY, {
  api_host: API_HOST,
  cookieless_mode: 'always',
  persistence: 'memory',
  person_profiles: 'identified_only',
  respect_dnt: true,
  advanced_disable_flags: true,
  disable_external_dependency_loading: true,
  disable_session_recording: true,
  disable_surveys: true,
  autocapture: false,
  capture_pageview: true,
  capture_pageleave: false,
  capture_exceptions: false,
  capture_performance: false,
  capture_dead_clicks: false,
  disable_capture_url_hashes: true,
});

const holder = globalThis as unknown as { __LS_ANALYTICS__?: AnalyticsEvent[] };
const queue = holder.__LS_ANALYTICS__ ?? [];
for (const [name, properties] of queue.splice(0)) posthog.capture(name, properties);
queue.push = (...events: AnalyticsEvent[]) => {
  for (const [name, properties] of events) posthog.capture(name, properties);
  return 0;
};
