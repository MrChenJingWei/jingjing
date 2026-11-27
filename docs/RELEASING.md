# 发版与升级

用户能升级的唯一条件：**GitHub 上有一个版本号更大的 Release**，里面有 `latest.json` 和升级包。
Release 只由 `v*` tag 触发 CI 生成，所以「只 push main」等于没发版。

日常发版用一条命令：

```bash
npm run release -- 0.7.1 --notes "v0.7.1 修复：设置页模型下拉在窄窗口被截断"
```

---

## 一条命令背后发生了什么

`scripts/release.js` 依次做这些事：

1. 校验新版本号（语义化版本、必须大于当前版本）；
2. 检查在 `main`、工作区干净、没有同名 tag（本机和远程）；
3. 同步 `origin/main`，落后就要求先 pull；
4. 如果 `public/` 自上个 tag 以来有改动，自动刷新 service worker 缓存和资源版本；
5. 跑 `npm test`；
6. 改 `package.json`、`packaging/macos/Info.plist`（ShortVersionString 和 Bundle 号 +1）；
7. 提交 `chore: 版本升到 X`、打注释 tag、推送 `main` 和 tag。

常用参数：

| 参数 | 作用 |
|---|---|
| `--notes "..."` | 更新说明，会原样显示在用户的「关于与更新」里；不写就是 `vX.Y.Z` |
| `--dry-run` | 只打印计划，不改文件、不提交 |
| `--no-push` | 只在本机提交和打 tag，不推送（排练用） |
| `--skip-tests` | 跳过发版前的 `npm test` |
| `--ui` | 强制刷新前端缓存版本（`public/` 没 diff 但想刷缓存时用） |
| `--yes` | 跳过确认 |

## CI 会产出什么

推送 tag 后，`.github/workflows/release.yml` 跑三个 job：

- **release**：校验 tag 与 `package.json` 一致 → `npm test` → `scripts/package-update.sh` 生成代码升级包 → 创建 GitHub Release。
  产物：`jingjing-app-<version>.zip`、`latest.json`、`install.sh`、`install.ps1`（Windows 用同一个升级包）。
- **macos-app**：构建 App 安装包并传进同一个 Release。
  产物：`jingjing-<version>-macos-arm64.pkg`、`.zip`、`SHA256SUMS`。
- **windows-app**：构建 Windows 桌面 App（`packaging/windows/build.ps1`：.NET + WebView2 外壳、打包 Node 运行时、Inno Setup 安装包）并传进同一个 Release。
  产物：`jingjing-<version>-windows-x64-setup.exe`、`jingjing-<version>-windows-x64.zip`、`SHA256SUMS-windows.txt`。

三个 job 都绿，旧用户才能检查到更新、新用户才下得到对应的安装包。

## 验收

```bash
gh run list --workflow=release          # 等三个 job 变绿
gh release view v0.7.1                  # 确认资产齐全
curl -sL https://github.com/MrChenJingWei/jingjing/releases/latest/download/latest.json
```

`latest.json` 里的 `version` 要等于刚发的版本，`sha256` 对应升级包。

## 用户怎么升级

- **已装 App**：设置 → 关于与更新 → 检查更新 → 下载并校验 → 提示「重启服务后生效」。
  升级的是代码层（`server.js` / `src` / `public` / `workers`），**不用重装 pkg**，数据不动。
- **源码启动**：`git pull` 即可。
- **新装 / 重装**：用 Release 里的 `.pkg`，或 `install.sh`（macOS / Linux）、`install.ps1`（Windows）。
- overlay 只在「已装版本严格大于当前运行版本」时生效，所以版本号必须递增。

## 什么时候必须发新 pkg

改了原生外壳才需要用户重装 App：macOS 是 Swift 代码、`Info.plist`、图标、最低系统版本；
Windows 是 `packaging/windows/` 里的 C# 外壳、安装包脚本。
代码层的改动（服务端、前端、Worker、插件）都不需要：两个桌面 App 都从数据目录加载在线更新的代码。

## 常见问题

- **tag 与 package.json 不一致**：CI 直接失败。先改版本号提交，再打 tag。
- **发出去发现有问题**：再发一个补丁版本（0.7.2），不要覆盖已发布的版本号，用户可能已经装了。
- **macOS / Windows job 失败**：在 Actions 里重跑该 job，或手动 `workflow_dispatch`（按当前 `package.json` 版本重新上传）。
- **Windows job 卡在「运行测试」**：本地 `npm test` 只跑 macOS/Linux，Windows 只在 CI 上跑，本地绿不代表 Windows 绿。先看失败用例（Actions 的 annotations，或 `gh run view <run-id> --log`）；最常见的是测试里写死了 `/` 路径分隔符，例如 `path.relative` 在 Windows 返回反斜杠——断言用 `path.join('a', 'b')`，或按平台比较。修完先 push `main`，等 `test` workflow 的 Windows job 通过，再打 tag（release 会重跑一遍）。v0.13.1 修过一次 `tests/permissions.test.js`。
- **要撤掉发错的 tag**：`git push --delete origin v0.7.1` 后重打；但用户已经拉到的更新不会自动回滚。
- **更新说明从哪来**：CI 读 tag 的附注；脚本把 `--notes` 写进 tag，所以写用户能看懂的话。

## 版本号约定

- 新功能、行为变化：`0.x.0`
- 纯修复：`0.x.y`
- 同一个版本号永远只用一次；发过的号不能复用。
