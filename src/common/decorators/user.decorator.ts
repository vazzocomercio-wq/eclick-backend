import { createParamDecorator, ExecutionContext } from '@nestjs/common'

export const ReqUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().reqUser,
)
