import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { readSessionCwd } from '../src/deliverables.ts'

function context(services: Record<string, unknown>): Context {
  return { get: (name: string) => services[name] } as unknown as Context
}

describe('DSH 0.2.1 current working directory', () => {
  const session = { header: { cwd: '/original' } }
  const agent = { session }

  it('follows directory changes between tool calls instead of the immutable header', () => {
    let directory = '/current'
    const ctx = context({ workingDirectory: { get: (owner: unknown) => {
      expect(owner).toBe(session)
      return directory
    } } })
    expect(readSessionCwd(agent, ctx)).toBe('/current')
    directory = '/changed-again'
    expect(readSessionCwd(agent, ctx)).toBe('/changed-again')
  })

  it('uses the committed directory projection when the service is not mounted', () => {
    const ctx = context({ sessionProjections: { stateOf: (_session: unknown, name: string) => name === 'workingDirectory' ? '/projected' : undefined } })
    expect(readSessionCwd(agent, ctx)).toBe('/projected')
  })

  it('retains the original-directory fallback in minimal compositions', () => {
    expect(readSessionCwd(agent, context({}))).toBe('/original')
    expect(readSessionCwd({ session: { header: {} } }, context({}))).toBeUndefined()
    expect(readSessionCwd(undefined, context({}))).toBeUndefined()
  })
})
