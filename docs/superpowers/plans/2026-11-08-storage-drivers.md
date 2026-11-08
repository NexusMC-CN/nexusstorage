# 新增存储后端实现计划

> **面向 AI 代理的工作者：** 按测试先行执行独立任务并审查结果。

**目标：** 让站点不同功能分别选择四种存储 driver，新增 sessionStorage 与 Cache Storage 的统一 JSON 支持。

**架构：** 公共类保持 JSON API 与排队职责；Web Storage 复用一个实现；Cache Storage 单独适配。通过 namespace 为每个功能隔离数据。

**技术栈：** 现有 TypeScript、Node 测试、tsup、Playwright，不增加运行时依赖。

## 任务 1：Web Storage 与 sessionStorage

文件：`src/backend/web/index.ts`、`src/backend/web/local.ts`、`tests/backend/web/index.test.ts`。

- [x] 先写双后端 CRUD、local/session 独立、延迟获取、错误和关闭的失败测试。
- [x] 将现有实现提取到 `WebStorageBackend(namespace, driver)`，driver 为 localStorage 或 sessionStorage，保留旧 LocalStorageBackend 包装类和原 key 格式。
- [x] 两组测试通过，保留原 localStorage 回归。

```ts
const session = new WebStorageBackend('checkout', 'sessionStorage');
await session.set('cart', '{"count":1}');
assert.equal(await session.get('cart'), '{"count":1}');
```

## 任务 2：Cache Storage 适配器

文件：`src/backend/cache.ts`、`tests/backend/cache.test.ts`、`tests/helpers/memory/cache.ts`。

- [x] 先写 CRUD、编码往返、Response、外部条目隔离、跨实例 clear、异常和关闭失败测试。
- [x] 实现设计约定的命名缓存与规范内部 URL。所有数据操作使用 Cache/Response API，不能隐式 fetch。
- [x] 验证同一缓存的实例 A clear 后实例 B 写入仍被新实例 C 读到；外部资源和其他缓存保留。
- [x] 修复原生 Cache 忽略 fragment 所产生的非规范键冲突，验证读写和删除均保护外部条目。

```ts
const backend = new CacheStorageBackend('offline');
await backend.set('\ud800', 'null');
assert.deepEqual(await backend.keys(), ['\ud800']);
```

## 任务 3：公共入口、消费和浏览器

文件：`src/types.ts`、`src/storage/index.ts`、`tests/storage/index.test.ts`、`scripts/consumer-smoke.mjs`、`scripts/browser-smoke.mjs`、`README.md`、`examples/features/index.ts`、`examples/worker/service.ts`。

- [x] 先为新增 driver 扩展统一 API 测试，确认尚未支持的 driver 失败；然后扩展类型和构造选择。
- [x] 消费脚本扩展四种后端、缺 API 和 SSR；使用测试 helper 提供 Cache 模拟，真实产物仍从 tarball 独立安装。
- [x] 真实 Chromium 检查四种后端、独立标签 session 隔离、真实 Service Worker 与页面双向 Cache JSON 读写。
- [x] 更新 README 的后端选择表与按功能配置示例，区分 Cache JSON 存储与资源缓存策略；示例静态检查包括 Service Worker 的延长事件生命周期用法。
- [x] 独立审查、修复、整体 `npm run check`、真实浏览器验证并重新生成本地安装包。

## 全局边界

不自动注册 SW、不增加 HTTP 缓存策略、不做跨实例锁、不改已有存储格式；包尚未发布，版本保持 `0.1.0`。当前目录无 Git 历史，不创建远程仓库或提交。

## 完成证据

2026-11-08：

- 公共新增后端测试先以 `INVALID_OPTIONS` 失败；扩展后四种 driver 的 39 个公共行为测试通过。
- Web Storage 适配器与原 localStorage 回归 61/61 通过。
- Cache 初始 34 个行为测试由占位红灯到绿灯；独立审查发现 fragment 别名问题，新增 7 个回归后先有 6 个失败，修复后 41/41 通过。
- 最终 `npm run check` 退出 0，包含严格类型检查、220 个测试、ESM/CJS 与两套声明文件构建、真实 tarball 离线安装及 NodeNext/Bundler 类型消费。
- 对最终构建执行 `node scripts/browser-smoke.mjs`，指定本机已有 Chromium 路径；Chromium 156.0.8078.4 的 54 项检查全部通过，包含真实模块 Service Worker 与页面双向读写、会话隔离、Cache 外部条目保护。
- 独立定向复审直接在 Chromium 重跑 fragment 场景，确认 `CORRUPT_DATA`、外部 URL/响应体保留与不冲突条目正常读写，唯一 P2 已关闭。
- 已重新生成 `.tmp/nexusmc-cn-nexusstorage-0.1.0.tgz`，8 个文件，未发布 npm。

本次没有其他浏览器、真实设备或大规模缓存性能验证。Cache 后端保持无跨实例原子事务的既定边界。
