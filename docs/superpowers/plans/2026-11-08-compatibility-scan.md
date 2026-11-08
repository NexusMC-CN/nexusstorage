# 通知协议兼容与 Cache 扫描一致性修复计划

**目标：** 在已合并 PR #1 的 main 基础上创建新的修复 PR，处理跨版本通知、内部 Cache HTTP 变体及整库正文聚合问题。

**范围：** 三项修复和 Input / Output 文档；诊断、续期和 watch 扩展保留为后续建议。

## 通知兼容

修改 `src/events.ts`，保留 `nexusstorage:events:1:` 控制键，新发送包含 `id: eventId` 以及 `instanceId` / `eventId`。接收时仅在两个新字段都不存在时接受非空旧 `id`，部分新字段或无效新字段不降级；旧格式 ID 和新格式二元组使用独立去重身份空间。既有同页通知、跨页隔离、关闭清理及 Memory 隔离保持原契约。

- [x] 从 `21c6335` 冻结旧事件类为测试 fixture，覆盖旧旧、旧新、新旧、新新组合的双向 change / remove / clear。
- [x] 先运行混合版本失败回归，再实现双格式兼容及分别去重。

## Cache 一致性与逐条扫描

修改 `src/backend/cache.ts` 及测试替身：一个规范逻辑 key 只允许一个内部记录，HTTP 变体不能被任意选取。重复规范 URL 或内部非空 Vary 记录以 `CORRUPT_DATA` 拒绝；读取、枚举和修改采用同一约束，冲突原数据保留。外部 URL / fragment 的既有归属保护继续生效。测试替身应支持真实 Vary 匹配和多个请求变体，并在真实 Chromium 中复核。

将内部后端签名由聚合数组改为同步 visitor：

```ts
scan?(visit: (entry: { key: string; value: string }) => void): Promise<void>;
```

`src/storage/index.ts` 的 `keys()` 在 visitor 内解码与过滤 TTL，只保留键名。后端一次枚举 Request，逐个读取正文并立即交给 visitor；遇到解码错误停止后续正文读取。清理前完成归属与响应头检查，避免部分删除。保留 Request 元数据快照，不缓存全库正文，不宣称垃圾回收时机、实际内存峰值或浏览器内部查询复杂度。

- [x] 复现单个不可规范读取的 Vary 记录；本机 Chromium 两次 put 仅保留最后一条，重复规范 URL 使用明确标注的人工请求快照防御测试，再实现一致拒绝。
- [x] 公共 `keys()` 早停回归已观察 RED：首条 JSON 损坏时旧实现仍读取第二条 128 KiB 正文。
- [x] 改为逐条 visitor，覆盖一轮枚举、TTL、外部保护、错误早停和并发可见性。

## 文档与交付

- [x] README 增加方法 Input / Output 对照表及字符串数字输入、数字 patch 示例，重申浅合并和 patch 不执行输入转换。
- [x] 新增真实浏览器混合版本 / Vary 变体 / 解码早停检查，保留既有 437 项。
- [x] 独立审查完成；`npm run check` 通过（575 项单元测试、构建、真实 tarball 安装运行、NodeNext/Bundler 类型合同）；Chromium 156 通过 494 项检查（437 项原有、57 项本轮回归）。

验证完成后提交、推送 `fix/storage-protocol-cache` 分支并创建新的 PR，附上最终验证结果。
