# 第二阶段：能力声明、事务、CAS 与事件

承接已授权的分阶段建设和用户最新建议。本阶段交付事务/并发控制/事件，补充显式取消 TTL。Migration、通用批量和诊断分别保留在后续路线图，不将浏览器驱动的能力差异隐藏。

## 兼容性与能力

保持 set 完整替换且默认取消有效期，update 浅合并且默认保留期限；新增 `{ ttl: null }` 显式取消期限，ttl/expiresAt 仍互斥。到期 update 仍 NOT_FOUND；CAS 以 null 期望版本可以新建或覆盖逻辑已过期记录。

实例公开冻结的 capabilities：transactions、compareAndSwap、persistent、crossTab、broadcast 布尔值，atomicity 为 instance/database/none。Memory transactions/CAS=true、atomicity=instance；IDB=true/database；其余=false/none。persistent 仅表示跨页面会话保留的存储设计，不是浏览器授予持久化权限或永不丢失的承诺。crossTab/broadcast 仅 localStorage/IDB/Cache=true；Memory/session=false。平台支持仍在实际操作时检查。

## 多 key 事务

`transaction(keys, callback): Promise<T>`，预声明字符串 key 数组，复制并去重，仅当前驱动/namespace。callback 同步运行，tx.get/has/set/update/remove 为同步方法；输入输出与 schema、TTL 保持一致，所有 key 必须在 keys 范围中。回调结束后 tx 立即失效（TRANSACTION_INACTIVE），然后检查结果；返回 Promise/thenable 或 then 访问器以 ASYNC_TRANSACTION 拒绝，观察原生 Promise 拒绝且不执行 then getter。结果仅允许 JSON 或 undefined/void，提交前复制独立 JSON 快照，其他结果 INVALID_VALUE 并回滚。结果反射操作也只能访问失效的公共 tx，避免 Proxy 在回调结束后继续修改工作区。

后端扩展可选 `atomic<T>(keys, transform): Promise<T>`；transform 接收 RawTransaction（get/set/remove）。Memory 在私有快照上执行，成功后一并提交；IDB 在单个 readwrite 事务中读取所有声明 key，在最后请求回调内同步执行 transform 并提交暂存写集，只在 oncomplete resolve。异常/校验失败/异步回调不提交任何数据和事件。其他驱动 UNSUPPORTED_OPERATION，不能以顺序 Promise 模拟原子性。

## CAS 与记录版本

`getEntry(key)` 返回 `{ value, revision, expiresAt? } | undefined`，revision 为不透明字符串；普通 get 仍仅返回 JSON 值。原始旧 JSON/v1 TTL 记录的 revision 以精确原始快照标识（legacy:raw）；新 Memory/IDB 写入均带独立随机版本，防止删除重建/相同值替换造成 ABA。CAS 保证只覆盖由本版本 API 协作写入的数据；直接改底层或旧客户端回写不在保证内。

`compareAndSwap(key, expectedRevision, value, options?)` 仅 Memory/IDB；expectedRevision 为 string/null，null 表示逻辑不存在。事务内检查版本，冲突 CONFLICT，不写入也不发事件；成功返回 StorageEntry。CAS 是完整替换，TTL 默认同 set。新记录格式 `NexusStorage/2\n` 加 `{value,revision,expiresAt?}`；decode 继续兼容原始 JSON 与 v1，严格拒绝损坏/未知格式，不识别用户对象的同名字段。

## 存储事件

`on('change'|'remove'|'clear', listener)` 返回取消订阅函数。事件只含 type/operation/key?、driver/namespace、source(local/remote)，无业务值。set/update/CAS 成功后 change，remove 实际删除后 remove，clear 成功后一个 clear；事务将修改按最终每个 key 合并，全部提交后发送；失败事务无通知。监听器抛错或异步拒绝不改变已提交操作的结果。TTL 到期不主动触发 remove。

`broadcast: true` 显式启用跨上下文通知，仅 localStorage/IDB/Cache 支持。IDB/Cache 使用按 driver+namespace 版本化命名的 BroadcastChannel；localStorage 使用原生 window storage 事件，提交后向数据命名空间之外的专属控制 key 写入仅含元数据的通知信封并移除。控制 key 的通知沿同一存储事件流投递，避免 Chromium 中 BroadcastChannel 先于 localStorage 缓存可见的实测竞态，不将延迟或重试当作一致性保证。localStorage 不向同一个 window 的其他实例发送远端事件，遵循原生 storage 规则。构造不访问浏览器全局，订阅或写入前惰性建立监听/通道，缺失 STORAGE_UNAVAILABLE。

未启用时只有当前实例事件；Memory 不允许跨实例共享，session 不跨独立标签页传播。消息格式与作用域严格校验，不重复广播，外部原生 API 写入不会自动通知。通知是尽力投递，不持久化，不是锁；发布失败不改变已经提交的结果，接收方重新读取最新存储而非历史快照。close 等待已排队操作后释放监听/通道并清理订阅。

浏览器语义参考：[HTML Web Storage](https://html.spec.whatwg.org/multipage/webstorage.html)、[MDN storage 事件](https://developer.mozilla.org/en-US/docs/Web/API/Window/storage_event)。支持范围仍以实际验证结果为准。

## 验证

TDD 覆盖旧格式/TTL null、原子提交回滚/并发/失效tx/异步回调、CAS冲突/到期/删除重建/相同值版本、事件提交后顺序/失败无事件/取消/异常隔离/通道作用域与关闭。打包后 ESM/CJS 与 NodeNext/Bundler 类型正反例；真实 Chromium 多标签页竞争 CAS、事务转账、广播读取、原有 SW/TTL/schema 回归。
