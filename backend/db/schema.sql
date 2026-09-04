-- Tattoo OS Database Schema

CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT UNIQUE NOT NULL,
  name           TEXT NOT NULL,
  password       TEXT NOT NULL,
  is_admin       BOOLEAN DEFAULT FALSE,
  -- plan: ver migración "Fase 1" en server.js. active/last_login_at: ver migración
  -- "panel superadmin" en server.js (activar/desactivar cuentas y última actividad).
  plan               TEXT NOT NULL DEFAULT 'independiente',
  active             BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at      TIMESTAMPTZ,
  -- Email de contacto del estudio (Responder-a de las notificaciones por email, ver
  -- "seguimiento por email" en server.js) - se auto-vincula al email de la cuenta al
  -- registrarse; solo el dueño del estudio o el superadmin pueden cambiarlo después.
  notification_email TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

-- Modo soporte del panel superadmin: log de auditoría de cada vez que is_admin entra a ver la
-- cuenta de un usuario (impersonar de solo lectura). Ver POST /api/admin/impersonate/:userId.
CREATE TABLE IF NOT EXISTS admin_access_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  admin_email TEXT NOT NULL,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_email  TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_access_log_user ON admin_access_log(user_id);

CREATE TABLE IF NOT EXISTS profiles (
  id                SERIAL PRIMARY KEY,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  role              TEXT DEFAULT '',
  color             TEXT DEFAULT 'v',
  photo             TEXT,
  commission_pct    NUMERIC DEFAULT 50,
  -- Aislamiento por perfil (contraseña propia + marca de Administrador): ver server.js.
  password_hash     TEXT,
  password_plain    TEXT,
  is_admin_profile  BOOLEAN NOT NULL DEFAULT FALSE,
  wa_settings       JSONB,
  -- Nombre del estudio de este perfil (Ajustes > Estudio en el frontend) - hace falta en el
  -- servidor porque el remitente de cada email de seguimiento lo arma el propio backend
  -- (nombre del tatuador + su estudio), ver "seguimiento por email" en server.js.
  studio_name       TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS appointments (
  id               TEXT PRIMARY KEY,
  profile_id       INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  date             TEXT NOT NULL,
  start            NUMERIC DEFAULT 10,
  dur              NUMERIC DEFAULT 2,
  color            TEXT DEFAULT 'v',
  status           TEXT DEFAULT 'pending',
  price            NUMERIC DEFAULT 0,
  deposit          NUMERIC DEFAULT 0,
  work_type        TEXT DEFAULT '',
  notes            TEXT DEFAULT '',
  artist_id        INTEGER REFERENCES profiles(id),
  deposit_method   TEXT DEFAULT '',
  balance_method   TEXT DEFAULT '',
  balance_paid     BOOLEAN DEFAULT FALSE,
  balance_paid_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clients (
  id          TEXT PRIMARY KEY,
  profile_id  INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  phone       TEXT DEFAULT '',
  email       TEXT DEFAULT '',
  instagram   TEXT DEFAULT '',
  notes       TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS expenses (
  id          TEXT PRIMARY KEY,
  profile_id  INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount      NUMERIC NOT NULL DEFAULT 0,
  category    TEXT DEFAULT '',
  description TEXT DEFAULT '',
  date        TEXT NOT NULL,
  kind        TEXT DEFAULT 'variable',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Ventas de mostrador: compartidas por todo el estudio, no atadas a un artista concreto
CREATE TABLE IF NOT EXISTS pos_sales (
  id          TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item        TEXT NOT NULL,
  amount      NUMERIC NOT NULL DEFAULT 0,
  method      TEXT DEFAULT 'efectivo',
  date        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Liquidaciones de comisión por artista (generadas server-side, fuente autoritativa)
CREATE TABLE IF NOT EXISTS commission_settlements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artist_id       INTEGER NOT NULL REFERENCES profiles(id),
  period_start    TEXT NOT NULL,
  period_end      TEXT NOT NULL,
  appt_ids        TEXT[] NOT NULL DEFAULT '{}',
  total_facturado NUMERIC NOT NULL DEFAULT 0,
  total_comision  NUMERIC NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',
  paid_at         TIMESTAMPTZ,
  method          TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- id es TEXT (no UUID) porque el frontend siempre genera ids numéricos propios (projSeq++),
-- igual que appointments/clients/expenses.
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  profile_id  INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  client      TEXT DEFAULT '',
  status      TEXT DEFAULT 'pending',
  notes       TEXT DEFAULT '',
  tags        TEXT[] DEFAULT '{}',
  images      TEXT[] DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Documentos subidos (fichas, PDFs, fotos) - url guarda el archivo como data URI base64.
CREATE TABLE IF NOT EXISTS doc_files (
  id          TEXT PRIMARY KEY,
  profile_id  INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT DEFAULT '',
  client      TEXT DEFAULT '',
  date        TEXT DEFAULT '',
  size        TEXT DEFAULT '',
  type        TEXT DEFAULT '',
  url         TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Consentimientos informados (formulario para imprimir y firmar en papel).
CREATE TABLE IF NOT EXISTS consents (
  id                 TEXT PRIMARY KEY,
  profile_id         INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_name        TEXT DEFAULT '',
  dni                TEXT DEFAULT '',
  dob                TEXT DEFAULT '',
  phone              TEXT DEFAULT '',
  email              TEXT DEFAULT '',
  address            TEXT DEFAULT '',
  tattoo_type        TEXT DEFAULT '',
  zone               TEXT DEFAULT '',
  size_desc          TEXT DEFAULT '',
  session_date       TEXT DEFAULT '',
  artist             TEXT DEFAULT '',
  price              TEXT DEFAULT '',
  deposit            TEXT DEFAULT '',
  medical            TEXT DEFAULT '',
  checks             JSONB DEFAULT '[]',
  created_at_label   TEXT DEFAULT '',
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

-- Plantillas de documentos del estudio, editables por perfil (portada, ficha, RGPD, etc).
CREATE TABLE IF NOT EXISTS doc_templates (
  profile_id  INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,
  name        TEXT DEFAULT '',
  content     TEXT DEFAULT '',
  PRIMARY KEY (profile_id, template_id)
);

-- Historial de conversación de WhatsApp por cliente (distinto de wa_followups, que es la
-- cola de envíos automáticos programados).
CREATE TABLE IF NOT EXISTS wa_messages (
  id          TEXT PRIMARY KEY,
  profile_id  INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id   TEXT NOT NULL,
  text        TEXT DEFAULT '',
  dir         TEXT DEFAULT 'out',
  ts          TIMESTAMPTZ,
  auto        BOOLEAN DEFAULT FALSE,
  auto_id     TEXT,
  read        BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tickets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  user_email  TEXT,
  user_name   TEXT,
  title       TEXT NOT NULL,
  description TEXT DEFAULT '',
  status      TEXT DEFAULT 'open',
  priority    TEXT DEFAULT 'normal',
  has_unread  BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  sender      TEXT NOT NULL,
  sender_name TEXT DEFAULT '',
  message     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- OBSOLETA: el seguimiento de curación se hace ahora por email (email_followups más abajo).
-- Se deja la tabla tal cual (sin migración destructiva) por si queda algo histórico que
-- consultar, pero nada en server.js vuelve a escribir ni leer de aquí.
CREATE TABLE IF NOT EXISTS wa_followups (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id TEXT NOT NULL,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_name    TEXT NOT NULL,
  phone          TEXT NOT NULL,
  kind           TEXT NOT NULL,
  message        TEXT NOT NULL,
  scheduled_at   TIMESTAMPTZ NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  sent_at        TIMESTAMPTZ,
  error          TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_followup_unique ON wa_followups(appointment_id, kind);

-- Reglas de notificación por email, editables por el dueño del estudio (Ajustes >
-- Notificaciones por email). Se siembran 2 por defecto (día 1/día 3) la primera vez que una
-- cuenta las necesita - ver ensureDefaultEmailRules() en server.js.
CREATE TABLE IF NOT EXISTS email_rules (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  offset_days  INTEGER NOT NULL DEFAULT 1,
  offset_hour  INTEGER NOT NULL DEFAULT 11,
  subject      TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_rules_user ON email_rules(user_id);

-- Cola de envío del seguimiento de curación por email - se programa al marcar una cita como
-- completada (una fila por regla activa), y un worker en server.js la va enviando.
CREATE TABLE IF NOT EXISTS email_followups (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id TEXT NOT NULL,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_id        UUID REFERENCES email_rules(id) ON DELETE SET NULL,
  client_name    TEXT NOT NULL,
  client_email   TEXT NOT NULL,
  sender_name    TEXT NOT NULL DEFAULT '',
  subject        TEXT NOT NULL DEFAULT '',
  body           TEXT NOT NULL DEFAULT '',
  scheduled_at   TIMESTAMPTZ NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  sent_at        TIMESTAMPTZ,
  error          TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_followup_unique ON email_followups(appointment_id, rule_id);
CREATE INDEX IF NOT EXISTS idx_email_followups_user ON email_followups(user_id);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_profiles_user      ON profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_appts_profile      ON appointments(profile_id);
CREATE INDEX IF NOT EXISTS idx_appts_user         ON appointments(user_id);
CREATE INDEX IF NOT EXISTS idx_appts_date         ON appointments(date);
CREATE INDEX IF NOT EXISTS idx_clients_profile    ON clients(profile_id);
CREATE INDEX IF NOT EXISTS idx_expenses_profile   ON expenses(profile_id);
CREATE INDEX IF NOT EXISTS idx_projects_profile   ON projects(profile_id);
CREATE INDEX IF NOT EXISTS idx_tickets_user       ON tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_ticket_msg_ticket  ON ticket_messages(ticket_id);
CREATE INDEX IF NOT EXISTS idx_appts_artist       ON appointments(artist_id);
CREATE INDEX IF NOT EXISTS idx_pos_sales_user     ON pos_sales(user_id);
CREATE INDEX IF NOT EXISTS idx_settlements_artist ON commission_settlements(artist_id);
CREATE INDEX IF NOT EXISTS idx_settlements_user   ON commission_settlements(user_id);
