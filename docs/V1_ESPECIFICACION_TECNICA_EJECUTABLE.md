# CraftForge Web - Especificacion tecnica ejecutable V1

## 1. Objetivo

Definir contratos tecnicos concretos para implementar V1 de punta a punta sin ambiguedad:

- API backend formalizada (OpenAPI)
- esquema de base de datos versionado (SQL)
- contrato de mensajes API -> worker
- flujos operativos con estados y errores

Artefactos fuente de verdad:

- OpenAPI: docs/api/openapi-v1.yaml
- SQL inicial: docs/sql/001_init.sql
- Contrato de cola: docs/contracts/export-job.schema.json

## 2. Arquitectura ejecutable

Servicios:

- frontend: UI web
- backend-api: HTTP API y proxy controlado a CurseForge
- queue-worker: descarga jars, arma zip y actualiza estado de job
- postgres: persistencia
- redis: cache de consultas CurseForge y broker de colas

Flujo de datos principal:

1. Frontend consume backend-api.
2. Backend-api consulta CurseForge con cache Redis.
3. Backend-api persiste modpacks/mods/jobs en PostgreSQL.
4. Backend-api publica trabajo de exportacion.
5. Queue-worker consume trabajo, descarga archivos y genera ZIP.
6. Queue-worker marca job como completed/failed.

## 3. Reglas tecnicas obligatorias V1

### 3.1 CurseForge

- Base URL: https://api.curseforge.com
- Header: x-api-key
- Max pageSize: 50
- Limite paginacion: index + pageSize <= 10000
- Dependencias requeridas: relationType = 3

### 3.2 Dependencias recursivas

- Usar conjunto visited por curseforge_project_id para evitar ciclos.
- Limite de profundidad configurable (default 20).
- Insertar dependencias con es_dependencia = true y padre_proyecto_id.
- Si el mod ya existe en modpack, no duplicar (constraint unique).

### 3.3 Exportacion

- API responde 202 de inmediato.
- Worker limita concurrencia de descarga a 3.
- Filtro por entorno:
  - CLIENT: excluye SERVER_ONLY
  - SERVER: excluye CLIENT_ONLY
  - BOTH: incluye todos
- Crear ZIP con carpeta mods/ en raiz.
- Limpieza de scratch por cron cada 15 min, TTL 120 min.

## 4. Estados de export job

- queued: creado y encolado
- running: worker en ejecucion
- completed: zip disponible
- failed: error terminal

Transiciones validas:

- queued -> running
- running -> completed
- running -> failed

## 5. Politica de errores API

Formato unico:

{
  "error": {
    "code": "STRING_CODE",
    "message": "Human readable"
  }
}

Codigos recomendados:

- 400: validacion o filtros invalidos
- 404: recurso inexistente
- 409: estado invalido (ej: descarga antes de completar job)
- 502: error aguas arriba de CurseForge
- 503: degradacion temporal de dependencias (redis/cf)

## 6. Configuracion de entorno minima

Backend API:

- PORT=3000
- DATABASE_URL=postgres://...
- REDIS_URL=redis://...
- CURSEFORGE_API_KEY=...
- CURSEFORGE_BASE_URL=https://api.curseforge.com
- CACHE_TTL_SECONDS=86400
- DEP_RESOLVE_MAX_DEPTH=20

Worker:

- DATABASE_URL=postgres://...
- REDIS_URL=redis://...
- WORKER_MAX_PARALLEL_DOWNLOADS=3
- SCRATCH_BASE_DIR=/app/scratch
- SCRATCH_TTL_MINUTES=120

## 7. Algoritmos de referencia

### 7.1 Alta de mod con dependencias

1. Validar modpackId.
2. Leer archivo objetivo desde CurseForge /mods/{modId}/files/{fileId}.
3. Insertar mod solicitado con es_dependencia=false.
4. Extraer dependencies con relationType=3.
5. DFS/BFS recursivo para cada dependencia requerida.
6. Guardar dependencias faltantes con es_dependencia=true.
7. Retornar created[] y skipped[].

### 7.2 Exportacion

1. Crear export_jobs en estado queued.
2. Publicar mensaje con contrato JSON schema.
3. Worker toma job y pasa a running.
4. Leer modpack_mods y filtrar por target.
5. Para cada mod seleccionado, resolver download-url y descargar jar.
6. Comprimir mods/ en ZIP final.
7. Actualizar export_jobs a completed o failed.

## 8. Validaciones de negocio minimas

- nombre de modpack: 3..150 caracteres
- version_minecraft: formato texto no vacio (ej 1.20.1)
- modloader_tipo: Forge/Fabric/Quilt/NeoForge
- entorno_destino: BOTH/CLIENT_ONLY/SERVER_ONLY
- No permitir agregar el mismo projectId dos veces al mismo modpack.

## 9. Observabilidad minima V1

Logs estructurados JSON con campos:

- timestamp
- level
- service
- requestId
- route
- durationMs
- statusCode
- errorCode (si aplica)

Metricas minimas:

- cf_requests_total
- cf_cache_hit_ratio
- export_jobs_total
- export_jobs_failed_total
- export_job_duration_seconds

## 10. Criterio de aceptacion tecnico

V1 pasa cuando:

1. OpenAPI se valida sin errores.
2. SQL inicial crea tablas/indices/tipos sin fallar en DB limpia.
3. API expone todos los endpoints definidos en OpenAPI.
4. Agregar mod con dependencias funciona con al menos 3 niveles de recursion.
5. Export job recorre estado queued->running->completed y entrega ZIP descargable.
6. Prueba de 20 mods completa en menos de 5 minutos en entorno local promedio.
