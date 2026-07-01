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
  id          SERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  role        TEXT DEFAULT '',
  color       TEXT DEFAULT 'v',
  photo       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS appointments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  date        TEXT NOT NULL,
  start       NUMERIC DEFAULT 10,
  dur         NUMERIC DEFAULT 2,
  color       TEXT DEFAULT 'v',
  status      TEXT DEFAULT 'pending',
  price       NUMERIC DEFAULT 0,
  deposit     NUMERIC DEFAULT 0,
  work_type   TEXT DEFAULT '',
  notes       TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clients (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  created_at  TIMESTAMPTZ DEFAULT NOW()
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
