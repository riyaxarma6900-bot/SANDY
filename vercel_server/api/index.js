const http = require('http');
const url = require('url');
const crypto = require('crypto');

const PRESET_KEYS = [
  "HOOK-7X9B-4M2K-8VQ1",
  "HOOK-9N3P-6T8W-2DY5",
  "HOOK-4K8R-1F7H-9CZ3",
  "HOOK-2W5L-8Q3M-7VB9",
  "HOOK-6B1N-9K4T-3XP8",
  "HOOK-8M4V-2Z7L-1DW6",
  "HOOK-3T9Q-7H1R-5KF2",
  "HOOK-5P2K-8W4Y-9NC7",
  "HOOK-1F7M-3B9T-6XZ4",
  "HOOK-9L5R-6K2W-8VH1",
  "HOOK-7D3Q-1N8P-4MC9",
  "HOOK-2Z8K-9V5F-3TB6",
  "HOOK-4W1L-7T3R-8DY2",
  "HOOK-6K9P-2M7B-1XQ5",
  "HOOK-8V4T-5H1N-9CZ7",
  "HOOK-3N7W-8F2K-6LR1",
  "HOOK-5B2M-4Q9T-7XP3",
  "HOOK-1R8K-6Z3W-2VF9",
  "HOOK-9T4L-1P7Y-8NC5",
  "HOOK-7M2Q-5K8B-3DW6"
];

// In-Memory Database store
let DB = {
  licenses: {},
  sessions: {},
  maintenance: false,
  maintenance_message: "Server is under maintenance. Please try again later."
};

// Initialize preset keys
PRESET_KEYS.forEach(k => {
  DB.licenses[k] = {
    key: k,
    duration_days: 7,
    status: 'unused',
    activated_at: 0,
    expires_at: 0,
    device_model: '',
    created_at: Math.floor(Date.now() / 1000)
  };
});

// Helper for Upstash/Vercel KV if configured
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const res = await fetch(`${KV_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    const d = await res.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch (e) {
    return null;
  }
}

async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await fetch(`${KV_URL}/set/${key}/${encodeURIComponent(JSON.stringify(value))}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
  } catch (e) {}
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Installation-ID'
  });
  res.end(JSON.stringify(data));
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8'
  });
  res.end(html);
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') {
    return Promise.resolve(req.body);
  }
  if (typeof req.body === 'string') {
    try { return Promise.resolve(JSON.parse(req.body)); } catch (e) {}
  }
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (e) {
        resolve({});
      }
    });
    setTimeout(() => {
      try { resolve(JSON.parse(body || '{}')); } catch (e) { resolve({}); }
    }, 1500);
  });
}

// Main Request Handler
async function handler(req, res) {
  const parsed = url.parse(req.url, true);
  const rawPath = parsed.pathname || '/';
  const normPath = rawPath.replace(/\/+$/, '') || '/';
  const isStatus = normPath === '/status' || normPath.endsWith('/status');
  const isActivate = normPath === '/license/activate' || normPath.endsWith('/license/activate') || normPath.includes('activate');
  const isValidate = normPath === '/session/validate' || normPath.endsWith('/session/validate') || normPath.includes('validate');
  const isRefresh = normPath === '/session/refresh' || normPath.endsWith('/session/refresh') || normPath.includes('refresh');
  const isAuthorize = normPath === '/feature/authorize' || normPath.endsWith('/feature/authorize') || normPath.includes('authorize');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Installation-ID, X-Feature-Token'
    });
    res.end();
    return;
  }

  const now = Math.floor(Date.now() / 1000);

  // Status check - Provides all parameters required by iOS App telemetry & cloud indicator
  if (isStatus) {
    sendJson(res, 200, {
      server: 'HOOK REGEDIT',
      status: DB.maintenance ? 'maintenance' : 'online',
      server_available: !DB.maintenance,
      plan_authorized: true,
      maintenance: DB.maintenance,
      maintenance_message: DB.maintenance_message,
      time: now,
      kv_enabled: Boolean(KV_URL),
      game: {
        bundle_identifier: 'com.dts.freefiremax',
        displayName: 'FREE FIRE MAX'
      },
      features: [
        'BODY', 'CHEST', 'NECK', 'MOD_SKINS', 'ESP',
        'HOLOGRAM_GUN', 'THREE_D', 'DRAG',
        'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'
      ]
    });
    return;
  }

  // Admin: Get Keys List & Maintenance Status
  if (normPath === '/api/admin/keys') {
    const list = Object.values(DB.licenses).map(lic => {
      let st = lic.status;
      if (st === 'active' && now > lic.expires_at) {
        st = 'expired';
      }
      const rem = lic.expires_at > 0 ? Math.max(0, lic.expires_at - now) : 0;
      return {
        ...lic,
        status: st,
        days_left: Math.round((rem / 86400) * 10) / 10
      };
    });
    sendJson(res, 200, { 
      keys: list,
      maintenance: DB.maintenance,
      maintenance_message: DB.maintenance_message
    });
    return;
  }

  // Admin Dashboard
  if (normPath === '/' || normPath === '/admin') {
    sendHtml(res, getDashboardHtml());
    return;
  }

  // Admin: Toggle Maintenance Mode
  if (normPath === '/api/admin/maintenance' && req.method === 'POST') {
    const body = await parseBody(req);
    DB.maintenance = Boolean(body.maintenance);
    if (body.message) {
      DB.maintenance_message = body.message;
    }
    if (KV_URL) {
      await kvSet('app:maintenance', { maintenance: DB.maintenance, message: DB.maintenance_message });
    }
    sendJson(res, 200, {
      success: true,
      maintenance: DB.maintenance,
      message: DB.maintenance_message
    });
    return;
  }

  // Check Maintenance Mode for App Endpoints
  if (DB.maintenance && (isActivate || isValidate || isRefresh || isAuthorize)) {
    sendJson(res, 503, {
      error: DB.maintenance_message || "Server is under maintenance. Please try again later.",
      status: "maintenance",
      maintenance: true
    });
    return;
  }

  // Activate License (matches /license/activate, /api/license/activate, etc.)
  if (isActivate) {
    const body = await parseBody(req);
    const key = ((body.license_key || body.key || parsed.query.license_key || parsed.query.key) || '').trim();
    const device_model = body.device_model || parsed.query.device_model || 'iPhone';

    if (!key) {
      sendJson(res, 400, { error: 'license_key is required' });
      return;
    }

    let lic = DB.licenses[key];
    if (!lic && KV_URL) {
      lic = await kvGet(`lic:${key}`);
    }

    if (!lic) {
      sendJson(res, 403, { error: 'Invalid License Key' });
      return;
    }

    if (lic.status === 'revoked') {
      sendJson(res, 403, { error: 'This license key has been revoked by admin' });
      return;
    }

    if (lic.status === 'unused') {
      lic.status = 'active';
      lic.activated_at = now;
      lic.expires_at = now + (lic.duration_days * 86400);
      lic.device_model = device_model;
      DB.licenses[key] = lic;
      if (KV_URL) await kvSet(`lic:${key}`, lic);
    } else if (lic.status === 'active') {
      if (now > lic.expires_at) {
        lic.status = 'expired';
        DB.licenses[key] = lic;
        sendJson(res, 403, {
          error: `License Expired! Your ${lic.duration_days} days validity has ended.`,
          status: 'expired',
          expired_at: lic.expires_at
        });
        return;
      }
    } else if (lic.status === 'expired') {
      sendJson(res, 403, { error: 'License Expired!' });
      return;
    }

    const token = 'ffa_' + crypto.randomBytes(16).toString('hex');
    const refresh_token = 'ffr_' + crypto.randomBytes(16).toString('hex');
    DB.sessions[token] = { key, expires_at: lic.expires_at };

    const remSec = Math.max(0, lic.expires_at - now);
    const daysLeft = Math.round((remSec / 86400) * 10) / 10;

    sendJson(res, 200, {
      success: true,
      status: 'active',
      plan: 'VIP PREMIUM',
      license_key: key,
      server_available: true,
      plan_authorized: true,
      activated_at: lic.activated_at,
      expires_at: lic.expires_at,
      duration_days: lic.duration_days,
      days_left: daysLeft,
      token,
      access_token: token,
      session_token: token,
      refresh_token,
      game: {
        bundle_identifier: 'com.dts.freefiremax',
        displayName: 'FREE FIRE MAX'
      },
      features: [
        'BODY', 'CHEST', 'NECK', 'MOD_SKINS', 'ESP',
        'HOLOGRAM_GUN', 'THREE_D', 'DRAG',
        'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'
      ],
      message: `License Active! ${daysLeft} Days Remaining`
    });
    return;
  }

  // Validate Session
  if (isValidate) {
    const body = await parseBody(req);
    const token = body.token || (req.headers['authorization'] || '').replace('Bearer ', '');
    const session = DB.sessions[token];

    if (!session) {
      sendJson(res, 401, { error: 'Invalid session token' });
      return;
    }

    if (now > session.expires_at) {
      sendJson(res, 403, { error: 'Session Expired!' });
      return;
    }

    sendJson(res, 200, {
      valid: true,
      success: true,
      server_available: true,
      plan_authorized: true,
      license_key: session.key,
      expires_at: session.expires_at,
      days_left: Math.round(((session.expires_at - now) / 86400) * 10) / 10
    });
    return;
  }

  // Refresh Session
  if (isRefresh) {
    const body = await parseBody(req);
    const token = 'ffa_' + crypto.randomBytes(16).toString('hex');
    const refresh_token = 'ffr_' + crypto.randomBytes(16).toString('hex');
    sendJson(res, 200, {
      success: true,
      token,
      access_token: token,
      refresh_token
    });
    return;
  }

  // Feature Authorize
  if (isAuthorize) {
    sendJson(res, 200, {
      success: true,
      authorized: true,
      plan_authorized: true,
      server_available: true
    });
    return;
  }

  // Admin: Generate Keys
  if (normPath === '/api/admin/generate' && req.method === 'POST') {
    const body = await parseBody(req);
    const count = parseInt(body.count || 5);
    const duration = parseInt(body.duration_days || 7);
    const generated = [];

    for (let i = 0; i < count; i++) {
      const p1 = crypto.randomBytes(2).toString('hex').toUpperCase();
      const p2 = crypto.randomBytes(2).toString('hex').toUpperCase();
      const p3 = crypto.randomBytes(2).toString('hex').toUpperCase();
      const k = `HOOK-${p1}-${p2}-${p3}`;
      DB.licenses[k] = {
        key: k,
        duration_days: duration,
        status: 'unused',
        activated_at: 0,
        expires_at: 0,
        device_model: '',
        created_at: now
      };
      if (KV_URL) await kvSet(`lic:${k}`, DB.licenses[k]);
      generated.push(k);
    }
    sendJson(res, 200, { success: true, duration_days: duration, generated });
    return;
  }

  // Admin: Revoke Key
  if (normPath === '/api/admin/revoke' && req.method === 'POST') {
    const body = await parseBody(req);
    const key = body.license_key;
    if (DB.licenses[key]) {
      DB.licenses[key].status = 'revoked';
      if (KV_URL) await kvSet(`lic:${key}`, DB.licenses[key]);
    }
    sendJson(res, 200, { success: true, message: `Key ${key} revoked` });
    return;
  }

  sendJson(res, 404, { error: 'Endpoint not found' });
}

function getDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>HOOK REGEDIT - Vercel License Portal</title>
<style>
  :root {
    --bg: #0b0c10;
    --card: #141720;
    --primary: #ff2a2a;
    --primary-glow: rgba(255, 42, 42, 0.4);
    --text: #ffffff;
    --text-muted: #8b949e;
    --border: #232936;
    --success: #00ff88;
    --warning: #ffb800;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  body { background: var(--bg); color: var(--text); padding: 30px 20px; min-height: 100vh; }
  .container { max-width: 1100px; margin: 0 auto; }
  header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid var(--border); padding-bottom: 20px; margin-bottom: 25px; }
  .logo-title { display: flex; align-items: center; gap: 15px; }
  .logo-badge { background: linear-gradient(135deg, #ff2a2a, #aa0000); color: #fff; padding: 10px 18px; border-radius: 12px; font-weight: 900; font-size: 20px; box-shadow: 0 0 20px var(--primary-glow); }
  h1 { font-size: 26px; font-weight: 800; }
  .subtitle { color: var(--text-muted); font-size: 13px; margin-top: 3px; }
  
  .maintenance-banner { display: none; background: #351010; border: 1px solid #ff2a2a; color: #ff6b6b; padding: 14px 20px; border-radius: 10px; margin-bottom: 25px; font-weight: 700; font-size: 14px; box-shadow: 0 0 20px rgba(255,42,42,0.3); animation: pulse 2s infinite; }
  @keyframes pulse { 0% { opacity: 0.8; } 50% { opacity: 1; } 100% { opacity: 0.8; } }
  
  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 25px; }
  .stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; text-align: center; }
  .stat-val { font-size: 32px; font-weight: 800; margin-top: 5px; color: var(--primary); }
  
  .controls-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 30px; }
  @media(max-width: 800px) { .controls-grid { grid-template-columns: 1fr; } }
  
  .card-box { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 22px; display: flex; flex-direction: column; gap: 15px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
  .card-title { font-size: 15px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid var(--border); padding-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
  
  .gen-group { display: flex; flex-direction: column; gap: 6px; }
  .gen-group label { font-size: 12px; text-transform: uppercase; color: var(--text-muted); font-weight: 700; letter-spacing: 0.5px; }
  select, input { background: #0b0d13; color: white; border: 1px solid #303848; padding: 11px 16px; border-radius: 8px; font-size: 14px; font-weight: 600; outline: none; }
  select:focus, input:focus { border-color: var(--primary); box-shadow: 0 0 10px var(--primary-glow); }
  
  button { background: var(--primary); color: white; border: none; padding: 12px 24px; border-radius: 8px; font-weight: 700; cursor: pointer; transition: 0.2s; box-shadow: 0 0 15px var(--primary-glow); }
  button:hover { background: #ff4747; transform: translateY(-2px); }
  .btn-warning { background: #ff9900; box-shadow: 0 0 15px rgba(255,153,0,0.4); }
  .btn-warning:hover { background: #ffaa22; }
  .btn-success { background: #00cc66; box-shadow: 0 0 15px rgba(0,204,102,0.4); }
  .btn-success:hover { background: #00dd77; }
  .btn-secondary { background: #232936; box-shadow: none; }
  .btn-secondary:hover { background: #2f3647; }
  
  table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 12px; overflow: hidden; border: 1px solid var(--border); }
  th, td { padding: 14px 18px; text-align: left; border-bottom: 1px solid var(--border); }
  th { background: #1a1f2c; color: var(--text-muted); font-size: 13px; text-transform: uppercase; }
  .key-code { font-family: monospace; font-size: 15px; font-weight: bold; color: #ff5e5e; background: #231518; padding: 5px 10px; border-radius: 6px; border: 1px solid rgba(255, 42, 42, 0.3); }
  .badge { display: inline-block; padding: 5px 12px; border-radius: 20px; font-size: 12px; font-weight: bold; text-transform: uppercase; }
  .badge-unused { background: #2c2514; color: var(--warning); border: 1px solid var(--warning); }
  .badge-active { background: #123324; color: var(--success); border: 1px solid var(--success); }
  .badge-expired { background: #351515; color: var(--primary); border: 1px solid var(--primary); }
  .badge-revoked { background: #222; color: #777; border: 1px solid #444; }
  .copy-btn { background: #1c2230; color: #8fa1c4; border: 1px solid #2d374d; padding: 5px 10px; font-size: 11px; border-radius: 4px; box-shadow: none; cursor: pointer; margin-left: 8px; }
  .copy-btn:hover { background: #2c354a; color: #fff; }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo-title">
      <div class="logo-badge">H</div>
      <div>
        <h1>HOOK REGEDIT // VERCEL CLOUD PORTAL</h1>
        <div class="subtitle">Multi-Tier VIP License & Server Operations Center</div>
      </div>
    </div>
    <div style="text-align: right;" id="serverStatusBadge">
      <span style="display: inline-block; width: 10px; height: 10px; background: #00ff88; border-radius: 50%; box-shadow: 0 0 10px #00ff88;"></span>
      <span style="font-size: 13px; color: #00ff88; font-weight: bold; margin-left: 5px;">SERVER ONLINE</span>
    </div>
  </header>

  <div id="maintenanceAlert" class="maintenance-banner">
    🚨 WARNING: SERVER IS CURRENTLY IN MAINTENANCE MODE! Users cannot activate keys or play.
  </div>

  <div class="stats-row">
    <div class="stat-card">
      <div style="color: var(--text-muted); font-size: 13px;">TOTAL KEYS</div>
      <div class="stat-val" id="totalKeys">0</div>
    </div>
    <div class="stat-card">
      <div style="color: var(--text-muted); font-size: 13px;">UNUSED (READY)</div>
      <div class="stat-val" style="color: var(--warning);" id="unusedKeys">0</div>
    </div>
    <div class="stat-card">
      <div style="color: var(--text-muted); font-size: 13px;">ACTIVE (RUNNING)</div>
      <div class="stat-val" style="color: var(--success);" id="activeKeys">0</div>
    </div>
    <div class="stat-card">
      <div style="color: var(--text-muted); font-size: 13px;">EXPIRED / REVOKED</div>
      <div class="stat-val" style="color: #888;" id="expiredKeys">0</div>
    </div>
  </div>

  <div class="controls-grid">
    <!-- Card 1: Key Generator -->
    <div class="card-box">
      <div class="card-title">
        <span>⚡ VIP Key Generator</span>
        <span style="font-size: 11px; color: var(--text-muted); font-weight: normal;">Multi-Tier</span>
      </div>
      <div style="display: flex; gap: 12px; flex-wrap: wrap;">
        <div class="gen-group" style="flex: 1;">
          <label>Validity:</label>
          <select id="durationSelect">
            <option value="1">⏱️ 1 Day (Trial)</option>
            <option value="7" selected>⚡ 7 Days (Weekly)</option>
            <option value="30">👑 30 Days (Monthly)</option>
            <option value="60">🔥 60 Days (2 Months)</option>
            <option value="365">💎 365 Days (1 Year)</option>
          </select>
        </div>
        <div class="gen-group" style="flex: 1;">
          <label>Quantity:</label>
          <select id="countSelect">
            <option value="1">1 Key</option>
            <option value="5" selected>5 Keys</option>
            <option value="10">10 Keys</option>
            <option value="20">20 Keys</option>
          </select>
        </div>
      </div>
      <button onclick="generateCustomKeys()">⚡ Generate Selected Keys</button>
    </div>

    <!-- Card 2: Maintenance Mode Control -->
    <div class="card-box">
      <div class="card-title">
        <span>🛠️ Server Maintenance Control</span>
        <span id="maintStatusText" style="font-size: 12px; color: #00ff88; font-weight: bold;">[NORMAL]</span>
      </div>
      <div class="gen-group">
        <label>Maintenance Message to Users:</label>
        <input type="text" id="maintMessageInput" value="Server is under maintenance. Please try again later." />
      </div>
      <div style="display: flex; gap: 10px; margin-top: auto;">
        <button id="maintToggleBtn" class="btn-warning" style="flex: 1;" onclick="toggleMaintenance()">
          🚨 Turn ON Maintenance
        </button>
        <button class="btn-secondary" onclick="loadKeys()">🔄 Refresh</button>
      </div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>License Key</th>
        <th>Validity</th>
        <th>Status</th>
        <th>Remaining Time</th>
        <th>Device</th>
        <th>Action</th>
      </tr>
    </thead>
    <tbody id="keysTable">
      <tr><td colspan="6" style="text-align: center; color: var(--text-muted);">Loading keys...</td></tr>
    </tbody>
  </table>
</div>

<script>
let currentMaintenanceState = false;

async function loadKeys() {
  try {
    const res = await fetch('/api/admin/keys');
    const data = await res.json();
    const tbody = document.getElementById('keysTable');
    tbody.innerHTML = '';
    
    // Update Maintenance UI
    currentMaintenanceState = Boolean(data.maintenance);
    const maintAlert = document.getElementById('maintenanceAlert');
    const maintText = document.getElementById('maintStatusText');
    const maintBtn = document.getElementById('maintToggleBtn');
    const statusBadge = document.getElementById('serverStatusBadge');
    
    if (currentMaintenanceState) {
      maintAlert.style.display = 'block';
      maintText.innerText = '[MAINTENANCE ACTIVE]';
      maintText.style.color = '#ff2a2a';
      maintBtn.className = 'btn-success';
      maintBtn.innerText = '🟢 Turn OFF Maintenance (Resume)';
      statusBadge.innerHTML = '<span style="display: inline-block; width: 10px; height: 10px; background: #ff2a2a; border-radius: 50%; box-shadow: 0 0 10px #ff2a2a;"></span><span style="font-size: 13px; color: #ff2a2a; font-weight: bold; margin-left: 5px;">MAINTENANCE MODE</span>';
    } else {
      maintAlert.style.display = 'none';
      maintText.innerText = '[NORMAL]';
      maintText.style.color = '#00ff88';
      maintBtn.className = 'btn-warning';
      maintBtn.innerText = '🚨 Turn ON Maintenance';
      statusBadge.innerHTML = '<span style="display: inline-block; width: 10px; height: 10px; background: #00ff88; border-radius: 50%; box-shadow: 0 0 10px #00ff88;"></span><span style="font-size: 13px; color: #00ff88; font-weight: bold; margin-left: 5px;">SERVER ONLINE</span>';
    }

    if (data.maintenance_message) {
      document.getElementById('maintMessageInput').value = data.maintenance_message;
    }

    let total = data.keys.length;
    let unused = 0, active = 0, expired = 0;

    data.keys.forEach(k => {
      if(k.status === 'unused') unused++;
      else if(k.status === 'active') active++;
      else expired++;

      let badgeClass = 'badge-' + k.status;
      let remainingText = k.status === 'unused' ? k.duration_days + ' Days (Not started)' : (k.status === 'active' ? k.days_left + ' Days Left' : '0 Days (Ended)');
      
      const tr = document.createElement('tr');
      tr.innerHTML = \`
        <td>
          <span class="key-code">\${k.key}</span>
          <button class="copy-btn" onclick="copyKey('\${k.key}', this)">Copy</button>
        </td>
        <td style="font-weight: 700; color: #ffb800;">\${k.duration_days} \${k.duration_days == 1 ? 'Day' : 'Days'}</td>
        <td><span class="badge \${badgeClass}">\${k.status}</span></td>
        <td style="font-weight: 600; color: \${k.status==='active' ? '#00ff88' : '#aaa'}">\${remainingText}</td>
        <td style="color: #aaa; font-size: 13px;">\${k.device_model || '—'}</td>
        <td>
          \${k.status !== 'revoked' ? \`<button style="background: #441414; padding: 6px 12px; font-size: 12px; box-shadow: none;" onclick="revokeKey('\${k.key}')">Revoke</button>\` : '<span style="color:#666;">Revoked</span>'}
        </td>
      \`;
      tbody.appendChild(tr);
    });

    document.getElementById('totalKeys').innerText = total;
    document.getElementById('unusedKeys').innerText = unused;
    document.getElementById('activeKeys').innerText = active;
    document.getElementById('expiredKeys').innerText = expired;
  } catch(e) {
    console.error(e);
  }
}

async function toggleMaintenance() {
  const newState = !currentMaintenanceState;
  const msg = document.getElementById('maintMessageInput').value;
  const confirmMsg = newState 
    ? 'Are you sure you want to turn ON Maintenance Mode?\\nUsers will not be able to activate or login.' 
    : 'Turn OFF Maintenance Mode and resume normal access?';
  
  if(!confirm(confirmMsg)) return;

  await fetch('/api/admin/maintenance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ maintenance: newState, message: msg })
  });
  loadKeys();
}

async function generateCustomKeys() {
  const duration = document.getElementById('durationSelect').value;
  const count = document.getElementById('countSelect').value;

  const res = await fetch('/api/admin/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: count, duration_days: duration })
  });
  const data = await res.json();
  alert('Successfully generated ' + count + ' keys with ' + duration + ' Days validity!');
  loadKeys();
}

function copyKey(key, btn) {
  navigator.clipboard.writeText(key);
  const oldText = btn.innerText;
  btn.innerText = 'Copied!';
  setTimeout(() => { btn.innerText = oldText; }, 1500);
}

async function revokeKey(key) {
  if(!confirm('Are you sure you want to revoke key ' + key + '?')) return;
  await fetch('/api/admin/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ license_key: key })
  });
  loadKeys();
}

loadKeys();
</script>
</body>
</html>`;
}

// Export for Vercel Serverless Function
module.exports = handler;

// Local Node execution support
if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  http.createServer(handler).listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}
