#!/usr/bin/env node
/**
 * DSH WeChat Bridge
 * =================
 * A standalone Node.js process that connects a personal WeChat account (via
 * the official iLink Bot API, wrapped by `@wechatbot/wechatbot`) to the
 * DeepSeek Harness web endpoints exposed by the `dsh-wechat-bridge` Cordis
 * plugin.
 *
 *   WeChat App  ←→  iLink API  ←→  this bridge  ←→  DSH (http://127.0.0.1:<port>)
 *
 * Flow:
 *   1. QR login (credentials persist in WECHAT_STORAGE_DIR; no re-scan after
 *      the first login unless --force).
 *   2. Every inbound WeChat message is POSTed to  POST {DSH_BASE_URL}/wxb/inbound
 *   3. The bridge long-polls             GET  {DSH_BASE_URL}/wxb/outbox?since=N
 *      and sends every returned reply back to the WeChat user via the SDK.
 *   4. Lifecycle/status events are POSTed to  POST {DSH_BASE_URL}/wxb/event
 *
 * Environment:
 *   DSH_BASE_URL        default http://127.0.0.1:3080
 *   DSH_BRIDGE_TOKEN    shared secret; must match the plugin (default "dev")
 *   WECHAT_STORAGE_DIR  credential storage directory (default ./wechat-credentials)
 *   WECHAT_ALLOW_USERS  optional comma-separated allowlist of WeChat userIds
 *                       that may talk to the bot (default: everyone)
 *   WECHAT_BOT_AGENT    UA-style bot_agent sent to the iLink API
 *
 * Flags:
 *   --force             force a fresh QR login even if credentials exist
 */
import { WeChatBot, stripMarkdown } from '@wechatbot/wechatbot'
import QRCode from 'qrcode'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Log everything to a file as well as the terminal (the plugin spawns the
// bridge with inherited stdio; a file gives us an inspectable record).
const LOG_FILE = process.env.WECHAT_LOG_FILE || './bridge.log'
const origLog = console.log
const origErr = console.error
console.log = (...a) => {
  const line = '[' + new Date().toISOString() + '] ' + a.map(String).join(' ')
  try { appendFileSync(LOG_FILE, line + '\n') } catch {}
  origLog(...a)
}
console.error = (...a) => {
  const line = '[' + new Date().toISOString() + '] ERR ' + a.map(String).join(' ')
  try { appendFileSync(LOG_FILE, line + '\n') } catch {}
  origErr(...a)
}

const DSH_BASE_URL = process.env.DSH_BASE_URL || 'http://127.0.0.1:3080'
const TOKEN = process.env.DSH_BRIDGE_TOKEN || 'dev'
const STORAGE_DIR = process.env.WECHAT_STORAGE_DIR || './wechat-credentials'
const ALLOW_USERS = (process.env.WECHAT_ALLOW_USERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const BOT_AGENT = process.env.WECHAT_BOT_AGENT || 'DSH-WeChat-Bridge/0.1'
// Media download directory — must live INSIDE the DSH workspace so the agent
// (sandboxed to workspace-write) can read the files via read_image / read.
const MEDIA_DIR = process.env.WECHAT_MEDIA_DIR
  || join(dirname(fileURLToPath(import.meta.url)), '..', 'media')

// ---------------------------------------------------------------------------
// Small HTTP helpers (Node 22 global fetch)
// ---------------------------------------------------------------------------

let lastAuthErrorAt = 0

async function postJson(path, body, { timeoutMs = 10000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(DSH_BASE_URL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (res.status === 401 && Date.now() - lastAuthErrorAt > 15000) {
      lastAuthErrorAt = Date.now()
      console.error(`[bridge] 401 from DSH at ${path} — token mismatch?`)
    }
    if (!res.ok) {
      console.error(`[bridge] POST ${path} -> HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
      return false
    }
    return true
  } catch (err) {
    console.error(`[bridge] POST ${path} failed: ${err?.message || err}`)
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** Fire an event at the DSH plugin; failures are logged and swallowed. */
function sendEvent(type, extra = {}) {
  postJson('/wxb/event', { type, ts: Date.now(), ...extra }).catch(() => {})
}

// ---------------------------------------------------------------------------
// QR code handling
// ---------------------------------------------------------------------------

/** Render the login link as a QR PNG data-URL so the web panel can show it. */
async function qrDataUrl(loginUrl) {
  try {
    return await QRCode.toDataURL(loginUrl, { width: 240, margin: 1, errorCorrectionLevel: 'M' })
  } catch (err) {
    console.error('[bridge] QR render failed:', err?.message || err)
    return null
  }
}

/** Print a scannable ASCII QR to the terminal (host installs have no panel). */
function printAsciiQr(loginUrl) {
  try {
    const art = QRCode.toString(loginUrl, { type: 'terminal', small: true })
    console.log(art)
  } catch (err) {
    console.error('[bridge] ASCII QR render failed:', err?.message || err)
  }
}

async function onQrUrl(url) {
  console.log('\n========== 微信扫码登录 ==========')
  console.log('请用手机微信扫描下方二维码（或用浏览器打开 /wxb/qr 查看大图）：')
  printAsciiQr(url)
  console.log('扫码链接（二维码无法显示时）：')
  console.log(url)
  console.log('==================================\n')
  const image = await qrDataUrl(url)
  sendEvent('qr', { url, image })
}

function onScanned() {
  console.log('[bridge] 二维码已扫描，请在手机上确认登录…')
  sendEvent('scanned')
}

function onExpired() {
  console.log('[bridge] 二维码已过期，正在获取新二维码…')
  sendEvent('qr-expired')
}

async function onVerifyCode(isRetry) {
  console.log(isRetry ? '[bridge] 配对码错误，请重新输入手机上显示的配对码' : '[bridge] 请在手机微信中输入配对码')
  sendEvent('verify-code-required', { isRetry })
  return new Promise((resolve) => {
    let out = ''
    const onData = (chunk) => {
      out += chunk.toString()
      if (out.includes('\n')) {
        process.stdin.removeListener('data', onData)
        resolve(out.trim())
      }
    }
    process.stdin.resume()
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', onData)
    setTimeout(() => {
      process.stdin.removeListener('data', onData)
      resolve('')
    }, 60000)
  })
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

const recent = new Set() // message dedupe (bridge restarts / poll retries)
const MAX_RECENT = 800

function dedupeKey(m) {
  return [m.userId, String(m.timestamp?.getTime?.() || m.timestamp || ''), m.type, m.text].join('|')
}

async function onMessage(msg) {
  const key = dedupeKey(msg)
  if (recent.has(key)) return
  recent.add(key)
  if (recent.size > MAX_RECENT) {
    const first = recent.values().next().value
    if (first !== undefined) recent.delete(first)
  }

  if (ALLOW_USERS.length && !ALLOW_USERS.includes(msg.userId)) {
    console.log(`[bridge] blocked userId=${msg.userId} (not in allowlist)`)
    return
  }

  console.log(`[bridge] inbound from ${msg.userId} [${msg.type}]: ${String(msg.text).slice(0, 80)}`)

  // Show "typing…" to the user while the agent works.
  bot.sendTyping(msg.userId).catch(() => {})

  // Download non-text media and persist it under MEDIA_DIR (inside the DSH
  // workspace) so the agent can read the file by path.
  let media = null
  if (msg.type !== 'text') {
    try {
      const downloaded = await bot.download(msg)
      if (downloaded && downloaded.data && downloaded.data.length) {
        const safeName = String(downloaded.fileName || '')
          .replace(/[^a-zA-Z0-9._-]/g, '_')
          .slice(0, 80)
        const ext = safeName.includes('.')
          ? ''
          : (downloaded.type === 'image' ? '.jpg' : downloaded.type === 'file' ? '.bin' : downloaded.type === 'voice' ? '.wav' : '.bin')
        const fname = `${Date.now()}-${Math.floor(Math.random() * 1e6)}${safeName ? '-' + safeName : ext}`
        mkdirSync(MEDIA_DIR, { recursive: true })
        const fullPath = join(MEDIA_DIR, fname)
        writeFileSync(fullPath, downloaded.data)
        media = { path: fullPath, type: downloaded.type, fileName: downloaded.fileName || fname }
        console.log(`[bridge] media saved: ${fullPath} (${downloaded.type}, ${downloaded.data.length} bytes)`)
      } else {
        console.error(`[bridge] download returned nothing for ${msg.type} from ${msg.userId}`)
      }
    } catch (err) {
      console.error(`[bridge] media download failed (${msg.type}): ${err?.message || err}`)
    }
  }

  const body = {
    msgId: key,
    userId: msg.userId,
    text: msg.text,
    type: msg.type,
    ts: Date.now(),
  }
  if (media) body.media = media

  const ok = await postJson('/wxb/inbound', body)
  if (!ok) {
    console.error(`[bridge] failed to deliver inbound message from ${msg.userId} to DSH`)
    bot.stopTyping(msg.userId).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Outbound loop: long-poll the DSH outbox and send replies to WeChat
// ---------------------------------------------------------------------------

async function outboxLoop() {
  let cursor = 0
  let consecutiveErrors = 0
  while (!stopping) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 30000)
    try {
      console.log(`[outbox] poll since=${cursor}`)
      const res = await fetch(`${DSH_BASE_URL}/wxb/outbox?since=${cursor}`, {
        headers: { Authorization: 'Bearer ' + TOKEN },
        signal: ctrl.signal,
      })
      if (!res.ok) {
        consecutiveErrors++
        console.error(`[outbox] poll HTTP ${res.status}; waiting 5s`)
        await sleep(5000)
        continue
      }
      consecutiveErrors = 0
      const data = await res.json()
      const msgs = data.messages || []
      console.log(`[outbox] got ${msgs.length} message(s), cursor=${data.cursor}`)
      for (const m of msgs) {
        console.log(`[outbox] sending to ${m.userId}: ${String(m.text).slice(0, 60)}`)
        try {
          // Light markdown cleanup so code fences / headers read well in WeChat.
          const clean = (m.text || '').replace(/```[^\n]*\n?/g, '`').replace(/^#{1,6}\s+/gm, '').trim()
          console.log(`[outbox] bot.send start (id=${m.id})`)
          await bot.send(m.userId, { text: clean || '…' })
          console.log(`[outbox] bot.send OK (id=${m.id})`)
          await bot.stopTyping(m.userId).catch(() => {})
        } catch (err) {
          console.error(`[outbox] send to ${m.userId} FAILED (id=${m.id}): ${err?.message || err}`)
        }
        if (m.id > cursor) cursor = m.id
      }
    } catch (err) {
      // Expected on the 30s timeout — the loop just continues.
      consecutiveErrors++
      if (consecutiveErrors > 6) {
        console.error(`[outbox] poll error: ${err?.message || err}`)
        consecutiveErrors = 0
        await sleep(2000)
      }
    } finally {
      clearTimeout(timer)
    }
  }
  console.log('[bridge] outbox loop stopped')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let bot
let stopping = false

async function login(force) {
  bot = new WeChatBot({
    storageDir: STORAGE_DIR,
    logLevel: 'info',
    botAgent: BOT_AGENT,
    loginCallbacks: {
      onQrUrl,
      onScanned,
      onExpired,
      onVerifyCode,
    },
  })

  bot.onMessage(onMessage)
  bot.on('poll:start', () => sendEvent('poll-start'))
  bot.on('poll:stop', () => sendEvent('poll-stop'))
  bot.on('error', (err) => {
    console.error('[bridge] bot error:', err?.message || err)
    sendEvent('bot-error', { message: String(err?.message || err).slice(0, 300) })
  })
  bot.on('session:expired', () => {
    console.error('[bridge] session expired, re-login needed')
    sendEvent('session-expired')
  })
  bot.on('session:restored', () => sendEvent('session-restored'))

  await bot.login({ force, callbacks: { onQrUrl, onScanned, onExpired, onVerifyCode } })
  sendEvent('logged-in', {
    accountId: bot.getCredentials()?.accountId || '',
    userId: bot.getCredentials()?.userId || '',
  })
  console.log('[bridge] 登录成功 ✓')
}

async function main() {
  const force = process.argv.includes('--force')

  // Tell the plugin we are alive, and keep telling it.
  sendEvent('bridge-start', { pid: process.pid })
  setInterval(() => sendEvent('heartbeat', { pid: process.pid }), 20000)

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  try {
    await login(force)
    // IMPORTANT: the SDK's start() runs the long-poll loop and only resolves
    // when the bot is stopped — run it in the background so the outbox
    // consumer loop can run in parallel.
    const startPromise = bot.start()
    startPromise.catch((err) => console.error('[bridge] poll loop error:', err?.message || err))
    outboxLoop()
    console.log('[bridge] ready. Waiting for WeChat messages…')
    // Keep the process alive until the bot is stopped (e.g. SIGTERM).
    await startPromise
  } catch (err) {
    console.error('[bridge] fatal:', err?.message || err)
    sendEvent('fatal', { message: String(err?.message || err).slice(0, 500) })
    process.exit(1)
  }
}

async function shutdown() {
  if (stopping) return
  stopping = true
  console.log('[bridge] shutting down…')
  try {
    bot?.stop()
  } catch {
    /* ignore */
  }
  sendEvent('bridge-stop')
  setTimeout(() => process.exit(0), 500)
}

main()
