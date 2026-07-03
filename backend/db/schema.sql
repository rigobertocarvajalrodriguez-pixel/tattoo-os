-- Tattoo OS Database Schema

CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  password    TEXT NOT NULL,
  is_admin    BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS profiles (
  id              SERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  role            TEXT DEFAULT '',
  color           TEXT DEFAULT 'v',
  photo           TEXT,
  commission_pct  NUMERIC DEFAULT 50,
  created_at      TIMESTAMPTZ DEFAULT NOW()
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
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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

CREATE TABLE IF NOT EXISTS projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  client      TEXT DEFAULT '',
  status      TEXT DEFAULT 'pending',
  notes       TEXT DEFAULT '',
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
