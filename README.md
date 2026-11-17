# dsh-tailscale-serve

把当前 DSH Web 界面发布到你的 **tailnet HTTPS** 上，只依赖 `tailscale` 命令，不依赖任何其他插件。

手机、笔记本等装了 Tailscale 并登录同一 tailnet 的设备，直接打开
`https://<你的机器名>.<tailnet>.ts.net/` 就能用当前 DSH —— 不需要 URL token，
不需要管理密码；不在 tailnet 里的设备连不上，因为只有 tailscaled 在监听该端口。

## 工作原理

```
browser ──HTTPS──▶ tailscaled（终止 TLS，仅 tailnet 可达）
                 ──HTTP──▶ 127.0.0.1:<临时端口>（本插件的桥）
                 ──HTTP──▶ 127.0.0.1:<dsh 端口>（ctx.webServer）
```

DSH 的 API/WebSocket 校验 Host/Origin 并绑定 `dsh-auth-*` 会话 cookie。
`tailscale serve` 会改掉 Host，所以插件在本机临时端口起一个桥：把 Host/Origin
改写回 loopback 地址，并通过 DSH 公开的 `connection.authenticatedUrl()`
（进程启动令牌）换取一个 loopback 权限的会话 cookie 后重放。桥只监听
`127.0.0.1`，因此除 Tailscale 之外没有额外攻击面。

## 对 tailscale 的改动范围（有意保持最小）

- 只启动**一条前台** `tailscale serve --https=<port> --yes http://127.0.0.1:<桥端口>`；
  前台进程退出即撤销映射，所以停用/卸载插件时映射自动消失。
- 启动前读取 `tailscale serve status --json`；若该 `主机名:端口` 已有其他 handler，
  **拒绝覆盖**并提示换端口或由你手动删除。
- 不调用 `tailscale set / up / down / cert`，不写 `serve --bg`，不调用
  `serve reset` / `serve clear`，不自动 sudo，不修改 tailscale 偏好设置。

## 前置条件

1. 本机已登录 tailscale 且 `tailscale status` 显示 Running。
2. tailnet 已启用 **MagicDNS** 与 **HTTPS Certificates**
   （管理后台 → DNS / HTTPS 证书）。首次 serve 时 tailscaled 会自动申请证书，约 10–60 秒。
3. 允许你的用户使用 `tailscale serve`。若日志提示
   `Access denied: serve config denied`，执行一次（需要你自己执行，插件不会自动 sudo）：
   ```bash
   sudo tailscale set --operator=$USER
   ```

## 安装 / 卸载

```bash
git clone https://github.com/iceleaf916/dsh-tailscale-serve.git
```

在本仓库目录用 dsh 的插件安装器安装（`plugin_manager`，target 为本目录绝对路径），
或在插件市场里以本地目录安装。卸载/停用插件后，前台 serve 子进程被终止，映射随之消失。

## 配置（`cordis.patch.yml` 中的 `config`）

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `httpsPort` | `443` | tailnet 上对外服务的 HTTPS 端口；非 443 时 URL 形如 `https://host.ts.net:8443/` |
| `tailscaleBin` | `tailscale` | tailscale CLI 路径 |
| `retryMs` | `20000` | tailscale 尚未就绪时的重试间隔（毫秒，5s–300s） |

## 验证

```bash
# 映射是否存在
tailscale serve status

# 本机通过 MagicDNS 名称访问（CorpDNS 关闭时用 --resolve 指向 100.x 地址）
curl --resolve <name>.ts.net:443:<tailscale-ip> https://<name>.ts.net/
```

浏览器里打开同一个 URL 应直接进入 DSH 界面。

## 访问控制

- 只有 tailnet 内的设备能到达 tailscaled 的 443；插件本身不改 tailnet ACL，
  也不在 DSH 里新增账号或密码。
- 桥会拒绝携带**外部 Origin** 的 HTTP/WebSocket 请求（403），防止你在浏览网页时
  被第三方页面借用会话调用本机 DSH；不带 `Origin` 的 curl/CLI 请求不受影响。

## 已知边界

- tailscaled 停止、退出 tailnet 或证书过期未续期时，远程访问不可用；插件会在日志里
  给出原因并按 `retryMs` 重试。
- 若 DSH 进程被 `SIGKILL`（插件来不及善后），前台 serve 子进程可能残留并继续持有映射；
  再次启用时插件会检测到该 `主机名:端口` 已有 handler 并拒绝覆盖。此时先结束残留进程
  （`pgrep -af 'tailscale serve'`）再启用，或手动 `tailscale serve reset`。
- 某些插件会在页面里注入指向 `127.0.0.1` 的绝对地址（例如 billion-context 的
  `__BILI__`），远程浏览器无法访问那个 loopback 端口；这与本插件无关。
