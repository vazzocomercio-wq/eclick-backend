import 'dotenv/config'
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const port = process.env.PORT ?? 3001;
  console.log(`[Bootstrap] NODE_ENV=${process.env.NODE_ENV} PORT=${port}`);
  console.log(`[Bootstrap] SUPABASE_URL=${process.env.SUPABASE_URL ? 'SET' : 'MISSING'}`);
  console.log(`[Bootstrap] SUPABASE_SECRET_KEY=${process.env.SUPABASE_SECRET_KEY ? 'SET' : 'MISSING'}`);
  console.log(`[Bootstrap] ML_CLIENT_ID=${process.env.ML_CLIENT_ID ? 'SET' : 'MISSING'}`);

  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: [
      'https://eclick.app.br',
      'https://eclick-frontend.netlify.app',
      'http://localhost:3000',
    ],
    credentials: true,
  });
  await app.listen(port);
  console.log(`[Bootstrap] App listening on port ${port}`);
}
bootstrap();
