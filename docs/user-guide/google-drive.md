# Google Drive 同步（实验版）

本分支在 Serpent 0.2.9 的同步引擎上增加 Google Drive v3 原生接口。无需 WebDAV 转接，也无需把整个本地数据库目录放进 Drive 桌面同步盘。

**适用方式：Windows 和 Mac 轮流使用，等一台同步完成后再切换。当前版本不保证两台设备同时写入同一资源库的一致性。** Drive 没有文件名唯一约束，本实现也不宣称支持 WebDAV 的 ETag 条件写入或跨设备锁。首次试用请使用资产副本。

## 首次配置

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 创建或选择一个项目，启用 **Google Drive API**。
2. 配置 Google Auth Platform 的 Branding、Audience 和 Data Access。同意屏幕的应用名称可用 `Serpent Personal`。申请的范围只有 `https://www.googleapis.com/auth/drive.file`。
3. 创建 **Desktop app / 桌面应用** 类型的 OAuth 客户端，保存客户端 ID 和 Google 提供的客户端密钥。不要用 Web application 类型，不需要部署登录服务器。
4. 外部应用在 Testing 状态时，将自己使用的 Google 账号加入 Test users。包含 Drive 范围的测试应用刷新令牌通常会在 7 天后过期；届时编辑连接并重新授权，或按 Google 要求调整发布状态。此处的发布状态是 OAuth 项目的状态，不是发布你的资产。
5. 在 Serpent「设置 → 同步」选择 **Google Drive**，填入客户端 ID、客户端密钥。第一台电脑的文件夹 ID 留空。
6. 点击「连接 Google Drive」。在系统浏览器中选择账号并同意访问。登录回调只监听本机 `127.0.0.1` 的随机端口，采用 state 和 S256 PKCE，三分钟后超时。
7. 连接成功后，设置页会显示同步根文件夹 ID。应用在 My Drive 下创建或查找一个由同一 OAuth 应用标记的 `Serpent` 文件夹；不会仅凭文件夹名称接管其他同名资料。
8. 在资源库设置中选择该连接及同步文件夹名称，先预览，再同步。初次试用建议关闭自动同步，手动完成首次上传。

本版本使用个人 My Drive；Shared Drives、团队多人协作和任意 Drive 文件浏览不属于本次支持范围。`drive.file` 仅能访问该 OAuth 应用创建或获准访问的文件；直接填写一个任意已有文件夹的 ID 并不赋予访问权限。本版未提供 Google Picker 授权已有文件夹。

## 在 Mac / 第二台电脑打开

1. 使用这个分支构建的 Serpent。两台电脑使用**相同的 OAuth 客户端 ID 和同一个 Google 账号**，分别在自己的系统浏览器授权。
2. 填入第一台设置页显示的**同步根文件夹 ID**，不要填写完整 Drive URL，也不要填写根下面某个资源库的文件夹 ID。
3. 使用「打开同步资源库」，选择同一个连接和远端资源库，将其下载到第二台电脑的本地磁盘。
4. 等第一台同步完成，再在第二台编辑。切换回第一台前同样先完成同步。

每台设备各自保存本地资源库、数据库和加密凭据。不要复制 `sync-servers.json` 来共享令牌，也不要让 Drive Desktop 同时同步这些本地资源库目录。`safeStorage` 密文与本机系统凭据存储绑定，不能作为跨设备登录文件。

## 同步内容与限制

| 内容 | 本分支行为 |
| --- | --- |
| 托管资产的文件内容 | 上传、下载、移动、重命名，使用原始二进制内容 |
| 标签、描述、评分、收藏、现有 AI 元数据 | 复用 Serpent 的 metadata sidecar 同步 |
| 字体、AI 图样、模型、Grasshopper 文件 | 作为托管资产同步；预览能力仍由 Serpent 原有预览器决定 |
| SQLite 数据库 | 不上传、不共享 |
| 合集成员关系、链接文件夹中的资产 | 仍不在原有同步协议范围内 |
| 字体安装、Rhino/GH 插件安装 | 不负责安装，需在各设备另行配置 |
| 两台离线设备先后同步各自修改 | 复用现有冲突副本处理，测试覆盖内容冲突 |
| 两台设备同时同步、边同步边编辑 | 不保证一致性，暂不支持协作写入 |
| 自动同步和远端轮询 | 沿用原调度器；轮流使用时可开启，首次试用建议手动同步 |

Drive 配额和上传限制仍由 Google 账号决定。大于 5 MiB 的文件使用 resumable upload，8 MiB 分块，在同一会话内可查询已接收偏移并恢复网络中断。应用退出后不会持久化上传会话；下次同步重新开始该文件上传。源引擎仍把单个文件读入内存，此次没有改造成流式大文件引擎。

## 失败与恢复

- 取消登录、登录超时或保存失败：既有连接凭据不被替换。重新点击连接即可。
- 授权过期或撤回：编辑同一连接并重新授权；需要时重新填入客户端密钥。客户端 ID 和根文件夹 ID 在编辑时固定，避免误换到另一份云端资产。
- 删除连接：只删除本机保存的连接和凭据，不删除 Drive 中的资产，也不撤销其他设备的授权。彻底撤回授权请使用 [Google 账号的第三方连接管理](https://myaccount.google.com/connections)，这可能影响同项目的其他设备。
- 同名文件/文件夹：同步停止。到 Drive 检查并保留正确版本、移走多余版本后再同步；程序不会随机挑一个覆盖。
- 远端 manifest 损坏、权限不足、网络失败：Drive 路径不会将这些问题当作空库；单个同步动作失败时中止本次会话，避免把失败显示成成功。
- 元数据缺失、损坏或与 manifest 中的哈希不一致：停止下载并保留原有同步缓存；首次下载会先校验元数据，再导入媒体，避免漏掉标签却显示成功。仅未声明元数据的旧版条目允许缺少 sidecar。
- 同时改名和改内容时，旧路径重名、权限不足或传输错误会停止同步；只有明确的旧文件不存在才允许继续上传新路径。
- 冲突处理先在云端和本地保存冲突副本，再替换正式文件。副本保存失败时保留双方原文件；Drive 副本名称附带唯一标识，避免同一分钟内再次冲突时覆盖已有副本。
- 删除的 Drive 文件先进入 Drive 回收站，便于恢复；Serpent 自己的同步墓碑和回收逻辑继续生效。
- 从已有 WebDAV 库切换：不要只改服务器地址复用旧缓存。先备份，在新本地库中导入副本并建立 Drive 同步，再从第二台打开远端库。本版拒绝使用 WebDAV ETag 向 Drive 进行条件写入。

## 开发与验证

需要 Node.js 24 和 npm。在项目根目录：

```sh
npm ci
npm run typecheck
npx vitest run --maxWorkers=2 tests/unit/google-drive-driver.test.ts tests/unit/google-drive-oauth.test.ts tests/unit/google-drive-sync.test.ts tests/unit/main-sync-command.test.ts tests/unit/main-sync-owned-request.test.ts tests/unit/sync-auto-scheduler.test.ts tests/unit/sync-handler.test.ts tests/worker/sync-engine.test.ts
npm run start
```

启动桌面应用需要原项目的 Electron、原生模块与媒体依赖初始化；请参照项目 README 的平台构建步骤。测试使用模拟 Drive HTTP 接口和本机 OAuth 回调，不需要真实 Google 账号。模拟测试不能证明真实账号授权、Google 服务行为或 Mac 实机运行已经验收。

官方接口依据：[桌面 OAuth 与 PKCE](https://developers.google.com/identity/protocols/oauth2/native-app)、[Drive 范围](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)、[上传方式](https://developers.google.com/workspace/drive/api/guides/manage-uploads)、[令牌到期说明](https://developers.google.com/identity/protocols/oauth2#expiration)。
