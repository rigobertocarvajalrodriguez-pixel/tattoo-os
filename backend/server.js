const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://svremmknodxnaekzrunw.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN2cmVtbWtub2R4bmFla3pydW53Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg5MjM0NjksImV4cCI6MjA5NDQ5OTQ2OX0.CdXcxj2aoR1TOhnt524zPeHLsLvIkcnVqLLDcdJUB3E';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Sessions store: { userId: { client, qr, ready, state } }
const waSessions = {};

const SESSION_BASE = process.env.NODE_ENV === 'production' ? '/tmp/wa_sessions' : path.join(__dirname, 'data', 'wa_sessions');

if (!fs.existsSync(SESSION_BASE)) fs.mkdirSync(SESSION_BASE, { recursive: true });

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
async function authMiddleware(req, res, next) {
  var token = req.headers.authorization && req.headers.authorization.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    var result = await supabase.auth.getUser(token);
    if (result.error || !result.data.user) return res.status(401).json({ error: 'Token invalido' });
    req.userId = result.data.user.id;
    req.user = result.data.user;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Error de autenticacion' });
  }
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
    supabase.from('whatsapp_sessions')
      .upsert({ user_id: userId, connected: true, updated_at: new Date().toISOString() })
      .then(function() {});
  });

  client.on('disconnected', function(reason) {
    console.log('[WA] Disconnected:', userId.slice(0, 8), reason);
    if (waSessions[userId]) {
      waSessions[userId].ready = false;
      waSessions[userId].state = 'DISCONNECTED';
    }
    supabase.from('whatsapp_sessions')
      .upsert({ user_id: userId, connected: false, updated_at: new Date().toISOString() })
      .then(function() {});
    // Don't auto-restart - user must click Verify button again
  });

  client.initialize().catch(function(err) {
    console.error('[WA] Init error for', userId.slice(0, 8), ':', err.message);
    if (waSessions[userId]) {
      waSessions[userId].state = 'ERROR';
      waSessions[userId].ready = false;
      // Clean up so user can retry
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

// Clients API
app.get('/api/clients', authMiddleware, async function(req, res) {
  var r = await supabase.from('clients').select('*').eq('user_id', req.userId).order('created_at', { ascending: false });
  if (r.error) return res.status(500).json({ error: r.error.message });
  res.json(r.data);
});
app.post('/api/clients', authMiddleware, async function(req, res) {
  var r = await supabase.from('clients').insert(Object.assign({}, req.body, { user_id: req.userId })).select().single();
  if (r.error) return res.status(500).json({ error: r.error.message });
  res.json(r.data);
});
app.put('/api/clients/:id', authMiddleware, async function(req, res) {
  var r = await supabase.from('clients').update(req.body).eq('id', req.params.id).eq('user_id', req.userId).select().single();
  if (r.error) return res.status(500).json({ error: r.error.message });
  res.json(r.data);
});
app.delete('/api/clients/:id', authMiddleware, async function(req, res) {
  var r = await supabase.from('clients').delete().eq('id', req.params.id).eq('user_id', req.userId);
  if (r.error) return res.status(500).json({ error: r.error.message });
  res.json({ success: true });
});

// Appointments API
app.get('/api/appointments', authMiddleware, async function(req, res) {
  var r = await supabase.from('appointments').select('*').eq('user_id', req.userId).order('date', { ascending: true });
  if (r.error) return res.status(500).json({ error: r.error.message });
  res.json(r.data);
});
app.post('/api/appointments', authMiddleware, async function(req, res) {
  var r = await supabase.from('appointments').insert(Object.assign({}, req.body, { user_id: req.userId })).select().single();
  if (r.error) return res.status(500).json({ error: r.error.message });
  res.json(r.data);
});
app.put('/api/appointments/:id', authMiddleware, async function(req, res) {
  var r = await supabase.from('appointments').update(req.body).eq('id', req.params.id).eq('user_id', req.userId).select().single();
  if (r.error) return res.status(500).json({ error: r.error.message });
  res.json(r.data);
});
app.delete('/api/appointments/:id', authMiddleware, async function(req, res) {
  var r = await supabase.from('appointments').delete().eq('id', req.params.id).eq('user_id', req.userId);
  if (r.error) return res.status(500).json({ error: r.error.message });
  res.json({ success: true });
});

// Expenses API
app.get('/api/expenses', authMiddleware, async function(req, res) {
  var r = await supabase.from('expenses').select('*').eq('user_id', req.userId).order('date', { ascending: false });
  if (r.error) return res.status(500).json({ error: r.error.message });
  res.json(r.data);
});
app.post('/api/expenses', authMiddleware, async function(req, res) {
  var r = await supabase.from('expenses').insert(Object.assign({}, req.body, { user_id: req.userId })).select().single();
  if (r.error) return res.status(500).json({ error: r.error.message });
  res.json(r.data);
});
app.delete('/api/expenses/:id', authMiddleware, async function(req, res) {
  var r = await supabase.from('expenses').delete().eq('id', req.params.id).eq('user_id', req.userId);
  if (r.error) return res.status(500).json({ error: r.error.message });
  res.json({ success: true });
});

// Keep-alive for Render free plan
if (process.env.NODE_ENV === 'production' && process.env.RENDER_URL) {
  setInterval(function() {
    fetch(process.env.RENDER_URL + '/health').catch(function() {});
  }, 10 * 60 * 1000);
}

app.listen(PORT, function() {
  console.log('[SERVER] Port:', PORT);
  console.log('[SERVER] Panel: http://localhost:' + PORT);
  console.log('[SERVER] Platform:', process.platform);
  console.log('[SERVER] Chrome:', getChromePath() || 'auto');
  console.log('[SERVER] Supabase:', SUPABASE_URL);
});
