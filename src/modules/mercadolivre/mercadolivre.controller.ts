import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common'
import { MercadolivreService } from './mercadolivre.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'

interface ReqUserPayload {
  id: string
  orgId: string | null
}

@Controller('ml')
@UseGuards(SupabaseAuthGuard)
export class MercadolivreController {
  constructor(private readonly ml: MercadolivreService) {}

  // GET /ml/auth-url?redirect_uri=...
  @Get('auth-url')
  getAuthUrl(@Query('redirect_uri') redirectUri: string) {
    return { url: this.ml.getAuthUrl(redirectUri) }
  }

  // POST /ml/connect  { code, redirect_uri }
  @Post('connect')
  @HttpCode(HttpStatus.OK)
  connect(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { code: string; redirect_uri: string },
  ) {
    return this.ml.connect(user.orgId!, body.code, body.redirect_uri)
  }

  // DELETE /ml/disconnect
  @Delete('disconnect')
  @HttpCode(HttpStatus.NO_CONTENT)
  disconnect(@ReqUser() user: ReqUserPayload) {
    return this.ml.disconnect(user.orgId!)
  }

  // GET /ml/status
  @Get('status')
  status(@ReqUser() user: ReqUserPayload) {
    return this.ml.getConnection(user.orgId!)
  }

  // GET /ml/item-info?url=...
  @Get('item-info')
  getItemInfo(
    @ReqUser() user: ReqUserPayload,
    @Query('url') url: string,
  ) {
    return this.ml.getItemInfo(user.orgId!, url)
  }

  // GET /ml/items?offset=0&limit=50
  @Get('items')
  getItems(
    @ReqUser() user: ReqUserPayload,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ) {
    return this.ml.getItems(user.orgId!, Number(offset ?? 0), Number(limit ?? 50))
  }

  // POST /ml/items/import  { ml_item_id }
  @Post('items/import')
  @HttpCode(HttpStatus.OK)
  importItem(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { ml_item_id: string },
  ) {
    return this.ml.importItem(user.orgId!, body.ml_item_id)
  }

  // GET /ml/orders?offset=0&limit=50
  @Get('orders')
  getOrders(
    @ReqUser() user: ReqUserPayload,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ) {
    return this.ml.getOrders(user.orgId!, Number(offset ?? 0), Number(limit ?? 50))
  }

  // GET /ml/metrics
  @Get('metrics')
  getMetrics(@ReqUser() user: ReqUserPayload) {
    return this.ml.getMetrics(user.orgId!)
  }
}
