const { Pool, types } = require('pg');

// NUMERIC chega como string no pg; aqui os valores cabem com folga em float.
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));

if (!process.env.DATABASE_URL) {
  console.error('[PULSE] DATABASE_URL não definida. No Railway: adicione um Postgres e referencie ${{Postgres.DATABASE_URL}}.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 10,
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS sites (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      url        TEXT NOT NULL DEFAULT '',
      currency   TEXT NOT NULL DEFAULT 'USD',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS sites_user_name_uq ON sites (user_id, lower(name));

    CREATE TABLE IF NOT EXISTS records (
      id         BIGSERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      post_id    TEXT NOT NULL,
      country    TEXT NOT NULL,
      cpr        NUMERIC(14,4) NOT NULL,
      cpm        NUMERIC(14,4) NOT NULL,
      note       TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS records_key_idx
      ON records (user_id, site_id, post_id, country, created_at DESC);

    -- evoluções de esquema (idempotentes)
    ALTER TABLE users   ADD COLUMN IF NOT EXISTS company   TEXT    NOT NULL DEFAULT '';
    ALTER TABLE users   ADD COLUMN IF NOT EXISTS is_master BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE records ADD COLUMN IF NOT EXISTS action    TEXT    NOT NULL DEFAULT '';
    CREATE INDEX IF NOT EXISTS records_site_key_idx ON records (site_id, post_id, country, created_at DESC);
  `);
}

module.exports = { pool, migrate };
