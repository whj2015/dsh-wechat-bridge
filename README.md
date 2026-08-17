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
- ⚙️ **网页配置页**：`http://127.0.0.1:3080/wxb/config` 浏览器直接改配置，保存即生效
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

3. 重启 `dsh`。首次登录扫码有三种方式（任选其一）：
   - **终端 ASCII 二维码**：DSH 终端日志里直接打印可扫描的二维码（黑白色块）
   - **浏览器大图**：访问 `http://127.0.0.1:3080/wxb/qr`（仅 127.0.0.1，无鉴权）
   - **扫码链接**：终端日志打印的链接，微信内打开/转发后长按识别
   
   用手机微信（建议小号）扫码确认，凭据保存在 `bridge/wechat-credentials/`，之后免扫码。

> 说明：host 安装没有 Web 面板（动态插件才有），登录后如需看状态，访问
> `http://127.0.0.1:3080/wxb/status`（JSON）或查看终端日志/WeChat 工作区。

## 配置页面

host 安装后无需碰终端：浏览器打开 **`http://127.0.0.1:3080/wxb/config`**
（与 `/wxb/qr` 同策略、仅 127.0.0.1 可访问），即可查看/修改全部配置并保存。
保存的值写入 DSH 的 `settings.yaml`（`dsh-wechat-bridge` 命名空间），
**覆盖** `cordis.patch.yml` 中 `config` 的同名字段；留空的字段回落到默认值。

| 配置项 | 说明 | 默认 |
|--------|------|------|
| `bridgeDir` | bridge 进程目录 | 包内 `./bridge` |
| `wechatWsPath` | WeChat 工作区路径 | 包目录 |
| `secret` | `/wxb/*` 端点共享密钥 | `dsh-wechat-bridge-local-token`（仅 127.0.0.1） |
| `preset` | 微信 agent 的 preset | `cordis` |
| `approvalPolicy` | `never` / `ask` | `never`（手机端无法点批准） |
| `base` | 端点前缀 | `/wxb` |
| `workspaceTitle` | GUI 工作区名称 | `WeChat` |

保存行为：
- `secret` 保存后 **立即生效**（路由重新鉴权 + bridge 自动重启）；
- 其余字段（`preset`/`approvalPolicy`/`base`/`bridgeDir`/`wechatWsPath`/
  `workspaceTitle`）在启动时读入常量，保存后需**重启 DSH** 完全生效，页面会提示；
- 页面上的「恢复默认」按钮可一键清空所有已保存覆盖，回到组合配置。

> 为什么不在原生 Settings 页？DSH 内核（`dsh-host-apiproxy`）对 Web 设置页
> 渲染的命名空间有**硬编码白名单**（核心插件专属），第三方 host 插件注册的
> 命名空间会被 `settings-not-exposed` 拒绝，且该扩展点在内核中是"deferred work"。
> 因此本插件自带独立配置页，无需改动内核、升级不失效。

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
