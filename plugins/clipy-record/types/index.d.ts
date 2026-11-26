export type RecordPhase = 'idle' | 'starting' | 'recording' | 'stopping'

export type RecordState = {
  phase: RecordPhase
  /** When the recording started, ms on the session clock. */
  startedAt: number | null
  /** Where the take's AREC will be, from session start, so a stop in the app still reaches Claude. */
  arec: string | null
  /** The last failure, shown in the band until the next press. */
  error: string | null
  /** What to do about it (update the CLI, open the app), shown under the error. */
  hint: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'clipy-record': { state: RecordState; elapsed: number; hidden: boolean }
  }
}
