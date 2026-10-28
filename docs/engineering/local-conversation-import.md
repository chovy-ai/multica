# 本机会话导入

对话流的「本机会话」标题旁提供导入入口。先选择 Codex 或 Claude Code，再选择会话和归属项目；「选择全部历史」会继续读取所有分页，排除已经导入的记录。导入完成只刷新列表，保留当前打开的会话及草稿。

## 数据流

```text
导入窗口 → 私有桌面 IPC → 原生历史列表与正文
         → 创建独立原生分支 → 读取该分支的快照
         → 当前账号 / 官方地址 / 工作区隔离的本机历史
续聊     → 使用分支原生会话 ID，而不是原始 ID
```

Codex 使用 app-server 的 `thread/list`、`thread/read` 与 `thread/turns/list`，读取完整分页，不执行 `thread/resume` 或 `turn/start`。列表先读未归档会话，再读已归档会话；使用 `useStateDbOnly`，避免扫描期间修复其他进程的历史索引。复制复用已有的无提示词 `exec fork`。协议依据 [Codex App Server](https://learn.chatgpt.com/docs/app-server)。不支持完整历史分页的旧版本会明确报错，需要更新 Codex。

Claude Code 使用已安装的 Agent SDK：`listSessions`、`getSessionInfo`、`getSessionMessages` 和 `forkSession`。导入按已发现的 UUID 查询和复制，避免工作目录符号链接与原生项目存储键不一致时查不到历史。

原生分支复制保留运行器上下文。本机展示层只保存可见消息及已识别的工具活动，不包含隐藏推理。HTML / SVG 代码块原样保留。历史图片显示占位提示，图片内容保留在原生分支中；消息时间优先取原始时间，缺失时使用会话时间。工作目录不存在、正文为空或读取不完整时，该项报告失败，不伪装成可正常续聊的导入。

## 持久化与边界

- `importedFrom` 保存提供方和源会话 ID，在当前账号与工作区内去重；原生分支本身也识别为已导入。
- 每个工作区同一时间只运行一批导入。每项单独原子保存，某项失败不撤销其他已完成项目，失败项可重试。
- 停止导入、切换账号或退出应用会取消后续操作。已经持久化的会话保留。
- 导入过程不发送模型消息、不创建官方聊天或上传本机历史。读取窗口与导入不会更改当前工作目录、项目绑定或其他现有会话。
- 若原生复制成功后发生磁盘或读取错误，原生存储中可能留下未关联的副本；不自动删除原生数据。重试可能重新创建分支。
- 原生历史查询与单项导入限制为 64 MiB，界面按 25 项提交；历史较多时可以分批处理。不能通过不完整快照恢复已被提供方清理的上下文。

## 验证

默认测试使用专门创建的模拟 Codex 可执行文件和隔离 Claude 配置目录。验证分页、只读 RPC、原始文件不变、独立分支续聊、重启去重、部分失败、并发保护、账号切换、取消、持久化失败及导入窗口交互。

```sh
pnpm --filter @multica/desktop test src/local-host/local-native-history.test.ts src/local-host/local-conversation-import.test.ts src/local-host/local-conversation-service.test.ts src/local-host/local-provider-fork.test.ts src/renderer/src/pages/local-conversation-import.test.tsx src/renderer/src/pages/local-conversation-flow.test.tsx
pnpm --filter @multica/desktop typecheck
git diff --check
```

单独的显式只读验收使用本机 Codex 列表接口，并读取已存在的合成验证会话，未启动模型请求或对真实会话执行导入。桌面主线程的启动状态由原任务维护，本次不主动重启其应用或服务。
