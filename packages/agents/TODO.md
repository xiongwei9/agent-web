# TODO

`@ai-chat/agents` 的待完成清单。完成一项就勾上，整理时再移除。

优先级：P0 阻塞使用 · P1 尽快做 · P2 计划内 · P3 有空再做

## 功能

- [ ] P2 - steer/followUp/abort 等指令
  - 目前一个 run 只能通过取消订阅整体中止，运行中无法插入新指令或排队追问

## MCP

- [ ] P2 - 授权服务器遗忘了已存储的 client_id 时自动重新注册
  - `/authorize` 返回 `invalid_client` 不会重定向回来，SDK 无从得知；
    可在有 `clientInformation` 而无 `tokens` 时，发起授权前先
    `invalidateCredentials("client")`
- [ ] P3 - `createFileMcpOAuthStore` 清理长期不用的用户记录
  - 换浏览器、清 cookie 都会产生新用户，旧记录一直留在文件里

## 循环

- [ ] P3 - 上下文压缩的摘要可持久化
  - 摘要只存在内存（`src/loop/compaction.ts`），重启后长对话要从头总结

## 文档

- [x] P3 - README 的 HITL、A2UI、Skills 章节仍引用已不存在的
      `src/runtime/*.ts`，改为 `src/client-tools/`、`src/skills/toolset.ts`
