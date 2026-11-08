# NexusStorage

`@nexusmc-cn/nexusstorage` · `v0.1.0`

为 Memory、localStorage、sessionStorage、IndexedDB 与 Cache Storage 提供统一的异步 JSON 键值接口。直接传入、读取对象或数组，无需自行调用 `JSON.stringify` / `JSON.parse`。

- TypeScript 编写，提供 ESM、CommonJS 及对应类型声明。
- 无运行时依赖。
- `set` 完整替换，`update` 对普通对象进行顶层浅合并。
- 命名空间隔离，读写返回独立的数据快照。
- 支持按记录设置 TTL 或到期时间，以及按 key 配置同步 Standard Schema V1 校验与类型推导。
- Memory 与 IndexedDB 支持多 key 原子事务及版本比较写入（CAS）；五种后端均可订阅提交后的变更事件。
- 每个功能可独立选择后端，通过相同的方法读写 JSON 数据。

## 安装

本项目尚未发布到 npm。以下 registry 安装命令仅在发布后适用：

```sh
npm install @nexusmc-cn/nexusstorage
```

当前可在项目目录安装开发依赖、构建并生成本地安装包：

```sh
npm ci
npm run build
npm pack
```

随后在消费项目中安装生成的 tarball：

```sh
npm install /path/to/nexusmc-cn-nexusstorage-0.1.0.tgz
```

## 基本用法

在浏览器中执行数据操作：

```ts
import { NexusStorage } from '@nexusmc-cn/nexusstorage';

interface Profile {
  name: string;
  settings: { theme: 'light' | 'dark'; language: string };
  tags: string[];
}

const storage = new NexusStorage({
  driver: 'localStorage', // 也支持 'memory'、'sessionStorage'、'indexedDB'、'cacheStorage'
  namespace: 'my-app',
});

try {
  await storage.set<Profile>('profile', {
    name: 'Alex',
    settings: { theme: 'light', language: 'zh-CN' },
    tags: ['developer'],
  });

  const updated = await storage.update<Profile>('profile', { name: 'Sam' });
  // { name: 'Sam', settings: { theme: 'light', language: 'zh-CN' }, tags: ['developer'] }

  const profile = await storage.get<Profile>('profile'); // Profile | undefined
  const exists = await storage.has('profile');          // true
  const keys = await storage.keys();                    // ['profile']
  const removed = await storage.remove('profile');      // true
  await storage.clear();
} finally {
  await storage.close();
}
```

CommonJS 也可使用相同 API：

```js
const { NexusStorage } = require('@nexusmc-cn/nexusstorage');
const storage = new NexusStorage();
```

完整示例见 [`examples/basic.ts`](examples/basic.ts)。

## 按站点功能选择后端

为每个功能创建实例，用 `driver` 选择后端，用 `namespace` 隔离数据。已有的实例配置即可表达这些选择，无需额外的工厂或全站注册表：

```ts
const preferences = new NexusStorage({ driver: 'localStorage', namespace: 'preferences' });
const checkout = new NexusStorage({ driver: 'sessionStorage', namespace: 'checkout' });
const drafts = new NexusStorage({ driver: 'indexedDB', namespace: 'drafts' });
const offline = new NexusStorage({ driver: 'cacheStorage', namespace: 'offline-data' });

try {
  await preferences.set('theme', 'dark');
  await checkout.set('cart', { itemIds: ['book-1'], quantity: 1 });
  await drafts.set('article', { title: '草稿', body: '尚未发布' });
  await offline.set('last-result', { items: ['a', 'b'], savedAt: Date.now() });
} finally {
  await Promise.all([preferences.close(), checkout.close(), drafts.close(), offline.close()]);
}
```

| 后端 | 数据生命周期 | 页面 / Worker | 更新的事务边界 |
| --- | --- | --- | --- |
| `memory` | 仅当前实例；`close()` 后释放 | 浏览器、Worker 与 Node.js / SSR | 同一实例内的事务 / CAS；实例间不共享 |
| `localStorage` | 跨刷新、跨页面会话保留 | 页面可用；Worker 不可用 | 无跨实例原子读改写 |
| `sessionStorage` | 标签页的页面会话；刷新保留，页面会话结束后清除 | 页面可用；Worker 不可用 | 无跨实例原子读改写 |
| `indexedDB` | 跨刷新、跨页面会话保留 | 页面与 Worker 可用 | `update`、多 key 事务与 CAS 在数据库读写事务中完成 |
| `cacheStorage` | 跨刷新、跨页面会话保留 | 安全上下文中的页面与 Worker 可用，无需先注册 Service Worker | 无跨实例原子读改写 |

四种浏览器后端受浏览器的访问策略、配额、用户清理与数据回收策略约束。`sessionStorage` 遵循浏览器原生页面会话规则：独立新标签页使用独立会话；有 opener 的新页面可能先获得初始副本，之后各自独立。

四种浏览器后端中，同源、同后端、同 `namespace` 的实例访问相同数据；`sessionStorage` 还受所在标签页的页面会话限制。同名 `namespace` 位于不同后端时互不影响。选择 `cacheStorage` 的页面与 Service Worker 可通过相同 `namespace` 双向读写 JSON 数据。完整功能示例见 [`examples/features/index.ts`](examples/features/index.ts)。

`memory` 使用实例私有的数据空间；即使 `namespace` 相同，不同实例也不共享数据。应用需要共享内存数据时应复用实例；SSR 建议每个请求创建实例，并在请求结束后关闭，以隔离用户数据。Memory 不提供跨刷新、跨进程或进程重启后的持久化。

## 在 Service Worker 中使用

Cache Storage 在安全上下文中可直接从页面或 Worker 使用，不强制依赖 Service Worker。这个适配器沿用本包的 JSON 键值接口；应用的静态资源缓存、`Request` / `Response` 与网络策略由应用自行管理。本包不会注册 Service Worker、拦截 `fetch` 或自动预缓存资源。

在应用已有的 Service Worker 中，将数据操作和关闭实例的 Promise 交给 `event.waitUntil()`，以覆盖事件任务的完整生命周期。页面使用 `new NexusStorage({ driver: 'cacheStorage', namespace: 'offline-data' })` 即可访问同一数据空间。可由应用的构建工具编译打包的完整示例见 [`examples/worker/service.ts`](examples/worker/service.ts)。

`clear()` 仅移除该命名空间内由本包管理的 JSON 记录，保留其他 Cache Storage 缓存与非本包记录。应用清理自己的资源缓存时，也应只删除自己明确管理的缓存名。

Cache API 的原生 URL 匹配会忽略 `#` 片段。如果同一命名缓存中存在与内部记录 URL 冲突的非规范外部条目，相关读写以 `CORRUPT_DATA` 拒绝，避免误读、覆盖或删除外部数据。

## 配置与方法

```ts
const storage = new NexusStorage();
// 等同于 new NexusStorage({ driver: 'localStorage', namespace: 'nexusstorage' })
```

| 配置项 | 类型 | 默认值 |
| --- | --- | --- |
| `driver` | `'memory' \| 'localStorage' \| 'sessionStorage' \| 'indexedDB' \| 'cacheStorage'` | `'localStorage'` |
| `namespace` | `string` | `'nexusstorage'` |
| `schemas` | 按 key 配置的 Standard Schema V1 对象 | 无业务校验 |
| `broadcast` | `boolean`；仅 localStorage / IndexedDB / Cache Storage 支持 | `false` |

五种后端的数据方法都返回 Promise，订阅方法 `on` 同步返回取消订阅函数。逻辑 key 必须是字符串。默认后端仍为 `localStorage`，原有普通 JSON 与 v1 有效期记录保持可读；驱动不支持的原子操作以 `UNSUPPORTED_OPERATION` 拒绝。

| 方法 | 行为 | Promise 返回值 |
| --- | --- | --- |
| `set(key, value, options?)` | 新建或完整替换 JSON 值，可设置有效期 | 写入值的独立快照；配置 schema 时为校验输出 |
| `get<T>(key)` | 读取 JSON 值 | `T \| undefined`，缺失时为 `undefined` |
| `getEntry<T>(key)` | 读取值、不透明版本与可选到期时间 | `StorageEntry<T> \| undefined` |
| `update<T>(key, patch, options?)` | 浅合并已存在的普通对象，可重新设置有效期 | 合并后的完整对象；配置 schema 时为校验输出 |
| `has(key)` | 检查未过期的 key 是否存在 | `boolean` |
| `remove(key)` | 删除 key，包括已过期的记录 | 删除前物理记录是否存在的 `boolean` |
| `keys()` | 列出当前命名空间未过期的逻辑 key | 排序后的 `string[]` |
| `clear()` | 清除当前命名空间的数据 | `void` |
| `compareAndSwap(key, revision, value, options?)` | 仅 Memory / IndexedDB；版本匹配时完整替换 | 新的 `StorageEntry` |
| `transaction(keys, callback)` | 仅 Memory / IndexedDB；原子执行预声明 key 上的同步回调 | 回调 JSON 结果的独立快照，或 `undefined` |
| `close()` | 关闭实例，释放 IndexedDB 连接或实例内存 | `void` |

`clear()` 仅作用于当前后端、当前命名空间，不调用 Web Storage 的全量 `clear()` 清空整个站点。命名空间和逻辑 key 可以包含分隔符，不会因此串读其他命名空间。

`close()` 等待此前已排队的数据操作结束，然后清理订阅和广播通道，可以重复调用。开始关闭后，新的数据操作以 `CLOSED` 拒绝；再次使用需要创建新实例。

每个实例公开冻结的 `capabilities`，可在操作前查看驱动的设计能力；这些声明不检查当前平台是否提供对应 API：

| 后端 | `transactions` / `compareAndSwap` | `atomicity` | `persistent` | `crossTab` / `broadcast` |
| --- | --- | --- | --- | --- |
| `memory` | `true` | `'instance'` | `false` | `false` |
| `indexedDB` | `true` | `'database'` | `true` | `true` |
| `localStorage` | `false` | `'none'` | `true` | `true` |
| `sessionStorage` | `false` | `'none'` | `false` | `false` |
| `cacheStorage` | `false` | `'none'` | `true` | `true` |

`persistent` 只表示后端设计上可跨页面会话保留数据，不表示浏览器已授予持久化权限，也不保证数据永不丢失。`broadcast` 表示可支持广播，实际启用仍须传入 `{ broadcast: true }`。

## TTL 与到期时间

所有后端均支持在 `set` 或 `update` 的第三个参数中指定有效期：

```ts
await storage.set('session', { userId: 'user-1' }, { ttl: 30_000 });
await storage.set('report', { ready: true }, { expiresAt: Date.now() + 60_000 });

await storage.update('session', { userId: 'user-2' }); // 保留原到期时间
await storage.update('session', { userId: 'user-3' }, { ttl: 30_000 }); // 重设有效期
await storage.update('session', { userId: 'user-3' }, { ttl: null }); // 显式取消有效期
await storage.set('session', { userId: 'user-4' }); // 完整替换并取消原有效期
```

`ttl` 的单位为毫秒，从该次排队写入开始执行时计算；`expiresAt` 是 Unix 时间戳，单位同样为毫秒。数值必须非负、有限且不大于 `Number.MAX_SAFE_INTEGER`；计算出的到期时间也须在该范围内。`ttl: 0` 表示立即过期，`ttl: null` 显式取消有效期，`expiresAt: null` 无效。二者互斥，`{ ttl: null, expiresAt: ... }` 同样无效。无效选项以 `INVALID_OPTIONS` 拒绝。`set` 与 CAS 默认取消原期限，`update` 未提供有效期选项时保留原期限。

到达期限时，`get` 返回 `undefined`、`has` 返回 `false`、`keys` 隐藏该 key，`update` 返回 `NOT_FOUND`。本包不启动清理定时器，也不在读取时删除记录；过期数据可能继续占用后端空间，可通过 `remove` 或 `clear` 清理。`remove` 按物理记录是否存在返回布尔值，因此删除已过期但尚未清理的记录仍可返回 `true`。

本包自动编解码有效期和版本元数据。业务对象中的 `value`、`version`、`revision`、`expiresAt` 等字段仍是普通字段，不会被当作记录配置。Memory 与 IndexedDB 的新写入使用带版本的 v2 格式，即使没有有效期也需要由支持 v2 的新版客户端读取；其他后端继续使用普通 JSON 或 v1 有效期记录。

## 多 key 事务

`transaction(keys, callback)` 先复制、去重预声明的 key，再在当前驱动、当前命名空间内原子执行回调。Memory 的原子性仅覆盖当前实例；IndexedDB 使用单个数据库读写事务，可协调共享该命名空间的实例。其他三种驱动不支持该方法。

```ts
const balances = new NexusStorage({ driver: 'memory', namespace: 'balances' });
try {
  await balances.set('alice', 10);
  await balances.set('bob', 0);
  const total = await balances.transaction(['alice', 'bob'], tx => {
    const alice = tx.get<number>('alice')!;
    const bob = tx.get<number>('bob')!;
    tx.set('alice', alice - 3);
    tx.set('bob', bob + 3);
    return alice + bob;
  });
  // total === 10；两项修改已全部提交
} finally {
  await balances.close();
}
```

外层方法返回 Promise，回调及 `tx.get / has / set / update / remove` 均同步执行。回调可以返回 JSON 数据或 `undefined`，返回的 JSON 结果在提交前复制为独立快照；Date、函数等非 JSON 返回值以 `INVALID_VALUE` 拒绝并回滚。

回调不可使用 `async`、返回 Promise 或 thenable；返回对象自身或继承的 `then` 访问器也会被拒绝，且不会执行该 getter。这些情况在提交前以 `ASYNC_TRANSACTION` 拒绝。需要网络请求等异步准备时，应在调用事务之前完成。

所有访问必须位于 `keys` 范围内，否则为 `INVALID_KEY`；回调结束后 `tx` 立即失效，保留后再调用会得到 `TRANSACTION_INACTIVE`。回调抛错、JSON / Schema 校验失败或异步返回均回滚整个事务，不发送变更事件。读写遵循相同的快照、浅合并和 TTL 规则；配置 schema 时，`tx` 按 key 推导输入、输出与 patch 类型。

## 版本读取与 CAS

`getEntry(key)` 在五种驱动上返回 `{ value, revision, expiresAt? }`，缺失或到期时返回 `undefined`。`revision` 是不透明字符串，应用应原样保存并传回，不应解析其格式或把它视为业务值的哈希；历史普通 JSON / v1 记录也能获得版本标识。

```ts
const counters = new NexusStorage({ driver: 'memory', namespace: 'counters' });
try {
  const created = await counters.compareAndSwap('count', null, 0);
  const next = await counters.compareAndSwap('count', created.revision, 1);
  // next.value === 1；next.revision 是新版本
  const latest = await counters.getEntry<number>('count');
} finally {
  await counters.close();
}
```

CAS 仅支持 Memory / IndexedDB；`expectedRevision: null` 表示逻辑不存在，可新建或替换已到期的记录。字符串版本与当前记录不匹配时以 `CONFLICT` 拒绝，不写入也不发事件。CAS 是完整替换，其有效期选项与 `set` 一致；`get` 继续仅返回业务值。

Memory / IndexedDB 的每次新写入都会产生独立版本；相同值替换、删除后重建也不会复用旧版本。这项并发保证覆盖使用新版 API 协作写入的数据；直接修改底层或让旧客户端回写不在保证范围内。完整的 Schema 事务与 CAS 示例见 [`examples/concurrency.ts`](examples/concurrency.ts)。

## 变更订阅与广播

`on('change' | 'remove' | 'clear', listener)` 同步返回取消订阅函数：

```ts
const shared = new NexusStorage({
  driver: 'indexedDB', namespace: 'shared-data', broadcast: true,
});
const unsubscribe = shared.on('change', event => {
  console.log(event.operation, event.key, event.source);
  // 需要业务值时，使用 shared.get(event.key!) 重新读取。
});
try {
  await shared.set('message', { text: 'hello' });
} finally {
  unsubscribe();
  await shared.close();
}
```

事件只包含 `type`、`operation`、可选 `key`、`driver`、`namespace` 和 `source: 'local' | 'remote'`，不携带业务值。成功提交的 `set / update / compareAndSwap` 发送 `change`；实际删除发送 `remove`；`clear` 成功后发送一个 `clear`。事务在全部提交后按每个 key 的最终修改合并通知；失败事务无通知。监听器抛错或异步拒绝不改变已经提交的结果，TTL 到期不会主动发送删除事件。

默认仅通知当前实例。localStorage、IndexedDB 与 Cache Storage 可显式启用 `broadcast: true`，向同源、同驱动、同命名空间的订阅实例传播元数据；接收方重新读取存储。localStorage 使用浏览器的存储事件传递本包通知，IndexedDB 与 Cache Storage 使用 BroadcastChannel。Memory 与 sessionStorage 不支持跨独立标签页广播，传入 `broadcast: true` 会得到 `INVALID_OPTIONS`。通知所需的监听或通道在订阅或写入前惰性建立，相应平台 API 缺失时为 `STORAGE_UNAVAILABLE`。

localStorage 的跨上下文通知仅到达其他 window；浏览器不会把原生存储事件发送回写入所在的 window。写入实例仍收到自己的 `local` 事件，同一 window 内的其他实例不会因此收到 `remote` 事件；需要共享这类订阅时应复用实例。

广播消息不持久化，也不提供锁或事务保证；外部直接调用浏览器原生存储 API 不会自动产生本包事件。

## 按 key 配置 Schema

传入符合 Standard Schema V1 结构的校验器即可启用运行时校验，无需为本包安装额外运行时依赖。以下示例同时展示输入 / 输出推导和同步转换：

```ts
import { NexusStorage } from '@nexusmc-cn/nexusstorage';
import type { StandardSchemaV1 } from '@nexusmc-cn/nexusstorage';

const countSchema: StandardSchemaV1<string | number, number> = {
  '~standard': {
    version: 1,
    vendor: 'my-app',
    validate(value) {
      const count = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
      return Number.isFinite(count)
        ? { value: count }
        : { issues: [{ message: '需要有限数字或数字字符串' }] };
    },
  },
};

const counters = new NexusStorage({
  driver: 'memory',
  schemas: { count: countSchema },
});

try {
  const written = await counters.set('count', '42', { ttl: 60_000 }); // number
  const read = await counters.get('count'); // number | undefined
  // counters.set('count', false); // 类型错误：输入必须为 string | number
  // counters.get('unknown');      // 类型错误：未声明的 key
} finally {
  await counters.close();
}
```

配置 `schemas` 的 TypeScript 实例将 key 限定为已声明项。`set` 与 CAS 接受对应 schema 的输入类型，读取、写入和事务方法按 key 返回输出类型；`getEntry` 与 CAS 用 `StorageEntry` 包装输出。`update` 的 patch 使用输出对象的 `Partial` 类型，并对浅合并后的完整对象执行校验。对象更新、TTL 与 Schema 组合示例见 [`examples/features/managed.ts`](examples/features/managed.ts)。公开类型还包括 `StorageSchemas`、`InferSchemaInput`、`InferSchemaOutput`、`WriteOptions`、`StorageCapabilities`、`StorageTransaction` 和 `StorageEvent`。

输入在校验前捕获严格 JSON 快照，转换结果再次检查并复制，输入和输出均须符合下述 JSON 规则。`get` 会重新校验已存储的数据，包括历史数据；转换后的输出应能再次作为该 schema 的输入，并在重复校验时保持稳定。业务校验失败或校验器抛错返回 `VALIDATION_ERROR`，不符合 JSON 规则返回 `INVALID_VALUE`，失败不会覆盖旧值。

当前仅执行同步 schema 校验。返回 Promise 或 thenable 的校验器以 `ASYNC_SCHEMA` 拒绝；异步校验应在写入前由应用完成。配置只读取自身的 schema 项并在构造时复制；后续修改原 map 不改变实例配置。JavaScript 仍可读写未配置 schema 的 key，此类 key 只执行 JSON 校验。`keys()` 检查记录格式与有效期，不执行业务 schema 校验。

## JSON 值规则

支持 `null`、字符串、布尔值、有限数字、JSON 数组、普通 JSON 对象及其嵌套组合。普通对象可以具有 `Object.prototype` 或空原型。

以下输入会被拒绝，不会静默删除字段或自动改变类型：

- `undefined`、函数、Symbol、BigInt、`NaN` 和正负无穷。
- Date、Map、Set、自定义类实例和循环引用。
- 稀疏数组、带额外属性的数组、Symbol 属性键和访问器属性。

校验只读取对象自身的数据属性，不调用 getter 或 `toJSON()`。`-0` 按 JSON 规则保存为 `0`。五种后端采用相同的 JSON 规则，即使 IndexedDB 原生支持更多类型，也不会放宽这些限制。

不存在的数据与存储的 `null` 严格区分：

```ts
await storage.set('empty', null);
await storage.get('empty');  // null
await storage.has('empty');  // true
await storage.get('absent'); // undefined
await storage.has('absent'); // false
```

## 更新与快照

`update` 仅接受普通对象 patch，目标也必须是已存在的普通对象。缺失 key 报 `NOT_FOUND`，数组、标量或 `null` 目标报 `TYPE_MISMATCH`，不会隐式创建对象。

合并只在顶层进行；嵌套对象和数组作为完整字段值替换。patch 中的 `null` 是要存储的值，不代表删除字段：

```ts
await storage.set('preferences', {
  settings: { theme: 'light', language: 'zh-CN' },
  tags: ['a', 'b'],
  note: 'hello',
});

await storage.update('preferences', {
  settings: { theme: 'dark' },
  tags: ['c'],
  note: null,
});
// { settings: { theme: 'dark' }, tags: ['c'], note: null }
```

`set` 和 `update` 在调用时捕获输入快照。调用后修改输入，不会改变已提交操作的内容。`set`、`get` 和 `update` 返回独立的对象或数组；修改返回值不会自动写回存储。需要持久化修改时，应再次调用 `set` 或 `update`。

未配置 schema 时，TypeScript 仍支持用 `interface` 描述对象，`get<Profile>` 等泛型提供静态类型提示。泛型本身不会执行业务校验，也不能验证历史数据是否符合 `Profile`；需要运行时业务校验时可配置 `schemas`。JSON 运行时校验始终执行。

## 时序、浏览器与 SSR

同一实例的数据操作按调用顺序执行，单次失败不会阻止后续操作。localStorage 与 sessionStorage 底层仍是同步 API，统一的 Promise 接口不会把它们移到后台线程。

localStorage、sessionStorage 与 Cache Storage 不提供跨实例更新的原子性。能访问同一数据的多个实例、标签页或 Worker 同时修改同一个 key，可能出现后写覆盖。同一实例的顺序队列不等于跨上下文锁；需要事务内读改写时可选择 IndexedDB。

IndexedDB 的 `update` 在同一 `readwrite` 事务中读取、合并并写入。写入操作在事务完成后才报告成功，事务中止会报告错误。

模块导入和实例构造不访问浏览器存储，因此可以用于 SSR 导入。选择 `memory` 可直接在 Node.js / SSR 中读写；选择四种浏览器后端时，实际数据操作依赖相应浏览器 API，API 缺失时以 `STORAGE_UNAVAILABLE` 拒绝。访问被禁止、配额不足等失败也会向调用方报告，不会自动回退到另一后端或内存存储。

浏览器支持范围应以应用实际验证为准。本项目的存储模拟测试不等同于真实浏览器兼容性验证。

## 错误处理

操作失败时使用 `NexusStorageError`。`code` 用于稳定识别错误类别；存在底层原始错误时，`cause` 保留其原因，错误消息不作为稳定的判断接口。

```ts
import { NexusStorageError } from '@nexusmc-cn/nexusstorage';

try {
  await storage.update('missing', { name: 'Sam' });
} catch (error) {
  if (error instanceof NexusStorageError) {
    console.error(error.code, error.cause);
  } else {
    throw error;
  }
}
```

| 错误码 | 含义 |
| --- | --- |
| `INVALID_OPTIONS` | 构造配置或写入有效期选项无效 |
| `INVALID_KEY` | key 不是字符串，或超出事务预声明范围 |
| `INVALID_VALUE` | 输入不符合 JSON 值规则 |
| `VALIDATION_ERROR` | 业务 schema 校验失败或校验器抛错 |
| `ASYNC_SCHEMA` | schema 返回 Promise 或 thenable，当前仅支持同步校验 |
| `ASYNC_TRANSACTION` | 事务回调返回 Promise 或 thenable，必须同步执行 |
| `TRANSACTION_INACTIVE` | 回调结束后继续使用事务上下文 |
| `CONFLICT` | CAS 的期望版本与当前记录不匹配 |
| `UNSUPPORTED_OPERATION` | 所选驱动不支持事务或 CAS |
| `NOT_FOUND` | 更新的 key 不存在或已经到期 |
| `TYPE_MISMATCH` | 更新的目标或 patch 不是普通对象 |
| `CORRUPT_DATA` | 已存储的数据或有效期 / 版本记录格式损坏、不受支持 |
| `STORAGE_UNAVAILABLE` | 所选存储 API 不可用 |
| `STORAGE_ERROR` | 配额不足、事务中止等后端操作失败 |
| `DATABASE_BLOCKED` | IndexedDB 升级被其他连接阻塞 |
| `CLOSED` | 实例已开始关闭 |

## 开发与验证

源码按职责分类：`src/storage/` 管理公共 API 与实例行为，`src/backend/` 提供后端接口和实现，`src/backend/web/` 复用 Web Storage 逻辑，`src/record/` 处理记录格式与上下文。`tests/` 按相同职责分组，测试替身放在 `tests/helpers/`；`examples/features/` 和 `examples/worker/` 分别放置功能组合与 Worker 示例。

TypeScript 文件名使用单词或驼峰写法，复合职责通过子目录表达，避免使用连字符 `-`。

开发工具建议使用 Node.js 22 或更高版本。Memory 可在浏览器与 Node.js 使用，其他后端面向提供相应 API 的浏览器环境；核心包无运行时依赖。

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run test:consumer
```

`npm run check` 依次执行类型检查、单元测试、构建与打包消费验证。消费检查对真实 tarball 进行离线安装，分别验证 ESM、CommonJS 和 NodeNext / Bundler 类型声明，覆盖五种后端、Memory 实例隔离、TTL / Schema、能力声明、版本读取、Memory / IndexedDB CAS 与事务提交 / 回滚，以及提交后事件；类型反例验证非法 JSON、Schema key / patch、异步事务回调与有效期互斥规则。浏览器 API 在该消费检查中使用测试替身，IndexedDB 使用 `fake-indexeddb`。`npm run test:consumer` 要求先完成构建。

浏览器检查需要先安装 Playwright 对应的 Chromium：

```sh
npx playwright install chromium
npm run test:browser
```

已有 Chromium 时，可将环境变量 `NEXUSSTORAGE_BROWSER_EXECUTABLE` 设为其可执行文件的绝对路径，再运行 `npm run test:browser`，以使用该浏览器。

2026-11-08 新功能加入前的历史验证记录：Chromium `156.0.8078.4` 通过 54 项浏览器检查，覆盖四种浏览器后端的数据操作与刷新后保留、sessionStorage 的独立标签页会话隔离、Cache Storage 跨标签页共享、页面 / 真实模块 Service Worker 双向 JSON 读写和外部 fragment 条目保护，以及 IndexedDB 跨两个标签页的 24 次并发 patch。该历史记录不包含 Memory、TTL 与 Schema，不承诺所有浏览器版本的兼容性。

2026-11-08 第一阶段历史验证：同一 Chromium 版本通过 210 项浏览器检查，保留上述覆盖，并验证五种驱动的 TTL 临界判断、更新保留 / 重设期限、同步 Schema 校验失败保留旧值、异步校验拒绝、Memory 实例与刷新隔离，以及带期限和 Schema 的跨标签页并发更新。真实 Service Worker 可读取带有效期的记录格式。该历史记录不包含第二阶段事务、CAS 与事件，测试结果仅对应当时环境。

2026-11-08 第二阶段验证：Chromium `156.0.8078.4` 通过完整 312 项浏览器检查，其中保留上述 210 项，新增 102 项能力声明、事务、CAS、TTL 取消与事件检查。验证包括真实双标签页 IndexedDB CAS 竞争、80 次并发双 key 转账的总额守恒、Schema / 异步回调失败回滚与事件静默、事务上下文失效，以及三种共享驱动的跨标签页元数据通知和提交后重新读取。完整检查包含 200 次连续 localStorage 写入 / 清除后的立即读取；另行执行的 500 次顺序变更复现检查未发现陈旧读取。结果仅对应本次环境，不代表其他浏览器版本均已验证。

Migration、通用批量操作与诊断工具保留在后续路线图，当前未实现。当前也不包含加密、查询、响应式绑定、持久队列、文件扩展或后端自动切换。

## 许可

本项目采用 [MIT License](LICENSE)，沿用远程仓库已有的许可与版权声明。
