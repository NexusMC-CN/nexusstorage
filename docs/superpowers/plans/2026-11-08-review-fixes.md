# 存储审查反馈修复计划

**目标：** 修复用户列出的五类正确性与枚举开销问题，在独立修复分支向 main 创建 PR。

**范围：** Schema、事件订阅/同页传播、Cache 枚举与媒体类型。路径 API、Collection、过期物理清理、业务迁移仅为后续建议，不混入本次修复。TypeScript 文件使用现有目录分类与无连字符命名。

## Schema 语义

保留 schemas 的输入/输出推导，增加可选 storedSchemas 映射：key 限定为已配置输入 Schema 的 key，类型绑定为输入 Schema 的 Output。set/CAS/tx.set 执行输入转换，然后验证结果可作为存储值；get/getEntry/tx.get 与 update/tx.update 合并后仅验证存储值。存储校验不得改变 JSON 值，结构比较忽略对象属性顺序；返回变化以 VALIDATION_ERROR 拒绝，绝不采用二次转换结果。

未配置 storedSchemas 时复用对应输入 Schema 作为存储校验器，以兼容幂等的既有校验器；不可往返或非幂等转换必须在写入前失败，并指导提供独立 storedSchemas。读取历史记录仍校验、不重写；失败写入保留值、期限和版本且不发布事件。显式输入转换在读取及 patch 更新时不再运行。参考 [Standard Schema](https://standardschema.dev/schema) 的 Input / Output 区分。

## 事件语义

每次 on 调用独立订阅，同一回调重复订阅会调用多次，各句柄只取消自身。localStorage 的 broadcast:true 实例使用按当前 Window + namespace 分组的页内注册表；Memory/session 仍不共享。通知信封包含 instanceId/eventId，页内派发与原生 storage 通知去重，不回声，关闭释放注册。IDB/Cache 保留 BroadcastChannel，继续只发送元数据。未启用广播仍只通知当前实例。原生 storage 保留跨页顺序修复。

## Cache 语义

后端增加可选 scan(): Promise<Array<{ key: string; value: string }>>，公开 keys 对支持 scan 的后端一次集中读取并过滤过期项，避免每 key 再枚举。Cache clear 一次枚举及归属/fragment 冲突分析后删除；单 key get/set/remove 冲突查询通过 Cache.keys(request, { ignoreVary: true }) 缩小返回集合，同时避免 Vary 隐藏 fragment 冲突，不承诺浏览器内部 O(1)。不长期缓存枚举结果，保留跨实例可见性与非本包条目保护。

普通 JSON 的 Response 保持 application/json；NexusStorage 前缀内部记录使用 application/x.nexusstorage-record; charset=utf-8，旧格式继续由本包解码。

## 执行与验证

- [x] Schema：先复现 string→length、number+1、对象字段重复转换，再实现 storedSchemas 与输出校验，覆盖五驱动及 IDB/Memory 事务/CAS。
- [x] 事件：先复现重复订阅的旧句柄误删；补同页/跨页、取消/关闭/隔离/去重回归，再实现。
- [x] Cache：计数测试验证公开 keys / clear 无 N+1 全库枚举；保留冲突保护、并发可见性和实际 Response 类型测试。
- [x] 集成：README、类型合同和真实 tarball 验证新契约，真实 Chromium 验证新增行为及原有 312 项回归。
- [x] 独立审查及最终验证：npm run check 通过（535 项单元测试、ESM/CJS 构建、真实 tarball 离线安装运行、NodeNext/Bundler 类型合同）；Chromium 156 通过 437 项检查（312 项原有检查、125 项本次回归）。

验证完成后提交、推送修复分支并创建及附加 PR。此交付不包含合并或发布 npm。
