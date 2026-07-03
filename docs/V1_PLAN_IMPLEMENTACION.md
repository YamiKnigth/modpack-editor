# CraftForge Web - Plan de implementacion V1

## Fase 1 - Fundaciones (Dia 1-2)

Objetivo: dejar entorno operativo y contratos congelados.

Entregables:

- OpenAPI base implementada en backend con stubs.
- Migracion docs/sql/001_init.sql aplicada en local.
- Docker Compose funcional con postgres y redis.
- Healthcheck de API y worker.

Definition of done:

- GET /healthz devuelve 200.
- DB contiene tablas modpacks, modpack_mods, export_jobs, outbox_export_jobs.

## Fase 2 - Modpacks y busqueda (Dia 3-4)

Objetivo: CRUD basico y proxy de busqueda.

Entregables:

- Crear/listar/ver/eliminar modpacks.
- Endpoint /api/v1/mods/search integrado a CurseForge.
- Cache Redis para busquedas (TTL 24h).

Definition of done:

- Flujo UI: crear modpack -> buscar mods -> ver resultados paginados.

## Fase 3 - Alta de mods con dependencias (Dia 5-6)

Objetivo: resolver grafo de required dependencies.

Entregables:

- Endpoint POST /api/v1/modpacks/{modpackId}/mods.
- Algoritmo recursivo con visited y depth limit.
- Guardado de padre_proyecto_id y es_dependencia.

Definition of done:

- Agregar un mod conocido con dependencias guarda arbol sin duplicados.

## Fase 4 - Exportacion asincrona (Dia 7-8)

Objetivo: generar ZIP por target sin bloquear request.

Entregables:

- POST /api/v1/modpacks/{modpackId}/exports (202).
- Worker consumidor de cola.
- GET /api/v1/exports/{jobId} y /download.
- Limpieza de scratch por TTL.

Definition of done:

- Job termina en completed y ZIP se descarga correctamente.

## Fase 5 - Endurecimiento y QA (Dia 9-10)

Objetivo: estabilidad para uso real personal.

Entregables:

- Manejo estandar de errores.
- Logs estructurados.
- Pruebas integracion minimas de flujos E2E.

Definition of done:

- Flujo completo pasa en local y en despliegue tipo Coolify.
