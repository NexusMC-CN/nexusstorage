import { NexusStorage } from '@nexusmc-cn/nexusstorage';

/** 在页面中调用：每个功能分别选择 driver 与 namespace。 */
export async function byFeatureExample(): Promise<void> {
  const preferences = new NexusStorage({ driver: 'localStorage', namespace: 'preferences' });
  const checkout = new NexusStorage({ driver: 'sessionStorage', namespace: 'checkout' });
  const drafts = new NexusStorage({ driver: 'indexedDB', namespace: 'drafts' });
  // Cache Storage 需要安全上下文；页面可以直接使用，无需先注册 Service Worker。
  const offline = new NexusStorage({ driver: 'cacheStorage', namespace: 'offline-data' });

  try {
    await preferences.set('theme', 'dark');
    await checkout.set('cart', { itemIds: ['book-1'], quantity: 1 });
    await drafts.set('article', { title: '草稿', body: '尚未发布' });
    // 与 service-worker.ts 中的同源、同 driver、同 namespace 实例共享数据。
    await offline.set('last-result', { items: ['a', 'b'], savedAt: Date.now() });
    console.log(await offline.get('last-result'));
  } finally {
    await Promise.all([preferences.close(), checkout.close(), drafts.close(), offline.close()]);
  }
}
