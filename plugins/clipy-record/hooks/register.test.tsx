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
