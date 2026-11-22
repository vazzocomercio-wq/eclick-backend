import { BadRequestException } from '@nestjs/common'

/**
 * Comandos que a tela pode mandar pra uma impressora da farm. São os mesmos que o
 * Bambu Studio / app Handy mandam pelo MQTT LAN; o agente local (farm-agent ≥ 1.5.0)
 * traduz cada um. 'print' NÃO entra aqui — só sai pelo envio de OP (tem guardas próprias).
 *
 * Valida e normaliza o payload ANTES de enfileirar: o agente revalida, mas um valor
 * absurdo (bico a 900 °C) não pode nem chegar na fila.
 */
export const FARM_UI_COMMANDS = [
  'pause', 'resume', 'stop', 'light_on', 'light_off',
  'speed', 'nozzle_temp', 'bed_temp', 'fan', 'home', 'move', 'extrude',
  'ams_load', 'ams_unload', 'calibrate', 'clean_error', 'gcode',
] as const

/** O que qualquer agente (mesmo < 1.5.0) já sabe executar. */
export const FARM_LEGACY_COMMANDS: readonly string[] = ['pause', 'resume', 'stop', 'light_on', 'light_off', 'print']

/** Compara versão semver simples ("1.4.8" ≥ "1.5.0"?). Versão ausente = falso. */
export function agentAtLeast(v: string | null | undefined, min: string): boolean {
  if (!v) return false
  const a = v.split('.').map(x => parseInt(x, 10) || 0), b = min.split('.').map(x => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0) }
  return true
}

function num(v: unknown, lo: number, hi: number, what: string): number {
  const n = Number(v)
  if (v === null || v === undefined || v === '' || !Number.isFinite(n) || n < lo || n > hi) {
    throw new BadRequestException(`${what} inválido — use entre ${lo} e ${hi}`)
  }
  return n
}

export function validateFarmCommand(type: unknown, payload: Record<string, unknown>): Record<string, unknown> {
  if (typeof type !== 'string' || !(FARM_UI_COMMANDS as readonly string[]).includes(type)) throw new BadRequestException('Comando inválido')
  const p = payload ?? {}
  switch (type) {
    case 'speed': return { level: Math.round(num(p.level, 1, 4, 'Nível de velocidade')) }
    case 'nozzle_temp': return { temp: Math.round(num(p.temp, 0, 300, 'Temperatura do bico')) }
    case 'bed_temp': return { temp: Math.round(num(p.temp, 0, 110, 'Temperatura da mesa')) }
    case 'fan': {
      const which = (p.which ?? 'part') as string
      if (!['part', 'aux', 'chamber'].includes(which)) throw new BadRequestException('Ventoinha inválida')
      return { which, pct: Math.round(num(p.pct, 0, 100, 'Ventoinha (%)')) }
    }
    case 'move': {
      const axis = String(p.axis ?? '').toUpperCase()
      if (!['X', 'Y', 'Z'].includes(axis)) throw new BadRequestException('Eixo inválido (X, Y ou Z)')
      const mm = num(p.mm, -100, 100, 'Distância (mm)')
      if (mm === 0) throw new BadRequestException('Distância não pode ser zero')
      return { axis, mm }
    }
    case 'extrude': {
      const mm = num(p.mm, -50, 50, 'Extrusão (mm)')
      if (mm === 0) throw new BadRequestException('Extrusão não pode ser zero')
      return { mm }
    }
    case 'ams_load': return { slot: Math.round(num(p.slot, 0, 254, 'Slot')), temp: Math.round(num(p.temp ?? 220, 170, 300, 'Temperatura')) }
    case 'ams_unload': return { temp: Math.round(num(p.temp ?? 220, 170, 300, 'Temperatura')) }
    case 'calibrate': {
      const out = { bed_leveling: p.bed_leveling !== false, vibration: p.vibration === true, motor_noise: p.motor_noise === true }
      if (!out.bed_leveling && !out.vibration && !out.motor_noise) throw new BadRequestException('Escolha pelo menos uma calibração')
      return out
    }
    case 'gcode': {
      const line = String(p.line ?? '').trim()
      if (!line) throw new BadRequestException('G-code vazio')
      if (line.length > 2000) throw new BadRequestException('G-code longo demais (máx 2000 caracteres)')
      return { line }
    }
    default: return {}
  }
}
