# NexusStorage 初始化设计提案

日期：2026-11-08
状态：用户已选择统一异步键值接口，按方案 A 实施。

## 项目目标

- 项目名称：NexusStorage。
- npm 包名：`@nexusmc-cn/nexusstorage`。
- 使用 TypeScript 编写，为 LocalStorage 与 IndexedDB 提供统一的 JSON 数据读写接口。
- 使用者直接传入、取得 JavaScript 对象或数组，不需要自行调用 `JSON.stringify` / `JSON.parse`。

## 接口方向与取舍

### 方案 A：统一异步键值接口（推荐）

每个 key 对应一个 JSON 值；两种后端都使用 Promise。调用方可以更换后端而不必修改读写代码。`set` 完整替换，`update` 对普通对象进行浅合并，操作完成后返回完整数据。

LocalStorage 的底层操作仍然是同步的；Promise 接口不代表它会在后台线程运行。IndexedDB 使用异步事务。

### 方案 B：保留后端原生时序

LocalStorage 提供同步接口，IndexedDB 提供异步接口。同步调用更短，但换后端时需要改写调用代码，也会产生两套公共接口。

### 方案 C：JSON 文档数据库

提供 collection、文档 ID、筛选和查询等能力。更适合结构化业务数据，但会增加查询语义、索引维护和迁移范围，不作为此次初始化的默认方案。

## 推荐接口示例

以下为待确认的使用示例，不是已经实现的功能。

```ts
import { NexusStorage } from '@nexusmc-cn/nexusstorage';

const storage = new NexusStorage({
  driver: 'localStorage', // 可改为 'indexedDB'
  namespace: 'my-app',
});

await storage.set('profile', {
  name: 'Alex',
  settings: { theme: 'light', language: 'zh-CN' },
  tags: ['developer'],
});

const updated = await storage.update('profile', { name: 'Sam' });
// { name: 'Sam', settings: { theme: 'light', language: 'zh-CN' }, tags: ['developer'] }

const profile = await storage.get('profile');
const exists = await storage.has('profile');
const keys = await storage.keys();
const removed = await storage.remove('profile');
await storage.clear();
await storage.close();
```

## 首版行为约定

| 操作 | 行为 | 返回值 |
| --- | --- | --- |
| `set(key, value)` | 新建或完整替换一个 JSON 值 | 写入值的独立快照 |
| `get<T>(key)` | 读取并反序列化 JSON | `T \| undefined`；不存在返回 `undefined` |
| `update(key, patch)` | 对已存在的普通对象进行顶层浅合并 | 合并后的完整对象 |
| `has(key)` | 检查 key 是否存在 | `boolean` |
| `remove(key)` | 删除当前命名空间内的 key | 原来是否存在的 `boolean` |
| `keys()` | 列出当前命名空间的逻辑 key | 排序后的 `string[]` |
| `clear()` | 仅清除当前命名空间 | `void` |
| `close()` | 关闭实例，释放 IndexedDB 连接 | `void`；可重复调用，后续数据操作报错 |

所有方法都返回 Promise。默认后端为 `localStorage`，默认命名空间为 `nexusstorage`；创建实例不立即访问浏览器全局对象。

### JSON 边界

- 支持 `null`、字符串、布尔值、有限数字、JSON 数组、普通 JSON 对象及其嵌套组合。
- 不存在与已存储的 `null` 严格区分。
- 拒绝 `undefined`、函数、Symbol、BigInt、非有限数字、Date、Map、Set、循环引用和稀疏数组；不静默删除字段或改变类型。
- 两种后端共享同一 JSON 校验及序列化规则，不因 IndexedDB 支持额外数据类型而改变公共接口。
- `-0` 按 JSON 规则保存为 `0`；不自动调用输入对象的 `toJSON()`。只读取自有数据属性，拒绝访问器属性，避免校验过程中执行 getter。
- 读写返回独立的数据快照，修改返回对象不会自动改变持久化内容。
- TypeScript 泛型提供静态类型提示，不替代读取数据时的业务 schema 校验。

### 修改规则

- `set` 允许新建，也允许替换数组、对象和标量。
- `update` 仅接受普通对象 patch。嵌套对象和数组作为完整字段值替换，不递归合并。
- 更新不存在的 key、数组、标量或 `null` 时抛出明确错误，不隐式创建数据。
- patch 中的 `null` 是要存储的值，不代表删除字段；同一实例的数据操作按调用顺序执行。
- 对 `__proto__` 等名称按普通数据键处理，不能改变对象原型。

### 存储与异常

- 内部分离公共 API、JSON 编解码、命名空间编码、LocalStorage 适配器和 IndexedDB 适配器。
- 命名空间与逻辑 key 使用无歧义编码，避免包含分隔符的名称相互串读。
- `clear` 不调用会清空整个站点数据的 `localStorage.clear()`。
- IndexedDB 的更新在同一 `readwrite` 事务内完成读取、合并和写入；写入方法在事务完成后才报告成功。
- IndexedDB 处理连接关闭、升级阻塞和事务中止，避免 Promise 无法结束。
- LocalStorage 不承诺跨标签页更新的原子性；本版本不加入跨标签页锁。
- 不同 LocalStorage 实例或标签页同时修改同一个 key 时，可能出现后写覆盖；需要事务保证的并发修改应选择 IndexedDB。
- 导入模块与创建实例不要求存在 `window`，支持 SSR 导入；实际使用不可用的浏览器存储时明确报错。
- 不静默回退到其他后端或内存；配额不足、访问拒绝、数据损坏等错误向调用方报告。
- 统一错误类型保留稳定错误码与原始原因，区分无效值、数据不存在、类型不符、存储不可用和后端操作失败。

## 初始化交付范围

- `package.json`，使用准确的 scoped 包名，初始版本 `0.1.0`。
- 严格 TypeScript 配置与公开类型声明。
- ESM 与 CommonJS 入口，以及分别匹配的类型导出。
- 无运行时依赖；开发依赖仅用于构建、测试和浏览器存储模拟。
- 源码、中文 README、使用示例、`.gitignore`、统一换行与编辑器配置。
- 默认标注 `UNLICENSED`，不代用户授予开源许可；本次不发布 npm，也不建立远程仓库。
- 自动化测试、类型检查、构建和打包消费验证命令。

首版不包含 TTL、加密、数据查询、响应式绑定、监听器、自动迁移或后端自动切换。

## 验证标准

1. 在实现之前编写并运行失败测试，之后实现对应行为。
2. 对两种适配器运行相同的 CRUD、JSON 边界、命名空间隔离测试。
3. 验证空值、错误、损坏数据、更新语义、关闭后行为和 IndexedDB 事务失败。
4. 运行严格类型检查和构建，检查输出类型是否与 JavaScript 入口一致。
5. 从实际 npm 打包产物分别验证 ESM、CommonJS 与 TypeScript 消费，不只检查源码路径。
6. 单独报告模拟存储测试与真实浏览器验证结果，不将模拟测试表述成真实浏览器验证。

## 设计依据

- [MDN：Web Storage API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API)：LocalStorage 的同步特性。
- [MDN：Using IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB)：事务边界与完成事件。
- [TypeScript：Modules Reference](https://www.typescriptlang.org/docs/handbook/modules/reference)：模块入口与类型导出约定。
