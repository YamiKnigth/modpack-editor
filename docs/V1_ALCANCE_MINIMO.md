# CraftForge Web - Alcance minimo V1

## 1) Objetivo de V1

Entregar una aplicacion autoalojada que permita:

- crear un modpack de Minecraft,
- buscar y agregar mods desde CurseForge,
- resolver dependencias requeridas,
- exportar ZIP para cliente, servidor o ambos,
- operar de forma estable en entorno Docker para 1 a 3 usuarios.

Esta V1 prioriza flujo end-to-end funcional por encima de funciones avanzadas.

## 2) Alcance funcional IN

### 2.1 Gestion de modpacks

- Crear modpack con nombre, version de Minecraft y modloader.
- Listar modpacks.
- Ver detalle de un modpack con lista de mods.
- Eliminar modpack (con borrado en cascada de relaciones).

### 2.2 Catalogo y seleccion de mods

- Buscar mods por texto y filtros basicos (version, modloader, paginacion).
- Ver datos de mod y archivos disponibles para una version concreta.
- Elegir un archivo de mod (fileId) para instalar.

### 2.3 Resolucion de dependencias

- Resolver dependencias recursivas usando relationType = 3 (RequiredDependency).
- Evitar duplicados por combinacion modpack_id + curseforge_project_id.
- Marcar en base de datos si un registro es dependencia automatica.

### 2.4 Exportacion asincrona

- Solicitar exportacion y devolver respuesta inmediata (202 Accepted).
- Worker descarga archivos .jar en volumen compartido temporal.
- Filtrado por entorno: BOTH, CLIENT_ONLY, SERVER_ONLY.
- Compresion ZIP final con estructura /mods.
- Limpieza automatica de temporales > 120 minutos.

### 2.5 Operacion minima

- Docker Compose para frontend, backend, worker, postgres, redis.
- Cache Redis con TTL 24h para metadatos de CurseForge usados repetidamente.
- Healthcheck basico en API y worker.

## 3) Alcance funcional OUT (post V1)

- Sistema de usuarios multi-tenant y RBAC completo.
- Importacion por fingerprints de carpeta local del usuario.
- Sincronizacion bidireccional con launchers externos.
- Recomendaciones, ranking o featured avanzado.
- UI de dependencias en forma de grafo.
- Telemetria avanzada, dashboards y alertado completo.

## 4) Integracion CurseForge requerida para V1

Base URL: https://api.curseforge.com
Autenticacion: header x-api-key

### 4.1 Endpoints obligatorios para V1

- GET /v1/minecraft/version
  - Obtener versiones de Minecraft para filtros y validaciones.
- GET /v1/minecraft/modloader
  - Obtener modloaders disponibles.
- GET /v1/mods/search
  - Busqueda principal de mods (con gameId requerido).
- GET /v1/mods/{modId}
  - Detalle de mod.
- GET /v1/mods/{modId}/files
  - Listado de archivos por version/modloader.
- GET /v1/mods/{modId}/files/{fileId}
  - Metadatos completos del archivo y dependencias.
- GET /v1/mods/{modId}/files/{fileId}/download-url
  - URL oficial de descarga para el worker.

### 4.2 Endpoints utiles pero no bloqueantes en V1

- GET /v1/categories
  - Categorias para filtros opcionales.
- POST /v1/mods/files
  - Consulta en lote de archivos, optimizacion posterior.
- GET /v1/mods/{modId}/description
  - Enriquecimiento de UI.

### 4.3 Endpoints fuera de V1 inicial

- POST /v1/fingerprints
- POST /v1/fingerprints/{gameId}
- POST /v1/fingerprints/fuzzy
- POST /v1/fingerprints/fuzzy/{gameId}

Se pueden habilitar en V1.1 para importacion automatica de mods instalados.

## 5) Reglas tecnicas de CurseForge a respetar en V1

- El pageSize maximo es 50.
- El limite de paginacion es index + pageSize <= 10000.
- En busquedas por listas:
  - categoryIds maximo 10,
  - gameVersions maximo 4,
  - modLoaderTypes maximo 5.
- Para filtrar por modloader en busqueda de mods, debe acoplarse con gameVersion.

## 6) Modelo de datos minimo V1 (ajuste al SDD)

Tablas principales:

- modpacks
  - id, nombre, version_minecraft, modloader_tipo, modloader_version, created_at, updated_at.
- modpack_mods
  - id, modpack_id, curseforge_project_id, curseforge_file_id, nombre_mod,
    entorno_destino, es_dependencia, padre_proyecto_id, created_at.

Restricciones recomendadas:

- UNIQUE(modpack_id, curseforge_project_id)
- CHECK(entorno_destino IN ('BOTH','CLIENT_ONLY','SERVER_ONLY'))
- FK con ON DELETE CASCADE en modpack_id

## 7) Criterios de aceptacion V1

- Se despliega con un solo docker-compose.yml.
- Un usuario puede crear un modpack y agregar al menos 20 mods con dependencias.
- El worker exporta ZIP de cliente y servidor sin bloquear el request HTTP.
- Las descargas de CurseForge se realizan respetando filtros de version/modloader.
- La limpieza de temporales mantiene controlado el uso de disco.
- Todo flujo principal funciona en local y en Coolify con variables de entorno.

## 8) Riesgos y mitigaciones V1

- Riesgo: cambios o indisponibilidad temporal de CurseForge.
  - Mitigacion: cache Redis, retries con backoff, errores legibles para el usuario.
- Riesgo: dependencia ciclica o inconsistencia de metadata.
  - Mitigacion: conjunto visited por projectId y limite de profundidad configurable.
- Riesgo: saturacion por descarga masiva.
  - Mitigacion: concurrencia maxima 3 descargas paralelas por job.

## 9) Definicion de "V1 lista"

Se considera V1 lista cuando los flujos de crear modpack, buscar/agregar mods,
resolver dependencias requeridas y exportar ZIP por entorno funcionen de punta a
punta en Docker sin pasos manuales fuera de configurar la API key.