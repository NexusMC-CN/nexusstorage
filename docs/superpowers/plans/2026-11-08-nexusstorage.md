# NexusStorage 实现计划

> **面向 AI 代理的工作者：** 使用测试先行和独立任务审查执行本计划。步骤使用复选框跟踪。

**目标：** 初始化 `@nexusmc-cn/nexusstorage`，提供 LocalStorage 和 IndexedDB 的统一异步 JSON API。

**架构：** 公共类负责排队、JSON 快照和错误归一化；两种内部适配器只处理字符串记录和同步更新回调。IndexedDB 的读改写在同一事务完成，LocalStorage 仅承诺单实例调用顺序。

**技术栈：** TypeScript、tsup、Node test runner、tsx、fake-indexeddb；Playwright 用于真实浏览器冒烟验证。

## 全局约束

- 在用户指定的全新目录原地初始化，不创建多余工作树，不发布 npm。
- 数据接口、JSON 边界和命名空间隔离遵循设计文档。
- 不添加运行时依赖、查询能力、TTL 或加密。
- 无既存 Git 历史，先交付可检查文件；不自动创建远程仓库或提交身份。

## 文件职责

- `src/types.ts`：JSON 值、选项和公开类型。
- `src/errors.ts`：公开错误类型与错误码。
- `src/backend/index.ts`：内部字符串存储接口。
- `src/json.ts`：严格校验、快照、解码和浅合并。
- `src/backend/web/local.ts`：命名空间隔离的 LocalStorage CRUD。
- `src/backend/indexedDB.ts`：IndexedDB 连接和事务。
- `src/storage/index.ts`、`src/index.ts`：公共 API、顺序执行、生命周期和导出。
- `tests/**/*.test.ts`：核心、适配器和公共 API 行为测试。
- `scripts/consumer-smoke.mjs`：实际打包并在临时消费项目运行 JS 和 TS 入口。
- `scripts/browser-smoke.mjs`：隔离站点运行真实浏览器 CRUD。
- `README.md`、`examples/basic.ts`：对外使用说明与示例。

## 任务 1：JSON 契约与 LocalStorage

- [x] 先编写并运行 `tests/json.test.ts`、`tests/backend/web/local.test.ts`，确认缺失行为导致失败。
- [x] 实现普通 JSON 值的无损校验和独立快照；拒绝 Date、循环、稀疏数组、getter 和无效值，保留合法特殊属性名。
- [x] 实现 `LocalStorageBackend(namespace)`；每个实例延迟读取 `globalThis.localStorage`，使用无歧义前缀，不清空外部数据。
- [x] 验证新增、替换、删除、只清理自己命名空间、损坏数据、配额及访问错误。

测试示例：

```ts
assert.deepEqual(snapshotJson({ a: [null, true] }), { a: [null, true] });
assert.throws(() => snapshotJson({ a: undefined }), { code: 'INVALID_VALUE' });
```

运行：`node --import tsx --test tests/json.test.ts tests/backend/web/local.test.ts`。

## 任务 2：IndexedDB 事务适配器

- [x] 先编写并运行 `tests/backend/indexedDB.test.ts`，验证 CRUD、持久化、隔离、事务回滚和关闭行为。
- [x] 实现 `IndexedDBBackend(namespace)`；数据库名包含完整编码后的命名空间，固定 `entries` store。
- [x] 实现同步 transform 回调的 `update`：同一事务读取与写入，仅在 `complete` 后成功。
- [x] 处理缺失 API、打开失败、阻塞、升级、意外关闭、事务失败，不留下悬空连接。
- [x] 运行适配器测试和类型检查。

内部约定：

```ts
interface StorageBackend {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  update(key: string, transform: (raw: string | undefined) => string): Promise<string>;
  remove(key: string): Promise<boolean>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
  close(): Promise<void>;
}
```

运行：`node --import tsx --test tests/backend/indexedDB.test.ts`。

## 任务 3：公共 API 与可消费产物

- [x] 先写 `tests/storage/index.test.ts`：两种后端相同的 CRUD、返回值隔离、浅合并、缺失与 null、调用顺序、关闭后报错、SSR 导入与无效选项。
- [x] 实现 `NexusStorage`：构造不访问浏览器全局；所有操作 Promise；同实例顺序执行；失败不阻断后续队列。
- [x] 导出 JSON 类型、选项、错误；构建 ESM、CJS、`.d.ts`、`.d.cts`。
- [x] 编写消费验证脚本：打包 tarball，在临时项目安装，运行 ESM/CJS，分别用 NodeNext 与 bundler 模式检查类型。
- [x] 编写 README 和示例，明确无效 JSON、泛型边界、事务保证、许可与环境要求。
- [x] 运行真实浏览器隔离站点冒烟测试并关闭测试进程。
- [x] 独立审查并修复发现，完成整体检查与真实浏览器检查；记录实际通过范围。

公共行为示例：

```ts
await storage.set('profile', { name: 'Alex', theme: 'light' });
assert.deepEqual(await storage.update('profile', { name: 'Sam' }), {
  name: 'Sam', theme: 'light',
});
assert.equal(await storage.get('absent'), undefined);
```

## 最终验证记录

2026-11-08：

- `npm run check`：退出码 0；类型检查、120 个测试、ESM/CJS 构建、声明文件构建和真实 tarball 消费检查均通过。
- 消费检查覆盖离线安装、两种入口的实际 CRUD、SSR 导入、NodeNext ESM/CJS 与 Bundler 类型；包含 interface、泛型 JSON 封装正例及无效输入负例。
- 对最终构建执行 `node scripts/browser-smoke.mjs`，通过环境变量指定本机已有 Chromium；Chromium 156.0.8078.4 的 23 项检查通过，包含刷新持久化、命名空间隔离及两个标签页的 24 次并发修改。
- 独立审查发现的泛型 `set` 类型组合问题已按红绿测试修复，并经定向复审确认关闭；没有剩余需处理项。
- 本地安装包：`.tmp/nexusmc-cn-nexusstorage-0.1.0.tgz`，包含 8 个文件，未发布 npm。

真实浏览器结果仅覆盖本次 Chromium 环境；其他浏览器和设备未在本次验证。
