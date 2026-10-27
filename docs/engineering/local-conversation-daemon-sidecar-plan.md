# 本地对话流迁入 daemon：执行计划

对应方案：[local-conversation-daemon-sidecar.md](./local-conversation-daemon-sidecar.md)。日期：2026-10-27。

## 交付策略

- **可以提前合入 main 的**：行为不变的重构，以及 daemon 侧在没有 manifest 时不生效的新能力（P0、P1-A）。
- **切换部分**（P1-B）在长期分支 `feat/local-conversation-sidecar` 上开发，分几个 PR 合入该分支。E2E 全部通过后一次性合入 main，不设运行时开关，同时删除进程内实现。
- 每个 PR 都是原子化的 conventional commit，在 PR 中写明实际跑过的检查。

## 阶段 0：前置验证（spike，不合入）

在投入编码前，先验证会推翻方案的三处平台假设：

| # | 验证内容 | 方法 | 不成立时 |
| --- | --- | --- | --- |
| S1a | 打包的 daemon 以 `ELECTRON_RUN_AS_NODE=1` 运行 `Multica.app` 内的 Electron（hardened runtime 开启，未配置关闭 RunAsNode 的 fuse） | 本地 adhoc 签名包实测 | **已通过**（2026-10-27，Node 24.22 / Electron 44.9.3） |
| S1b | 正式签名并公证的包中：daemon 由登录项或 launchd 拉起时，sidecar 访问"文稿"目录的权限弹窗归属；公证后 Gatekeeper 是否放行 sidecar | 发布前用 Developer ID 签名的 Canary 包手工验证 | 归属异常时评估：改为由 desktop 在启动时拉起 sidecar |
| S2 | Windows NSIS 更新时，正在运行的 sidecar（`Multica.exe`）会怎样：被阻塞还是被杀掉；drain 之后再 stop 能否保证更新成功 | 在 Windows 测试机上对比安装新旧版本 | 更新流程中强制先 stop |
| S3 | `asarUnpack: resources/**` 下，sidecar 的 `index.mjs` 能否解析 Claude Agent SDK 自带的平台二进制和 MCP SDK | 打一个本地包跑最小的 sidecar | 调整打包方式 |

产出：一份记录结论的简短文档，追加到方案 §15。

另需产品确认两项功能回退：WSL2 daemon 下本地对话不可用；离线时本地对话不可用。

## 阶段 P0：拆分（行为不变，合入 main）

| PR | 内容 | 主要文件 | 验证 |
| --- | --- | --- | --- |
| P0-1 | 把协议类型移到无 UI 依赖的包。不保留旧路径的 re-export | `packages/tutti-agent-gui-host/src/local-protocol.ts` → `packages/core/local-conversation/protocol.ts`；更新 GUI host 和 desktop 中的 import | `pnpm typecheck`、`pnpm test` |
| P0-2 | 抽出共用的小模块 | `daemon-profile.ts` 中的路径函数、`settings-operation-error.ts` → `apps/desktop/src/shared/` | `pnpm typecheck`、desktop 单测 |
| P0-3 | 把对话服务及其依赖整体移到 `apps/desktop/src/local-host/`；定义注入接口 `LocalHostPlatform`（dataDir、notify、pickDirectory、confirmedOperation、settingsHost、exportDeveloperLogs、timing、cliPath、env），由 main 在进程内实现 | 方案 §12 清单中的文件及其测试；`main/index.ts` 改为构造 platform | 迁移后的 `local-*.test.ts` 全部通过；desktop 冒烟：Codex/Claude 对话、fork、@智能体、设置确认 |

完成标志：`apps/desktop/src/local-host/` 中不出现任何 `electron` import（加一条 lint 规则固化这一点）。

## 阶段 P1-A：daemon 侧能力（无 manifest 时不生效，合入 main）

| PR | 内容 | 主要文件 | 验证 |
| --- | --- | --- | --- |
| A-1 | `/shutdown` 加鉴权：daemon 生成 `local-api.token`（0600，每次启动轮换），`/shutdown` 校验 token、Host 和 Origin；CLI 的 `daemon stop` 读取 token 后再调用 | `server/internal/daemon/health.go`、`server/cmd/multica/cmd_daemon.go:1422` | Go 测试：缺 token / Host 错误 / 带 Origin 均返回 403；`daemon stop` 端到端。需确认 desktop 停止 daemon 是否全部经由 CLI 进行 |
| A-2 | `internal/daemon/localhost`：manifest 定位、Local API（HTTP：hello、文件读写；WebSocket（gorilla/websocket）：session.set、subscribe、request、hostReply、sidecar.drain/undrain/stop，握手鉴权、1MB 上限、心跳）、连接表（连接断开时其 host_request 立即失败）、环形缓冲、host_request 定向投递与 90 秒超时、sidecar 监管（按需拉起、退避重启、stdin 关闭、shutdown） | 新包；`health.go` 挂载路由；`/health` 增加 `local_conversations`、`local_busy_count` | 使用测试内假 sidecar 脚本的 Go 测试，覆盖方案 §14 中列出的 Go 项 |
| A-3 | 重启屏障：在 `tryBeginServerUpdate`（`daemon.go:5034,5047`）、`tryAutoUpdate`、`trySelfReload` 中计入本地忙碌计数；检查前先执行 drain，不重启时再执行 undrain | `daemon.go`、`auto_update.go` | 竞态测试：drain 之后不能再开始新轮次 |
| A-4 | 协议契约 fixture：daemon↔sidecar 与 desktop↔daemon 的 JSON-RPC 消息、HTTP 响应各一组样例 | `server/internal/daemon/localhost/testdata/protocol/` | Go 侧读取 fixture；P1-B 中由 vitest 读取同一批 fixture |

`make test` 全量通过后合入。没有 manifest 时 `/health` 报告 `unsupported`，对现有用户没有可见变化。

## 阶段 P1-B：切换（在 `feat/local-conversation-sidecar` 上开发）

| PR | 内容 | 主要文件 | 验证 |
| --- | --- | --- | --- |
| B-1 | sidecar 入口：stdio JSON-RPC server，`init`、`session.set`、`request`、`hostReply`、`drain`、`shutdown`；向 daemon 发送 `event`、`busy`、`log`、`timing` 通知；provider 环境改为来自 `session.set.env` | `apps/desktop/src/local-host/entry.ts`、`rpc.ts`；electron-vite 新增构建入口；electron-builder 打包 `resources/local-conversation-host/` 和 `manifest.json` | vitest 读取 A-4 的 fixture；用 node 启动 entry 做集成测试 |
| B-2 | sidecar 内的 @智能体：合并两条实现，统一使用 PAT；加载 scope 时续接 running 状态的远程轮次；协议升到 v2，删除 `remoteBegin` / `remoteUpdate`，并从 `fileStore` / `fileRead` / `imageRead` / `preview*` 中删除 base64 `data` 字段；@智能体上传附件改为从磁盘流式 multipart；`read_attachment` 只返回路径 | `local-queued-cloud-run.ts`、`local-conversation-service.ts`、`packages/core/local-conversation/protocol.ts` | 新增续接测试：发送已确认则继续轮询，未确认则标记失败 |
| B-3 | 数据迁移：`migrate {legacyDir}`、按来源目录记录的 `migrations.json`、按 id 合并、`MIGRATED_TO` 标记；scope key 使用 desktop 原始的 apiUrl | `local-host/migration.ts` | 单测：单渠道、双渠道冲突、重复迁移、apiUrl 原样保留 |
| B-4 | desktop 代理：`local-conversation-proxy.ts`（读取 port 和 token、收到 401 时重新读取；用 npm `ws` 建立 WebSocket，断线退避重连、session.set、subscribe、resync；转发 IPC；用 zod 解析）；文件全程不转 base64（方案 §5.3）：main 注册 `multica-local-file://` 协议流式透传 daemon 文件端点，读写文件一律走 HTTP：renderer 对该协议 GET/POST，main 只补 token 并流式转发给 daemon，文件内容不走 IPC 和 WebSocket；renderer 改为使用该协议地址；host_request 处理：`confirmed_operation`（由 `desktop-settings-host.ts` 弹窗并执行）、`settings_host`、`pick_directory`、`developer_logs_export`；timing 写入 `turn-timing.jsonl`；删除 main 中进程内构造对话服务的代码 | `apps/desktop/src/main/` | desktop 单测：畸形响应、断线重连与重新订阅、token 轮换、`daemon.port` 变化、首个回复生效、账号切换后回复作废 |
| B-5 | 生命周期：`decideVersionAction` 计入 `local_busy_count`；更新前先 drain 再 stop；退出时只断开连接（AppImage 除外）；`autoStop` 设置项增加说明 | `daemon-manager.ts`、`version-decision.ts`、`updater.ts` | `version-decision` 单测；更新流程按 S2 的结论验证 |
| B-6 | renderer：删除远程轮询代码；增加不可用状态（未登录、daemon 未运行、`unsupported`、账号不一致、sidecar 崩溃中）和"重启后队列已暂停"提示；文案同时更新中英文 | `renderer/src/platform/local-conversation-*.ts`、`pages/local-*.tsx` | 组件测试；按 conventions 检查文案 |
| B-7 | E2E：关闭 desktop 后轮次继续；daemon 重启后队列暂停、手动继续后正常；两个 desktop 共用一个 profile；设置确认；迁移后数据可见 | `e2e/` | `pnpm exec playwright test`；macOS 与 Windows 各跑一遍 |

合入 main 前的总检查：`make check`，`pnpm exec playwright test`，再用 Canary 签名包在 macOS、Windows、Linux（deb 和 AppImage）上手工验证一轮。

## 阶段 P2：体验（合入 main 之后）

| PR | 内容 |
| --- | --- |
| P2-1 | 增量事件 `turn.delta` / `turn.tool`，renderer 不再整段重读 |
| P2-2 | 常驻 Codex 进程池和 Claude 会话的空闲回收与数量上限；sidecar 的 RSS 和崩溃次数写入开发日志导出 |

## 依赖关系

```text
S1–S3 ─┐
       ├─> P0-1 ─> P0-2 ─> P0-3 ─┐
A-1 ──> A-2 ─> A-3              ├─> B-1 ─> B-2 ─> B-3 ─> B-4 ─> B-5 ─> B-6 ─> B-7 ─> 合入 main ─> P2
        A-2 ─> A-4 ─────────────┘
```

P0 和 P1-A 可以并行：P0 只改 TS，P1-A 只改 Go。

## 风险跟踪

| 风险 | 何时确认 | 处理 |
| --- | --- | --- |
| macOS 权限弹窗归属、签名 | S1b（发布前） | 不成立时回到方案讨论拓扑 |
| Windows 更新被正在运行的 sidecar 阻塞 | S2 | 更新流程中强制先 stop |
| WSL2 和离线时的功能回退 | 产品确认 | 在 B-6 中给出明确提示 |
| 旧版 CLI 调用新 daemon 的 `/shutdown` 返回 403 | A-1 | daemon 与 CLI 同属一个安装包；独立安装的旧 CLI 需要升级，在 release notes 中说明 |
| 多渠道 desktop 互相触发版本对齐重启 | B-5 | 现有问题，只在空闲时发生；后续单独处理 |

## 执行状态（2026-10-27）

全部提交位于分支 `feat/local-conversation-sidecar`（从 `origin/main` 的 804c7bef9 切出），尚未推送、未开 PR。

| 阶段 | 状态 | 提交 |
| --- | --- | --- |
| S1a | 已通过 | — |
| P0-1 / P0-2 / P0-3 | 完成 | 70dc97ad5、f2e6ef20f、0c6b565a3 |
| A-1 / A-2 / A-3 / A-4 | 完成 | 76804a0ba、a88695a23、c85416861、17bebe794 |
| B-1 sidecar 入口与打包 | 完成 | 0d27711e2、783bc9841 |
| B-2 @智能体合并与续接 | 完成 | 1e6d64ab6 |
| B-3 数据迁移 | 完成 | 7806670b0 |
| B-4 desktop 代理与文件协议 | 完成 | 3f6c5e40d |
| B-5 生命周期 | 完成 | 5475c83fb |
| B-6 不可用提示 | 完成 | 6fd48ca6e、f18a2bdff |
| B-7 真机验证 | 未执行，见下方清单 | — |
| S1b / S2 / S3 | 未执行，需要签名包、Windows 机器、打包产物 | — |

### 与计划不同的实现决定

- **确认后执行**：设置工具的确认改为 `confirmAndApply`，由弹出原生对话框的一方执行写入；token 的密钥由该方展示并从结果中去除。进程内与 sidecar 两种运行方式共用这一实现。
- **文件授权**：预览和生成图片不再在 RPC 中返回内容，而是返回 10 分钟有效、绑定账号与工作区的 `fileRef`；`fileRead`、`fileStore` 只在 sidecar 内部使用，desktop 调用会被拒绝。
- **文件传输**：`LocalConversationClient` 新增必需的 `files`（`upload`、`read`、`url`），preload 通过 `multica-local-file://` 实现，URL 携带每次启动生成、只有主窗口能取得的密钥。renderer 交给 agent GUI iframe 的接口仍是 base64，这是 iframe 既有约定，不经过 daemon。
- **@智能体**：新增 `remoteSend`；`remoteBegin`、`remoteUpdate` 保留为 sidecar 内部方法，desktop 调用会被拒绝。取消与已受理的发送交叉时，会同时取消云端任务。
- **开发日志工具**：`export_developer_logs` 在 sidecar 中通过 host_request `developer_logs_export` 交给 desktop 执行。
- **manifest**：Electron 可执行文件路径按操作系统分别列出，manifest 和加载器是提交到仓库的静态文件。

### 真机验证清单

1. 打包并安装 desktop，确认 `resources/local-conversation-host/` 位于 `app.asar.unpacked/resources/` 下，daemon `/health` 返回 `local_conversations: "supported"`（S3）。
2. 首次启动后，旧的 `userData/local-conversations` 出现 `MIGRATED_TO`，原有会话、附件、预览目录在新版中可见。
3. Codex、Claude 各发一轮；附件上传、生成图片、文件预览（图片、PDF、文本）显示正常。
4. 发送一轮后关闭窗口（未开启"退出时自动停止"），等待完成后重新打开，结果可见。
5. 运行中执行 `multica daemon restart --profile desktop-<host>`：运行中的轮次标记失败，排队项暂停，手动继续后正常执行。
6. @智能体一轮期间重启 desktop，重新打开后结果继续同步。
7. 设置类工具触发确认：拒绝时无写入；同意后写入成功；创建 token 时密钥只出现在原生对话框中。
8. 停止 daemon、退出登录、使用外部 CLI 拉起的 daemon，分别看到对应的不可用提示。
9. 正式签名包：daemon 由登录项拉起后访问"文稿"目录，记录权限弹窗归属（S1b）。
10. Windows：本地对话运行中触发更新，确认先询问、再停止 sidecar，安装成功（S2）。
