# Memory、TTL 与 Schema 设计

用户已批准上一轮功能分阶段建议，本轮交付第一阶段：Memory 驱动、TTL、按 key 的 Schema 与类型推导。迁移、订阅、持久队列与文件扩展仍按路线图分别交付。

## 接口与作用域

- `new NexusStorage({ driver: 'memory' })` 使用实例私有 Map；不会因为 namespace 相同隐式共享，不访问浏览器全局变量；close 释放内存。应用需要共享时复用实例，SSR 为每个请求创建实例。
- 所有五种驱动支持 `set(key, value, { ttl: milliseconds })` 或 `{ expiresAt: epochMilliseconds }`，二者在类型和运行时互斥。ttl 为有限非负数，0 立即过期，期限及相对时间加法结果不超过 Number.MAX_SAFE_INTEGER。set/update 的 ttl 从排队操作开始计算（包括校验与后端等待）；绝对时间不变。update 在实际事务读改写时另取当前时间检查旧值是否已过期。
- `update(key, patch, options?)` 在同一后端读改写中检查过期、浅合并、校验、写入；省略有效期选项时保留旧期限，提供选项则重新设置。set 省略选项会取消旧有效期。
- get/has/keys 对到期记录都视为不存在；update 对到期记录返回 NOT_FOUND。过期判断 `Date.now() >= expiresAt`。不使用定时器，不在读取时删除记录，避免误删其他实例刚更新的数据；remove 仍按物理记录存在性返回布尔值，clear/remove 可清除过期记录。

## 记录格式

无有效期的数据继续保存原始 JSON。带有效期数据采用非 JSON 前缀 `NexusStorage/1\n` 加 JSON `{ value, expiresAt }`。该前缀不能与任何合法旧 JSON 混淆，业务对象中 version/value/expiresAt 均保持普通字段。未知/损坏格式返回 CORRUPT_DATA。公共 API 永远只返回业务值。

## Schema

- 构造参数 `schemas: { profile: profileSchema }`，接受 Standard Schema V1 的结构接口，零运行时依赖；公开其类型与输入/输出推导。
- 有 schema 配置的 TypeScript 实例，key 限于已声明的项，set 根据 schema 输入推导参数，get/set/update 根据输出推导结果；无 schema 的旧泛型调用兼容。
- 运行时仅对配置过 schema 的 key 校验；配置 map 复制为私有 Map，忽略继承项，拒绝无效校验器。JS 仍可操作未配置 key，与已有 namespace 操作一致。keys 不执行 schema 校验，只检查记录格式与有效期。
- 输入先捕获严格 JSON 快照，schema 可进行同步转换，输出再次执行严格 JSON 检查并复制；get 也校验历史数据；update 校验合并后的完整值。
- 首版只执行同步校验。返回 Promise/thenable 的校验器返回 ASYNC_SCHEMA，观察其异步拒绝以防未处理 rejection；不在 IndexedDB 事务内 await。普通校验失败/抛错为 VALIDATION_ERROR；不符合 JSON 的输入或校验输出仍为 INVALID_VALUE。
- 失败的校验不写入、不修改旧值，后续排队操作继续；错误保留 cause。

## 验证

先写失败测试，再实现。覆盖格式兼容/字段碰撞、到期临界、TTL 输入、快照、更新保留期限、物理移除、五驱动一致性、同步 schema 转换/读取校验/失败保留、异步拒绝、IDB 并发 patch。实际 tarball 验证 ESM/CJS 和 NodeNext/Bundler 类型推导，真实 Chromium 验证五驱动及 Worker 既有行为和 TTL/schema 新行为。
