import { NexusStorage } from '@nexusmc-cn/nexusstorage';

// 将此模块作为应用已有 Service Worker 的入口，由应用构建工具编译打包。
// 仅声明此例使用的事件结构，避免把 DOM 与 WebWorker 全局类型混在一起。
interface WorkerMessageEvent extends Event {
  readonly data: unknown;
  waitUntil(promise: Promise<unknown>): void;
}

self.addEventListener('message', (event: Event) => {
  const message = event as WorkerMessageEvent;
  if (message.data !== 'refresh-offline-data') return;

  // 页面可用相同配置读取此处写入的 JSON，不需要 Request / Response API。
  const storage = new NexusStorage({ driver: 'cacheStorage', namespace: 'offline-data' });
  message.waitUntil((async () => {
    try {
      await storage.set('last-result', { items: ['a', 'b'], savedAt: Date.now() });
    } finally {
      // waitUntil 包含关闭操作，且关闭发生在本次读写结束后。
      await storage.close();
    }
  })());
});

// 本示例只处理消息，不注册 Service Worker，也不接管 fetch 或删除其他缓存。
