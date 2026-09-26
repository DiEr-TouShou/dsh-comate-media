/**
 * Cooperative deadlines for tool calls.
 *
 * `defineTool({ timeoutMs })` is DECLARATIVE ONLY — the registry never enforces
 * it (its own documentation says so, and enforcement lives in a separate
 * `dsh-tool-call-timeout-policy` wrapper this plugin does not control). A video
 * call that runs for twenty minutes therefore needs its own deadline, and the
 * only lever a tool body has is the `AbortSignal` it passes downstream.
 *
 * @module dsh-comate-media/signals
 */

/** One call's deadline: the signal to pass downstream, and whether it was the clock that fired. */
export interface Deadline {
  /**
   * Aborts when EITHER the caller cancels (user pressed stop, turn ended) OR
   * the deadline elapses.
   */
  signal: AbortSignal
  /**
   * Whether the deadline — not the caller — aborted {@link Deadline.signal}.
   *
   * This is the difference between two messages the user must be able to tell
   * apart: "you cancelled this" and "this took longer than we allow". Reading it
   * after a rejection is the only way to know which happened, because both
   * arrive as the same `AbortError`-shaped failure.
   */
  expired(): boolean
  /** The budget the deadline was built with, for the message a timeout produces. */
  readonly timeoutMs: number
}

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
export function withDeadline(caller: AbortSignal, timeoutMs: number): Deadline {
  const timer = AbortSignal.timeout(timeoutMs)
  return {
    signal: AbortSignal.any([caller, timer]),
    expired: () => timer.aborted,
    timeoutMs,
  }
}

/**
 * Render a budget the way a person reads it: milliseconds below a second, whole seconds above.
 *
 * @param timeoutMs - the budget in milliseconds.
 * @returns a short human-readable form, for example `40ms` or `25s`.
 */
export function formatBudget(timeoutMs: number): string {
  return timeoutMs >= 1_000 ? `${Math.round(timeoutMs / 1_000)}s` : `${timeoutMs}ms`
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
export async function raceDeadline<T>(
  operation: Promise<T>,
  deadline: Deadline,
  timeoutMessage: (budget: string) => string,
): Promise<T> {
  const { signal } = deadline
  let detach = (): void => undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    const fail = (): void => {
      reject(deadline.expired()
        ? new Error(timeoutMessage(formatBudget(deadline.timeoutMs)))
        : signal.reason ?? new Error('the tool call was cancelled'))
    }
    if (signal.aborted) {
      fail()
      return
    }
    signal.addEventListener('abort', fail, { once: true })
    detach = () => signal.removeEventListener('abort', fail)
  })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    // Losing the race must not leave a listener behind: a long-lived caller
    // signal would otherwise accumulate one per call.
    detach()
  }
}
