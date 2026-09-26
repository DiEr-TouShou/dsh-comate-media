/**
 * Where this plugin gets its Comate credential.
 *
 * The credential is the ONE thing this plugin cannot own. Measured fact (see
 * README「凭据」): the media endpoints accept the `wps_sid` cookie and nothing
 * else — `Authorization: Bearer <config apiKey>` comes back `401 not_login`
 * with the same body as sending no credential at all — and the desktop config
 * file only carries the placeholder string `COOKIE`. So the sid has to come
 * from somewhere a user put it, in this order:
 *
 *   1. the `dsh-connect-comate` plugin's own settings document, where the card
 *      saved it (sealed as `enc:v1:…`);
 *   2. `WPS_COMATE_SID`, for headless and one-off runs.
 *
 * Both are handed to `dsh-connect-comate`'s own `ComateCredentialStore` rather
 * than re-implemented here. That class owns the envelope format, the key file,
 * and the config-file probe order, and a second implementation of a sealed
 * format is exactly how two plugins start disagreeing about what a credential
 * is. It is also why `dsh-connect-comate` is a hard `dependencies` entry of
 * this package rather than an optional peer: the import must resolve.
 *
 * Precedence is the main plugin's own — the settings value is applied as the
 * store's override, and the store falls back to the environment — so a user
 * reading both plugins' documentation finds one rule, not two.
 *
 * @module dsh-comate-media/comate/credential
 */

import type { Context } from '@deepseek-ai/cordis'
import { COMATE_CONFIG_ENV, COMATE_SID_ENV, ComateCredentialStore } from 'dsh-connect-comate'
import type { ComateCredential, ComateSidResolution } from 'dsh-connect-comate'

/** The profile entry id the main plugin registers its settings section under. */
export const COMATE_SETTINGS_ENTRY = 'dsh-connect-comate'

/**
 * The slice of `ctx.settings` this module reads.
 *
 * Structural on purpose: importing `@deepseek-ai/dsh-settings` for one method
 * would add a peer dependency to a package that only needs to read a value out
 * of a document the host already owns.
 */
interface SettingsDescriptorLike {
  ns?: unknown
  value?: unknown
}

/** The settings service as this module sees it. */
interface SettingsSurfaceLike {
  describe?: (options?: { redactSecrets?: boolean }) => unknown
}

/** One settings section's sid, and the entry it came from. */
export interface ComateSettingsSid {
  /** The raw stored value: sealed (`enc:v1:…`) or legacy plaintext. */
  sid: string
  /** The profile entry id it was read from, for diagnostics. */
  ns: string
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
export function readSettingsSid(ctx: Context): ComateSettingsSid | undefined {
  const settings = ctx.get('settings') as SettingsSurfaceLike | undefined
  if (typeof settings?.describe !== 'function') return undefined

  let descriptors: unknown
  try {
    // A malformed profile must not take a tool call down with it: the caller
    // turns `undefined` into an actionable message either way.
    descriptors = settings.describe()
  } catch {
    return undefined
  }
  if (!Array.isArray(descriptors)) return undefined

  const candidates: ComateSettingsSid[] = []
  for (const descriptor of descriptors as SettingsDescriptorLike[]) {
    const value = descriptor?.value
    if (value === null || typeof value !== 'object') continue
    const sid = (value as { wpsSid?: unknown }).wpsSid
    if (typeof sid !== 'string' || sid.trim() === '') continue
    candidates.push({
      sid: sid.trim(),
      ns: typeof descriptor.ns === 'string' ? descriptor.ns : '',
    })
  }

  return candidates.find((candidate) => candidate.ns === COMATE_SETTINGS_ENTRY)
    ?? (candidates.length === 1 ? candidates[0] : undefined)
}

/**
 * Overrides for {@link resolveComateCredential}.
 *
 * A test seam, not a user-facing knob: the plugin's own config deliberately has
 * no credential fields, because the sid belongs to `dsh-connect-comate`'s card
 * and a second place to paste it is a second place to forget to update it.
 */
export interface ResolveComateCredentialOptions {
  /** Explicit sid, beating both the settings document and the environment. */
  wpsSid?: string
  /** Explicit config file, overriding the platform default. */
  configFile?: string
  /** Explicit key file for a sealed sid. */
  secretKeyFile?: string
  /** Skip the settings read entirely (for tests that only exercise the env path). */
  ignoreSettings?: boolean
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
export async function resolveComateCredential(
  ctx: Context,
  options: ResolveComateCredentialOptions = {},
): Promise<ComateCredential> {
  // Built empty and then pointed at the overrides, rather than passed through
  // the constructor: `exactOptionalPropertyTypes` rejects a conditional spread
  // whose branches have different shapes, and two setters read better anyway.
  const store = new ComateCredentialStore()
  if (options.configFile !== undefined) store.setConfigFile(options.configFile)
  if (options.secretKeyFile !== undefined) store.setSecretKeyFile(options.secretKeyFile)

  const settings = options.ignoreSettings === true ? undefined : readSettingsSid(ctx)
  if (options.wpsSid !== undefined) store.setWpsSid(options.wpsSid)
  else if (settings !== undefined) store.setWpsSid(settings.sid)

  const credential = await store.current()
  if (credential === undefined) {
    throw new Error(
      'WPS Comate media generation is unavailable: no Comate config file could be read, so there is no '
      + `gateway to call. Expected one at the platform default path, or set ${COMATE_CONFIG_ENV} to point at it.`,
    )
  }
  if (isUsableCookie(credential.cookie)) return credential

  // The config file answered, but with the placeholder the desktop client ships
  // instead of a real cookie — so the failure is "no sid", not "no config", and
  // the message has to say which of the two things to fix.
  throw new Error(await describeMissingSid(store))
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
function isUsableCookie(cookie: string | undefined): boolean {
  return typeof cookie === 'string' && cookie.startsWith('wps_sid=')
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
 * @returns the message for the tool failure.
 */
async function describeMissingSid(store: ComateCredentialStore): Promise<string> {
  let resolution: ComateSidResolution | undefined
  try {
    resolution = await store.resolveSid()
  } catch {
    // Diagnosis is best-effort; the generic message below is still correct.
    resolution = undefined
  }

  if (resolution?.storage === 'unreadable') {
    return 'WPS Comate media generation is unavailable: the wps_sid saved on the dsh-connect-comate plugin card is '
      + `sealed but cannot be decrypted (${resolution.problem ?? 'unknown reason'}). The key file ${resolution.keyFile} `
      + 'is missing, unreadable, or was created for another machine or user. Ask the user to paste the sid again on '
      + 'that card, or to point WPS_COMATE_SECRET_KEY_FILE at the right key file.'
  }

  return 'WPS Comate media generation needs a wps_sid, and none is configured. The Comate desktop config file only '
    + 'carries a placeholder cookie, which the gateway rejects — and it rejects the api key too, so the cookie is '
    + `the only credential that works here. Ask the user to fill the wps_sid field on the dsh-connect-comate plugin `
    + `card, or to set ${COMATE_SID_ENV} in the environment (headless runs).`
}
