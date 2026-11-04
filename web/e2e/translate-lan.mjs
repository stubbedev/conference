#!/usr/bin/env node
// Live translation between computers on the same network (office or home
// Wi-Fi). This machine runs everything: the speech service, a meeting
// server with live translation, and an HTTPS front door on LAN_PORT
// (8443) with a self-signed certificate. Browsers only allow camera and
// mic on HTTPS, and a secure page may only reach the speech service over
// wss, so both sit behind the one address: /speech/ goes to the speech
// service, everything else to the meeting server.
//
// It opens the host link here and prints the guest link for the other
// computer, which accepts the certificate warning once. Safari also has
// to trust the certificate before its WebSocket connects, so the
// certificate is kept in tmp/ across runs (new only when this machine's
// address changes) and offered at /certificate.pem. The room lives in a
// temporary database: Ctrl+C closes it for good.
//
//   just translate-lan openai        (OpenAI translates; key in speech/.env)
//   TRANSLATE_URL=http://… just translate-lan   (Ollama, Gemma unless TRANSLATE_MODEL)
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:https'
import { connect } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRoom } from './browser.mjs'
import { buildServer, ensureSpeech, repoRoot, shutdown, SPEECH_PORT, startServer, track } from './translate-stack.mjs'

const LAN_PORT = Number(process.env.LAN_PORT ?? 8443)
const SPEECH_PREFIX = '/speech/'
const CERTIFICATE_PATH = '/certificate.pem'
const CERT_DIR = join(repoRoot, 'tmp/translate-lan')
const secret = process.env.SPEECH_SECRET ?? 'translate-lan'
const openai = process.argv.includes('openai')

const dir = mkdtempSync(join(tmpdir(), 'translate-lan-'))
track({ close: () => rmSync(dir, { recursive: true, force: true }) })

function lanAddress() {
  for (const addrs of Object.values(networkInterfaces())) {
    const lan = addrs?.find((a) => a.family === 'IPv4' && !a.internal)
    if (lan) return lan.address
  }
  throw new Error('no network address: connect to the Wi-Fi or office network first')
}

// Reused while it still names this address, so a browser that trusts it
// keeps trusting it.
function selfSignedCert(ip) {
  const key = join(CERT_DIR, `${ip}.key.pem`)
  const cert = join(CERT_DIR, `${ip}.cert.pem`)
  if (existsSync(key) && existsSync(cert)) return { key: readFileSync(key), cert: readFileSync(cert) }
  mkdirSync(CERT_DIR, { recursive: true })
  const res = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '825',
    '-keyout', key, '-out', cert,
    '-subj', `/CN=${ip}`, '-addext', `subjectAltName=IP:${ip},IP:127.0.0.1`,
    // macOS trusts a self-signed server certificate only with this and at most 825 days.
    '-addext', 'extendedKeyUsage=serverAuth',
  ], { stdio: 'ignore' })
  if (res.status !== 0) throw new Error('openssl could not create a certificate')
  return { key: readFileSync(key), cert: readFileSync(cert) }
}

function target(url, meetingPort) {
  return url.startsWith(SPEECH_PREFIX)
    ? { port: SPEECH_PORT, path: url.slice(SPEECH_PREFIX.length - 1) }
    : { port: meetingPort, path: url }
}

// HTTPS in front, plain HTTP behind; the Host header is passed on as is,
// so the meeting server's same-origin WebSocket check still holds.
function frontDoor(tls, meetingPort) {
  const server = createServer(tls, (req, res) => {
    if (req.url === CERTIFICATE_PATH) {
      res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert' }).end(tls.cert)
      return
    }
    const { port, path } = target(req.url ?? '/', meetingPort)
    const upstream = request({ host: '127.0.0.1', port, path, method: req.method, headers: req.headers }, (back) => {
      res.writeHead(back.statusCode ?? 502, back.headers)
      back.pipe(res)
    })
    upstream.on('error', () => res.writeHead(502).end())
    req.pipe(upstream)
  })
  server.on('upgrade', (req, socket, head) => {
    const { port, path } = target(req.url ?? '/', meetingPort)
    const upstream = connect(port, '127.0.0.1', () => {
      const headers = Object.entries(req.headers).flatMap(([name, value]) =>
        [].concat(value).map((v) => `${name}: ${v}`),
      )
      upstream.write(`${req.method} ${path} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`)
      upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    const close = () => {
      socket.destroy()
      upstream.destroy()
    }
    upstream.on('error', close)
    socket.on('error', close)
  })
  return new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(LAN_PORT, '0.0.0.0', () => resolveListen(server))
  })
}

async function main() {
  const ip = lanAddress()
  const lanBase = `https://${ip}:${LAN_PORT}`
  await ensureSpeech({ secret, openai })
  const base = await startServer(buildServer(dir), dir, {
    speechURL: `wss://${ip}:${LAN_PORT}${SPEECH_PREFIX}v1/stream`,
    // Directly: the front door's self-signed certificate is trusted by the browsers, not this server.
    statusURL: `http://127.0.0.1:${SPEECH_PORT}/v1/status`,
    secret,
  })
  track(await frontDoor(selfSignedCert(ip), Number(new URL(base).port)))

  const room = await createRoom(base, 'Live translation')
  const hostLink = room.privUrl.replace(base, lanBase)
  const guestLink = room.url.replace(base, lanBase)
  spawn('open', [hostLink], { stdio: 'ignore' })

  console.log(`
Live translation over the local network is running (${openai ? 'OpenAI' : 'Gemma + local Whisper'}).

  You (host), opened here:   ${hostLink}
  Other computer (guest):    ${guestLink}

  1. Both browsers warn about the certificate once: "Advanced" → "Proceed".
     Safari must trust it as well (once; it is reused while this address stays):
       open ${lanBase}${CERTIFICATE_PATH} on that computer, open the downloaded file,
       then in Keychain Access double-click the certificate (${ip}),
       Trust → "When using this certificate": Always Trust, close, enter the password.
  2. Each person picks "My language" (and a voice) before joining.
  3. You click the translate button (Start live translation) in the call.
  If macOS asks whether to accept incoming connections, allow it.

Ctrl+C closes the room for good.`)
}

process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))

main().catch(async (err) => {
  console.error(err.message)
  await shutdown(1)
})
