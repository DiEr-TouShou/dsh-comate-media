import z from "@deepseek-ai/schemastery";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { AttachmentId } from "@deepseek-ai/dsh-attachment";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
//#region src/comate/sniff.ts
/**
* Read `length` bytes at `offset` as ASCII, or `''` when the buffer is shorter.
*
* @param bytes - the payload.
* @param offset - start offset.
* @param length - number of bytes to read.
* @returns the ASCII slice, empty when out of range.
*/
function ascii(bytes, offset, length) {
	return bytes.byteLength < offset + length ? "" : String.fromCharCode(...bytes.subarray(offset, offset + length));
}
/** Whether `bytes` starts with the given signature. */
function startsWith(bytes, signature) {
	return bytes.byteLength >= signature.length && signature.every((value, index) => bytes[index] === value);
}
/**
* Identify an image payload by its signature.
*
* @param bytes - the downloaded payload.
* @returns the sniffed media type, or `undefined` when it is not a known image.
*/
function sniffImageMediaType(bytes) {
	if (startsWith(bytes, [
		255,
		216,
		255
	])) return "image/jpeg";
	if (startsWith(bytes, [
		137,
		80,
		78,
		71,
		13,
		10,
		26,
		10
	])) return "image/png";
	if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
	if (ascii(bytes, 0, 3) === "GIF") return "image/gif";
}
/**
* Identify a video payload by its signature.
*
* MP4 carries the `ftyp` box at offset 4, after the box length.
*
* @param bytes - the downloaded payload.
* @returns `video/mp4`, or `undefined` when the bytes are something else.
*/
function sniffVideoMediaType(bytes) {
	return ascii(bytes, 4, 4) === "ftyp" ? "video/mp4" : void 0;
}
/**
* The file extension for a media type, including the dot.
*
* Falls back to `.bin` rather than guessing: an unknown type reaching this
* function means the sniffers disagreed with the caller, and a wrong extension
* is worse than an honest one.
*
* @param mediaType - a media type this plugin produced.
* @returns the extension.
*/
function extensionForMediaType(mediaType) {
	if (mediaType === "image/jpeg") return ".jpg";
	if (mediaType === "image/png") return ".png";
	if (mediaType === "image/webp") return ".webp";
	if (mediaType === "image/gif") return ".gif";
	if (mediaType === "video/mp4") return ".mp4";
	return ".bin";
}
//#endregion
//#region src/comate/client.ts
/**
* The Comate media protocol, as measured against the real gateway.
*
* This is the piece the main plugin used to own. It lives here now because the
* capability belongs to these tools — and because keeping it here means the
* main plugin can stay released and untouched. The one thing that stayed over
* there is the credential (see `./credential.ts`), which is the only part this
* plugin genuinely cannot own.
*
* Every body and header below is a shape that was observed to work against
* `https://comate.wps.cn/llmproxy/v1/user` (see
* `dsh-connect-comate/scripts/verify-media.mjs` for the live baseline). Where a
* field is optional in the tool schema, this client still sends the desktop
* client's own default rather than omitting it: "omit and let the gateway
* choose" has never been observed, and guessing is how an async submit fails
* with a message nobody can act on.
*
* @module dsh-comate-media/comate/client
*/
/** Path of the synchronous image endpoint, under the gateway base URL. */
const IMAGES_PATH = "/images/generations";
/** Path of the asynchronous video endpoint. */
const VIDEOS_PATH = "/videos";
/** Header the desktop client sends; the gateway does not require it for auth, but it is part of the observed request. */
const APP_ID = "comate";
/** How often the asynchronous video task is polled. The desktop client uses five seconds. */
const POLL_INTERVAL_MS = 5e3;
/** Total budget for one video task; the desktop client gives up after twenty minutes. */
const VIDEO_BUDGET_MS = 12e5;
/** Desktop defaults, sent when the caller omits the field. */
const DEFAULT_IMAGE_SIZE = "960x960";
const DEFAULT_VIDEO_SIZE = "720p";
const DEFAULT_VIDEO_SECONDS = "5";
/** Video statuses that end the poll loop without a clip. */
const FAILED_VIDEO_STATUSES = [
	"failed",
	"cancelled",
	"expired"
];
/**
* The two media calls, over the Comate gateway.
*
* Stateless apart from its options: nothing here caches a credential, a task, or
* a byte array between calls.
*/
var ComateMediaClient = class {
	resolveCredential;
	pollIntervalMs;
	videoBudgetMs;
	fetchImpl;
	sleepImpl;
	/**
	* @param options - credential source, timing, and the test seam.
	*/
	constructor(options) {
		this.resolveCredential = options.resolveCredential;
		this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
		this.videoBudgetMs = options.videoBudgetMs ?? VIDEO_BUDGET_MS;
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.sleepImpl = options.sleep ?? sleep;
	}
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
	async generateImage(request, signal) {
		throwIfAborted(signal);
		const credential = await this.resolveCredential();
		throwIfAborted(signal);
		const payload = await this.requestJson(`${baseOf(credential)}${IMAGES_PATH}`, {
			method: "POST",
			headers: mediaHeaders(credential),
			body: JSON.stringify({
				prompt: request.prompt,
				n: 1,
				size: request.size ?? DEFAULT_IMAGE_SIZE,
				...request.model === void 0 ? {} : { model: request.model }
			})
		}, signal, "image generation");
		const item = Array.isArray(payload.data) ? payload.data[0] : void 0;
		if (item === null || typeof item !== "object") throw new Error("image generation returned no image: the response carried no `data` entry");
		const entry = item;
		const bytes = await this.imageBytes(entry, signal);
		const mediaType = sniffImageMediaType(bytes);
		if (mediaType === void 0) throw new Error(`image generation returned ${bytes.byteLength} bytes that are not a recognized image format (starts with ${hex(bytes.subarray(0, 8))})`);
		const usage = usageOf(payload);
		return {
			bytes,
			mediaType,
			...typeof entry.revised_prompt === "string" && entry.revised_prompt !== "" ? { revisedPrompt: entry.revised_prompt } : {},
			...typeof payload.model === "string" && payload.model !== "" ? { model: payload.model } : {},
			...usage === void 0 ? {} : { usage }
		};
	}
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
	async generateVideo(request, signal) {
		throwIfAborted(signal);
		const credential = await this.resolveCredential();
		throwIfAborted(signal);
		const base = baseOf(credential);
		const headers = mediaHeaders(credential);
		const submitted = await this.requestJson(`${base}${VIDEOS_PATH}`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				prompt: request.prompt,
				seconds: request.seconds ?? DEFAULT_VIDEO_SECONDS,
				size: request.size ?? DEFAULT_VIDEO_SIZE,
				...request.model === void 0 ? {} : { model: request.model }
			})
		}, signal, "video generation");
		const taskId = typeof submitted.id === "string" && submitted.id !== "" ? submitted.id : void 0;
		if (taskId === void 0) throw new Error("video generation was not accepted: the response carried no task id");
		const segment = taskId.split("/").map((part) => encodeURIComponent(part)).join("/");
		const started = Date.now();
		let terminal;
		for (;;) {
			throwIfAborted(signal);
			const state = await this.requestJson(`${base}${VIDEOS_PATH}/${segment}`, { headers }, signal, "video generation");
			const status = typeof state.status === "string" ? state.status : "";
			if (status === "completed") {
				terminal = state;
				break;
			}
			if (FAILED_VIDEO_STATUSES.includes(status)) throw new Error(`video generation ${status} upstream${detailOf(state)}`);
			if (Date.now() - started > this.videoBudgetMs) throw new Error(`video generation did not finish within ${Math.round(this.videoBudgetMs / 1e3)}s (last status: ${status || "unknown"})`);
			await this.sleepImpl(this.pollIntervalMs, signal);
		}
		const content = await this.requestJson(`${base}${VIDEOS_PATH}/${segment}/content`, { headers }, signal, "video generation");
		const url = typeof content.url === "string" ? normalizePresignedUrl(content.url) : "";
		if (url === "") throw new Error("video generation finished but returned no download URL");
		const bytes = await this.download(url, signal);
		const mediaType = sniffVideoMediaType(bytes);
		if (mediaType === void 0) throw new Error(`video generation returned ${bytes.byteLength} bytes that are not a recognized video format (starts with ${hex(bytes.subarray(0, 8))})`);
		const usage = usageOf(terminal);
		return {
			bytes,
			mediaType,
			taskId,
			...typeof terminal?.model === "string" && terminal.model !== "" ? { model: terminal.model } : {},
			...typeof terminal?.seconds === "string" && terminal.seconds !== "" ? { seconds: terminal.seconds } : {},
			...usage === void 0 ? {} : { usage }
		};
	}
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
	async imageBytes(entry, signal) {
		if (typeof entry.b64_json === "string" && entry.b64_json !== "") return new Uint8Array(Buffer.from(entry.b64_json, "base64"));
		if (typeof entry.url === "string" && entry.url !== "") return await this.download(entry.url, signal);
		throw new Error("image generation returned neither `url` nor `b64_json`");
	}
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
	async download(url, signal) {
		try {
			return await this.fetchBytes(url, signal);
		} catch (error) {
			if (!url.startsWith("http://") || signal?.aborted === true) throw error;
			return await this.fetchBytes(url.replace(/^http:/, "https:"), signal);
		}
	}
	/** One download attempt. The URL is deliberately absent from the failure message — it is presigned. */
	async fetchBytes(url, signal) {
		const response = await this.fetchImpl(url, signal === void 0 ? {} : { signal });
		if (!response.ok) throw new Error(`could not download the generated media: the presigned URL answered HTTP ${response.status}`);
		return new Uint8Array(await response.arrayBuffer());
	}
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
	async requestJson(url, init, signal, what) {
		const response = await this.fetchImpl(url, {
			...init,
			...signal === void 0 ? {} : { signal }
		});
		const text = await response.text();
		let payload;
		try {
			payload = JSON.parse(text);
		} catch {
			payload = void 0;
		}
		if (!response.ok) {
			const message = upstreamMessage(payload) ?? excerpt(text);
			const hint = response.status === 401 ? " The saved wps_sid is missing, expired, or was rejected — ask the user to paste a fresh one on the dsh-connect-comate plugin card." : "";
			throw new Error(`${what} failed: HTTP ${response.status}${message === "" ? "" : ` — ${message}`}.${hint}`);
		}
		if (payload === null || typeof payload !== "object") throw new Error(`${what} returned a body that is not JSON: ${excerpt(text)}`);
		const record = payload;
		if (record.error !== void 0) throw new Error(`${what} failed: ${upstreamMessage(payload) ?? excerpt(text)}`);
		return record;
	}
};
/**
* The gateway usage object, when it really is one.
*
* JSON can carry `null` here and the contract declares an object, so the shape
* is checked at the boundary rather than declared nullable and pushed outward.
*
* @param payload - the response body, or undefined when there is none.
* @returns the usage record, or undefined.
*/
function usageOf(payload) {
	const usage = payload?.["usage"];
	return usage !== null && typeof usage === "object" ? usage : void 0;
}
/**
* The gateway base URL, without a trailing slash.
*
* @param credential - the resolved credential.
* @returns the base URL.
*/
function baseOf(credential) {
	return credential.baseUrl.replace(/\/+$/, "");
}
/**
* The headers every media request carries.
*
* `Cookie` alone authenticates: measured, `Authorization: Bearer <apiKey>`
* answers `401 not_login` with the same body as sending nothing, while the
* cookie reaches the business layer. `X-App-Id` is not required either, but the
* desktop client sends it and it costs nothing to match. The two request ids are
* for the gateway's own tracing.
*
* @param credential - the resolved credential.
* @returns the header map.
*/
function mediaHeaders(credential) {
	return {
		"Content-Type": "application/json",
		"X-App-Id": APP_ID,
		"X-Request-Id": randomUUID(),
		"X-Session-Id": randomUUID(),
		...credential.cookie === void 0 ? {} : { Cookie: credential.cookie }
	};
}
/**
* Undo the escaping the gateway applies to presigned URLs.
*
* The JSON arrives with `\u0026` where the URL needs `&`; fetching it verbatim
* sends a query string with one giant parameter and the object store answers
* 403. Both the literal escape and its percent-encoded spelling are seen.
*
* @param url - the URL as returned.
* @returns the URL to fetch.
*/
function normalizePresignedUrl(url) {
	return url.replace(/\\u0026/gi, "&").replace(/%5Cu0026/gi, "&");
}
/**
* Pull the upstream's own sentence out of an error body.
*
* @param payload - the parsed body, possibly not an object.
* @returns the message, or `undefined` when the body carries none.
*/
function upstreamMessage(payload) {
	if (payload === null || typeof payload !== "object") return void 0;
	const record = payload;
	const error = record.error;
	if (typeof error === "string" && error !== "") return error;
	if (error !== null && typeof error === "object") {
		const nested = error;
		for (const candidate of [
			nested.message,
			nested.msg,
			nested.code
		]) if (typeof candidate === "string" && candidate !== "") return candidate;
	}
	for (const candidate of [record.message, record.msg]) if (typeof candidate === "string" && candidate !== "") return candidate;
}
/**
* A short, non-JSON body, for a message a model has to read.
*
* @param text - the raw body.
* @returns up to 200 characters.
*/
function excerpt(text) {
	const trimmed = text.trim();
	return trimmed.length <= 200 ? trimmed : `${trimmed.slice(0, 200)}…`;
}
/**
* A trailing detail for a terminal-but-failed task.
*
* @param state - the poll response.
* @returns ` (message)` or `''`.
*/
function detailOf(state) {
	const message = upstreamMessage(state);
	return message === void 0 ? "" : ` (${message})`;
}
/**
* Hex of a byte prefix, for a failure message that has to say what arrived.
*
* @param bytes - the first bytes of the payload.
* @returns space-free lowercase hex.
*/
function hex(bytes) {
	return Buffer.from(bytes).toString("hex");
}
/**
* Throw the caller's own reason when the signal has already fired.
*
* Called at every step of the long path so a cancellation stops the work
* instead of being noticed only at the next `fetch`.
*
* @param signal - the tool call's signal.
*/
function throwIfAborted(signal) {
	if (signal?.aborted === true) throw signal.reason ?? /* @__PURE__ */ new Error("the tool call was cancelled");
}
/**
* Sleep that can be cut short.
*
* @param ms - milliseconds to wait.
* @param signal - the tool call's signal.
* @returns a promise that resolves after the delay or rejects with the signal's reason.
*/
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? /* @__PURE__ */ new Error("the tool call was cancelled"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		if (signal?.aborted === true) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
}
//#endregion
//#region src/comate/credential.ts
/** The resolved module, cached across calls. */
let mainPlugin;
/** What the model is told when the main plugin is not installed at all. */
const MISSING_MAIN_PLUGIN = "WPS Comate media generation is unavailable: the dsh-connect-comate plugin is not installed in this DSH profile. This plugin deliberately keeps no copy of the credential machinery — the sealed sid format and its key file belong to dsh-connect-comate alone — so it has nothing to read the sid with. Ask the user to install dsh-connect-comate, then sign in on its settings card.";
/**
* Load the main plugin, or explain why the credential cannot be read.
*
* The default path caches on success and **not** on failure: a missing peer
* cannot appear mid-process (DSH loads plugins at boot), but caching a rejected
* promise would make one unlucky first call poison every later one for no
* benefit.
*
* An explicit `load` override runs unconditionally and touches neither side of
* the cache. That is not a detail of the test seam — it is the only way the
* seam works at all: the cache is process-global, so a caller injecting a
* loader would otherwise get the real module back the moment any earlier call
* had succeeded, and a test for the missing-peer path would silently be testing
* the present-peer path instead. (It was, until this comment existed.)
*
* @param load - override for tests; defaults to a real dynamic import.
* @returns the main plugin's exports.
* @throws {Error} with a message written for the model to relay.
*/
async function loadMainPlugin(load) {
	if (load === void 0 && mainPlugin !== void 0) return mainPlugin;
	try {
		const resolved = await (load ?? (() => import("dsh-connect-comate")))();
		if (load === void 0) mainPlugin = resolved;
		return resolved;
	} catch {
		throw new Error(MISSING_MAIN_PLUGIN);
	}
}
/**
* Read the sid out of the main plugin's settings section.
*
* `describe()` is called with NO options, and that is load-bearing: the
* redaction switch (`redactSecrets`) exists for the Remote boundary, and
* `dsh-settings` only applies it when the caller asks
* (`value: options?.redactSecrets ? redacted.value : value`). A host-side
* reader gets the real value. The projection also keeps volatile fields only
* and resolves live references before handing them over, so the `wpsSid`
* arrives as the plain stored string.
*
* The entry is matched by id first, then by "the single section that exposes a
* `wpsSid` at all" — because the id is whatever the user's profile entry is
* called, and a renamed entry must not silently lose the credential.
*
* @param ctx - the plugin context; `settings` is read without injecting it.
* @returns the stored value, or `undefined` when no section carries one.
*/
function readSettingsSid(ctx) {
	const settings = ctx.get("settings");
	if (typeof settings?.describe !== "function") return void 0;
	let descriptors;
	try {
		descriptors = settings.describe();
	} catch {
		return;
	}
	if (!Array.isArray(descriptors)) return void 0;
	const candidates = [];
	for (const descriptor of descriptors) {
		const value = descriptor?.value;
		if (value === null || typeof value !== "object") continue;
		const sid = value.wpsSid;
		if (typeof sid !== "string" || sid.trim() === "") continue;
		candidates.push({
			sid: sid.trim(),
			ns: typeof descriptor.ns === "string" ? descriptor.ns : ""
		});
	}
	return candidates.find((candidate) => candidate.ns === "dsh-connect-comate") ?? (candidates.length === 1 ? candidates[0] : void 0);
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
async function resolveComateCredential(ctx, options = {}) {
	const main = options.loadMainPlugin === void 0 ? await loadMainPlugin() : await loadMainPlugin(options.loadMainPlugin);
	const store = new main.ComateCredentialStore();
	if (options.configFile !== void 0) store.setConfigFile(options.configFile);
	if (options.secretKeyFile !== void 0) store.setSecretKeyFile(options.secretKeyFile);
	const settings = options.ignoreSettings === true ? void 0 : readSettingsSid(ctx);
	if (options.wpsSid !== void 0) store.setWpsSid(options.wpsSid);
	else if (settings !== void 0) store.setWpsSid(settings.sid);
	const credential = await store.current();
	if (credential === void 0) throw new Error(`WPS Comate media generation is unavailable: no Comate config file could be read, so there is no gateway to call. Expected one at the platform default path, or set ${main.COMATE_CONFIG_ENV} to point at it.`);
	if (isUsableCookie(credential.cookie)) return credential;
	throw new Error(await describeMissingSid(store, main.COMATE_SID_ENV));
}
/**
* Whether a cookie value is a real `wps_sid` rather than the shipped placeholder.
*
* The desktop config writes `headers.cookie: "COOKIE"` verbatim, and the store
* passes it through untouched when no sid was resolved. Checking the shape here
* is what turns "the gateway said 登录校验失败" into a sentence naming the field
* to fill in.
*
* @param cookie - the credential's cookie, possibly absent.
* @returns whether the media endpoints would accept it.
*/
function isUsableCookie(cookie) {
	return typeof cookie === "string" && cookie.startsWith("wps_sid=");
}
/**
* Explain why there is no usable sid, using the store's own diagnosis.
*
* A sealed value that will not open is the case worth separating out: it looks
* identical to "never configured" from the outside, but the fix is different
* (re-paste the sid, or restore the key file) and only the store knows the
* difference.
*
* @param store - the store the read went through.
* @param sidEnv - the environment variable name to name in the message, taken
*   from the main plugin so the two plugins never quote different names.
* @returns the message for the tool failure.
*/
async function describeMissingSid(store, sidEnv) {
	let resolution;
	try {
		resolution = await store.resolveSid();
	} catch {
		resolution = void 0;
	}
	if (resolution?.storage === "unreadable") return `WPS Comate media generation is unavailable: the wps_sid saved on the dsh-connect-comate plugin card is sealed but cannot be decrypted (${resolution.problem ?? "unknown reason"}). The key file ${resolution.keyFile} is missing, unreadable, or was created for another machine or user. Ask the user to paste the sid again on that card, or to point WPS_COMATE_SECRET_KEY_FILE at the right key file.`;
	return `WPS Comate media generation needs a wps_sid, and none is configured. The Comate desktop config file only carries a placeholder cookie, which the gateway rejects — and it rejects the api key too, so the cookie is the only credential that works here. Ask the user to fill the wps_sid field on the dsh-connect-comate plugin card, or to set ${sidEnv} in the environment (headless runs).`;
}
//#endregion
//#region src/deliverables.ts
/** The event the Web client reads to show an openable deliverable. */
const DELIVERABLES_PRESENTED = "deliverables/presented";
/**
* The Session working directory, when one is known.
*
* Read structurally rather than through `dsh-agent`'s types: this plugin does
* not otherwise depend on that package, and the field has been stable while the
* surrounding types have not. `undefined` means "no workspace", which callers
* answer with a temporary directory.
*
* @param agent - `exec.agent`, possibly absent for direct or nested callers.
* @returns the absolute working directory, or `undefined`.
*/
function readSessionCwd(agent) {
	const cwd = (agent?.session)?.header?.cwd;
	return typeof cwd === "string" && cwd.length > 0 ? cwd : void 0;
}
/**
* Append `deliverables/presented` for one successful call.
*
* Mirrors `dsh-tool-present`'s payload exactly (`turn`, `callId`, `files`), so
* the client needs no knowledge of which plugin declared the file. Requires an
* OPEN turn: the event carries the turn it belongs to, and appending it outside
* one would file the deliverable under a turn that does not exist.
*
* @param ctx - the plugin context, for the optional `sessionProjections` read.
* @param agent - `exec.agent`, possibly absent.
* @param callId - `exec.callId`, for the audit trail.
* @param files - the files to declare; empty is a no-op.
* @returns whether the event was appended.
*/
function publishDeliverables(ctx, agent, callId, files) {
	if (files.length === 0) return false;
	try {
		const session = agent?.session;
		if (session?.append === void 0) return false;
		const boundary = ctx.get("sessionProjections")?.stateOf?.(session, "turnBoundary");
		if (boundary === void 0) return false;
		const turn = boundary.lastTurn;
		if (turn === void 0 || boundary.openTurnStartSeq === null || boundary.openTurnStartSeq === void 0) return false;
		session.append(DELIVERABLES_PRESENTED, {
			turn,
			callId,
			files: files.map((file) => ({ ...file }))
		});
		return true;
	} catch {
		return false;
	}
}
//#endregion
//#region src/signals.ts
/**
* Combine the caller's signal with a timeout.
*
* `AbortSignal.timeout` uses an unref'd timer, so a pending deadline never keeps
* the process alive, and `AbortSignal.any` propagates the FIRST abort reason —
* the caller's own reason survives when they cancel, which is what lets the
* registry classify a user stop as a cancellation rather than a failure.
*
* @param caller - the caller-owned signal from `exec.signal`.
* @param timeoutMs - positive finite budget in milliseconds.
* @returns the combined signal and the clock-expiry probe.
*/
function withDeadline(caller, timeoutMs) {
	const timer = AbortSignal.timeout(timeoutMs);
	return {
		signal: AbortSignal.any([caller, timer]),
		expired: () => timer.aborted,
		timeoutMs
	};
}
/**
* Render a budget the way a person reads it: milliseconds below a second, whole seconds above.
*
* @param timeoutMs - the budget in milliseconds.
* @returns a short human-readable form, for example `40ms` or `25s`.
*/
function formatBudget(timeoutMs) {
	return timeoutMs >= 1e3 ? `${Math.round(timeoutMs / 1e3)}s` : `${timeoutMs}ms`;
}
/**
* Race an operation against its deadline.
*
* Passing the signal downstream is necessary but NOT sufficient: a signal is a
* request, and an implementation that never reads it — a promise parked on a
* socket that stopped responding, say — would otherwise hang the turn forever,
* which is exactly the failure `timeoutMs` exists to bound. Racing here makes
* the declared budget real regardless of what the other side does.
*
* The two aborts stay distinguishable: a clock expiry becomes the caller's
* message via `timeoutMessage`, while a caller cancellation rejects with the
* caller's OWN reason, so a user pressing stop never sees a timeout.
*
* @param operation - the work to bound; its own rejections pass through untouched.
* @param deadline - the combined caller-plus-clock signal.
* @param timeoutMessage - builds the message for a clock expiry, from a formatted budget.
* @returns the operation's value, or the first failure to arrive.
*/
async function raceDeadline(operation, deadline, timeoutMessage) {
	const { signal } = deadline;
	let detach = () => void 0;
	const aborted = new Promise((_resolve, reject) => {
		const fail = () => {
			reject(deadline.expired() ? new Error(timeoutMessage(formatBudget(deadline.timeoutMs))) : signal.reason ?? /* @__PURE__ */ new Error("the tool call was cancelled"));
		};
		if (signal.aborted) {
			fail();
			return;
		}
		signal.addEventListener("abort", fail, { once: true });
		detach = () => signal.removeEventListener("abort", fail);
	});
	try {
		return await Promise.race([operation, aborted]);
	} finally {
		detach();
	}
}
//#endregion
//#region src/storage.ts
/**
* Where generated bytes land on disk.
*
* Bytes are saved even when the implementation already uploaded them to cloud
* storage, because the two consumers want different things: the chat wants a
* displayable object, and the user wants a file they can open, keep, and drop
* into another document. The cloud key is a transport detail; a local path is
* an artifact.
*
* @module dsh-comate-media/storage
*/
/**
* Write one artifact under a collision-proof, sortable name.
*
* The name carries a local-time stamp so a directory listing reads as a
* timeline, plus a random suffix so two calls in the same second — which the
* image path reaches easily at ~10 s per generation — cannot overwrite each
* other. Nothing here reads the prompt: prompts are long, user-authored, and
* frequently contain path separators and reserved characters, and a filename is
* the wrong place to discover that.
*
* @param input - directory, bytes, naming inputs.
* @returns the absolute path and the byte count.
*/
async function saveGeneratedMedia(input) {
	const stamp = formatStamp(input.now ?? /* @__PURE__ */ new Date());
	const suffix = randomBytes(3).toString("hex");
	const name = `${input.prefix}-${stamp}-${suffix}${input.extension}`;
	const path = join(input.dir, name);
	await mkdir(input.dir, { recursive: true });
	await writeFile(path, input.bytes);
	return {
		path,
		bytes: input.bytes.byteLength
	};
}
/**
* Render a local-time `YYYYMMDD-HHMMSS` stamp.
*
* Local time, not UTC: the user reading the filename is looking at their own
* clock, and a file generated at 23:40 should not be named for the next day.
*
* @param date - the moment to render.
* @returns the compact sortable stamp.
*/
function formatStamp(date) {
	const pad = (value, width = 2) => String(value).padStart(width, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
//#endregion
//#region src/tools/generate-image.ts
/**
* `comate_generate_image` — text prompt in, image out.
*
* The tool's job is narrow: ask the main plugin for bytes, put them somewhere
* durable, and hand the model something it can SEE. The last part is the whole
* reason this tool returns an `ImageBlock` instead of a path: a path makes the
* model guess, and `dsh-tools` turns a successful image-bearing result into
* deferred user-message context, so the next step of the turn actually looks at
* the picture.
*
* @module dsh-comate-media/tools/generate-image
*/
/** The model-facing tool name. */
const GENERATE_IMAGE_TOOL = "comate_generate_image";
/** Nested value schema for the committed attachment, mirroring the shape `read_image` declares. */
const IMAGE_VALUE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		attachmentId: {
			type: "string",
			required: true
		},
		mediaType: {
			type: "string",
			enum: [
				"image/png",
				"image/jpeg",
				"image/webp",
				"image/gif"
			],
			required: true
		},
		bytes: {
			type: "integer",
			required: true
		},
		width: {
			type: "integer",
			required: true
		},
		height: {
			type: "integer",
			required: true
		},
		name: { type: "string" }
	}
};
/**
* Register {@link GENERATE_IMAGE_TOOL}.
*
* @param ctx - the plugin context; `tools` is injected, the attachment service
*   is read lazily per call.
* @param options - the client, budget, and storage policy from the plugin config.
*/
function registerGenerateImage(ctx, options) {
	ctx.tools.register(defineTool({
		name: GENERATE_IMAGE_TOOL,
		description: "Generate an image from a text prompt with the user's signed-in WPS Comate account and return the image itself. Use it when the user asks for a picture, illustration, poster, or other artwork. Generation takes roughly ten seconds. The upstream provider applies the required AIGC label, so never add a watermark, caption, or metadata of your own.",
		parameters: {
			prompt: {
				type: "string",
				required: true,
				description: "What to draw, in the language of the user's request. Be specific about subject, style, composition, and lighting."
			},
			size: {
				type: "string",
				description: "Output size in PIXELS as WIDTHxHEIGHT, for example 960x960 or 1024x768. Omit for the default 960x960."
			},
			model: {
				type: "string",
				description: "Provider model id. Omit to let the service route to its default image model."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					prompt: {
						type: "string",
						required: true
					},
					media_type: {
						type: "string",
						required: true
					},
					bytes: {
						type: "integer",
						required: true
					},
					width: {
						type: "integer",
						required: true
					},
					height: {
						type: "integer",
						required: true
					},
					path: { type: "string" },
					model: { type: "string" },
					revised_prompt: { type: "string" },
					image: IMAGE_VALUE_SCHEMA
				}
			},
			render: (_args, value) => imageContent(value),
			presentationMeta: (_args, value) => ({ path: value.path ?? null })
		},
		isConcurrencySafe: () => true,
		timeoutMs: options.timeoutMs,
		async execute(args, exec) {
			const prompt = args.prompt.trim();
			if (prompt.length === 0) throw new Error("prompt must be a non-empty string");
			const request = {
				prompt,
				...args.size === void 0 ? {} : { size: args.size },
				...args.model === void 0 ? {} : { model: args.model }
			};
			const deadline = withDeadline(exec.signal, options.timeoutMs);
			const generated = await generate$1(options.api, request, deadline);
			const dir = resolveOutputDir(options, exec.agent);
			const saved = dir === void 0 ? void 0 : await saveGeneratedMedia({
				dir,
				bytes: generated.bytes,
				extension: extensionForMediaType(generated.mediaType),
				prefix: "comate-image"
			});
			const attachments = ctx.get("attachments");
			const ref = attachments === void 0 ? void 0 : await attachments.saveImage({
				data: generated.bytes,
				mediaType: generated.mediaType,
				...saved === void 0 ? {} : { name: basenameOf(saved.path) }
			});
			if (saved !== void 0) publishDeliverables(ctx, exec.agent, exec.callId, [{
				path: saved.path,
				description: `Generated image for: ${prompt.slice(0, 80)}`
			}]);
			return {
				prompt,
				media_type: generated.mediaType,
				bytes: generated.bytes.byteLength,
				width: ref?.width ?? 0,
				height: ref?.height ?? 0,
				...saved === void 0 ? {} : { path: saved.path },
				...generated.model === void 0 ? {} : { model: generated.model },
				...generated.revisedPrompt === void 0 ? {} : { revised_prompt: generated.revisedPrompt },
				...ref === void 0 ? {} : { image: {
					attachmentId: ref.attachmentId,
					mediaType: ref.mediaType,
					bytes: ref.bytes,
					width: ref.width,
					height: ref.height,
					...ref.name === void 0 ? {} : { name: ref.name }
				} }
			};
		}
	}));
}
/**
* Call the service under the deadline.
*
* A caller cancellation keeps its own reason: the registry owns that outcome and
* classifies it as an abort, and rewriting it here would hide the user's own
* stop button behind an error message.
*
* @param media - the Comate client.
* @param request - the trimmed prompt plus any caller overrides.
* @param deadline - the combined caller-plus-clock signal.
* @returns the generated image.
*/
async function generate$1(media, request, deadline) {
	return await raceDeadline(media.generateImage(request, deadline.signal), deadline, (budget) => `image generation did not finish within ${budget} and was cancelled; the service may be slow or the account may be rate-limited — retry once, or ask the user to check their WPS Comate account`);
}
/**
* Where a generated image is written, or `undefined` to keep it only in the attachment store.
*
* @param options - the plugin config.
* @param agent - `exec.agent`, possibly absent for nested callers.
* @returns an absolute directory, or `undefined` when disk copies are off.
*/
function resolveOutputDir(options, agent) {
	if (!options.saveToDisk) return void 0;
	return options.outputDir ?? readSessionCwd(agent) ?? tmpdir();
}
/** Final path segment, without importing `node:path` for one call. */
function basenameOf(path) {
	const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return index === -1 ? path : path.slice(index + 1);
}
/**
* Project one generated image into the model-facing envelope.
*
* The text block leads so a text-only route still learns the dimensions and the
* saved path; the image block follows, and `dsh-tools` defers it into
* user-message context so the model can look at what it just made.
*
* @param value - the validated canonical value.
* @returns the content blocks for this result.
*/
function imageContent(value) {
	const lines = [`Generated an image: ${value.width}x${value.height} ${value.media_type}, ${value.bytes} bytes.`];
	if (value.path !== void 0) lines.push(`Saved to ${value.path}`);
	if (value.model !== void 0) lines.push(`Model: ${value.model}`);
	if (value.revised_prompt !== void 0) lines.push(`Upstream prompt: ${value.revised_prompt}`);
	const blocks = [{
		type: "text",
		text: lines.join("\n")
	}];
	if (value.image !== void 0) blocks.push({
		type: "image",
		attachment: {
			attachmentId: AttachmentId(value.image.attachmentId),
			mediaType: value.image.mediaType,
			bytes: value.image.bytes,
			width: value.image.width,
			height: value.image.height,
			...value.image.name === void 0 ? {} : { name: value.image.name }
		}
	});
	return blocks;
}
//#endregion
//#region src/tools/generate-video.ts
/**
* `comate_generate_video` — text prompt in, short clip out.
*
* Structurally different from the image tool in one way that shapes everything
* else: the gateway generates video ASYNCHRONOUSLY (submit, then poll for up to
* twenty minutes), so one call here can hold a turn open for minutes. The main
* plugin hides the polling — it resolves only when the bytes are in hand — which
* is why this file has no state machine and only needs a deadline.
*
* Display is different too, and worse. A generated image can become an
* `ImageBlock`; a video has no chat-renderable form, because DSH's markdown
* pipeline rewrites image destinations only and the generic tool card never
* renders a player. So the local file IS the deliverable: this tool always
* writes it to disk and declares it, regardless of the `saveToDisk` setting that
* governs images.
*
* @module dsh-comate-media/tools/generate-video
*/
/** The model-facing tool name. */
const GENERATE_VIDEO_TOOL = "comate_generate_video";
/** Resolution tiers the gateway accepts. */
const RESOLUTION_TIERS = [
	"480p",
	"720p",
	"1080p"
];
/**
* Register {@link GENERATE_VIDEO_TOOL}.
*
* @param ctx - the plugin context; `tools` is injected.
* @param options - the client, budget, and output location from the plugin config.
*/
function registerGenerateVideo(ctx, options) {
	ctx.tools.register(defineTool({
		name: GENERATE_VIDEO_TOOL,
		description: "Generate a short video clip from a text prompt with the user's signed-in WPS Comate account. Use it when the user asks for a video, animation, or moving shot. Generation is asynchronous and typically takes one to three minutes; the call returns only when the clip is ready, so do not retry it on your own while it runs. The saved file is declared as a deliverable the user can open.",
		parameters: {
			prompt: {
				type: "string",
				required: true,
				description: "What the clip should show, in the language of the user's request. Describe subject, action, camera movement, and mood."
			},
			seconds: {
				type: "string",
				description: "Duration in seconds, as a string: \"5\" or \"10\". Omit for the default 5."
			},
			size: {
				type: "string",
				enum: [...RESOLUTION_TIERS],
				description: "Resolution TIER — 480p, 720p, or 1080p. This is not a pixel size; the image tool's size parameter is. Omit for the default 720p."
			},
			model: {
				type: "string",
				description: "Provider model id. Omit to let the service route to its default video model."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					prompt: {
						type: "string",
						required: true
					},
					media_type: {
						type: "string",
						required: true
					},
					bytes: {
						type: "integer",
						required: true
					},
					path: {
						type: "string",
						required: true
					},
					seconds: { type: "string" },
					model: { type: "string" },
					task_id: { type: "string" }
				}
			},
			render: (_args, value) => videoContent(value),
			presentationMeta: (_args, value) => ({ path: value.path })
		},
		isConcurrencySafe: () => true,
		timeoutMs: options.timeoutMs,
		async execute(args, exec) {
			const prompt = args.prompt.trim();
			if (prompt.length === 0) throw new Error("prompt must be a non-empty string");
			const request = {
				prompt,
				...args.seconds === void 0 ? {} : { seconds: args.seconds },
				...args.size === void 0 ? {} : { size: args.size },
				...args.model === void 0 ? {} : { model: args.model }
			};
			const deadline = withDeadline(exec.signal, options.timeoutMs);
			const generated = await generate(options.api, request, deadline);
			const saved = await saveGeneratedMedia({
				dir: options.outputDir ?? readSessionCwd(exec.agent) ?? tmpdir(),
				bytes: generated.bytes,
				extension: extensionForMediaType(generated.mediaType),
				prefix: "comate-video"
			});
			publishDeliverables(ctx, exec.agent, exec.callId, [{
				path: saved.path,
				description: `Generated video for: ${prompt.slice(0, 80)}`
			}]);
			return {
				prompt,
				media_type: generated.mediaType,
				bytes: generated.bytes.byteLength,
				path: saved.path,
				...generated.seconds === void 0 ? {} : { seconds: generated.seconds },
				...generated.model === void 0 ? {} : { model: generated.model },
				...generated.taskId === void 0 ? {} : { task_id: generated.taskId }
			};
		}
	}));
}
/**
* Call the service under the deadline.
*
* A caller cancellation keeps its own reason, for the same reason as the image
* tool: the registry owns that outcome and classifies it as an abort.
*
* @param media - the Comate client.
* @param request - the trimmed prompt plus any caller overrides.
* @param deadline - the combined caller-plus-clock signal.
* @returns the generated clip, already downloaded.
*/
async function generate(media, request, deadline) {
	return await raceDeadline(media.generateVideo(request, deadline.signal), deadline, (budget) => `video generation did not finish within ${budget} and was cancelled; the upstream queue can be slow at peak times — retry once, or try a shorter clip`);
}
/**
* Project one generated clip into the model-facing envelope.
*
* Text only, deliberately: there is no content block a video can travel in, and
* pretending otherwise would produce a result the client silently drops. The
* path is the payload — the model relays it, and the deliverable card is what
* makes it openable.
*
* @param value - the validated canonical value.
* @returns the content blocks for this result.
*/
function videoContent(value) {
	const lines = [`Generated a video: ${value.media_type}, ${value.bytes} bytes.`];
	lines.push(`Saved to ${value.path}`);
	if (value.seconds !== void 0) lines.push(`Duration: ${value.seconds}s`);
	if (value.model !== void 0) lines.push(`Model: ${value.model}`);
	if (value.task_id !== void 0) lines.push(`Upstream task: ${value.task_id}`);
	return [{
		type: "text",
		text: lines.join("\n")
	}];
}
//#endregion
//#region src/index.ts
/** Loader identity; matches the package name so the Cordis patch entry resolves. */
const name = "dsh-comate-media";
/**
* Only `tools`.
*
* `settings` and `attachments` are intentionally absent — both are read with
* `ctx.get` at call time. Injecting `settings` would make the whole plugin wait
* on it, and the credential has an environment fallback that needs no service.
*/
const inject = ["tools"];
const Config = z.object({
	/**
	* Fixed directory for generated files. Empty means "the Session working
	* directory, falling back to the system temporary directory".
	*/
	outputDir: z.string().default(""),
	/**
	* Budget for one image generation. The shipped desktop client measures about
	* eleven seconds against the real gateway; five minutes leaves room for a
	* cold queue without leaving a stuck call running for an hour.
	*/
	imageTimeoutMs: z.number().default(3e5),
	/**
	* Budget for one video generation. Twenty-five minutes, because the shipped
	* client polls the asynchronous task for up to twenty minutes before giving
	* up — a shorter deadline here would abort calls the upstream would have
	* completed.
	*/
	videoTimeoutMs: z.number().default(15e5),
	/**
	* Whether to keep a disk copy of generated IMAGES beside the committed
	* attachment. Videos are always written to disk, because the file is their
	* only artifact — see `./tools/generate-video.ts`.
	*/
	saveToDisk: z.boolean().default(true)
});
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
function mount(ctx, config, api) {
	const outputDir = config.outputDir.trim().length === 0 ? void 0 : config.outputDir;
	registerGenerateImage(ctx, {
		api,
		timeoutMs: config.imageTimeoutMs,
		saveToDisk: config.saveToDisk,
		outputDir
	});
	registerGenerateVideo(ctx, {
		api,
		timeoutMs: config.videoTimeoutMs,
		outputDir
	});
}
/**
* Register both tools against the shipped Comate client.
*
* @param ctx - agent-scoped services; `tools` is guaranteed by {@link inject}.
* @param config - validated plugin configuration.
*/
function apply(ctx, config) {
	mount(ctx, config, new ComateMediaClient({ resolveCredential: () => resolveComateCredential(ctx) }));
}
//#endregion
export { ComateMediaClient, Config, apply, inject, mount, name, resolveComateCredential };
