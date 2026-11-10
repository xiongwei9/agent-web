# TODO

`@ai-chat/agents` 的待完成清单。完成一项就勾上，整理时再移除。

优先级：P0 阻塞使用 · P1 尽快做 · P2 计划内 · P3 有空再做

## 功能

- [ ] P2 - steer/followUp/abort 等指令
  - 目前一个 run 只能通过取消订阅整体中止，运行中无法插入新指令或排队追问
- [ ] P2 - Async Task Management：耗时操作放到后台异步执行
  - 目前工具调用都在 loop 内同步等待，code-mode 和 skill 脚本受超时上限约束，
    长任务要么阻塞对话、要么被强行中止
  - 启动后立即返回 task id，提供查询状态/输出、取消的工具；任务完成后把结果
    回注到对话（可依赖上面的 followUp 能力）
- [ ] P2 - Sub Agent：把子任务委派给独立上下文的子 agent 执行
  - 目前所有工作都在同一个 loop、同一份上下文里完成，探索/检索类任务的大量
    中间结果会挤占主对话上下文，也无法并行处理互不依赖的子任务
  - 提供委派工具：主 agent 传入任务描述，子 agent 以独立消息历史运行（可指定
    模型、system prompt、可用工具子集），结束后只把最终结论返回给主 agent
  - 支持并行启动多个子 agent；需限制嵌套深度，子 agent 的 HITL 请求和步骤
    事件要能透传到前端；长时间运行的可结合上面的 Async Task 放到后台

## MCP

- [ ] P2 - 授权服务器遗忘了已存储的 client_id 时自动重新注册
  - `/authorize` 返回 `invalid_client` 不会重定向回来，SDK 无从得知；
    可在有 `clientInformation` 而无 `tokens` 时，发起授权前先
    `invalidateCredentials("client")`
- [ ] P3 - `createFileMcpOAuthStore` 清理长期不用的用户记录
  - 换浏览器、清 cookie 都会产生新用户，旧记录一直留在文件里

## 循环

- [x] P3 - 上下文压缩的摘要可持久化
  - 摘要只存在内存（`src/loop/compaction.ts`），重启后长对话要从头总结

## 文档

- [x] P3 - README 的 HITL、A2UI、Skills 章节仍引用已不存在的
      `src/runtime/*.ts`，改为 `src/client-tools/`、`src/skills/toolset.ts`
