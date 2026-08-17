# dsh-wechat-bridge

把微信接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：扫码登录后，
微信消息由 DSH agent（coding agent）回复；会话按轮次管理并挂在独立的 **WeChat 工作区**，
支持 `/new`（新对话，旧对话保留）、`/history`（回看历史）。适合"在手机上用 DSH"。

基于微信官方 **iLink Bot API**（`ilinkai.weixin.qq.com`，同腾讯开源项目
[openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 所用协议），
消息收发由 `@wechatbot/wechatbot` SDK 完成。

## 特性

- 📱 **扫码登录**：凭据持久化，重启免扫码
- 🤖 **DSH agent 回复**：每个微信用户一个稳定会话（cordis preset，含完整工具链）
- 🗂️ **独立 WeChat 工作区**：所有微信会话在 Web GUI 侧边栏单独分组，标题自动摘要为
  `微信 · 对话内容`
- 🔄 **/new 保留旧对话**：新对话用轮次后缀创建，旧对话完整保存、随时回看
- 📜 **/history 查询**：微信内直接列出/查看任意历史轮次
- 🖼️ **媒体支持**：图片/文件自动落盘并给出路径，agent 可读取处理
- ⚙️ **配置页面**：Web GUI Settings → WeChat Bridge 直接改配置（bridgeDir/secret/preset 等）
- 🚀 **一键安装**：`curl .../install.sh | bash`
- 🔌 **host 组合插件**：写进 `cordis.patch.yml` 后随 DSH 自动加载、7×24 运行

## 架构

```
┌──────────┐   iLink 官方协议   ┌──────────────────┐   HTTP (127.0.0.1)   ┌────────────────────────────┐
│ 微信 App  │ ◄────────────────► │   bridge 进程     │ ◄─────────────────► │   DSH Host（Cordis 插件）  │
│ (手机)    │   （扫码登录/长轮询）│  bridge/bridge.js │   /wxb/inbound       │   index.js                 │
└──────────┘                     └──────────────────┘   /wxb/outbox        │   ├─ agents.create/resume   │
                                  Node ≥ 22            /wxb/event          │   ├─ 按用户驱动回合+回复     │
                                  依赖 @wechatbot/wechatbot + qrcode        │   └─ WeChat 工作区挂载     │
                                                                            └────────────────────────────┘
```

## 安装

1. 把本仓库复制到 DSH 的 **profile 目录**（默认 `~/.dsh/profiles/web/`）：

### 一键安装（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/whj2015/dsh-wechat-bridge/main/install.sh | bash
```

脚本自动完成：克隆插件到 `~/.dsh/profiles/web/` → 安装依赖 → 注册到
`cordis.patch.yml` → 提示重启 DSH。

### 手动安装

1. 把本仓库复制到 DSH 的 **profile 目录**（默认 `~/.dsh/profiles/web/`）：

   ```bash
   git clone https://github.com/whj2015/dsh-wechat-bridge ~/.dsh/profiles/web/dsh-wechat-bridge
   cd ~/.dsh/profiles/web/dsh-wechat-bridge && npm install
   cd bridge && npm install
   ```

2. 编辑 `~/.dsh/profiles/web/cordis.patch.yml`，追加：

   ```yaml
   - insert:
       - id: dsh-wechat-bridge
         name: ./dsh-wechat-bridge/index.js
         config: {}        # 可选配置见下
   ```

3. 重启 `dsh`，查看终端日志中的扫码链接，用手机微信（建议小号）扫码确认。

## 配置页面

插件注册了 **`dsh-wechat-bridge` 配置命名空间**，Web GUI 的
**Settings → WeChat Bridge** 会自动渲染配置表单（无需写客户端代码）：

| 配置项 | 说明 | 默认 |
|--------|------|------|
| `bridgeDir` | bridge 进程目录 | 包内 `./bridge` |
| `wechatWsPath` | WeChat 工作区路径（须为已存在目录） | 包目录 |
| `secret` | `/wxb/*` 端点共享密钥 | `dsh-wechat-bridge-local-token`（仅 127.0.0.1） |
| `preset` | 微信 agent 的 preset | `cordis` |
| `approvalPolicy` | `never` / `ask` | `never`（手机端无法点批准） |
| `base` | 端点前缀 | `/wxb` |
| `workspaceTitle` | GUI 工作区名称 | `WeChat` |

> 修改配置后需**重启 DSH** 生效。配置页保存的值会覆盖 `cordis.patch.yml` 中
> `config` 的同名字段。

## 微信内命令

| 命令 | 说明 |
|------|------|
| `/new`（或 `/重置`） | 开启新对话（第 N+1 轮），旧对话完整保留 |
| `/history`（或 `/历史`） | 列出历史会话 |
| `/history 数字` | 查看对应轮次对话内容 |
| `/help`（或 `/帮助`） | 命令帮助 |

## 注意事项

- **扫码的账号成为机器人**：它对收到的消息自动回复，建议使用小号。
- 任何能给机器人发消息的人都获得一个带完整工具权限、免批准的 DSH agent
  （`approvalPolicy: never` + workspace-write 沙箱）。多人使用务必自行加白名单
  （`bridge/bridge.js` 的 `WECHAT_ALLOW_USERS` 环境变量）。
- 依赖 Node.js ≥ 22；`/wxb/*` 端点仅监听 `127.0.0.1`。

## License

MIT
