# 天工反馈桌面客户端（Electron，macOS / Windows）

配置好后打开就是问题库（自动登录）；**控制台**（运行状态、设置、诊断）是单独窗口，从问题库左下角、菜单栏（Windows 系统托盘）图标或 ⌘,（Ctrl+,）打开。首次使用显示封面和分步引导。交互参照 tiangong-chat 的桌面端。

| 事项 | 做法 |
|---|---|
| 数据 | macOS `~/Library/Application Support/com.tiangong.feedback/`，Windows `%APPDATA%\com.tiangong.feedback\`：`data/` 数据，`config.json` 设置，`logs/` 日志 |
| 密钥 | 登录密码、AppSecret 加密存 `secrets.json`，由系统加密（macOS 钥匙串 / Windows DPAPI） |
| 服务 | 独立的 utilityProcess（`service-entry.mjs`）跑与命令行版同一份服务；崩溃按 2s→60s 退避重启，配置或端口错误不重试 |
| 窗口 | 关窗 = 收到菜单栏，服务继续；退出时先优雅停服务 |
| 安全 | 控制台页面只能调用白名单接口；问题库窗口加载的是网页，只多一个「打开控制台」的能力 |
| 外网 | 「设置 → 访问 → 外网访问」填域名；只信任本机上的代理（`TRUST_PROXY=loopback`），HTTPS 访问自动用安全 Cookie，局域网 HTTP 不受影响；此时要求密码至少 12 位 |
| 导入 | 封面「我用过旧版」选项目文件夹；数据库取一致快照、附件复制，不改旧文件夹。macOS 只会停止正打开着 `feedback.db` 的旧版进程；Windows 不代为结束进程，提示自己关 |

```bash
npm ci && cd desktop && ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm ci
npm run build:mac  # → release/天工反馈.app 和 .dmg（当前机器的架构，只能在 macOS 上）
npm run build:win  # → release/天工反馈-*-x64-setup.exe（macOS 上交叉打包；Windows 上用 node build.mjs win）
npm test           # 设置、导入单元测试
npm run test:e2e   # 驱动打包后的 .app（macOS），模拟 QQ 平台；截图在 ../test-output/desktop
```

没有开发者证书时是临时签名：在本机打包可直接打开；发给别的 Mac 首次打开要到「系统设置 → 隐私与安全性」点「仍要打开」，每次重新打包后钥匙串也会再询问一次（点「始终允许」）。有证书时设 `CODESIGN_IDENTITY`，正式分发还需公证。

## Windows

- NSIS 安装包，x64，装在当前用户目录，不需要管理员；可改安装位置。升级直接装新版，卸载不删数据。
- 自带 VC++ 运行库（`vendor/`），干净的 Windows 10 / 11 可直接用。
- 首次启动 Windows 防火墙弹窗要勾选「专用网络」，否则手机打不开。
- 签名：在插着 EV Key 的 Windows 上设 `SIGN_CERT_SHA1`（可加 `TG_DESKTOP_SIGN=1` 强制）后 `node build.mjs win`。未签名的包首次运行 SmartScreen 会提示，点「更多信息 → 仍要运行」。签名流程和安装包**还没在 Windows 实机验证**，验收步骤见 [../docs/验收清单.md](../docs/验收清单.md)。
