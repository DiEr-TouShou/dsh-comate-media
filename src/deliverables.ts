/**
 * Declare generated files as deliverables.
 *
 * A generated video has no chat-renderable form: DSH's markdown pipeline
 * rewrites image destinations only, and the generic tool card renders text,
 * diffs, and reads — never a video player. The one first-class way to hand a
 * user a file is the `deliverables/presented` Session event, which the Web
 * client turns into an openable card. `@deepseek-ai/dsh-tool-present` owns that
 * event for the `present` tool; this module appends the same event for files
 * this plugin produced, so the user gets an "open it" affordance instead of a
 * path to copy out of a log.
 *
 * Best-effort by construction: the media is already generated and on disk by
 * the time this runs, and a deployment that mounts neither `sessionProjections`
 * nor a Session workspace must still get the file. Every read here is therefore
 * loose and every failure is swallowed — a missing deliverable card is a
 * cosmetic loss, never a reason to fail a call that already succeeded.
 *
 * @module dsh-comate-media/deliverables
 */

import type { Context } from '@deepseek-ai/cordis'

/** The event the Web client reads to show an openable deliverable. */
const DELIVERABLES_PRESENTED = 'deliverables/presented'

/** One declared file. */
export interface Deliverable {
  path: string
  description?: string
}

/** The slice of `exec.agent` this module reads. */
interface AgentLike {
  session?: SessionLike
}

/** The slice of a Session this module reads. */
interface SessionLike {
  header?: { cwd?: string }
  append?: (event: string, payload: unknown) => void
}

/** The slice of `ctx.sessionProjections` this module reads. */
interface SessionProjectionsLike {
  stateOf?: (session: unknown, name: string) => { lastTurn?: number; openTurnStartSeq?: number | null } | undefined
}

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
export function readSessionCwd(agent: unknown): string | undefined {
  const session = (agent as AgentLike | undefined)?.session
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
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
export function publishDeliverables(
  ctx: Context,
  agent: unknown,
  callId: string,
  files: readonly Deliverable[],
): boolean {
  if (files.length === 0) return false
  try {
    const session = (agent as AgentLike | undefined)?.session
    if (session?.append === undefined) return false
    const projections = ctx.get('sessionProjections') as SessionProjectionsLike | undefined
    const boundary = projections?.stateOf?.(session, 'turnBoundary')
    if (boundary === undefined) return false
    const turn = boundary.lastTurn
    if (turn === undefined || boundary.openTurnStartSeq === null || boundary.openTurnStartSeq === undefined) return false
    session.append(DELIVERABLES_PRESENTED, {
      turn,
      callId,
      files: files.map((file) => ({ ...file })),
    })
    return true
  } catch {
    // See the module note: the artifact exists and its path is already in the
    // tool result, so a failed card declaration must not fail the call.
    return false
  }
}
