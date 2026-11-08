import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

/** Regression checks against native Chromium storage, with no backend substitutes. */
export async function runReviewBrowserChecks({ page, secondPage, results }) {
  results.push(...await page.evaluate(async () => {
    const { NexusStorage } = await import('/index.js');
    const checked = [];
    const equal = (actual, expected, label) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
      }
      checked.push(label);
    };
    const rejects = async (operation, label) => {
      try { await operation(); }
      catch (error) { equal(error.code, 'VALIDATION_ERROR', label); return; }
      throw new Error(`${label}: unexpectedly succeeded`);
    };
    const schema = validate => ({ '~standard': { version: 1, vendor: 'browser-review', validate } });
    const number = schema(value => typeof value === 'number' && Number.isFinite(value)
      ? { value } : { issues: [{ message: 'Expected stored number' }] });
    const length = schema(value => typeof value === 'string'
      ? { value: value.length } : { issues: [{ message: 'Expected input string' }] });
    const increment = schema(value => typeof value === 'number'
      ? { value: value + 1 } : { issues: [{ message: 'Expected number input' }] });
    for (const driver of ['memory', 'localStorage', 'sessionStorage', 'indexedDB', 'cacheStorage']) {
      let inputCalls = 0;
      let rejectStored = false;
      const profileInput = schema(value => {
        inputCalls++;
        return value && typeof value.name === 'string' && typeof value.visits === 'number'
          ? { value: { name: value.name + '!', visits: value.visits, settings: value.settings } }
          : { issues: [{ message: 'Expected input profile' }] };
      });
      const profileStored = schema(value => !rejectStored && value && typeof value.name === 'string'
        && Number.isInteger(value.visits) && value.visits >= 0 && value.settings && typeof value.settings === 'object'
        // Property order is irrelevant; returning an equivalent snapshot is allowed.
        ? { value: { settings: value.settings, visits: value.visits, name: value.name } }
        : { issues: [{ message: 'Expected stored profile' }] });
      const store = new NexusStorage({ driver, namespace: `review:schemas:${driver}`,
        schemas: { length, increment, profile: profileInput },
        storedSchemas: { length: number, increment: number, profile: profileStored } });
      const events = [];
      store.on('change', event => events.push(event));
      try {
        equal(await store.set('length', 'hello'), 5, `${driver}: string-only input converts to number`);
        equal(await store.get('length'), 5, `${driver}: read validates stored number without string conversion`);
        equal(await store.set('increment', 1), 2, `${driver}: increment conversion runs once`);
        equal(await store.get('increment'), 2, `${driver}: read does not increment again`);
        await store.set('profile', { name: 'Alex', visits: 1, settings: { theme: 'light', language: 'zh' } }, { ttl: 60_000 });
        const before = await store.getEntry('profile');
        equal(before.value.name, 'Alex!', `${driver}: object input conversion runs once`);
        equal(await store.update('profile', { visits: 2, settings: { theme: 'dark' } }),
          { name: 'Alex!', visits: 2, settings: { theme: 'dark' } }, `${driver}: output patch shallow merges without retransforming`);
        const updated = await store.getEntry('profile');
        equal(updated.expiresAt, before.expiresAt, `${driver}: transformed profile patch preserves deadline`);
        equal(inputCalls, 1, `${driver}: get and update never execute explicit input validator`);
        const eventCount = events.length;
        await rejects(() => store.update('profile', { visits: -1 }), `${driver}: stored validator rejects invalid output patch`);
        rejectStored = true;
        await rejects(() => store.get('profile'), `${driver}: stored validator rejects historical invalid data`);
        rejectStored = false;
        equal(await store.getEntry('profile'), updated, `${driver}: failed validation preserves value deadline and revision`);
        equal(events.length, eventCount, `${driver}: failed validation emits no changes`);
        if (driver === 'memory' || driver === 'indexedDB') {
          const swapped = await store.compareAndSwap('length', (await store.getEntry('length')).revision, 'xy');
          equal(swapped.value, 2, `${driver}: CAS converts string-only input once`);
          equal(await store.transaction(['length', 'increment', 'profile'], tx => {
            const existing = tx.get('length');
            tx.set('increment', 5);
            tx.update('profile', { visits: 3 });
            return [existing, tx.get('increment'), tx.get('profile').name];
          }), [2, 6, 'Alex!'], `${driver}: transaction validates stored reads and patch without reconversion`);
          equal(inputCalls, 1, `${driver}: transaction patch never invokes input transform`);
        }
      } finally { await store.clear(); await store.close(); }

      for (const [name, input, validator] of [['length', 'abc', length], ['increment', 1, increment]]) {
        const unsafe = new NexusStorage({ driver, namespace: `review:unsafe:${driver}:${name}`, schemas: { value: validator } });
        try {
          await rejects(() => unsafe.set('value', input), `${driver}: ${name} without storedSchemas fails before persistence`);
          equal(await unsafe.has('value'), false, `${driver}: unsafe ${name} output never persists`);
        } finally { await unsafe.clear(); await unsafe.close(); }
      }
      const mutating = new NexusStorage({ driver, namespace: `review:mutating:${driver}`,
        schemas: { value: number }, storedSchemas: { value: increment } });
      try {
        await rejects(() => mutating.set('value', 1), `${driver}: stored validator cannot alter values`);
        equal(await mutating.has('value'), false, `${driver}: altered stored validation result never persists`);
      } finally { await mutating.clear(); await mutating.close(); }
    }
    return checked;
  }));

  results.push(...await page.evaluate(async () => {
    const { NexusStorage } = await import('/index.js');
    const checked = [];
    const equal = (actual, expected, label) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
      checked.push(label);
    };
    const stores = [];
    const create = options => { const store = new NexusStorage(options); stores.push(store); return store; };
    try {
      const first = create({ driver: 'localStorage', namespace: 'review:local-events', broadcast: true });
      const second = create({ driver: 'localStorage', namespace: 'review:local-events', broadcast: true });
      const disabled = create({ driver: 'localStorage', namespace: 'review:local-events' });
      const other = create({ driver: 'localStorage', namespace: 'review:local-events:other', broadcast: true });
      const local = [], remote = [], isolated = [];
      first.on('change', event => local.push(event));
      disabled.on('change', event => isolated.push(event));
      other.on('change', event => isolated.push(event));
      const listener = event => remote.push(event);
      const stopFirst = second.on('change', listener);
      const stopSecond = second.on('change', listener);
      await first.set('item', 1);
      equal(local.map(event => event.source), ['local'], 'localStorage: sender receives one local notification');
      equal(remote.map(event => event.source), ['remote', 'remote'], 'localStorage: same-window repeated callback subscriptions are independent');
      stopFirst(); stopFirst();
      await first.set('item', 2);
      equal(remote.length, 3, 'localStorage: unsubscribing one repeated callback preserves the other');
      stopSecond();
      await first.set('item', 3);
      equal(remote.length, 3, 'localStorage: both handles remove exactly their own subscription');
      equal(isolated, [], 'localStorage: disabled broadcast and other namespace receive no same-window events');
      second.on('change', listener);
      await second.close();
      await first.set('item', 4);
      equal(remote.length, 3, 'localStorage: closed same-window receiver releases registration');
      for (const driver of ['memory', 'sessionStorage']) {
        const a = create({ driver, namespace: 'review:same-window-isolation' });
        const b = create({ driver, namespace: 'review:same-window-isolation' });
        const observed = [];
        b.on('change', event => observed.push(event));
        await a.set('item', 1);
        equal(observed, [], `${driver}: same-window instances retain notification isolation`);
      }
    } finally { await Promise.all(stores.map(store => store.close())); }
    return checked;
  }));

  await secondPage.evaluate(async () => {
    const { NexusStorage } = await import('/index.js');
    const stores = [0, 1].map(() => new NexusStorage({ driver: 'localStorage', namespace: 'review:cross-tab-events', broadcast: true }));
    const events = [];
    for (let index = 0; index < stores.length; index++) stores[index].on('change', async event => {
      events.push({ index, event, value: await stores[index].get('item') });
    });
    globalThis.__reviewEvents = { stores, events };
  });
  try {
    await page.evaluate(async () => {
      const { NexusStorage } = await import('/index.js');
      const store = new NexusStorage({ driver: 'localStorage', namespace: 'review:cross-tab-events', broadcast: true });
      try { await store.set('item', { committed: true }); } finally { await store.close(); }
    });
    await secondPage.waitForFunction(() => globalThis.__reviewEvents.events.length >= 2);
    await secondPage.waitForTimeout(100);
    const observed = await secondPage.evaluate(() => globalThis.__reviewEvents.events);
    assert.deepEqual(observed.map(item => item.index).sort(), [0, 1]);
    assert.ok(observed.every(item => item.event.source === 'remote' && !('value' in item.event)));
    assert.deepEqual(observed.map(item => item.value), [{ committed: true }, { committed: true }]);
    results.push('localStorage: each of two same-window cross-tab receivers receives exactly one notification');
    results.push('localStorage: cross-tab notifications contain metadata and expose committed reads');
  } finally {
    await secondPage.evaluate(async () => {
      await Promise.all(globalThis.__reviewEvents.stores.map(store => store.close()));
      delete globalThis.__reviewEvents;
    });
  }

  results.push(...await page.evaluate(async () => {
    const { NexusStorage } = await import('/index.js');
    const checked = [];
    const equal = (actual, expected, label) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
      checked.push(label);
    };
    const namespace = 'review:cache-scan';
    const store = new NexusStorage({ driver: 'cacheStorage', namespace });
    const peer = new NexusStorage({ driver: 'cacheStorage', namespace });
    const cache = await caches.open('nexusstorage:' + JSON.stringify(namespace));
    const originalKeys = Cache.prototype.keys;
    let fullEnumerations = 0;
    try {
      await store.clear();
      for (let index = 0; index < 24; index++) await store.set(`key${String(index).padStart(2, '0')}`, index);
      await store.set('expired', true, { ttl: 0 });
      Cache.prototype.keys = function (...args) {
        if (args[0] === undefined) fullEnumerations++;
        return originalKeys.apply(this, args);
      };
      equal((await store.keys()).length, 24, 'cacheStorage: scanned keys exclude expired records');
      equal(fullEnumerations, 1, 'cacheStorage: public keys performs one full enumeration for many records');
      await peer.set('from-peer', true);
      fullEnumerations = 0;
      equal((await store.keys()).includes('from-peer'), true, 'cacheStorage: scan sees a later write from another instance');
      equal(fullEnumerations, 1, 'cacheStorage: later scan enumerates once without a stale persistent index');
      fullEnumerations = 0;
      await store.clear();
      equal(fullEnumerations, 1, 'cacheStorage: clear performs one full enumeration for many records');
      equal((await cache.keys()).length, 0, 'cacheStorage: clear removes all canonical records including expired ones');
      await store.set('plain', { ok: true });
      await store.set('timed', { ok: true }, { ttl: 60_000 });
      const responses = {};
      for (const request of await cache.keys()) {
        const key = JSON.parse(decodeURIComponent(new URL(request.url).pathname.slice('/v1/'.length)));
        const response = await cache.match(request);
        responses[key] = { type: response.headers.get('content-type'), body: await response.text() };
      }
      equal(responses.plain.type, 'application/json; charset=utf-8', 'cacheStorage: ordinary JSON advertises JSON media type');
      equal(JSON.parse(responses.plain.body), { ok: true }, 'cacheStorage: ordinary JSON response parses directly');
      equal(responses.timed.type, 'application/x.nexusstorage-record; charset=utf-8', 'cacheStorage: TTL envelope advertises its record media type');
      equal(responses.timed.body.startsWith('NexusStorage/1\n'), true, 'cacheStorage: TTL media type describes prefixed envelope');
      equal(await peer.get('timed'), { ok: true }, 'cacheStorage: TTL envelope remains readable from another instance');
    } finally {
      Cache.prototype.keys = originalKeys;
      await store.clear(); await store.close(); await peer.close();
    }
    // Vary matching must not hide a foreign fragment alias from the ownership guard.
    const conflictNamespace = 'review:cache-vary-conflict';
    const conflictCache = await caches.open('nexusstorage:' + JSON.stringify(conflictNamespace));
    const foreign = new Request('https://nexusstorage.invalid/v1/%22collision%22#foreign', { headers: { 'x-lang': 'zh' } });
    await conflictCache.put(foreign, new Response('{"foreign":true}', { headers: { vary: 'x-lang' } }));
    const canonical = new Request('https://nexusstorage.invalid/v1/%22collision%22');
    equal((await conflictCache.keys(canonical)).length, 0, 'cacheStorage: native filtered keys hides a foreign Vary mismatch');
    equal((await conflictCache.keys(canonical, { ignoreVary: true })).map(request => request.url), [foreign.url],
      'cacheStorage: ignoreVary exposes the fragment alias for ownership checks');
    const protectedStore = new NexusStorage({ driver: 'cacheStorage', namespace: conflictNamespace });
    try {
      for (const [name, operation] of [
        ['get', () => protectedStore.get('collision')],
        ['set', () => protectedStore.set('collision', { overwritten: true })],
        ['update', () => protectedStore.update('collision', { overwritten: true })],
        ['remove', () => protectedStore.remove('collision')],
      ]) {
        let rejected = false;
        try { await operation(); }
        catch (error) { equal(error.code, 'CORRUPT_DATA', `cacheStorage: ${name} protects foreign fragment despite Vary mismatch`); rejected = true; }
        if (!rejected) throw new Error(`cacheStorage: ${name} ignored a foreign Vary/fragment alias`);
      }
      await protectedStore.clear();
      equal((await conflictCache.keys()).map(request => request.url), [foreign.url], 'cacheStorage: clear preserves foreign Vary/fragment request');
      equal(await (await conflictCache.match(foreign)).json(), { foreign: true }, 'cacheStorage: Vary/fragment foreign response remains unchanged');
    } finally { await protectedStore.close(); }
    return checked;
  }));
}

// Can run independently against an already built bundle to demonstrate red/green regressions.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bundle = await readFile(new URL('../dist/index.js', import.meta.url));
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': request.url === '/index.js' ? 'text/javascript' : 'text/html' });
    response.end(request.url === '/index.js' ? bundle : '<!doctype html><title>Review regression checks</title>');
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true, ...(process.env.NEXUSSTORAGE_BROWSER_EXECUTABLE
      ? { executablePath: process.env.NEXUSSTORAGE_BROWSER_EXECUTABLE } : {}) });
    const context = await browser.newContext();
    const page = await context.newPage();
    const secondPage = await context.newPage();
    const errors = [];
    for (const tab of [page, secondPage]) {
      tab.on('pageerror', error => errors.push(error.message));
      await tab.goto(`http://127.0.0.1:${server.address().port}`);
    }
    const results = [];
    await runReviewBrowserChecks({ page, secondPage, results });
    assert.deepEqual(errors, []);
    console.log(`Chromium ${browser.version()}: ${results.length} review browser checks passed.`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
