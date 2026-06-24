// e-Click Farm Agent — roda na rede local da fábrica.
// Lê o MQTT (LAN) das impressoras Bambu, envia o status pro e-Click e
// executa comandos (pausar/retomar/parar/luz; enviar impressão = experimental).
// Node 18+ (fetch nativo). Dependências: mqtt, basic-ftp.
import mqtt from 'mqtt'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const cfg = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url)))
const BACKEND = String(cfg.backend_url || '').replace(/\/+$/, '')
const TOKEN = cfg.agent_token
const PUSH_MS = (Number(cfg.push_interval_sec) || 5) * 1000
const AGENT_VERSION = '1.1.0'

if (!BACKEND || !TOKEN) { console.error('Falta backend_url ou agent_token no config.json'); process.exit(1) }

const state = {}      // serial -> objeto "print" mesclado
const connected = {}  // serial -> bool
const clients = {}    // serial -> cliente mqtt
const acks = []       // [{ id, ok, result }] pendentes de envio

const STATE_MAP = { RUNNING: 'printing', PAUSE: 'paused', FAILED: 'error', FINISH: 'idle', IDLE: 'idle', PREPARE: 'printing', SLICING: 'printing' }

function connectPrinter(p) {
  const client = mqtt.connect(`mqtts://${p.ip}:8883`, {
    username: 'bblp', password: p.access_code, rejectUnauthorized: false,
    reconnectPeriod: 5000, connectTimeout: 8000,
    clientId: `eclick-${p.serial}-${Math.floor(Date.now() / 1000)}`,
  })
  clients[p.serial] = client
  const report = `device/${p.serial}/report`
  const request = `device/${p.serial}/request`
  const pushall = () => client.publish(request, JSON.stringify({ pushing: { sequence_id: '0', command: 'pushall' } }))

  client.on('connect', () => { connected[p.serial] = true; console.log(`[${p.name || p.serial}] conectado`); client.subscribe(report); pushall() })
  client.on('message', (_t, buf) => { try { const m = JSON.parse(buf.toString()); if (m.print) state[p.serial] = { ...(state[p.serial] || {}), ...m.print } } catch { /* ignora */ } })
  client.on('error', e => console.log(`[${p.name || p.serial}] erro: ${e.message}`))
  client.on('close', () => { connected[p.serial] = false })
  client.on('offline', () => { connected[p.serial] = false })
  setInterval(() => { if (connected[p.serial]) pushall() }, 30000)
}

function snapshot(p) {
  const s = state[p.serial] || {}
  const ams = []
  try { for (const u of (s.ams?.ams || [])) for (const t of (u.tray || [])) if (t.tray_type) ams.push({ slot: `${u.id}-${t.id}`, material: t.tray_type, color: t.tray_color, remain_pct: t.remain }) } catch { /* */ }
  const hms = Array.isArray(s.hms) && s.hms.length ? s.hms[0] : null
  return {
    serial: p.serial, online: !!connected[p.serial],
    state: connected[p.serial] ? (STATE_MAP[s.gcode_state] || 'idle') : 'offline',
    job_name: s.subtask_name || s.gcode_file || null,
    progress_pct: s.mc_percent ?? null, remaining_minutes: s.mc_remaining_time ?? null,
    layer_current: s.layer_num ?? null, layer_total: s.total_layer_num ?? null,
    nozzle_temp: s.nozzle_temper ?? null, bed_temp: s.bed_temper ?? null, ams,
    error_code: hms ? String(hms.code) : (s.print_error ? String(s.print_error) : null),
    error_text: hms ? `HMS ${hms.attr ?? ''}`.trim() : null,
  }
}

// ── execução de comandos vindos do e-Click ──────────────────────────
function publishCmd(serial, obj) { const c = clients[serial]; if (!c) throw new Error('impressora não conectada'); c.publish(`device/${serial}/request`, JSON.stringify(obj)) }

async function runCommand(cmd) {
  const { id, serial, command_type, payload } = cmd
  try {
    if (command_type === 'pause') publishCmd(serial, { print: { sequence_id: '0', command: 'pause' } })
    else if (command_type === 'resume') publishCmd(serial, { print: { sequence_id: '0', command: 'resume' } })
    else if (command_type === 'stop') publishCmd(serial, { print: { sequence_id: '0', command: 'stop' } })
    else if (command_type === 'light_on') publishCmd(serial, { system: { sequence_id: '0', command: 'ledctrl', led_node: 'chamber_light', led_mode: 'on' } })
    else if (command_type === 'light_off') publishCmd(serial, { system: { sequence_id: '0', command: 'ledctrl', led_node: 'chamber_light', led_mode: 'off' } })
    else if (command_type === 'print') { await dispatchPrint(serial, payload); }
    else throw new Error(`comando desconhecido: ${command_type}`)
    acks.push({ id, ok: true, result: 'ok' })
    console.log(`[cmd ${command_type}] ${serial} → ok`)
  } catch (e) {
    acks.push({ id, ok: false, result: e.message })
    console.log(`[cmd ${command_type}] ${serial} → falhou: ${e.message}`)
  }
}

// EXPERIMENTAL: baixa o .3mf, sobe via FTP pra impressora e manda imprimir.
// O formato exato do comando varia por modelo/firmware — validar numa máquina real.
async function dispatchPrint(serial, payload) {
  const p = (cfg.printers || []).find(x => x.serial === serial)
  if (!p) throw new Error('impressora não encontrada no config')
  if (!payload?.file_url) throw new Error('sem file_url')
  const { Client } = await import('basic-ftp')
  const name = (payload.file_name || 'job.3mf').replace(/[^\w.\-]/g, '_')
  const tmp = path.join(os.tmpdir(), `eclick-${Date.now()}-${name}`)
  const res = await fetch(payload.file_url)
  if (!res.ok) throw new Error(`download do arquivo falhou (HTTP ${res.status})`)
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()))
  const ftp = new Client(15000)
  try {
    await ftp.access({ host: p.ip, port: 990, user: 'bblp', password: p.access_code, secure: 'implicit', secureOptions: { rejectUnauthorized: false } })
    await ftp.uploadFrom(tmp, name)
  } finally { ftp.close(); try { fs.unlinkSync(tmp) } catch { /* */ } }
  publishCmd(serial, {
    print: {
      sequence_id: '0', command: 'project_file', param: 'Metadata/plate_1.gcode',
      subtask_name: name, url: `file:///sdcard/${name}`,
      bed_type: 'auto', timelapse: false, bed_leveling: true, flow_cali: false,
      vibration_cali: false, layer_inspect: false, use_ams: true,
      profile_id: '0', project_id: '0', subtask_id: '0', task_id: '0',
    },
  })
}

async function push() {
  const printers = (cfg.printers || []).map(snapshot)
  const command_results = acks.splice(0, acks.length)  // envia e limpa
  try {
    const r = await fetch(`${BACKEND}/product-os/farm/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-farm-agent-token': TOKEN },
      body: JSON.stringify({ agent_version: AGENT_VERSION, printers, command_results }),
    })
    if (!r.ok) { console.log(`[push] HTTP ${r.status}`); return }
    const data = await r.json().catch(() => ({}))
    for (const cmd of (data.commands || [])) await runCommand(cmd)
  } catch (e) { console.log(`[push] ${e.message}`) }
}

console.log(`e-Click Farm Agent v${AGENT_VERSION} — ${(cfg.printers || []).length} impressora(s) → ${BACKEND}`)
;(cfg.printers || []).forEach(connectPrinter)
setInterval(push, PUSH_MS)
