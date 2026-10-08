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
  sessions: {}
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
  });
}

// Main Request Handler
async function handler(req, res) {
  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Installation-ID'
    });
    res.end();
    return;
  }

  const now = Math.floor(Date.now() / 1000);

  // Status check
  if (path === '/status') {
    sendJson(res, 200, {
      server: 'HOOK REGEDIT VERCEL API',
      status: 'online',
      time: now,
      kv_enabled: Boolean(KV_URL)
    });
    return;
  }

  // Admin: Get Keys List
  if (path === '/api/admin/keys') {
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
    sendJson(res, 200, { keys: list });
    return;
  }

  // Admin Dashboard
  if (path === '/' || path === '/admin') {
    sendHtml(res, getDashboardHtml());
    return;
  }

  // POST: Activate License
  if (path === '/license/activate' && req.method === 'POST') {
    const body = await parseBody(req);
    const key = (body.license_key || '').trim();
    const device_model = body.device_model || 'iPhone';

    if (!key) {
      sendJson(res, 400, { error: 'license_key is required' });
      return;
    }

    // Try KV or memory
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

    // First time activation -> 7 Days timer start!
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
          error: 'License Expired! Your 7 days validity has ended.',
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
      activated_at: lic.activated_at,
      expires_at: lic.expires_at,
      duration_days: lic.duration_days,
      days_left: daysLeft,
      token,
      refresh_token,
      message: `License Active! ${daysLeft} Days Remaining`
    });
    return;
  }

  // POST: Validate Session
  if (path === '/session/validate' && req.method === 'POST') {
    const body = await parseBody(req);
    const token = body.token || (req.headers['authorization'] || '').replace('Bearer ', '');
    const session = DB.sessions[token];

    if (!session) {
      sendJson(res, 401, { error: 'Invalid session token' });
      return;
    }

    if (now > session.expires_at) {
      sendJson(res, 403, { error: 'Session Expired! 7 Days completed.' });
      return;
    }

    sendJson(res, 200, {
      valid: true,
      license_key: session.key,
      expires_at: session.expires_at,
      days_left: Math.round(((session.expires_at - now) / 86400) * 10) / 10
    });
    return;
  }

  // Admin: Generate Keys
  if (path === '/api/admin/generate' && req.method === 'POST') {
    const body = await parseBody(req);
    const count = parseInt(body.count || 5);
    const generated = [];
    for (let i = 0; i < count; i++) {
      const p1 = crypto.randomBytes(2).toString('hex').toUpperCase();
      const p2 = crypto.randomBytes(2).toString('hex').toUpperCase();
      const p3 = crypto.randomBytes(2).toString('hex').toUpperCase();
      const k = `HOOK-${p1}-${p2}-${p3}`;
      DB.licenses[k] = {
        key: k,
        duration_days: 7,
        status: 'unused',
        activated_at: 0,
        expires_at: 0,
        device_model: '',
        created_at: now
      };
      if (KV_URL) await kvSet(`lic:${k}`, DB.licenses[k]);
      generated.push(k);
    }
    sendJson(res, 200, { success: true, generated });
    return;
  }

  // Admin: Revoke Key
  if (path === '/api/admin/revoke' && req.method === 'POST') {
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
  header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid var(--border); padding-bottom: 20px; margin-bottom: 30px; }
  .logo-title { display: flex; align-items: center; gap: 15px; }
  .logo-badge { background: linear-gradient(135deg, #ff2a2a, #aa0000); color: #fff; padding: 10px 18px; border-radius: 12px; font-weight: 900; font-size: 20px; box-shadow: 0 0 20px var(--primary-glow); }
  h1 { font-size: 26px; font-weight: 800; }
  .subtitle { color: var(--text-muted); font-size: 13px; margin-top: 3px; }
  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 30px; }
  .stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; text-align: center; }
  .stat-val { font-size: 32px; font-weight: 800; margin-top: 5px; color: var(--primary); }
  .actions-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 30px; display: flex; gap: 15px; align-items: center; flex-wrap: wrap; }
  button { background: var(--primary); color: white; border: none; padding: 12px 24px; border-radius: 8px; font-weight: 700; cursor: pointer; transition: 0.2s; box-shadow: 0 0 15px var(--primary-glow); }
  button:hover { background: #ff4747; transform: translateY(-2px); }
  table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 12px; overflow: hidden; border: 1px solid var(--border); }
  th, td { padding: 14px 18px; text-align: left; border-bottom: 1px solid var(--border); }
  th { background: #1a1f2c; color: var(--text-muted); font-size: 13px; text-transform: uppercase; }
  .key-code { font-family: monospace; font-size: 15px; font-weight: bold; color: #ff5e5e; background: #231518; padding: 5px 10px; border-radius: 6px; border: 1px solid rgba(255, 42, 42, 0.3); }
  .badge { display: inline-block; padding: 5px 12px; border-radius: 20px; font-size: 12px; font-weight: bold; text-transform: uppercase; }
  .badge-unused { background: #2c2514; color: var(--warning); border: 1px solid var(--warning); }
  .badge-active { background: #123324; color: var(--success); border: 1px solid var(--success); }
  .badge-expired { background: #351515; color: var(--primary); border: 1px solid var(--primary); }
  .badge-revoked { background: #222; color: #777; border: 1px solid #444; }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo-title">
      <div class="logo-badge">H</div>
      <div>
        <h1>HOOK REGEDIT // VERCEL CLOUD PORTAL</h1>
        <div class="subtitle">07-Day Dynamic VIP License & Device Authentication API</div>
      </div>
    </div>
    <div style="text-align: right;">
      <span style="display: inline-block; width: 10px; height: 10px; background: #00ff88; border-radius: 50%; box-shadow: 0 0 10px #00ff88;"></span>
      <span style="font-size: 13px; color: #00ff88; font-weight: bold; margin-left: 5px;">VERCEL SERVERLESS ONLINE</span>
    </div>
  </header>

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

  <div class="actions-card">
    <button onclick="generateKeys(5)">⚡ Generate 5 More Keys (7 Days)</button>
    <button onclick="generateKeys(10)">⚡ Generate 10 More Keys</button>
    <button style="background: #2a3142; box-shadow: none;" onclick="loadKeys()">🔄 Refresh Table</button>
  </div>

  <table>
    <thead>
      <tr>
        <th>License Key (Prefix: HOOK-)</th>
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
async function loadKeys() {
  try {
    const res = await fetch('/api/admin/keys');
    const data = await res.json();
    const tbody = document.getElementById('keysTable');
    tbody.innerHTML = '';
    
    let total = data.keys.length;
    let unused = 0, active = 0, expired = 0;

    data.keys.forEach(k => {
      if(k.status === 'unused') unused++;
      else if(k.status === 'active') active++;
      else expired++;

      let badgeClass = 'badge-' + k.status;
      let remainingText = k.status === 'unused' ? '7 Days (Not started)' : (k.status === 'active' ? k.days_left + ' Days Left' : '0 Days (Ended)');
      
      const tr = document.createElement('tr');
      tr.innerHTML = \`
        <td><span class="key-code">\${k.key}</span></td>
        <td>\${k.duration_days} Days</td>
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

async function generateKeys(count) {
  await fetch('/api/admin/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: count })
  });
  loadKeys();
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
