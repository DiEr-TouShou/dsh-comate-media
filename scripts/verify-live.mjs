/**
 * 真机冒烟（从插件侧）：用**本插件自己的** `ComateMediaClient` 打真网关。
 *
 * 为什么需要它（README 第 12 节列的缺口 1）：
 *
 *   离线套件（48 个用例）把协议钉在**脚本化 fetch** 上，验的是「我们按实测形状
 *   解析/编码」。它验不了的是「真网关今天仍然那样说话」——上游改一个字段名、
 *   改一个状态码，离线全绿而线上全挂。主插件的 `verify-media.mjs` 对真服务打过
 *   一份基线，但那份基线走的是**主插件手写的 fetch**，不是本插件的客户端。
 *   这个脚本补的就是这一段：本插件的 `ComateMediaClient` + 真凭据 + 真字节。
 *
 * 它顺带验一条本插件独有的路径：凭据**原样**取自 profile 的 `cordis.patch.yml`
 * （那里存的是 `enc:v1:…` 密文），交给本插件的 `resolveComateCredential` →
 * 主插件的 `ComateCredentialStore` 解封。所以「从插件能不能用主插件那份封套凭据」
 * 这件事，在这里是被真跑过一次的，而不只是被读过源码。
 *
 * 与主插件那个脚本的分工：
 *
 *   | | verify-media.mjs（主插件） | verify-live.mjs（本插件） |
 *   |---|---|---|
 *   | 协议实现 | 手写 fetch | **本插件的 client** |
 *   | 鉴权口径 | 零额度断言（Bearer 无效） | 不测（已由主插件钉住） |
 *   | 云存储上传 | 验（桌面端 UI 需要） | **不验**（本插件不需要，见 README 第七节） |
 *   | 产物 | 图片 + 视频 | 图片（视频需开开关） |
 *
 * 跑法（需要登录态，默认不进 CI）：
 *   node scripts/verify-live.mjs                            # 只跑生图（约 10 秒）
 *   COMATE_MEDIA_VIDEO=1 node scripts/verify-live.mjs        # 连生视频（实测约 2 分钟）
 *   COMATE_PKG_DIR="<插件安装目录>" node scripts/verify-live.mjs
 *
 * 可选环境变量：
 *   WPS_COMATE_SID=<sid>              直接给会话 sid，最短路径
 *   WPS_COMATE_PROFILE_PATCH=<路径>   指向含 wpsSid 的 cordis.patch.yml
 *   COMATE_MEDIA_VIDEO=1              跑生视频（默认关：慢，且真扣额度）
 *   COMATE_MEDIA_PROMPT=<英文 prompt> 覆盖生图提示词
 *   COMATE_MEDIA_VIDEO_PROMPT=<...>   覆盖生视频提示词
 *   COMATE_MEDIA_VIDEO_TIMEOUT_MS     生视频总预算，默认 10 分钟
 *   COMATE_MEDIA_OUT=<目录>           产物落盘目录，默认系统临时目录
 *
 * 判定：生图必须拿到**字节**（不是 URL、不是 data URL），客户端报出的 `mediaType`
 * 必须与脚本**独立嗅探**的结果一致（不一致就说明它在信响应头——而上游的响应头是
 * `application/octet-stream`，那是错的）。AIGC 元数据缺失只提示、不判失败：上游若
 * 不再写，那是**本插件需要跟进**，不是这个脚本该红。
 *
 * 输出里**永不打印** sid / cookie / 任何凭据片段。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = resolve(process.env.COMATE_PKG_DIR || join(HERE, '..'))
const OUT_DIR = process.env.COMATE_MEDIA_OUT || join(tmpdir(), 'comate-media-live')
const RUN_VIDEO = /^(1|true|yes|on)$/i.test(process.env.COMATE_MEDIA_VIDEO || '')
const VIDEO_BUDGET_MS = Number(process.env.COMATE_MEDIA_VIDEO_TIMEOUT_MS || 10 * 60 * 1000)

/** 提示词要具体到「画面能被验证」的程度，纯色图会被不看图也蒙对的回答骗过。 */
const IMAGE_PROMPT = process.env.COMATE_MEDIA_PROMPT
  || 'a solid red circle centered on a pure white background, flat minimal illustration'
const VIDEO_PROMPT = process.env.COMATE_MEDIA_VIDEO_PROMPT
  || 'a single red balloon slowly floating upward against a clear blue sky, gentle camera tilt up, bright daylight'

// ─────────────────────────── sid 上哪找 ───────────────────────────
//
// 与主插件 `scripts/live-profile.mjs` 同款解析顺序，但这里是**另写的一份**：
// 那个文件在 `scripts/` 下，而 `scripts/` 不在主插件的 `files` 白名单里，装到
// node_modules 后根本不存在。为了几十行去改主插件的发布面不值得，所以这份是本
// 插件自己的。环境变量名保持一致，换机时两边的用法一样。
//
// 路径里没有任何用户名字面量：写死 `C:\Users\<某人>\...` 的话，换台机器会以
// ENOENT 的形式挂掉，看起来像插件坏了，其实只是脚本认路认死了。

const SID_ENV = 'WPS_COMATE_SID'
const PATCH_ENV = 'WPS_COMATE_PROFILE_PATCH'
const PATCH_FILENAME = 'cordis.patch.yml'
const SID_PATTERN = /wpsSid:\s*(\S+)/

/** 空白串当没设：`VAR=` 与 `VAR= ` 在真机上都很常见。 */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * 解析出 sid 与它的来源。
 *
 * @returns the sid exactly as stored (possibly still sealed), plus where it came from.
 * @throws {Error} naming every path it tried, which is what a machine swap needs.
 */
function readSid() {
  const fromEnv = nonEmpty(process.env[SID_ENV])
  if (fromEnv !== undefined) return { value: fromEnv, source: `$${SID_ENV}` }

  const candidates = []
  const explicit = nonEmpty(process.env[PATCH_ENV])
  if (explicit !== undefined) candidates.push(explicit)
  const profileDir = nonEmpty(process.env['DSH_PROFILE_DIR'])
  if (profileDir !== undefined) candidates.push(join(profileDir, PATCH_FILENAME))
  for (const name of [nonEmpty(process.env['DSH_PROFILE']) ?? 'desktop', 'desktop', 'web']) {
    candidates.push(join(homedir(), '.dsh', 'profiles', name, PATCH_FILENAME))
  }

  for (const path of [...new Set(candidates)]) {
    let raw
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const match = SID_PATTERN.exec(raw)
    if (match !== null) {
      const value = match[1].replace(/^['"]|['"]$/g, '')
      if (value !== '') return { value, source: path }
    }
  }

  throw new Error([
    `拿不到 wps_sid：${SID_ENV} 没设，profile 的 ${PATCH_FILENAME} 也没找到。`,
    '试过这些位置：',
    ...[...new Set(candidates)].map(path => `  - ${path}`),
    '设置任意一条即可：',
    `  ${SID_ENV}=<sid>                   直接给会话 sid`,
    `  ${PATCH_ENV}=<patch 绝对路径>  指向含 wpsSid 的 ${PATCH_FILENAME}`,
  ].join('\n'))
}

// ─────────────────────────── 独立嗅探 ───────────────────────────
//
// 刻意**不复用**客户端的 sniff 模块：这里要的是一次交叉验证——客户端说
// `image/jpeg`，脚本自己看一眼字节是不是真的 JPEG。用同一个实现去验自己，等于
// 没验。

/**
 * 把字节当 latin1 文本读。
 *
 * **必须过 `Buffer.from`**：契约里 `bytes` 是 `Uint8Array`，而
 * `Uint8Array.prototype.toString()` 会**忽略编码参数**，返回逗号分隔的十进制数字
 * （`"255,216,255,…"`）。踩到它不报错，只是让每一次文本比较静默为 false——
 * 第一次跑就撞上了这个坑，表现为「上游不再写 AIGC 元数据」这个**假警报**，
 * 以及 MP4 被判成「未知格式」。
 */
function latin1Of(bytes) {
  return Buffer.from(bytes).toString('latin1')
}

/** 读 offset 处的 length 个字节当 ASCII；越界返回空串。 */
function asciiAt(bytes, offset, length) {
  return bytes.byteLength < offset + length ? '' : latin1Of(bytes.subarray(offset, offset + length))
}

function sniff(bytes) {
  const starts = (offset, values) => values.every((value, index) => bytes[offset + index] === value)
  if (starts(0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (starts(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WEBP') return 'image/webp'
  if (asciiAt(bytes, 0, 3) === 'GIF') return 'image/gif'
  if (asciiAt(bytes, 4, 4) === 'ftyp') return 'video/mp4'
  return undefined
}

/** 上游是否已写入 GB 45438-2025 标识（决定本插件要不要自己补元数据）。 */
function aigcOf(bytes) {
  const text = latin1Of(bytes)
  if (!text.includes('TC260:AIGC')) return undefined
  const produceId = /ProduceID&quot;:&quot;([^&]+)/.exec(text)
  return { produceId: produceId === undefined ? undefined : produceId[1] }
}

// ─────────────────────────── 开跑 ───────────────────────────

/**
 * 先验脚本自己那把尺子，再花钱。
 *
 * 上面那个 `latin1Of` 的坑就是这样露的：嗅探器坏了以后，生图那条**照样通过**
 * （JPEG 走的是字节比较那一条），只有生视频才炸——而等到那一步已经花了 2 分钟
 * 和一次额度。所以这几个字节序列在**发任何请求之前**先跑一遍，坏了就当场退出。
 */
const SNIFF_SAMPLES = [
  ['image/jpeg', [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]],
  ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['image/webp', [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]],
  ['image/gif', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
  ['video/mp4', [0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]],
]

const sniffProblems = SNIFF_SAMPLES
  .filter(([expected, values]) => sniff(new Uint8Array(values)) !== expected)
  .map(([expected]) => expected)
if (latin1Of(new Uint8Array([0x54, 0x43, 0x32])) !== 'TC2') sniffProblems.push('latin1Of')
if (sniffProblems.length > 0) {
  console.error(`FAIL 脚本自身的嗅探器不可信（${sniffProblems.join(', ')}）——先修它，别急着发请求`)
  process.exit(1)
}

const pkg = await import(pathToFileURL(join(PKG_DIR, 'lib/index.js')).href)
const { ComateMediaClient, resolveComateCredential } = pkg
const { ComateCredentialStore } = await import('dsh-connect-comate')

if (typeof ComateMediaClient !== 'function' || typeof resolveComateCredential !== 'function') {
  console.error('FAIL lib/index.js 没有导出 ComateMediaClient / resolveComateCredential')
  console.error('     先 `pnpm run build`，或用 COMATE_PKG_DIR 指向正确的目录')
  process.exit(1)
}

const sid = readSid()
// 脚本里没有 cordis，所以 ctx 是个最小替身：`settings` 读不到 → 走环境变量/显式
// sid 这条路。这正是 headless 运行时的真实形状，不是降级。
const ctx = { get: () => undefined }

// 先把封套本身验一遍：密文能不能解开，与「网关认不认」是两件事，分开报。
const store = new ComateCredentialStore()
store.setWpsSid(sid.value)
const resolution = await store.resolveSid()

const credential = await resolveComateCredential(ctx, { wpsSid: sid.value })
const gateway = credential.baseUrl.replace(/\/+$/, '')

console.log(`package   : ${PKG_DIR}`)
console.log(`sid from  : ${sid.source}`)
console.log(`sid form  : ${resolution.storage}${resolution.problem === undefined ? '' : ` (${resolution.problem})`}`)
console.log(`gateway   : ${gateway}`)
console.log(`cookie    : present`)
console.log(`out dir   : ${OUT_DIR}\n`)

if (credential.cookie === undefined || credential.cookie.trim() === '') {
  console.error('FAIL 凭据里没有 cookie；媒体端点只认 Cookie，Bearer 不顶用')
  process.exit(1)
}

mkdirSync(OUT_DIR, { recursive: true })

// 每次调用都重新解析凭据（客户端就是这么用的），所以这一行同时验了「重复解析」。
const client = new ComateMediaClient({
  resolveCredential: () => resolveComateCredential(ctx, { wpsSid: sid.value }),
  videoBudgetMs: VIDEO_BUDGET_MS,
})

let failures = 0
let checked = 0

// ─────────────────────────────── 生图 ───────────────────────────────
{
  checked++
  const problems = []
  const notes = []
  const started = Date.now()

  try {
    const result = await client.generateImage({ prompt: IMAGE_PROMPT })
    const bytes = result.bytes

    if (bytes.length < 1024) {
      problems.push(`字节数可疑：${bytes.length}`)
    }
    const sniffed = sniff(bytes)
    if (sniffed === undefined) {
      problems.push(`不是已知图片格式（前 8 字节 ${bytes.subarray(0, 8).toString('hex')}）`)
    } else if (sniffed !== result.mediaType) {
      // 客户端报了类型，但字节不是那个类型——说明它在信响应头（上游给的是
      // application/octet-stream），或者嗅探逻辑坏了。两种都得修。
      problems.push(`客户端报 ${result.mediaType}，脚本嗅探出 ${sniffed}`)
    } else {
      const aigc = aigcOf(bytes)
      if (aigc === undefined) {
        // 不是失败：上游若不再写元数据，是本插件需要跟进，不是这个脚本该红。
        notes.push('上游未带 AIGC 元数据（若长期如此，本插件需自行写入）')
      } else {
        notes.push(`AIGC ProduceID=${aigc.produceId}`)
      }
      const ext = sniffed === 'image/jpeg' ? 'jpg' : sniffed.split('/')[1]
      const path = join(OUT_DIR, `verify-live-image.${ext}`)
      writeFileSync(path, bytes)
      notes.push(`${sniffed}，${bytes.length} bytes → ${path}`)
    }

    if (result.revisedPrompt !== undefined) notes.push(`revisedPrompt=${JSON.stringify(result.revisedPrompt).slice(0, 80)}`)
    if (result.model !== undefined) notes.push(`model=${result.model}`)
    if (result.usage === undefined) notes.push('响应里没有 usage（不是失败，但值得留意）')
    else notes.push(`usage=${JSON.stringify(result.usage)}`)
  } catch (error) {
    problems.push(String(error?.message ?? error))
  }

  if (problems.length > 0) {
    console.log(`FAIL image  : ${problems.join('; ')}`)
    failures++
  } else {
    console.log(`ok   image  : ${Date.now() - started}ms`)
    for (const note of notes) console.log(`             ${note}`)
  }
}

// ─────────────────────────────── 生视频 ───────────────────────────────
if (!RUN_VIDEO) {
  console.log('\nskip video  : COMATE_MEDIA_VIDEO 未开（生视频约 2 分钟且真扣额度）')
} else {
  checked++
  const problems = []
  const notes = []
  const started = Date.now()

  try {
    // 客户端的 generateVideo 内部会轮询到底再下载，所以这里只看返回值和耗时。
    const result = await client.generateVideo({ prompt: VIDEO_PROMPT, seconds: '5', size: '480p' })
    const bytes = result.bytes

    if (typeof result.taskId !== 'string' || result.taskId === '') {
      problems.push('结果里没有 taskId')
    } else {
      notes.push(`taskId=${result.taskId}`)
    }
    if (bytes.length < 1024) {
      problems.push(`字节数可疑：${bytes.length}`)
    }
    const sniffed = sniff(bytes)
    if (sniffed !== 'video/mp4') {
      problems.push(`不是 MP4（嗅探 ${sniffed ?? '未知'}，前 8 字节 ${bytes.subarray(0, 8).toString('hex')}）`)
    } else if (sniffed !== result.mediaType) {
      problems.push(`客户端报 ${result.mediaType}，脚本嗅探出 ${sniffed}`)
    } else {
      const path = join(OUT_DIR, 'verify-live-video.mp4')
      writeFileSync(path, bytes)
      notes.push(`${sniffed}，${(bytes.length / 1024 / 1024).toFixed(2)} MB → ${path}`)
    }
    if (result.model !== undefined) notes.push(`model=${result.model}`)
    if (result.seconds !== undefined) notes.push(`seconds=${result.seconds}`)
    if (result.usage === undefined) notes.push('响应里没有 usage（不是失败，但值得留意）')
    else notes.push(`usage=${JSON.stringify(result.usage)}`)
  } catch (error) {
    problems.push(String(error?.message ?? error))
  }

  if (problems.length > 0) {
    console.log(`FAIL video  : ${problems.join('; ')}`)
    failures++
  } else {
    console.log(`ok   video  : ${Date.now() - started}ms`)
    for (const note of notes) console.log(`             ${note}`)
  }
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  ${checked - failures}/${checked}`)
process.exit(failures === 0 ? 0 : 1)
