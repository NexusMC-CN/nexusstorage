import assert from 'node:assert/strict';

/** Real browser integration checks, reusing the smoke runner's isolated origin and tabs. */
export async function runSecondStageBrowserChecks({ page, secondPage, results }) {
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
      catch (error) { equal(error.code, code, name); return; }
      throw new Error(`${name}: unexpectedly succeeded`);
    };
    for (const driver of ['memory', 'localStorage', 'sessionStorage', 'indexedDB', 'cacheStorage']) {
      const store = new NexusStorage({ driver, namespace: `stage:capabilities:${driver}` });
      try {
        const atomic = driver === 'memory' || driver === 'indexedDB';
        equal(store.capabilities.transactions, atomic, `${driver}: declared transaction capability`);
        equal(store.capabilities.compareAndSwap, atomic, `${driver}: declared CAS capability`);
        equal(store.capabilities.atomicity, driver === 'memory' ? 'instance' : driver === 'indexedDB' ? 'database' : 'none',
          `${driver}: declared atomicity scope`);
        equal(Object.isFrozen(store.capabilities), true, `${driver}: capabilities are frozen`);
        if (!atomic) {
          await rejects(() => store.transaction(['key'], () => {}), 'UNSUPPORTED_OPERATION', `${driver}: refuses synthetic transaction`);
          await rejects(() => store.compareAndSwap('key', null, 1), 'UNSUPPORTED_OPERATION', `${driver}: refuses synthetic CAS`);
          equal(await store.get('key'), undefined, `${driver}: unsupported operations never write`);
        }
        if (driver === 'memory' || driver === 'sessionStorage') {
          await rejects(() => new NexusStorage({ driver, broadcast: true }), 'INVALID_OPTIONS', `${driver}: refuses cross-tab broadcast`);
        }
      } finally { await store.close(); }
    }
    return checked;
  }));

  // Both pages finish reading the same revision before either attempts its CAS.
  const revision = await page.evaluate(async () => {
    const { NexusStorage } = await import('/index.js');
    const store = new NexusStorage({ driver: 'indexedDB', namespace: 'stage:cas' });
    await store.set('winner', { side: 'seed' });
    globalThis.__stageCAS = { store, events: [] };
    store.on('change', event => globalThis.__stageCAS.events.push(event));
    return (await store.getEntry('winner')).revision;
  });
  await secondPage.evaluate(async expected => {
    const { NexusStorage } = await import('/index.js');
    const store = new NexusStorage({ driver: 'indexedDB', namespace: 'stage:cas' });
    const current = await store.getEntry('winner');
    if (current.revision !== expected) throw new Error('Second tab did not read the shared initial revision');
    globalThis.__stageCAS = { store, events: [] };
    store.on('change', event => globalThis.__stageCAS.events.push(event));
  }, revision);
  try {
    const attempts = await Promise.all([page, secondPage].map((tab, side) => tab.evaluate(async ({ expected, side }) => {
      const state = globalThis.__stageCAS;
      try {
        const entry = await state.store.compareAndSwap('winner', expected, { side });
        return { success: true, entry, eventCount: state.events.length };
      } catch (error) {
        return { success: false, code: error.code, eventCount: state.events.length };
      }
    }, { expected: revision, side })));
    const winner = attempts.find(attempt => attempt.success);
    const loser = attempts.find(attempt => !attempt.success);
    assert.equal(attempts.filter(attempt => attempt.success).length, 1);
    assert.equal(loser.code, 'CONFLICT');
    assert.equal(winner.eventCount, 1);
    assert.equal(loser.eventCount, 0);
    assert.notEqual(winner.entry.revision, revision);
    const committed = await Promise.all([page, secondPage].map(tab => tab.evaluate(async () =>
      globalThis.__stageCAS.store.getEntry('winner'))));
    assert.deepEqual(committed, [winner.entry, winner.entry]);
    results.push('indexedDB: two tabs racing one revision produce exactly one CAS winner');
    results.push('indexedDB: CAS loser neither overwrites winner nor emits change');
    results.push('indexedDB: both tabs read the same committed CAS value and new revision');
  } finally {
    await Promise.all([page, secondPage].map(tab => tab.evaluate(async () => {
      await globalThis.__stageCAS.store.close();
      delete globalThis.__stageCAS;
    })));
  }

  await page.evaluate(async () => {
    const { NexusStorage } = await import('/index.js');
    const store = new NexusStorage({ driver: 'indexedDB', namespace: 'stage:transfers' });
    try {
      await store.transaction(['a', 'b'], tx => {
        tx.set('a', { account: 'a', balance: 100 });
        tx.set('b', { account: 'b', balance: 100 });
      });
    } finally { await store.close(); }
  });
  await Promise.all([page, secondPage].map((tab, side) => tab.evaluate(async side => {
    const { NexusStorage } = await import('/index.js');
    const store = new NexusStorage({ driver: 'indexedDB', namespace: 'stage:transfers' });
    const [from, to] = side === 0 ? ['a', 'b'] : ['b', 'a'];
    try {
      await Promise.all(Array.from({ length: 40 }, () => store.transaction(['a', 'b'], tx => {
        const debit = tx.get(from);
        const credit = tx.get(to);
        if (debit.balance < 1 || debit.balance + credit.balance !== 200) throw new Error('Transfer observed a partial commit');
        tx.update(from, { balance: debit.balance - 1 });
        tx.set(to, { ...credit, balance: credit.balance + 1 });
        if (tx.get(from).balance + tx.get(to).balance !== 200) throw new Error('Staged transfer lost money');
      })));
    } finally { await store.close(); }
  }, side)));
  const accounts = await page.evaluate(async () => {
    const { NexusStorage } = await import('/index.js');
    const store = new NexusStorage({ driver: 'indexedDB', namespace: 'stage:transfers' });
    try { return [await store.get('a'), await store.get('b')]; }
    finally { await store.close(); }
  });
  assert.deepEqual(accounts, [{ account: 'a', balance: 100 }, { account: 'b', balance: 100 }]);
  results.push('indexedDB: 80 opposing transactions across tabs preserve both accounts and total money');

  // Subscribe remotely after seeding, then use a successful sentinel to confirm delivery.
  await page.evaluate(async () => {
    const { NexusStorage } = await import('/index.js');
    const schema = { '~standard': {
      version: 1, vendor: 'browser-transaction',
      validate(value) {
        return value && typeof value.balance === 'number' && value.balance >= 0
          ? { value } : { issues: [{ message: 'Balance must be nonnegative' }] };
      },
    } };
    globalThis.__stageRollback = [];
    for (const driver of ['memory', 'indexedDB']) {
      const store = new NexusStorage({ driver, namespace: `stage:rollback:${driver}`,
        schemas: { a: schema, b: schema }, ...(driver === 'indexedDB' ? { broadcast: true } : {}) });
      await store.set('a', { balance: 100 });
      await store.set('b', { balance: 100 });
      const state = { driver, store, before: [await store.getEntry('a'), await store.getEntry('b')], events: [] };
      for (const type of ['change', 'remove', 'clear']) store.on(type, event => state.events.push(event));
      globalThis.__stageRollback.push(state);
    }
  });
  await secondPage.evaluate(async () => {
    const { NexusStorage } = await import('/index.js');
    const store = new NexusStorage({ driver: 'indexedDB', namespace: 'stage:rollback:indexedDB', broadcast: true });
    const state = { store, events: [], resolve: undefined };
    for (const type of ['change', 'remove', 'clear']) store.on(type, event => {
      state.events.push(event);
      if (event.operation === 'set' && event.key === 'a') state.resolve?.();
    });
    globalThis.__stageRollbackRemote = state;
  });
  try {
    results.push(...await page.evaluate(async () => {
      const checked = [];
      const equal = (actual, expected, name) => {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${name}: unexpected value`);
        checked.push(name);
      };
      for (const state of globalThis.__stageRollback) {
        const { driver, store, before, events } = state;
        for (const failure of ['schema', 'async']) {
          let caught;
          try {
            if (failure === 'schema') {
              await store.transaction(['a', 'b'], tx => { tx.update('a', { balance: 90 }); tx.set('b', { balance: -1 }); });
            } else {
              await store.transaction(['a', 'b'], async tx => {
                tx.update('a', { balance: 90 });
                tx.update('b', { balance: 110 });
                await Promise.resolve();
                let inactive;
                try { tx.get('a'); } catch (error) { inactive = error.code; }
                state.continuationCode = inactive;
                throw new Error('Rejected callback Promise must be observed');
              });
            }
          } catch (error) { caught = error.code; }
          equal(caught, failure === 'schema' ? 'VALIDATION_ERROR' : 'ASYNC_TRANSACTION', `${driver}: ${failure} transaction rejects`);
          equal([await store.getEntry('a'), await store.getEntry('b')], before, `${driver}: ${failure} rollback preserves values and revisions`);
          equal(events, [], `${driver}: ${failure} rollback emits no local event`);
          if (failure === 'async') equal(state.continuationCode, 'TRANSACTION_INACTIVE', `${driver}: async continuation cannot reuse its transaction`);
        }
      }
      await new Promise(resolve => setTimeout(resolve, 0));
      return checked;
    }));
    const remoteReady = secondPage.evaluate(async () => {
      const state = globalThis.__stageRollbackRemote;
      if (state.events.length === 0) await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Rollback sentinel broadcast timed out')), 5000);
        state.resolve = () => { clearTimeout(timer); resolve(); };
      });
      return { events: state.events, value: await state.store.get('a') };
    });
    await page.evaluate(async () => globalThis.__stageRollback.find(state => state.driver === 'indexedDB').store.set('a', { balance: 101 }));
    const remote = await remoteReady;
    assert.equal(remote.events.length, 1);
    assert.equal(remote.events[0].source, 'remote');
    assert.deepEqual(remote.value, { balance: 101 });
    results.push('indexedDB: failed schema and async transactions emit no remote events before committed sentinel');
  } finally {
    await Promise.all([
      page.evaluate(async () => { await Promise.all(globalThis.__stageRollback.map(state => state.store.close())); delete globalThis.__stageRollback; }),
      secondPage.evaluate(async () => { await globalThis.__stageRollbackRemote.store.close(); delete globalThis.__stageRollbackRemote; }),
    ]);
  }

  results.push(...await page.evaluate(async () => {
    const { NexusStorage } = await import('/index.js');
    const checked = [];
    const equal = (actual, expected, name) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${name}: unexpected value`);
      checked.push(name);
    };
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    try {
      for (const driver of ['memory', 'indexedDB']) {
        const store = new NexusStorage({ driver, namespace: `stage:transaction-ttl:${driver}` });
        try {
          const deadline = now + 100;
          await store.transaction(['a', 'b'], tx => {
            tx.set('a', { count: 1 }, { ttl: 100 });
            tx.set('b', { count: 2 }, { ttl: 100 });
          });
          equal((await store.getEntry('a')).expiresAt, deadline, `${driver}: transaction set records TTL`);
          now += 40;
          await store.transaction(['a', 'b'], tx => {
            tx.update('a', { count: 3 });
            tx.update('b', { count: 4 }, { ttl: null });
          });
          const current = await store.getEntry('a');
          equal(current.expiresAt, deadline, `${driver}: transaction update preserves deadline`);
          equal((await store.getEntry('b')).expiresAt, undefined, `${driver}: transaction ttl null clears deadline`);
          now = deadline;
          equal(await store.getEntry('a'), undefined, `${driver}: transaction TTL expires at exact deadline`);
          const renewed = await store.compareAndSwap('a', null, { count: 5 }, { ttl: 100 });
          equal(renewed.expiresAt, now + 100, `${driver}: CAS null replaces expired record with new TTL`);
          const permanent = await store.compareAndSwap('a', renewed.revision, { count: 6 }, { ttl: null });
          equal(permanent.expiresAt, undefined, `${driver}: CAS ttl null clears deadline`);
          equal(permanent.revision !== renewed.revision, true, `${driver}: CAS replacement receives a fresh revision`);
          now += 1000;
          equal([await store.get('a'), await store.get('b')], [{ count: 6 }, { count: 4 }], `${driver}: cleared deadlines remain readable later`);
        } finally { await store.close(); }
      }
    } finally { Date.now = originalNow; }
    return checked;
  }));

  for (const driver of ['localStorage', 'indexedDB', 'cacheStorage']) {
    const namespace = `stage:broadcast:${driver}`;
    await secondPage.evaluate(async ({ driver, namespace }) => {
      const { NexusStorage } = await import('/index.js');
      const store = new NexusStorage({ driver, namespace, broadcast: true });
      const state = { store, namespace, received: [], ready: [], waiters: [], unsubscribers: [], cancelled: 0, closed: 0 };
      const publish = value => {
        const waiter = state.waiters.shift();
        if (waiter) waiter(value); else state.ready.push(value);
      };
      const listen = (receiver, label) => ['change', 'remove', 'clear'].map(type => receiver.on(type, async event => {
        try {
          const value = await receiver.get('item');
          const nativeAfterRead = driver === 'localStorage' ? localStorage.getItem(`nexusstorage:${JSON.stringify(namespace)}:item`) : undefined;
          const observation = { event, value, keys: await receiver.keys(), nativeAfterRead };
          if (label === 'main') state.received.push(observation);
          publish({ label, observation });
        } catch (error) { publish({ label, error: String(error) }); }
      }));
      state.unsubscribers = listen(store, 'main');
      const unsubscribe = store.on('change', () => { state.cancelled++; });
      unsubscribe();
      unsubscribe();
      state.next = () => {
        if (state.ready.length > 0) return Promise.resolve(state.ready.shift());
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`${driver} event delivery timed out`)), 5000);
          state.waiters.push(value => { clearTimeout(timer); resolve(value); });
        });
      };
      state.installWitness = () => {
        state.witness = new NexusStorage({ driver, namespace, broadcast: true });
        listen(state.witness, 'witness');
      };
      globalThis.__stageBroadcast = state;
    }, { driver, namespace });
    await page.evaluate(async ({ driver, namespace }) => {
      const { NexusStorage } = await import('/index.js');
      const store = new NexusStorage({ driver, namespace, broadcast: true });
      const state = { store, events: [] };
      for (const type of ['change', 'remove', 'clear']) store.on(type, event => state.events.push(event));
      globalThis.__stageBroadcastWriter = state;
    }, { driver, namespace });
    let eventCount = 0;
    const action = async (operation, expectedValue, callback, expectedKeys = ['item'], label = 'main', recordCheck = true) => {
      const next = secondPage.evaluate(async () => globalThis.__stageBroadcast.next());
      const [received] = await Promise.all([next, page.evaluate(callback)]);
      assert.equal(received.error, undefined);
      assert.equal(received.label, label);
      const type = operation === 'remove' || operation === 'clear' ? operation : 'change';
      assert.deepEqual(received.observation.event, {
        type, operation, ...(type === 'clear' ? {} : { key: 'item' }), driver, namespace, source: 'remote',
      });
      assert.deepEqual(received.observation.value, expectedValue,
        `${driver}: ${operation} listener must read the committed value (native snapshot: ${received.observation.nativeAfterRead})`);
      assert.deepEqual(received.observation.keys, expectedKeys, `${driver}: ${operation} listener must read committed keys`);
      if (label === 'main') eventCount++;
      if (recordCheck) results.push(`${driver}: remote ${operation} event contains only metadata and reads committed storage`);
    };
    try {
      await action('set', { secret: 'value stays in storage', balance: 7 }, async () =>
        globalThis.__stageBroadcastWriter.store.set('item', { secret: 'value stays in storage', balance: 7 }));
      if (driver === 'indexedDB') {
        await action('compareAndSwap', { secret: 'value stays in storage', balance: 8 }, async () => {
          const store = globalThis.__stageBroadcastWriter.store;
          const entry = await store.getEntry('item');
          await store.compareAndSwap('item', entry.revision, { secret: 'value stays in storage', balance: 8 });
        });
        await action('update', { secret: 'value stays in storage', balance: 10 }, async () =>
          globalThis.__stageBroadcastWriter.store.transaction(['item'], tx => {
            tx.update('item', { balance: 9 });
            tx.update('item', { balance: 10 });
          }));
        results.push('indexedDB: transaction coalesces two changes into one remote event after commit');
      } else {
        await action('update', { secret: 'value stays in storage', balance: 8 }, async () =>
          globalThis.__stageBroadcastWriter.store.update('item', { balance: 8 }));
      }
      await action('remove', undefined, async () => globalThis.__stageBroadcastWriter.store.remove('item'), []);
      await action('set', { readyForClear: true }, async () => globalThis.__stageBroadcastWriter.store.set('item', { readyForClear: true }));
      await action('clear', undefined, async () => globalThis.__stageBroadcastWriter.store.clear(), []);
      if (driver === 'localStorage') {
        await page.evaluate(() => { globalThis.__stageBroadcastWriter.orderIndex = 0; });
        for (let index = 0; index < 200; index++) {
          const clearing = index % 3 === 2;
          await action(clearing ? 'clear' : 'set', clearing ? undefined : { order: index }, async () => {
            const state = globalThis.__stageBroadcastWriter;
            const current = state.orderIndex++;
            if (current % 3 === 2) await state.store.clear();
            else await state.store.set('item', { order: current });
          }, clearing ? [] : ['item'], 'main', false);
        }
        results.push('localStorage: 200 consecutive set/clear notifications immediately expose committed native values');
      }
      const local = await page.evaluate(() => globalThis.__stageBroadcastWriter.events);
      assert.equal(local.length, eventCount);
      assert.ok(local.every(event => event.source === 'local'));
      results.push(`${driver}: remote delivery does not echo events back to the writer`);
      await secondPage.evaluate(() => {
        const state = globalThis.__stageBroadcast;
        state.unsubscribers.forEach(unsubscribe => unsubscribe());
        state.installWitness();
      });
      await action('set', { unsubscribed: true }, async () => globalThis.__stageBroadcastWriter.store.set('item', { unsubscribed: true }), ['item'], 'witness');
      const afterUnsubscribe = await secondPage.evaluate(() => ({ received: globalThis.__stageBroadcast.received.length, cancelled: globalThis.__stageBroadcast.cancelled }));
      assert.deepEqual(afterUnsubscribe, { received: eventCount, cancelled: 0 });
      results.push(`${driver}: cancelled subscriptions remain silent while a live witness receives the same broadcast`);
      await secondPage.evaluate(async () => {
        const state = globalThis.__stageBroadcast;
        state.store.on('change', () => { state.closed++; });
        await state.store.close();
      });
      await action('set', { afterClose: true }, async () => globalThis.__stageBroadcastWriter.store.set('item', { afterClose: true }), ['item'], 'witness');
      const afterClose = await secondPage.evaluate(() => ({ received: globalThis.__stageBroadcast.received.length, closed: globalThis.__stageBroadcast.closed }));
      assert.deepEqual(afterClose, { received: eventCount, closed: 0 });
      results.push(`${driver}: closing the receiver clears listeners while another receiver stays active`);
    } finally {
      await Promise.all([
        page.evaluate(async () => { await globalThis.__stageBroadcastWriter.store.close(); delete globalThis.__stageBroadcastWriter; }),
        secondPage.evaluate(async () => {
          const state = globalThis.__stageBroadcast;
          await state.store.close();
          await state.witness?.close();
          delete globalThis.__stageBroadcast;
        }),
      ]);
    }
  }

  await secondPage.evaluate(async () => {
    const { NexusStorage } = await import('/index.js');
    const state = { stores: [], observations: [], resolved: new Map(), waiting: new Map() };
    for (const driver of ['localStorage', 'indexedDB', 'cacheStorage', 'memory', 'sessionStorage']) {
      const supported = driver !== 'memory' && driver !== 'sessionStorage';
      const configurations = supported ? [
        { label: driver, namespace: 'stage:isolation', broadcast: true },
        { label: `${driver}:namespace`, namespace: 'stage:isolation:other', broadcast: true },
        { label: `${driver}:disabled`, namespace: 'stage:isolation', broadcast: false },
      ] : [{ label: driver, namespace: 'stage:isolation', broadcast: false }];
      for (const { label, ...options } of configurations) {
        const store = new NexusStorage({ driver, ...options });
        state.stores.push({ label, store });
        for (const type of ['change', 'remove', 'clear']) store.on(type, async event => {
          const observation = { label, event, value: await store.get('item'), nativeAfterRead: driver === 'localStorage'
            ? localStorage.getItem(`nexusstorage:${JSON.stringify(options.namespace)}:item`) : undefined };
          state.observations.push(observation);
          state.resolved.set(label, observation);
          state.waiting.get(label)?.(observation);
        });
      }
    }
    state.waitFor = label => {
      if (state.resolved.has(label)) return Promise.resolve(state.resolved.get(label));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} isolated broadcast timed out`)), 5000);
        state.waiting.set(label, value => { clearTimeout(timer); resolve(value); });
      });
    };
    globalThis.__stageIsolation = state;
  });
  try {
    for (const driver of ['localStorage', 'indexedDB', 'cacheStorage']) {
      const remote = secondPage.evaluate(async driver => globalThis.__stageIsolation.waitFor(driver), driver);
      await page.evaluate(async driver => {
        const { NexusStorage } = await import('/index.js');
        const store = new NexusStorage({ driver, namespace: 'stage:isolation', broadcast: true });
        try { await store.set('item', { sourceDriver: driver }); }
        finally { await store.close(); }
      }, driver);
      const observed = await remote;
      assert.deepEqual(observed.value, { sourceDriver: driver },
        `${driver}: isolated receiver reads committed data (native snapshot: ${observed.nativeAfterRead})`);
    }
    await page.evaluate(async () => {
      const { NexusStorage } = await import('/index.js');
      for (const driver of ['memory', 'sessionStorage']) {
        const store = new NexusStorage({ driver, namespace: 'stage:isolation' });
        try { await store.set('item', { sourceDriver: driver }); }
        finally { await store.close(); }
      }
    });
    const isolated = await secondPage.evaluate(async () => {
      // Let any erroneous extra channel messages surface after all positive acknowledgements.
      await new Promise(resolve => setTimeout(resolve, 100));
      const state = globalThis.__stageIsolation;
      return { observations: state.observations, values: await Promise.all(state.stores
        .filter(({ label }) => label === 'memory' || label === 'sessionStorage')
        .map(async ({ label, store }) => ({ label, value: await store.get('item') }))) };
    });
    assert.deepEqual(isolated.observations.map(item => item.label), ['localStorage', 'indexedDB', 'cacheStorage']);
    assert.ok(isolated.observations.every(item => item.event.source === 'remote' && item.event.namespace === 'stage:isolation'
      && item.event.driver === item.label));
    assert.deepEqual(isolated.values, [{ label: 'memory', value: undefined }, { label: 'sessionStorage', value: undefined }]);
    results.push('broadcast: same namespace on different drivers receives only its own driver events');
    results.push('broadcast: other namespaces and broadcast-disabled instances remain silent');
    results.push('broadcast: independent memory and sessionStorage tabs share neither values nor events');
  } finally {
    await secondPage.evaluate(async () => {
      await Promise.all(globalThis.__stageIsolation.stores.map(({ store }) => store.close()));
      delete globalThis.__stageIsolation;
    });
  }
}
