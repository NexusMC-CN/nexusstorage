import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { runSecondStageBrowserChecks } from './browser-second-stage.mjs';
import { legacyEventBundle, runFollowupBrowserChecks } from './browser/followup.mjs';

// A fresh browser context and a random loopback origin isolate all test data.
const bundle = await readFile(new URL('../dist/index.js', import.meta.url));
const legacyEvents = await legacyEventBundle();
const server = createServer((request, response) => {
  if (request.url === '/index.js') {
    response.writeHead(200, { 'content-type': 'text/javascript' });
    response.end(bundle);
  } else if (request.url === '/legacy-events.js') {
    response.writeHead(200, { 'content-type': 'text/javascript' });
    response.end(legacyEvents);
  } else if (request.url === '/storage-worker.js') {
    response.writeHead(200, { 'content-type': 'text/javascript' });
    response.end(`
      import { NexusStorage } from '/index.js';
      self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
      self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
      self.addEventListener('message', event => {
        event.waitUntil((async () => {
          const store = new NexusStorage({ driver: 'cacheStorage', namespace: 'worker-shared' });
          try {
            const fromPage = await store.get('from-page');
            await store.set('from-worker', { source: 'service-worker', ready: true });
            event.ports[0].postMessage({ fromPage, keys: await store.keys() });
          } catch (error) {
            event.ports[0].postMessage({ error: String(error) });
          } finally {
            await store.close();
          }
        })());
      });
    `);
  } else if (request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><html><title>NexusStorage verification</title></html>');
  } else {
    response.writeHead(404);
    response.end();
  }
});

let browser;
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.NEXUSSTORAGE_BROWSER_EXECUTABLE
      ? { executablePath: process.env.NEXUSSTORAGE_BROWSER_EXECUTABLE }
      : {}),
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  const results = await page.evaluate(async () => {
    const { NexusStorage } = await import('/index.js');
    const checked = [];
    const equal = (actual, expected, name) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${name}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
      }
      checked.push(name);
    };
    for (const driver of ['localStorage', 'sessionStorage', 'indexedDB', 'cacheStorage']) {
      const store = new NexusStorage({ driver, namespace: `browser:${driver}` });
      const other = new NexusStorage({ driver, namespace: `browser:${driver}:other` });
      equal(await store.get('missing'), undefined, `${driver}: missing`);
      const input = { name: 'Alex', preferences: { theme: 'light', language: 'zh' } };
      const pending = store.set('profile', input);
      input.name = 'mutated';
      equal(await pending, { name: 'Alex', preferences: { theme: 'light', language: 'zh' } }, `${driver}: snapshot`);
      equal(await store.update('profile', { preferences: { theme: 'dark' } }), {
        name: 'Alex', preferences: { theme: 'dark' },
      }, `${driver}: shallow update`);
      await store.set('null', null);
      equal(await store.get('null'), null, `${driver}: null`);
      equal(await store.has('null'), true, `${driver}: has`);
      try {
        await store.set('invalid', { value: undefined });
        throw new Error('Invalid JSON was accepted');
      } catch (error) {
        equal(error.code, 'INVALID_VALUE', `${driver}: invalid JSON`);
      }
      await other.set('keep', [1, true, null]);
      equal(await store.remove('null'), true, `${driver}: remove existing`);
      equal(await store.remove('null'), false, `${driver}: remove missing`);
      await store.clear();
      equal(await store.keys(), [], `${driver}: clear`);
      equal(await other.get('keep'), [1, true, null], `${driver}: namespace isolation`);
      await store.set('reload', { persisted: true });
      await store.close();
      await other.close();
    }
    localStorage.setItem('unrelated', 'preserved');
    const isolated = new NexusStorage();
    await isolated.set('item', 1);
    await isolated.clear();
    equal(localStorage.getItem('unrelated'), 'preserved', 'localStorage: unrelated data');
    await isolated.close();

    // Native Cache matching ignores fragments even though keys() preserves them.
    const foreignCache = await caches.open('nexusstorage:' + JSON.stringify('foreign-fragment'));
    const foreignURL = 'https://nexusstorage.invalid/v1/%22a%22#external';
    await foreignCache.put(foreignURL, new Response('{"external":true}'));
    const protectedStore = new NexusStorage({ driver: 'cacheStorage', namespace: 'foreign-fragment' });
    try {
      const operations = [
        ['get', () => protectedStore.get('a')],
        ['set', () => protectedStore.set('a', { replaced: true })],
        ['update', () => protectedStore.update('a', { replaced: true })],
        ['remove', () => protectedStore.remove('a')],
      ];
      for (const [name, operation] of operations) {
        let rejected = false;
        try { await operation(); }
        catch (error) {
          equal(error.code, 'CORRUPT_DATA', `cacheStorage: ${name} rejects fragment aliases`);
          rejected = true;
        }
        if (!rejected) throw new Error(`cacheStorage: ${name} accessed a foreign fragment alias`);
      }
      await protectedStore.set('owned', { owned: true });
      await protectedStore.clear();
      equal(await protectedStore.keys(), [], 'cacheStorage: clear removes only canonical records');
      equal((await foreignCache.keys()).map(request => request.url), [foreignURL], 'cacheStorage: clear preserves fragment resource');
      equal(await (await foreignCache.match(foreignURL)).json(), { external: true }, 'cacheStorage: foreign response remains unchanged');
    } finally { await protectedStore.close(); }
    return checked;
  });

  results.push(...await page.evaluate(async () => {
    const { NexusStorage } = await import('/index.js');
    const checked = [];
    const equal = (actual, expected, name) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${name}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
      }
      checked.push(name);
    };
    const rejects = async (operation, code, name) => {
      try { await operation(); }
      catch (error) {
        equal(error.code, code, name);
        return;
      }
      throw new Error(`${name}: operation unexpectedly succeeded`);
    };
    const originalNow = Date.now;
    const stores = [];
    let now = originalNow();
    // Keep clock control inside this page evaluation, before any Worker is installed.
    Date.now = () => now;
    try {
      for (const driver of ['memory', 'localStorage', 'sessionStorage', 'indexedDB', 'cacheStorage']) {
        const store = new NexusStorage({ driver, namespace: `features:${driver}:ttl` });
        stores.push(store);
        await store.set('draft', { title: 'Hello' }, { ttl: 100 });
        await store.set('keep', null);
        now += 99;
        equal(await store.get('draft'), { title: 'Hello' }, `${driver}: get before deadline`);
        equal(await store.has('draft'), true, `${driver}: has before deadline`);
        equal(await store.keys(), ['draft', 'keep'], `${driver}: keys before deadline`);
        now++;
        equal(await store.get('draft'), undefined, `${driver}: get at deadline`);
        equal(await store.has('draft'), false, `${driver}: has at deadline`);
        equal(await store.keys(), ['keep'], `${driver}: keys at deadline`);
        await rejects(() => store.update('draft', { title: 'Late' }), 'NOT_FOUND', `${driver}: expired update`);
        equal(await store.remove('draft'), true, `${driver}: expired record remains physically removable`);
        equal(await store.remove('draft'), false, `${driver}: expired record removed once`);
        await store.set('zero', 1, { ttl: 0 });
        equal(await store.get('zero'), undefined, `${driver}: zero TTL`);
        await store.set('absolute', 1, { expiresAt: now });
        equal(await store.has('absolute'), false, `${driver}: absolute deadline`);

        await store.set('preserved', { a: 1 }, { ttl: 100 });
        now += 50;
        await store.update('preserved', { b: 2 });
        now += 49;
        equal(await store.get('preserved'), { a: 1, b: 2 }, `${driver}: update preserves value before expiry`);
        now++;
        equal(await store.get('preserved'), undefined, `${driver}: update preserves original deadline`);

        await store.set('reset', { a: 1 }, { ttl: 100 });
        now += 50;
        await store.update('reset', { b: 2 }, { ttl: 200 });
        now += 50;
        equal(await store.get('reset'), { a: 1, b: 2 }, `${driver}: explicit TTL extends original deadline`);
        now += 149;
        equal(await store.has('reset'), true, `${driver}: reset TTL before deadline`);
        now++;
        equal(await store.get('reset'), undefined, `${driver}: reset TTL exact deadline`);

        await store.set('reset-absolute', { a: 1 }, { ttl: 100 });
        now += 50;
        const absoluteDeadline = now + 300;
        await store.update('reset-absolute', { b: 2 }, { expiresAt: absoluteDeadline });
        now += 50;
        equal(await store.get('reset-absolute'), { a: 1, b: 2 }, `${driver}: explicit absolute deadline extends expiry`);
        now = absoluteDeadline;
        equal(await store.get('reset-absolute'), undefined, `${driver}: reset absolute deadline`);
        await store.set('replaced', 1, { ttl: 10 });
        await store.set('replaced', 2);
        now += 10;
        equal(await store.get('replaced'), 2, `${driver}: replacement without options clears expiry`);

        let rejectReads = false;
        const profileSchema = { '~standard': {
          version: 1,
          vendor: 'browser-smoke',
          validate(value) {
            if (!rejectReads && value && typeof value.name === 'string'
              && typeof value.score === 'number' && value.score >= 0) {
              return { value: { name: value.name.trim(), score: value.score } };
            }
            return { issues: [{ message: 'Expected a valid profile' }] };
          },
        } };
        const schemaStore = new NexusStorage({ driver, namespace: `features:${driver}:schema`, schemas: {
          profile: profileSchema,
          deferred: { '~standard': {
            version: 1,
            vendor: 'browser-smoke',
            validate: async () => { throw new Error('Rejected asynchronous schema'); },
          } },
        } });
        stores.push(schemaStore);
        equal(await schemaStore.set('profile', { name: ' Alex ', score: 2 }),
          { name: 'Alex', score: 2 }, `${driver}: schema transforms write`);
        equal(await schemaStore.update('profile', { score: 3 }),
          { name: 'Alex', score: 3 }, `${driver}: schema validates full merged update`);
        await rejects(() => schemaStore.set('profile', { name: 'Broken', score: -1 }),
          'VALIDATION_ERROR', `${driver}: schema rejects invalid replacement`);
        equal(await schemaStore.get('profile'), { name: 'Alex', score: 3 }, `${driver}: rejected write preserves value`);
        await rejects(() => schemaStore.update('profile', { score: -1 }),
          'VALIDATION_ERROR', `${driver}: schema rejects invalid update`);
        equal(await schemaStore.get('profile'), { name: 'Alex', score: 3 }, `${driver}: rejected update preserves value`);
        rejectReads = true;
        await rejects(() => schemaStore.get('profile'), 'VALIDATION_ERROR', `${driver}: schema validates reads`);
        rejectReads = false;
        equal(await schemaStore.get('profile'), { name: 'Alex', score: 3 }, `${driver}: rejected read preserves value`);
        await rejects(() => schemaStore.set('deferred', {}), 'ASYNC_SCHEMA', `${driver}: asynchronous schema rejection`);
        equal(await schemaStore.has('deferred'), false, `${driver}: asynchronous schema never persists`);
        equal(await schemaStore.keys(), ['profile'], `${driver}: failed schema writes leave keys unchanged`);
      }
      // Let native Promise rejection reporting run before asserting the clean page error log.
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally {
      Date.now = originalNow;
      await Promise.all(stores.map(store => store.close()));
    }

    const first = new NexusStorage({ driver: 'memory', namespace: 'browser:memory-reload' });
    const second = new NexusStorage({ driver: 'memory', namespace: 'browser:memory-reload' });
    try {
      await first.set('reload', { transient: true });
      equal(await second.get('reload'), undefined, 'memory: same namespace instances are isolated');
      await second.set('reload', { ownInstance: true });
      equal(await first.get('reload'), { transient: true }, 'memory: another instance cannot overwrite data');
      equal(await first.keys(), ['reload'], 'memory: original instance retains its keys');
      // Keep the first instance alive until navigation, so reload checks page lifetime.
      globalThis.__nexusMemoryBeforeReload = first;
    } finally { await second.close(); }
    return checked;
  }));

  await page.reload();
  await page.evaluate(async () => {
    const { NexusStorage } = await import('/index.js');
    for (const driver of ['localStorage', 'sessionStorage', 'indexedDB', 'cacheStorage']) {
      const store = new NexusStorage({ driver, namespace: `browser:${driver}` });
      if ((await store.get('reload'))?.persisted !== true) throw new Error(`${driver} reload persistence failed`);
      await store.close();
    }
  });
  results.push('four drivers: persistence after reload');
  await page.evaluate(async () => {
    const { NexusStorage } = await import('/index.js');
    if (globalThis.__nexusMemoryBeforeReload !== undefined) throw new Error('The previous page realm survived reload');
    const store = new NexusStorage({ driver: 'memory', namespace: 'browser:memory-reload' });
    try {
      if (await store.get('reload') !== undefined) throw new Error('Memory data persisted after reload');
      if ((await store.keys()).length !== 0) throw new Error('Memory keys persisted after reload');
    } finally { await store.close(); }
  });
  results.push('memory: records and keys are empty after page reload');

  // Two pages use distinct instances on the same database and race patches.
  const secondPage = await context.newPage();
  secondPage.on('pageerror', error => errors.push(error.message));
  await secondPage.goto(origin);
  await secondPage.evaluate(async () => {
    const { NexusStorage } = await import('/index.js');
    const session = new NexusStorage({ driver: 'sessionStorage', namespace: 'browser:sessionStorage' });
    const cache = new NexusStorage({ driver: 'cacheStorage', namespace: 'browser:cacheStorage' });
    try {
      if (await session.get('reload') !== undefined) throw new Error('sessionStorage leaked into an independent tab');
      await session.set('reload', { ownTab: true });
      if ((await cache.get('reload'))?.persisted !== true) throw new Error('Cache Storage did not share across tabs');
    } finally {
      await session.close();
      await cache.close();
    }
  });
  await page.evaluate(async () => {
    const { NexusStorage } = await import('/index.js');
    const session = new NexusStorage({ driver: 'sessionStorage', namespace: 'browser:sessionStorage' });
    try {
      if ((await session.get('reload'))?.persisted !== true) throw new Error('Another tab overwrote the first session');
    } finally { await session.close(); }
  });
  results.push('sessionStorage: independent tabs remain isolated');
  results.push('cacheStorage: shared across independent tabs');
  const sharedDeadline = await page.evaluate(async () => {
    const { NexusStorage } = await import('/index.js');
    const store = new NexusStorage({ driver: 'indexedDB', namespace: 'concurrent' });
    const originalNow = Date.now;
    const now = originalNow();
    Date.now = () => now;
    try {
      await store.set('shared', {}, { ttl: 60000 });
      return now + 60000;
    } finally {
      Date.now = originalNow;
      await store.close();
    }
  });
  const validationCounts = await Promise.all([page, secondPage].map((tab, index) => tab.evaluate(async (side) => {
    const { NexusStorage } = await import('/index.js');
    let validationCount = 0;
    const schema = { '~standard': {
      version: 1,
      vendor: 'browser-smoke',
      validate(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)
          || Object.entries(value).some(([key, item]) => !/^[01]:(?:[0-9]|1[01])$/.test(key)
            || !Number.isInteger(item) || Number(key.split(':')[1]) !== item)) {
          return { issues: [{ message: 'Expected concurrent patch entries' }] };
        }
        validationCount++;
        return { value };
      },
    } };
    const stores = Array.from({ length: 12 }, () => new NexusStorage({
      driver: 'indexedDB', namespace: 'concurrent', schemas: { shared: schema },
    }));
    try {
      await Promise.all(stores.map((store, id) => store.update('shared', { [`${side}:${id}`]: id })));
      return validationCount;
    } finally {
      await Promise.all(stores.map(store => store.close()));
    }
  }, index)));
  assert.deepEqual(validationCounts, [12, 12]);
  const final = await page.evaluate(async (deadline) => {
    const { NexusStorage } = await import('/index.js');
    const store = new NexusStorage({ driver: 'indexedDB', namespace: 'concurrent' });
    const originalNow = Date.now;
    try {
      Date.now = () => deadline - 1;
      const value = await store.get('shared');
      if (!value) throw new Error('Concurrent patches changed the original deadline');
      Date.now = () => deadline;
      if (await store.get('shared') !== undefined || await store.has('shared') || (await store.keys()).length !== 0) {
        throw new Error('Concurrent patches lost the original TTL metadata');
      }
      return value;
    } finally {
      Date.now = originalNow;
      await store.close();
    }
  }, sharedDeadline);
  for (let side = 0; side < 2; side++) {
    for (let id = 0; id < 12; id++) assert.equal(final[`${side}:${id}`], id);
  }
  results.push('indexedDB: 24 concurrent patches across two tabs');
  results.push('indexedDB: synchronous schema validates all 24 concurrent patches');
  results.push('indexedDB: original deadline survives all concurrent patches');

  const workerResult = await page.evaluate(async () => {
    const { NexusStorage } = await import('/index.js');
    const store = new NexusStorage({ driver: 'cacheStorage', namespace: 'worker-shared' });
    try {
      await store.set('from-page', { source: 'page', value: [1, null, true] }, { ttl: 60000 });
      const registration = await navigator.serviceWorker.register('/storage-worker.js', { type: 'module' });
      await navigator.serviceWorker.ready;
      const active = registration.active;
      if (!active) throw new Error('Service Worker failed to activate');
      const received = await new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => {
          channel.port1.close();
          reject(new Error('Service Worker response timed out'));
        }, 10000);
        channel.port1.onmessage = event => {
          clearTimeout(timer);
          channel.port1.close();
          if (event.data.error) reject(new Error(event.data.error));
          else resolve(event.data);
        };
        active.postMessage({ action: 'verify' }, [channel.port2]);
      });
      const fromWorker = await store.get('from-worker');
      await registration.unregister();
      return { received, fromWorker };
    } finally { await store.close(); }
  });
  assert.deepEqual(workerResult.received.fromPage, { source: 'page', value: [1, null, true] });
  assert.deepEqual(workerResult.fromWorker, { source: 'service-worker', ready: true });
  assert.deepEqual(workerResult.received.keys, ['from-page', 'from-worker']);
  results.push('cacheStorage: page JSON read from a real Service Worker');
  results.push('cacheStorage: Service Worker JSON read from the page');
  const originalChecks = results.length;
  assert.equal(originalChecks, 210, 'All existing browser checks must remain enabled');
  await runSecondStageBrowserChecks({ page, secondPage, results });
  const existingChecks = results.length;
  assert.equal(existingChecks, 312, 'All previous stages must remain enabled');
  await (await import('./browser-review.mjs')).runReviewBrowserChecks({ page, secondPage, results });
  const reviewChecks = results.length;
  assert.equal(reviewChecks, 437, 'All 437 previous browser checks must remain enabled');
  await runFollowupBrowserChecks({ page, secondPage, results });
  assert.deepEqual(errors, []);
  console.log(`Chromium ${browser.version()}: ${results.length} browser checks passed (${reviewChecks} existing, ${results.length - reviewChecks} followup regressions).`);
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
