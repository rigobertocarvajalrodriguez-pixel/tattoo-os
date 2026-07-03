// Allow self-signed certs (needed for Supabase pooler on Render)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'rigobertocarvajalrodriguez@gmail.com';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

// ══════════════════════════════════════════
// POSTGRESQL CONNECTION
// ══════════════════════════════════════════
var dbConfig;
if (process.env.DATABASE_URL) {
  // Render / Supabase connection string
  dbConfig = { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } };
} else {
  // Local development
  dbConfig = {
    host:     process.env.PG_HOST || 'localhost',
    port:     parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DB   || 'tattoo_os',
    user:     process.env.PG_USER || 'postgres',
    password: process.env.PG_PASS || 'tattoo123',
  };
}
const db = new Pool(dbConfig);
db.connect()
  .then(function() { console.log('[DB] PostgreSQL conectado'); })
  .catch(function(e) { console.error('[DB] Error conexión PostgreSQL:', e.message); });

// Seguimiento de curación por WhatsApp: cola de mensajes programados (día 1 / día 3 tras completar cita)
db.query(`
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
  )
`).then(function() {
  return db.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_followup_unique ON wa_followups(appointment_id, kind)');
}).catch(function(e) { console.error('[DB] Error creando wa_followups:', e.message); });

// Comisiones por artista, métodos de pago y ventas de mostrador (migración aditiva)
Promise.all([
  db.query('ALTER TABLE profiles ADD COLUMN IF NOT EXISTS commission_pct NUMERIC DEFAULT 50'),
  db.query('ALTER TABLE appointments ADD COLUMN IF NOT EXISTS artist_id INTEGER REFERENCES profiles(id)'),
  db.query("ALTER TABLE appointments ADD COLUMN IF NOT EXISTS deposit_method TEXT DEFAULT ''"),
  db.query("ALTER TABLE appointments ADD COLUMN IF NOT EXISTS balance_method TEXT DEFAULT ''"),
  db.query('ALTER TABLE appointments ADD COLUMN IF NOT EXISTS balance_paid BOOLEAN DEFAULT FALSE'),
  db.query('ALTER TABLE appointments ADD COLUMN IF NOT EXISTS balance_paid_at TIMESTAMPTZ'),
  db.query("ALTER TABLE expenses ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'variable'"),
]).then(function() {
  console.log('[DB] Migración de comisiones/artistas aplicada');
}).catch(function(e) { console.error('[DB] Error en migración de comisiones:', e.message); });

db.query(`
  CREATE TABLE IF NOT EXISTS pos_sales (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item        TEXT NOT NULL,
    amount      NUMERIC NOT NULL DEFAULT 0,
    method      TEXT DEFAULT 'efectivo',
    date        TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  )
`).then(function() {
  return db.query('CREATE INDEX IF NOT EXISTS idx_pos_sales_user ON pos_sales(user_id)');
}).catch(function(e) { console.error('[DB] Error creando pos_sales:', e.message); });

db.query(`
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
  )
`).then(function() {
  return Promise.all([
    db.query('CREATE INDEX IF NOT EXISTS idx_settlements_artist ON commission_settlements(artist_id)'),
    db.query('CREATE INDEX IF NOT EXISTS idx_settlements_user ON commission_settlements(user_id)')
  ]);
}).catch(function(e) { console.error('[DB] Error creando commission_settlements:', e.message); });

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Iconos PWA generados server-side como SVG → PNG equivalente
app.get('/icon-:size.png', function(req, res) {
  var size = parseInt(req.params.size) || 192;
  var r = Math.round(size * 0.22);
  var svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" rx="${r}" fill="#07070f"/>
    <defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#7c5cfc"/>
      <stop offset="100%" stop-color="#a78bfa"/>
    </linearGradient></defs>
    <text x="${size/2}" y="${size*0.58}" font-family="Arial Black,Arial" font-weight="900"
      font-size="${Math.round(size*0.52)}" text-anchor="middle" fill="url(#g)">T.</text>
  </svg>`;
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(svg);
});

// Sessions store: { userId: { client, qr, ready, state } }
const waSessions = {};

const SESSION_BASE = process.env.NODE_ENV === 'production' ? '/tmp/wa_sessions' : path.join(__dirname, 'data', 'wa_sessions');
if (!fs.existsSync(SESSION_BASE)) fs.mkdirSync(SESSION_BASE, { recursive: true });

// ══════════════════════════════════════════
// LOCAL DATA STORAGE
// ══════════════════════════════════════════
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch(e) { return []; }
}
function writeJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// Ensure admin user exists on first run (PostgreSQL)
db.query(
  'INSERT INTO users (email, name, password, is_admin) VALUES ($1,$2,$3,TRUE) ON CONFLICT (email) DO NOTHING',
  [ADMIN_EMAIL, 'Admin', ADMIN_PASS]
).then(function() {
  console.log('[AUTH] Admin verificado en BD:', ADMIN_EMAIL);
}).catch(function(e) {
  // Fallback: also keep JSON so app still works if DB is down
  var users = readJSON('users.json');
  if (!users.find(function(u) { return u.email === ADMIN_EMAIL; })) {
    users.push({ id: crypto.randomUUID(), email: ADMIN_EMAIL, name: 'Admin', password: ADMIN_PASS, isAdmin: true, created_at: new Date().toISOString() });
    writeJSON('users.json', users);
  }
});

// Auth sessions in memory: token → { userId, email, name, isAdmin }
const authSessions = {};

// ── AUTH ENDPOINTS ──
app.post('/api/auth/login', function(req, res) {
  var email = (req.body.email || '').trim().toLowerCase();
  var pass = req.body.password || '';
  db.query('SELECT * FROM users WHERE email=$1 AND password=$2', [email, pass])
    .then(function(r) {
      if (!r.rows.length) return res.status(401).json({ error: 'Email o contraseña incorrectos' });
      var user = r.rows[0];
      var token = crypto.randomUUID();
      authSessions[token] = { userId: user.id, email: user.email, name: user.name, isAdmin: !!user.is_admin };
      res.json({ token: token, user: { id: user.id, email: user.email, name: user.name } });
    })
    .catch(function(e) { res.status(500).json({ error: 'Error de base de datos' }); });
});

app.post('/api/auth/register', function(req, res) {
  var email = (req.body.email || '').trim().toLowerCase();
  var pass = req.body.password || '';
  var name = (req.body.name || email.split('@')[0]).trim();
  if (!email || !pass) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  if (pass.length < 8) return res.status(400).json({ error: 'Contraseña mínimo 8 caracteres' });
  db.query('INSERT INTO users (email, name, password) VALUES ($1,$2,$3) RETURNING *', [email, name, pass])
    .then(function(r) {
      var user = r.rows[0];
      var token = crypto.randomUUID();
      authSessions[token] = { userId: user.id, email: user.email, name: user.name, isAdmin: false };
      res.json({ token: token, user: { id: user.id, email: user.email, name: user.name } });
    })
    .catch(function(e) {
      if (e.code === '23505') return res.status(400).json({ error: 'El email ya está registrado' });
      res.status(500).json({ error: 'Error de base de datos' });
    });
});

app.get('/api/auth/me', function(req, res) {
  var token = req.headers.authorization && req.headers.authorization.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  var session = authSessions[token];
  if (!session) return res.status(401).json({ error: 'Token inválido' });
  res.json({ user: { id: session.userId, email: session.email, name: session.name } });
});

app.post('/api/auth/logout', function(req, res) {
  var token = req.headers.authorization && req.headers.authorization.replace('Bearer ', '');
  if (token) delete authSessions[token];
  res.json({ ok: true });
});

// Get Chrome path based on environment
function getChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  // Linux (Render) - use bundled chromium from whatsapp-web.js
  if (process.platform === 'linux') return undefined; // let puppeteer find its own
  // Windows - prefer Chrome 119 which works with whatsapp-web.js
  if (process.platform === 'win32') {
    var userProfile = process.env.USERPROFILE || 'C:\\Users\\Usuario';
    var puppeteerCache = userProfile + '\\.cache\\puppeteer\\chrome';
    if (fs.existsSync(puppeteerCache)) {
      var versions = fs.readdirSync(puppeteerCache).sort();
      // Prefer version 119 first
      for (var i = 0; i < versions.length; i++) {
        if (versions[i].indexOf('119') !== -1) {
          var exePath = puppeteerCache + '\\' + versions[i] + '\\chrome-win64\\chrome.exe';
          if (fs.existsSync(exePath)) {
            console.log('[WA] Using Chrome 119:', exePath);
            return exePath;
          }
        }
      }
      // Fallback to oldest version (most compatible)
      for (var j = 0; j < versions.length; j++) {
        var exePath2 = puppeteerCache + '\\' + versions[j] + '\\chrome-win64\\chrome.exe';
        if (fs.existsSync(exePath2)) {
          console.log('[WA] Using Chrome:', exePath2);
          return exePath2;
        }
      }
    }
  }
  return undefined;
}

// Auth middleware
function authMiddleware(req, res, next) {
  var token = req.headers.authorization && req.headers.authorization.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  var session = authSessions[token];
  if (!session) return res.status(401).json({ error: 'Token invalido' });
  req.userId = session.userId;
  req.user = session;
  next();
}

// Admin middleware
function adminMiddleware(req, res, next) {
  var token = req.headers.authorization && req.headers.authorization.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  var session = authSessions[token];
  if (!session) return res.status(401).json({ error: 'Token inválido' });
  if (!session.isAdmin && session.email !== ADMIN_EMAIL) return res.status(403).json({ error: 'Not admin' });
  req.adminUser = session;
  next();
}

// Start WhatsApp session for a user
function startWASession(userId) {
  if (waSessions[userId] &&
      waSessions[userId].state !== 'ERROR' &&
      waSessions[userId].state !== 'DISCONNECTED') {
    console.log('[WA] Session already exists for:', userId.slice(0, 8), '- state:', waSessions[userId].state);
    return;
  }
  // Clear old session before starting new one
  if (waSessions[userId] && waSessions[userId].client) {
    try { waSessions[userId].client.destroy().catch(function(){}); } catch(e) {}
  }

  console.log('[WA] Starting session for:', userId.slice(0, 8));

  var sessionDir = path.join(SESSION_BASE, userId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  var chromePath = getChromePath();
  console.log('[WA] Chrome path:', chromePath || 'auto-detect');

  var clientOptions = {
    authStrategy: new LocalAuth({ dataPath: sessionDir, clientId: userId }),
    puppeteer: {
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--no-first-run',
        '--no-zygote',
        '--disable-extensions',
        '--ignore-certificate-errors'
      ],
      headless: true
    }
  };

  if (chromePath) clientOptions.puppeteer.executablePath = chromePath;

  var client = new Client(clientOptions);
  waSessions[userId] = { client: client, qr: null, ready: false, state: 'STARTING' };

  client.on('qr', function(qr) {
    console.log('[WA] QR ready for:', userId.slice(0, 8));
    waSessions[userId].state = 'QR_READY';
    qrcode.toDataURL(qr, function(err, url) {
      if (!err) waSessions[userId].qr = url;
    });
  });

  client.on('authenticated', function() {
    console.log('[WA] Authenticated:', userId.slice(0, 8));
    waSessions[userId].state = 'AUTHENTICATED';
    waSessions[userId].qr = null;
  });

  client.on('ready', function() {
    console.log('[WA] Ready:', userId.slice(0, 8));
    waSessions[userId].ready = true;
    waSessions[userId].state = 'READY';
  });

  client.on('disconnected', function(reason) {
    console.log('[WA] Disconnected:', userId.slice(0, 8), reason);
    if (waSessions[userId]) {
      waSessions[userId].ready = false;
      waSessions[userId].state = 'DISCONNECTED';
    }
  });

  client.initialize().catch(function(err) {
    console.error('[WA] Init error for', userId.slice(0, 8), ':', err.message);
    if (waSessions[userId]) {
      waSessions[userId].state = 'ERROR';
      waSessions[userId].ready = false;
      delete waSessions[userId];
    }
  });
}

// Health check
app.get('/health', function(req, res) {
  res.json({ status: 'ok', sessions: Object.keys(waSessions).length, platform: process.platform });
});

// Start WA session
app.post('/api/wa/start', authMiddleware, function(req, res) {
  startWASession(req.userId);
  res.json({ success: true });
});

// Get QR
app.get('/api/wa/qr', authMiddleware, function(req, res) {
  var session = waSessions[req.userId];
  if (!session) {
    startWASession(req.userId);
    return res.json({ status: 'starting', message: 'Iniciando... espera 15 segundos y pulsa Verificar.' });
  }
  if (session.ready) return res.json({ status: 'connected' });
  if (session.state === 'ERROR') {
    delete waSessions[req.userId];
    startWASession(req.userId);
    return res.json({ status: 'restarting', message: 'Reiniciando... espera 15 segundos.' });
  }
  if (session.qr) return res.json({ status: 'qr', qr: session.qr });
  res.json({ status: 'waiting', state: session.state, message: 'Generando QR... espera y pulsa Verificar.' });
});

// WA Status
app.get('/api/wa/status', authMiddleware, function(req, res) {
  var session = waSessions[req.userId];
  if (!session) return res.json({ connected: false, state: 'NOT_STARTED' });
  res.json({ connected: session.ready, state: session.state });
});

// Disconnect WA
app.post('/api/wa/disconnect', authMiddleware, async function(req, res) {
  var session = waSessions[req.userId];
  if (session && session.client) {
    try { await session.client.destroy(); } catch(e) {}
    delete waSessions[req.userId];
  }
  res.json({ success: true });
});

// Send message
app.post('/api/wa/send', authMiddleware, async function(req, res) {
  var session = waSessions[req.userId];
  if (!session || !session.ready) {
    return res.status(503).json({ error: 'WhatsApp no conectado. Ve a Ajustes > WhatsApp para vincular.' });
  }
  var numero = req.body.numero;
  var mensaje = req.body.mensaje;
  if (!numero || !mensaje) return res.status(400).json({ error: 'Faltan numero y mensaje' });
  var num = numero.replace(/[\s+\-()]/g, '');
  if (num.length === 9) num = '34' + num;
  var chatId = num + '@c.us';
  try {
    await session.client.sendMessage(chatId, mensaje);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// DATA APIS — almacenamiento local JSON
// ══════════════════════════════════════════

// Clients API
app.get('/api/clients', authMiddleware, function(req, res) {
  var all = readJSON('clients.json');
  res.json(all.filter(function(c) { return c.user_id === req.userId; }).sort(function(a, b) { return b.created_at > a.created_at ? 1 : -1; }));
});
app.post('/api/clients', authMiddleware, function(req, res) {
  var all = readJSON('clients.json');
  var item = Object.assign({}, req.body, { id: crypto.randomUUID(), user_id: req.userId, created_at: new Date().toISOString() });
  all.push(item);
  writeJSON('clients.json', all);
  res.json(item);
});
app.put('/api/clients/:id', authMiddleware, function(req, res) {
  var all = readJSON('clients.json');
  var idx = all.findIndex(function(c) { return c.id === req.params.id && c.user_id === req.userId; });
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  all[idx] = Object.assign(all[idx], req.body);
  writeJSON('clients.json', all);
  res.json(all[idx]);
});
app.delete('/api/clients/:id', authMiddleware, function(req, res) {
  var all = readJSON('clients.json');
  writeJSON('clients.json', all.filter(function(c) { return !(c.id === req.params.id && c.user_id === req.userId); }));
  res.json({ success: true });
});

// Appointments API
app.get('/api/appointments', authMiddleware, function(req, res) {
  var all = readJSON('appointments.json');
  res.json(all.filter(function(a) { return a.user_id === req.userId; }).sort(function(a, b) { return a.date > b.date ? 1 : -1; }));
});
app.post('/api/appointments', authMiddleware, function(req, res) {
  var all = readJSON('appointments.json');
  var item = Object.assign({}, req.body, { id: crypto.randomUUID(), user_id: req.userId, created_at: new Date().toISOString() });
  all.push(item);
  writeJSON('appointments.json', all);
  res.json(item);
});
app.put('/api/appointments/:id', authMiddleware, function(req, res) {
  var all = readJSON('appointments.json');
  var idx = all.findIndex(function(a) { return a.id === req.params.id && a.user_id === req.userId; });
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  all[idx] = Object.assign(all[idx], req.body);
  writeJSON('appointments.json', all);
  res.json(all[idx]);
});
app.delete('/api/appointments/:id', authMiddleware, function(req, res) {
  var all = readJSON('appointments.json');
  writeJSON('appointments.json', all.filter(function(a) { return !(a.id === req.params.id && a.user_id === req.userId); }));
  res.json({ success: true });
});

// Expenses API
app.get('/api/expenses', authMiddleware, function(req, res) {
  var all = readJSON('expenses.json');
  res.json(all.filter(function(e) { return e.user_id === req.userId; }).sort(function(a, b) { return b.date > a.date ? 1 : -1; }));
});
app.post('/api/expenses', authMiddleware, function(req, res) {
  var all = readJSON('expenses.json');
  var item = Object.assign({}, req.body, { id: crypto.randomUUID(), user_id: req.userId, created_at: new Date().toISOString() });
  all.push(item);
  writeJSON('expenses.json', all);
  res.json(item);
});
app.delete('/api/expenses/:id', authMiddleware, function(req, res) {
  var all = readJSON('expenses.json');
  writeJSON('expenses.json', all.filter(function(e) { return !(e.id === req.params.id && e.user_id === req.userId); }));
  res.json({ success: true });
});

// ══════════════════════════════════════════
// ADMIN PANEL
// ══════════════════════════════════════════

app.get('/api/admin/users', adminMiddleware, function(req, res) {
  db.query('SELECT id, email, name, password, is_admin, created_at FROM users ORDER BY created_at ASC')
    .then(function(r) { res.json(r.rows); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.get('/api/admin/tickets', adminMiddleware, function(req, res) {
  db.query('SELECT * FROM tickets ORDER BY updated_at DESC')
    .then(function(r) { res.json(r.rows); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.patch('/api/admin/tickets/:id', adminMiddleware, function(req, res) {
  var b = req.body;
  db.query('UPDATE tickets SET status=COALESCE($1,status), updated_at=NOW() WHERE id=$2 RETURNING *',
    [b.status, req.params.id])
    .then(function(r) { r.rows.length ? res.json(r.rows[0]) : res.status(404).json({ error: 'No encontrado' }); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.get('/api/tickets/:id/messages', authMiddleware, function(req, res) {
  db.query('SELECT * FROM ticket_messages WHERE ticket_id=$1 ORDER BY created_at ASC', [req.params.id])
    .then(function(r) { res.json(r.rows); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.post('/api/tickets/:id/messages', authMiddleware, function(req, res) {
  var isAdm = req.body.sender === 'admin';
  var sender = isAdm ? 'admin' : 'user';
  var senderName = isAdm ? 'Admin' : (req.body.sender_name || '');
  db.query('INSERT INTO ticket_messages (ticket_id,sender,sender_name,message) VALUES ($1,$2,$3,$4) RETURNING *',
    [req.params.id, sender, senderName, req.body.message])
    .then(function(r) {
      var newStatus = isAdm ? 'in_progress' : 'open';
      db.query('UPDATE tickets SET status=$1, updated_at=NOW(), has_unread=$2 WHERE id=$3',
        [newStatus, !isAdm, req.params.id]).catch(function(){});
      res.json(r.rows[0]);
    })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.get('/api/tickets/mine', authMiddleware, function(req, res) {
  db.query('SELECT * FROM tickets WHERE user_id=$1 ORDER BY updated_at DESC', [req.userId])
    .then(function(r) { res.json(r.rows); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.patch('/api/tickets/:id/read', authMiddleware, function(req, res) {
  db.query('UPDATE tickets SET has_unread=FALSE WHERE id=$1 AND user_id=$2', [req.params.id, req.userId])
    .then(function() { res.json({ ok: true }); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.post('/api/tickets', authMiddleware, function(req, res) {
  db.query('INSERT INTO tickets (user_id,user_email,user_name,title,description,priority) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [req.userId, req.body.user_email, req.body.user_name, req.body.title, req.body.description, req.body.priority||'normal'])
    .then(function(r) { res.json(r.rows[0]); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

// ══════════════════════════════════════════
// SEGUIMIENTO DE CURACIÓN POR WHATSAPP (día 1 / día 3 tras completar la cita)
// ══════════════════════════════════════════
var DEFAULT_FOLLOWUP_TEMPLATES = {
  day1: 'Hola {nombre}! ¿Qué tal fue todo en la sesión de tu "{tattoo}"? \n\nTe dejo los cuidados para la curación:\n- Lava la zona con agua y jabón neutro 2 veces al día\n- Aplica una crema cicatrizante fina, sin tapar en exceso\n- No rasques ni arranques las pieles que se levanten\n- Evita el sol directo, la piscina, el mar y la sauna las próximas 2-3 semanas\n- Usa ropa holgada que no roce la zona\n\n¡Cualquier duda me escribes!',
  day3: 'Hola {nombre}! ¿Cómo va la curación de tu "{tattoo}"? \n\nSi puedes, mándame una foto para ver cómo va el proceso y así confirmamos que todo evoluciona bien.\n\n¡Gracias!'
};

function followupFirstName(name) {
  return (name || '').trim().split(' ')[0] || '';
}

function renderFollowupTemplate(tpl, vars) {
  return String(tpl || '')
    .replace(/{nombre}/g, vars.nombre || '')
    .replace(/{tattoo}/g, vars.tattoo || 'tatuaje')
    .replace(/{fecha}/g, vars.fecha || '')
    .replace(/{precio}/g, vars.precio || '0')
    .replace(/{senal}/g, vars.senal || '0');
}

function followupDate(dateStr, daysAhead, hour) {
  var d = new Date(dateStr + 'T' + (hour || 11) + ':00:00');
  if (isNaN(d.getTime())) d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d;
}

// Called when an appointment transitions to status='completed': schedules the day1/day3 messages
function scheduleAftercareFollowups(userId, apptId, a, profile) {
  var clientsList = profile.clients || [];
  var client = clientsList.find(function(c) { return c.name === a.name; });
  var phone = client && client.phone ? String(client.phone).trim() : '';
  if (!phone) return Promise.resolve();

  var ws = profile.waSettings || {};
  if (ws.enabled === false) return Promise.resolve();
  var autos = ws.automations || [];
  var day1Auto = autos.find(function(x) { return x.id === 'followup_48h'; });
  var day3Auto = autos.find(function(x) { return x.id === 'followup_week'; });

  var vars = {
    nombre: followupFirstName(a.name),
    tattoo: a.workType || a.type || a.notes || a.note || 'tatuaje',
    fecha: a.date || '',
    precio: a.price || 0,
    senal: a.deposit || 0
  };

  var jobs = [];
  if (!day1Auto || day1Auto.enabled !== false) {
    var msg1 = renderFollowupTemplate(day1Auto ? day1Auto.template : DEFAULT_FOLLOWUP_TEMPLATES.day1, vars);
    jobs.push(db.query(
      'INSERT INTO wa_followups (appointment_id,user_id,client_name,phone,kind,message,scheduled_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (appointment_id,kind) DO NOTHING',
      [apptId, userId, a.name || '', phone, 'day1', msg1, followupDate(a.date, 1, 11)]
    ));
  }
  if (!day3Auto || day3Auto.enabled !== false) {
    var msg3 = renderFollowupTemplate(day3Auto ? day3Auto.template : DEFAULT_FOLLOWUP_TEMPLATES.day3, vars);
    jobs.push(db.query(
      'INSERT INTO wa_followups (appointment_id,user_id,client_name,phone,kind,message,scheduled_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (appointment_id,kind) DO NOTHING',
      [apptId, userId, a.name || '', phone, 'day3', msg3, followupDate(a.date, 3, 11)]
    ));
  }
  return Promise.all(jobs).catch(function() {});
}

// Background worker: envía los seguimientos programados que ya tocan, cuando WhatsApp está conectado
setInterval(function() {
  db.query("SELECT * FROM wa_followups WHERE status='pending' AND scheduled_at <= NOW() ORDER BY scheduled_at ASC LIMIT 20")
    .then(function(r) {
      r.rows.forEach(function(f) {
        var session = waSessions[f.user_id];
        if (!session || !session.ready) return; // se reintenta en el siguiente ciclo
        var num = f.phone.replace(/[\s+\-()]/g, '');
        if (num.length === 9) num = '34' + num;
        session.client.sendMessage(num + '@c.us', f.message)
          .then(function() {
            return db.query("UPDATE wa_followups SET status='sent', sent_at=NOW() WHERE id=$1", [f.id]);
          })
          .catch(function(e) {
            db.query("UPDATE wa_followups SET status='failed', error=$1 WHERE id=$2", [e.message, f.id]).catch(function() {});
          });
      });
    })
    .catch(function() {});
}, 5 * 60 * 1000);

// Consulta de seguimientos programados/enviados (para mostrar en Ajustes > WhatsApp)
app.get('/api/wa/followups', authMiddleware, function(req, res) {
  db.query('SELECT id,client_name,kind,status,scheduled_at,sent_at FROM wa_followups WHERE user_id=$1 ORDER BY scheduled_at DESC LIMIT 100', [req.userId])
    .then(function(r) { res.json(r.rows); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

// Profile sync: save full profile data to PostgreSQL
app.post('/api/profile/sync', authMiddleware, function(req, res) {
  var userId = req.userId;
  var profilesData = req.body.profiles;
  if (!profilesData || !profilesData.length) return res.json({ ok: true });

  var ops = profilesData.map(function(p) {
    return db.query(
      'INSERT INTO profiles (id,user_id,name,role,color) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET name=$3,role=$4,color=$5',
      [p.id, userId, p.name||'', p.role||'', p.color||'v']
    ).then(function() {
      var apptOps = (p.appts||[]).map(function(a) {
        var apptId = a.id !== undefined && a.id !== null ? String(a.id) : crypto.randomUUID();
        return db.query('SELECT status FROM appointments WHERE id=$1', [apptId]).then(function(prev) {
          var oldStatus = prev.rows.length ? prev.rows[0].status : null;
          return db.query(
            'INSERT INTO appointments (id,profile_id,user_id,name,date,start,dur,color,status,price,deposit,work_type,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (id) DO UPDATE SET name=$4,date=$5,start=$6,dur=$7,color=$8,status=$9,price=$10,deposit=$11,work_type=$12,notes=$13',
            [apptId, p.id, userId, a.name||'', a.date||'', a.start||10, a.dur||2, a.color||'v', a.status||'pending', a.price||0, a.deposit||0, a.workType||a.type||'', a.notes||a.note||'']
          ).then(function() {
            if (oldStatus !== 'completed' && a.status === 'completed') {
              return scheduleAftercareFollowups(userId, apptId, a, p);
            }
          });
        }).catch(function(){});
      });
      var clientOps = (p.clients||[]).map(function(c) {
        var clientId = c.id !== undefined && c.id !== null ? String(c.id) : crypto.randomUUID();
        return db.query(
          'INSERT INTO clients (id,profile_id,user_id,name,phone,email,instagram,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET name=$4,phone=$5,email=$6,instagram=$7,notes=$8',
          [clientId, p.id, userId, c.name||'', c.phone||'', c.email||'', c.instagram||'', c.notes||'']
        ).catch(function(){});
      });
      return Promise.all(apptOps.concat(clientOps));
    });
  });

  Promise.all(ops)
    .then(function() { res.json({ ok: true }); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

// Admin: get a specific user's full data from PostgreSQL
app.get('/api/admin/user-data/:userId', adminMiddleware, function(req, res) {
  var uid = req.params.userId;
  db.query('SELECT * FROM profiles WHERE user_id=$1 ORDER BY id ASC', [uid])
    .then(function(pr) {
      if (!pr.rows.length) return res.status(404).json({ error: 'Sin datos guardados aún' });
      var profileIds = pr.rows.map(function(p){ return p.id; });
      return Promise.all([
        db.query('SELECT * FROM appointments WHERE profile_id=ANY($1) ORDER BY date,start', [profileIds]),
        db.query('SELECT * FROM clients WHERE profile_id=ANY($1)', [profileIds])
      ]).then(function(results) {
        var appts = results[0].rows;
        var clients = results[1].rows;
        var profiles = pr.rows.map(function(p) {
          return Object.assign({}, p, {
            appts: appts.filter(function(a){ return a.profile_id===p.id; }),
            clients: clients.filter(function(c){ return c.profile_id===p.id; })
          });
        });
        res.json({ profiles: profiles, updated_at: new Date().toISOString() });
      });
    })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

// Keep-alive for Render free plan
if (process.env.NODE_ENV === 'production' && process.env.RENDER_URL) {
  setInterval(function() {
    fetch(process.env.RENDER_URL + '/health').catch(function() {});
  }, 10 * 60 * 1000);
}

// ══════════════════════════════════════════
// WEBRTC SIGNALING (Socket.io)
// ══════════════════════════════════════════
const http = require('http');
const { Server } = require('socket.io');
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

// rooms: { roomId: { admin: socketId, user: socketId, userId: string } }
const rooms = {};

io.on('connection', function(socket) {
  // Admin solicita ver la pantalla de un usuario
  socket.on('admin:request-view', function(data) {
    rooms[data.roomId] = { admin: socket.id, userId: data.targetUserId };
    io.to('user:' + data.targetUserId).emit('view:request', { roomId: data.roomId, adminName: 'Admin' });
  });

  socket.on('user:join', function(data) {
    socket.join('user:' + data.userId);
    socket.userId = data.userId;
  });

  socket.on('view:accept', function(data) {
    var room = rooms[data.roomId];
    if (!room) return;
    room.user = socket.id;
    socket.join(data.roomId);
    io.to(room.admin).emit('view:accepted', { roomId: data.roomId });
  });
  socket.on('view:reject', function(data) {
    var room = rooms[data.roomId];
    if (!room) return;
    io.to(room.admin).emit('view:rejected', { roomId: data.roomId });
    delete rooms[data.roomId];
  });

  socket.on('webrtc:offer', function(data) {
    var room = rooms[data.roomId];
    if (!room) return;
    io.to(room.user).emit('webrtc:offer', { offer: data.offer, roomId: data.roomId });
  });
  socket.on('webrtc:answer', function(data) {
    var room = rooms[data.roomId];
    if (!room) return;
    io.to(room.admin).emit('webrtc:answer', { answer: data.answer, roomId: data.roomId });
  });
  socket.on('webrtc:ice', function(data) {
    var room = rooms[data.roomId];
    if (!room) return;
    var target = socket.id === room.admin ? room.user : room.admin;
    io.to(target).emit('webrtc:ice', { candidate: data.candidate });
  });

  socket.on('view:end', function(data) {
    var room = rooms[data.roomId];
    if (!room) return;
    io.to(room.admin).emit('view:ended');
    io.to(room.user).emit('view:ended');
    delete rooms[data.roomId];
  });

  socket.on('disconnect', function() {
    Object.keys(rooms).forEach(function(rid) {
      var r = rooms[rid];
      if (r.admin === socket.id || r.user === socket.id) {
        io.to(r.admin).emit('view:ended');
        io.to(r.user || '').emit('view:ended');
        delete rooms[rid];
      }
    });
  });
});

httpServer.listen(PORT, '0.0.0.0', function() {
  var os = require('os');
  var nets = os.networkInterfaces();
  var localIP = 'localhost';
  Object.keys(nets).forEach(function(name) {
    nets[name].forEach(function(net) {
      if (net.family === 'IPv4' && !net.internal) localIP = net.address;
    });
  });
  console.log('[SERVER] Port:', PORT);
  console.log('[SERVER] PC:     http://localhost:' + PORT);
  console.log('[SERVER] iPhone: http://' + localIP + ':' + PORT);
  console.log('[SERVER] Platform:', process.platform);
  console.log('[SERVER] Chrome:', getChromePath() || 'auto');
  console.log('[SERVER] Modo: LOCAL (sin Supabase)');
});
