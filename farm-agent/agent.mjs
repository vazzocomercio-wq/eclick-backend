// e-Click Farm Agent — roda na rede local da fábrica.
// Lê o MQTT (LAN) das impressoras Bambu, envia o status pro e-Click e
// executa comandos (pausar/retomar/parar/luz/velocidade/temperaturas/ventoinha/
// eixos/extrusão/AMS/calibração/limpar erro/G-code; enviar impressão).
// Node 18+ (fetch nativo). Dependências: mqtt, basic-ftp.
import mqtt from 'mqtt'
import tls from 'node:tls'
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

const cfg = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url)))
const BACKEND = String(cfg.backend_url || '').replace(/\/+$/, '')
const TOKEN = cfg.agent_token
const PUSH_MS = (Number(cfg.push_interval_sec) || 5) * 1000
const AGENT_VERSION = '1.5.0'

if (!BACKEND || !TOKEN) { console.error('Falta backend_url ou agent_token no config.json'); process.exit(1) }

const state = {}        // serial -> objeto "print" mesclado
const connected = {}    // serial -> bool
const clients = {}      // serial -> cliente mqtt
const acks = []         // [{ id, ok, result }] pendentes de envio
const detectionCfg = {}     // serial -> { enabled, sensitivity } (vem do backend)
const detectionApplied = {} // serial -> assinatura já aplicada (evita reenviar)
const pushallTimers = {}    // serial -> setInterval do pushall (limpar ao reconectar)

const STATE_MAP = { RUNNING: 'printing', PAUSE: 'paused', FAILED: 'error', FINISH: 'finished', IDLE: 'idle', PREPARE: 'printing', SLICING: 'printing' }   // FINISH = terminou e a peça ainda está na mesa (até confirmar na tela da impressora)

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
  if (pushallTimers[p.serial]) clearInterval(pushallTimers[p.serial])
  pushallTimers[p.serial] = setInterval(() => { if (connected[p.serial]) { pushall(); detectionApplied[p.serial] = null; applyDetection(p.serial) } }, 30000)
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
    // estado dos controles (velocidade, alvos de temperatura, ventoinhas) — vai em printer_status.raw
    raw: {
      controls: {
        speed_level: num(s.spd_lvl), speed_pct: num(s.spd_mag),
        nozzle_target: num(s.nozzle_target_temper), bed_target: num(s.bed_target_temper),
        fan_part_pct: fanPct(s.cooling_fan_speed), fan_aux_pct: fanPct(s.big_fan1_speed), fan_chamber_pct: fanPct(s.big_fan2_speed),
        tray_now: s.ams?.tray_now ?? null,
        agent_version: AGENT_VERSION,
        commands: SUPPORTED_COMMANDS,
      },
    },
  }
}
function num(v) { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? null : n }
// a Bambu reporta ventoinha em 0..15 (string) → %
function fanPct(v) { const n = num(v); return n == null ? null : Math.round(n / 15 * 100) }

// ── execução de comandos vindos do e-Click ──────────────────────────
function publishCmd(serial, obj) { const c = clients[serial]; if (!c) throw new Error('impressora não conectada'); c.publish(`device/${serial}/request`, JSON.stringify(obj)) }

// Comandos de máquina = os mesmos que o Bambu Studio / app Handy mandam pelo MQTT (LAN).
// Os que MOVEM a máquina (home, mover eixo, extrudar, calibrar, carregar/descarregar
// filamento) só rodam com a impressora parada — o agente recusa se estiver imprimindo.
const SUPPORTED_COMMANDS = ['pause', 'resume', 'stop', 'light_on', 'light_off', 'speed', 'nozzle_temp', 'bed_temp',
  'fan', 'home', 'move', 'extrude', 'ams_load', 'ams_unload', 'calibrate', 'clean_error', 'gcode', 'print']
const gcode = (serial, line) => publishCmd(serial, { print: { sequence_id: '0', command: 'gcode_line', param: line.endsWith('\n') ? line : line + '\n' } })
const liveState = serial => STATE_MAP[(state[serial] || {}).gcode_state] || 'idle'
function requireStopped(serial, what) {
  const st = liveState(serial)
  if (st === 'printing' || st === 'paused') throw new Error(`${what}: só com a impressora parada (agora: ${st})`)
}
function clampNum(v, lo, hi, what) {
  const n = Number(v)
  if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${what} inválido (${v}); faixa ${lo}–${hi}`)
  return n
}

async function runCommand(cmd) {
  const { id, serial, command_type, payload = {} } = cmd
  try {
    const s = state[serial] || {}
    if (command_type === 'pause') publishCmd(serial, { print: { sequence_id: '0', command: 'pause' } })
    else if (command_type === 'resume') publishCmd(serial, { print: { sequence_id: '0', command: 'resume' } })
    else if (command_type === 'stop') publishCmd(serial, { print: { sequence_id: '0', command: 'stop' } })
    else if (command_type === 'light_on') publishCmd(serial, { system: { sequence_id: '0', command: 'ledctrl', led_node: 'chamber_light', led_mode: 'on', led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 } })
    else if (command_type === 'light_off') publishCmd(serial, { system: { sequence_id: '0', command: 'ledctrl', led_node: 'chamber_light', led_mode: 'off', led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 } })
    // velocidade: 1 silencioso (50%) · 2 padrão (100%) · 3 esporte (124%) · 4 ludicrous (166%)
    else if (command_type === 'speed') publishCmd(serial, { print: { sequence_id: '0', command: 'print_speed', param: String(clampNum(payload.level, 1, 4, 'nível de velocidade')) } })
    else if (command_type === 'nozzle_temp') gcode(serial, `M104 S${Math.round(clampNum(payload.temp, 0, 300, 'temperatura do bico'))}`)
    else if (command_type === 'bed_temp') gcode(serial, `M140 S${Math.round(clampNum(payload.temp, 0, 110, 'temperatura da mesa'))}`)
    else if (command_type === 'fan') {
      // P1 = ventoinha da peça · P2 = auxiliar · P3 = câmara (a A1 só tem a da peça)
      const P = { part: 1, aux: 2, chamber: 3 }[payload.which || 'part']
      if (!P) throw new Error(`ventoinha desconhecida: ${payload.which}`)
      const pct = clampNum(payload.pct, 0, 100, 'ventoinha %')
      gcode(serial, `M106 P${P} S${Math.round(pct / 100 * 255)}`)
    }
    else if (command_type === 'home') { requireStopped(serial, 'Home'); gcode(serial, 'G28') }
    else if (command_type === 'move') {
      requireStopped(serial, 'Mover eixo')
      const axis = String(payload.axis || '').toUpperCase()
      if (!['X', 'Y', 'Z'].includes(axis)) throw new Error(`eixo inválido: ${payload.axis}`)
      const mm = clampNum(payload.mm, -100, 100, 'distância (mm)')
      const F = axis === 'Z' ? 600 : 3000
      // mesma sequência do Bambu Studio (limites de software + modo relativo)
      gcode(serial, `M211 S\nM211 X1 Y1 Z1\nM1002 push_ref_mode\nG91\nG1 ${axis}${mm.toFixed(1)} F${F}\nM1002 pop_ref_mode\nM211 R\n`)
    }
    else if (command_type === 'extrude') {
      requireStopped(serial, 'Extrudar')
      const mm = clampNum(payload.mm, -50, 50, 'extrusão (mm)')
      if (num(s.nozzle_temper) != null && num(s.nozzle_temper) < 170) throw new Error(`bico frio (${Math.round(s.nozzle_temper)}°C) — aqueça a 170°C+ antes de extrudar`)
      gcode(serial, `M83\nG0 E${mm.toFixed(1)} F900\n`)
    }
    else if (command_type === 'ams_unload' || command_type === 'ams_load') {
      requireStopped(serial, command_type === 'ams_load' ? 'Carregar filamento' : 'Descarregar filamento')
      const tar = Math.round(clampNum(payload.temp ?? 220, 170, 300, 'temperatura'))
      // target: 0..3 = slot do AMS (ams_id*4+slot) · 254 = rolo externo · 255 = descarregar
      const target = command_type === 'ams_unload' ? 255 : Math.round(clampNum(payload.slot, 0, 254, 'slot'))
      publishCmd(serial, { print: { sequence_id: '0', command: 'ams_change_filament', target, curr_temp: Math.round(num(s.nozzle_temper) ?? 0), tar_temp: tar,
        ...(target < 254 ? { ams_id: Math.floor(target / 4), slot_id: target % 4 } : target === 254 ? { ams_id: 255, slot_id: 0 } : {}) } })
    }
    else if (command_type === 'calibrate') {
      requireStopped(serial, 'Calibrar')
      // bits = os do Studio: 0 lidar/micro-lidar · 1 nivelamento · 2 vibração · 3 ruído do motor
      let option = 0
      if (payload.bed_leveling !== false) option |= 1 << 1
      if (payload.vibration) option |= 1 << 2
      if (payload.motor_noise) option |= 1 << 3
      if (!option) throw new Error('escolha pelo menos uma calibração')
      publishCmd(serial, { print: { sequence_id: '0', command: 'calibration', option } })
    }
    else if (command_type === 'clean_error') {
      publishCmd(serial, { print: { sequence_id: '0', command: 'clean_print_error', subtask_id: String(s.subtask_id ?? '0'), print_error: Number(s.print_error) || 0 } })
    }
    else if (command_type === 'gcode') {
      const line = String(payload.line || '').trim()
      if (!line) throw new Error('G-code vazio')
      if (line.length > 2000) throw new Error('G-code longo demais (máx 2000 caracteres)')
      gcode(serial, line)
    }
    else if (command_type === 'print') {
      // última linha de defesa contra envio duplo: se a máquina já está
      // rodando/pausada (telemetria MQTT local), recusa em vez de atropelar
      const st = STATE_MAP[(state[serial] || {}).gcode_state] || 'idle'
      if (st === 'printing' || st === 'paused') throw new Error(`impressora ocupada (${st}) — print duplicado bloqueado no agente`)
      await dispatchPrint(serial, payload)
    }
    else throw new Error(`comando desconhecido: ${command_type}`)
    acks.push({ id, ok: true, result: 'ok' })
    console.log(`[cmd ${command_type}] ${serial} → ok`)
  } catch (e) {
    acks.push({ id, ok: false, result: e.message })
    console.log(`[cmd ${command_type}] ${serial} → falhou: ${e.message}`)
  }
}

// fila de comandos FORA do ciclo de telemetria: um print (download+FTP demorado)
// não pode atrasar o push nem sobrepor ciclos (era o gatilho da entrega dupla).
// Dedupe por id segura redelivery de corrida antiga no backend.
const cmdQueue = []
const cmdSeen = new Set()
let cmdBusy = false
function enqueueCmds(cmds) {
  for (const c of cmds || []) {
    if (!c?.id || cmdSeen.has(c.id)) continue
    cmdSeen.add(c.id)
    if (cmdSeen.size > 500) cmdSeen.delete(cmdSeen.values().next().value)
    cmdQueue.push(c)
  }
  void drainCmds()
}
async function drainCmds() {
  if (cmdBusy) return
  cmdBusy = true
  try { while (cmdQueue.length) await runCommand(cmdQueue.shift()) }
  finally { cmdBusy = false }
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
    enqueueCmds(data.commands)
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

// ── Auto-descoberta de IP (o DHCP troca o IP; o serial é fixo) ───────────────
// Quando uma impressora não conecta no IP conhecido, varremos a LAN atrás de
// hosts com a porta 8883 (MQTT Bambu) aberta e identificamos cada um pelo
// access_code (cada máquina só aceita o seu). Achou → reconecta no IP novo e
// grava de volta no config.json. Assim o agente se autocorrige sem intervenção.

// base /24 da rede local; prefere a interface que casa com os IPs do config.
function localSubnetBase() {
  const cfgBase = (cfg.printers || []).map(p => String(p.ip || '').split('.').slice(0, 3).join('.')).find(Boolean)
  const bases = []
  const ifs = os.networkInterfaces()
  for (const name of Object.keys(ifs)) for (const a of ifs[name] || []) {
    if (a.family === 'IPv4' && !a.internal) bases.push(a.address.split('.').slice(0, 3).join('.'))
  }
  if (cfgBase && bases.includes(cfgBase)) return cfgBase
  return bases[0] || cfgBase || null
}

// TCP connect só pra ver se a porta está aberta (não faz TLS handshake).
function portOpen(ip, port, timeout = 700) {
  return new Promise(res => {
    const s = new net.Socket()
    let done = false
    const fin = v => { if (done) return; done = true; try { s.destroy() } catch { /* */ } res(v) }
    s.setTimeout(timeout)
    s.once('connect', () => fin(true))
    s.once('timeout', () => fin(false))
    s.once('error', () => fin(false))
    s.connect(port, ip)
  })
}

// tenta um access_code contra um IP; sucesso = aquela máquina está nesse IP.
function mqttProbe(ip, access_code, timeout = 6000) {
  return new Promise(res => {
    const c = mqtt.connect(`mqtts://${ip}:8883`, {
      username: 'bblp', password: access_code, rejectUnauthorized: false,
      reconnectPeriod: 0, connectTimeout: timeout,
      clientId: `disc-${Math.floor(Date.now() / 1000)}-${Math.random().toString(16).slice(2)}`,
    })
    let done = false
    const fin = v => { if (done) return; done = true; try { c.end(true) } catch { /* */ } res(v) }
    c.on('connect', () => fin(true))
    c.on('error', () => fin(false))
    setTimeout(() => fin(false), timeout + 1000)
  })
}

let persistTimer = null
function persistConfig() {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    try {
      fs.writeFileSync(new URL('./config.json', import.meta.url), JSON.stringify(cfg, null, 2) + '\n')
      console.log('[disc] config.json atualizado com os IPs novos')
    } catch (e) { console.log(`[disc] falha ao gravar config.json: ${e.message}`) }
  }, 1500)
}

function reconnectPrinter(p, newIp) {
  const old = clients[p.serial]
  if (old) { try { old.end(true) } catch { /* */ } }
  connected[p.serial] = false
  console.log(`[disc] ${p.name}: IP mudou ${p.ip} -> ${newIp}; reconectando`)
  p.ip = newIp
  connectPrinter(p)
  persistConfig()
}

let discovering = false
async function discoverMissing() {
  if (discovering) return
  const missing = (cfg.printers || []).filter(p => !connected[p.serial])
  if (!missing.length) return
  discovering = true
  try {
    const base = localSubnetBase()
    if (!base) { console.log('[disc] sem interface IPv4 pra varrer'); return }
    console.log(`[disc] ${missing.length} impressora(s) offline; varrendo ${base}.0/24…`)
    // 1) IPs com 8883 aberta (em lotes pra não abrir 254 sockets de vez)
    const ips = Array.from({ length: 254 }, (_, k) => `${base}.${k + 1}`)
    const open = []
    const CONC = 32
    for (let i = 0; i < ips.length; i += CONC) {
      const rs = await Promise.all(ips.slice(i, i + CONC).map(ip => portOpen(ip, 8883).then(o => (o ? ip : null))))
      for (const ip of rs) if (ip) open.push(ip)
    }
    // 2) ignorar IPs já ocupados por impressoras conectadas
    const used = new Set((cfg.printers || []).filter(p => connected[p.serial]).map(p => p.ip))
    const cand = open.filter(ip => !used.has(ip))
    // 3) casar cada candidato com uma impressora faltante pelo access_code
    for (const ip of cand) {
      for (const p of missing) {
        if (connected[p.serial]) continue
        if (await mqttProbe(ip, p.access_code)) { reconnectPrinter(p, ip); break }
      }
    }
    const still = (cfg.printers || []).filter(p => !connected[p.serial])
    if (still.length) console.log(`[disc] ainda offline: ${still.map(p => p.name).join(', ')} (impressora desligada, fora da rede ou LAN Mode off?)`)
  } catch (e) { console.log(`[disc] erro na varredura: ${e.message}`) } finally { discovering = false }
}

console.log(`e-Click Farm Agent v${AGENT_VERSION} — ${(cfg.printers || []).length} impressora(s) → ${BACKEND}`)
;(cfg.printers || []).forEach(connectPrinter)
setInterval(push, PUSH_MS)
setInterval(pushCamera, 3000)
setTimeout(discoverMissing, 20000)   // 1ª varredura após dar tempo do MQTT conectar no IP conhecido
setInterval(discoverMissing, 60000)  // barato: só varre se houver alguma offline
