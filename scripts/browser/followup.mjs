import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Bundle the frozen 21c6335 event class, rather than imitating its wire receiver.
// The fixture adapts imports to current JSON/error helpers; it is not a full old package.
export async function legacyEventBundle() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../../tests/fixtures/events/legacy.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', write: false,
  });
  return result.outputFiles[0].text;
}

async function cacheIntegrityChecks(page, results) {
  const report = await page.evaluate(async () => {
    const { NexusStorage } = await import('/index.js');
    const checked = [], failures = [], observations = [];
    const equal = (actual, expected, label) => {
      if (JSON.stringify(actual) === JSON.stringify(expected)) checked.push(label);
      else failures.push(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
    };
    const url = key => 'https://nexusstorage.invalid/v1/' + encodeURIComponent(JSON.stringify(key));
    for (const { name: fixture, languages } of [
      { name: 'matched-single', languages: [null] },
      { name: 'hidden-single', languages: ['zh'] },
      { name: 'two-put', languages: ['zh', 'en'] },
    ]) {
      const namespace = `followup:cache:vary:${fixture}`;
      const cacheName = 'nexusstorage:' + JSON.stringify(namespace);
      const cache = await caches.open(cacheName);
      const store = new NexusStorage({ driver: 'cacheStorage', namespace });
      const foreign = new Request('https://example.invalid/foreign', { headers: { 'x-lang': 'zh' } });
      const snapshot = async () => {
        const entries = [];
        for (const request of await cache.keys()) {
          const response = await cache.match(request);
          entries.push({ url: request.url, lang: request.headers.get('x-lang'),
            vary: response.headers.get('vary'), body: await response.text() });
        }
        return entries;
      };
      const seed = async () => {
        for (const request of await cache.keys()) await cache.delete(request, { ignoreVary: true });
        await cache.put(new Request(url('before')), new Response('{"keep":true}'));
        for (const lang of languages) {
          await cache.put(new Request(url('item'), lang === null ? {} : { headers: { 'x-lang': lang } }),
            new Response(JSON.stringify({ lang }), { headers: { vary: 'x-lang' } }));
        }
        await cache.put(foreign, new Response('{"foreign":true}', { headers: { vary: 'x-lang' } }));
      };
      try {
        await seed();
        const nativeVariants = (await cache.keys(new Request(url('item')), { ignoreVary: true })).length;
        observations.push(`native Chromium: ${fixture} (${languages.length} Vary put(s)) retained ${nativeVariants} canonical request(s)`);
        equal(nativeVariants >= 1 && nativeVariants <= languages.length, true,
          `cacheStorage: native ${fixture} fixture contains Vary data`);
        for (const [name, operation] of [
          ['get', () => store.get('item')], ['has', () => store.has('item')],
          ['set', () => store.set('item', { changed: true })],
          ['update', () => store.update('item', { changed: true })],
          ['remove', () => store.remove('item')], ['keys', () => store.keys()], ['clear', () => store.clear()],
        ]) {
          // Recreate independently: a buggy mutation must not conceal a later failure.
          await seed();
          const before = await snapshot();
          let outcome = 'SUCCESS';
          try { await operation(); } catch (error) { outcome = error.code ?? String(error); }
          equal(outcome, 'CORRUPT_DATA', `cacheStorage: ${fixture} native Vary ${name} rejects ambiguity`);
          equal(await snapshot(), before, `cacheStorage: ${fixture} native Vary ${name} preserves all original responses`);
        }
      } finally { await store.close(); await caches.delete(cacheName); }
    }
    return { checked, failures, observations };
  });
  results.push(...report.checked);
  for (const observation of report.observations) console.log(observation);
  assert.deepEqual(report.failures, [], 'Native Cache Vary defenses');
}

async function incrementalScanChecks(page, results) {
  const report = await page.evaluate(async () => {
    const { NexusStorage } = await import('/index.js');
    const checked = [], failures = [];
    const equal = (actual, expected, label) => {
      if (JSON.stringify(actual) === JSON.stringify(expected)) checked.push(label);
      else failures.push(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
    };
    const namespace = 'followup:cache:incremental';
    const cacheName = 'nexusstorage:' + JSON.stringify(namespace);
    const cache = await caches.open(cacheName);
    const store = new NexusStorage({ driver: 'cacheStorage', namespace });
    const originalKeys = Cache.prototype.keys, originalText = Response.prototype.text, originalParse = JSON.parse;
    let fullEnumerations = 0;
    const observed = [];
    const bodies = ['"followup:scan:0"', '"followup:scan:1"', '"followup:scan:2"'];
    const bad = '{followup:broken', late = JSON.stringify({ payload: 'x'.repeat(128 * 1024) });
    const labels = new Map([...bodies.map((body, index) => [body, String(index)]), [bad, 'bad'], [late, 'late']]);
    const seed = async entries => {
      for (const request of await cache.keys()) await cache.delete(request);
      for (const [key, body] of entries) await cache.put(
        new Request('https://nexusstorage.invalid/v1/' + encodeURIComponent(JSON.stringify(key))), new Response(body));
    };
    const instrument = () => {
      Cache.prototype.keys = function (...args) {
        if (args[0] === undefined) fullEnumerations++;
        return originalKeys.apply(this, args);
      };
      Response.prototype.text = async function () {
        const body = await originalText.call(this);
        if (labels.has(body)) observed.push('text:' + labels.get(body));
        return body;
      };
      JSON.parse = function (raw, ...args) {
        if (labels.has(raw)) observed.push('parse:' + labels.get(raw));
        return originalParse.call(this, raw, ...args);
      };
    };
    const restore = () => { Cache.prototype.keys = originalKeys; Response.prototype.text = originalText; JSON.parse = originalParse; };
    try {
      await seed(bodies.map((body, index) => [`key${index}`, body]));
      instrument();
      equal(await store.keys(), ['key0', 'key1', 'key2'], 'cacheStorage: incremental scan returns all logical keys');
      equal(fullEnumerations, 1, 'cacheStorage: incremental scan enumerates Requests once');
      equal(observed, ['text:0', 'parse:0', 'text:1', 'parse:1', 'text:2', 'parse:2'],
        'cacheStorage: each body is decoded before reading the next body');
      restore();
      await seed([['first', bad], ['later', late]]);
      fullEnumerations = 0; observed.length = 0; instrument();
      let outcome = 'SUCCESS';
      try { await store.keys(); } catch (error) { outcome = error.code ?? String(error); }
      equal(outcome, 'CORRUPT_DATA', 'cacheStorage: invalid first JSON rejects public keys');
      equal(fullEnumerations, 1, 'cacheStorage: corrupt scan still enumerates Requests once');
      equal(observed, ['text:bad', 'parse:bad'], 'cacheStorage: invalid first JSON stops before reading later 128KiB body');
    } finally { restore(); await store.close(); await caches.delete(cacheName); }
    return { checked, failures };
  });
  results.push(...report.checked);
  assert.deepEqual(report.failures, [], 'Observable incremental Cache body decoding (not GC or RSS measurement)');
}

async function mixedVersionChecks(page, secondPage, results) {
  const namespace = 'followup:legacy-events';
  await secondPage.evaluate(async namespace => {
    const { StorageEvents } = await import('/legacy-events.js');
    const transport = new StorageEvents('localStorage', namespace, true);
    const events = [], envelopes = [];
    const key = 'nexusstorage:events:1:' + JSON.stringify(['localStorage', namespace]);
    const capture = event => {
      if (event.key === key && event.newValue !== null) envelopes.push(JSON.parse(event.newValue));
    };
    window.addEventListener('storage', capture);
    for (const type of ['change', 'remove', 'clear']) transport.on(type, event => events.push(event));
    globalThis.__legacyFollowup = { transport, events, envelopes, capture };
  }, namespace);
  await page.evaluate(async namespace => {
    const { NexusStorage } = await import('/index.js');
    const stores = [0, 1].map(() => new NexusStorage({ driver: 'localStorage', namespace, broadcast: true }));
    const events = [];
    stores.forEach((store, index) => {
      for (const type of ['change', 'remove', 'clear']) store.on(type, event => events.push({ index, event }));
    });
    globalThis.__currentFollowup = { stores, events };
  }, namespace);
  try {
    await page.evaluate(async () => {
      const store = globalThis.__currentFollowup.stores[0];
      await store.set('item', { n: 1 }); await store.update('item', { n: 2 });
      await store.remove('item'); await store.clear();
    });
    // Wait for all native control writes, even when the frozen old receiver drops them.
    await secondPage.waitForFunction(() => globalThis.__legacyFollowup.envelopes.length === 4);
    const legacy = await secondPage.evaluate(() => ({
      events: globalThis.__legacyFollowup.events, envelopes: globalThis.__legacyFollowup.envelopes,
    }));
    const changes = [
      { type: 'change', operation: 'set', key: 'old-set' },
      { type: 'change', operation: 'update', key: 'old-update' },
      { type: 'remove', operation: 'remove', key: 'old-remove' },
      { type: 'clear', operation: 'clear' },
    ];
    await page.evaluate(() => { globalThis.__currentFollowup.events.length = 0; });
    let committed;
    for (const [index, change] of changes.entries()) {
      await secondPage.evaluate(change => {
        // Native business writes plus publication by the genuine frozen old event class.
        const prefix = 'nexusstorage:' + JSON.stringify('followup:legacy-events') + ':';
        if (change.type === 'change') localStorage.setItem(prefix + change.key, JSON.stringify({ committed: change.operation }));
        else if (change.type === 'remove') localStorage.removeItem(prefix + change.key);
        else {
          for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
        }
        globalThis.__legacyFollowup.transport.publish(change);
      }, change);
      // The assertion below also records drops; no fixed sleep or timeout is used as delivery proof.
      if (index === 0) committed = await page.evaluate(() => globalThis.__currentFollowup.stores[0].get('old-set'));
    }
    // A sentinel storage event proves the preceding old native writes reached this tab.
    await page.evaluate(() => {
      globalThis.__oldFollowupDone = false;
      const listener = event => {
        if (event.key === 'followup:legacy:sentinel') {
          globalThis.__oldFollowupDone = true;
          window.removeEventListener('storage', listener);
        }
      };
      window.addEventListener('storage', listener);
    });
    await secondPage.evaluate(() => localStorage.setItem('followup:legacy:sentinel', 'done'));
    await page.waitForFunction(() => globalThis.__oldFollowupDone);
    const current = await page.evaluate(() => globalThis.__currentFollowup.events);
    const failures = [];
    const equal = (actual, expected, label) => {
      try { assert.deepEqual(actual, expected); results.push(label); }
      catch { failures.push(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`); }
    };
    const operations = ['set', 'update', 'remove', 'clear'];
    equal(legacy.events.map(event => event.operation), operations, 'localStorage: frozen 21c6335 event class receives all new operations');
    equal(legacy.events.every(event => event.source === 'remote' && !('value' in event)), true,
      'localStorage: frozen old receiver gets remote metadata only');
    equal(legacy.envelopes.every(envelope => typeof envelope.id === 'string' && envelope.id === envelope.eventId
      && typeof envelope.instanceId === 'string'), true, 'localStorage: new sender retains legacy id alongside instance and event identity');
    equal(current.map(item => [item.index, item.event.operation]),
      operations.flatMap(operation => [[0, operation], [1, operation]]),
      'localStorage: old id-only sender reaches both new subscribers once in native order');
    equal(current.every(item => item.event.source === 'remote' && !('value' in item.event)), true,
      'localStorage: new receivers keep old notifications remote and omit business values');
    equal(committed, { committed: 'set' }, 'localStorage: new receiver can reread committed old data');
    assert.deepEqual(failures, [], 'Frozen legacy and current native storage event interoperability');
  } finally {
    await page.evaluate(async () => {
      await Promise.all(globalThis.__currentFollowup.stores.map(store => store.close()));
      delete globalThis.__currentFollowup; delete globalThis.__oldFollowupDone;
    });
    await secondPage.evaluate(() => {
      const state = globalThis.__legacyFollowup;
      state.transport.close(); window.removeEventListener('storage', state.capture);
      localStorage.removeItem('followup:legacy:sentinel'); delete globalThis.__legacyFollowup;
    });
  }
}

export async function runFollowupBrowserChecks({ page, secondPage, results }) {
  const failures = [];
  for (const [name, operation] of [
    ['native Cache Vary', () => cacheIntegrityChecks(page, results)],
    ['incremental Cache bodies', () => incrementalScanChecks(page, results)],
    ['frozen legacy events', () => mixedVersionChecks(page, secondPage, results)],
  ]) {
    try { await operation(); console.log(`PASS ${name}`); }
    catch (error) { console.error(`FAIL ${name}: ${error.message}`); failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, `${failures.length} browser followup groups failed`);
}

// Run against the existing dist only; the caller controls the red/green build boundary.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bundle = await readFile(new URL('../../dist/index.js', import.meta.url));
  const legacy = await legacyEventBundle();
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': request.url.endsWith('.js') ? 'text/javascript' : 'text/html' });
    response.end(request.url === '/index.js' ? bundle : request.url === '/legacy-events.js' ? legacy : '<!doctype html><title>Followup checks</title>');
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true, ...(process.env.NEXUSSTORAGE_BROWSER_EXECUTABLE
      ? { executablePath: process.env.NEXUSSTORAGE_BROWSER_EXECUTABLE } : {}) });
    const context = await browser.newContext();
    const page = await context.newPage(), secondPage = await context.newPage();
    const errors = [];
    for (const tab of [page, secondPage]) {
      tab.on('pageerror', error => errors.push(error.message));
      await tab.goto(`http://127.0.0.1:${server.address().port}`);
    }
    const results = [];
    await runFollowupBrowserChecks({ page, secondPage, results });
    assert.deepEqual(errors, []);
    console.log(`Chromium ${browser.version()}: ${results.length} followup browser checks passed.`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
