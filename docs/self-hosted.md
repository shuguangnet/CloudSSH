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

初始化不会覆盖已有密码。轮换时用原项目 `hash-password` 工具生成新校验值，替换卷中的 `admin-password-hash`（权限 600），重启服务；旧浏览器会话和旧 MCP 令牌均失效。

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
