# `cssh` — CloudSSH 命令行客户端

自托管运行时可选的命令行客户端。凭据永远留在面板，CLI 只持有**访问令牌**，
因此权限、有效期、撤销都能在面板里统一管理，终端侧不留任何服务器密码或私钥。

```bash
cssh                       # 交互选择服务器
cssh prod                  # 唯一命中就直接连
cssh @database             # 按标签
cssh 42 -- df -h           # 按 id，跑一条命令就退出
cssh -                     # 重连上一次
```

`cssh` 与 `cloudssh` 是同一个程序的两个名字（安装后都可用）。

---

## 安装

要求 **Node.js ≥ 20**（用到 `node:` 前缀的 ESM 与顶层 await）。

### A. 面板所在的机器（最简单）

官方 Docker 镜像里已经带好了 CLI，直接在容器里跑，不用装任何东西：

```bash
# 面板和服务同机时，走容器内回环（令牌不会经过网络）
docker exec -it cloudssh-cloudssh-1 \
  node /app/standalone/cli.mjs login http://127.0.0.1:8787
```

想把 `cssh` 变成这台机器上的普通命令（本机也装了 Node ≥ 20）：

```bash
# $REPO 换成仓库的实际路径
sudo ln -sf "$REPO/standalone/cli.mjs" /usr/local/bin/cssh
sudo ln -sf "$REPO/standalone/cli.mjs" /usr/local/bin/cloudssh
```

`standalone/cli.mjs` 是 `#!/usr/bin/env node` 脚本，软链到 PATH 里即可。注意它
依赖仓库里的 `node_modules`（唯一的运行时依赖是 `ws`），所以**不要**把单个文件
拷走——要么软链到仓库内，要么用下面的方式装。

### B. 从 Git 安装（推荐给日常使用）

```bash
npm i -g "github:shuguangnet/CloudSSH#test"
# 之后 cssh 与 cloudssh 都在 PATH 上
cssh --version
```

这会把整包（含 `ws`）装进全局 `node_modules`，之后与仓库目录无关，升级走
`npm i -g` 重装即可。Linux 上如果提示 `EACCES`，别加 `sudo`，改用
`npm config set prefix ~/.local` 并把 `~/.local/bin` 加进 `PATH`。

### C. 单文件（拷到别的机器，无 node_modules）

只有 `ws` 一个运行时依赖，打成单个 `.cjs` 就没有任何外部依赖了：

```bash
cd "$REPO"
npx esbuild standalone/cli/main.mjs --bundle --platform=node \
  --format=cjs --target=node20 --outfile=cssh.cjs
chmod +x cssh.cjs && ./cssh.cjs --version
```

两个打包坑（都实测过）：

- **必须 `--format=cjs`，不能用 esm**。`ws` 内部有 `require('events')` 这类动态
  `require`，打 ESM 时 esbuild 无法静态化，运行期直接报
  `Dynamic require of "events" is not supported`。
- **入口用 `standalone/cli/main.mjs`，不能用 `standalone/cli.mjs`**。后者是
  `await import(join(here,'cli','main.mjs'))` 的动态路径，打包工具跟不进去，
  产物里只剩那两行 import。

### D. 从源码仓库

```bash
cd "$REPO"
pnpm install            # 首次需要，装 ws 等运行时依赖
npm link                # 之后 cssh / cloudssh 都在 PATH 上，改代码即时生效

# 不想 link 也可以直接跑
node standalone/cli.mjs whoami
```

首次登录：

```bash
cssh login https://panel.example.com
# 提示粘贴访问令牌（不回显）
```

令牌在面板「设置 → MCP 令牌」中创建，勾选需要的权限（`read` / `write` / `exec`）
与服务器范围。CLI 与 MCP 客户端共用同一套令牌。

---

## 令牌与配置

| 来源 | 说明 |
| --- | --- |
| `--token <值>` | 优先级最高。**会出现在 `ps` 里，仅用于一次性排查** |
| `CLOUDSSH_TOKEN` | 环境变量，CI / 自动化推荐 |
| 配置文件 | `cssh login` 写入，权限 `0600`，目录 `0700` |

配置目录遵循 XDG：默认 `$XDG_CONFIG_HOME/cloudssh/`（通常是 `~/.config/cloudssh/`），
可用 `CLOUDSSH_CONFIG_HOME` 覆盖。

```bash
export CLOUDSSH_URL=https://panel.example.com
export CLOUDSSH_TOKEN=cssh_xxxxxxxx
cssh whoami
```

其他环境变量：

- `CLOUDSSH_YES=1`：跳过写操作的确认提示
- `NO_COLOR=1`：关闭颜色

明文 HTTP 默认**只允许回环地址**。远程面板请配 TLS；确实只能明文时加
`--insecure`（或 `CLOUDSSH_INSECURE=1`）显式承担令牌被链路上任何一跳看到的风险。

---

## 命令

### 连接

| 命令 | 说明 |
| --- | --- |
| `cssh [关键词]` | 交互选择；唯一命中直接连 |
| `cssh ssh <名称>` | 显式进交互终端 |
| `cssh exec <名称> -- <命令>` | 跑一条命令，退出码原样透传 |
| `cssh exec <名称> --stream -- <命令>` | 流式输出（适合 `tail -f`、构建日志） |
| `cssh -` | 重连上一次的服务器 |

关键词按 **id 全等 → 名称全等 → 别名 → 名称前缀 → 主机前缀 → 标签 → 子串 → os**
逐级打分。**唯一命中才自动连**；多命中给选择器，零命中给最近似的建议——绝不瞎猜。

### 文件传输

```bash
cssh cp up ./build.tar.gz prod:/tmp/
cssh cp down prod:/var/log/app.log ./app.log
```

按 96 KiB 分块走面板已有的 SFTP 通道，不新开端口。下载默认**不覆盖**本地已存在
的文件，`--force` 才覆盖；新文件权限 `0600`。

### 命令片段

```bash
cssh snippet ls               # 列出面板里保存的片段
cssh snippet run deploy prod  # 在 prod 上执行「deploy」片段
```

### 数据库

需要令牌带 `db_connection_ids` 授权。

```bash
cssh db ls                          # 已授权的连接
cssh db schema prod-db users        # 表结构
cssh db query prod-db "SELECT 1"    # 结果按 CJK 宽度对齐成表格
```

查询结果的敏感内容（私钥块、连接串口令、`PASSWORD=` / `API_KEY=` 一类键值、
`sk-` 风格密钥、JWT）会被替换成 `***`，命中数量会单独提示——**数据库里仍是原值**，
别把 `***` 回写进去。

### 维护

| 命令 | 说明 |
| --- | --- |
| `cssh login [地址]` | 登录并保存令牌（先验证再落盘） |
| `cssh logout` | 清除本地令牌 |
| `cssh whoami` | 身份、权限、可用服务器、令牌有效期 |
| `cssh ls [关键词]` | 列出可用服务器 |
| `cssh forget <名称>` | 清除已知主机指纹 |
| `cssh aliases set <别名> <目标>` | 自定义快捷方式 |

---

## 主机指纹（TOFU）

首次连接某台服务器时，面板会返回它看到的指纹，CLI 打印出来并请你确认；
确认后写入已知主机库，之后指纹必须完全一致。

**指纹变更时 CLI 立刻断开，退出码 3**，并同时打印「期望」与「实际」两个指纹。
没有任何自动信任、自动重试或「忽略一次」的开关——服务器被换掉、中间人攻击、
或者只是重装了系统，都需要人来判断。确认是重装后先 `cssh forget <名称>` 再连。

指纹的写入路径只有一条：`host_key_verified` 事件（首次连接 + 签名已验证）。
修改已有指纹的接口**不存在**，这是刻意的。

---

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 一般错误（网络、面板 5xx、参数问题） |
| 3 | **主机指纹变更，已中断连接** |
| 7 | 远端命令返回非零时透传的原始退出码（`cssh exec`） |
| 77 | 令牌无效或权限不足（配置问题，与「命令失败」区分开） |
| 130 | 用户按 Ctrl-C |

`cssh exec` 的远端退出码会**原样透传**，因此可以直接放进脚本：

```bash
if cssh exec prod -- systemctl is-active nginx; then echo up; fi
```

---

## 安全边界

- 令牌只进 `Authorization: Bearer` 头，**绝不进 URL**；WebSocket 升级同样走请求头。
- 令牌文件 `0600`，配置目录 `0700`；权限过宽时启动会提示收紧。
- CLI 不缓存、不落盘任何服务器凭据——它在面板侧解密，CLI 只拿到已建立的连接。
- 危险命令闸门（`rm -rf /` 一类）对 CLI 与 MCP **同一道**，CLI 不是旁路。
- 令牌可随时在面板撤销，撤销后 CLI 立刻失效。

---

## 故障排查

**「令牌无效或已过期」** — 面板里令牌可能被撤销或到期了，重新 `cssh login`。

**「找不到匹配的服务器」** — `cssh ls` 看看当前令牌被授权了哪些机器。
令牌的服务器范围在面板创建/编辑令牌时设定。

**「没有指纹，请先在面板连接一次」** — `cssh exec` 走的是池化链路，要求每一跳
的指纹都已信任。先用 `cssh <名称>` 连一次（会走 TOFU 流程），之后 `exec` 就能用。

**指纹变了** — 先确认是不是有人重装了系统或换了机器。确认无误后
`cssh forget <名称>`，再连一次重新走 TOFU。
