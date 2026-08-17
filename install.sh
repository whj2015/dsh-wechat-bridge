#!/usr/bin/env bash
# ============================================================================
# dsh-wechat-bridge — 一键安装脚本
#
# 用法:
#   bash install.sh
#
# 自动完成:
#   1. 克隆插件到 DSH profile 目录 (~/.dsh/profiles/web/)
#   2. 安装 bridge 依赖 (npm install)
#   3. 注册插件到 cordis.patch.yml
#   4. 提示重启 DSH
# ============================================================================
set -e

REPO_URL="https://github.com/whj2015/dsh-wechat-bridge.git"
PROFILE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/web"
PLUGIN_DIR="$PROFILE_DIR/dsh-wechat-bridge"

echo "==> dsh-wechat-bridge 一键安装"
echo "    profile 目录: $PROFILE_DIR"
echo "    DSH_HOME:     ${DSH_HOME:-$HOME/.dsh}"

# ---- 1. 确认 profile 目录 ----
if [ ! -d "$PROFILE_DIR" ]; then
  echo "!! 未找到 profile 目录: $PROFILE_DIR"
  echo "   请先启动过一次 DSH（dsh web）生成 profile，再运行本脚本。"
  exit 1
fi

# ---- 2. 获取插件代码 ----
if [ -d "$PLUGIN_DIR/.git" ]; then
  echo "[1/4] 插件已存在，拉取最新代码…"
  (cd "$PLUGIN_DIR" && git pull --ff-only) || echo "    （拉取失败，继续使用现有代码）"
else
  echo "[1/4] 克隆插件到 $PLUGIN_DIR …"
  git clone "$REPO_URL" "$PLUGIN_DIR"
fi

# ---- 3. 安装依赖 ----
echo "[2/4] 安装依赖（Node ≥ 22）…"
echo "    插件依赖:"
(cd "$PLUGIN_DIR" && npm install --cache ./.npm-cache --no-audit --no-fund)
echo "    bridge 依赖:"
(cd "$PLUGIN_DIR/bridge" && npm install --cache ./.npm-cache --no-audit --no-fund)

# ---- 4. 注册到 cordis.patch.yml ----
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
echo "[3/4] 注册插件到 $PATCH_FILE …"
if [ ! -f "$PATCH_FILE" ]; then
  echo "[]" > "$PATCH_FILE"
fi
if grep -q "dsh-wechat-bridge" "$PATCH_FILE"; then
  echo "    已注册（跳过）"
else
  # 空数组文件（内容仅为 []）必须整体替换，否则 append 会产生两个 YAML 文档
  TRIMMED="$(tr -d '[:space:]' < "$PATCH_FILE")"
  if [ "$TRIMMED" = "[]" ] || [ -z "$TRIMMED" ]; then
    cat > "$PATCH_FILE" <<'EOF'
# dsh-wechat-bridge: 微信接入 DSH（安装脚本自动添加）
- insert:
    - id: dsh-wechat-bridge
      name: ./dsh-wechat-bridge/index.js
      config: {}
EOF
    echo "    已写入注册条目（覆盖空列表）"
  else
    cat >> "$PATCH_FILE" <<'EOF'

# dsh-wechat-bridge: 微信接入 DSH（安装脚本自动添加）
- insert:
    - id: dsh-wechat-bridge
      name: ./dsh-wechat-bridge/index.js
      config: {}
EOF
    echo "    已追加注册条目"
  fi
fi

# ---- 5. 完成 ----
echo "[4/4] ✅ 安装完成！"
echo ""
echo "  最后一步：重启 DSH"
echo "    1) 停止当前运行的 dsh"
echo "    2) 重新启动:  dsh web   （或 npm exec @deepseek-ai/dsh web）"
echo ""
echo "  启动后："
echo "    - 终端日志出现扫码链接，用手机微信（建议小号）扫码登录"
echo "    - 浏览器打开 http://127.0.0.1:3080/wxb/config 可修改配置"
echo "    - 侧边栏出现 WeChat 工作区，微信消息由 DSH agent 回复"
