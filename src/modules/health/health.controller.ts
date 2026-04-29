import { Controller, Get } from '@nestjs/common'
import axios from 'axios'
import { Public } from '../../common/decorators/public.decorator'

/** Health endpoints públicos. /health/egress-ip retorna o IP outbound
 * do Railway (via api.ipify.org) — usado pra whitelist em provedores de
 * enrichment (DirectData, DataStone, etc) que checam IP de origem. */
@Controller('health')
export class HealthController {
  @Get('egress-ip')
  @Public()
  async getEgressIp(): Promise<{ ip?: string; error?: string; timestamp: string }> {
    try {
      const { data } = await axios.get<{ ip: string }>(
        'https://api.ipify.org?format=json',
        { timeout: 5_000 },
      )
      return { ip: data.ip, timestamp: new Date().toISOString() }
    } catch {
      return { error: 'failed to fetch IP', timestamp: new Date().toISOString() }
    }
  }
}
