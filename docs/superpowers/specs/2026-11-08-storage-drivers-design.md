# 多功能存储与新增后端设计

日期：2026-11-08。延续用户已确认的统一异步 JSON 键值接口，按用户追加要求支持 sessionStorage 与 Cache Storage。

## 功能与选择

每个功能创建独立 `NexusStorage` 实例；`driver` 指定后端，`namespace` 指定功能的数据空间。已有方案能够表达这一需求，不额外加入注册表或全站默认路由。

支持的 `StorageDriver` 扩展为 `localStorage | sessionStorage | indexedDB | cacheStorage`。默认值保持 `localStorage`。同名 namespace 在不同后端中相互独立。

```ts
const preferences = new NexusStorage({ driver: 'localStorage', namespace: 'preferences' });
const checkout = new NexusStorage({ driver: 'sessionStorage', namespace: 'checkout' });
const drafts = new NexusStorage({ driver: 'indexedDB', namespace: 'drafts' });
const offline = new NexusStorage({ driver: 'cacheStorage', namespace: 'offline-data' });
```

比较过的替代方案：添加全站存储管理器会引入当前并不需要的生命周期管理；为 Cache Storage 单独设计 Request/Response API 会扩大统一 JSON 包的范围。本次保持按实例选后端，Cache Storage 作为 JSON 存储适配器，资源请求策略由应用管理。

## sessionStorage

- 与 localStorage 共享 Web Storage 实现，通过显式后端名称选择 `globalThis.localStorage` 或 `globalThis.sessionStorage`。
- 保留 `LocalStorageBackend` 的内部兼容入口；原有持久化 key 格式不变。
- 不依赖 window；构造和导入不访问浏览器 API。数据操作才取得后端；缺失和访问失败显式报错。
- 具有浏览器原生的页面会话与标签页隔离规则，刷新同一标签页仍可读取，新建独立标签页不共享该会话数据。

## Cache Storage

- 内部 `CacheStorageBackend` 实现现有字符串后端接口，公共层继续负责严格 JSON 校验与快照。
- 通过 `globalThis.caches` 延迟打开 `nexusstorage:${JSON.stringify(namespace)}` 命名缓存；不依赖 document、window 或 location，因此页面和 Service Worker 均能使用。
- 逻辑字符串 key 编码为 `https://nexusstorage.invalid/v1/${encodeURIComponent(JSON.stringify(key))}`。这是仅用于 Cache 索引的合成 URL，不进行网络请求；JSON 字符串编码保留空字符串、Unicode、未配对代理项及分隔符。
- 值是 `Content-Type: application/json; charset=utf-8` 的合成 Response，读取通过 `Response.text()` 返回原始 JSON 字符串。
- `keys()` 仅识别规范编码的内部 GET 请求，返回排序逻辑 key。外部资源 URL 不计入记录。
- 原生 Cache 匹配忽略 URL fragment，而 `keys()` 会保留它。对逻辑 key 读、写、更新或删除前检查此类非规范别名；发现内部规范 URL 与外部带 fragment URL 冲突时报告 CORRUPT_DATA，保留外部条目。清理内部记录时也应用相同保护。
- `clear()` 只逐条删除自身规范编码条目，不删除整个命名缓存，避免其他实例持有孤立的旧 Cache 引用；保留外部缓存与非内部资源条目。
- 读取、写入、枚举或删除失败统一包装并保留 cause；无 API 报 STORAGE_UNAVAILABLE，实际后端失败报 STORAGE_ERROR；close 后永久 CLOSED。
- 同实例调用顺序由公共队列保证。Cache Storage 不提供读改写事务，不承诺跨实例、标签页或 Service Worker 的原子更新。
- 本次不自动注册 Service Worker、不接管 fetch、不发起网络请求或自动预缓存资源。应用可在已有 Worker 的 `event.waitUntil` 中调用存储。

## 验证

- 新增行为先写失败测试；对四种 driver 运行统一 CRUD、JSON、隔离、顺序、关闭测试。
- Web Storage 适配器回归旧 key 格式与读取错误，新增 local/session 不串读。
- Cache 单测使用仅测试目录内的 Cache API 替身验证 URL 编码、Response 消费、外部条目保留、异常及跨实例 clear 后可见性。
- Chromium 对四种后端验证真实 CRUD 和刷新持久化；检查 sessionStorage 的独立标签隔离，Cache Storage 的页面与真实 Service Worker 双向读写。
- 真正 tarball 的 ESM/CJS 消费与公开类型支持四种 driver；示例补充按功能实例与 Service Worker 用法。

## 参考

- [MDN sessionStorage](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage)
- [MDN CacheStorage](https://developer.mozilla.org/en-US/docs/Web/API/CacheStorage)
- [MDN Cache](https://developer.mozilla.org/en-US/docs/Web/API/Cache)
- [MDN Using Service Workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers)
