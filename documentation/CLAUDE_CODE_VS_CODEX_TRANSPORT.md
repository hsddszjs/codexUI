# Claude Code 与 Codex App-Server Transport 对比研究

> 本文档总结对 codexUI、`openai/codex`、`anthropics/claude-code`(基于 sourcemap 还原)以及 `anthropics/claude-agent-sdk-python` 的源码阅读结论,用于指导 codexUI 在不同 transport 上的集成与排错。

---

## 1. codexUI 整体架构回顾

codexUI(npm 上发布为 `codexapp`)是一个把 Codex AI 编码助手暴露到浏览器的 Web bridge,派生自 `codex-web-local`。三段式结构:

```
浏览器 (Vue 3 SPA)
   │  HTTP / WebSocket
   ▼
Node.js 服务端 (Express + Vite middleware)
   │  stdin/stdout (JSON-RPC lite, JSONL)
   ▼
codex app-server (子进程)
```

| 层级 | 关键文件 | 职责 |
|---|---|---|
| 前端 SPA | `src/composables/useDesktopState.ts` (~5K LOC) | 单一巨型 composable,集中管理所有 UI 状态;`localStorage` 持久化 |
| 前端组件 | `src/components/{content,sidebar,layout}/` | 聊天、侧栏、布局 |
| 后端 bridge | `src/server/codexAppServerBridge.ts` (~5.3K LOC) | spawn 子进程、RPC 多路复用、WS/SSE 订阅管理 |
| Provider 适配 | `src/server/{openRouterProxy,zenProxy,customEndpointProxy}.ts` | Codex 永远看到 Responses API,代理层翻译到下游 Chat Completions |
| CLI | `src/cli/index.ts` | `npx codexapp` 启动入口、Cloudflare Tunnel、密码生成 |

构建:Vite 出 SPA `dist/`,tsup 出 CLI `dist-cli/index.js`(带 shebang 的 ESM)。

---

## 2. Codex app-server transport

### 2.1 协议形态

`codex app-server` 使用**JSON-RPC lite**:保留 request / response / notification 三种消息形态,但**省略 `"jsonrpc": "2.0"` 字段**;严格说不是 JSON-RPC 2.0。每条消息一行 JSON(JSONL)。

### 2.2 支持的 transport(`codex-rs/app-server/src/transport/mod.rs`)

```rust
pub(crate) enum ConnectionOrigin {
    Stdio,
    InProcess,
    WebSocket,
    RemoteControl,
}
```

CLI 层入口:

```
--listen stdio://         (默认)
--listen unix://[PATH]    (WebSocket frames over unix socket)
--listen ws://IP:PORT     (实验性,README 明确标注 unsupported)
--listen off              (不开本地 transport,仅走 remote-control)
```

### 2.3 wire format 在所有 transport 上**共享同一 `JSONRPCMessage` 枚举**

`transport/mod.rs:257, 313` 中 `forward_incoming_message` / `serialize_outgoing_message` 是所有 transport 共用的入口/出口 —— 协议方法集(`thread/*`、`turn/*`、`config/*`、`item/*` 等)在 stdio / unix / ws 上**字节级一致**。

### 2.4 真正的 transport-gated 差异

| 维度 | Stdio | WebSocket / Unix |
|---|---|---|
| Client 数 | `single_client_mode = true` (`lib.rs:595`) | 多 client |
| 无 client 时 | `shutdown_when_no_connections = true` | 继续监听 |
| Graceful restart | 关闭(`graceful_signal_restart_enabled = !single_client_mode`) | 开启 |
| 鉴权 | 默认本地信任 | `--ws-auth` Bearer token |
| 帧层能力 | 行分隔 NDJSON | TextFrame + ping/pong;binary frame 主动丢弃 |
| **方法级 ACL** | **允许** `device/key/*` | **拒绝** |

最硬的一个限制(`transport/mod.rs:182-188`):

```rust
impl ConnectionOrigin {
    pub(crate) fn allows_device_key_requests(self) -> bool {
        matches!(self, Self::Stdio | Self::InProcess)
    }
}
```

`device/key/create` 等设备密钥端点**只接受 stdio/in-process**,任何 WebSocket(包括本地 `ws://127.0.0.1`)和 remote-control 都会被拒。这是源码里**唯一一处真正按 transport gate 方法**的地方。

---

## 3. Claude Code transport

### 3.1 协议形态

Claude Code 走的不是 JSON-RPC,而是**事件流 + control 协议**。message taxonomy 由 zod 定义于 `src/entrypoints/sdk/controlSchemas.ts`:

```ts
StdoutMessageSchema = SDKMessage             // assistant / system / result / user
                   | SDKStreamlinedTextMessage
                   | SDKStreamlinedToolUseSummaryMessage
                   | SDKPostTurnSummaryMessage
                   | SDKControlResponse
                   | SDKControlRequest        // can_use_tool / hook_callback / mcp_message / elicitation ...
                   | SDKControlCancelRequest
                   | SDKKeepAlive

StdinMessageSchema  = SDKUserMessage
                   | SDKControlRequest
                   | SDKControlResponse
                   | SDKKeepAlive
                   | SDKUpdateEnvironmentVariables
```

### 3.2 支持的 transport

| 入口 | Transport class | 数据流 | 触发条件 |
|---|---|---|---|
| `--input-format=stream-json --output-format=stream-json` | (无,直走 `process.stdin`/`stdout`) | NDJSON over PIPE | SDK 子进程模式 |
| `--sdk-url ws(s)://...` | `WebSocketTransport` | 读写都用 WS | 默认 |
| `--sdk-url ...` + `CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2=1` | `HybridTransport` | WS 读 + HTTP POST 写 | 环境变量 |
| `--sdk-url ...` + `CLAUDE_CODE_USE_CCR_V2=1` | `SSETransport` | SSE 读 + HTTP POST 写 | 环境变量 |

选择优先级见 `src/cli/transports/transportUtils.ts:11-14`。

### 3.3 `--sdk-url` 实质

`--sdk-url` 让 CLI 作为 **WebSocket client 主动出站**,连到指定 server(对应 cloud session 资源 `https://api.anthropic.com/v1/code/sessions/cse_…`)。这与 Codex `--listen ws://` 的方向**相反**:Codex 是把自己当 server 监听,Claude Code 是当 client 出站连。

握手流程(逆向自 The-Vibe-Company/companion):

1. CLI WS Upgrade,头里带 `Authorization: Bearer <token>`
2. CLI 发 `system/init`(tools / model / session_id / capabilities)
3. Server 发 `user`(用户消息)
4. CLI 流式回 `stream_event` + `assistant`
5. 工具批准走 `control_request` 的 `can_use_tool` 子类型
6. `result` 收尾

### 3.4 wire format 在所有 transport 上**共享同一 schema**

stdio 和 WS 都序列化同一个 `StdoutMessage`/`StdinMessage` zod union,字节一致。stdio 路径是 `structuredIO.write → writeToStdout → process.stdout.write(... + '\n')`(`structuredIO.ts:466`),WS 路径是 `ws.send(line)`(`WebSocketTransport.ts:339`)。

### 3.5 transport-gated 差异

| 维度 | stdio | WebSocket / Hybrid / SSE |
|---|---|---|
| `keep_alive` | 写得出去但本地不需要 | **必需**,定时帧维持连接 |
| `update_environment_variables` | 父进程注入合理 | 跨信任域,实际只在 SDK 启动时有意义 |
| `stream_event` 批处理 | 一条一行 | Hybrid 聚合 100ms 再 POST |
| 反压/重试 | EOF 即结束 | `SerialBatchEventUploader`(指数退避 + jitter) |
| 鉴权 | 父进程信任 | `Authorization: Bearer` + `refreshHeaders` |
| `--print` 限制 | `--output-format=stream-json` 必须 `--verbose` | 不适用 |

**没有发现任何方法被 origin gate 限制**。Codex 那种 `allows_device_key_requests` 的硬编码限制在 Claude Code 源码里没有等价物。

### 3.6 当前云容器实际启动方式

```
process_api (firecracker-init)
└── /bin/sh (env setup)
    └── environment-manager task-run --stdin --session cse_… --session-mode resume
        └── claude
              --input-format=stream-json
              --output-format=stream-json
              --replay-user-messages
              --debug-to-stderr
              --model claude-opus-4-7[1m]
              --tools preset:default,...
              --mcp-config /tmp/mcp-config-cse_….json
              --add-dir /home/user/codexUI
              --sdk-url   https://api.anthropic.com/v1/code/sessions/cse_…
              --resume=   https://api.anthropic.com/v1/code/sessions/cse_…
              --debug
```

要点:
- `--sdk-url` 在,`SdkUrlTransport`(LQA)优先用 **WebSocket** 作为对话传输
- `environment-manager --stdin` 只在 **bootstrap 阶段**用 stdin 喂启动参数 / replay,**不是对话通道**
- 真正的浏览器 ↔ 容器消息流走:**claude.ai/code → Anthropic API session → 容器 CLI 出站 WebSocket**
- stdio 的 stream-json flag 在此场景留作 fallback / replay 注入

---

## 4. claude-agent-sdk-python 实现观察

`anthropics/claude-agent-sdk-python` 的本地 transport 实现位于 `src/claude_agent_sdk/_internal/transport/subprocess_cli.py`(726 行)。

**关键事实:整个 SDK 中没有任何 `pty` / `tty` / `forkpty` / `openpty` / `termios` / `isatty` 引用**。

```python
# subprocess_cli.py:207
cmd = [self._cli_path, "--output-format", "stream-json", "--verbose"]
# subprocess_cli.py:382-384  Always use streaming mode with stdin (matching TypeScript SDK)
cmd.extend(["--input-format", "stream-json"])

# subprocess_cli.py:452-460
stdin=PIPE, stdout=PIPE, ...
self._stdout_stream = TextReceiveStream(self._process.stdout)
self._stdin_stream = TextSendStream(self._process.stdin)
```

子进程通过 `os.pipe()` 标准 PIPE 通信(子进程 `isatty()` 返回 False,CLI 自动走 SDK 分支不渲染 TUI),逐行 NDJSON 收发。**SDK transport 与 Codex `app-server` stdio mode 在结构上完全等价**,实现干净,不存在 TUI 模拟。

---

## 5. 两个项目 transport 等价性总览

| | Codex | Claude Code |
|---|---|---|
| 协议风格 | JSON-RPC lite (无 `jsonrpc:"2.0"`) | 事件流 + control_request/response |
| 帧格式 | JSONL | NDJSON |
| stdio 入口 | `codex app-server` 子命令 | `claude --input-format=stream-json --output-format=stream-json` |
| WS 角色 | 自身做 server 监听 (`--listen ws://`) | 自身做 client 出站 (`--sdk-url`) |
| Wire 在 stdio vs WS | **字节一致**,共享枚举 | **字节一致**,共享 schema |
| 方法级 ACL | **有**:`device/key/*` 仅限 stdio/in-process | **未发现** |
| WS 状态 | 实验性、unsupported | 生产可用,Cloud session 默认 |
| 多客户端 | stdio 单连;ws/unix 多连 | 单进程一条 transport |

**一句话结论**:两个项目都做到了"transport 透明 + 共享 wire payload",真正按 transport 区分的差异都集中在**鉴权 / 生命周期 / 反压 / keep-alive** 这种工程层面;唯一一处真正"WS 不支持的方法"是 Codex 的 device-key API,出于安全显式只允许本地 transport。

---

## 6. Claude Code 的 `bypassPermissions` 实现

容器化场景下要做到"零权限提示",关键路径如下。

### 6.1 进入条件:`setup.ts:395-440` 两道安全门

```ts
if (permissionMode === 'bypassPermissions' || allowDangerouslySkipPermissions) {
  // 安全门 A:对所有用户生效
  if (process.platform !== 'win32' &&
      process.getuid?.() === 0 &&
      process.env.IS_SANDBOX !== '1' &&
      !isEnvTruthy(process.env.CLAUDE_CODE_BUBBLEWRAP)) {
    process.exit(1)   // root + 非 sandbox → 直接退出
  }

  // 安全门 B:仅 USER_TYPE=ant(Anthropic 内部用户)生效
  if (process.env.USER_TYPE === 'ant' && ...) {
    if (!isSandboxed || hasInternet) process.exit(1)  // 必须 sandbox + 无外网
  }
}
```

- **门 A** 普适:容器里跑 root → 必须设 `IS_SANDBOX=1` 或 `CLAUDE_CODE_BUBBLEWRAP=1`
- **门 B** 仅内部用户触发,普通用户与本场景无关

### 6.2 CLI flags(`main.tsx:976`)

```
--dangerously-skip-permissions          直接进入 bypassPermissions
--allow-dangerously-skip-permissions    仅"允许",不强制
--permission-mode bypassPermissions     等价
```

### 6.3 运行时短路:`permissions.ts:1262-1281`

```ts
const shouldBypassPermissions =
  appState.toolPermissionContext.mode === 'bypassPermissions' ||
  (appState.toolPermissionContext.mode === 'plan' &&
   appState.toolPermissionContext.isBypassPermissionsModeAvailable)

if (shouldBypassPermissions) {
  return { behavior: 'allow', updatedInput: ..., decisionReason: { type: 'mode', ... } }
}
```

命中后直接放行,后续所有 ask 不再触发。

### 6.4 即使 bypass 也"免疫"的几条(`permissions.ts:1219-1260`)

| 优先级 | 条件 |
|---|---|
| 1d | 显式 `deny` 规则 |
| 1e | `tool.requiresUserInteraction()` 返回 true |
| 1f | 用户配置内容级 `ask` 规则(如 `Bash(npm publish:*)`) |
| 1g | 路径安全检查:`.git/`、`.claude/`、`.vscode/`、shell 配置 |

bypass 不能盖过这四类。要彻底放行,只能改 `checkPathSafetyForAutoEdit` 或显式配置 `allow` 规则。

### 6.5 远程 Statsig gate(`permissionSetup.ts:778`)

Anthropic 服务端可临时禁用 `bypassPermissions`。无外网或 Statsig 拉不到时通常默认放行。

### 6.6 容器推荐配置

```bash
# 必备
export IS_SANDBOX=1                          # 过 root 检查

# 启动方式三选一
claude --dangerously-skip-permissions ...
claude --permission-mode bypassPermissions ...

# Agent SDK
options = ClaudeAgentOptions(permission_mode="bypassPermissions")  # Python
{ permissionMode: "bypassPermissions" }                            # TypeScript
```

要做到 100% 零提示,还需:
1. 不让 model 触碰 `.git/` `.claude/` `.vscode/` `~/.bashrc`(免疫白名单),或在 settings 加 `allow` 规则
2. 不要在 settings 里配 `Bash(...)` 之类的 `ask` 规则
3. 不要配 `permissions.deny`(deny 在 bypass 下仍生效)
4. MCP 工具实现里别返回 `requiresUserInteraction()=true`

---

## 7. 对 codexUI 的启示

1. **bridge 层选 transport 时 wire payload 不变**:codexUI 现在 spawn `codex app-server` 用默认 stdio 是最稳的选择,WebSocket 是实验性 transport,Codex README 明确标注 unsupported。
2. **device-key API 选 stdio**:如果未来 codexUI 需要用 `device/key/*`,必须保持 stdio/in-process,WebSocket 会被 Codex 直接拒绝。
3. **可参考 claude-agent-sdk-python 的 transport 抽象**:用一个 `Transport` 抽象类把 stdio / WS 统一,业务代码不感知 —— 这正是 codexUI bridge 现有做法。
4. **bypassPermissions 不是 codexUI 范畴**(codexUI 走的是 Codex 不是 Claude Code),但若将来支持 Claude Code as backend,需要把 `IS_SANDBOX=1` 与 `--dangerously-skip-permissions` 一起注入子进程环境。

---

## 参考来源

- `openai/codex` — `codex-rs/app-server/{src,README.md}`
- `anthropics/claude-code` — sourcemap 还原版 `ChinaSiro/claude-code-sourcemap`
- `anthropics/claude-agent-sdk-python` — `_internal/transport/subprocess_cli.py`
- `The-Vibe-Company/companion` — `WEBSOCKET_PROTOCOL_REVERSED.md`(逆向 `--sdk-url` 协议)
- 官方文档:
  - https://developers.openai.com/codex/app-server
  - https://code.claude.com/docs/en/agent-sdk/overview
  - https://code.claude.com/docs/en/headless
  - https://code.claude.com/docs/en/remote-control
