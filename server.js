require('dotenv').config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const cors = require('cors');
const axios = require('axios');
const { wrapper: wrapAxios } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const { GoogleAuth } = require('google-auth-library');
const fs = require('fs');
const { spawn } = require('child_process');
const multer = require('multer');
const os = require('os');
const crypto = require('crypto');

// --- Transcode Job Management ---
// Simple in-memory job registry (ephemeral; lost on restart)
const transcodeJobs = new Map();
function createJob(meta) {
  const id = crypto.randomBytes(8).toString('hex');
  const job = {
    id,
    status: 'queued', // queued | processing | done | error
    created: Date.now(),
    updated: Date.now(),
    input: meta,
    outputUrl: null,
    progress: 0,
    fps: null,
    speed: null,
    eta: null,
    logTail: [],
    error: null,
    tookMs: null
  };
  transcodeJobs.set(id, job);
  return job;
}
function updateJob(id, patch) {
  const job = transcodeJobs.get(id); if (!job) return;
  Object.assign(job, patch, { updated: Date.now() });
}
// Periodic cleanup (jobs older than 6h)
setInterval(()=>{
  const cutoff = Date.now() - 6*60*60*1000;
  for (const [id, j] of transcodeJobs) if (j.created < cutoff) transcodeJobs.delete(id);
}, 60*60*1000);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// Serve static files from public directory
app.use(cors()); // enable CORS globally
app.use(express.static(path.join(__dirname, "public")));
// Directory for transcoded files
const TRANSCODE_DIR = path.join(__dirname, 'transcodes');
if (!fs.existsSync(TRANSCODE_DIR)) fs.mkdirSync(TRANSCODE_DIR);
app.use('/transcodes', express.static(TRANSCODE_DIR, { maxAge: '1h' }));

// Multer setup for uploads (memory or temp disk)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, os.tmpdir()),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.dat';
    cb(null, 'upload_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex') + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 * 1024 } }); // 5GB limit

// Basic middleware
app.use(express.json());

// Enhanced CORS middleware for video streaming
app.use((req, res, next) => {
  // Set CORS headers for all requests
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization, X-Requested-With');
  res.header('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
  
  // Handle OPTIONS preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Room state management
let movieRoom = {
  users: new Map(),
  currentTime: 0,
  isPlaying: false,
  lastUpdate: Date.now(),
  movieUrl: process.env.MOVIE_URL || ""
};

// --- Google Drive Proxy with Cookie Jar + Confirm Flow ---
const driveClient = wrapAxios(axios.create({
  maxRedirects: 5,
  validateStatus: s => s >= 200 && s < 400
}));

function buildJar() { return new CookieJar(); }

function extractConfirmTokens(html) {
  const tokens = new Set();
  if (!html) return [];
  // Normalize quotes just for simpler pattern checks (don't mutate original for logs)
  const src = html;
  // Patterns observed in Drive interstitials:
  // 1. href="/uc?export=download&confirm=XXXX&id=..."
  // 2. action="/uc?export=download&confirm=XXXX&id=..."
  // 3. name="confirm" value="XXXX"
  // 4. confirm=XXXX (end of URL) without trailing &
  const regexes = [
    /confirm=([a-zA-Z0-9-_]{3,})&/g,
    /confirm=([a-zA-Z0-9-_]{3,})(?=["'&])/g,
    /name=\"confirm\"\s+value=\"([a-zA-Z0-9-_]{3,})\"/g,
    /name='confirm'\s+value='([a-zA-Z0-9-_]{3,})'/g
  ];
  for (const rx of regexes) {
    let m; while ((m = rx.exec(src)) !== null) {
      tokens.add(m[1]);
    }
  }
  // Occasionally very short (1 char) matches are false positives; filtered by {3,}
  return [...tokens];
}

async function initialHtmlFetch(url, jar, headers) {
  const r = await driveClient.get(url, { headers, jar, withCredentials: true, responseType: 'text' });
  return { status: r.status, headers: r.headers, html: r.data };
}

async function attemptVideoStream(url, jar, headers, range) {
  const h = { ...headers };
  if (range) h.Range = range;
  const r = await driveClient.get(url, { headers: h, jar, withCredentials: true, responseType: 'stream', validateStatus: s => [200,206].includes(s) });
  return r;
}

function classifyHtml(html) {
  if (!html) return 'empty';
  const lower = html.toLowerCase();
  if (lower.includes('quota exceeded')) return 'quota_exceeded';
  if (lower.includes('access denied') || lower.includes('you need access')) return 'access_denied';
  if (lower.includes('virus scan warning')) return 'virus_scan_interstitial';
  if (lower.includes('download anyway')) return 'needs_confirm';
  return 'generic_html';
}

// --- Google Drive API (Service Account) helper ---
// Expects a JSON key file path via env GOOGLE_APPLICATION_CREDENTIALS or inline credentials in env DRIVE_SA_JSON
let driveAuthClient = null;
async function ensureServiceAccountMaterialized() {
  // Precedence: explicit file path > inline JSON env var name variants
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) return;
  const inlineJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.DRIVE_SA_JSON;
  if (inlineJson) {
    try {
      const parsed = JSON.parse(inlineJson);
      if (!parsed.private_key || !parsed.client_email) throw new Error('incomplete_service_account_json');
      const keyPath = path.join(os.tmpdir(), 'drive_sa_key.json');
      fs.writeFileSync(keyPath, JSON.stringify(parsed), { encoding: 'utf8', mode: 0o600 });
      process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
    } catch (e) {
      console.error('Invalid inline service account JSON:', e.message);
    }
  }
}
async function getDriveAuthClient(scopes = ['https://www.googleapis.com/auth/drive.readonly']) {
  if (driveAuthClient) return driveAuthClient;
  await ensureServiceAccountMaterialized();
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) throw new Error('no_service_account_credentials');
  const auth = new GoogleAuth({ scopes });
  driveAuthClient = await auth.getClient();
  return driveAuthClient;
}

async function streamViaDriveApi(fileId, rangeHeader, res) {
  try {
    console.log(`🔄 Drive API: Starting stream for fileId=${fileId}, range=${rangeHeader || 'none'}`);
    const client = await getDriveAuthClient();
    const base = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const headers = {};
    if (rangeHeader) headers.Range = rangeHeader;
  // Robust: use getRequestHeaders (official) to avoid token shape ambiguity
  const reqHdrs = await client.getRequestHeaders();
  const authH = reqHdrs.Authorization || reqHdrs.authorization;
  if (!authH || !authH.startsWith('Bearer ')) throw new Error('missing_bearer_header');
  const token = authH.substring(7);
    console.log(`🔄 Drive API: Making request to ${base}`);
    console.log(`🔄 Drive API: Token length=${token.length}, Range=${rangeHeader || 'none'}`);
    
    const apiResp = await axios.get(base, {
      headers: { ...headers, Authorization: `Bearer ${token}` },
      responseType: 'stream',
      validateStatus: s => [200,206].includes(s),
      timeout: 60000, // Increased to 60 seconds for large files
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
    
    console.log(`✅ Drive API: Response status=${apiResp.status}, content-type=${apiResp.headers['content-type']}`);
    console.log(`✅ Drive API: Content-length=${apiResp.headers['content-length']}, Content-range=${apiResp.headers['content-range'] || 'none'}`);
    
    // Content type may not always be present; attempt fallback
    const ctype = apiResp.headers['content-type'] || 'video/mp4';
    if (apiResp.headers['content-range']) res.status(206).set('Content-Range', apiResp.headers['content-range']);
    if (apiResp.headers['content-length']) res.set('Content-Length', apiResp.headers['content-length']);
    
    // Set comprehensive headers for video streaming
    res.set({ 
      'Content-Type': ctype, 
      'Accept-Ranges': 'bytes', 
      'X-Proxy-Source': 'drive_api',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Content-Type, Authorization',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
      'Cache-Control': 'public, max-age=3600'
    });
    
    let bytesStreamed = 0;
    apiResp.data.on('data', (chunk) => {
      bytesStreamed += chunk.length;
    });
    
    apiResp.data.on('end', () => {
      console.log(`✅ Drive API: Stream completed, ${bytesStreamed} bytes streamed`);
    });
    
    apiResp.data.on('error', err => {
      console.error('❌ Drive API stream error:', err.message);
      if (!res.headersSent) res.status(500).end();
    });
    apiResp.data.pipe(res);
    return true;
  } catch (e) {
    const status = e.response?.status;
    const bodySnippet = e.response?.data ? (typeof e.response.data === 'string' ? e.response.data.slice(0,200) : JSON.stringify(e.response.data).slice(0,200)) : null;
    console.error('❌ Drive API fallback failed:', e.message, 'status=', status, 'snippet=', bodySnippet);
    console.error('❌ Drive API error details:', {
      code: e.code,
      message: e.message,
      response: e.response ? {
        status: e.response.status,
        statusText: e.response.statusText,
        headers: e.response.headers
      } : 'no response'
    });
    if (!res.headersSent) {
      res.set('X-Drive-Error', String(status||'unknown'));
    }
    return false;
  }
}

app.get('/proxy/:fileId', async (req, res) => {
  const { fileId } = req.params;
  let range = req.headers.range;
  
  // Optimize range requests for better streaming on Render
  if (range && range.includes('-')) {
    const match = range.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1]);
      const end = match[2] ? parseInt(match[2]) : undefined;
      
      // If no end specified or range is too large, limit initial chunk size
      if (!end || (end - start) > 10 * 1024 * 1024) { // 10MB limit
        const limitedEnd = start + (5 * 1024 * 1024) - 1; // 5MB chunks
        range = `bytes=${start}-${limitedEnd}`;
        console.log(`🔧 Range limited from ${req.headers.range} to ${range}`);
      }
    }
  }
  
  console.log(`🔄 Proxy request fileId=${fileId} range=${range || 'none'}`);
  const primaryMode = (process.env.DRIVE_PRIMARY_MODE || 'api').toLowerCase(); // 'api' | 'html'

  // Set basic CORS headers early
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type, Authorization',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges'
  });

  // Helper to run HTML confirm flow
  const runHtmlFlow = async () => {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    const ACCEPT = 'video/*;q=0.9,*/*;q=0.8';
    const baseHeaders = { 'User-Agent': UA, 'Accept': ACCEPT }; 
    const jar = buildJar();
    const candidates = [
      { url: `https://drive.usercontent.google.com/download?id=${fileId}&export=download`, tag: 'usercontent' },
      { url: `https://drive.google.com/uc?export=download&id=${fileId}`, tag: 'uc' }
    ];
    let lastIssue = null;
    for (const cand of candidates) {
      try {
        const htmlResp = await initialHtmlFetch(cand.url, jar, baseHeaders);
        const ctype = (htmlResp.headers['content-type']||'').toLowerCase();
        const isHtml = ctype.includes('text/html');
        let streamUrl = cand.url;
        let confirmTokens = [];
        if (isHtml) {
          confirmTokens = extractConfirmTokens(htmlResp.html);
          if (confirmTokens.length === 0) {
            const htmlClass = classifyHtml(htmlResp.html);
            lastIssue = htmlClass;
            console.warn(`⚠️ HTML interstitial (${htmlClass}) without token for ${cand.tag}`);
            continue;
          }
          let success = false; let lastTokenErr = null;
          for (const token of confirmTokens) {
            const confirmUrl = `https://drive.google.com/uc?export=download&confirm=${token}&id=${fileId}`;
            try {
              const probe = await driveClient.get(confirmUrl, { headers: baseHeaders, jar, withCredentials: true, responseType: 'stream', validateStatus: s => [200,206].includes(s) });
              const sc = (probe.headers['content-type']||'').toLowerCase();
              if (sc.startsWith('text/html')) {
                lastTokenErr = 'html_after_confirm';
                probe.data.destroy();
                continue;
              }
              probe.data.destroy();
              streamUrl = confirmUrl;
              success = true;
              console.log(`🔐 Confirm token accepted (${token}) source=${cand.tag}`);
              break;
            } catch(e) { lastTokenErr = e.message; continue; }
          }
          if (!success) { lastIssue = lastTokenErr || 'confirm_failed'; continue; }
        }
        const streamResp = await attemptVideoStream(streamUrl, jar, baseHeaders, range);
        const streamType = (streamResp.headers['content-type']||'').toLowerCase();
        if (streamType.startsWith('text/html')) { lastIssue = 'html_stream'; streamResp.data.destroy(); continue; }
        if (streamResp.headers['content-range']) res.status(206).set('Content-Range', streamResp.headers['content-range']);
        res.set('Content-Type', streamResp.headers['content-type'] || 'video/mp4');
        if (streamResp.headers['content-length']) res.set('Content-Length', streamResp.headers['content-length']);
        res.set({ 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range', 'X-Proxy-Source': cand.tag, 'X-Proxy-Confirmed': String(isHtml), 'X-Proxy-Tokens': confirmTokens.join(',') });
        console.log(`✅ Proxy stream start (HTML flow) source=${cand.tag} range=${!!range} type=${streamResp.headers['content-type']}`);
        streamResp.data.on('error', err => { console.error('❌ Stream error', err.message); if (!res.headersSent) res.status(500).end(); });
        streamResp.data.pipe(res);
        return true;
      } catch (e) { lastIssue = e.message; console.warn(`⚠️ HTML flow candidate failure source=${cand.tag} err=${e.message}`); continue; }
    }
    return { ok: false, issue: lastIssue };
  };

  const apiFirst = primaryMode === 'api';
  if (apiFirst) {
    // Attempt Drive API immediately; fallback to HTML confirm flow on failure
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.DRIVE_SA_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      const ok = await streamViaDriveApi(fileId, range, res);
      if (ok) return;
      console.log('🔁 API failed -> attempting HTML confirm flow');
      const htmlResult = await runHtmlFlow();
      if (htmlResult === true) return; // already streamed
      if (!res.headersSent) return res.status(502).json({ error: 'proxy_failed', fileId, issue: htmlResult.issue || 'api_and_html_failed', mode:'api_primary' });
      return; // stream already attempted
    } else {
      console.log('ℹ️ No service account creds present, falling back to HTML confirm flow');
      const htmlResult = await runHtmlFlow();
      if (htmlResult === true) return;
      if (!res.headersSent) return res.status(502).json({ error: 'proxy_failed', fileId, issue: htmlResult.issue || 'html_failed', mode:'api_primary_no_creds' });
      return;
    }
  } else {
    // HTML first mode (legacy) then API fallback
    const htmlResult = await runHtmlFlow();
    if (htmlResult === true) return; // success
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.DRIVE_SA_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      console.log('🔁 HTML flow failed -> trying API fallback');
      const ok = await streamViaDriveApi(fileId, range, res);
      if (ok) return;
      if (!res.headersSent) return res.status(502).json({ error: 'proxy_failed', fileId, issue: htmlResult.issue || 'html_and_api_failed', mode:'html_primary' });
    } else {
      if (!res.headersSent) return res.status(502).json({ error: 'proxy_failed', fileId, issue: htmlResult.issue || 'html_failed_no_api_creds', mode:'html_primary' });
    }
  }
});

// Direct Drive API route (requires service account credentials)
app.get('/proxy-api/:fileId', async (req, res) => {
  const { fileId } = req.params;
  const range = req.headers.range;
  try { await ensureServiceAccountMaterialized(); } catch(e) {}
  if (!(process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.DRIVE_SA_JSON)) {
    console.error('❌ No Google credentials available for streaming');
    return res.status(400).json({ error: 'no_credentials', detail: 'Provide GOOGLE_SERVICE_ACCOUNT_JSON inline or GOOGLE_APPLICATION_CREDENTIALS path' });
  }
  
  console.log(`🚀 Attempting Drive API streaming for ${fileId}`);
  const ok = await streamViaDriveApi(fileId, range, res);
  
  if (!ok && !res.headersSent) {
    console.error(`❌ Drive API streaming failed for ${fileId}, falling back to HTML flow`);
    try {
      const htmlResult = await runHtmlFlow();
      if (!htmlResult) {
        console.error('❌ HTML fallback also failed');
        res.status(502).json({ 
          error: 'all_methods_failed', 
          detail: 'Both Drive API and HTML confirm flow failed',
          fileId: fileId
        });
      }
    } catch (error) {
      console.error('❌ HTML fallback error:', error.message);
      res.status(502).json({ 
        error: 'fallback_failed', 
        detail: error.message,
        fileId: fileId
      });
    }
  }
});

// Drive file metadata (checks permission) without downloading
app.get('/drive-file-meta/:fileId', async (req, res) => {
  const { fileId } = req.params;
  try {
    const client = await getDriveAuthClient(['https://www.googleapis.com/auth/drive.readonly']);
    const token = await client.getAccessToken();
    const metaResp = await axios.get(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,size,owners,permissions`, {
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: s => s >=200 && s < 500
    });
    res.status(metaResp.status).json({ status: metaResp.status, data: metaResp.data });
  } catch (e) {
    res.status(500).json({ error: 'meta_failed', detail: e.message });
  }
});

// Attempt credential test at startup (async, non-blocking)
(async () => {
  try {
    await ensureServiceAccountMaterialized();
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      const c = await getDriveAuthClient();
      const token = await c.getAccessToken();
      console.log('🔐 Drive auth token acquired (length:', String(token).length, ')');
    } else {
      console.log('ℹ️ No service account credentials present at startup');
    }
  } catch (e) {
    console.warn('⚠️ Startup Drive auth check failed:', e.message);
  }
})();

// Credential presence status (no secrets returned)
app.get('/auth-status', async (req, res) => {
  const inline = !!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.DRIVE_SA_JSON);
  const filePath = process.env.GOOGLE_APPLICATION_CREDENTIALS || null;
  let fileExists = false;
  if (filePath) { try { fileExists = fs.existsSync(filePath); } catch(e) {} }
  
  // Additional debugging for Render deployment
  const envVarExists = !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const envVarLength = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? process.env.GOOGLE_SERVICE_ACCOUNT_JSON.length : 0;
  let envVarValid = false;
  
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      const parsed = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      envVarValid = !!(parsed.private_key && parsed.client_email);
    } catch (e) {
      envVarValid = false;
    }
  }
  
  res.json({
    inlineProvided: inline,
    credentialFilePathSet: !!filePath,
    credentialFileExists: fileExists,
    readyForDriveApi: inline || (filePath && fileExists),
    // Render debugging
    renderDeployment: {
      envVarExists,
      envVarLength,
      envVarValid,
      hasPrivateKey: envVarExists && process.env.GOOGLE_SERVICE_ACCOUNT_JSON.includes('private_key'),
      hasClientEmail: envVarExists && process.env.GOOGLE_SERVICE_ACCOUNT_JSON.includes('client_email')
    }
  });
});

// Debug token acquisition and scopes
app.get('/auth-debug', async (req, res) => {
  try {
    const client = await getDriveAuthClient(['https://www.googleapis.com/auth/drive.readonly']);
    const hdrs = await client.getRequestHeaders();
    const authH = hdrs.Authorization || hdrs.authorization;
    const token = authH && authH.startsWith('Bearer ') ? authH.substring(7) : null;
    res.json({ ok: true, tokenSample: token ? token.slice(0,25)+'...' : null, tokenLength: token ? token.length : 0, headerPresent: !!authH });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Test endpoint for Render deployment debugging
app.get('/render-test', (req, res) => {
  const hasJsonEnv = !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const hasUser1 = !!process.env.LOGIN_USER1;
  const hasPass1 = !!process.env.LOGIN_PASS1;
  
  res.json({
    status: 'render_test',
    environment: {
      googleServiceAccount: hasJsonEnv ? 'present' : 'missing',
      loginUser1: hasUser1 ? process.env.LOGIN_USER1 : 'missing',
      loginPass1: hasPass1 ? 'present' : 'missing',
      port: process.env.PORT || 'not_set'
    },
    timestamp: new Date().toISOString()
  });
});

// Test specific Google Drive file access
app.get('/drive-test/:fileId', async (req, res) => {
  const { fileId } = req.params;
  
  try {
    console.log(`🧪 Testing Drive file access for: ${fileId}`);
    const client = await getDriveAuthClient();
    
    // Test file metadata access
    const metaUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,size,mimeType,permissions`;
    const reqHdrs = await client.getRequestHeaders();
    const authH = reqHdrs.Authorization || reqHdrs.authorization;
    
    const metaResp = await axios.get(metaUrl, {
      headers: { Authorization: authH },
      timeout: 10000
    });
    
    console.log(`✅ File metadata retrieved:`, metaResp.data);
    
    // Test media download (first 1024 bytes)
    const mediaUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const testResp = await axios.get(mediaUrl, {
      headers: { 
        Authorization: authH,
        Range: 'bytes=0-1023'
      },
      responseType: 'arraybuffer',
      timeout: 10000
    });
    
    console.log(`✅ Media access test: status=${testResp.status}, bytes=${testResp.data.byteLength}`);
    
    res.json({
      success: true,
      fileId,
      metadata: metaResp.data,
      mediaTest: {
        status: testResp.status,
        contentType: testResp.headers['content-type'],
        contentLength: testResp.headers['content-length'],
        contentRange: testResp.headers['content-range'],
        bytesReceived: testResp.data.byteLength
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error(`❌ Drive test failed for ${fileId}:`, error.message);
    res.status(500).json({
      success: false,
      fileId,
      error: {
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data
      },
      timestamp: new Date().toISOString()
    });
  }
});

// Simple stream test endpoint
app.get('/stream-test/:fileId', async (req, res) => {
  const { fileId } = req.params;
  const range = req.headers.range || 'bytes=0-1048575'; // 1MB test
  
  console.log(`🧪 Stream test for ${fileId}, range: ${range}`);
  
  try {
    const success = await streamViaDriveApi(fileId, range, res);
    if (!success && !res.headersSent) {
      res.status(500).json({ 
        error: 'stream_test_failed', 
        fileId,
        range,
        message: 'Stream test did not complete successfully'
      });
    }
  } catch (error) {
    console.error(`❌ Stream test failed:`, error);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'stream_test_exception', 
        fileId,
        range,
        message: error.message
      });
    }
  }
});

// Permissions listing route
app.get('/drive-file-perms/:fileId', async (req, res) => {
  const { fileId } = req.params;
  try {
    const client = await getDriveAuthClient([
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.metadata.readonly'
    ]);
    const hdrs = await client.getRequestHeaders();
    const authH = hdrs.Authorization || hdrs.authorization;
    if (!authH) return res.status(500).json({ error: 'no_auth_header' });
    const token = authH.replace(/^Bearer\s+/i,'');
    const permResp = await axios.get(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=permissions(id,emailAddress,role,type,displayName)`, {
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: s => s < 500
    });
    res.status(permResp.status).json({ 
      status: permResp.status,
      permissions: permResp.data.permissions || [],
      file: {
        id: permResp.data.id,
        name: permResp.data.name,
        shared: permResp.data.shared,
        owners: permResp.data.owners,
        permissionIds: permResp.data.permissionIds
      }
    });
  } catch (e) {
    res.status(500).json({ error: 'perm_list_failed', detail: e.message });
  }
});

// Lightweight probe: returns headers + first bytes classification without streaming whole video
app.get('/proxy-head/:fileId', async (req, res) => {
  const { fileId } = req.params;
  const primaryMode = (process.env.DRIVE_PRIMARY_MODE || 'api').toLowerCase();
  // If API primary and creds exist, do a lightweight API range probe first
  if (primaryMode === 'api' && (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.DRIVE_SA_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON)) {
    try {
      const client = await getDriveAuthClient();
      const reqHdrs = await client.getRequestHeaders();
      const authH = reqHdrs.Authorization || reqHdrs.authorization;
      const token = authH && authH.startsWith('Bearer ') ? authH.substring(7) : null;
      if (!token) throw new Error('no_token');
      const probe = await axios.get(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
        headers: { Authorization: `Bearer ${token}`, Range: 'bytes=0-2047' },
        responseType: 'arraybuffer',
        validateStatus: s => [200,206].includes(s)
      });
      const buf = Buffer.from(probe.data);
      const ascii = buf.toString('utf8');
      const looksHtml = ascii.toLowerCase().includes('<html');
      let containerGuess = 'unknown';
      if (ascii.includes('ftyp')) containerGuess = 'mp4_like';
      if (!looksHtml) {
        return res.json({ fileId, ok: true, best: { source: 'drive_api', status: probe.status, contentType: probe.headers['content-type'], bytesReturned: buf.length, containerGuess }, attempts: [] });
      }
      // If HTML (shouldn't happen for API) fall through to legacy flow
      console.warn('proxy-head api primary returned html-looking content, falling back to html confirm flow');
    } catch (e) {
      console.warn('proxy-head api probe failed:', e.message, 'falling back to html confirm flow');
    }
  }
  const jar = buildJar();
  const rangeHeader = 'bytes=0-2047';
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  const baseHeaders = { 'User-Agent': UA, 'Accept': 'video/*;q=0.9,*/*;q=0.6', 'Range': rangeHeader };
  const candidates = [
    { url: `https://drive.usercontent.google.com/download?id=${fileId}&export=download`, tag: 'usercontent' },
    { url: `https://drive.google.com/uc?export=download&id=${fileId}`, tag: 'uc' }
  ];
  const attempts = [];
  for (const cand of candidates) {
    try {
      // HTML first
      const htmlResp = await initialHtmlFetch(cand.url, jar, baseHeaders);
      const ctype = (htmlResp.headers['content-type']||'').toLowerCase();
      const isHtml = ctype.includes('text/html');
      let tokens = [];
      let finalUrl = cand.url;
      if (isHtml) {
        tokens = extractConfirmTokens(htmlResp.html);
        if (tokens.length) {
          finalUrl = `https://drive.google.com/uc?export=download&confirm=${tokens[0]}&id=${fileId}`;
        }
      }
      // Byte probe
      const probe = await driveClient.get(finalUrl, { headers: baseHeaders, jar, withCredentials: true, responseType: 'arraybuffer', validateStatus: s => [200,206].includes(s) });
      const buf = Buffer.from(probe.data);
      const ascii = buf.toString('utf8');
      const looksHtml = ascii.toLowerCase().includes('<html');
      let containerGuess = 'unknown';
      if (ascii.includes('ftyp')) containerGuess = 'mp4_like';
      attempts.push({
        source: cand.tag,
        status: probe.status,
        initialHtml: isHtml,
        confirmTried: tokens[0] || null,
        contentType: probe.headers['content-type'],
        bytesReturned: buf.length,
        looksHtml,
        containerGuess,
        hexPreview: buf.slice(0,32).toString('hex')
      });
      if (!looksHtml && containerGuess === 'mp4_like') {
        return res.json({ fileId, ok: true, best: attempts[attempts.length-1], attempts });
      }
    } catch (e) {
      attempts.push({ source: cand.tag, error: e.message });
    }
  }
  res.json({ fileId, ok: false, attempts });
});

// Proxy health check
app.get('/proxy-test/:fileId', (req, res) => {
  const fileId = req.params.fileId;
  res.json({
    status: 'Range-enabled proxy ready',
    fileId: fileId,
    proxyUrl: `/proxy/${fileId}`,
    timestamp: new Date().toISOString(),
    features: ['range-requests', 'video-seeking', 'large-file-streaming', 'progress-tracking'],
    testUrls: [
      `https://drive.google.com/uc?export=download&id=${fileId}`,
      `https://drive.usercontent.google.com/download?id=${fileId}&export=download`
    ]
  });
});

// Helper: spawn ffmpeg with progress parsing
function runFfmpegWithProgress(args, jobId, inputPath, outputPath) {
  console.log('🎞  Transcode start:', args.join(' '));
  updateJob(jobId, { status: 'processing' });
  const started = Date.now();
  const proc = spawn('ffmpeg', args);
  proc.stderr.on('data', chunk => {
    const text = chunk.toString();
    const job = transcodeJobs.get(jobId); if (!job) return;
    // Keep tail (last ~25 lines max 4k chars)
    text.split(/\r?\n/).filter(l=>l.trim()).forEach(l=>{
      job.logTail.push(l); if (job.logTail.length>25) job.logTail.shift();
      // Parse time=, fps=, speed=
      if (l.includes('time=')) {
        const tMatch = l.match(/time=([0-9:.]+)/);
        if (tMatch) {
          // Convert HH:MM:SS.xx -> seconds
            const parts = tMatch[1].split(':');
            let seconds = 0; if (parts.length===3) seconds = (+parts[0])*3600 + (+parts[1])*60 + parseFloat(parts[2]);
            job.progress = seconds; // raw seconds; client can compare
        }
        const fpsM = l.match(/fps=\s*([0-9.]+)/); if (fpsM) job.fps = parseFloat(fpsM[1]);
        const spdM = l.match(/speed=\s*([0-9.]+)x/); if (spdM) job.speed = parseFloat(spdM[1]);
      }
    });
    job.updated = Date.now();
  });
  proc.on('error', err => {
    console.error('❌ ffmpeg spawn error:', err.message);
    updateJob(jobId, { status: 'error', error: 'ffmpeg_spawn', detail: err.message });
  });
  proc.on('close', code => {
    const ms = Date.now() - transcodeJobs.get(jobId).created;
    if (code === 0) {
      // Validate output
      fs.stat(outputPath, (err, st) => {
        if (err || !st || st.size < 1000) {
          console.error('⚠️ Output validation failed (size too small)');
          updateJob(jobId, { status: 'error', error: 'invalid_output', tookMs: ms });
        } else {
          updateJob(jobId, { status: 'done', tookMs: ms, outputUrl: `/transcodes/${path.basename(outputPath)}` });
          console.log(`✅ Transcode success in ${ms}ms -> ${transcodeJobs.get(jobId).outputUrl}`);
        }
        fs.unlink(inputPath, ()=>{});
      });
    } else {
      console.error('❌ Transcode failed code=' + code);
      updateJob(jobId, { status: 'error', error: 'exit_code_'+code });
      fs.unlink(inputPath, ()=>{});
      // Remove partial output
      fs.unlink(outputPath, ()=>{});
    }
  });
}

// Transcode upload endpoint (auto converts every upload to standardized H.264/AAC)
// Query param async=1 for immediate job response (poll /transcode/jobs/:id)
app.post('/transcode/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const inputPath = req.file.path;
  const base = path.basename(inputPath).replace(/\.[^.]+$/, '');
  const outFile = base + '_h264.mp4';
  const outputPath = path.join(TRANSCODE_DIR, outFile);

  const preset = process.env.TX_PRESET || 'fast';
  const crf = process.env.TX_CRF || '20';
  const aBitrate = process.env.TX_ABR || '160k';
  const gop = process.env.TX_GOP || '96';
  const args = [
    '-y','-hide_banner','-i', inputPath,
    '-c:v','libx264','-preset',preset,'-crf',crf,'-profile:v','high','-level','4.1','-pix_fmt','yuv420p',
    '-c:a','aac','-b:a',aBitrate,
    '-movflags','+faststart',
    '-g', gop, '-keyint_min', gop,
    outputPath
  ];

  const job = createJob({ originalName: req.file.originalname, size: req.file.size });
  runFfmpegWithProgress(args, job.id, inputPath, outputPath);

  if (req.query.async === '1') {
    return res.json({ jobId: job.id, status: 'queued' });
  }
  // Synchronous wait (stream job polling) - simple loop using interval until done or error
  const startWait = Date.now();
  const interval = setInterval(()=>{
    const j = transcodeJobs.get(job.id);
    if (!j) { clearInterval(interval); return res.status(500).json({ error:'job_missing'}); }
    if (j.status === 'done') { clearInterval(interval); return res.json({ status:'ok', url: j.outputUrl, tookMs: j.tookMs }); }
    if (j.status === 'error') { clearInterval(interval); return res.status(500).json({ error: j.error, logTail: j.logTail.slice(-10) }); }
    if (Date.now() - startWait > 15*60*1000) { clearInterval(interval); return res.status(504).json({ error:'timeout'}); }
  }, 800);
});

// Job status endpoint
app.get('/transcode/jobs/:id', (req,res)=>{
  const j = transcodeJobs.get(req.params.id);
  if (!j) return res.status(404).json({ error:'not_found' });
  res.json({ id:j.id,status:j.status,progressSeconds:j.progress,fps:j.fps,speed:j.speed,eta:j.eta,outputUrl:j.outputUrl,updated:j.updated,logTail:j.logTail.slice(-8),tookMs:j.tookMs});
});

// --- Transcode Inspection (ffprobe) ---
function safeOutputName(name) {
  // prevent path traversal; only allow simple filenames that exist in transcodes
  if (!name || name.includes('/') || name.includes('..')) return null;
  return name;
}

function runFfprobeJson(targetPath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(targetPath)) return reject(new Error('missing_file'));
    const args = ['-v','quiet','-print_format','json','-show_format','-show_streams', targetPath];
    const proc = spawn('ffprobe', args);
    let out=''; let err='';
    const timer = setTimeout(()=>{ proc.kill('SIGKILL'); reject(new Error('ffprobe_timeout')); }, 10000);
    proc.stdout.on('data', d=> out += d.toString());
    proc.stderr.on('data', d=> err += d.toString());
    proc.on('error', e=> { clearTimeout(timer); reject(e); });
    proc.on('close', code=> {
      clearTimeout(timer);
      if (code===0) {
        try { return resolve(JSON.parse(out)); } catch(parseErr){ return reject(new Error('parse_error')); }
      }
      reject(new Error('ffprobe_exit_'+code+ (err? ':'+err.trim():'')));
    });
  });
}

// Inspect by filename already in /transcodes
app.get('/transcode/inspect/:file', async (req,res)=>{
  const fname = safeOutputName(req.params.file);
  if (!fname) return res.status(400).json({ error:'bad_filename'});
  const full = path.join(TRANSCODE_DIR, fname);
  try {
    const meta = await runFfprobeJson(full);
    res.json({ file: fname, meta });
  } catch (e) {
    if (e.message === 'missing_file') return res.status(404).json({ error:'not_found'});
    res.status(500).json({ error:'probe_failed', detail: e.message });
  }
});

// Inspect by job id (if job done)
app.get('/transcode/jobs/:id/inspect', async (req,res)=>{
  const j = transcodeJobs.get(req.params.id);
  if (!j) return res.status(404).json({ error:'not_found'});
  if (j.status !== 'done' || !j.outputUrl) return res.status(400).json({ error:'not_ready', status:j.status });
  const fname = path.basename(j.outputUrl);
  const full = path.join(TRANSCODE_DIR, fname);
  try {
    const meta = await runFfprobeJson(full);
    res.json({ id:j.id, file: fname, meta });
  } catch (e) {
    res.status(500).json({ error:'probe_failed', detail:e.message });
  }
});

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    users: movieRoom.users.size,
    uptime: Math.floor(process.uptime()),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
    features: ['range-requests', 'video-seeking', 'large-file-proxy', 'websockets', 'chat', 'progress-tracking']
  });
});

app.get('/api/room-info', (req, res) => {
  res.json({
    userCount: movieRoom.users.size,
    currentTime: movieRoom.currentTime,
    isPlaying: movieRoom.isPlaying,
    lastUpdate: movieRoom.lastUpdate
  });
});

// Login endpoint
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  // Get credentials from environment variables
  const validCredentials = {
    [process.env.LOGIN_USER1 || 'samyuctaa']: process.env.LOGIN_PASS1 || 'yukshar',
    [process.env.LOGIN_USER2 || 'sharada']: process.env.LOGIN_PASS2 || 'yukshar'
  };
  
  console.log(`🔐 Login attempt for user: ${username}`);
  
  if (validCredentials[username] && validCredentials[username] === password) {
    console.log(`✅ Login successful for: ${username}`);
    res.json({ 
      success: true, 
      message: 'Login successful',
      user: username 
    });
  } else {
    console.log(`❌ Login failed for: ${username}`);
    res.status(401).json({ 
      success: false, 
      message: 'Invalid credentials' 
    });
  }
});

// Socket.IO connection handling
io.on("connection", (socket) => {
  const userId = socket.id;
  const userInfo = {
    id: userId,
    connected: Date.now(),
    lastSeen: Date.now(),
    ip: socket.handshake.address
  };
  
  movieRoom.users.set(userId, userInfo);
  
  console.log(`✅ User connected: ${userId.substring(0, 6)} from ${userInfo.ip} (Total: ${movieRoom.users.size})`);
  
  // Send initial room state to new user
  socket.emit('roomState', {
    userCount: movieRoom.users.size,
    currentTime: movieRoom.currentTime,
    isPlaying: movieRoom.isPlaying,
    movieUrl: movieRoom.movieUrl
  });
  
  // Broadcast user count update to everyone
  io.emit('userCount', movieRoom.users.size);
  
  socket.on("control", (data) => {
    try {
      const { type, time, timestamp } = data;
      
      console.log(`🎮 Control ${type.toUpperCase()}: ${time}s from ${userId.substring(0, 6)} at ${new Date().toLocaleTimeString()}`);
      
      // Handle buffering events
      if (type === 'buffering') {
        console.log(`🔄 User ${userId.substring(0, 6)} is buffering`);
        // Broadcast buffering state to all other users
        socket.broadcast.emit('control', {
          type: 'buffering',
          time: time,
          timestamp: Date.now(),
          from: userId.substring(0, 6)
        });
        return;
      }
      
      if (type === 'buffer-ready') {
        console.log(`✅ User ${userId.substring(0, 6)} finished buffering`);
        // Broadcast buffer ready state to all other users
        socket.broadcast.emit('control', {
          type: 'buffer-ready',
          time: time,
          timestamp: Date.now(),
          from: userId.substring(0, 6)
        });
        return;
      }
      
      // Update room state based on control type
      if (time !== undefined && !isNaN(time)) {
        const newTime = Math.max(0, parseFloat(time)); // Ensure non-negative time
        
        // For seek commands, ALWAYS update the room time immediately
        if (type === 'seek') {
          movieRoom.currentTime = newTime;
          movieRoom.isPlaying = movieRoom.isPlaying; // Maintain current play state
          console.log(`🎯 SEEK: Room time updated to: ${newTime}s`);
        }
        // For play/pause, update time but be more lenient with differences
        else if (type === 'play' || type === 'pause') {
          // Only reject extremely large differences (like > 30 minutes)
          const timeDiff = Math.abs(movieRoom.currentTime - newTime);
          
          if (timeDiff < 1800) { // Less than 30 minutes difference
            movieRoom.currentTime = newTime;
            console.log(`🔄 ${type.toUpperCase()}: Room time updated to: ${newTime}s (diff: ${timeDiff.toFixed(1)}s)`);
          } else {
            console.log(`⚠️ Large time difference (${timeDiff.toFixed(1)}s) - using seek time anyway for ${type}`);
            movieRoom.currentTime = newTime; // Still update for user experience
          }
          
          // Update play state
          movieRoom.isPlaying = (type === 'play');
        }
        // For timesync, be more permissive
        else if (type === 'timesync') {
          const timeDiff = Math.abs(movieRoom.currentTime - newTime);
          
          if (timeDiff < 30) { // Less than 30 seconds difference
            movieRoom.currentTime = newTime;
          }
        }
      }
      
      movieRoom.lastUpdate = Date.now();
      
      // Update user activity
      if (movieRoom.users.has(userId)) {
        movieRoom.users.get(userId).lastSeen = Date.now();
      }
      
      // Broadcast to all other clients with the EXACT time from the control
      socket.broadcast.emit("control", {
        type,
        time: time !== undefined ? Math.max(0, parseFloat(time)) : movieRoom.currentTime,
        timestamp: Date.now(),
        from: userId.substring(0, 6)
      });
      
    } catch (error) {
      console.error(`❌ Control error from ${userId.substring(0, 6)}: ${error.message}`);
    }
  });

  
  // Handle sync requests
  socket.on("requestSync", () => {
    console.log(`🔄 Sync requested by ${userId.substring(0, 6)}`);
    socket.emit("control", {
      type: movieRoom.isPlaying ? 'play' : 'pause',
      time: movieRoom.currentTime,
      timestamp: Date.now(),
      sync: true
    });
  });
  
  // Handle chat messages
  socket.on("chatMessage", (message) => {
    if (message && typeof message === 'string' && message.trim().length > 0) {
      const chatData = {
        user: userId.substring(0, 6),
        message: message.trim().substring(0, 200), // Limit message length
        timestamp: Date.now()
      };
      
      console.log(`💬 Chat from ${chatData.user}: ${chatData.message}`);
      
      // Broadcast to everyone including sender
      io.emit("chatMessage", chatData);
    }
  });
  
  // Handle movie URL updates
  socket.on("updateMovieUrl", (url) => {
    if (url && typeof url === 'string') {
      movieRoom.movieUrl = url;
      console.log(`🎬 Movie URL updated by ${userId.substring(0, 6)}: ${url.substring(0, 50)}...`);
      
      // Broadcast new movie URL to all other users
      socket.broadcast.emit("movieUrlUpdate", url);
    }
  });
  
  // Handle disconnection
  socket.on("disconnect", (reason) => {
    movieRoom.users.delete(userId);
    console.log(`❌ User disconnected: ${userId.substring(0, 6)} (${reason}) (Total: ${movieRoom.users.size})`);
    
    // Broadcast updated user count
    io.emit('userCount', movieRoom.users.size);
  });
  
  // Handle connection errors
  socket.on("error", (error) => {
    console.error(`🔥 Socket error for ${userId.substring(0, 6)}:`, error.message);
  });
});

// Cleanup inactive users every 5 minutes
setInterval(() => {
  const now = Date.now();
  const fiveMinutesAgo = now - (5 * 60 * 1000);
  let cleanedCount = 0;
  
  for (const [userId, userInfo] of movieRoom.users) {
    if (userInfo.lastSeen < fiveMinutesAgo) {
      movieRoom.users.delete(userId);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    console.log(`🧹 Cleaned up ${cleanedCount} inactive users`);
    io.emit('userCount', movieRoom.users.size);
  }
}, 5 * 60 * 1000);

// Start server with enhanced configuration for video streaming
const PORT = process.env.PORT || 10000;

// Configure server timeouts for large file streaming and range requests
server.keepAliveTimeout = 600000; // 10 minutes
server.headersTimeout = 600000;   // 10 minutes
server.requestTimeout = 600000;   // 10 minutes

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎬 Movie Sync Server Started`);
  console.log(`🌐 Host: 0.0.0.0:${PORT}`);
  console.log(`📁 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔧 Features: Range Requests, Video Seeking, Large File Streaming, WebSocket, Chat`);
  console.log(`⏰ Started at: ${new Date().toLocaleString()}`);
  console.log(`📊 Timeouts: 10 minutes for large file streaming and seeking`);
});

// Enhanced error handling
server.on('error', (error) => {
  console.error('🔥 Server error:', error);
  if (error.code === 'EADDRINUSE') {
    console.log(`❌ Port ${PORT} is already in use`);
  }
});

// Handle client errors
server.on('clientError', (err, socket) => {
  console.error('🔥 Client error:', err.message);
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('🔥 Uncaught Exception:', err);
  console.log('Server will continue running');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 Unhandled Rejection at:', promise, 'reason:', reason);
  console.log('Server will continue running');
});
