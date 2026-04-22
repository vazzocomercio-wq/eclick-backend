# eclick-backend

Backend do projeto eclick-saas, construído com NestJS.

## Tecnologias

- [NestJS](https://nestjs.com/)
- [TypeScript](https://www.typescriptlang.org/)
- [TypeORM](https://typeorm.io/) / [Prisma](https://www.prisma.io/)
- [PostgreSQL](https://www.postgresql.org/)
- [JWT](https://jwt.io/) para autenticação

## Estrutura de Pastas

```
eclick-backend/
├── src/
│   ├── modules/          # Módulos da aplicação (auth, users, etc.)
│   ├── common/           # Filtros, guards, interceptors, pipes
│   ├── config/           # Configurações da aplicação
│   └── main.ts           # Entry point
├── test/                 # Testes e2e
└── ...
```

## Instalação

```bash
npm install
```

## Desenvolvimento

```bash
npm run start:dev
```

API disponível em [http://localhost:3001](http://localhost:3001).

## Build

```bash
npm run build
npm run start:prod
```

## Testes

```bash
# unit tests
npm run test

# e2e tests
npm run test:e2e

# test coverage
npm run test:cov
```

## Variáveis de Ambiente

Copie `.env.example` para `.env` e preencha os valores.

```bash
cp .env.example .env
```
