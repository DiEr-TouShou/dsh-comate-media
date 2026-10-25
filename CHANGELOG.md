# Changelog

## 0.2.0 — DSH 0.2.1-rc.3 adaptation (2026-10-25)

- 声明 `engines.dsh >=0.2.1-rc.3 <0.2.2-0`，对齐新版 DSH、Cordis 和 Schemastery 开发依赖及锁文件。
- 图片和视频的默认落盘目录读取当前 `workingDirectory` 服务或会话投影，避免切换目录后仍写入不可变 header 的初始目录；显式 `outputDir` 继续优先。
- 主插件 peer 范围更新为 `>=0.6.0 <0.7.0`，开发依赖固定为 GitHub `v0.6.0`，清除旧 git 版本引入的新旧 DSH 混用。消费者仍通过 peer 使用宿主安装的主插件。
- 本地离线验证：56 个测试、类型检查与构建通过，peer 检查无冲突。未调用真实生成网关；DSH 页面交互与真实生成需在宿主中另行验证。

## 0.1.1-rc.1 (2026-09-27)

### Fixed

- **主插件从 `dependencies` 改为 `peerDependencies`。** v0.1.0 实际上**装不上**：pnpm 11 默认开启
  `blockExoticSubdeps`，禁止 subdependency 使用 git / tarball / file 形式的异形依赖，而主插件
  **只能**以 git 形式安装。报错 `ERR_PNPM_EXOTIC_SUBDEP`；换成 tarball URL 一样被拒
  （"resolved via url"）。改成 peer 后安装干净通过——零环境改动、零 `allowBuilds`。
- 主插件的 import 改为**动态**，失败时抛出指名"该装哪个插件"的句子，而不是让
  `ERR_MODULE_NOT_FOUND` 在加载期炸出来。`resolveComateCredential` 本就 async，所以这个改动
  只落在一个函数里。
- 修了一个由新测试暴露出来的真 bug：`loadMainPlugin` 的进程级缓存会**短路注入的 loader**，
  于是任何早先调用成功过之后，"缺主插件"的测试实际上在测"主插件存在"的路径。现在显式
  override 无条件执行，且不读写缓存。

### Changed

- `peerDependencies` 声明 `dsh-connect-comate >=0.5.1 <0.6.0`；`devDependencies` 保留 git 形式
  供本地开发与测试。消费者不再拿到那条 git 依赖。
- README 第一节重写：记录结论被推翻两次的过程，以及五组安装对照实验（A–E）。

### Verified

- 离线 **50** 用例（3 文件）全绿，含新增的两条：缺 peer 时给出的是那句人话、以及显式 override
  不会被缓存短路。
- 真机 `verify:live` 通过（`ProduceID=TC7A2F9A4`，`image/jpeg`）——确认动态 import 没有破坏
  凭据链。
- 安装实测（pnpm 11.7.0）：宿主装主插件 + 本插件用 peer → 干净装上。

## 0.1.0 (2026-09-27)

首个版本。把 WPS Comate 的**图片与视频生成**以两个工具暴露给 DSH：
`comate_generate_image` 与 `comate_generate_video`。

### Added

- **两个工具**（`src/tools/`）。图片结果以 attachment 块返回，`dsh-tools` 会把它延迟为
  user message 上下文，所以模型下一步能真正看到自己刚生成的图；视频落盘并声明为
  `deliverables/presented`，因为 DSH 没有可聊内渲染视频的形态。
- **Comate 媒体协议**（`src/comate/client.ts`）。生图是同步一次请求；生视频是异步
  三段式（提交 → 5 秒轮询 → 取地址 → 下载），轮询在客户端内部完成，所以工具层没有
  状态机，只需要一个 deadline。上传云存储整段不做——展示走本地字节，那三步最脆的
  环节（100MB 上限、必须真 cookie 才不失败）因此被省掉。
- **按字节判类型**（`src/comate/sniff.ts`）。上游的图片响应头是
  `application/octet-stream`，字节其实是 JPEG；信响应头会产出一个扩展名错误的文件，
  等到下游签名校验失败时，原因已经不在现场了。
- **凭据解析**（`src/comate/credential.ts`）。设置文档的 `wpsSid` 优先，
  `WPS_COMATE_SID` 兜底；两者都交给主插件自己的 `ComateCredentialStore`，
  不重实现封套格式与密钥文件。**每次调用重新解析，不缓存**——用户在卡片上保存新
  sid 后，下一次工具调用就生效。
- **真机冒烟**（`scripts/verify-live.mjs`，`pnpm run verify:live`）。用**本插件自己的
  client** 打真网关，实测约 7 秒出图、约 81 秒出视频。

### Design

- **主插件 `dsh-connect-comate` 是硬 `dependencies`，不是服务接缝。** 最初的设计是
  主插件 `provide('comateMedia')`、本插件 `inject`。改成库依赖有两条实测依据：
  媒体端点只认 Cookie（`config.json` 里的 apiKey 带与不带，回包**逐字相同**），
  所以凭据必须来自主插件那套；而 DSH **没有跨插件依赖机制**（manifest 无依赖位、
  peer 校验只认 `@deepseek-ai/dsh*`、装上 ≠ 挂载），所以服务接缝下「包在而服务不在」
  是一个 DSH 无法阻止的半装状态，库依赖下这个失败模式直接消失。
- **只 `inject: ['tools']`。** 注册无条件进行，拿不到凭据时失败在一句模型能转述的话上，
  而不是一个静默缺席的工具。
- **自己兑现 deadline**。`defineTool({ timeoutMs })` 只是声明，注册表不执行它；
  所以除了把 signal 传下去，还让调用与 deadline 竞速——一个从不读 signal 的实现会让
  整个 turn 永久挂住。调用方取消时**原样抛出调用方自己的 reason**，用户按停止键不会
  看到「超时」。
- **配置里没有凭据字段。** sid 归主插件的卡片管，第二处粘贴就是第二处忘记更新。

### Verified

- 离线 48 个用例（3 个文件）全绿。`plugin.spec.ts` 挂**真实的** `dsh-tools` 注册表进
  真实 cordis，走 `execute` + `output.render`——最容易坏的恰是假注册表会掩盖的部分
  （输出 schema 能否通过校验、渲染出的 block 是否带一个附件服务能接受的图片）。
- 真机 `verify:live` 通过：图片 JPEG 带 GB 45438-2025 AIGC 元数据（`ProduceID=T…`），
  视频 MP4 1.05 MB（路由到 `doubao-seedance-2-0-fast-260128`）。
- 主插件 `verify:media` 新增**零额度鉴权口径**断言：Bearer 与「不带鉴权」回包逐字
  相同、cookie 能过鉴权、再加 Bearer 回包不变。这个前提一旦被上游改掉就静默失效，
  而离线套件、单测、真机生图**全都不会红**。

### Known limitations

- llmproxy 通道下视频 `aspect_ratio` 被上游**静默忽略**（该通道只发
  `prompt` / `seconds` / `size` / `model`），所以比例不可控。
- 未在 DSH 宿主里实装加载过；deliverable 卡片的实际渲染效果未验。
- 未在 DSH 0.1.5 上验过（本机 0.1.7-rc.2）。0.1.5 没有 `settings.describe()`，
  凭据需退回 `WPS_COMATE_SID`。
