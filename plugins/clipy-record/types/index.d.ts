export type RecordPhase = 'idle' | 'starting' | 'recording' | 'stopping' | 'waiting'

/** A cloud session's wait for a recording made on the person's own computer. */
export type CloudWait = {
  /** The newest recording when Record was pressed: anything newer is the one to send. */
  baselineId: string | null
  baselineAt: string | null
  /** The server's time when Record was pressed (ISO): anything created before it is not the one. */
  since?: string | null
  /** The new recording, once it shows up in the library. */
  id: string | null
  /** When the new recording finished uploading, ms on the session clock. */
  uploadedAt: number | null
}

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
  /** Set while a cloud session waits for a recording; absent in a local one. */
  cloud?: CloudWait | null
}

declare module 'claude-code' {
  interface PluginState {
    'clipy-record': { state: RecordState; elapsed: number; hidden: boolean }
  }
}
