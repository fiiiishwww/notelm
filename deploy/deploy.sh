#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  NoteLM 云上一键部署脚本（Alibaba Cloud Linux 3 / CentOS 8 系）
#
#  用法：
#    curl -fsSL <这个文件的地址> -o deploy.sh
#    sudo bash deploy.sh
#
#  部署前请先在控制台做两件事（脚本管不了）：
#    1. 给实例「分配公网 IP」（或绑定弹性公网 IP）
#    2. 安全组入方向放行本脚本用的端口（默认 3000）
#
#  可改的环境变量（都在脚本顶部，按需改完再跑）：
#    APP_DIR      安装目录          默认 /opt/notelm
#    APP_PORT     Node 监听端口     默认 3000
#    GIT_REPO     代码仓库地址（留空则跳过拉取，只重新构建已有代码）
#    AUTH_USER    登录用户名        默认 notelm
#    AUTH_PASS    登录密码          默认随机生成（跑完会打印，务必保存）
#    PUBLIC_HOST  公网 IP 或域名（Host 白名单，必须填，否则公网访问一律 403）
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/notelm}"
APP_PORT="${APP_PORT:-3000}"
GIT_REPO="${GIT_REPO:-}"
AUTH_USER="${AUTH_USER:-notelm}"
AUTH_PASS="${AUTH_PASS:-}"
PUBLIC_HOST="${PUBLIC_HOST:-}"
NODE_VER="${NODE_VER:-v22.11.0}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m[失败]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash deploy.sh"

# ── 1. 交换分区：2G 内存的机器必须有，pdfjs 解析大 PDF 峰值会到 500MB+ ──
say "1/7 配置 swap（2G，已有则跳过）"
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  echo "swap 已开启"
else
  echo "swap 已存在，跳过"
fi

# ── 2. 基础工具 ──
say "2/7 安装基础工具"
dnf install -y -q git tar curl which >/dev/null 2>&1 || true

# ── 3. Node 22（官方二进制，不依赖发行版仓库版本） ──
say "3/7 安装 Node ${NODE_VER}"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v)" != "${NODE_VER}" ]; then
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64) NODE_ARCH=linux-x64 ;;
    aarch64) NODE_ARCH=linux-arm64 ;;
    *) die "不支持的架构：${ARCH}" ;;
  esac
  curl -fsSL "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-${NODE_ARCH}.tar.xz" -o /tmp/node.tar.xz \
    || die "下载 Node 失败，检查网络或换版本（NODE_VER）"
  rm -rf /opt/node
  mkdir -p /opt/node
  tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /usr/local/bin/node
  ln -sf /opt/node/bin/npm /usr/local/bin/npm
  ln -sf /opt/node/bin/npx /usr/local/bin/npx
fi
node -v
npm -v

# ── 4. 代码 ──
say "4/7 准备代码于 ${APP_DIR}"
mkdir -p "$APP_DIR"
if [ -n "$GIT_REPO" ]; then
  if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" pull --ff-only || echo "拉取失败，沿用现有代码"
  else
    git clone "$GIT_REPO" "$APP_DIR"
  fi
fi
[ -f "$APP_DIR/package.json" ] || die "${APP_DIR} 里没有 package.json，先把代码放进来或设 GIT_REPO"
mkdir -p "$APP_DIR/notes" "$APP_DIR/.local"

# ── 5. 依赖 + 构建 ──
say "5/7 安装依赖并构建前端"
cd "$APP_DIR"
# 构建需要 vite / tsx 这些 devDependencies，这里只能全量装（产物只有 dist，源码不对外）
npm install
npx vite build

# ── 6. 环境变量与 systemd ──
say "6/7 写入环境配置与 systemd 服务"
[ -n "$PUBLIC_HOST" ] || die "必须设 PUBLIC_HOST（公网 IP 或域名），否则公网访问会被 Host 校验 403"
if [ -z "$AUTH_PASS" ]; then
  AUTH_PASS="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)"
  GEN_PASS=1
else
  GEN_PASS=0
fi

cat >"$APP_DIR/.env" <<EOF
PORT=${APP_PORT}
NB_HOST=0.0.0.0
NB_PUBLIC_HOST=${PUBLIC_HOST}
NB_AUTH_USER=${AUTH_USER}
NB_AUTH_PASS=${AUTH_PASS}
NB_NO_OPEN=1
EOF
chmod 600 "$APP_DIR/.env"

# config.json：预置 vaultRoot，避免首次打开还要在界面里选目录
if [ ! -f "$APP_DIR/.local/config.json" ]; then
  printf '{\n  "vaultRoot": "%s/notes"\n}\n' "$APP_DIR" >"$APP_DIR/.local/config.json"
fi

cat >/etc/systemd/system/notelm.service <<EOF
[Unit]
Description=NoteLM
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=/opt/node/bin/node --import tsx server/index.ts --prod
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable notelm >/dev/null 2>&1
systemctl restart notelm
sleep 3

# ── 7. 每日备份 ──
say "7/7 配置每日备份（保留 14 天）"
mkdir -p /var/backups/notelm
cat >/usr/local/bin/notelm-backup.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SRC=/opt/notelm/notes
DST=/var/backups/notelm
mkdir -p "$DST"
tar -czf "$DST/notes-$(date +%F).tar.gz" -C /opt/notelm notes .local 2>/dev/null || true
find "$DST" -name 'notes-*.tar.gz' -mtime +14 -delete
EOF
chmod +x /usr/local/bin/notelm-backup.sh
( crontab -l 2>/dev/null | grep -v notelm-backup ; echo "20 4 * * * /usr/local/bin/notelm-backup.sh" ) | crontab -

# ── 结果 ──
systemctl --no-pager status notelm | head -5 || true
say "部署完成"
echo "  访问地址：http://${PUBLIC_HOST}:${APP_PORT}"
echo "  登录用户：${AUTH_USER}"
if [ "$GEN_PASS" = "1" ]; then
  echo "  登录密码：${AUTH_PASS}   ← 随机生成，请立刻保存"
else
  echo "  登录密码：（你指定的那个）"
fi
echo "  备份目录：/var/backups/notelm（每日 04:20，保留 14 天）"
echo "  常用命令：systemctl status|restart|stop notelm ；journalctl -u notelm -f"
echo ""
echo "  ★ 若打不开：99% 是安全组没放行 ${APP_PORT} 端口，去控制台「安全组 → 入方向」加一条 TCP:${APP_PORT} 来源 0.0.0.0/0"
