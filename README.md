# modpack-editor

Implementacion V1 funcional de CraftForge Web (API + worker + UI basica + Docker).

## Documentacion inicial

- Alcance minimo V1: [docs/V1_ALCANCE_MINIMO.md](docs/V1_ALCANCE_MINIMO.md)
- Especificacion tecnica ejecutable V1: [docs/V1_ESPECIFICACION_TECNICA_EJECUTABLE.md](docs/V1_ESPECIFICACION_TECNICA_EJECUTABLE.md)
- OpenAPI V1: [docs/api/openapi-v1.yaml](docs/api/openapi-v1.yaml)
- SQL inicial: [docs/sql/001_init.sql](docs/sql/001_init.sql)
- Contrato de cola: [docs/contracts/export-job.schema.json](docs/contracts/export-job.schema.json)
- Plan de implementacion: [docs/V1_PLAN_IMPLEMENTACION.md](docs/V1_PLAN_IMPLEMENTACION.md)

## Stack implementado

- Backend: Node.js + TypeScript + Express
- Worker: BullMQ + Redis
- DB: PostgreSQL
- Cache/Broker: Redis
- UI V1: HTML/JS (nginx)
- Orquestacion: Docker Compose

## Ejecutar V1

Prerequisitos:

- Docker + Docker Compose
- Node.js 20+
- API key disponible en `secret.properties` (ya soportado por el backend)

### Opcion rapida

```bash
npm run bootstrap:v1
```

### Opcion manual

```bash
npm install
docker compose up -d --build database cache-broker backend-api queue-worker frontend
docker compose exec -T backend-api npm run migrate
curl -fsS http://localhost:3000/healthz
```

URLs:

- API: http://localhost:3000
- Frontend: http://localhost:8080

## Smoke test E2E

```bash
npm run smoke:v1
```

Este test valida:

- health
- crear modpack
- buscar mods en CurseForge
- agregar mod
- encolar export
- completar job
- descargar ZIP

## Endpoints V1 principales

- GET /healthz
- GET /api/v1/system/minecraft/versions
- GET /api/v1/system/minecraft/modloaders
- GET /api/v1/modpacks
- POST /api/v1/modpacks
- GET /api/v1/modpacks/{modpackId}
- DELETE /api/v1/modpacks/{modpackId}
- GET /api/v1/mods/search
- POST /api/v1/modpacks/{modpackId}/mods
- DELETE /api/v1/modpacks/{modpackId}/mods/{projectId}
- POST /api/v1/modpacks/{modpackId}/exports
- GET /api/v1/exports/{jobId}
- GET /api/v1/exports/{jobId}/download