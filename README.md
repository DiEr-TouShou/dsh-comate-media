# dsh-comate-media

WPS Comate 的图片与视频生成，作为 DSH 工具暴露给模型。

这是一个**从插件**：Comate 的媒体协议由它自己实现，它只从主插件 `dsh-connect-comate` 借一样东西——
**凭据**。

---

## 一、设计说明：为什么是"库依赖"而不是"服务接缝"

最初的设计是主插件 `ctx.provide('comateMedia', …)`，本插件 `inject: ['comateMedia']`。现在改成了
**npm 依赖 + 自持协议**，理由有两条，都是实测出来的。

### 1. 凭据只有主插件那一份，且媒体端点只认 cookie

一组零额度探针（故意发缺 `prompt` 的非法 body——网关先校鉴权、后校 body，两种错误可区分）：

| 变体 | 结果 |
|---|---|
| `Authorization: Bearer <config.json 里的 apiKey>` | **401** `not_login` |
| 完全不发鉴权头 | **401**，与上面**逐字相同** |
| `Cookie: wps_sid=…` | **500**「所有模型创作图片都失败」← 进业务层了 |
| `GET /videos/<bogus>` + Cookie | **404**「任务ID不存在」← 鉴权通过 |

两条结论：`config.json` 里的 api key 在媒体端点上**一文不值**（带它和不带它回包逐字一样，说明被
彻底忽略，不是"权限不够"）；而 `config.json` 里的 cookie 是桌面端占位串 `COOKIE`。

所以"从插件自己读 `~/.wpscomate/config.json` 就能自立"这条路不存在，凭据必须来自主插件那套
（卡片设置文档 / 环境变量 / sealed secret 解封）。

### 2. DSH 没有跨插件依赖机制

查过 `dsh-package-manifest`、`dsh-app-boot`、`client-ui-plugin-manager` 的文档：

- manifest 里**没有**依赖位（只有 `manifestVersion` / `engines.dsh` / `bundle.patch` / `client`）；
- DSH 唯一的依赖校验只认 `@deepseek-ai/dsh*` 的 peer，**不管第三方插件**；
- 安装期唯一的门是"有没有 bundle patch"——安装器只看**被装的这个包自己**；
- **装上 ≠ 挂载**：包进了 `dependencies`，loader entry 也不会插入，entry 来自 bundle patch 层。

也就是说「主插件没装就拒绝安装」在 DSH 里**做不到**；但把主插件写成 npm `dependencies`，
「代码必然在」在 npm 层就自动成立了。

**这正是选库依赖的决定性理由**：服务接缝下「包在而服务不在」是一个 DSH 无法阻止的半装状态
（只能靠 `inject` 或抛错把它变成显式失败）；库依赖下这个失败模式**直接消失**，剩下的唯一失败是
「没登录」，而那本来就是一句模型能转述的人话。

### 两种方案对照

| | 服务接缝 | 库依赖（现状） |
|---|---|---|
| 主插件改动 | 需要新增 `comateMedia` 服务 | **零改动**，v0.5.1 原样 |
| 凭据 owner | 主插件 | 主插件（经它的 `ComateCredentialStore`） |
| 模块解析 | 无问题 | 需 git 依赖 + specifier 逐字对齐 |
| "主插件没装" | DSH 无法阻止半装状态 | 不可能发生 |
| 主插件重构影响 | 接口稳定 | 依赖 `ComateCredentialStore` 的公开导出面 |

本插件要写的代码量两种方案差别很小——**媒体协议本来就得写在从插件里**（服务方案下是"调
`ctx.comateMedia`"，库方案下是"自己发请求"）。

---

## 二、依赖与安装

```json
"dependencies": {
  "dsh-connect-comate": "github:DiEr-TouShou/dsh-connect-comate#v0.5.1"
}
```

三条约束，都踩过：

1. **specifier 必须与 profile 里那一条逐字相同**，pnpm 才会去重成同一份。不同 → 装出两份主插件
   代码，而其中一份的 `enc:v1:` 封套格式可能已经过时，表现为"密文解不开"。
2. **用 `dependencies`，不用 `peerDependencies`**。peer 在 pnpm 下运行时解析不到（本插件的 realpath
   在 profile 之外时，Node 不会向上找到 profile 的 `node_modules`）。
3. **主插件带 `prepack` 构建脚本**，新 commit 会触发 `allowBuilds` 白名单；管理器的失败界面有
   「允许这些脚本并重试」，会把授权写进 profile 的 `pnpm-workspace.yaml`。

本插件自身也应作为 **git 依赖**装进 profile，realpath 才会落在 `.pnpm` 树里，上述解析才成立。

---

## 三、凭据解析顺序

| 顺序 | 来源 | 何时用 |
|---|---|---|
| 1 | 主插件设置文档的 `wpsSid` | 常规路径；卡片保存的是 `enc:v1:…` 密文 |
| 2 | `WPS_COMATE_SID` | headless / 一次性运行 / GUI 启动拿不到设置时 |

两者都交给主插件的 `ComateCredentialStore`（`src/comate/credential.ts`），本插件**不碰**封套格式、
密钥文件与配置文件探测顺序——第二份 sealed 格式实现正是两个插件开始对"凭据是什么"产生分歧的方式。

设置文档的读法有三个刻意的选择：

- `ctx.settings.describe()` **不传 `redactSecrets`**。脱敏只对 Remote 边界生效
  （`dsh-settings` 的实现是 `value: options?.redactSecrets ? redacted.value : value`），宿主侧读者拿到真值。
- 先按 entry id 匹配，匹配不到时退回**唯一一个带 `wpsSid` 的 section**——用户改了 profile entry 名
  不该静默丢掉凭据；有两个外来 section 都带 sid 时**拒绝猜**。
- **每次调用重新解析，不缓存**。用户可以在两次工具调用之间在卡片上保存新 sid。

### 失败文案（三条路，三种修法）

模型会把这里的一句话原样转述给用户，所以三者必须可区分：

| 情况 | 文案要点 |
|---|---|
| 找不到配置文件 | 说明没有可读的 Comate 配置，并给出 `WPS_COMATE_CONFIG_FILE` |
| 有配置但只有占位 cookie | 说明 `config.json` 只带占位 cookie、**api key 同样不被网关接受**（用户会问的下一个问题），请填卡片 `wpsSid` 或设 `WPS_COMATE_SID` |
| 密文解不开 | 与"从未配置"症状相同但修法不同：给出密钥文件路径，并说明三种可能（丢失 / 不可读 / 换了机器或用户） |

---

## 四、模块划分

```
src/
├─ index.ts               # Config（schemastery）+ apply：建客户端、挂两个工具
├─ contract.ts            # 两个请求/结果类型 + ComateMediaApi + Context 增强
├─ signals.ts             # withDeadline / raceDeadline
├─ storage.ts             # 落盘（时间戳+随机后缀；不从 prompt 造文件名）
├─ deliverables.ts        # deliverables/presented 追加
├─ comate/
│  ├─ credential.ts       # 凭据解析（设置文档 → 环境变量）+ 失败文案
│  ├─ client.ts           # 媒体协议：生图、生视频、轮询、下载、错误映射
│  └─ sniff.ts            # 按字节判类型（不看响应头）
└─ tools/
   ├─ generate-image.ts
   └─ generate-video.ts
```

`ComateMediaClient` 实现 `ComateMediaApi`，所以工具只依赖那个接口——测试替换的是**客户端**，
不是服务。

---

## 五、协议：七条实测偏差

都是**读桌面端源码会读错**的地方，每条都在 `tests/client.spec.ts` 里被断言钉住：

1. **响应里没有 `code` 字段。** 实际是 OpenAI 形状 `{created, data:[…], usage}`。桌面端源码的
   `isBizSuccessCode(data.code)` 之所以不误报，是因为它实现为 `code === undefined → true`。
   别照抄成"必须校验 code"——那会拒绝**每一个**正常响应。
2. **图片返回 `url`，不是 `b64_json`。** 所以"下载 → 嗅探 → 使用"是必需路径，不是可选分支。
   （`b64_json` 仍然接受，两者互不为 fallback。）
3. **`content-type` 会撒谎。** 图片响应头是 `application/octet-stream`，实际字节是 JPEG
   （`FF D8 FF E0 … JFIF`）。按 header 存成 `.png` 会在下游签名校验时才发现。
4. **上游已经写好 AIGC 元数据。** 返回的 JPEG 里带完整 GB 45438-2025 标识
   （`XMP APP1`、`TC260:AIGC`、`ProduceID:T…`、`ContentProducer` 与源码常量逐字一致）。
   走 llmproxy 通道时水印与 AIGC 元数据**全由上游完成**，插件不需要实现 `watermark.js` /
   `aigc-metadata.js`——这也解释了源码为什么对 llmproxy 跳过水印。
5. **视频 `aspect_ratio` 在 llmproxy 通道被静默忽略。** 该通道只发
   `{prompt, seconds, size, model?}`。工具参数里那个 `aspect_ratio` 只有 volcengine/kling 直连才用。
6. **taskId 含 `/`**（形如 `llm-video-doubao-doubao-seedance-2-0-fast-260128/<hash>`），那个斜杠属于
   **路径**，拼 URL 必须按段 `encodeURIComponent` 再拼回 `/`。
7. **presigned URL 是 `http://` 开头且带 `\u0026` 转义**，必须还原成 `&`；http 失败时用 https 重试
   （取消则**不**重试）。轮询期间 `GET /videos/{id}` 的返回体字段会变（进行中只有 5 个 key，
   完成后多出 `model` / `seconds` / `size` / `completed_at` / `usage`）。

另：`size` 字段**同名不同义**——图片是像素 `WxH`，视频是分辨率档位 `480p/720p/1080p`。所以两个工具的
参数类型是分开的，不共用一个字段。

---

## 六、工具

### `comate_generate_image`

| 参数 | 必填 | 说明 |
|---|---|---|
| `prompt` | ✅ | 画什么 |
| `size` | | **像素**尺寸 `WIDTHxHEIGHT`，如 `960x960` |
| `model` | | 省略则由网关路由 |

结果里的 `image` 是一个 attachment 块。`dsh-tools` 会把带图结果**延迟为 user message 上下文**，
所以模型下一步能真正"看到"自己刚生成的图。

### `comate_generate_video`

| 参数 | 必填 | 说明 |
|---|---|---|
| `prompt` | ✅ | 拍什么 |
| `seconds` | | **字符串**时长，如 `"5"` / `"10"`。默认 5 |
| `size` | | **分辨率档位** `480p` / `720p` / `1080p`——不是像素尺寸 |
| `model` | | 省略则由网关路由 |

网关侧是异步的（提交 → 5 秒轮询 → 取地址 → 下载，源码上限 20 分钟）；客户端隐藏了轮询，
返回时字节已到手，所以工具里没有状态机，只需要一个 deadline。

---

## 七、展示链路

- **图片**：字节 → `ctx.attachments.saveImages()` → 宿主渲染。可选留一份本地副本（`saveToDisk`）。
- **视频**：**没有可聊内渲染的形态**——DSH 的 markdown 管线只重写图片目标，通用工具卡也不渲染播放器。
  唯一的一等公民路径是 `deliverables/presented` Session 事件（`dsh-tool-present` 的机制），客户端据此
  给出"可打开"的卡片。所以本地文件**就是**交付物：视频**总是**落盘并声明为 deliverable，
  **不受 `saveToDisk` 影响**（那个开关只管图片）。

因为展示走本地字节，本插件**不需要云存储上传**——省掉了最脆的一环（100MB 视频上限、必须真 cookie
才不失败的三步 presign 链）。

---

## 八、deadline

`defineTool({ timeoutMs })` **只是声明**，注册表不执行它（其文档自己这么写，真正的执行在另一个不由
本插件控制的 policy wrapper 里）。所以本插件自己兑现：

- `withDeadline` 把 `exec.signal` 与 `AbortSignal.timeout` 合成一个信号传下去；
- `raceDeadline` **额外**让调用与 deadline 竞速。

第二步是必要的：signal 只是"请求"，一个从不读它的实现（比如卡在失联 socket 上的 promise）会让整个
turn 永久挂住——而 `timeoutMs` 存在的意义正是给这种情况兜底。

两种中止保持可区分：时钟到点 → 超时文案；调用方取消 → **原样抛出调用方自己的 reason**，
所以用户按停止键永远不会看到"超时"。

客户端侧还**自己在轮询循环里检查 signal**（不只在 `fetch` 里），否则一次取消会让调用在循环里干等到
20 分钟上限。

---

## 九、配置

```yaml
outputDir: ''           # 空 = 会话工作目录，再退回系统临时目录
imageTimeoutMs: 300000  # 5 分钟；实测约 8–11 秒
videoTimeoutMs: 1500000 # 25 分钟；轮询上限 20 分钟，设短了会砍掉本可完成的调用
saveToDisk: true        # 是否给图片留一份本地副本（视频不受此开关影响）
```

配置里**没有凭据字段**，刻意的：sid 归主插件的卡片管，第二处粘贴就是第二处忘记更新。

---

## 十、两条 DSH 线的降级

| 能力 | 0.1.7（宿主实测 0.1.7-rc.2） | 0.1.5 |
|---|---|---|
| `ctx.settings.describe()` | ✅ 读设置文档里的 `wpsSid` | ❌ 只有 `register` / `installSection` |
| 环境变量兜底 | ✅ | ✅ |

`readSettingsSid` 是**结构化**读的（不 import `@deepseek-ai/dsh-settings`），`describe` 不存在时直接
返回 `undefined`，于是凭据退回 `WPS_COMATE_SID`。在 0.1.5 上插件仍可用，只是必须先设环境变量；
失败文案会明确要求它。

---

## 十一、开发

```bash
pnpm install
pnpm run typecheck   # tsc -p tsconfig.json
pnpm run test        # 48 个用例（3 个文件）
pnpm run build       # tsdown → lib/
```

测试分三层，都不触网、不消耗额度：

| 文件 | 覆盖 |
|---|---|
| `tests/plugin.spec.ts` | 挂**真实的** `dsh-tools` 注册表进真实 cordis，走 `execute` + `output.render` |
| `tests/client.spec.ts` | 媒体协议对**脚本化 fetch**——第五节七条偏差的离线那一半 |
| `tests/credential.spec.ts` | 设置文档读取、优先级、三条失败文案（配置文件是真的，写进临时目录） |

`plugin.spec.ts` 用真注册表而非替身，是因为最容易坏的恰是假注册表会掩盖的部分：输出 schema 能否通过
`assertSupportedJsonSchema`、canonical value 能否通过校验、渲染出的 block 是否带一个附件服务能接受的
图片。唯一的替身是被读取的那几个服务。

环境约束：依赖安装必须用 DSH runtime 自带的 node + pnpm
（`<DSH>/resources/runtime/primary-runtime/dependencies/` 下的 `node/bin/node.exe` 与
`pnpm/bin/pnpm.cjs`），不要用 PATH 上的 pnpm（版本不匹配会触发整个 `node_modules` 重装）。

---

## 十二、已验证 / 未验证

**已验证（48 个用例全绿）**：工具注册契约与两个 JSON Schema、参数透传、attachment 提交
（用**嗅探出的** jpeg，不是网关声称的 octet-stream）、落盘字节、deliverable 声明、图片块渲染、
五条降级路径（缺客户端 / 缺附件服务 / 关落盘 / 无开启 turn / 空 prompt）、deadline 竞速、
调用方取消不被改写、上游失败原样透传；媒体协议的提交体与鉴权头、`url` 与 `b64_json` 两条载荷、
按字节嗅探、无 `code` 字段、taskId 分段编码、失败/超预算/取消三条中止路径、presigned URL 还原与
http→https 重试；凭据的设置文档优先、环境变量兜底、配置文件真 cookie、三条失败文案。

**未验证**：

1. **真实生成链路端到端**（本插件的客户端 → 真网关 → 真字节）。协议层本身已由主插件的
   `scripts/verify-media.mjs` 对真服务打过基线（生图 11.3s、生视频 122s，均通过），但本插件的
   `ComateMediaClient` 尚未用真凭据跑过。
2. **DSH 宿主里的实际加载**，以及 deliverable 卡片的渲染效果。
3. **0.1.5 上的行为**（本机是 0.1.7-rc.2，降级路径只测了 `describe` 缺失这一分支）。
