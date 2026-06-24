// e-Click Farm Agent — roda na rede local da fábrica.
// Lê o MQTT (LAN) das impressoras Bambu e envia o status pro e-Click.
// Node 18+ (tem fetch nativo). Dependência: mqtt (npm i).
import mqtt from 'mqtt'
import fs from 'node:fs'

const cfg = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url)))
const BACKEND = String(cfg.backend_url || '').replace(/\/+$/, '')
const TOKEN = cfg.agent_token
const PUSH_MS = (Number(cfg.push_interval_sec) || 5) * 1000
const AGENT_VERSION = '1.0.0'

if (!BACKEND || !TOKEN) { console.error('Falta backend_url ou agent_token no config.json'); process.exit(1) }

const state = {}      // serial -> objeto "print" mesclado
const connected = {}  // serial -> bool

const STATE_MAP = { RUNNING: 'printing', PAUSE: 'paused', FAILED: 'error', FINISH: 'idle', IDLE: 'idle', PREPARE: 'printing', SLICING: 'printing' }

function connectPrinter(p) {
  const client = mqtt.connect(`mqtts://${p.ip}:8883`, {
    username: 'bblp', password: p.access_code, rejectUnauthorized: false,
    reconnectPeriod: 5000, connectTimeout: 8000,
    clientId: `eclick-${p.serial}-${Math.floor(Date.now() / 1000)}`,
  })
  const report = `device/${p.serial}/report`
  const request = `device/${p.serial}/request`
  const pushall = () => client.publish(request, JSON.stringify({ pushing: { sequence_id: '0', command: 'pushall' } }))

  client.on('connect', () => { connected[p.serial] = true; console.log(`[${p.name || p.serial}] conectado`); client.subscribe(report); pushall() })
  client.on('message', (_t, buf) => { try { const m = JSON.parse(buf.toString()); if (m.print) state[p.serial] = { ...(state[p.serial] || {}), ...m.print } } catch { /* ignora */ } })
  client.on('error', e => console.log(`[${p.name || p.serial}] erro: ${e.message}`))
  client.on('close', () => { connected[p.serial] = false })
  client.on('offline', () => { connected[p.serial] = false })
  setInterval(() => { if (connected[p.serial]) pushall() }, 30000)  // status completo a cada 30s
}

function snapshot(p) {
  const s = state[p.serial] || {}
  const ams = []
  try { for (const u of (s.ams?.ams || [])) for (const t of (u.tray || [])) if (t.tray_type) ams.push({ slot: `${u.id}-${t.id}`, material: t.tray_type, color: t.tray_color, remain_pct: t.remain }) } catch { /* */ }
  const hms = Array.isArray(s.hms) && s.hms.length ? s.hms[0] : null
  return {
    serial: p.serial,
    online: !!connected[p.serial],
    state: connected[p.serial] ? (STATE_MAP[s.gcode_state] || 'idle') : 'offline',
    job_name: s.subtask_name || s.gcode_file || null,
    progress_pct: s.mc_percent ?? null,
    remaining_minutes: s.mc_remaining_time ?? null,
    layer_current: s.layer_num ?? null,
    layer_total: s.total_layer_num ?? null,
    nozzle_temp: s.nozzle_temper ?? null,
    bed_temp: s.bed_temper ?? null,
    ams,
    error_code: hms ? String(hms.code) : (s.print_error ? String(s.print_error) : null),
    error_text: hms ? `HMS ${hms.attr ?? ''}`.trim() : null,
  }
}

async function push() {
  const printers = (cfg.printers || []).map(snapshot)
  try {
    const r = await fetch(`${BACKEND}/product-os/farm/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-farm-agent-token': TOKEN },
      body: JSON.stringify({ agent_version: AGENT_VERSION, printers }),
    })
    if (!r.ok) console.log(`[push] HTTP ${r.status}`)
  } catch (e) { console.log(`[push] ${e.message}`) }
}

console.log(`e-Click Farm Agent v${AGENT_VERSION} — ${(cfg.printers || []).length} impressora(s) → ${BACKEND}`)
;(cfg.printers || []).forEach(connectPrinter)
setInterval(push, PUSH_MS)
