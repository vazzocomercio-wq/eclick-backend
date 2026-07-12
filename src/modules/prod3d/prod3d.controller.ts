import { Controller, Get, Post, Patch, Put, Delete, Body, Param, Query, Headers, UseGuards, BadRequestException } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { Public } from '../../common/decorators/public.decorator'
import { RequirePermission, RequirePermissionGuard } from '../rbac'
import { Prod3dService } from './prod3d.service'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * Custos de Produção 3D (custeio por absorção R$/g).
 * Leitura = financeiro.view; edição = financeiro.update_margin (custos de
 * produção são configuração financeira — mesmas permissions do módulo
 * financeiro, sem criar keys novas no RBAC).
 */
@Controller('prod3d')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class Prod3dController {
  constructor(private readonly svc: Prod3dService) {}

  private org(u: ReqUserPayload): string {
    if (!u.orgId) throw new BadRequestException('Usuário sem organização ativa.')
    return u.orgId
  }

  /** Tudo que a tela precisa: cadastros + KPIs + custo por SKU + auditoria. */
  @Get('dados')
  @RequirePermission('financeiro.view')
  dados(@ReqUser() u: ReqUserPayload) {
    return this.svc.dados(this.org(u))
  }

  @Get('historico')
  @RequirePermission('financeiro.view')
  historico(@ReqUser() u: ReqUserPayload, @Query('limit') limit?: string) {
    return this.svc.historico(this.org(u), limit ? Number(limit) : 50)
  }

  /** Simulador: custo de produção de 1 peça avulsa (g/h do fatiador). */
  @Post('peca')
  @RequirePermission('financeiro.view')
  async peca(@ReqUser() u: ReqUserPayload, @Body() b: { gramas: number; horas: number; material?: string; minutos_mo?: number }) {
    const d = await this.svc.loadAll(this.org(u))
    if (!(b?.gramas > 0) || !(b?.horas > 0)) throw new BadRequestException('Informe gramas e horas (> 0).')
    return this.svc.custoPeca(d, b.gramas, b.horas, (b.material ?? 'PLA').toUpperCase(), b.minutos_mo)
  }

  /** VIGIA local da impressora (sem login — autentica pela watchdog_key no
   * header). Repassa no WhatsApp a mensagem que a impressora deu. */
  @Public()
  @Post('alerta-impressora')
  alertaImpressora(
    @Headers('x-watchdog-key') key: string,
    @Body() b: { impressora?: string; evento?: string; mensagem: string },
  ) {
    return this.svc.alertaImpressora(key, b)
  }

  /** Configura o número que recebe os alertas (DDI+DDD+número). */
  @Patch('alerta')
  @RequirePermission('financeiro.update_margin')
  setAlerta(@ReqUser() u: ReqUserPayload, @Body() b: { whatsapp: string }) {
    return this.svc.setAlertaWhatsapp(this.org(u), u.id, b?.whatsapp ?? '')
  }

  /** Envia um alerta de teste pro número configurado. */
  @Post('alerta-teste')
  @RequirePermission('financeiro.view')
  alertaTeste(@ReqUser() u: ReqUserPayload) {
    return this.svc.alertaTeste(this.org(u))
  }

  /** IA: parágrafo executivo do custo de produção pra investidor/sócio. */
  @Post('explicar')
  @RequirePermission('financeiro.view')
  explicar(@ReqUser() u: ReqUserPayload) {
    return this.svc.explicarInvestidor(this.org(u))
  }

  @Patch('config')
  @RequirePermission('financeiro.update_margin')
  setConfig(@ReqUser() u: ReqUserPayload, @Body() b: { campo: string; valor: number }) {
    return this.svc.setConfig(this.org(u), u.id, b?.campo, Number(b?.valor))
  }

  @Post('impressoras')
  @RequirePermission('financeiro.update_margin')
  addImpressora(@ReqUser() u: ReqUserPayload, @Body() b: { modelo: string; quantidade?: number; valor_pago?: number; vida_util_horas?: number; potencia_ams_w?: number }) {
    return this.svc.addImpressora(this.org(u), u.id, b)
  }

  @Patch('impressoras/:id')
  @RequirePermission('financeiro.update_margin')
  setImpressora(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() b: { campo: string; valor: number }) {
    return this.svc.setImpressora(this.org(u), u.id, id, b?.campo, Number(b?.valor))
  }

  /** Upsert de potência por família de material — onde entra a medição da tomada medidora. */
  @Put('potencias')
  @RequirePermission('financeiro.update_margin')
  setPotencia(@ReqUser() u: ReqUserPayload, @Body() b: { impressora_id: string; material: string; watts: number; fonte?: string }) {
    return this.svc.setPotencia(this.org(u), u.id, { ...b, watts: Number(b?.watts) })
  }

  @Post('fixos')
  @RequirePermission('financeiro.update_margin')
  addFixo(@ReqUser() u: ReqUserPayload, @Body() b: { nome: string; valor_mensal: number; categoria?: string }) {
    return this.svc.addFixo(this.org(u), u.id, { ...b, valor_mensal: Number(b?.valor_mensal) })
  }

  @Patch('fixos/:id')
  @RequirePermission('financeiro.update_margin')
  setFixo(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() b: { valor_mensal: number }) {
    return this.svc.setFixo(this.org(u), u.id, id, Number(b?.valor_mensal))
  }

  @Delete('fixos/:id')
  @RequirePermission('financeiro.update_margin')
  rmFixo(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.rmFixo(this.org(u), u.id, id)
  }

  @Put('filamentos')
  @RequirePermission('financeiro.update_margin')
  setFilamento(@ReqUser() u: ReqUserPayload, @Body() b: { material: string; preco_kg: number }) {
    return this.svc.setFilamento(this.org(u), u.id, b?.material, Number(b?.preco_kg))
  }

  @Patch('embalagens/:id')
  @RequirePermission('financeiro.update_margin')
  setEmbalagem(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() b: { preco?: number; qtd_padrao?: number }) {
    return this.svc.setEmbalagem(this.org(u), u.id, id, {
      preco: b?.preco !== undefined ? Number(b.preco) : undefined,
      qtd_padrao: b?.qtd_padrao !== undefined ? Number(b.qtd_padrao) : undefined,
    })
  }

  @Post('skus')
  @RequirePermission('financeiro.update_margin')
  addSku(@ReqUser() u: ReqUserPayload, @Body() b: { sku: string; projeto?: string; gramas: number; horas: number; material?: string }) {
    return this.svc.addSku(this.org(u), u.id, { ...b, gramas: Number(b?.gramas), horas: Number(b?.horas) })
  }

  @Delete('skus/:id')
  @RequirePermission('financeiro.update_margin')
  rmSku(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.rmSku(this.org(u), u.id, id)
  }
}
