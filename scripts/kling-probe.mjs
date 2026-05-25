// Diagnóstico: descobre quais model_name o Kling aceita HOJE.
// A API valida o model_name ANTES do saldo:
//   code 1201 "model_name ... is invalid"  → nome INVÁLIDO
//   code 1102 "Account balance not enough" → nome VÁLIDO (só falta crédito)
//   code 0    + task_id                    → nome VÁLIDO e gerou (gasta crédito!)
// Submete cada modelo com um PNG sólido 9:16 gerado em memória (sem dep externa).
// Uso: KLING_ACCESS_KEY=.. KLING_SECRET_KEY=.. node scripts/kling-probe.mjs
import { createHmac } from 'node:crypto'
import zlib from 'node:zlib'

const BASE = process.env.KLING_API_BASE ?? 'https://api-singapore.klingai.com'
const ACCESS = process.env.KLING_ACCESS_KEY
const SECRET = process.env.KLING_SECRET_KEY
if (!ACCESS || !SECRET) { console.error('faltam KLING_ACCESS_KEY/KLING_SECRET_KEY'); process.exit(1) }

// Modelos expostos na UI (devem voltar 1102 = válidos) + alguns candidatos de sanidade.
const MODELS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['kling-v2-6', 'kling-v2-5-turbo', 'kling-v2-1', 'kling-v1-6', 'kling-v2-1-master']

function b64url(s) { return Buffer.from(s).toString('base64url') }
function signJwt() {
  const now = Math.floor(Date.now() / 1000)
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const p = b64url(JSON.stringify({ iss: ACCESS, exp: now + 1800, nbf: now - 5 }))
  const sig = createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')
  return `${h}.${p}.${sig}`
}

let CRC_TABLE
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = []
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c }
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c ^ 0xffffffff
}
function makePng(w, h, rgb = [128, 128, 128]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: w }, () => Buffer.from(rgb)))])
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64')
}

const IMG = makePng(720, 1280)

async function probe(model) {
  const body = { model_name: model, image: IMG, prompt: 'product showcase, gentle camera move', duration: '5', aspect_ratio: '9:16', cfg_scale: 0.5 }
  const res = await fetch(`${BASE}/v1/videos/image2video`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${signJwt()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await res.json().catch(() => ({}))
  return { model, http: res.status, code: j.code, message: j.message, taskId: j?.data?.task_id }
}

for (const m of MODELS) {
  const r = await probe(m)
  const valid = r.code === 0 || r.code === 1102 // 1102 = saldo (nome aceito)
  const verdict = r.taskId ? `VALID ✓ (task ${r.taskId})` : `${valid ? 'VALID ✓' : 'INVALID ✗'} code=${r.code} "${r.message}"`
  console.log(`${m.padEnd(20)} → http=${r.http} ${verdict}`)
}
