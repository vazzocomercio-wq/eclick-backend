import { webcrypto } from 'crypto';
if (!globalThis.crypto) {
  (globalThis as any).crypto = webcrypto as Crypto;
}

import 'dotenv/config'
import { NestFactory } from '@nestjs/core';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { AppModule } from './app.module';

// Catch any unhandled rejection / uncaught exception so the log shows the
// real cause before Railway stops the container.
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err?.message ?? err)
  console.error(err?.stack)
})
process.on('unhandledRejection', (reason: any) => {
  console.error('[FATAL] Unhandled rejection:', reason?.message ?? reason)
  if (reason?.stack) console.error(reason.stack)
})

async function bootstrap() {
  const port = process.env.PORT ?? 3001;
  console.log(`[Bootstrap] NODE_ENV=${process.env.NODE_ENV} PORT=${port}`);
  console.log(`[Bootstrap] SUPABASE_URL=${process.env.SUPABASE_URL ? 'SET' : 'MISSING'}`);
  console.log(`[Bootstrap] SUPABASE_SECRET_KEY=${process.env.SUPABASE_SECRET_KEY ? 'SET' : 'MISSING'}`);
  console.log(`[Bootstrap] ML_CLIENT_ID=${process.env.ML_CLIENT_ID ? 'SET' : 'MISSING'}`);

  const app = await NestFactory.create(AppModule);
  app.useWebSocketAdapter(new IoAdapter(app));
  app.enableCors({
    origin: true,   // allow all origins — restrict after confirmed working
    credentials: true,
  });
  const numPort = parseInt(String(port), 10) || 3001;
  await app.listen(numPort, '0.0.0.0');
  console.log(`[Bootstrap] Listening on 0.0.0.0:${numPort}`);
}

bootstrap().catch((err) => {
  console.error('[Bootstrap] FATAL — app failed to start:', err?.message ?? err)
  console.error(err?.stack)
  process.exit(1)
});
