// e-Click Radar IA — utilitários dos coletores (eclick-workers).

export function radarLog(scope: string, ...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log(`[radar.${scope} ${new Date().toISOString()}]`, ...args)
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
