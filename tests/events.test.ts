import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { StorageEvents, type StorageEvent } from '../src/events.js';
import type { StorageDriver } from '../src/types.js';

class TestWindow extends EventTarget {
  readonly localStorage: TestLocalStorage;

  constructor(network: TestStorageNetwork) {
    super();
    this.localStorage = new TestLocalStorage(network, this);
  }
}

class TestStorageNetwork {
  readonly entries = new Map<string, string>();
  readonly windows = new Set<TestWindow>();
  failSet = false;
  failRemove = false;

  createWindow(): TestWindow {
    const target = new TestWindow(this);
    this.windows.add(target);
    return target;
  }

  notify(sender: TestWindow, key: string, oldValue: string | null, newValue: string | null): void {
    for (const target of this.windows) {
      if (target === sender) continue;
      const event = new Event('storage');
      Object.defineProperties(event, {
        key: { value: key }, oldValue: { value: oldValue }, newValue: { value: newValue },
        storageArea: { value: target.localStorage },
      });
      queueMicrotask(() => target.dispatchEvent(event));
    }
  }
}

class TestLocalStorage implements Storage {
  constructor(private readonly network: TestStorageNetwork, private readonly owner: TestWindow) {}
  get length(): number { return this.network.entries.size; }
  key(index: number): string | null { return [...this.network.entries.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.network.entries.get(key) ?? null; }
  setItem(key: string, value: string): void {
    if (this.network.failSet) throw new Error('Storage control write failed.');
    const oldValue = this.getItem(key);
    this.network.entries.set(key, value);
    if (oldValue !== value) this.network.notify(this.owner, key, oldValue, value);
  }
  removeItem(key: string): void {
    if (this.network.failRemove) throw new Error('Storage control cleanup failed.');
    const oldValue = this.getItem(key);
    this.network.entries.delete(key);
    if (oldValue !== null) this.network.notify(this.owner, key, oldValue, null);
  }
  clear(): void { for (const key of this.network.entries.keys()) this.removeItem(key); }
}

/** Deliver cloned messages asynchronously to peers, as the platform channel does. */
class TestBroadcastChannel {
  static readonly channels = new Set<TestBroadcastChannel>();
  static failPost = false;
  readonly name: string;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  #closed = false;

  constructor(name: string) {
    this.name = name;
    TestBroadcastChannel.channels.add(this);
  }

  postMessage(message: unknown): void {
    if (this.#closed || TestBroadcastChannel.failPost) throw new Error('Channel cannot post.');
    for (const peer of TestBroadcastChannel.channels) {
      if (peer === this || peer.#closed || peer.name !== this.name) continue;
      const event = new MessageEvent('message', { data: structuredClone(message) });
      const receive = peer.onmessage;
      // A queued delivery can still reach a retained handler after close().
      queueMicrotask(() => receive?.(event));
    }
  }

  close(): void {
    this.#closed = true;
    TestBroadcastChannel.channels.delete(this);
  }
}

describe('storage events', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const dispatchers: StorageEvents[] = [];
  let storageNetwork: TestStorageNetwork;
  let primaryWindow: TestWindow;

  function useWindow(target: TestWindow): void {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: target.localStorage });
  }

  function create(driver: StorageDriver = 'memory', namespace = 'events', broadcast = false): StorageEvents {
    const events = new StorageEvents(driver, namespace, broadcast);
    dispatchers.push(events);
    return events;
  }

  function channelPeer(): TestBroadcastChannel {
    const receiver = TestBroadcastChannel.channels.values().next().value;
    assert.ok(receiver, 'the dispatcher must have opened its channel');
    return new TestBroadcastChannel(receiver.name);
  }

  beforeEach(() => {
    TestBroadcastChannel.failPost = false;
    Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, value: TestBroadcastChannel });
    storageNetwork = new TestStorageNetwork();
    primaryWindow = storageNetwork.createWindow();
    useWindow(primaryWindow);
  });

  afterEach(() => {
    for (const events of dispatchers.splice(0)) events.close();
    for (const channel of TestBroadcastChannel.channels) channel.close();
    if (original) Object.defineProperty(globalThis, 'BroadcastChannel', original);
    else Reflect.deleteProperty(globalThis, 'BroadcastChannel');
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('constructs without reading browser globals and keeps broadcast disabled by default', () => {
    const globals = ['BroadcastChannel', 'window', 'localStorage', 'sessionStorage', 'indexedDB', 'caches'] as const;
    const descriptors = globals.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
    let accesses = 0;
    try {
      for (const name of globals) Object.defineProperty(globalThis, name, {
        configurable: true,
        get() { accesses++; throw new Error('Browser API denied.'); },
      });
      for (const driver of ['memory', 'localStorage', 'sessionStorage', 'indexedDB', 'cacheStorage'] as const) {
        const events = create(driver);
        const seen: StorageEvent[] = [];
        events.on('change', event => { seen.push(event); });
        events.prepare();
        events.publish({ type: 'change', operation: 'set', key: 'item' });
        assert.equal(seen.length, 1);
      }
      for (const driver of ['localStorage', 'indexedDB', 'cacheStorage'] as const) create(driver, 'lazy', true);
      assert.equal(accesses, 0);
    } finally {
      globals.forEach((name, index) => {
        const descriptor = descriptors[index];
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      });
    }
  });

  it('rejects broadcasting for instance memory and tab-local session storage', () => {
    for (const driver of ['memory', 'sessionStorage'] as const) {
      assert.throws(() => create(driver, 'events', true), { code: 'INVALID_OPTIONS' });
    }
  });

  it('validates subscriptions before accessing the broadcast API', () => {
    const events = create('localStorage', 'events', true);
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      get() { throw new Error('This must not be read for invalid subscriptions.'); },
    });
    assert.throws(() => events.on('unknown' as never, () => {}), { code: 'INVALID_OPTIONS' });
    assert.throws(() => events.on('change', null as never), { code: 'INVALID_OPTIONS' });
  });

  it('delivers only matching local metadata synchronously with cancellation', () => {
    const events = create('indexedDB', '本地:"scope"');
    const seen: StorageEvent[] = [];
    const cancel = events.on('change', event => { seen.push(event); });
    const removed: StorageEvent[] = [];
    events.on('remove', event => { removed.push(event); });
    const cleared: StorageEvent[] = [];
    events.on('clear', event => { cleared.push(event); });
    events.publish({ type: 'change', operation: 'set', key: '' });
    events.publish({ type: 'change', operation: 'update', key: 'item' });
    events.publish({ type: 'change', operation: 'compareAndSwap', key: 'other' });
    events.publish({ type: 'remove', operation: 'remove', key: 'gone' });
    events.publish({ type: 'clear', operation: 'clear' });
    assert.deepEqual(seen, [
      { type: 'change', operation: 'set', key: '', driver: 'indexedDB', namespace: '本地:"scope"', source: 'local' },
      { type: 'change', operation: 'update', key: 'item', driver: 'indexedDB', namespace: '本地:"scope"', source: 'local' },
      { type: 'change', operation: 'compareAndSwap', key: 'other', driver: 'indexedDB', namespace: '本地:"scope"', source: 'local' },
    ]);
    assert.deepEqual(removed, [
      { type: 'remove', operation: 'remove', key: 'gone', driver: 'indexedDB', namespace: '本地:"scope"', source: 'local' },
    ]);
    assert.deepEqual(cleared, [
      { type: 'clear', operation: 'clear', driver: 'indexedDB', namespace: '本地:"scope"', source: 'local' },
    ]);
    cancel();
    cancel();
    events.publish({ type: 'change', operation: 'set', key: 'cancelled' });
    assert.equal(seen.length, 3);
  });

  it('isolates default events between dispatchers even with the same driver and namespace', () => {
    const first = create('localStorage');
    const second = create('localStorage');
    const seen: StorageEvent[] = [];
    first.on('change', event => { seen.push(event); });
    second.publish({ type: 'change', operation: 'set', key: 'item' });
    assert.deepEqual(seen, []);
  });

  it('freezes a metadata copy before invoking listeners', () => {
    const events = create();
    const change = { type: 'change' as const, operation: 'set' as const, key: 'original', value: 'private value' };
    const seen: StorageEvent[] = [];
    events.on('change', event => { Reflect.set(event, 'key', 'tampered'); change.key = 'outside mutation'; });
    events.on('change', event => { seen.push(event); });
    events.publish(change);
    assert.deepEqual(seen, [
      { type: 'change', operation: 'set', key: 'original', driver: 'memory', namespace: 'events', source: 'local' },
    ]);
    assert.equal(Object.isFrozen(seen[0]), true);
  });

  it('observes listener rejections and continues after synchronous failures', async () => {
    const events = create();
    const seen: StorageEvent[] = [];
    events.on('change', () => { throw new Error('Synchronous listener failure.'); });
    events.on('change', async () => { throw new Error('Asynchronous listener failure.'); });
    events.on('change', event => { seen.push(event); });
    assert.doesNotThrow(() => events.publish({ type: 'change', operation: 'set', key: 'committed' }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(seen[0]?.key, 'committed');
  });

  it('contains failing then getters returned by listeners', () => {
    const events = create();
    const seen: StorageEvent[] = [];
    events.on('change', () => ({ get then() { throw new Error('Broken thenable.'); } }) as never);
    events.on('change', event => { seen.push(event); });
    assert.doesNotThrow(() => events.publish({ type: 'change', operation: 'set', key: 'committed' }));
    assert.equal(seen.length, 1);
  });

  for (const driver of ['indexedDB', 'cacheStorage'] as const) {
    it(`broadcasts ${driver} events to matching peers without echoing`, async () => {
      const sender = create(driver, 'shared', true);
      const receiver = create(driver, 'shared', true);
      const local: StorageEvent[] = [];
      const remote: StorageEvent[] = [];
      sender.on('change', event => { local.push(event); });
      receiver.on('change', event => { remote.push(event); });
      sender.publish({ type: 'change', operation: 'update', key: 'item' });
      assert.equal(local.length, 1);
      assert.equal(remote.length, 0);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(remote, [
        { type: 'change', operation: 'update', key: 'item', driver, namespace: 'shared', source: 'remote' },
      ]);
      assert.deepEqual(local, [
        { type: 'change', operation: 'update', key: 'item', driver, namespace: 'shared', source: 'local' },
      ]);
    });
  }

  it('broadcasts only inside the exact driver and namespace scope', async () => {
    const sender = create('indexedDB', 'scope:"[]:☃', true);
    const exact = create('indexedDB', 'scope:"[]:☃', true);
    const otherNamespace = create('indexedDB', 'scope:"[]:☃:', true);
    const otherDriver = create('cacheStorage', 'scope:"[]:☃', true);
    const received = [0, 0, 0];
    [exact, otherNamespace, otherDriver].forEach((events, index) => {
      events.on('remove', () => { received[index] = (received[index] ?? 0) + 1; });
    });
    sender.prepare();
    sender.publish({ type: 'remove', operation: 'remove', key: 'item' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(received, [1, 0, 0]);
  });

  it('reconstructs frozen remote metadata and discards extra payload fields', async () => {
    const events = create('cacheStorage', 'metadata', true);
    const seen: StorageEvent[] = [];
    events.on('change', event => { Reflect.set(event, 'operation', 'clear'); });
    events.on('change', event => { seen.push(event); });
    channelPeer().postMessage({
      type: 'change', operation: 'set', key: 'item', source: 'local',
      driver: 'memory', namespace: 'other', value: 'secret', payload: { business: true },
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(seen, [
      { type: 'change', operation: 'set', key: 'item', driver: 'cacheStorage', namespace: 'metadata', source: 'remote' },
    ]);
    assert.equal(Object.isFrozen(seen[0]), true);
  });

  it('filters unknown payloads and invalid event-operation-key combinations', async () => {
    const events = create('indexedDB', 'validation', true);
    const seen: StorageEvent[] = [];
    for (const type of ['change', 'remove', 'clear'] as const) events.on(type, event => { seen.push(event); });
    const peer = channelPeer();
    for (const payload of [
      null, undefined, false, 0, 'message', [], {},
      { type: 'unknown', operation: 'set', key: 'item' },
      { type: 'change', operation: 'unknown', key: 'item' },
      { type: 'change', operation: 'remove', key: 'item' },
      { type: 'change', operation: 'set' },
      { type: 'change', operation: 'set', key: 1 },
      { type: 'remove', operation: 'set', key: 'item' },
      { type: 'remove', operation: 'remove' },
      { type: 'clear', operation: 'clear', key: 'item' },
      { type: 'clear', operation: 'set' },
    ]) peer.postMessage(payload);
    peer.postMessage({ type: 'clear', operation: 'clear' });
    peer.postMessage({ type: 'remove', operation: 'remove', key: '' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(seen, [
      { type: 'clear', operation: 'clear', driver: 'indexedDB', namespace: 'validation', source: 'remote' },
      { type: 'remove', operation: 'remove', key: '', driver: 'indexedDB', namespace: 'validation', source: 'remote' },
    ]);
  });

  it('fails preparation and subscriptions when BroadcastChannel is missing', () => {
    Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, value: undefined });
    const events = create('indexedDB', 'unavailable', true);
    assert.throws(() => events.prepare(), { code: 'STORAGE_UNAVAILABLE' });
    assert.throws(() => events.on('change', () => {}), { code: 'STORAGE_UNAVAILABLE' });
  });

  it('normalizes denied BroadcastChannel access and failed channel construction', () => {
    const events = create('indexedDB', 'denied', true);
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      get() { throw new Error('Access denied.'); },
    });
    assert.throws(() => events.prepare(), { code: 'STORAGE_UNAVAILABLE' });
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      value: class { constructor() { throw new Error('Channel creation denied.'); } },
    });
    assert.throws(() => events.prepare(), { code: 'STORAGE_UNAVAILABLE' });
  });

  it('rejects a BroadcastChannel implementation without channel methods', () => {
    Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, value: class {} });
    assert.throws(() => create('indexedDB', 'malformed', true).prepare(), { code: 'STORAGE_UNAVAILABLE' });
  });

  it('reuses a prepared channel after global access becomes unavailable', () => {
    const events = create('indexedDB', 'prepared', true);
    events.prepare();
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      get() { throw new Error('Further global access denied.'); },
    });
    const seen: StorageEvent[] = [];
    assert.doesNotThrow(() => events.prepare());
    events.on('change', event => { seen.push(event); });
    events.publish({ type: 'change', operation: 'set', key: 'item' });
    assert.equal(seen.length, 1);
  });

  it('does not fail committed event publication when posting fails', () => {
    const events = create('indexedDB', 'failed-post', true);
    const seen: StorageEvent[] = [];
    events.on('change', event => { seen.push(event); });
    TestBroadcastChannel.failPost = true;
    assert.doesNotThrow(() => events.publish({ type: 'change', operation: 'set', key: 'committed' }));
    assert.equal(seen[0]?.key, 'committed');
  });

  it('sends the original metadata when a local listener mutates the input object', async () => {
    const sender = create('indexedDB', 'snapshot', true);
    const receiver = create('indexedDB', 'snapshot', true);
    const change = { type: 'change' as const, operation: 'set' as const, key: 'original' };
    sender.on('change', () => { change.key = 'tampered'; });
    const seen: StorageEvent[] = [];
    receiver.on('change', event => { seen.push(event); });
    sender.publish(change);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(seen[0]?.key, 'original');
  });

  it('closes subscriptions and ignores messages that were already queued', async () => {
    const events = create('indexedDB', 'close', true);
    const seen: StorageEvent[] = [];
    const cancel = events.on('change', event => { seen.push(event); });
    const peer = channelPeer();
    peer.postMessage({ type: 'change', operation: 'set', key: 'queued' });
    events.close();
    events.close();
    cancel();
    events.publish({ type: 'change', operation: 'set', key: 'closed' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(seen, []);
    assert.throws(() => events.prepare(), { code: 'CLOSED' });
    assert.throws(() => events.on('change', () => {}), { code: 'CLOSED' });
  });

  it('uses native storage events across windows and clears its metadata control key', async () => {
    Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, get() { throw new Error('BC must not be used.'); } });
    const sender = create('localStorage', 'native', true);
    const local: StorageEvent[] = [];
    sender.on('change', event => { local.push(event); });
    const peerWindow = storageNetwork.createWindow();
    useWindow(peerWindow);
    const receiver = create('localStorage', 'native', true);
    const remote: StorageEvent[] = [];
    receiver.on('change', event => { remote.push(event); });
    const wires: Array<{ key: string; value: Record<string, unknown> }> = [];
    peerWindow.addEventListener('storage', event => {
      const storage = event as globalThis.StorageEvent;
      if (storage.newValue !== null) wires.push({ key: storage.key!, value: JSON.parse(storage.newValue) });
    });
    const change = { type: 'change' as const, operation: 'set' as const, key: 'item', value: { secret: 'private' } };
    sender.publish(change);
    sender.publish(change);
    assert.equal(local.length, 2);
    assert.equal(remote.length, 0);
    assert.equal(storageNetwork.entries.size, 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(remote, [
      { type: 'change', operation: 'set', key: 'item', driver: 'localStorage', namespace: 'native', source: 'remote' },
      { type: 'change', operation: 'set', key: 'item', driver: 'localStorage', namespace: 'native', source: 'remote' },
    ]);
    assert.equal(wires.length, 2);
    assert.notEqual(wires[0]!.value.id, wires[1]!.value.id);
    for (const wire of wires) {
      assert.equal(wire.key, 'nexusstorage:events:1:["localStorage","native"]');
      assert.equal(wire.key.startsWith('nexusstorage:"native":'), false);
      assert.deepEqual(Object.keys(wire.value).sort(), ['driver', 'id', 'key', 'namespace', 'operation', 'source', 'type']);
      assert.equal(JSON.stringify(wire.value).includes('private'), false);
    }
    assert.equal(TestBroadcastChannel.channels.size, 0);
  });

  it('limits native broadcasts to other windows in the exact namespace', async () => {
    const sender = create('localStorage', 'native:"scope"', true);
    const sameWindow = create('localStorage', 'native:"scope"', true);
    const seen = { sameWindow: 0, sameNamespace: 0, otherNamespace: 0 };
    sameWindow.on('remove', () => { seen.sameWindow++; });
    sender.prepare();
    useWindow(storageNetwork.createWindow());
    const exact = create('localStorage', 'native:"scope"', true);
    const other = create('localStorage', 'native:"scope":', true);
    exact.on('remove', () => { seen.sameNamespace++; });
    other.on('remove', () => { seen.otherNamespace++; });
    sender.publish({ type: 'remove', operation: 'remove', key: 'item' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(seen, { sameWindow: 0, sameNamespace: 1, otherNamespace: 0 });
  });

  it('strictly validates native control messages and rebuilds remote metadata', () => {
    const events = create('localStorage', 'native-validation', true);
    const seen: StorageEvent[] = [];
    events.on('clear', event => { seen.push(event); });
    const controlKey = 'nexusstorage:events:1:["localStorage","native-validation"]';
    const valid = { id: 'unique-id', type: 'clear', operation: 'clear', driver: 'localStorage', namespace: 'native-validation', source: 'local' };
    const dispatch = (key: string, newValue: string | null, storageArea: Storage = primaryWindow.localStorage) => {
      const event = new Event('storage');
      Object.defineProperties(event, { key: { value: key }, newValue: { value: newValue }, storageArea: { value: storageArea } });
      primaryWindow.dispatchEvent(event);
    };
    dispatch(controlKey, null);
    dispatch(controlKey, 'not JSON');
    dispatch(controlKey, JSON.stringify(null));
    for (const patch of [
      { id: '' }, { id: 1 }, { id: undefined }, { driver: 'indexedDB' }, { namespace: 'other' },
      { source: 'remote' }, { source: undefined }, { type: 'change' }, { key: 'forbidden' },
    ]) dispatch(controlKey, JSON.stringify({ ...valid, ...patch }));
    dispatch('nexusstorage:"native-validation":business-key', JSON.stringify(valid));
    dispatch(controlKey, JSON.stringify(valid), storageNetwork.createWindow().localStorage);
    assert.deepEqual(seen, []);
    dispatch(controlKey, JSON.stringify({ ...valid, value: 'secret', extra: true }));
    assert.deepEqual(seen, [
      { type: 'clear', operation: 'clear', driver: 'localStorage', namespace: 'native-validation', source: 'remote' },
    ]);
    assert.equal(Object.isFrozen(seen[0]), true);
  });

  it('prepares native storage lazily and normalizes unavailable or denied APIs', () => {
    const events = create('localStorage', 'native-unavailable', true);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined });
    assert.throws(() => events.prepare(), { code: 'STORAGE_UNAVAILABLE' });
    useWindow(primaryWindow);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage access denied.'); } });
    assert.throws(() => events.on('change', () => {}), { code: 'STORAGE_UNAVAILABLE' });
    useWindow(primaryWindow);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {} });
    assert.throws(() => events.prepare(), { code: 'STORAGE_UNAVAILABLE' });
  });

  it('keeps committed local notifications successful when control writes or cleanup fail', () => {
    const events = create('localStorage', 'native-failures', true);
    let changes = 0;
    events.on('change', () => { changes++; });
    storageNetwork.failSet = true;
    assert.doesNotThrow(() => events.publish({ type: 'change', operation: 'set', key: 'item' }));
    assert.equal(changes, 1);
    storageNetwork.failSet = false;
    storageNetwork.failRemove = true;
    assert.doesNotThrow(() => events.publish({ type: 'change', operation: 'set', key: 'item' }));
    assert.equal(changes, 2);
    storageNetwork.failRemove = false;
    events.publish({ type: 'change', operation: 'set', key: 'item' });
    assert.equal(storageNetwork.entries.size, 0);
  });

  it('cancels native subscriptions and removes its native listener on close', async () => {
    const sender = create('localStorage', 'native-close', true);
    sender.prepare();
    const receiverWindow = storageNetwork.createWindow();
    useWindow(receiverWindow);
    const receiver = create('localStorage', 'native-close', true);
    let changes = 0;
    const cancel = receiver.on('change', () => { changes++; });
    assert.equal(getEventListeners(receiverWindow, 'storage').length, 1);
    cancel();
    sender.publish({ type: 'change', operation: 'set', key: 'cancelled' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(changes, 0);
    receiver.on('change', () => { changes++; });
    sender.publish({ type: 'change', operation: 'set', key: 'queued' });
    receiver.close();
    assert.equal(getEventListeners(receiverWindow, 'storage').length, 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(changes, 0);
    assert.throws(() => receiver.prepare(), { code: 'CLOSED' });
  });
});
