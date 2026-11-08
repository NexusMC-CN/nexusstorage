# 第二阶段实现计划

**目标：** 在明确的驱动能力内交付多 key 事务、版本比较提交和提交后事件。

**架构：** 后端提供原子原始记录工作区；公共同步上下文复用 JSON/schema/TTL；事件模块独立于数据提交。没有 Git 元数据，当前项目原地验证，不创建提交或发布。

- [x] 后端原子工作区：新增 RawTransaction、Memory/IDB atomic；先写原子提交、失败不写、scope、异步拒绝的测试并确认失败后实现。
- [x] 记录版本与 TTL null：新增 v2 编解码/legacy revision/随机版本工具，扩展互斥 WriteOptions；旧格式、ABA、显式取消测试先红后绿。
- [x] 事件中心：新增类型和独立模块，局部订阅、可选广播、校验/异常隔离/释放测试先红后绿。
- [x] 能力声明与公共 API：新增 getEntry/CAS/transaction/on，将 JSON/schema/TTL 集中到同步上下文，先公共失败测试再集成。
- [x] 验证与示例：扩展实际 tarball runtime/type 合同、真实 Chromium 并发/事件，更新 README 和 examples/concurrency.ts。
- [x] 独立审查并修复实际问题；npm run check 与真实浏览器通过后打包，记录证据与后续阶段边界。

## 最终验证（2026-11-08）

- `npm run check` exit 0：严格类型检查；474 项单元测试全通过；ESM/CJS 和双格式声明构建；真实 tarball 离线安装后的 ESM/CJS 运行合同与 NodeNext/Bundler 类型正反例均通过。
- Chromium 156.0.8078.4：`node scripts/browser-smoke.mjs` exit 0，312 项检查（保留原有 210 项，新增 102 项）。覆盖双标签页 CAS 竞争、80 次双 key 并发转账、回滚保留值与版本且无通知、同步回调失效、TTL、三驱动跨标签页通知。
- localStorage 通知顺序缺陷先在旧 BC 实现中复现：500 次连续操作出现 7 次陈旧读取；改用原生 storage 事件后同样 500 次为 0。完整浏览器套件保留 200 次连续写入/清除，监听器立即读取断言没有延迟或重试。
- 独立集成审查发现的 3 个事务 Promise 结果边界均修复并复验；公共事务结果限制为提交前 JSON 深快照或 undefined/void，回调退出即禁用公共上下文。
- 实际安装包限定 package.json、README 与 dist，零运行时依赖；本阶段未执行 npm 发布。

Migration、通用批量操作、诊断以及其他路线图扩展不属于本阶段交付，不以旧格式可读代替数据结构迁移能力。
