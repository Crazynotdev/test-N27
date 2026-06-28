// ═══════════════════════════════════════════════════════════
//          CRAZY VOL1  —  BOT + SERVEUR API
// ═══════════════════════════════════════════════════════════
// Ce fichier fait deux choses en même temps :
//   1. Lance le bot WhatsApp via gifted-baileys
//   2. Expose un serveur HTTP sur le port API_PORT
//      → Le site web SaaS appelle ces endpoints
//
// Endpoints exposés :
//   GET  /pair?phone=241XXXXXXXX  → génère le PairCode
//   GET  /status                  → état de connexion du bot
//   POST /disconnect              → déconnecte la session
// ═══════════════════════════════════════════════════════════

'use strict'

const http   = require('http')
const url    = require('url')
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('gifted-baileys')
const pino   = require('pino')
const chalk  = require('chalk')
const figlet = require('figlet')

const config         = require('./config')
const logger         = require('./lib/logger')
const { initDB, getGroup } = require('./database/db')
const { handleMessage }    = require('./handler')

// ── Port du serveur API ────────────────────────────────────
const API_PORT = process.env.API_PORT || 3000

// ── État global partagé ───────────────────────────────────
const botState = {
  sock:        null,
  connected:   false,
  phoneNumber: null,
  connectedAt: null,
}

// ═══════════════════════════════════════════════════════════
//   HELPERS
// ═══════════════════════════════════════════════════════════
function banner() {
  console.clear()
  try {
    console.log(chalk.cyanBright(figlet.textSync('CRAZY VOL1', { font: 'Standard' })))
  } catch {
    console.log(chalk.cyanBright.bold('=== CRAZY VOL1 ==='))
  }
  console.log(chalk.gray('  ' + '━'.repeat(55)))
  console.log(chalk.greenBright(`  🤖 ${config.BOT_NAME} v${config.BOT_VERSION}`))
  console.log(chalk.gray(`  ${config.BOT_TAG}`))
  console.log(chalk.gray('  ' + '━'.repeat(55)))
  console.log(chalk.cyan(`  🌐 API sur http://localhost:${API_PORT}`))
  console.log(chalk.gray('  ' + '━'.repeat(55)) + '\n')
}

function jsonRes(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(body)
}

// ═══════════════════════════════════════════════════════════
//   SERVEUR API HTTP
// ═══════════════════════════════════════════════════════════
function startApiServer() {
  const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' })
      return res.end()
    }

    const { pathname, query } = url.parse(req.url, true)

    // ── GET /pair?phone=241XXXXXXXX ──────────────────────
    if (req.method === 'GET' && pathname === '/pair') {
      const phone = (query.phone || '').replace(/[^0-9]/g, '')
      if (!phone || phone.length < 8) {
        return jsonRes(res, 400, { error: 'Numéro invalide. Inclure l\'indicatif pays.' })
      }

      if (!botState.sock) {
        return jsonRes(res, 503, { error: 'Bot non initialisé. Attends quelques secondes.' })
      }

      if (botState.connected) {
        return jsonRes(res, 409, { error: 'Une session est déjà active. Déconnecte d\'abord.' })
      }

      try {
        logger.info(`PairCode demandé pour +${phone}`)
        const code = await botState.sock.requestPairingCode(phone)
        if (!code) throw new Error('Code non reçu de WhatsApp')
        logger.boot(`PairCode généré : ${code}`)
        botState.phoneNumber = '+' + phone
        return jsonRes(res, 200, { code, phone: '+' + phone })
      } catch (err) {
        logger.error('PAIR', err)
        return jsonRes(res, 500, { error: err.message || 'Erreur lors de la génération du code' })
      }
    }

    // ── GET /status ──────────────────────────────────────
    if (req.method === 'GET' && pathname === '/status') {
      return jsonRes(res, 200, {
        connected:   botState.connected,
        phone:       botState.phoneNumber || null,
        connectedAt: botState.connectedAt || null,
        botName:     config.BOT_NAME,
        version:     config.BOT_VERSION,
        uptime:      Math.floor(process.uptime()),
      })
    }

    // ── POST /disconnect ─────────────────────────────────
    if (req.method === 'POST' && pathname === '/disconnect') {
      try {
        if (botState.sock) {
          await botState.sock.logout().catch(() => {})
        }
        botState.connected   = false
        botState.phoneNumber = null
        botState.connectedAt = null
        logger.info('Session déconnectée via API')
        return jsonRes(res, 200, { success: true, message: 'Bot déconnecté.' })
      } catch (err) {
        logger.error('DISCONNECT', err)
        return jsonRes(res, 500, { error: err.message })
      }
    }

    // 404
    jsonRes(res, 404, { error: 'Endpoint inconnu.' })
  })

  server.listen(API_PORT, () => {
    logger.boot(`Serveur API démarré sur le port ${API_PORT}`)
  })

  server.on('error', (err) => logger.error('API-SERVER', err))
  return server
}

// ═══════════════════════════════════════════════════════════
//   BOT WHATSAPP
// ═══════════════════════════════════════════════════════════
async function startBot() {
  banner()
  await initDB()

  const { state, saveCreds } = await useMultiFileAuthState(config.SESSION_PATH)
  const { version }          = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    logger:                    pino({ level: 'silent' }),
    printQRInTerminal:         false,   // QR désactivé — on passe par PairCode
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    browser:                   ['Ubuntu', 'Chrome', '20.0.04'],
    markOnlineOnConnect:       true,
    generateHighQualityLinkPreview: true,
  })

  botState.sock = sock

  // ── Connexion / déconnexion ──────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update

    if (connection === 'open') {
      botState.connected   = true
      botState.connectedAt = new Date().toISOString()
      botState.phoneNumber = botState.phoneNumber || sock.user?.id?.split(':')[0]
      logger.connect(config.BOT_NAME, sock.user?.id)
      logger.divider()
    }

    if (connection === 'close') {
      botState.connected = false
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        logger.disconnect('Session expirée (logout). Supprime /session et relance.')
        process.exit(1)
      } else {
        logger.reconnect(1)
        setTimeout(startBot, 4000)
      }
    }
  })

  sock.ev.on('creds.update', saveCreds)

  // ── Messages ─────────────────────────────────────────
  sock.ev.on('messages.upsert', async (m) => {
    await handleMessage(sock, m)
  })

  // ── Événements de groupe (welcome / goodbye) ─────────
  sock.ev.on('group-participants.update', async (event) => {
    try {
      const { id: chatId, participants, action } = event
      const groupConf = await getGroup(chatId)
      const meta = await sock.groupMetadata(chatId).catch(() => null)
      const groupName = meta?.subject || 'le groupe'

      for (const participant of participants) {
        const num = participant.split('@')[0]

        if (action === 'add' && groupConf.welcome) {
          const text = (groupConf.welcomeMsg || '👋 Bienvenue @user dans *@group* !')
            .replace('@user', `@${num}`)
            .replace('@group', groupName)
          await sock.sendMessage(chatId, { text, mentions: [participant] })
          logger.group('add', participant, groupName)
        }

        if (action === 'remove' && groupConf.goodbye) {
          await sock.sendMessage(chatId, {
            text: `👋 @${num} a quitté *${groupName}*.`,
            mentions: [participant],
          })
          logger.group('remove', participant, groupName)
        }

        if (action === 'promote') logger.group('promote', participant, groupName)
        if (action === 'demote')  logger.group('demote',  participant, groupName)
      }
    } catch (err) {
      logger.error('GROUP-EVENT', err)
    }
  })

  // ── Antilink ─────────────────────────────────────────
  sock.ev.on('messages.upsert', async (m) => {
    try {
      const message = m.messages[0]
      if (!message?.message || message.key.fromMe) return
      const chatId = message.key.remoteJid
      if (!chatId.endsWith('@g.us')) return

      const groupConf = await getGroup(chatId)
      if (!groupConf.antilink) return

      const body =
        message.message?.conversation ||
        message.message?.extendedTextMessage?.text || ''

      if (/(chat\.whatsapp\.com|https?:\/\/)/i.test(body)) {
        const sender = message.key.participant || message.participant
        const meta = await sock.groupMetadata(chatId).catch(() => null)
        const isAdmin = meta?.participants?.find(p => p.id === sender)?.admin
        if (isAdmin) return
        await sock.sendMessage(chatId, { delete: message.key }).catch(() => {})
        await sock.sendMessage(chatId, {
          text: `🚫 @${sender.split('@')[0]} les liens sont interdits ici !`,
          mentions: [sender],
        })
      }
    } catch (err) {
      logger.error('ANTILINK', err)
    }
  })

  process.on('uncaughtException',  (err) => logger.error('UNCAUGHT', err))
  process.on('unhandledRejection', (err) => logger.error('UNHANDLED', err))

  return sock
}

// ═══════════════════════════════════════════════════════════
//   DÉMARRAGE
// ═══════════════════════════════════════════════════════════
;(async () => {
  startApiServer()
  await startBot()
})().catch((err) => {
  console.error(chalk.red('❌ Erreur fatale :'), err)
  process.exit(1)
})
