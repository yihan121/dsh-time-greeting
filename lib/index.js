// dsh-time-greeting — Host half.
//
// Every step, append one short note to the step's message list: what time it is,
// how long the silence was, and the rule for when a greeting is welcome.
//
// WHY EVERY STEP
//   A continuous clock is the point. Injecting only on a trigger would leave the
//   agent blind in between, and the trigger itself would have to be a pair of
//   numeric thresholds — which cannot tell an eight-hour night from a three-hour
//   meeting. Supplying the facts every step moves the judgement to where the
//   context is. The cost is roughly 0.2k tokens per step; the requirement text is
//   repeated each time so the agent never has to have kept it.
//
// THE REQUIREMENT IS DATA, NOT A VERDICT
//   The note states the rule and the numbers, then stops. It never says "greet
//   now" or "stay quiet" — that call belongs to whoever can see how the user
//   actually sounds.
//
// WHY THIS PLUGIN HAS ALMOST NO IMPORTS
//   `@deepseek-ai/dsh-llm` provides `createUserMessage`, but a profile plugin
//   cannot resolve it: the profile's `node_modules/@deepseek-ai` holds only
//   `cosmokit` and `schemastery`, and Node's lookup from here walks up to `C:\`
//   and stops. A static import of an unresolvable package fails the whole module
//   at evaluation time, which takes the profile's boot with it. The message is
//   therefore built by hand, in the shape `createUserMessage` returns:
//   `{ content, source, role, id }`.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID, randomBytes } from 'node:crypto'
import z from '@deepseek-ai/schemastery'

/** Package name the loader mounts this row as. */
export const name = 'dsh-time-greeting'

/** This entry's Host configuration schema. */
export const Config = z.object({
  /** Minimum silence, in minutes, for a greeting to be welcome. */
  minGapMinutes: z.number().min(1).default(45),
  /** Off means the plugin is completely silent — no note, no tokens. */
  enabled: z.boolean().default(true),
  /**
   * Test mode: skip the silence check and put a random marker in the note, so a
   * reader can prove the injection actually arrived instead of inferring it.
   */
  testMode: z.boolean().default(false),
  /** Where the last-activity stamp lives. Empty means `<dsh home>/time-greeting.json`. */
  statePath: z.string().default(''),
})

/** The part of the day, in the order a day passes through them. */
function bandOf(date) {
  const hour = date.getHours()
  if (hour < 5) return '凌晨'
  if (hour < 11) return '早上'
  if (hour < 14) return '中午'
  if (hour < 18) return '下午'
  if (hour < 23) return '晚上'
  return '深夜'
}

/** `2026-10-16 08:24` — local time, no seconds; the gap carries those. */
function stamp(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Calendar day as `2026-10-16`, for telling "later the same day" from "tomorrow". */
function dayKey(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** `9 小时 20 分` — the largest two units, which is all a greeting needs. */
function humanGap(ms) {
  const minutes = Math.round(ms / 60000)
  if (minutes < 60) return `${String(minutes)} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 24) {
    return rest === 0 ? `${String(hours)} 小时` : `${String(hours)} 小时 ${String(rest)} 分`
  }
  const days = Math.floor(hours / 24)
  const leftHours = hours % 24
  return leftHours === 0
    ? `${String(days)} 天`
    : `${String(days)} 天 ${String(leftHours)} 小时`
}

/** Read one config field, whether it arrives as a live reference or a plain value. */
function read(config, key) {
  const value = config?.[key]
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get()
    : value
}

/**
 * Mount the time-awareness subscriber.
 * @param ctx - Host plugin context.
 * @param config - applied config, already validated against `Config` when the
 *   schema package resolved.
 */
export function apply(ctx, config) {
  const minGapMinutes = (() => {
    const v = read(config, 'minGapMinutes')
    return typeof v === 'number' && v > 0 ? v : 45
  })()
  const configuredPath = read(config, 'statePath')
  const statePath = typeof configuredPath === 'string' && configuredPath !== ''
    ? configuredPath
    : join(homedir(), '.dsh', 'time-greeting.json')

  let lastSeen = null
  let loaded = false
  let writing = null

  async function load() {
    if (loaded) return
    loaded = true
    try {
      const parsed = JSON.parse(await readFile(statePath, 'utf8'))
      if (typeof parsed?.lastSeen === 'number' && Number.isFinite(parsed.lastSeen)) {
        lastSeen = parsed.lastSeen
      }
    } catch {
      // ENOENT on the first run, or an unreadable file: no previous stamp, so
      // the note simply reports that it does not know.
    }
  }

  /** Serialized write, so two overlapping steps cannot interleave. */
  function save(at) {
    writing = (writing ?? Promise.resolve())
      .then(async () => {
        await mkdir(dirname(statePath), { recursive: true })
        await writeFile(statePath, JSON.stringify({ lastSeen: at }), 'utf8')
      })
      .catch((error) => {
        ctx.logger?.warn?.(`time-greeting: cannot write ${statePath}: ${String(error)}`)
      })
    return writing
  }

  /**
   * Compose the note.
   *
   * Two halves: the facts, then the rule. The rule is restated every step rather
   * than stated once, so that the agent never depends on having kept it.
   */
  function composeNote(nowMs, previousMs, testNonce) {
    const now = new Date(nowMs)
    const lines = [`[时间] 现在是 ${stamp(now)}（${bandOf(now)}）。`]

    if (previousMs === null) {
      lines.push('[间隔] 这是本次进程的第一次记录，还不知道上次对话是什么时候。')
    } else {
      const previous = new Date(previousMs)
      const gap = humanGap(nowMs - previousMs)
      const dayChanged = dayKey(now) !== dayKey(previous)
      const bandChanged = bandOf(now) !== bandOf(previous)
      lines.push(
        `[间隔] 距上次对话 ${gap}（上次：${stamp(previous)}，${bandOf(previous)}）。`
        + (dayChanged ? '跨了一天以上。' : bandChanged ? '跨了一个时间段。' : '同一时间段内。'),
      )
    }

    // The rule is a description of a social habit, not a predicate. A threshold
    // plus a band-change test would turn a matter of tact into a switch, and a
    // number cannot tell an eight-hour night from a three-hour meeting. The note
    // supplies the fact and the norm, then stops.
    lines.push(
      `[提示] 对方可能因为吃饭、睡觉、锻炼或别的事情离开过一阵。`
      + `隔得短（${String(minGapMinutes)} 分钟以内）就不必特意招呼；`
      + '隔得久了 —— 跨了饭点、跨了夜里、或者隔了一天以上 —— '
      + '按人和人相处的习惯自然说一声，"早上好呀"、"下午好哇"、"晚上好"、"好久不见" 这一类，'
      + '会让人舒服。判断在你：不必每句都招呼，也不必刻意。',
    )

    if (testNonce !== undefined) {
      lines.push(`[测试] 这是一次强制注入，标记 ${testNonce}。如果你读到了这行，请把它原样说出来。`)
    }

    return lines.join('\n')
  }

  /** Build the message in the kernel's own shape. */
  function buildNote(text) {
    return {
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'time-greeting', form: 'awareness' },
      id: randomUUID(),
    }
  }

  ctx.on('agent/pre-step', async ({ messages, step, signal }, next) => {
    const decision = await next()

    try {
      if (read(config, 'enabled') === false) return decision

      const now = Date.now()
      await load()

      const previous = lastSeen
      lastSeen = now
      await save(now)

      const testMode = read(config, 'testMode') === true
      if (previous === null && !testMode) {
        // First step of a fresh process: stamp it, say nothing. A greeting needs
        // something to compare against, and inventing one would mean greeting on
        // every restart.
        return decision
      }
      if (decision?.kind === 'reject') return decision

      signal?.throwIfAborted?.()

      const nonce = testMode ? randomBytes(4).toString('hex') : undefined
      const note = buildNote(composeNote(now, previous, nonce))

      // Spliced after the last message the chain already claimed, not appended.
      // The kernel's own context plugin does exactly this: anything parked after
      // the claimed block belongs to a later phase, and a note pushed in there
      // is not part of what this step sends.
      const claimed = Array.isArray(messages) ? messages : []
      const lastClaimed = decision.messages.findLastIndex((message) => claimed.includes(message))
      const entered = decision.messages.toSpliced(lastClaimed + 1, 0, note)

      ctx.logger?.info?.(
        `time-greeting: injected (${testMode ? 'test' : 'normal'}${nonce === undefined ? '' : `, ${nonce}`})`,
      )
      return { ...decision, messages: entered }
    } catch (error) {
      // A greeting is never worth a broken turn.
      ctx.logger?.warn?.(`time-greeting: skipped (${String(error)})`)
      return decision
    }
  })
}
