import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { clock as format, splitCommand } from './register'

const BAND = {
  plugin: 'clipy-record',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const

type Out = { exitCode: number; stdout: string; stderr: string }
type Cli = { version?: string | null; start?: Out | 'throw'; stop?: Out | 'throw'; abort?: 'throw'; status?: string }

const ran = (o: Out) => ({ value: { ...o, isStdoutTruncated: false, isStderrTruncated: false } })

/** The host beneath the mod: a Mac, a data folder, and a clipy that answers as told. */
function host(on: On, cli: Cli, platform: 'macos' | 'linux' = 'macos') {
  const calls: string[][] = []
  const prompts: string[] = []
  const clock = mock.clock(on)
  // Paths Clipy trashed: a cancel in the app removes the take's folder.
  const gone: string[] = []
  on('fs.stat', (_, e) =>
    gone.some(g => e.path.startsWith(g))
      ? { deny: 'missing' }
      : { value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } },
  )
  on('session.info', () => ({ value: { platform, isHosted: false, transcriptPath: '/t.jsonl' } }))
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/data/clipy-record' } }))
  on('process.run', (_, e) => {
    calls.push([...e.argv])
    const args = e.argv.join(' ')
    if (args.includes('--version')) {
      if (cli.version == null) return { deny: 'not found' }
      return ran({ exitCode: 0, stdout: `${cli.version}\n`, stderr: '' })
    }
    if (args.includes('session start')) {
      if (cli.start === 'throw') return { deny: 'could not launch' }
      return ran(cli.start ?? { exitCode: 0, stdout: '{"state":"recording"}', stderr: '' })
    }
    if (args.includes('session abort') && cli.abort === 'throw') return { deny: 'could not launch' }
    if (args.includes('session status')) {
      return ran({ exitCode: 0, stdout: `{"state":"${cli.status ?? 'recording'}"}`, stderr: '' })
    }
    if (args.includes('session stop')) {
      if (cli.stop === 'throw') return { deny: 'timed out' }
      return ran(
        cli.stop ?? {
          exitCode: 0,
          stdout: '{"arec":"/recordings/take/recording.arec","state":"stopped"}',
          stderr: '',
        },
      )
    }
    return ran({ exitCode: 0, stdout: '{}', stderr: '' })
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  return { calls, prompts, clock, gone }
}

test('record, watch the timer, stop and hand the AREC to Claude', async ($, on) => {
  const { calls, prompts, clock } = host(on, { version: '0.20.0' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'record' })

    const start = calls.find(c => c.includes('start'))
    expect(start).toEqual(expect.arrayContaining(['--local', '--source', 'mac-screen', '--mic', '--max', '600']))
    expect((await ui.find({ type: 'Text', text: /0:00/ }))?.text).toContain('0:00')
    expect(await ui.find({ key: 'stop' })).toBeDefined()

    await clock.advance(5_000)
    expect((await ui.find({ type: 'Text', text: /0:05/ }))?.text).toContain('0:05')

    await ui.press({ key: 'stop' })
    expect(prompts.at(-1)).toContain('/recordings/take/recording.arec')
    expect(await ui.find({ key: 'record' })).toBeDefined()
    await ui.unmount()
    calls.length = 0
  }
})

test('the desktop draws the Clipy mark beside the button; the terminal keeps the dot', async ($, on) => {
  host(on, { version: '0.20.0' })
  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(JSON.stringify(await desktop.findAll({}))).toContain('"type":"Svg"')
  expect((await desktop.find({ key: 'record' }))?.text).toBe('Record with Clipy')
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(JSON.stringify(await terminal.findAll({}))).not.toContain('"type":"Svg"')
  expect((await terminal.find({ key: 'record' }))?.text).toBe('● Record with Clipy')
  await terminal.unmount()
})

test('cancel throws the take away and says nothing to Claude', async ($, on) => {
  const { calls, prompts } = host(on, { version: '0.20.0' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  await ui.press({ key: 'cancel' })

  expect(calls.some(c => c.includes('abort'))).toBe(true)
  expect(prompts).toEqual([])
  expect(await ui.find({ key: 'record' })).toBeDefined()
  await ui.unmount()
})

test("the CLI's error and an update hint show in the band", async ($, on) => {
  host(on, {
    version: '0.19.0',
    start: {
      exitCode: 1,
      stdout: '',
      stderr: 'error: The Clipy app (v1.1.84) is running but cannot keep a recording on this computer.\n',
    },
  })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'record' })

    expect((await ui.find({ type: 'Text', text: /cannot keep a recording/ }))?.text).toContain('v1.1.84')
    expect((await ui.find({ type: 'Text', text: /npm i -g @clipy\/cli@latest/ }))?.text).toContain('0.20.0')
    await ui.unmount()
  }
})

test('a CLI too old to record locally is named before trying', async ($, on) => {
  const { calls } = host(on, { version: '0.13.1' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })

  expect((await ui.find({ type: 'Text', text: /too old/ }))?.text).toContain('0.13.1')
  expect(calls.some(c => c.includes('start'))).toBe(false)
  await ui.unmount()
})

test('no CLI at all says how to install it', async ($, on) => {
  host(on, { version: null })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })

  expect(await ui.find({ type: 'Text', text: /isn't installed/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /npm i -g @clipy\/cli/ })).toBeDefined()
  await ui.unmount()
})

test('a configured command runs instead of clipy', { options: { clipyCommand: 'node /cli/dist/index.js' } }, async ($, on) => {
  const { calls } = host(on, { version: '0.19.0' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })

  expect(calls[0]?.slice(0, 2)).toEqual(['node', '/cli/dist/index.js'])
  expect(await ui.find({ key: 'stop' })).toBeDefined()
  await ui.unmount()
})

test('no band where Clipy cannot record', async ($, on) => {
  host(on, { version: '0.20.0' }, 'linux')
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect(await ui.find({ key: 'record' })).toBeUndefined()
  await ui.unmount()
})

test('a take stopped in the Clipy app still reaches Claude', async ($, on) => {
  const arec = '/recordings/take/recording.arec'
  const cli: Cli = {
    version: '0.20.0',
    start: { exitCode: 0, stdout: `{"state":"recording","local":true,"arec":"${arec}"}`, stderr: '' },
  }
  const { calls, prompts, clock } = host(on, cli)
  let stage = 'transcribing'
  on('fs.read', (_, e) => {
    expect(e.path).toBe('/recordings/take/status.json')
    return { value: JSON.stringify({ stage }) }
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  await clock.advance(3000)
  expect(await ui.find({ key: 'stop' })).toBeDefined()

  cli.status = 'ended'
  await clock.advance(3000)
  expect(await ui.find({ type: 'Text', text: /building the recording/ })).toBeDefined()
  expect(calls.some(c => c.includes('abort'))).toBe(true)
  expect(prompts).toEqual([])

  stage = 'ready'
  await clock.advance(2000)
  expect(prompts.at(-1)).toContain(arec)
  expect(prompts.at(-1)).toContain('stopped it in the Clipy app')
  expect(await ui.find({ key: 'record' })).toBeDefined()
  await ui.unmount()
})

test('Hide tucks the band away across sessions and /record-button brings it back', async ($, on) => {
  host(on, { version: '0.20.0' })
  mock.store(on)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'record' })).toBeDefined()
    await ui.press({ key: 'hide' })
    expect(await ui.find({ key: 'record' })).toBeUndefined()
    await ui.unmount()

    // A new session remembers.
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const again = await $.ui.mount({ ...BAND, surface })
    expect(await again.find({ key: 'record' })).toBeUndefined()

    const shown = await $.command.run({ command: 'record-button' } as never)
    expect(JSON.stringify(shown)).toContain('back above the prompt')
    expect(await again.find({ key: 'record' })).toBeDefined()
    await again.unmount()
  }
})

test('with no Clipy app running, the band says where to get it', async ($, on) => {
  host(on, {
    version: '0.20.0',
    start: {
      exitCode: 1,
      stdout: '',
      stderr: 'error: Neither the Clipy app nor Clipy Local is running. Open Clipy (or install it from https://clipy.online/download) and try again.\n',
    },
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })

  expect((await ui.find({ type: 'Text', text: /utm_source=claude-code/ }))?.text).toContain('Clipy Local')
  await ui.unmount()
})

test('a take stopped in the app on Windows reads the status beside its AREC', async ($, on) => {
  const arec = 'C:\\Clipy\\take\\recording.arec'
  const cli: Cli = {
    version: '0.20.0',
    start: { exitCode: 0, stdout: JSON.stringify({ state: 'recording', arec }), stderr: '' },
    status: 'ended',
  }
  const { prompts, clock } = host(on, cli)
  const read: string[] = []
  on('fs.read', (_, e) => {
    read.push(e.path)
    return { value: JSON.stringify({ stage: 'ready' }) }
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  await clock.advance(3000)

  expect(read[0]).toEndWith('C:\\Clipy\\take\\status.json')
  expect(prompts.at(-1)).toContain(arec)
  await ui.unmount()
})

test('a take whose processing failed still reaches Claude as a Partial AREC', async ($, on) => {
  const arec = '/recordings/take/recording.arec'
  const { prompts } = host(on, {
    version: '0.20.0',
    stop: {
      exitCode: 1,
      stdout: JSON.stringify({ ok: false, local: true, status: 'failed', arec, message: 'Partial: processing failed.' }),
      stderr: '',
    },
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  await ui.press({ key: 'stop' })

  expect(prompts.at(-1)).toContain(arec)
  expect(await ui.find({ type: 'Text', text: /Partial/ })).toBeUndefined()
  await ui.unmount()
})

test('a take cancelled in the Clipy app sends nothing to Claude', async ($, on) => {
  const arec = '/recordings/take/recording.arec'
  const cli: Cli = {
    version: '0.20.0',
    start: { exitCode: 0, stdout: JSON.stringify({ state: 'recording', arec }), stderr: '' },
  }
  const { prompts, clock, gone } = host(on, cli)
  on('fs.read', () => ({ deny: 'missing' }))
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })

  cli.status = 'ended'
  gone.push('/recordings/take')
  await clock.advance(3000)

  expect(prompts).toEqual([])
  expect(await ui.find({ key: 'record' })).toBeDefined()
  expect(await ui.find({ key: 'record' })).toBeDefined()
  await ui.unmount()
})

test('the timer reads minutes and seconds', () => {
  expect(format(5)).toBe('0:05')
  expect(format(65)).toBe('1:05')
  expect(format(600)).toBe('10:00')
})

test('a CLI that cannot run leaves the band usable', async ($, on) => {
  const cli: Cli = { version: '0.20.0', start: 'throw' }
  host(on, cli)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  expect(await ui.find({ type: 'Text', text: /did not run/ })).toBeDefined()
  expect(await ui.find({ key: 'record' })).toBeDefined()

  // A stop that fails while the app still records brings Stop and Cancel back.
  cli.start = undefined
  cli.stop = 'throw'
  await ui.press({ key: 'record' })
  await ui.press({ key: 'stop' })
  expect(await ui.find({ type: 'Text', text: /did not run/ })).toBeDefined()
  expect(await ui.find({ key: 'stop' })).toBeDefined()
  expect(await ui.find({ key: 'cancel' })).toBeDefined()
  await ui.unmount()
})

test('a cancel that cannot run keeps Stop and Cancel while Clipy records', async ($, on) => {
  const cli: Cli = { version: '0.20.0', abort: 'throw' }
  const { prompts } = host(on, cli)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  await ui.press({ key: 'cancel' })

  expect(await ui.find({ type: 'Text', text: /could not cancel/ })).toBeDefined()
  expect(await ui.find({ key: 'stop' })).toBeDefined()
  expect(await ui.find({ key: 'record' })).toBeUndefined()
  expect(prompts).toEqual([])
  await ui.unmount()
})

test('a configured command keeps quoted paths with spaces together', () => {
  expect(splitCommand('node "D:\\Clipy Tools\\cli\\index.js"')).toEqual(['node', 'D:\\Clipy Tools\\cli\\index.js'])
  expect(splitCommand("  /usr/bin/node '/opt/Clipy Tools/cli.js'  ")).toEqual(['/usr/bin/node', '/opt/Clipy Tools/cli.js'])
  expect(splitCommand('clipy')).toEqual(['clipy'])
  expect(splitCommand('node ""')).toEqual(['node', ''])
})

test('upgrading the CLI after a too-old message works on the next press', async ($, on) => {
  const cli: Cli = { version: '0.13.1' }
  host(on, cli)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  expect(await ui.find({ type: 'Text', text: /too old/ })).toBeDefined()

  cli.version = '0.20.0'
  await ui.press({ key: 'record' })
  expect(await ui.find({ key: 'stop' })).toBeDefined()
  await ui.unmount()
})

type Rec = { id: string; createdAt: string; stage: string; agentReadiness: string }

/** A cloud session: Linux off the person's computer, a Clipy library read over the API. */
type Answer = { status: number; text?: string } | 'hang'

function cloudHost(
  on: On,
  env: Record<string, string> = { CLAUDE_CODE_REMOTE: 'true', CLIPY_API_KEY: 'clipy_test_key' },
  isHosted = false,
) {
  const library: Rec[] = [{ id: 'old1', createdAt: '2026-11-27T09:00:00.000Z', stage: 'ready', agentReadiness: 'complete' }]
  const prompts: string[] = []
  const runs: string[][] = []
  const auth: string[] = []
  const clock = mock.clock(on)
  mock.env(on, env)
  // The next answers the API gives, in order; empty means the library as it stands.
  const answers: Answer[] = []
  on('session.info', () => ({ value: { platform: 'linux' as const, isHosted, transcriptPath: '/t.jsonl' } }))
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/data/clipy-record' } }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { deny: 'no Clipy app in a cloud session' }
  })
  on('http.fetch', (_, e) => {
    auth.push(String((e.init?.headers as Record<string, string> | undefined)?.Authorization ?? ''))
    const answer = answers.shift()
    if (answer === 'hang') return new Promise<never>(() => {})
    const status = answer?.status ?? 200
    const text = answer?.text ?? JSON.stringify({ recordings: library.slice(0, 1) })
    // The server's clock when Record is pressed: 09:30, after the old take and before the new ones.
    return { value: { status, ok: status < 300, headers: { date: 'Fri, 27 Nov 2026 09:30:00 GMT' }, text } }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  const add = (r: Rec) => library.unshift(r)
  return { library, prompts, runs, auth, clock, add, answers, toasts }
}

test('a local session draws the dark Local band; a cloud session the orange Cloud band', async ($, on) => {
  host(on, { version: '0.20.0' })
  const local = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const drawn = JSON.stringify(await local.findAll({}))
  expect(drawn).toContain('#18181B')
  expect(drawn).toContain(' Local ')
  expect(drawn).not.toContain(' Cloud ')
  await local.unmount()
})

test('the cloud band is orange and says Cloud', async ($, on) => {
  cloudHost(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const drawn = JSON.stringify(await ui.findAll({}))
    expect(drawn).toContain('#FF4D29')
    expect(drawn).toContain(' Cloud ')
    expect(await ui.find({ key: 'record' })).toBeDefined()
    await ui.unmount()
  }
})

test('cloud: record on the computer, and Claude gets the new recording once it is readable', async ($, on) => {
  const { prompts, runs, auth, clock, add, library } = cloudHost(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })

  expect(await ui.find({ key: 'send' })).toBeDefined()
  expect(JSON.stringify(await ui.findAll({}))).toContain('https://clipy.online/videos')
  expect(auth[0]).toBe('Bearer clipy_test_key')

  // Still recording in Clipy: nothing is sent.
  add({ id: 'new1', createdAt: '2026-11-27T10:00:00.000Z', stage: 'uploading', agentReadiness: 'preparing' })
  await clock.advance(10_000)
  expect(prompts).toEqual([])
  expect((await ui.find({ type: 'Text', text: /Clipy is recording/ }))?.text).toBeDefined()

  // Transcript and summary in: sent, and the band is back to Record.
  library[0] = { ...library[0]!, stage: 'annotating', agentReadiness: 'usable' }
  await clock.advance(5_000)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('https://clipy.online/video/new1.arec')
  expect(prompts[0]).not.toContain('old1')
  expect(await ui.find({ key: 'record' })).toBeDefined()
  // A cloud session never runs the Clipy CLI.
  expect(runs).toEqual([])
  await ui.unmount()
})

test('cloud: a recording still preparing after three minutes is sent anyway', async ($, on) => {
  const { prompts, clock, add } = cloudHost(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'record' })
  add({ id: 'slow1', createdAt: '2026-11-27T10:00:00.000Z', stage: 'transcribing', agentReadiness: 'preparing' })
  await clock.advance(60_000)
  expect(prompts).toEqual([])
  await clock.advance(180_000)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('slow1')
  await ui.unmount()
})

test('cloud: Send now with nothing new keeps waiting; Cancel sends nothing', async ($, on) => {
  const { prompts } = cloudHost(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  await ui.press({ key: 'send' })
  expect(prompts).toEqual([])
  expect(await ui.find({ key: 'send' })).toBeDefined()
  await ui.press({ key: 'cancel' })
  expect(prompts).toEqual([])
  expect(await ui.find({ key: 'record' })).toBeDefined()
  await ui.unmount()
})

test('cloud: Send now sends a recording that is still preparing', async ($, on) => {
  const { prompts, add } = cloudHost(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  add({ id: 'prep1', createdAt: '2026-11-27T10:00:00.000Z', stage: 'transcoding', agentReadiness: 'preparing' })
  await ui.press({ key: 'send' })
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('prep1')
  await ui.unmount()
})

test('cloud with no CLIPY_API_KEY says where to get one', async ($, on) => {
  const { prompts } = cloudHost(on, { CLAUDE_CODE_REMOTE: 'true' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(JSON.stringify(await ui.findAll({}))).toContain('https://clipy.online/settings/api-keys')
  await ui.press({ key: 'record' })
  expect((await ui.find({ type: 'Text', text: /CLIPY_API_KEY/ }))?.text).toBeDefined()
  expect(await ui.find({ key: 'record' })).toBeDefined()
  expect(prompts).toEqual([])
  await ui.unmount()
})

test('a hosted session counts as cloud with no CLAUDE_CODE_REMOTE', async ($, on) => {
  cloudHost(on, { CLIPY_API_KEY: 'clipy_test_key' }, true)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(JSON.stringify(await ui.findAll({}))).toContain(' Cloud ')
  await ui.unmount()
})

test('cloud: a refused key says so and keeps the band usable', async ($, on) => {
  const { answers, prompts } = cloudHost(on)
  answers.push({ status: 401, text: '{"error":"Invalid API key"}' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  expect((await ui.find({ type: 'Text', text: /refused the CLIPY_API_KEY/ }))?.text).toBeDefined()
  expect(await ui.find({ key: 'record' })).toBeDefined()
  expect(prompts).toEqual([])
  await ui.unmount()
})

test('cloud: a request that never answers stops holding the band, and a later check sends', async ($, on) => {
  const { answers, prompts, clock, add, toasts } = cloudHost(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  answers.push('hang')
  await clock.advance(5_000)
  // The hung check holds the library read: Send now says so rather than doing nothing.
  await ui.press({ key: 'send' })
  expect(toasts.at(-1)).toContain('Still checking')
  expect(prompts).toEqual([])
  add({ id: 'late1', createdAt: '2026-11-27T10:00:00.000Z', stage: 'ready', agentReadiness: 'complete' })
  // Checks keep backing off while the stalled one is fresh, then go ahead without it.
  await clock.advance(10_000)
  expect(prompts).toEqual([])
  await clock.advance(15_000)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('late1')
  await ui.unmount()
})

test('cloud: nothing new in 30 minutes ends the wait without sending', async ($, on) => {
  const { prompts, clock } = cloudHost(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'record' })
  await clock.advance(30 * 60_000 + 2_000)
  expect((await ui.find({ type: 'Text', text: /30 minutes/ }))?.text).toBeDefined()
  expect(await ui.find({ key: 'record' })).toBeDefined()
  expect(prompts).toEqual([])
  await ui.unmount()
})

test('cloud: a check from a cancelled wait never sends into the next one', async ($, on) => {
  const { answers, prompts, clock, add } = cloudHost(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  // This check stalls; the person cancels and records again before it gives up.
  answers.push('hang')
  await clock.advance(5_000)
  await ui.press({ key: 'cancel' })
  await clock.advance(1_000)
  await ui.press({ key: 'record' })
  add({ id: 'fresh1', createdAt: '2026-11-27T10:00:00.000Z', stage: 'ready', agentReadiness: 'complete' })
  await clock.advance(15_000)
  // Only the new wait's own check sends, and only once.
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('fresh1')
  await ui.unmount()
})

test('cloud: a first lookup that stalls can be cancelled, and its late answer changes nothing', async ($, on) => {
  const { answers, prompts, clock } = cloudHost(on)
  answers.push('hang')
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // The press never settles while its lookup hangs, so it is not awaited.
  void ui.press({ key: 'record' })
  await clock.advance(100)
  expect((await ui.find({ type: 'Text', text: /Checking your Clipy library/ }))?.text).toBeDefined()
  await ui.press({ key: 'cancel' })
  expect(await ui.find({ key: 'record' })).toBeDefined()
  // Record again works, with the stalled start left behind.
  await ui.press({ key: 'record' })
  expect(await ui.find({ key: 'send' })).toBeDefined()
  await clock.advance(10_000)
  expect(prompts).toEqual([])
  await ui.unmount()
})

test('cloud: a take still uploading when Record was pressed is not sent as the new one', async ($, on) => {
  const { prompts, clock, add } = cloudHost(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'record' })
  // Started at 09:15, before the press, and only listed once it plays.
  add({ id: 'earlier1', createdAt: '2026-11-27T09:15:00.000Z', stage: 'ready', agentReadiness: 'complete' })
  await clock.advance(10_000)
  expect(prompts).toEqual([])
  add({ id: 'mine1', createdAt: '2026-11-27T09:31:00.000Z', stage: 'ready', agentReadiness: 'complete' })
  await clock.advance(5_000)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('mine1')
  await ui.unmount()
})
