# 本机会话执行权限

对话流输入框在 `@` 旁提供执行权限菜单，使用 Multica 的 Button、DropdownMenu 和语义化主题样式。菜单支持本机 Codex、Claude Code 和旁支输入框；执行或保存期间不能切换权限。

## 模式和运行器映射

| 模式 | Codex | Claude Code |
| --- | --- | --- |
| 默认权限 | 不传权限覆盖参数，沿用 CLI 配置 | 不传权限覆盖参数，沿用 CLI 配置 |
| 自动（Auto） | 根命令参数 `--approve-for-me` | `--permission-mode auto` |
| 完全访问 | 根命令参数 `--dangerously-bypass-approvals-and-sandbox` | `--permission-mode bypassPermissions` |

Auto 使用运行器自身的自动审批机制，仍可能拒绝操作。完全访问会跳过权限询问，并允许命令访问工作目录之外的文件。菜单说明这两种模式的区别。

Codex 的参数放在 `exec` 之前，使新会话和 `exec resume` 都能接受；Claude Code 在两种情况下都使用 `--permission-mode`。标题生成独立使用原有受限配置，不接受会话的权限覆盖。旧版 CLI 不支持参数时保留其错误，不自动退回更宽的权限。

## 数据流与作用范围

`PermissionPicker → runtime.setPermissionSelection → storage.write → submission checkpoint → queue.enqueue.item.permissionMode → local conversation service → provider`

- GUI 偏好使用已有账户、工作区隔离的存储通道，键为 `global-execution-permission-v1`。同一作用域的 Codex、Claude Code 和各会话共用当前选择，重启后恢复；不再读取旧的 `permission-preferences-v1`。历史会话设置不会覆盖全局选择，偏好保存失败时保留原选择。
- 每条新消息首次形成提交快照前，等待偏好加载及当前选择保存结束，再读取输入栏使用的全局权限。启用持久化提交时，新会话首条消息在创建会话前完成该步骤；快照保存失败则不创建会话、不发送消息。
- 已接纳消息的权限随提交快照保存。切换全局选择只影响后续新消息；恢复和重试继续使用原快照，不重新读取当前权限，也不追溯修改旧消息。
- 接受发送后，权限随 `LocalConversation` 持久化；未显式传值的客户端沿用会话权限，旧会话缺省为默认权限。服务端拒绝未知值，写入失败时回滚权限与消息。
- 旁支继承来源权限；排队消息转旁支时记录转移时的权限选择。
- `@` Multica 智能体继续使用自身运行配置，不接收本机会话权限覆盖。
- 不修改用户全局 CLI 配置，也不增加官方 Server 接口。

## 验证

默认测试使用伪运行器与 MessagePort 服务，不发现或启动已安装的模型 CLI：

```sh
pnpm --filter @multica/desktop test src/local-host/local-provider-runner.test.ts src/local-host/local-conversation-service.test.ts src/renderer/src/platform/local-conversation-service.test.ts
pnpm --filter @multica/tutti-agent-gui-host test src/runtime/runtime.test.ts
pnpm --filter @multica/tutti-agent-gui-host typecheck
pnpm --filter @multica/desktop typecheck
```

浏览器回归：`e2e/local-permissions.spec.ts` 覆盖两种运行器、独立会话、重载恢复、执行中禁用、实际发送字段、中英文和深浅主题。在 1360、760、520px 视口下，权限按钮与 `@` 的间距保持 4px 并垂直居中；窄窗口允许右侧控件换行。`e2e/local-provider-gui.spec.ts` 检查已有草稿、模型和引用交互。

若需隔离验证，可将 GUI 构建到临时目录并通过独立静态服务运行上述两套浏览器测试，避免重新构建、刷新或重启正在使用的桌面应用。本次未进行真实模型执行或手动审批界面测试；GUI 当前不提供 CLI 手动审批交互。
