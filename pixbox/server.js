require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');
const axios   = require('axios');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT              = parseInt(process.env.PORT || '3000');
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REDIRECT_URI  = process.env.SPOTIFY_REDIRECT_URI || `http://127.0.0.1:${PORT}/api/spotify/callback`;
const SONG_PRICE_CENTS  = parseInt(process.env.SONG_PRICE_CENTS || '100');
const MAX_SONG_DURATION_MIN = parseInt(process.env.MAX_SONG_DURATION_MIN || '8');
const BLOCK_EXPLICIT    = process.env.BLOCK_EXPLICIT === 'true';
const FORCE_MOCK        = process.env.FORCE_MOCK === 'true';
const TOKENS_FILE       = path.join(__dirname, '.tokens.json');
const MP_ACCESS_TOKEN   = process.env.MP_ACCESS_TOKEN;

// ============================================================
// LISTA NEGRA DE ARTISTAS
// ============================================================
const BLOCKED_ARTISTS = [
  'mc kevin o chris','kevin o chris','mc ryan sp','mc cabelinho','matuê','matue',
  'mc poze do rodo','poze do rodo','tati quebra barraco','mc ig','mc dricka','dricka',
  'oruam','xamã','xama','sidoka','kayblack','veigh','teto','chefin','mc hariel',
  'mc davi','mc don juan','mc paiva','mc pedrinho','mc brinquedo',
  'tasha & tracie','tasha e tracie','flora matos','djonga','filipe ret',
  'mc pipokinha','pipokinha','valesca popozuda','valesca',
  'mc jessica do escadão','mc jessica','mc torugo',
  'mc joãozinho vt','mc joaozinho vt','nego do borel','mc g15',
  'mc rodrigo do cn','mc neguinho do kaxeta','mc magal','mc lucy',
  'mc lon','mc luki','mc luuky','mc gh do 7','mc digu',
  'mc fabinho da osk','mc leozin','mc leozinho zs',
  'mc negão original','mc negao original','mc kako','mc kadu',
  'mc jvila','mc j vila','mc lele jp','mc gury','mc l da vinte','mc du black',
];
function norm(s) { return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''); }
function isBlockedArtist(artists) {
  const names   = artists.map(a => norm(a.name));
  const blocked = BLOCKED_ARTISTS.map(norm);
  return names.some(n => blocked.some(b => n.includes(b) || b.includes(n)));
}

// ============================================================
// IN-MEMORY STATE
// ============================================================
const sessions     = new Map();
const mpIdToSession = new Map(); // MP payment id -> sessionId
const pendingPixSessions = new Set();
const queueHistory = [];
const spotifyTokens = { access_token:null, refresh_token:null, expires_at:0, user:null };
const newId = () => crypto.randomBytes(8).toString('hex');

// ============================================================
// SPOTIFY TOKEN PERSISTENCE
// ============================================================
function saveTokens() {
  try { fs.writeFileSync(TOKENS_FILE, JSON.stringify(spotifyTokens)); } catch(e) {}
}
function loadTokens() {
  try {
    if (!fs.existsSync(TOKENS_FILE)) return;
    Object.assign(spotifyTokens, JSON.parse(fs.readFileSync(TOKENS_FILE,'utf-8')));
    console.log('[spotify] Sessão restaurada:', spotifyTokens.user?.display_name);
  } catch(e) {}
}
async function refreshSpotifyToken() {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method:'POST',
    headers:{ Authorization:'Basic '+Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'), 'Content-Type':'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type:'refresh_token', refresh_token:spotifyTokens.refresh_token }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Refresh failed: '+JSON.stringify(data));
  spotifyTokens.access_token = data.access_token;
  spotifyTokens.expires_at = Date.now() + data.expires_in*1000;
  if (data.refresh_token) spotifyTokens.refresh_token = data.refresh_token;
  saveTokens();
}
function startTokenKeepAlive() {
  setInterval(async () => {
    if (!spotifyTokens.refresh_token) return;
    try { await refreshSpotifyToken(); } catch(e) { console.error('[keepalive]',e.message); }
  }, 45*60*1000);
}
async function spotifyFetch(endpoint, options={}) {
  if (!spotifyTokens.access_token) throw new Error('Spotify não conectado.');
  if (Date.now() > spotifyTokens.expires_at - 60_000) await refreshSpotifyToken();
  return fetch(`https://api.spotify.com/v1${endpoint}`, {
    ...options,
    headers:{ Authorization:`Bearer ${spotifyTokens.access_token}`, 'Content-Type':'application/json', ...(options.headers||{}) },
  });
}

// ============================================================
// MERCADO PAGO PIX
// ============================================================
async function createPixCharge(session) {
  if (!MP_ACCESS_TOKEN || FORCE_MOCK) {
    if (FORCE_MOCK) console.log('[mp] FORCE_MOCK ativo.');
    return { mpId:'MOCK-'+session.id, brcode:'MOCK_BRCODE', qrBase64:null, mock:true };
  }
  const res = await axios.post('https://api.mercadopago.com/v1/payments', {
    transaction_amount: session.amount / 100,
    description: 'Pixbox — 1 música',
    payment_method_id: 'pix',
    external_reference: session.id,
    payer: { email: 'cliente@pixbox.app' },
  }, {
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': session.id,
    }
  });
  const d = res.data;
  console.log('[mp] Cobrança criada id:', d.id);
  return {
    mpId: String(d.id),
    brcode: d.point_of_interaction.transaction_data.qr_code,
    qrBase64: d.point_of_interaction.transaction_data.qr_code_base64 || null,
    mock: false,
  };
}

// Polling: verifica status do pagamento no MP a cada 3s
async function checkPixSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || session.status !== 'awaiting_payment') { pendingPixSessions.delete(sessionId); return; }
  if (Date.now() > session.expiresAt) { session.status='expired'; pendingPixSessions.delete(sessionId); return; }
  if (!session.mpId || session.mpId.startsWith('MOCK-')) return;
  try {
    const res = await axios.get(`https://api.mercadopago.com/v1/payments/${session.mpId}`, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` }
    });
    if (res.data.status === 'approved') {
      session.status = 'paid';
      pendingPixSessions.delete(sessionId);
      console.log('[poll] ✓ Pix pago! Sessão:', sessionId);
    }
  } catch(e) { console.error('[poll] Erro:', e.message); }
}
function startPixPolling() {
  setInterval(async () => {
    for (const id of pendingPixSessions) await checkPixSession(id);
  }, 3000);
  console.log('[poll] Polling ativo (3s).');
}

// ============================================================
// SPOTIFY OAUTH
// ============================================================
app.get('/api/spotify/login', (req,res) => {
  if (!SPOTIFY_CLIENT_ID) return res.status(500).send('SPOTIFY_CLIENT_ID não configurado.');
  const params = new URLSearchParams({ response_type:'code', client_id:SPOTIFY_CLIENT_ID, scope:'user-modify-playback-state user-read-playback-state user-read-currently-playing', redirect_uri:SPOTIFY_REDIRECT_URI });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});
app.get('/api/spotify/callback', async (req,res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send('Spotify error: '+error);
  try {
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method:'POST',
      headers:{ Authorization:'Basic '+Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'), 'Content-Type':'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type:'authorization_code', code, redirect_uri:SPOTIFY_REDIRECT_URI }),
    });
    const data = await tokenRes.json();
    if (!tokenRes.ok) return res.status(500).send('Token error: '+JSON.stringify(data));
    spotifyTokens.access_token = data.access_token;
    spotifyTokens.refresh_token = data.refresh_token;
    spotifyTokens.expires_at = Date.now() + data.expires_in*1000;
    const meRes = await spotifyFetch('/me');
    if (meRes.ok) spotifyTokens.user = await meRes.json();
    saveTokens();
    res.redirect('/host.html?connected=1');
  } catch(e) { res.status(500).send('Error: '+e.message); }
});
app.get('/api/spotify/status', (req,res) => {
  res.json({ connected:!!spotifyTokens.access_token, user:spotifyTokens.user ? { name:spotifyTokens.user.display_name, product:spotifyTokens.user.product } : null });
});

// ============================================================
// SESSIONS / PAYMENT
// ============================================================
app.post('/api/sessions', async (req,res) => {
  const id = newId();
  const session = { id, status:'awaiting_payment', createdAt:Date.now(), expiresAt:Date.now()+5*60*1000, amount:SONG_PRICE_CENTS, song:null, mpId:null };
  try {
    const pix = await createPixCharge(session);
    session.mpId = pix.mpId;
    mpIdToSession.set(pix.mpId, id);
    sessions.set(id, session);
    pendingPixSessions.add(id);
    res.json({ sessionId:id, amount:SONG_PRICE_CENTS, brcode:pix.brcode, qrBase64:pix.qrBase64||null, mock:pix.mock||false, expiresAt:session.expiresAt });
  } catch(e) { res.status(500).json({ error:'Falha ao criar Pix: '+e.message }); }
});
app.get('/api/sessions/:id/status', (req,res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error:'not found' });
  res.json({ status:s.status });
});
app.post('/api/sessions/:id/simulate-payment', (req,res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error:'not found' });
  if (s.status !== 'awaiting_payment') return res.status(400).json({ error:'invalid state' });
  s.status = 'paid';
  res.json({ ok:true });
});

// Webhook do Mercado Pago
app.post('/api/webhooks/pix', async (req,res) => {
  res.json({ ok:true }); // responde rápido pro MP
  const id = req.body?.data?.id;
  if (!id) return;
  try {
    const r = await axios.get(`https://api.mercadopago.com/v1/payments/${id}`, {
      headers:{ Authorization:`Bearer ${MP_ACCESS_TOKEN}` }
    });
    if (r.data.status === 'approved') {
      const sessionId = mpIdToSession.get(String(id)) || mpIdToSession.get(r.data.external_reference);
      const session = sessions.get(sessionId) || sessions.get(r.data.external_reference);
      if (session && session.status === 'awaiting_payment') {
        session.status = 'paid';
        console.log('[webhook] ✓ Pago via MP webhook:', session.id);
      }
    }
  } catch(e) { console.error('[webhook] Erro:', e.message); }
});

// ============================================================
// SEARCH & QUEUE
// ============================================================
app.get('/api/sessions/:id/search', async (req,res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error:'sessão não encontrada' });
  if (s.status !== 'paid') return res.status(403).json({ error:'sessão não paga' });
  const q = (req.query.q||'').toString().trim();
  if (!q) return res.json({ tracks:[] });
  try {
    const r = await spotifyFetch(`/search?q=${encodeURIComponent(q)}&type=track&limit=10&market=BR`);
    if (!r.ok) return res.status(500).json({ error:await r.text() });
    const data = await r.json();
    const maxMs = MAX_SONG_DURATION_MIN*60_000;
    const tracks = data.tracks.items
      .filter(t => t.duration_ms <= maxMs)
      .filter(t => !(BLOCK_EXPLICIT && t.explicit))
      .filter(t => !isBlockedArtist(t.artists))
      .map(t => ({ id:t.id, uri:t.uri, name:t.name, artists:t.artists.map(a=>a.name).join(', '), album:t.album.name, duration_ms:t.duration_ms, explicit:t.explicit, image:t.album.images.find(i=>i.width<=300)?.url||t.album.images.at(-1)?.url||null }));
    res.json({ tracks });
  } catch(e) { res.status(500).json({ error:e.message }); }
});
app.post('/api/sessions/:id/queue', async (req,res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error:'sessão não encontrada' });
  if (s.status !== 'paid') return res.status(403).json({ error:'sessão não paga' });
  const { trackUri, trackName, trackArtists } = req.body||{};
  if (!trackUri) return res.status(400).json({ error:'missing trackUri' });
  try {
    const devRes = await spotifyFetch('/me/player/devices');
    const devData = await devRes.json();
    const active = devData.devices?.find(d=>d.is_active)||devData.devices?.[0];
    if (!active) return res.status(503).json({ error:'Nenhum dispositivo Spotify ativo.' });
    const qRes = await spotifyFetch(`/me/player/queue?uri=${encodeURIComponent(trackUri)}&device_id=${active.id}`, { method:'POST' });
    if (!qRes.ok) return res.status(500).json({ error:'Spotify queue error: '+await qRes.text() });
    s.status='queued'; s.song={ uri:trackUri, name:trackName, artists:trackArtists };
    queueHistory.unshift({ at:Date.now(), name:trackName, artists:trackArtists });
    if (queueHistory.length>20) queueHistory.pop();
    res.json({ ok:true, queuedOnDevice:active.name });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ============================================================
// HOST DASHBOARD
// ============================================================
app.get('/api/host/now-playing', async (req,res) => {
  if (!spotifyTokens.access_token) return res.json({ connected:false });
  try {
    const r = await spotifyFetch('/me/player/currently-playing');
    if (r.status===204) return res.json({ connected:true, playing:null });
    if (!r.ok) return res.json({ connected:true, playing:null });
    const d = await r.json();
    res.json({ connected:true, playing:d.item ? { name:d.item.name, artists:d.item.artists.map(a=>a.name).join(', '), progress_ms:d.progress_ms, duration_ms:d.item.duration_ms, image:d.item.album.images[0]?.url, is_playing:d.is_playing } : null });
  } catch(e) { res.json({ connected:true, playing:null }); }
});
app.get('/api/host/stats', (req,res) => {
  const today = new Date().setHours(0,0,0,0);
  let paidToday=0, queuedToday=0;
  for (const s of sessions.values()) {
    if (s.createdAt>=today) { if (['paid','queued'].includes(s.status)) paidToday++; if (s.status==='queued') queuedToday++; }
  }
  res.json({ paidToday, queuedToday, revenueCentsToday:queuedToday*SONG_PRICE_CENTS, recentQueued:queueHistory.slice(0,10) });
});

// ============================================================
// START
// ============================================================
loadTokens(); startTokenKeepAlive(); startPixPolling();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎵 Pixbox rodando — http://127.0.0.1:${PORT}\n`);
  if (!MP_ACCESS_TOKEN) console.log('   ⚠ MP_ACCESS_TOKEN não configurado (mock ativo).\n');
  if (FORCE_MOCK)       console.log('   ⚠ FORCE_MOCK ativo.\n');
  if (BLOCK_EXPLICIT)   console.log('   ✓ Filtro explícitos ativo.\n');
  console.log(`   ✓ Lista negra: ${BLOCKED_ARTISTS.length} artistas.\n`);
});
