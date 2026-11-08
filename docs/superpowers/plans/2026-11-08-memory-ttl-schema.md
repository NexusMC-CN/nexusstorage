# Memory、TTL 与 Schema 实现计划

> 按用户已批准的第一阶段设计执行；独立模块并行开发，公共接口集中集成。当前目录没有 Git 元数据，直接在本项目验证交付。

**目标：** 五驱动 JSON API 支持有效期与按 key 校验，保持既有接口兼容。

**架构：** 公共层管理 JSON、记录元数据与同步校验；后端同步 transform 保留 IDB 原子读改写。

**技术栈：** TypeScript、node:test、fake-indexeddb、Playwright、tsup；零运行时依赖。

## 任务 1：Memory 驱动

- [x] 新增 tests/backend/memory.test.ts，测试独立实例、CRUD、失败不改写、close；运行 `node --import tsx --test tests/backend/memory.test.ts` 确认缺失实现失败。
- [x] 新增 src/backend/memory.ts，实现 StorageBackend；运行同一命令通过。公共 driver 集成由任务 4 负责。

## 任务 2：记录格式与期限

- [x] 新增 tests/record/index.test.ts，先断言 `decodeRecord(encodeRecord({ value: 1, expiresAt: 2 }))` 是普通业务对象；测试旧 JSON、带期限格式、损坏前缀、边界与选项。
- [x] 新增 src/record/index.ts，导出 StorageRecord、WriteOptions、encodeRecord(value, expiresAt?)、decodeRecord(raw)、isExpired(record, now)、snapshotWriteOptions(options)、resolveExpiresAt(options, now)。运行 `node --import tsx --test tests/record/index.test.ts` 验证红绿。

## 任务 3：Schema 校验器

- [x] 新增 tests/schema.test.ts，先测试同步成功/转换、issues/throw、异步结果、无效 JSON 输出与 map 快照。
- [x] 新增 src/schema.ts，导出 StandardSchemaV1、StorageSchemas、InferSchemaInput、InferSchemaOutput、snapshotSchemas、validateSchema。错误码由任务 4 统一加入。运行 `node --import tsx --test tests/schema.test.ts` 验证红绿。

## 任务 4：公共 API 与联合测试

- [x] 新增 tests/storage/features.test.ts，循环五种驱动，先测试 `set('a', 1, { ttl: 0 })` 后 get/has/keys 均缺失、过期 update NOT_FOUND，以及 schema 写/读/更新失败保留。
- [x] 集成 src/storage/index.ts、types.ts、index.ts、errors.ts，类型化 schema key 与输入输出，同时保留无 schema 的旧泛型调用。
- [x] 执行 `npm run typecheck` 与 `npm test`，修复兼容与事务回归。

## 任务 5：消费者、浏览器与文档

- [x] 扩充 scripts/consumer-smoke.mjs，实际 tarball 检查第五驱动、TTL/schema 运行行为和 ESM/CJS/NodeNext/Bundler 类型正反例。
- [x] 扩充 scripts/browser-smoke.mjs：Memory 实例隔离、五驱动 TTL 边界及 schema 更新，保留页面/SW、session 隔离和并发测试。
- [x] 更新 README.md、package 元数据与 examples/features/managed.ts，清楚说明同步 schema、旧格式、过期物理保留与 Memory 作用域。
- [x] 执行 `npm run check`、真实 Chromium browser-smoke；独立审查规格与代码，修复实际问题后打包，记录本次证据。

## 完成证据

- 最终 npm run check 退出 0：类型检查、360/360 单测、ESM/CJS 构建、实际 tarball 离线安装及 NodeNext/Bundler 消费全部通过。
- Chromium 156.0.8078.4：210 项真实浏览器检查通过。
- 独立审查无剩余 P1/P2；TTL 起点、并发枚举过期和泛型消费问题均有先红后绿回归。
- .tmp/nexusmc-cn-nexusstorage-0.1.0.tgz：8 个文件，53196 字节，核心零运行时依赖。
- 未发布 npm；当前仍使用原有 0.1.0 版本。
