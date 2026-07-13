// e-Click Farm Agent — roda na rede local da fábrica.
// Lê o MQTT (LAN) das impressoras Bambu, envia o status pro e-Click e
// executa comandos (pausar/retomar/parar/luz; enviar impressão = experimental).
// Node 18+ (fetch nativo). Dependências: mqtt, basic-ftp.
import mqtt from 'mqtt'
import tls from 'node:tls'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

const cfg = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url)))
const BACKEND = String(cfg.backend_url || '').replace(/\/+$/, '')
const TOKEN = cfg.agent_token
const PUSH_MS = (Number(cfg.push_interval_sec) || 5) * 1000
const AGENT_VERSION = '1.4.5'

if (!BACKEND || !TOKEN) { console.error('Falta backend_url ou agent_token no config.json'); process.exit(1) }

const state = {}        // serial -> objeto "print" mesclado
const connected = {}    // serial -> bool
const clients = {}      // serial -> cliente mqtt
const acks = []         // [{ id, ok, result }] pendentes de envio
const detectionCfg = {}     // serial -> { enabled, sensitivity } (vem do backend)
const detectionApplied = {} // serial -> assinatura já aplicada (evita reenviar)

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

  client.on('connect', () => {
    connected[p.serial] = true; console.log(`[${p.name || p.serial}] conectado`); client.subscribe(report); pushall()
    // liga a vigilância de falha o quanto antes (default; o backend refina no 1º push)
    if (!detectionCfg[p.serial]) detectionCfg[p.serial] = { enabled: true, sensitivity: 'medium' }
    applyDetection(p.serial)
  })
  client.on('message', (_t, buf) => { try { const m = JSON.parse(buf.toString()); if (m.print) state[p.serial] = { ...(state[p.serial] || {}), ...m.print } } catch { /* ignora */ } })
  client.on('error', e => console.log(`[${p.name || p.serial}] erro: ${e.message}`))
  client.on('close', () => { connected[p.serial] = false })
  client.on('offline', () => { connected[p.serial] = false })
  // a cada 30s: pushall + re-afirma a detecção (a A1 pode resetar o xcam ao iniciar um job)
  setInterval(() => { if (connected[p.serial]) { pushall(); detectionApplied[p.serial] = null; applyDetection(p.serial) } }, 30000)
}

// T1-A: liga/desliga a detecção de falha ON-BOARD da Bambu (spaghetti + first-layer)
// via MQTT. print_halt=true faz a A1 PAUSAR sozinha ao detectar. EXPERIMENTAL:
// o formato/sensibilidade varia por firmware — validar em máquina real.
function applyDetection(serial) {
  const c = clients[serial]; if (!c) return
  const cfg = detectionCfg[serial]; if (!cfg) return
  const control = cfg.enabled !== false
  const sens = ['low', 'medium', 'high'].includes(cfg.sensitivity) ? cfg.sensitivity : 'medium'
  const sig = `${control}:${sens}`
  if (detectionApplied[serial] === sig) return
  for (const module_name of ['spaghetti_detector', 'first_layer_inspector']) {
    try {
      c.publish(`device/${serial}/request`, JSON.stringify({
        xcam: { sequence_id: '0', command: 'xcam_control_set', module_name, control, print_halt: control, halt_print_sensitivity: sens },
      }))
    } catch { /* reenvia no próximo ciclo */ }
  }
  detectionApplied[serial] = sig
  console.log(`[${serial}] vigilância de falha ${control ? `ON (sens ${sens})` : 'OFF'}`)
}

function snapshot(p) {
  const s = state[p.serial] || {}
  const ams = []
  try { for (const u of (s.ams?.ams || [])) for (const t of (u.tray || [])) if (t.tray_type) ams.push({ slot: `${u.id}-${t.id}`, material: t.tray_type, color: t.tray_color, remain_pct: t.remain }) } catch { /* */ }
  const hms = Array.isArray(s.hms) && s.hms.length ? s.hms[0] : null
  const lr = Array.isArray(s.lights_report) ? s.lights_report : null
  const light_on = lr ? lr.some(l => l && l.mode === 'on') : undefined
  return {
    serial: p.serial, online: !!connected[p.serial],
    state: connected[p.serial] ? (STATE_MAP[s.gcode_state] || 'idle') : 'offline',
    job_name: s.subtask_name || s.gcode_file || null,
    progress_pct: s.mc_percent ?? null, remaining_minutes: s.mc_remaining_time ?? null,
    layer_current: s.layer_num ?? null, layer_total: s.total_layer_num ?? null,
    nozzle_temp: s.nozzle_temper ?? null, bed_temp: s.bed_temper ?? null, ams,
    error_code: hms ? String(hms.code) : (s.print_error ? String(s.print_error) : null),
    error_text: hms ? `HMS ${hms.attr ?? ''}`.trim() : null,
    light_on,
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
  // download com timeout (arquivo .3mf pode ser grande e a conexão lenta) —
  // sem isso um download travado penduraria o comando pra sempre (status 'sent')
  const ac = new AbortController()
  const dlTimer = setTimeout(() => ac.abort(), 180000)
  let fileBuf
  try {
    const res = await fetch(payload.file_url, { signal: ac.signal })
    if (!res.ok) throw new Error(`download do arquivo falhou (HTTP ${res.status})`)
    fileBuf = Buffer.from(await res.arrayBuffer())
  } catch (e) { throw new Error(`download do .3mf falhou/expirou: ${e.message}`) } finally { clearTimeout(dlTimer) }
  const md5 = crypto.createHash('md5').update(fileBuf).digest('hex')   // firmware exige o md5 do arquivo
  fs.writeFileSync(tmp, fileBuf)
  const ftp = new Client(15000)
  try {
    await ftp.access({ host: p.ip, port: 990, user: 'bblp', password: p.access_code, secure: 'implicit', secureOptions: { rejectUnauthorized: false } })
    await ftp.uploadFrom(tmp, name)
  } finally { ftp.close(); try { fs.unlinkSync(tmp) } catch { /* */ } }
  const amsMap = Array.isArray(payload.ams_mapping) && payload.ams_mapping.length > 0 ? payload.ams_mapping : null
  // impressora sem AMS (rolo externo): o backend manda use_ams=false — repassar
  // true pra ela deixaria a máquina parada pedindo filamento do AMS que não existe
  const useAms = payload.use_ams !== false
  publishCmd(serial, {
    print: {
      // arquivo do auto-slicing pode ser de outro prato (projeto multi-peça)
      sequence_id: '0', command: 'project_file', param: payload.gcode_param || 'Metadata/plate_1.gcode',
      subtask_name: name.replace(/\.(gcode\.)?3mf$/i, ''), url: `file:///mnt/sdcard/${name}`, md5,
      bed_type: 'auto', timelapse: false, bed_leveling: true, flow_cali: false,
      vibration_cali: false, layer_inspect: false, use_ams: useAms,
      ...(useAms && amsMap ? { ams_mapping: amsMap } : {}),   // imprime no slot/cor escolhido
      profile_id: '0', project_id: '0', subtask_id: '0', task_id: '0',
    },
  })
}

// ── fatiamento automático (Bambu Studio CLI instalado no PC da farm) ─
const STUDIO_EXE = cfg.bambu_studio_exe || 'C:\\Program Files\\Bambu Studio\\bambu-studio.exe'
const PROFILES_DIR = cfg.bambu_profiles_dir || path.join(path.dirname(STUDIO_EXE), 'resources', 'profiles', 'BBL')
// Sem isso o CLI assume "Cool Plate" e o G-code sai com mesa 35°C (M190 S35) —
// PLA descola da PEI texturizada da A1, que precisa das temps "textured" do
// perfil do filamento (65°C PLA). A flag escolhe a coluna certa pra QUALQUER material.
const BED_TYPE = cfg.bed_type || 'Textured PEI Plate'
let slicing = false

// Os perfis oficiais usam herança ("inherits") que o CLI NÃO resolve sozinho —
// sem achatar, densidade/temperatura saem genéricas (bico 200 em vez de 220).
// E o start/end/troca-de-filamento gcode NÃO mora no inherits: mora em arquivos-
// irmãos apontados por "include" (que o CLI também não resolve num JSON avulso).
// Sem eles o machine_start_gcode cai no genérico do fdm_machine_common (estilo
// Ender: prime line em X10.1, bico 205) — SEM o `M620 S0A` que carrega o AMS →
// a A1 imprime A SECO e dá HMS 50336000 (parece falha física, é o arquivo).
// Resolver o include traz o start REAL da A1 (M620 M enable-remap + M620 S0A
// carga do AMS + preheat 25→220°C). O leaf entra por último, então o gcode dele
// vence o genérico herdado.
function flattenProfile(kind, name) {
  const chain = []; const seen = new Set(); let n = name
  while (n && !seen.has(n)) {
    seen.add(n)
    const f = path.join(PROFILES_DIR, kind, n + '.json')
    if (!fs.existsSync(f)) throw new Error(`perfil não encontrado: ${kind}/${n}`)
    const j = JSON.parse(fs.readFileSync(f)); chain.push(j); n = j.inherits || null
  }
  if (!chain.length) throw new Error(`perfil não encontrado: ${kind}/${name}`)
  const readInclude = inc => {
    const f = path.join(PROFILES_DIR, kind, inc + '.json')
    if (!fs.existsSync(f)) throw new Error(`include não encontrado: ${kind}/${inc}`)
    const ij = JSON.parse(fs.readFileSync(f))
    for (const k of ['name', 'type', 'instantiation', 'from']) delete ij[k]  // são do template, não do perfil
    return ij
  }
  let merged = {}
  for (const j of chain.reverse()) {
    merged = { ...merged, ...j }
    for (const inc of (j.include || [])) merged = { ...merged, ...readInclude(inc) }
  }
  delete merged.inherits; delete merged.include
  return merged
}

async function runSlice(job) {
  const t0 = Date.now()
  const tag = `slice ${String(job.id).slice(0, 8)}`
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclick-slice-'))
  const post = body => fetch(`${BACKEND}/product-os/farm/slice-result`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-farm-agent-token': TOKEN }, body: JSON.stringify(body),
  }).catch(() => {})
  try {
    console.log(`[${tag}] baixando ${job.source_name || 'modelo'}…`)
    const srcName = (job.source_name || 'model.stl').replace(/[^\w.\-]/g, '_')
    const src = path.join(dir, srcName)
    const ac = new AbortController(); const dl = setTimeout(() => ac.abort(), 180000)
    let buf
    try {
      const r = await fetch(job.source_url, { signal: ac.signal })
      if (!r.ok) throw new Error(`download do modelo falhou (HTTP ${r.status})`)
      buf = Buffer.from(await r.arrayBuffer())
    } finally { clearTimeout(dl) }
    fs.writeFileSync(src, buf)

    const args = []
    if (/\.(stl|obj)$/i.test(srcName)) {
      fs.writeFileSync(path.join(dir, 'machine.json'), JSON.stringify(flattenProfile('machine', job.machine_profile)))
      fs.writeFileSync(path.join(dir, 'process.json'), JSON.stringify(flattenProfile('process', job.process_profile)))
      fs.writeFileSync(path.join(dir, 'filament.json'), JSON.stringify(flattenProfile('filament', job.filament_profile)))
      args.push('--load-settings', `${path.join(dir, 'machine.json')};${path.join(dir, 'process.json')}`,
        '--load-filaments', path.join(dir, 'filament.json'), '--orient', '1', '--arrange', '1',
        '--curr-bed-type', BED_TYPE)
    }
    // projeto .3mf: fatia com as configurações embutidas (o designer já preparou)
    args.push('--slice', String(job.plate || 1), '--export-3mf', 'out.gcode.3mf', '--outputdir', dir, src)
    console.log(`[${tag}] fatiando…`)
    await new Promise((resolve, reject) => {
      execFile(STUDIO_EXE, args, { timeout: 15 * 60000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        err => err ? reject(new Error(`bambu-studio falhou: ${err.message}`)) : resolve(null))
    })
    const outFile = path.join(dir, 'out.gcode.3mf')
    if (!fs.existsSync(outFile)) throw new Error('o fatiamento não gerou arquivo de saída')
    const meta = { duration_ms: Date.now() - t0 }
    try {
      const rj = JSON.parse(fs.readFileSync(path.join(dir, 'result.json')))
      const p = (rj.sliced_plates || [])[0] || {}
      meta.prediction_s = Math.round(p.total_predication || 0)
      meta.plate_id = Number(p.id) >= 1 ? Number(p.id) : (Number(job.plate) || 1)   // qual prato virou G-code (projeto multi-peça)
      meta.filaments = (p.filaments || []).map(f => ({ id: f.id, filament_id: f.filament_id, used_g: Math.round((f.total_used_g || 0) * 100) / 100 }))
    } catch { /* segue sem meta fina */ }
    console.log(`[${tag}] subindo resultado…`)
    const up = await fetch(job.upload_url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: fs.readFileSync(outFile) })
    if (!up.ok) throw new Error(`upload do fatiado falhou (HTTP ${up.status})`)
    await post({ job_id: job.id, ok: true, meta })
    console.log(`[${tag}] ok em ${Math.round((Date.now() - t0) / 1000)}s (impressão prevista: ${meta.prediction_s ?? '?'}s)`)
  } catch (e) {
    console.log(`[${tag}] FALHOU: ${e.message}`)
    await post({ job_id: job.id, ok: false, error: e.message })
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* */ }
  }
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
    // backend manda a config de vigilância por impressora → aplica se mudou
    for (const [serial, dc] of Object.entries(data.detection_config || {})) { detectionCfg[serial] = dc; applyDetection(serial) }
    for (const cmd of (data.commands || [])) await runCommand(cmd)
    // fatiamento: 1 por vez (CPU pesada); roda em paralelo ao loop de telemetria
    for (const job of (data.slice_jobs || [])) {
      if (slicing) break
      slicing = true
      runSlice(job).finally(() => { slicing = false })
    }
  } catch (e) { console.log(`[push] ${e.message}`) }
}

// ── câmera: captura 1 frame JPEG da impressora (TLS porta 6000 + access code) ──
function grabFrame(p) {
  return new Promise(resolve => {
    let done = false
    const fin = v => { if (done) return; done = true; try { sock.destroy() } catch { /* */ } resolve(v) }
    const sock = tls.connect({ host: p.ip, port: 6000, rejectUnauthorized: false, timeout: 6000 }, () => {
      const b = Buffer.alloc(80)
      b.writeUInt32LE(0x40, 0); b.writeUInt32LE(0x3000, 4)
      Buffer.from('bblp').copy(b, 16); Buffer.from(String(p.access_code)).copy(b, 48)
      sock.write(b)
    })
    let buf = Buffer.alloc(0)
    sock.on('data', d => {
      buf = Buffer.concat([buf, d])
      const s = buf.indexOf(Buffer.from([0xff, 0xd8])); const e = s >= 0 ? buf.indexOf(Buffer.from([0xff, 0xd9]), s + 2) : -1
      if (s >= 0 && e > s) fin(buf.slice(s, e + 2))
    })
    sock.on('timeout', () => fin(null)); sock.on('error', () => fin(null))
    setTimeout(() => fin(null), 7000)
  })
}

let camTick = 0
let camBusy = false  // captura em andamento — o setInterval de 3s NÃO pode sobrepor
const camFail = {}   // serial -> nº de falhas seguidas de captura (pra não spammar o log)
async function pushCamera() {
  // Sem o guard, invocações sobrepostas (grabFrame leva até 7s/impressora) abriam
  // liveviews concorrentes E incrementavam camTick no MEIO do laço de outra invocação
  // → o `camTick % 10` das impressoras do fim da lista quase nunca batia (a 03 ficou
  // sem câmera pra sempre, sem nenhum erro). Snapshot do tick + reentrância resolvem.
  if (camBusy) return
  camBusy = true
  const tick = ++camTick
  try {
    for (const p of (cfg.printers || [])) {
      if (!connected[p.serial]) continue
      const st = STATE_MAP[(state[p.serial] || {}).gcode_state] || 'idle'
      const every = st === 'printing' ? 1 : 10   // imprimindo: ~3s; senão: ~30s
      if (tick % every !== 0) continue
      const frame = await grabFrame(p)
      if (!frame || frame.length < 1000) {
        // câmera não devolveu frame (porta 6000). Antes isso era silencioso → ficava
        // congelado sem ninguém perceber. Loga na 1ª falha e a cada ~30 tentativas.
        const n = (camFail[p.serial] = (camFail[p.serial] || 0) + 1)
        if (n === 1 || n % 30 === 0) console.log(`[cam] ${p.name}: sem frame da porta 6000 (${n}x seguidas) — verifique o LAN Live View / câmera da impressora`)
        continue
      }
      if (camFail[p.serial]) { console.log(`[cam] ${p.name}: câmera voltou (após ${camFail[p.serial]} falhas)`); camFail[p.serial] = 0 }
      try {
        const r = await fetch(`${BACKEND}/product-os/farm/camera`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-farm-agent-token': TOKEN },
          body: JSON.stringify({ serial: p.serial, image_base64: frame.toString('base64') }),
        })
        if (!r.ok) { console.log(`[cam] ${p.name}: backend recusou o frame (HTTP ${r.status})`); continue }
        // o backend responde 200 mesmo quando NÃO grava ({ok:false, reason}) — ler o corpo
        const j = await r.json().catch(() => null)
        if (j && j.ok === false) console.log(`[cam] ${p.name}: backend não gravou o frame — ${j.reason || 'sem motivo'}`)
      } catch (e) { console.log(`[cam] ${p.name}: falha ao enviar frame — ${e.message}`) }
    }
  } finally { camBusy = false }
}

console.log(`e-Click Farm Agent v${AGENT_VERSION} — ${(cfg.printers || []).length} impressora(s) → ${BACKEND}`)
;(cfg.printers || []).forEach(connectPrinter)
setInterval(push, PUSH_MS)
setInterval(pushCamera, 3000)
