import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
import { ComateCredential } from "dsh-connect-comate";
//#region src/contract.d.ts
/**
 * The contract between this plugin's tools and its Comate client.
 *
 * This used to be a cross-plugin seam: the tools asked the running
 * `dsh-connect-comate` plugin for a `comateMedia` service. It is not one any
 * more, and the reason is worth keeping in writing.
 *
 * DSH has no cross-plugin dependency mechanism. A plugin's manifest may declare
 * `manifestVersion`, `engines.dsh`, `bundle.patch` and `client` — nothing that
 * says "this plugin requires that one" — and the only dependency check the host
 * performs is on `peerDependencies` whose name starts with `@deepseek-ai/dsh`.
 * A service seam therefore cannot be made mandatory: a package can be installed
 * while its loader entry is not mounted, and the consumer simply finds no
 * service. The choice was between a seam that can silently be absent and a hard
 * npm dependency that cannot — and the capability belongs to these tools anyway,
 * so the protocol moved here and `dsh-connect-comate` stayed released.
 *
 * What did NOT move is the credential — see `./comate/credential.ts`.
 *
 * @module dsh-comate-media/contract
 */
/** Image types the sniffer can identify, and therefore the only ones a result can carry. */
type ComateImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
/** Video types the sniffer can identify. */
type ComateVideoMediaType = 'video/mp4';
/** Resolution TIERS the video endpoint accepts — not pixel sizes. */
type ComateVideoSize = '480p' | '720p' | '1080p';
/**
 * The gateway's own accounting for one generation, passed through untouched.
 *
 * Typed loosely on purpose: the image and video endpoints report different key
 * sets (`total_tokens`, `completion_tokens`, `credits`, …), and this plugin
 * renders none of it. It is carried so a caller can log what a generation cost,
 * rather than being dropped between the response and the result.
 */
type ComateMediaUsage = Readonly<Record<string, unknown>>;
/** One image request. */
interface ComateImageRequest {
  /** What to draw; already trimmed and checked non-empty by the tool. */
  prompt: string;
  /** Pixel size as `WIDTHxHEIGHT`. Absent means the client sends the desktop default. */
  size?: string;
  /** Provider model id; absent lets the gateway route. */
  model?: string;
}
/** One generated image, bytes in hand. */
interface ComateImageResult {
  /**
   * The image itself — a plain `Uint8Array`, NOT a `Buffer`.
   *
   * Worth spelling out: `Uint8Array.prototype.toString()` ignores its encoding
   * argument and returns comma-joined decimals, so `bytes.toString('latin1')`
   * yields `"255,216,255,…"` rather than text. It does not throw, it just makes
   * every `includes` false. Go through `Buffer.from(bytes)` to read bytes as text.
   */
  bytes: Uint8Array;
  /** Sniffed from the bytes, never taken from the response header. */
  mediaType: ComateImageMediaType;
  /** The upstream's rewritten prompt, when it sends one. */
  revisedPrompt?: string;
  /** The model that actually produced the image, when the gateway names it. */
  model?: string;
  /** The gateway's own accounting, when it sends one. */
  usage?: ComateMediaUsage;
}
/** One video request. */
interface ComateVideoRequest {
  /** What to film; already trimmed and checked non-empty by the tool. */
  prompt: string;
  /** Duration in seconds as a STRING, because that is what the endpoint takes. */
  seconds?: string;
  /** Resolution tier. Absent means the client sends the desktop default. */
  size?: ComateVideoSize;
  /** Provider model id; absent lets the gateway route. */
  model?: string;
}
/** One generated clip, bytes in hand. */
interface ComateVideoResult {
  bytes: Uint8Array;
  /** Sniffed from the bytes. */
  mediaType: ComateVideoMediaType;
  /** The upstream task id, for the audit trail. */
  taskId: string;
  /** The duration the gateway reports for the finished clip. */
  seconds?: string;
  /** The model that actually produced the clip. */
  model?: string;
  /** The gateway's own accounting, when it sends one. */
  usage?: ComateMediaUsage;
}
/**
 * The two calls the tools make.
 *
 * `ComateMediaClient` is the shipped implementation; the tests supply their own,
 * which is what keeps the tool suite off the network.
 */
interface ComateMediaApi {
  /**
   * @param request - prompt plus optional size and model.
   * @param signal - the tool call's signal; cancellation must reach every hop.
   * @returns the image bytes and their sniffed type.
   */
  generateImage(request: ComateImageRequest, signal?: AbortSignal): Promise<ComateImageResult>;
  /**
   * @param request - prompt plus optional duration, resolution tier, and model.
   * @param signal - the tool call's signal.
   * @returns the clip bytes and their sniffed type.
   */
  generateVideo(request: ComateVideoRequest, signal?: AbortSignal): Promise<ComateVideoResult>;
}
//#endregion
//#region src/comate/client.d.ts
/** Construction inputs. */
interface ComateMediaClientOptions {
  /**
   * Resolve the credential for ONE call.
   *
   * Called per call rather than once at startup: the user can save a new sid on
   * the main plugin's card between two tool calls, and a credential captured at
   * load time would keep using the old one until the process restarted.
   */
  resolveCredential: () => Promise<ComateCredential>;
  /** Poll interval for the asynchronous video task. */
  pollIntervalMs?: number;
  /** Total budget for one video task. */
  videoBudgetMs?: number;
  /** `fetch` to use; injectable so the protocol can be tested without a network. */
  fetch?: typeof globalThis.fetch;
  /** Delay that honours the signal; injectable so tests do not wait five seconds. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
/**
 * The two media calls, over the Comate gateway.
 *
 * Stateless apart from its options: nothing here caches a credential, a task, or
 * a byte array between calls.
 */
declare class ComateMediaClient implements ComateMediaApi {
  private readonly resolveCredential;
  private readonly pollIntervalMs;
  private readonly videoBudgetMs;
  private readonly fetchImpl;
  private readonly sleepImpl;
  /**
   * @param options - credential source, timing, and the test seam.
   */
  constructor(options: ComateMediaClientOptions);
  /**
   * Generate one image and return its bytes.
   *
   * The endpoint is synchronous and takes roughly ten seconds against the real
   * gateway. The payload comes back as a URL (not `b64_json`), so a download is
   * part of the normal path rather than a fallback — and the bytes are sniffed
   * because the response header says `application/octet-stream` while the
   * content is JPEG.
   *
   * @param request - prompt plus optional size and model.
   * @param signal - the tool call's signal; cancellation propagates to every hop.
   * @returns the bytes, their sniffed type, and the upstream's own metadata.
   */
  generateImage(request: ComateImageRequest, signal?: AbortSignal): Promise<ComateImageResult>;
  /**
   * Generate one video and return its bytes.
   *
   * Asynchronous upstream: submit, poll until a terminal status, then fetch the
   * clip's presigned URL and download it. The polling loop checks the signal on
   * every iteration — a signal that is only forwarded to `fetch` leaves a
   * cancelled call sitting in the loop for up to twenty minutes.
   *
   * @param request - prompt plus optional duration, resolution tier, and model.
   * @param signal - the tool call's signal.
   * @returns the bytes, their sniffed type, and the upstream's own metadata.
   */
  generateVideo(request: ComateVideoRequest, signal?: AbortSignal): Promise<ComateVideoResult>;
  /**
   * Read an image payload into bytes.
   *
   * Both spellings are accepted because the endpoint has been seen to use `url`
   * while the OpenAI Images schema also allows `b64_json`; neither is treated as
   * the fallback of the other.
   *
   * @param entry - one element of the response's `data`.
   * @param signal - the tool call's signal.
   * @returns the payload bytes.
   */
  private imageBytes;
  /**
   * Fetch one URL as bytes.
   *
   * The presigned URL arrives as `http://`; when that scheme fails the same
   * object is retried over https, mirroring the main plugin's download path.
   * A cancellation is never retried — the user asked for this to stop.
   *
   * @param url - the media URL.
   * @param signal - the tool call's signal.
   * @returns the bytes.
   */
  private download;
  /** One download attempt. The URL is deliberately absent from the failure message — it is presigned. */
  private fetchBytes;
  /**
   * Send one JSON request and return its parsed body.
   *
   * The gateway's media endpoints answer errors as `{ error: { message, type,
   * code } }` with a non-2xx status, so the upstream's own sentence — 「未登录，
   * 请先登录」, 「登录校验失败」, 「所有模型创作图片都失败」 — is what the model
   * gets to relay. Note what is NOT asserted: a `code` field. These endpoints do
   * not send one on success, and a check for `code === 0` would reject every
   * working response.
   *
   * @param url - absolute endpoint URL.
   * @param init - method, headers, body.
   * @param signal - the tool call's signal.
   * @param what - the operation name, for the message.
   * @returns the parsed JSON body.
   */
  private requestJson;
}
//#endregion
//#region src/comate/credential.d.ts
/** The main plugin's runtime surface, resolved on first use. */
type MainPluginModule = typeof import('dsh-connect-comate');
/**
 * Overrides for {@link resolveComateCredential}.
 *
 * A test seam, not a user-facing knob: the plugin's own config deliberately has
 * no credential fields, because the sid belongs to `dsh-connect-comate`'s card
 * and a second place to paste it is a second place to forget to update it.
 */
interface ResolveComateCredentialOptions {
  /** Explicit sid, beating both the settings document and the environment. */
  wpsSid?: string;
  /** Explicit config file, overriding the platform default. */
  configFile?: string;
  /** Override for the main-plugin import, so tests can exercise a missing peer. */
  loadMainPlugin?: () => Promise<MainPluginModule>;
  /** Explicit key file for a sealed sid. */
  secretKeyFile?: string;
  /** Skip the settings read entirely (for tests that only exercise the env path). */
  ignoreSettings?: boolean;
}
/**
 * Resolve the credential one media call will use.
 *
 * Read per call, never cached: the user can save a new sid on the main plugin's
 * card between two tool calls, and a cached credential would keep answering
 * with the old one until the process restarted.
 *
 * @param ctx - the plugin context, for the settings read.
 * @param options - the test seam.
 * @returns the credential, with `cookie` already spelled `wps_sid=…`.
 * @throws {Error} with a message written for the model to relay, never for a log.
 */
declare function resolveComateCredential(ctx: Context, options?: ResolveComateCredentialOptions): Promise<ComateCredential>;
//#endregion
//#region src/index.d.ts
/** Loader identity; matches the package name so the Cordis patch entry resolves. */
declare const name = "dsh-comate-media";
/**
 * Only `tools`.
 *
 * `settings` and `attachments` are intentionally absent — both are read with
 * `ctx.get` at call time. Injecting `settings` would make the whole plugin wait
 * on it, and the credential has an environment fallback that needs no service.
 */
declare const inject: string[];
/**
 * Plugin configuration.
 *
 * Every value has a working default, so a deployment can mount this plugin with
 * an empty config and get the shipped behavior.
 */
interface Config {
  /** Fixed directory for generated files. Empty means "the Session working directory, falling back to the system temporary directory". */
  outputDir: string;
  /** Budget for one image generation, in milliseconds. */
  imageTimeoutMs: number;
  /** Budget for one video generation, in milliseconds. */
  videoTimeoutMs: number;
  /** Whether to keep a disk copy of generated IMAGES; videos are always written. */
  saveToDisk: boolean;
}
declare const Config: z<Config>;
/**
 * Register both tools over a given client.
 *
 * Split out of {@link apply} so the tool suite can drive the REAL registration
 * path — Config to options, both tools, both deadlines — with a substitute
 * client. `apply` is then only the shipped composition: build the client, call
 * this.
 *
 * @param ctx - agent-scoped services; `tools` is guaranteed by {@link inject}.
 * @param config - validated plugin configuration.
 * @param api - the Comate client the tools will call.
 */
declare function mount(ctx: Context, config: Config, api: ComateMediaApi): void;
/**
 * Register both tools against the shipped Comate client.
 *
 * @param ctx - agent-scoped services; `tools` is guaranteed by {@link inject}.
 * @param config - validated plugin configuration.
 */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { type ComateImageRequest, type ComateImageResult, type ComateMediaApi, ComateMediaClient, type ComateVideoRequest, type ComateVideoResult, Config, type ResolveComateCredentialOptions, apply, inject, mount, name, resolveComateCredential };