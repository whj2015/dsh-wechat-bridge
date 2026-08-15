/**
 * DSH WeChat Bridge — installable host-composition plugin
 * ======================================================
 * A Cordis plugin that connects a personal WeChat account (official iLink
 * protocol) to DeepSeek Harness. Runs the companion `bridge/` process,
 * exposes /wxb/* HTTP endpoints on the DSH web server, drives per-user DSH
 * agents, and attaches WeChat sessions to a dedicated "WeChat" workspace.
 *
 * Install (see README.md in this package):
 *   1. Copy this directory into the DSH profile directory
 *      (~/.dsh/profiles/web/ by default).
 *   2. Append to cordis.patch.yml:
 *        - insert:
 *            - id: dsh-wechat-bridge
 *              name: ./dsh-wechat-bridge/index.js
 *              config: {}   # optional overrides below
 *   3. Restart `dsh web`. Scan the QR shown in the Run panel / terminal.
 *
 * Config (all optional):
 *   bridgeDir      - directory containing bridge.js + node_modules
 *                    (default: ./bridge inside this package)
 *   wechatWsPath   - path of the "WeChat" GUI workspace; also the agents' cwd
 *                    (default: this package directory)
 *   secret         - shared token for /wxb/* endpoints
 *                    (default: dsh-wechat-bridge-local-token; loopback only)
 *   preset         - agent preset mounted for WeChat agents (default: cordis)
 *   approvalPolicy - 'never' | 'ask' (default: never — phone cannot click)
 *   base           - URL prefix for the bridge endpoints (default: /wxb)
 *   workspaceTitle - GUI workspace title (default: WeChat)
 */
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = fileURLToPath(new URL('.', import.meta.url))

export default {
  inject: ['webServer', 'agents', 'timer'],
  async apply(ctx, config) {
    const cfg = config || {}
    const ws = ctx.get('webServer')
    const agentsSvc = ctx.get('agents')
    const sub = ctx.get('subprocess')
    const fsSvc = ctx.get('fs')
    if (!ws || !agentsSvc) {
      console.error('[wechat] webServer/agents service missing, abort')
      return
    }

    const BRIDGE_DIR = cfg.bridgeDir || (PACKAGE_DIR + 'bridge')
    const WECHAT_WS_PATH = cfg.wechatWsPath || PACKAGE_DIR.slice(0, -1)
    const WS_TITLE = cfg.workspaceTitle || 'WeChat'
    const PRESET = cfg.preset || 'cordis'
    const SECRET = cfg.secret || 'dsh-wechat-bridge-local-token'
    const BASE = cfg.base || '/wxb'
    const APPROVAL_POLICY = cfg.approvalPolicy || 'never'
    const GEN_FILE = BRIDGE_DIR + '/wechat-gen.json'

    const state = {
      phase: 'idle',
      detail: '插件已加载，等待 bridge 进程连接',
      qrRev: 0,
      qrState: 'none',
      qrImage: null,
      qrUrl: null,
      bridgeAlive: false,
      bridgePid: null,
      lastHeartbeat: 0,
      since: Date.now(),
    }
    const outbox = []
    let outboxCursor = 0
    const outboxWaiters = new Set()
    const userAgents = new Map()
    const retiredHandles = new Map()
    const creating = new Map()
    const recentMsgs = new Map()
    const userGen = new Map()
    const routeDisposers = []
    let bridgeProc = null
    let stopping = false

    // ---------------- WeChat workspace (GUI grouping) -----------------------
    const wsReg = ctx.get('workspaceRegistry')
    let wechatWs = null
    const ensureWechatWorkspace = async () => {
      if (!wsReg) return null
      try {
        const existing = wsReg.list().find((w) => w.path === WECHAT_WS_PATH)
        if (existing) { wechatWs = existing; return existing }
        wechatWs = await wsReg.create(WECHAT_WS_PATH, WS_TITLE)
        console.log('[wechat] created ' + WS_TITLE + ' workspace at ' + WECHAT_WS_PATH)
        return wechatWs
      } catch (e) {
        console.error('[wechat] ensure workspace failed:', e)
        return null
      }
    }
    const attachToWechatWorkspace = async (sessionId) => {
      try {
        if (!wechatWs) await ensureWechatWorkspace()
        if (wechatWs && !wechatWs.sessionIds.includes(sessionId)) {
          await wechatWs.attachSession(sessionId)
          console.log('[wechat] attached session ' + sessionId + ' to ' + WS_TITLE + ' workspace')
        }
      } catch (e) {
        console.error('[wechat] attach session failed:', sessionId, String((e && e.message) || e).slice(0, 160))
      }
    }

    // ---------------- persisted per-user generation -------------------------
    const loadUserGen = async () => {
      if (!fsSvc) return
      try {
        const target = await fsSvc.resolve(GEN_FILE)
        const text = await fsSvc.readText(target)
        const obj = JSON.parse(text)
        if (obj && typeof obj === 'object') {
          userGen.clear()
          for (const k of Object.keys(obj)) userGen.set(k, Number(obj[k]) || 1)
        }
      } catch (e) { /* first run: no file yet */ }
    }
    const saveUserGen = () => {
      if (!fsSvc) return
      try {
        const payload = {}
        for (const [k, v] of userGen) payload[k] = v
        fsSvc.resolve(GEN_FILE).then((target) =>
          fsSvc.writeText(target, JSON.stringify(payload))
        ).catch((e) => console.error('[wechat] save gen failed:', e))
      } catch (e) { console.error('[wechat] save gen error:', e) }
    }

    const readBody = (req) => new Promise((resolve) => {
      let data = ''
      req.setEncoding('utf8')
      req.on('data', (c) => { data += c; if (data.length > 300000) { req.destroy(); resolve(null) } })
      req.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { resolve(null) } })
      req.on('error', () => resolve(null))
    })
    const sendJson = (res, code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    const authorized = (req) => String(req.headers['authorization'] || '') === 'Bearer ' + SECRET
    const queryParam = (req, name) => {
      const q = String(req.url || '').split('?')[1] || ''
      for (const pair of q.split('&')) {
        const i = pair.indexOf('=')
        const k = i >= 0 ? pair.slice(0, i) : pair
        if (k === name) {
          const v = i >= 0 ? pair.slice(i + 1) : ''
          try { return decodeURIComponent(v) } catch (e) { return v }
        }
      }
      return null
    }

    const pushOutbox = (userId, text) => {
      const id = ++outboxCursor
      outbox.push({ id, userId, text, ts: Date.now() })
      for (const w of outboxWaiters) w()
      outboxWaiters.clear()
    }

    const extractAssistantText = (events) => {
      const messageTexts = []
      for (const ev of events) {
        if (ev && ev.type === 'assistant/message' && ev.data && ev.data.message) {
          const parts = []
          const content = ev.data.message.content || []
          for (const block of content) {
            if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
              parts.push(block.text)
            }
          }
          if (parts.length) messageTexts.push(parts.join('\n\n'))
        }
      }
      return messageTexts.length ? messageTexts[messageTexts.length - 1].trim() : ''
    }
    let msgSeq = 0
    const makeUserMessage = (text) => ({
      id: 'wxm-' + Date.now() + '-' + (++msgSeq),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })

    // Name a conversation from its first meaningful user question.
    const GREETINGS = /^(你好|您好|hi|hello|嗨|在吗|在么|hey|哈喽|早上好|晚上好|下午好|你好呀|在不在|测试|test)[!！。.？?~～\s]*$/i
    const summarizeTitle = (text) => {
      const t = String(text || '').replace(/\s+/g, ' ').trim()
      if (!t || t.startsWith('[收到') || t.length < 4 || GREETINGS.test(t)) return null
      return t.length > 24 ? t.slice(0, 24) + '…' : t
    }

    const driveUser = async (userId) => {
      const entry = userAgents.get(userId)
      if (!entry || entry.busy) return
      entry.busy = true
      try {
        while (entry.queue.length) {
          const m = entry.queue.shift()
          const agent = entry.handle.agent
          if (!entry.named) {
            const topic = summarizeTitle(m.text)
            if (topic) {
              entry.named = true
              const titleSvc = ctx.get('sessionTitle')
              if (titleSvc) {
                try {
                  titleSvc.rename(agent.session, '微信 · ' + topic)
                } catch (e) {}
              }
            }
          }
          const beforeSeq = agent.session.seq
          agent.followup(makeUserMessage(m.text))
          await agent.whenIdle()
          const events = agent.session.events.slice(beforeSeq)
          const text = extractAssistantText(events)
          pushOutbox(userId, text ? text : '（已完成，没有生成文本输出）')
        }
      } catch (err) {
        pushOutbox(userId, '抱歉，处理你的消息时出错了：' + String((err && err.message) || err).slice(0, 300))
      } finally {
        entry.busy = false
      }
    }

    const defaultAgentOptions = () => {
      let agentOptions = {}
      const defModel = ctx.get('agentDefaultModel')
      if (defModel) {
        try {
          const sel = defModel.currentSelection()
          if (sel && sel.provider && sel.model) {
            agentOptions = { provider: sel.provider, model: sel.model }
          }
        } catch (e) { console.error('[wechat] default model read failed:', e) }
      }
      return agentOptions
    }
    const presetSetup = async (agentCtx) => {
      const presets = ctx.get('agentPresets')
      if (presets) await presets.mount(agentCtx, PRESET)
    }
    const postCreate = (handle, userId, sessionId, gen) => {
      const approvalSvc = ctx.get('approval')
      if (approvalSvc) {
        try { approvalSvc.setPolicy(handle.agent, APPROVAL_POLICY) } catch (e) { console.error('[wechat] setPolicy failed:', e) }
      }
      const titleSvc = ctx.get('sessionTitle')
      if (titleSvc) {
        try {
          titleSvc.rename(handle.agent.session, '微信 · 新对话')
        } catch (e) {}
      }
      userAgents.set(userId, { userId, handle, queue: [], busy: false, named: false, gen })
      state.detail = '已为 ' + userId + ' 创建会话 ' + sessionId
      attachToWechatWorkspace(handle.agent.session.id)
    }

    const sessionIdFor = (userId) => {
      const base = 'wechat-' + userId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
      const gen = userGen.get(userId) || 1
      return { id: gen > 1 ? base + '-g' + gen : base, gen }
    }

    const createAgentFor = async (userId) => {
      const { id: sessionId, gen } = sessionIdFor(userId)
      const agentOptions = defaultAgentOptions()
      let handle = null
      try {
        handle = await agentsSvc.resume({
          resumeSessionId: sessionId,
          agentOptions,
          setup: presetSetup,
        })
      } catch (errResume) {
        try {
          handle = await agentsSvc.create({
            sessionId,
            meta: { cwd: WECHAT_WS_PATH, agentPreset: PRESET },
            agentOptions,
            setup: presetSetup,
          })
        } catch (errCreate) {
          const uniqueId = sessionId + '-' + Date.now().toString(36).slice(-6)
          handle = await agentsSvc.create({
            sessionId: uniqueId,
            meta: { cwd: WECHAT_WS_PATH, agentPreset: PRESET },
            agentOptions,
            setup: presetSetup,
          })
          console.error('[wechat] resume/create collided, used unique id:', uniqueId, errCreate)
        }
      }
      postCreate(handle, userId, handle.agent.id, gen)
    }

    // ---------------- /history: list and view past conversations ------------
    const genOf = (id, base) => {
      if (id === base) return 1
      const m = /-g([0-9]+)$/.exec(String(id))
      return m ? Number(m[1]) : 1
    }
    const truncate = (s, n) => {
      const t = String(s || '').replace(/\s+/g, ' ').trim()
      return t.length > n ? t.slice(0, n) + '…' : t
    }
    const mySessions = async (userId) => {
      const q = ctx.get('sessionQuery')
      if (!q) return null
      const base = 'wechat-' + userId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
      const sessions = await q.listSessions()
      return sessions
        .map((r) => r.header)
        .filter((h) => h && (h.id === base || (h.id && h.id.startsWith(base + '-g'))))
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    }
    const handleHistory = async (userId, arg) => {
      const q = ctx.get('sessionQuery')
      if (!q) return '会话查询服务不可用。'
      try {
        const base = 'wechat-' + userId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
        const mine = await mySessions(userId)
        if (!mine || !mine.length) return '暂无历史会话。发送 /new 会开启新的对话，旧对话自动保存，可用 /history 回看。'
        if (arg) {
          const n = Number(arg)
          if (!n || n < 1 || n > mine.length) return '没有第 ' + arg + ' 个会话（共 ' + mine.length + ' 个）。'
          const h = mine[n - 1]
          const snap = await q.readSession(h.id)
          const gen = genOf(h.id, base)
          const lines = []
          for (const ev of (snap.events || [])) {
            if (ev && ev.type === 'user/message' && ev.data && ev.data.source && ev.data.source.kind === 'user') {
              for (const b of (ev.data.content || [])) if (b && b.type === 'text' && b.text && b.text.trim()) lines.push('我: ' + truncate(b.text, 120))
            } else if (ev && ev.type === 'assistant/message' && ev.data && ev.data.message) {
              for (const b of ((ev.data.message.content) || [])) if (b && b.type === 'text' && b.text && b.text.trim()) lines.push('AI: ' + truncate(b.text, 240))
            }
          }
          const tail = lines.slice(-20)
          return '—— 第' + gen + '轮对话（最近 ' + tail.length + ' 条）——\n' + tail.join('\n')
        }
        const lines = ['你的历史会话（/new 不会删除旧对话）：']
        mine.forEach((h, i) => {
          const gen = genOf(h.id, base)
          const t = new Date(h.createdAt || 0)
          const ts = t.toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          lines.push('[' + (i + 1) + '] 第' + gen + '轮 · ' + ts)
        })
        lines.push('回复「/history 数字」查看对应对话内容。')
        return lines.join('\n')
      } catch (e) {
        return '查询失败：' + String((e && e.message) || e).slice(0, 200)
      }
    }

    const handleInbound = async (m) => {
      const userId = String(m.userId || '').slice(0, 200)
      const text = String(m.text || '').slice(0, 4000)
      const media = (m && m.media && m.media.path) ? m.media : null

      const trimmed = text.trim()
      if (!media && (trimmed === '/new' || trimmed === '/重置')) {
        const old = userAgents.get(userId)
        if (old) {
          userAgents.delete(userId)
          retiredHandles.set(userId, old)
          state.users = Array.from(userAgents.keys())
        }
        userGen.set(userId, (userGen.get(userId) || 1) + 1)
        saveUserGen()
        pushOutbox(userId, '已开启新的对话 ✅（第' + (userGen.get(userId) || 1) + '轮）\n旧对话完整保留，回复「/history」可查看历史。')
        return
      }
      if (!media && (trimmed === '/history' || trimmed === '/历史' || trimmed.startsWith('/history ') || trimmed.startsWith('/历史 '))) {
        const parts = trimmed.split(/\s+/)
        const arg = parts.length > 1 ? parts[1] : ''
        const reply = await handleHistory(userId, arg)
        pushOutbox(userId, reply)
        return
      }
      if (!media && (trimmed === '/help' || trimmed === '/帮助')) {
        pushOutbox(userId, '可用命令：\n/new - 开启新对话（旧对话保留）\n/history - 查看历史对话\n/history 数字 - 查看对应对话内容\n/help - 显示本帮助\n其他消息直接和我对话即可。')
        return
      }

      let fullText = text
      if (media) {
        const kindLabel = media.type === 'image' ? '图片' : media.type === 'file' ? '文件' : media.type === 'voice' ? '语音' : media.type === 'video' ? '视频' : '媒体'
        const nameDesc = media.fileName ? '（' + String(media.fileName) + '）' : ''
        const desc = '[收到' + kindLabel + nameDesc + '，文件路径：' + String(media.path) + ']'
        fullText = text.trim() ? text + '\n' + desc : desc
      }
      if (!userId || (!fullText.trim() && !media)) return
      const key = String(m.msgId || (userId + '|' + text + '|' + m.ts))
      if (recentMsgs.has(key)) return
      recentMsgs.set(key, Date.now())
      if (recentMsgs.size > 600) {
        for (const [k, t] of recentMsgs) if (Date.now() - t > 300000) recentMsgs.delete(k)
      }
      let entry = userAgents.get(userId)
      if (!entry) {
        try {
          if (!creating.has(userId)) {
            creating.set(userId, createAgentFor(userId).finally(() => creating.delete(userId)))
          }
          await creating.get(userId)
        } catch (err) {
          console.error('[wechat] agent create failed:', err)
          pushOutbox(userId, '初始化会话失败：' + String((err && err.message) || err).slice(0, 200))
          return
        }
        entry = userAgents.get(userId)
        if (!entry) return
      }
      entry.queue.push({ userId, text: fullText })
      driveUser(userId)
    }

    const onBridgeEvent = (body) => {
      const t = String(body.type || '')
      if (t === 'qr') {
        state.qrRev += 1
        state.qrImage = body.image ? String(body.image) : null
        state.qrUrl = body.url ? String(body.url) : null
        state.qrState = 'waiting'
        state.phase = 'waiting-qr'
        state.detail = '请用手机微信扫描二维码登录（建议使用小号）'
      } else if (t === 'scanned') {
        state.qrState = 'scanned'
        state.detail = '已扫码，请在手机上确认登录'
      } else if (t === 'qr-expired') {
        state.qrState = 'expired'
        state.detail = '二维码已过期，bridge 正在获取新二维码…'
      } else if (t === 'logged-in') {
        state.qrState = 'online'
        state.phase = 'online'
        state.detail = '微信登录成功，在线监听中（account=' + String(body.accountId || '') + '）'
      } else if (t === 'heartbeat') {
        state.lastHeartbeat = Date.now()
        state.bridgeAlive = true
        state.bridgePid = Number(body.pid) || state.bridgePid
      } else if (t === 'bridge-start') {
        state.bridgeAlive = true
        state.bridgePid = Number(body.pid) || null
        if (state.phase !== 'waiting-qr') { state.phase = 'connecting'; state.detail = 'bridge 进程已启动，正在登录微信…' }
      } else if (t === 'bridge-stop') {
        state.bridgeAlive = false
        state.detail = 'bridge 已停止'
      } else if (t === 'fatal') {
        state.bridgeAlive = false
        state.phase = 'error'
        state.detail = 'bridge 错误：' + String(body.message || '').slice(0, 300)
      } else if (t === 'bot-error') {
        state.detail = '微信错误：' + String(body.message || '').slice(0, 200)
      } else if (t === 'session-expired') {
        state.phase = 'expired'
        state.detail = '会话过期，bridge 正在重新登录…'
      } else if (t === 'session-restored' || t === 'poll-start') {
        state.phase = 'online'
        state.detail = '在线监听中'
      } else if (t === 'verify-code-required') {
        state.detail = '需要输入配对码（在运行 DSH 的终端里查看并输入）'
      }
    }

    const statusSnapshot = () => ({
      phase: state.phase,
      detail: state.detail,
      qrRev: state.qrRev,
      qrState: state.qrState,
      bridgeAlive: state.bridgeAlive,
      bridgePid: state.bridgePid,
      users: Array.from(userAgents.keys()),
      outboxDepth: outbox.length,
      since: state.since,
    })

    routeDisposers.push(ws.register({ kind: 'exact', path: BASE + '/inbound', handler: async (req, res) => {
      if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' })
      const body = await readBody(req)
      if (!body) return sendJson(res, 400, { error: 'bad json' })
      handleInbound(body)
      sendJson(res, 200, { ok: true })
    }}))

    routeDisposers.push(ws.register({ kind: 'exact', path: BASE + '/event', handler: async (req, res) => {
      if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' })
      const body = await readBody(req)
      if (!body) return sendJson(res, 400, { error: 'bad json' })
      onBridgeEvent(body)
      sendJson(res, 200, { ok: true })
    }}))

    routeDisposers.push(ws.register({ kind: 'exact', path: BASE + '/outbox', handler: async (req, res) => {
      if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' })
      const since = Number(queryParam(req, 'since') || 0)
      let pending = outbox.filter((m) => m.id > since)
      if (!pending.length) {
        await new Promise((resolve) => {
          const waiter = () => resolve()
          outboxWaiters.add(waiter)
          ctx.timeout(() => { outboxWaiters.delete(waiter); resolve() }, 25000)
        })
        pending = outbox.filter((m) => m.id > since)
      }
      if (pending.length) {
        const lastId = pending[pending.length - 1].id
        const keep = outbox.filter((m) => m.id > lastId)
        outbox.length = 0
        for (const k of keep) outbox.push(k)
      }
      sendJson(res, 200, { messages: pending, cursor: outboxCursor })
    }}))

    routeDisposers.push(ws.register({ kind: 'exact', path: BASE + '/status', handler: async (req, res) => {
      if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' })
      sendJson(res, 200, statusSnapshot())
    }}))

    const startBridge = async () => {
      if (stopping) return
      if (!sub) {
        state.phase = 'error'
        state.detail = 'subprocess 服务不可用，请手动运行 bridge：node ' + BRIDGE_DIR + '/bridge.js'
        return
      }
      state.phase = 'starting-bridge'
      state.detail = '正在启动 bridge 进程…'
      try {
        let nodePath = null
        try { nodePath = await sub.resolveExecutable('node') } catch (e) { nodePath = null }
        const argv = nodePath ? [nodePath, BRIDGE_DIR + '/bridge.js'] : ['node', BRIDGE_DIR + '/bridge.js']
        bridgeProc = sub.spawn({
          argv,
          cwd: BRIDGE_DIR,
          stdio: { stdin: 'pipe', stdout: 'inherit', stderr: 'inherit' },
          graceMs: 3000,
          env: {
            DSH_BASE_URL: 'http://' + ws.host + ':' + ws.port,
            DSH_BRIDGE_TOKEN: SECRET,
            WECHAT_STORAGE_DIR: BRIDGE_DIR + '/wechat-credentials',
            WECHAT_BOT_AGENT: 'DSH-WeChat-Bridge/1.0',
          },
        })
        state.bridgePid = bridgeProc.pid
        bridgeProc.done.then((outcome) => {
          state.bridgeAlive = false
          state.bridgePid = null
          console.log('[wechat] bridge exited:', JSON.stringify(outcome))
          if (!stopping) {
            state.detail = 'bridge 进程退出（code=' + outcome.exitCode + '），3 秒后自动重启'
            ctx.timeout(() => startBridge(), 3000)
          }
        })
      } catch (err) {
        console.error('[wechat] bridge spawn failed:', err)
        state.phase = 'error'
        state.detail = 'bridge 启动失败：' + String((err && err.message) || err).slice(0, 200)
      }
    }

    const restartBridge = () => {
      const p = bridgeProc
      bridgeProc = null
      if (p) { try { p.terminate() } catch (e) {} }
      ctx.timeout(() => startBridge(), 800)
    }

    ctx.effect(() => {
      loadUserGen()
      ensureWechatWorkspace()
      startBridge()
      return () => {
        stopping = true
        if (bridgeProc) { try { bridgeProc.terminate() } catch (e) {} }
        for (const d of routeDisposers) { try { d() } catch (e) {} }
        routeDisposers.length = 0
      }
    })

    ctx.interval(() => {
      if (state.lastHeartbeat && Date.now() - state.lastHeartbeat > 60000 && state.bridgeAlive) {
        state.bridgeAlive = false
        state.detail = 'bridge 心跳超时，可能已离线'
      }
    }, 10000)

    ctx.effect(() => () => {
      for (const [userId, entry] of userAgents) {
        entry.handle.dispose().catch(() => {})
      }
      userAgents.clear()
      for (const [userId, entry] of retiredHandles) {
        entry.handle.dispose().catch(() => {})
      }
      retiredHandles.clear()
    })

    // Optional panel RPCs — only present in the dynamic-plugin runtime.
    if (typeof harness !== 'undefined') {
      harness.handle('status', async () => statusSnapshot())
      harness.handle('qr', async () => ({ image: state.qrImage || null, url: state.qrUrl || null, rev: state.qrRev }))
      harness.handle('action', async (args) => {
        const action = args && args.action
        if (action === 'restart-bridge') { restartBridge(); return { ok: true } }
        return { ok: false, error: 'unknown action' }
      })
    }

    console.log('[wechat] bridge plugin ready, base = ' + BASE + ', bridge dir = ' + BRIDGE_DIR + ', approval = ' + APPROVAL_POLICY)
  },
}
