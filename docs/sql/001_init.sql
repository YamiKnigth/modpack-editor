-- CraftForge V1 - Migracion inicial PostgreSQL

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'modloader_tipo') THEN
    CREATE TYPE modloader_tipo AS ENUM ('Forge', 'Fabric', 'Quilt', 'NeoForge');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'entorno_destino') THEN
    CREATE TYPE entorno_destino AS ENUM ('BOTH', 'CLIENT_ONLY', 'SERVER_ONLY');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'export_target') THEN
    CREATE TYPE export_target AS ENUM ('CLIENT', 'SERVER', 'BOTH');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'export_status') THEN
    CREATE TYPE export_status AS ENUM ('queued', 'running', 'completed', 'failed');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'export_format') THEN
    CREATE TYPE export_format AS ENUM ('MODS_ZIP', 'CURSEFORGE_ZIP');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'modpack_profile') THEN
    CREATE TYPE modpack_profile AS ENUM ('CLIENT', 'SERVER');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- gameId de Minecraft se resuelve via CurseForge /v1/games y se persiste.
INSERT INTO system_config(key, value)
VALUES ('minecraft_game_id', '432')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS modpacks (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id BIGINT NULL,
  nombre VARCHAR(150) NOT NULL,
  version_minecraft VARCHAR(20) NOT NULL,
  modloader_tipo modloader_tipo NOT NULL,
  modloader_version VARCHAR(50) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_users (
  id BIGSERIAL PRIMARY KEY,
  email VARCHAR(200) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nombre VARCHAR(120) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE modpacks
  ADD COLUMN IF NOT EXISTS owner_user_id BIGINT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app_users WHERE email = 'demo@local.dev'
  ) THEN
    INSERT INTO app_users (email, password_hash, nombre)
    VALUES ('demo@local.dev', '$2a$10$2vMfE8sA7n3QJ0qK2.DVfOVN6hY8x3hR9vQWQ2hPi0uG8koT0IZ5K', 'Demo User');
  END IF;
END $$;

UPDATE modpacks
SET owner_user_id = (SELECT id FROM app_users WHERE email = 'demo@local.dev' LIMIT 1)
WHERE owner_user_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'modpacks'
      AND constraint_name = 'fk_modpacks_owner_user'
  ) THEN
    ALTER TABLE modpacks
      ADD CONSTRAINT fk_modpacks_owner_user
      FOREIGN KEY (owner_user_id) REFERENCES app_users(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS modpack_mods (
  id BIGSERIAL PRIMARY KEY,
  modpack_id BIGINT NOT NULL REFERENCES modpacks(id) ON DELETE CASCADE,
  curseforge_project_id INT NOT NULL,
  curseforge_file_id INT NOT NULL,
  nombre_mod VARCHAR(200) NOT NULL,
  logo_url TEXT NULL,
  profile modpack_profile NOT NULL DEFAULT 'CLIENT',
  entorno_destino entorno_destino NOT NULL,
  es_dependencia BOOLEAN NOT NULL DEFAULT FALSE,
  padre_proyecto_id INT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_modpack_project UNIQUE (modpack_id, curseforge_project_id)
);

ALTER TABLE modpack_mods
  ADD COLUMN IF NOT EXISTS logo_url TEXT NULL;

ALTER TABLE modpack_mods
  ADD COLUMN IF NOT EXISTS profile modpack_profile NOT NULL DEFAULT 'CLIENT';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'modpack_mods'
      AND constraint_name = 'uq_modpack_project'
  ) THEN
    ALTER TABLE modpack_mods DROP CONSTRAINT uq_modpack_project;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'modpack_mods'
      AND constraint_name = 'uq_modpack_project_profile'
  ) THEN
    ALTER TABLE modpack_mods
      ADD CONSTRAINT uq_modpack_project_profile UNIQUE (modpack_id, curseforge_project_id, profile);
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_modpack_mods_modpack_id
  ON modpack_mods(modpack_id);

CREATE INDEX IF NOT EXISTS idx_modpack_mods_project_id
  ON modpack_mods(curseforge_project_id);

CREATE INDEX IF NOT EXISTS idx_modpack_mods_padre
  ON modpack_mods(padre_proyecto_id)
  WHERE padre_proyecto_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_modpack_mods_profile
  ON modpack_mods(modpack_id, profile);

CREATE TABLE IF NOT EXISTS export_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  modpack_id BIGINT NOT NULL REFERENCES modpacks(id) ON DELETE CASCADE,
  owner_user_id BIGINT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  target export_target NOT NULL,
  format export_format NOT NULL DEFAULT 'MODS_ZIP',
  status export_status NOT NULL DEFAULT 'queued',
  scratch_dir TEXT NULL,
  output_file TEXT NULL,
  error_message TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_export_jobs_modpack_id
  ON export_jobs(modpack_id);

CREATE INDEX IF NOT EXISTS idx_export_jobs_status
  ON export_jobs(status);

ALTER TABLE export_jobs
  ADD COLUMN IF NOT EXISTS format export_format NOT NULL DEFAULT 'MODS_ZIP';

ALTER TABLE export_jobs
  ADD COLUMN IF NOT EXISTS owner_user_id BIGINT NULL REFERENCES app_users(id) ON DELETE CASCADE;

UPDATE export_jobs ej
SET owner_user_id = m.owner_user_id
FROM modpacks m
WHERE ej.modpack_id = m.id
  AND ej.owner_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_modpacks_owner
  ON modpacks(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_export_jobs_owner
  ON export_jobs(owner_user_id);

-- Cola transaccional simple para desacoplar API y worker.
CREATE TABLE IF NOT EXISTS outbox_export_jobs (
  id BIGSERIAL PRIMARY KEY,
  export_job_id UUID NOT NULL REFERENCES export_jobs(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_export_jobs_published
  ON outbox_export_jobs(published_at);

-- Trigger generico para updated_at.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_modpacks_updated_at ON modpacks;
CREATE TRIGGER trg_modpacks_updated_at
BEFORE UPDATE ON modpacks
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
