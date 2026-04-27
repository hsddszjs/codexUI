# codexUI Container PoC

> 把 Codex 跑在容器里,容器主动 dial 宿主 server,无任何暴露端口。
> PoC 只跑 1 个用户(`wangshunfeng`),验证桥接链路是否走得通。

## 形状

```
浏览器 / curl
   │  POST /api/rpc/wangshunfeng  {jsonrpc, id, method, params}
   ▼
宿主 server (Node + Express + ws)   ← 端口 5173,本机暴露
   │  WSS /container-ws  ← 容器 dial 进来,X-User-Name 头标识身份
   ▲
   │
容器 codex-wangshunfeng
   ├── sidecar.mjs      (Node)  spawn codex,stdin/stdout 搭 ws
   └── codex app-server (stdio)  实际跑 model
```

## 状态

✅ **已端到端跑通**(2026-04-27,Anthropic eval 沙箱内 Linux x86_64,Docker 29.3.1):
- 容器主动 dial 宿主 `host.docker.internal:5173/container-ws`,服务端识别 `X-User-Name` 头
- 浏览器 / curl POST `/api/rpc/wangshunfeng` → 路由到容器 sidecar → 写入 codex stdin → 收到 codex stdout 响应
- 注入的 `config.toml`(`model=gpt-5`,`model_provider=claudecn`,`reasoning=high`)被 codex 正确加载

> 注:沙箱里出公网走 self-signed CA 中间人,所以多了个 `Dockerfile.sandbox`(把宿主 CA bundle COPY 进去)。
> **macOS 上请用默认 `Dockerfile`,不要用 `.sandbox`**。

## 文件

```
poc/
├── Dockerfile              ubuntu:24.04 + node22 + @openai/codex
├── users.yaml              用户清单(PoC 1 个,扩到 6 个直接加)
├── start.sh                构建镜像 + 起容器
├── stop.sh                 停容器
├── config/
│   ├── config.toml         注入到容器内 ~/.codex/config.toml
│   ├── auth.json           真 API key,gitignore
│   └── auth.json.example   提交在仓库的样例
├── sidecar/
│   ├── sidecar.mjs         容器内桥接进程
│   └── package.json        只依赖 ws
└── server/
    ├── server.mjs          宿主侧 5173 端口
    ├── public/index.html   手敲调试页
    └── package.json        express + ws
```

## 启动步骤(macOS / Linux,Docker Desktop 默认 bridge 网络即可)

```bash
# 1. 把真 API key 填进 config/auth.json(已用样例的话这一步可跳)
cp poc/config/auth.json.example poc/config/auth.json
$EDITOR poc/config/auth.json

# 2. 起宿主 server(终端 A)
cd poc/server
npm install
npm start
# → listening on http://0.0.0.0:5173

# 3. 起容器(终端 B)
cd poc
./start.sh
# 等容器输出 [sidecar] ws open
docker logs -f codex-wangshunfeng

# 4. 验证(终端 C / 浏览器)
# A) 浏览器打开 http://localhost:5173,依次点:initialize → thread/start → turn/start
# B) 或者 curl:
curl -s http://localhost:5173/api/users
curl -sX POST http://localhost:5173/api/rpc/wangshunfeng \
     -H 'content-type: application/json' \
     -d '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"curl","title":"PoC","version":"0"}}}'
curl -sX POST http://localhost:5173/api/rpc/wangshunfeng \
     -H 'content-type: application/json' \
     -d '{"id":2,"method":"thread/start","params":{}}'
```

## 已验证的 RPC 方法(端到端跑通)

| 方法 | 说明 |
|---|---|
| `initialize` | 握手,返回 userAgent / codexHome / platformOs |
| `config/read` | 拉到容器内 `~/.codex/config.toml`,确认 `model=gpt-5`、`model_provider=claudecn`、`reasoningEffort=high` 都正确注入 |
| `model/list` | 返回模型清单 |
| `thread/start` | 创建 thread,返回 thread.id 等 |
| `turn/start` | 发 prompt(需要外网到 claudecn.top 才能完整跑) |

> Codex 协议是 JSON-RPC 风格但**不带 `"jsonrpc": "2.0"` 字段**(OpenAI 自称 "JSON-RPC lite")。完整方法清单可以发一个故意错误的方法名,Codex 会在 error 里把全部合法 method 列出来。

## 关键设计点(对应聊天里的决策)

| 决策 | 实现位置 |
|---|---|
| 6 个固定用户,无密码,选完写 cookie | 后续在主 codexUI 加 `UserPicker.vue`;PoC 不做选择页,固定 `wangshunfeng` |
| 容器永驻,system 启动手动 `docker run`,不程序编排 | `start.sh` |
| 一人一容器一进程一 thread(软限制) | sidecar 不做强制,UI 层后续控制;Codex 进程支持多 thread 但 UI 一次只显示一个 |
| 容器无暴露端口,主动出站 | `docker run` 不加 `-p`;sidecar 用 `WebSocket(BRIDGE_HOST_URL)` 出站 |
| 用 `host.docker.internal:host-gateway` 让容器看到宿主 | `start.sh` 加 `--add-host` |
| 用户配置(name / git author / config.toml / auth.json)走 env | start.sh 用 `-e` 注入 |
| 不持久化,容器手动重建 | 没挂 `~/.codex` volume,容器重启 thread 状态丢失 |
| 不鉴权 | server 收到 ws 只看 `X-User-Name` 头,信任 |
| 出错 sidecar 直接退出 | 由 `--restart unless-stopped` 拉起来 |

## 已知 TODO(下一步)

- [ ] 6 个用户全开,`start.sh` 改成读 `users.yaml` 循环
- [ ] codexUI 主仓库加 `UserPicker.vue`,首访选用户写 cookie
- [ ] `useDesktopState.ts` 改造,让 RPC 走 `/api/rpc/$user` 而不是当前的内联 bridge
- [ ] 把 `server/server.mjs` 的逻辑合并进 `src/server/codexAppServerBridge.ts`(替换原 spawn)
- [ ] 通知(notification)从容器 → server → 浏览器的转发(目前 server 只打日志,浏览器收不到流式增量)
