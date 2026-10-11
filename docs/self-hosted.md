# Docker、脚本部署与外部 MCP 运维

本 Fork 增加独立的 Node.js 运行环境，无需 Cloudflare 账号。复用原项目的网页终端、SSH 协议、SFTP、管理员／GitHub 登录和服务器数据库；外部 AI 通过 MCP 调用这些已保存服务器，浏览器无需保持打开。

## Docker 一键部署

需要 Docker Engine 和 Compose v2 或更高版本。

```bash
git clone --branch test https://github.com/shuguangnet/CloudSSH.git
cd CloudSSH
cp .env.example .env
bash scripts/deploy.sh --docker
```

脚本构建镜像、初始化管理员密码并启动服务。**首次运行会显示一次随机管理员密码，请保存。** 再次运行保留账号和数据。打开 `http://localhost:8787`，使用管理员密码登录。

默认绑定 `127.0.0.1:8787`。远程访问时使用 HTTPS 反向代理，将 `.env` 的 `BASE_URL` 改为浏览器实际访问的地址，例如 `https://ssh.example.com`，再运行脚本。反向代理需支持 WebSocket，并将 `/mcp` 请求超时设为至少 210 秒。`BASE_URL` 必须是完整源地址，不带路径；浏览器登录、WebSocket Origin 校验和 MCP 使用同一地址。

仅在受信任内网需要 HTTP 时，可以明确设置 `ALLOW_INSECURE_HTTP=true`、`BIND_ADDRESS=0.0.0.0` 和实际 `BASE_URL`。HTTP 会关闭 Cookie 的 Secure 属性。

若明确使用公网 IP 的 HTTP 地址，同样需要设置上述选项，并将 `BASE_URL` 设为实际地址（例如 `http://5.175.220.95:8788`）。浏览器在 HTTP 下缺少 Web Crypto 时，管理员密码预拉伸通过本地异步 PBKDF2 兼容实现完成，原始密码仍不会发送给后端；HTTP 传输自身不加密。

管理员密码校验值和所有数据库保存在 `cloudssh-data` Docker 卷中。容器使用非 root 用户、只读根文件系统、无 Linux capabilities。升级使用同一个 Compose 项目和数据卷：

```bash
git pull --ff-only origin test
bash scripts/deploy.sh --docker
docker compose ps
docker compose logs --tail=100 cloudssh
```

停止使用 `docker compose down`。保留数据卷；不要使用 `down -v`，该选项会删除服务器配置、凭据和审计数据。备份前停止服务，再备份整个数据卷，包含 SQLite 数据库及其 WAL 文件。SSH 凭据使用原项目 AES-GCM 行级加密，派生密钥材料也在数据卷内，因此需要保护整个备份。

如需自选管理员密码，先构建镜像，再初始化：

```bash
docker compose build
read -rsp '管理员密码（至少 12 个字符）: ' admin_password; echo
printf '%s\n' "$admin_password" | docker compose run --rm -T --no-deps cloudssh node scripts/setup-standalone.mjs --stdin
unset admin_password
docker compose up -d
```

默认管理员账号为 `admin`（首次初始化可用 `ADMIN_USERNAME` 设置），原有部署升级后密码保持不变。登录后点击用户信息旁的「账号设置」，或访问 `/account/settings`，输入当前密码后即可修改账号或密码。新密码为 12–256 个字符；更改密码会立即使旧登录会话和 MCP 令牌失效，并关闭现有浏览器 SSH 连接，服务器与主机指纹数据保留。只修改账号会保留当前会话和 MCP 令牌。

账号配置持久化到数据卷中的 `admin-account.json`（权限 600），只保存密码校验值。首次启动自动迁移旧 `admin-password-hash`；迁移后以 `admin-account.json` 为准，环境变量和旧文件不会覆盖页面修改的账号密码。原先保存的初始密码文本不会随页面修改更新。

## 服务器文件密钥选择（文件浏览器）

自托管部署的保存服务器弹窗（新增／编辑／克隆）和匿名连接表单在「选择密钥文件」旁提供「服务器文件」入口，可浏览部署服务器上已存在的私钥文件（如 `/root/.ssh/id_ed25519`），选中后内容直接填入私钥文本域，无需从手机或电脑上传。后端提供两个需要管理员会话的只读接口：`GET /api/host-files?path=`（目录列表，目录优先、最多 500 项）和 `GET /api/host-file?path=`（读取不超过 1 MiB 的普通文件）；Cloudflare Workers 部署无此路由，前端探测不到时自动隐藏入口。

无 Docker 脚本部署直接生效，可浏览运行用户的整个文件系统。Docker 部署默认只能浏览容器内部文件；如需选择宿主机上的密钥，在同目录创建 `compose.override.yaml`（已被 .gitignore 忽略）挂载对应目录，例如挂载 root 专属的 `~/.ssh`：

```yaml
services:
  cloudssh:
    user: "0:0"
    volumes:
      - /root/.ssh:/host/keys:ro
```

容器默认以 uid 1000（node）运行，无法读取 root 属主且权限为 700 的 `~/.ssh`；上例改用 root 运行并通过属主权限读取，挂载为只读，容器仍保持只读根文件系统、无 capabilities 与 no-new-privileges。已有部署首次从默认用户切换到 root 时，数据卷内文件仍属 uid 1000，需先调整属主再启动：

```bash
docker compose down
chown -R 0:0 "$(docker volume inspect cloudssh_cloudssh-data --format '{{.Mountpoint}}')"
docker compose up -d
```

多个目录可追加更多 `:ro` 挂载；浏览器中在 `/host/keys` 下选择密钥。

## 无 Docker 脚本部署

需要 Node.js >=22.13 和 pnpm 11.8.0。建议使用当前维护的 Node.js 22 LTS；本地 SQLite 来自 Node.js 内置模块。

```bash
corepack enable
cp .env.example .env
bash scripts/deploy.sh --native
```

脚本安装锁定依赖、构建、初始化账号并以前台方式启动。默认数据在仓库 `data/`，可通过 `.env` 的 `DATA_DIR` 指定绝对路径。再次运行保留已有账号。长期运行可由 systemd 管理，例如将仓库安装到 `/opt/CloudSSH`、为专用服务用户准备可写 `data/` 后使用：

```ini
[Unit]
Description=CloudSSH panel and MCP
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=cloudssh
Group=cloudssh
WorkingDirectory=/opt/CloudSSH
ExecStart=/usr/bin/node --env-file=/opt/CloudSSH/.env /opt/CloudSSH/standalone/server.mjs
Restart=on-failure
TimeoutStopSec=210
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

请按实际 Node.js 安装位置调整 `ExecStart`。首次构建和初始化在启动 systemd 前完成。

## 外部 AI Agent 接入

1. 登录面板，添加服务器，在网页终端连接一次，确认并保存主机指纹。跳板链每一跳都需要已验证指纹。
2. 点击服务器列表用户信息旁的 **MCP**，或访问 `/mcp/settings`。
3. 创建令牌，选择服务器、权限和有效期（最多 365 天）。令牌仅显示一次。
4. 在支持 Streamable HTTP 和 Bearer 请求头的 MCP 客户端中配置：

```json
{
  "mcpServers": {
    "cloudssh": {
      "url": "https://ssh.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <面板生成的令牌>"
      }
    }
  }
}
```

具体配置文件字段因客户端而异；服务地址和 Authorization 请求头保持一致。首版提供独立令牌认证，不提供 MCP OAuth 自动授权；只接受 OAuth 的客户端暂不能直接接入。

| 工具 | 需要权限 | 行为 |
| --- | --- | --- |
| `list_servers` | 任意有效令牌 | 仅列出授权服务器，不返回密码、私钥、隧道 Service Token |
| `execute_command` | `exec` | 执行命令，返回 stdout、stderr、exit_code，超时 1–180 秒 |
| `list_files` | `read` | 列出绝对路径目录 |
| `read_file` | `read` | 返回 base64 编码文件内容，默认 64 KiB、最多 256 KiB |
| `write_file` | `write` | 原子替换 UTF-8 文件，最多 256 KiB |

支持已保存的直连、内网服务器、最多三级 SSH 跳板链，以及 Cloudflare Tunnel WebSocket 连接（可使用保存的 Access Service Token）。MCP 通过独立 SSH exec 通道工作，不依赖面板内置 AI 的 API Key。Docker 容器中的 `127.0.0.1` 指容器自身；连接宿主机或其他服务器时使用容器可达地址。

`exec` 明确授予 SSH 账号的任意命令权限，包括服务重启、Docker 管理和安装部署。内置极端危险命令拦截保留，但无法作为权限沙箱。MCP 没有网页确认对话框，运维写操作由令牌权限预先授权；需要限制系统权限时使用专用 SSH 用户与受限 sudo 策略。`read` 允许读取该 SSH 用户可读的任意文件，`write` 允许替换其有权限写入的任意文件。

文件工具面向 Unix/Linux，依赖 `ls/head/base64/mktemp/chmod/mv`；写入保留已有常规文件的权限位，文件所有者为执行 SSH 用户，新文件默认 600，目标符号链接会被替换。读取内容可能在 `max_bytes` 截断；命令输出复用原项目 4 MiB 捕获上限和头尾保留机制。长任务应由 Agent 使用 systemd/tmux 等远端机制管理，再通过后续调用查询。

## 鉴权与审计

- 自托管始终要求登录，支持管理员密码或 GitHub OAuth；不会开放匿名 SSH。
- 令牌保存 SHA-256 摘要，可撤销、到期、按服务器和操作权限隔离；每次调用及命令执行前重新检查撤销状态。
- 没有授权的工具不会出现在 `tools/list`。外部 Agent 无法指定新的服务器地址或获取面板凭据。
- 首次／变更主机指纹需要用户在面板确认；MCP 自身不接受新指纹。
- 管理接口要求浏览器会话；写操作校验 Origin。MCP 使用 Bearer 认证，有 Origin 时必须与 `BASE_URL` 一致。
- 审计记录开始、成功、失败、拒绝或不确定结果；记录命令 SHA-256 和文件路径，不保存命令正文、输出或凭据。可在管理页查看、按游标加载较早记录。
- 最多 100 个有效令牌／用户、4 个并发 MCP HTTP 请求／令牌、64 个全局并发请求、256 个面板 SSH 对象；请求体最多 1 MiB。取消调用或客户端断开时关闭该调用的 SSH 链，已经产生的远端副作用不会回滚。遇到超时或不确定状态，先检查远端再决定是否重试。

## 自动化（定时任务、可用性监控、推送通知、密钥对生成、PWA）

自托管面板提供 `/automation` 独立页面（主面板右上角入口，仅自托管部署显示），包含六块能力，均仅对管理员会话开放，Cloudflare Workers 部署无这些路由：

- **通知渠道**：支持 Bark、Telegram Bot、自定义 Webhook（POST JSON）和 SMTP 邮件四类。每个渠道保存后可发送测试消息验证；渠道配置仅管理员可读写，通知发送永不阻塞业务（失败仅记录在任务历史里）。
- **定时任务（cron）**：对已保存的服务器按 cron 表达式周期执行命令（标准 5 字段 Vixie 语法，支持 `*/n`、列表、范围、月/星期名称）。任务创建时快照服务器的连接参数，此后修改服务器不影响已建任务；执行超时上限 3600 秒。历史保留最近 50 条/任务，失败时自动推送通知（可关闭）。调度为 at-most-once：派发前先推进下次执行时间，进程崩溃丢弃当次而不是重启后补跑，运维脚本因此不会意外重放。也支持立即手动执行一次。
- **可用性监控**：对直连（非跳板）保存服务器做每分钟的 TCP 端口 + SSH banner 探测（只建连读 banner，不做认证，不会触发 fail2ban），记录延迟绘制最近 24 小时图表；连续失败达到阈值（默认 3 次）判定宕机并推送，恢复后推送恢复通知，每次状态变化只发一次。服务器删除后监控自动清理。
- **面板内生成 ed25519 密钥对**：主面板保存服务器弹窗（密钥认证模式）提供「生成密钥对」按钮，生成的私钥直接填入表单、公钥可一键复制，或通过「部署公钥」以 ssh-copy-id 等价逻辑追加到远端 `~/.ssh/authorized_keys`（幂等、不覆盖已有公钥）。
- **服务器状态面板**：主面板每张服务器卡片旁有「监控」按钮（连接按钮右侧），SSH 终端页顶栏（桌面）与「更多操作」菜单（移动端）也有同名入口，点击弹出实时状态弹窗，显示运行时长、CPU 使用率（两次 `/proc/stat` 采样）、负载、内存/交换/磁盘（带进度条与百分比）、上下行网速、CPU 型号与系统版本，默认每 5 秒自动刷新（可关闭，也可手动刷新）。采集通过保存的 SSH 凭据执行一段 POSIX 脚本完成（跳板链同样支持），单次采集约 1–2 秒；服务器端按服务器限流（1.5 秒最小间隔、单飞行），SSH 失败会在弹窗内提示并可重试。对服务器无侵入（只读 /proc 与 `df`，不做任何写操作）。终端页入口针对当前活跃标签的服务器，多标签切换时自动跟随；URL 直连（未保存服务器）不显示。
- **Docker 容器管理**：服务器卡片旁另有 Docker 按钮，SSH 终端页顶栏（桌面）与「更多操作」菜单（移动端）也有同名入口，弹出容器管理弹窗（`frontend/src/server-docker.ts`），列出全部容器（状态徽标、短 ID、镜像、运行时长、端口映射），默认每 5 秒自动刷新；每个容器支持启动、重启、停止、删除（强制停止后删除，需二次确认）与日志查看（可选尾行 100/500/1000，带时间戳）。所有命令通过该服务器的 SSH 凭据远程执行 `docker` CLI（跳板链同样支持；实现在 `standalone/docker.mjs`，容器名/ID 严格校验 `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$` 后再单引号引用），路由同样按服务器节流；SSH 用户需要 root 或 docker 组权限，未安装 Docker 时弹窗会给出明确提示。
- **终端左右分屏**：SSH 终端页标签栏「➕」旁新增分屏按钮（桌面端显示），点击后终端区拆为左右两个窗格（当前标签在左，最近访问的另一个标签在右），可同时观察/操作两个会话。点击窗格切换焦点（顶部强调线 + 状态栏/标签栏跟随）；点击标签栏会把该标签送入聚焦窗格（已在另一窗格时仅切换焦点，虚线边框提示）；空窗格提供「新建连接到此分栏」入口；分隔条可拖拽（钳制 20%–80%，双击复位 50/50），拖动结束后终端自动重新适配尺寸。关闭窗格内标签后该窗格自动回退到最近的后台标签（无则空窗格），两窗格全空时自动退出分屏；再点分屏按钮或关闭全部标签可随时退出。实现于 `frontend/src/tab-manager.ts`（`toggleSplit`/`renderSplitPanes` 等）。

调度器在面板进程内运行，跟随服务重启；不要让多个服务进程共用同一数据目录，否则 cron 会重复派发。通知渠道中的 SMTP 发件凭据、Telegram token 等仅保存在本地 SQLite，注意保护好数据卷。

### PWA（手机桌面安装）

面板提供 manifest、Service Worker 与应用图标，手机浏览器可直接「添加到主屏幕」后全屏打开：iOS Safari 通过 apple-touch-icon 与 standalone 元数据支持；Android Chrome 需要 HTTPS 部署才会弹出安装横幅（Service Worker 仅在安全上下文注册，纯 HTTP 的公网 IP 部署会自动降级为普通网页模式，其余功能不受影响）。

## 与 Cloudflare 部署的区别

原有 Cloudflare 部署命令保持可用；MCP 和 Docker／脚本部署属于新增的自托管运行环境。自托管使用本地 SQLite 数据库，无 Cloudflare 区域调度，也不会将 SSH 主机地址发送给 IPinfo；允许登录用户已保存的内网 SSH 地址。数据不会自动与 Cloudflare Durable Objects 互通，迁移应通过重新录入服务器或另行开发导出／导入流程完成。

自托管首版关闭一次性 SSH 分享功能；普通终端、SFTP、命令片段和内置 AI 仍复用现有实现。此运行环境为单实例，不要让多个服务进程共用同一个数据目录。服务重启会断开现有 SSH 会话；持久数据和 MCP 令牌保留，执行命令不会自动重放。

## 开发验证

```bash
pnpm run typecheck
pnpm test
pnpm run build:self-hosted
pnpm run test:self-hosted
pnpm run test:e2e
node tests/standalone/docker-smoke.mjs
```

新增 Node.js 测试覆盖令牌持久化／到期／撤销／用户隔离、MCP 官方 SDK 协议与权限、真实服务重启、浏览器 WebSocket 和 OpenSSH 命令／文件／跳板调用。真实 OpenSSH 测试在存在 `/usr/sbin/sshd` 且测试进程为 root 时运行，否则明确跳过；测试只创建临时密钥和配置。Cloudflare Tunnel 复用现有载体实现，需要实际 Cloudflare 账号和隧道才能做外部联调。
