/**
 * Where the credential comes from, and what the user is told when it is missing.
 *
 * Two things are under test here, and neither is the crypto. The sealed-value
 * handling belongs to `dsh-connect-comate`'s `ComateCredentialStore` and is
 * tested there; what this plugin has to get right is
 *
 *   1. finding the sid in the main plugin's settings document, including when
 *      the user renamed their profile entry, and
 *   2. choosing WHICH sentence to fail with, because the three reasons a
 *      credential can be missing have three different fixes and the model
 *      relays whichever one it is handed.
 *
 * The config files are real, written into a temp directory, because the store
 * parses them for real: the interesting case (a config whose cookie is the
 * desktop client's `COOKIE` placeholder) only exists as a parsed result.
 *
 * @module dsh-comate-media/tests/credential
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { readSettingsSid, resolveComateCredential } from '../src/comate/credential.ts'

/** Temporary directories created during the run. */
const created: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/**
 * Write a Comate config file in the desktop client's shape.
 *
 * @param cookie - the value to put under `providers.official.headers.cookie`.
 * @returns the path.
 */
async function writeConfig(cookie?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-comate-media-cred-'))
  created.push(dir)
  const path = join(dir, 'config.json')
  await writeFile(path, JSON.stringify({
    providers: {
      official: {
        baseUrl: 'https://comate.wps.cn/llmproxy/v1/user',
        apiKey: 'api-key-from-config',
        headers: cookie === undefined ? {} : { cookie },
      },
    },
  }))
  return path
}

/**
 * A context whose `settings.describe()` answers with the given descriptors.
 *
 * Structural rather than a mounted service: this module calls exactly one
 * method, and mounting the real settings service to test one read would test
 * the host, not the plugin.
 *
 * @param describe - the value `describe()` returns, or a thrower.
 * @returns the context stand-in.
 */
function contextWithSettings(describe: unknown): Context {
  return {
    get: (name: string) => (name === 'settings' ? { describe } : undefined),
  } as unknown as Context
}

describe('readSettingsSid', () => {
  it('reads the sid out of the section the main plugin owns', () => {
    const ctx = contextWithSettings(() => [
      { ns: 'some-other-plugin', value: { wpsSid: 'wrong' } },
      { ns: 'dsh-connect-comate', value: { wpsSid: 'enc:v1:right' } },
    ])

    expect(readSettingsSid(ctx)).toEqual({ sid: 'enc:v1:right', ns: 'dsh-connect-comate' })
  })

  it('falls back to the only section carrying a sid, so a renamed entry keeps working', () => {
    const ctx = contextWithSettings(() => [
      { ns: 'comate-renamed-by-the-user', value: { wpsSid: 'enc:v1:only' } },
      { ns: 'unrelated', value: { someOtherField: true } },
    ])

    expect(readSettingsSid(ctx)?.sid).toBe('enc:v1:only')
  })

  it('refuses to guess between two foreign sections', () => {
    const ctx = contextWithSettings(() => [
      { ns: 'a', value: { wpsSid: 'one' } },
      { ns: 'b', value: { wpsSid: 'two' } },
    ])

    expect(readSettingsSid(ctx)).toBeUndefined()
  })

  it('ignores a blank or non-string sid', () => {
    const ctx = contextWithSettings(() => [
      { ns: 'dsh-connect-comate', value: { wpsSid: '   ' } },
      { ns: 'other', value: { wpsSid: 42 } },
    ])

    expect(readSettingsSid(ctx)).toBeUndefined()
  })

  it('trims what it reads', () => {
    const ctx = contextWithSettings(() => [{ ns: 'dsh-connect-comate', value: { wpsSid: '  enc:v1:x  ' } }])

    expect(readSettingsSid(ctx)?.sid).toBe('enc:v1:x')
  })

  it('survives a settings service that throws, and one that is absent', () => {
    expect(readSettingsSid(contextWithSettings(() => {
      throw new Error('profile is malformed')
    }))).toBeUndefined()
    expect(readSettingsSid({ get: () => undefined } as unknown as Context)).toBeUndefined()
  })
})

describe('resolveComateCredential', () => {
  it('uses a sid from the settings document and spells the cookie the gateway wants', async () => {
    const configFile = await writeConfig('COOKIE')
    const ctx = contextWithSettings(() => [{ ns: 'dsh-connect-comate', value: { wpsSid: 'settings-sid' } }])

    const credential = await resolveComateCredential(ctx, { configFile })

    expect(credential.cookie).toBe('wps_sid=settings-sid')
    expect(credential.baseUrl).toBe('https://comate.wps.cn/llmproxy/v1/user')
  })

  it('lets the settings document beat the environment, as the main plugin does', async () => {
    const configFile = await writeConfig('COOKIE')
    vi.stubEnv('WPS_COMATE_SID', 'env-sid')
    const ctx = contextWithSettings(() => [{ ns: 'dsh-connect-comate', value: { wpsSid: 'settings-sid' } }])

    const credential = await resolveComateCredential(ctx, { configFile })

    expect(credential.cookie).toBe('wps_sid=settings-sid')
  })

  it('falls back to the environment when no section carries a sid', async () => {
    const configFile = await writeConfig('COOKIE')
    vi.stubEnv('WPS_COMATE_SID', 'env-sid')

    const credential = await resolveComateCredential(contextWithSettings(() => []), { configFile })

    expect(credential.cookie).toBe('wps_sid=env-sid')
  })

  it('accepts a real cookie already written in the config file', async () => {
    const configFile = await writeConfig('wps_sid=from-config')

    const credential = await resolveComateCredential(
      contextWithSettings(() => []),
      { configFile, ignoreSettings: true },
    )

    expect(credential.cookie).toBe('wps_sid=from-config')
  })

  it('names the config file when there is no config at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-comate-media-cred-'))
    created.push(dir)

    const failure = resolveComateCredential(contextWithSettings(() => []), {
      configFile: join(dir, 'absent.json'),
      ignoreSettings: true,
    })

    await expect(failure).rejects.toThrow('no Comate config file could be read')
    await expect(failure).rejects.toThrow('WPS_COMATE_CONFIG_FILE')
  })

  it('asks for the sid, not the config, when the config only carries the placeholder', async () => {
    // This is the shipped state of a fresh install: the desktop config writes
    // `headers.cookie: "COOKIE"` verbatim, which the store treats as no cookie.
    const configFile = await writeConfig('COOKIE')

    const failure = resolveComateCredential(contextWithSettings(() => []), {
      configFile,
      ignoreSettings: true,
    })

    await expect(failure).rejects.toThrow('needs a wps_sid')
    await expect(failure).rejects.toThrow('fill the wps_sid field on the dsh-connect-comate plugin card')
    await expect(failure).rejects.toThrow('WPS_COMATE_SID')
    // And it says why the api key is not an alternative, which is the question
    // a user asks next.
    await expect(failure).rejects.toThrow('rejects the api key too')
  })

  it('separates a sealed sid that will not open from one that was never set', async () => {
    const configFile = await writeConfig('COOKIE')
    const dir = await mkdtemp(join(tmpdir(), 'dsh-comate-media-cred-'))
    created.push(dir)

    const failure = resolveComateCredential(contextWithSettings(() => []), {
      configFile,
      ignoreSettings: true,
      wpsSid: 'enc:v1:bm90LXJlYWxseS1lbmNyeXB0ZWQ=',
      secretKeyFile: join(dir, 'absent-key'),
    })

    // Same outward symptom as "never configured", different fix — so the message
    // has to be different too.
    await expect(failure).rejects.toThrow('sealed but cannot be decrypted')
    await expect(failure).rejects.toThrow(join(dir, 'absent-key'))
  })

  it('names the missing main plugin when the peer cannot be imported', async () => {
    // `dsh-connect-comate` is a peer, so it may genuinely be absent. The import
    // is deferred for exactly this case: a static import would have failed at
    // plugin load with ERR_MODULE_NOT_FOUND — loud, but with nothing in it the
    // user or the model can act on.
    const failure = resolveComateCredential(contextWithSettings(() => []), {
      ignoreSettings: true,
      loadMainPlugin: () => Promise.reject(new Error('ERR_MODULE_NOT_FOUND')),
    })

    await expect(failure).rejects.toThrow('the dsh-connect-comate plugin is not installed')
    await expect(failure).rejects.toThrow('install dsh-connect-comate')
    // The raw resolution error must not be what the model is handed.
    await expect(failure).rejects.not.toThrow('ERR_MODULE_NOT_FOUND')
  })

  it('honours an injected loader even after the real module has been cached', async () => {
    // A regression guard with a real origin: the cache is process-global, so an
    // earlier test that resolved the real module used to make every later
    // injected loader a no-op — which quietly turned this missing-peer test
    // into a present-peer test.
    await resolveComateCredential(contextWithSettings(() => []), { ignoreSettings: true, wpsSid: 'sid' })

    const loadMainPlugin = vi.fn(() => Promise.reject(new Error('ERR_MODULE_NOT_FOUND')))

    await expect(resolveComateCredential(contextWithSettings(() => []), {
      ignoreSettings: true,
      loadMainPlugin,
    })).rejects.toThrow('is not installed')

    expect(loadMainPlugin).toHaveBeenCalledTimes(1)
  })
})
