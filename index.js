* Features:
 *  - Token generation (AES-256-CBC)
 *  - Token expiry enforcement
 *  - WebSocket token validation
 *  - Prometheus metrics
 *  - Preset-driven OR dynamic connections
 *  - Serves browser client
 */

const fs = require('fs');

const path = require('path');
const url = require('url');
const express = require('express');
const http = require('http');
const cors = require('cors');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const GuacamoleLite = require('guacamole-lite');
const client = require('prom-client');

const app = express();
app.use(cors());
const PORT = process.env.PORT || 8080;
const CIPHER = 'AES-256-CBC';

/* ------------------------------------------------------------------
   PROMETHEUS METRICS
-------------------------------------------------------------------*/

const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics({ timeout: 5000 });

const tokensIssued = new client.Counter({
  name: 'guac_tokens_issued_total',
  help: 'Total number of tokens issued by /token endpoint'
});

const tokenValidationFailed = new client.Counter({
  name: 'guac_token_validation_failed_total',
  help: 'Total number of token validation failures (bad format/decrypt)'
});

const tokenExpired = new client.Counter({
  name: 'guac_token_expired_total',
  help: 'Total number of token expiry rejections at upgrade'
});

const connectionsTotal = new client.Counter({
  name: 'guac_connections_total',
  help: 'Total number of successful guacamole connections established'
});

const connectionsActive = new client.Gauge({
  name: 'guac_connections_active',
  help: 'Current number of active guacamole connections'
});

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5]
});

/* latency measurement middleware */
app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer({
    method: req.method,
    route: req.path,
  });
  res.on('finish', () => {
    end({ status_code: res.statusCode });
  });
  next();
});

/* Prometheus endpoint */
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', client.register.contentType);
    res.send(await client.register.metrics());
  } catch (err) {
    res.status(500).send(String(err));
  }
});

/* ------------------------------------------------------------------
   STATIC CLIENT
-------------------------------------------------------------------*/

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

/* ------------------------------------------------------------------
   LOAD CONNECTIONS
-------------------------------------------------------------------*/

const CONNECTIONS_FILE =
  process.env.CONNECTIONS_FILE || path.join(__dirname, 'connections.json');

let CONNECTIONS = {};
try {
  CONNECTIONS = JSON.parse(fs.readFileSync(CONNECTIONS_FILE, 'utf8'));
  console.log('Loaded presets:', Object.keys(CONNECTIONS));
} catch (e) {
  console.warn('No connections.json or invalid JSON; presets disabled.');
}

/* ------------------------------------------------------------------
   CRYPTO & TOKEN CONFIG
-------------------------------------------------------------------*/

const TOKEN_SECRET = process.env.TOKEN_SECRET;
if (!TOKEN_SECRET) {
  console.error('TOKEN_SECRET environment variable is required.');
  process.exit(1);
}

const AES_KEY = crypto.createHash('sha256')
  .update(String(TOKEN_SECRET))
  .digest();

const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  console.error('API_KEY environment variable is required.');
  process.exit(1);
}

/* ------------------------------------------------------------------
   GUACD CONFIG
-------------------------------------------------------------------*/

const guacdHost = process.env.GUACD_HOST || '127.0.0.1';

const guacdPort = parseInt(process.env.GUACD_PORT || '4822', 10);

const server = http.createServer(app);

const websocketOptions = { server, path: '/ws' }
const guacdOptions = { host: guacdHost, port: guacdPort };

const clientOptions = {
  crypt: { cypher: 'AES-256-CBC', key: TOKEN_SECRET },
  joinSecondsToKeepSession: 3600,
  log: {level: 'DEBUG'}
};

const guacServer = new GuacamoleLite(
  websocketOptions,
  guacdOptions,
  clientOptions
);

/* ------------------------------------------------------------------
   GUACAMOLE EVENT METRICS
-------------------------------------------------------------------*/

guacServer.on('connection', (info) => {
  console.log('New guacamole connection:', info);
  connectionsTotal.inc();
  connectionsActive.inc();
});

guacServer.on('close', () => {
  console.log('Guacamole connection closed');
  try {
    connectionsActive.dec();
  } catch {
    connectionsActive.set(0);
  }
});

guacServer.on('error', (err) => {
  console.error('Guacamole error:', err);
});

/* ------------------------------------------------------------------
   HELPER: CREATE TOKEN
-------------------------------------------------------------------*/

function createTokenForConnection(connectionObject) {
  const plaintext = JSON.stringify(connectionObject);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(CIPHER, Buffer.from(TOKEN_SECRET), iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const tokenPkg = {
    iv: iv.toString('base64'),
    value: encrypted,
  };

  return Buffer.from(JSON.stringify(tokenPkg)).toString('base64');
}

/* ------------------------------------------------------------------
   HELPER: DECRYPT TOKEN
-------------------------------------------------------------------*/

function decryptToken(tokenBase64) {
  let pkg;
  try {
    pkg = JSON.parse(
      Buffer.from(tokenBase64, 'base64').toString('utf8')
    );
  } catch (e) {
    throw new Error('Token base64/JSON parse failed');
  }

  if (!pkg.iv || !pkg.value)
    throw new Error('Token package missing iv or value');

  const iv = Buffer.from(pkg.iv, 'base64');
  const encrypted = pkg.value;

  const decipher = crypto.createDecipheriv('aes-256-cbc', TOKEN_SECRET, iv);
  let decrypted;

  try {
    decrypted = decipher.update(encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
  } catch (e) {
    throw new Error('Decryption failed');
  }

  return JSON.parse(decrypted);
}

/* ------------------------------------------------------------------
   HELPER: BUILD CONNECTION STRING
-------------------------------------------------------------------*/

function buildConnectionString(conn) {
  const type = conn.type || conn.protocol || 'ssh';
  
  if (type === 'kubernetes' || conn.kubernetes) {
    // Kubernetes exec connection via SSH with ProxyCommand
    const k8s = conn.kubernetes || {};
    const namespace = k8s.namespace || 'default';
    const pod = k8s.pod || k8s.podName;
    const container = k8s.container || k8s.containerName || '';
    const command = k8s.command || '/bin/sh';
    const kubeconfig = k8s.kubeconfig || process.env.KUBECONFIG || '';
    
    if (!pod) {
      throw new Error('Kubernetes pod name is required');
    }
    
    // Build kubectl exec command for ProxyCommand
    let kubectlCmd = 'kubectl exec -i';
    if (namespace) kubectlCmd += ` -n ${namespace}`;
    if (container) kubectlCmd += ` -c ${container}`;
    kubectlCmd += ` ${pod} -- ${command}`;
    
    if (kubeconfig) {
      kubectlCmd = `KUBECONFIG=${kubeconfig} ${kubectlCmd}`;
    }
    
    // SSH connection string with ProxyCommand for kubectl exec
    // Format: ssh://user@host?ProxyCommand=kubectl exec ...
    const host = k8s.host || 'kubernetes';
    const user = k8s.user || conn.username || 'root';
    const port = k8s.port || conn.port || 22;
    
    return `ssh://${user}@${host}:${port}?ProxyCommand=${encodeURIComponent(kubectlCmd)}`;
  }
  
  if (type === 'rdp') {
    // RDP connection
    const host = conn.hostname || conn.host;
    const port = conn.port || 3389;
    const username = conn.username || '';
    const password = conn.password || '';
    const domain = conn.domain || '';
    const security = conn.security || 'any';
    const ignoreCert = conn['ignore-cert'] || conn.ignoreCert || false;
    const audio = conn.audio || false;
    
    let rdpStr = `rdp://${host}:${port}`;
    const params = [];
    
    if (username) params.push(`username=${encodeURIComponent(username)}`);
    if (password) params.push(`password=${encodeURIComponent(password)}`);
    if (domain) params.push(`domain=${encodeURIComponent(domain)}`);
    if (security !== 'any') params.push(`security=${security}`);
    if (ignoreCert) params.push('ignore-cert=true');
    if (audio) params.push('audio=true');
    
    if (params.length > 0) {
      rdpStr += '?' + params.join('&');
    }
    
    return rdpStr;
  }
  
  // Default SSH connection
  const host = conn.hostname || conn.host;
  const port = conn.port || 22;
  const username = conn.username || 'root';
  const password = conn.password || '';
  const privateKey = conn['private-key'] || conn.privateKey || '';
  const passphrase = conn.passphrase || '';
  const hostKey = conn['host-key'] || conn.hostKey || '';
  
  let sshStr = `ssh://${username}@${host}:${port}`;
  const params = [];
  
  if (password) params.push(`password=${encodeURIComponent(password)}`);
  if (privateKey) params.push(`private-key=${encodeURIComponent(privateKey)}`);
  if (passphrase) params.push(`passphrase=${encodeURIComponent(passphrase)}`);
  if (hostKey) params.push(`host-key=${encodeURIComponent(hostKey)}`);
  
  if (params.length > 0) {
    sshStr += '?' + params.join('&');
  }
  
  return sshStr;
}

/* ------------------------------------------------------------------
   TOKEN ENDPOINT (PRESET + DYNAMIC)
-------------------------------------------------------------------*/

app.post('/token', (req, res) => {
  const providedKey = req.headers['x-api-key'];
  if (!providedKey || providedKey !== API_KEY)
    return res.status(401).json({ error: 'invalid api key' });

  const body = req.body || {};
  const ttl = Number(body.ttl) || 300;

  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 86400)
    return res.status(400).json({
      error: 'ttl must be integer between 1 and 86400 seconds',
    });

  if (body.preset) {
    const preset = CONNECTIONS[body.preset];
    if (!preset)
      return res.status(404).json({ error: 'preset not found' });

    const now = Math.floor(Date.now() / 1000);
    let conn = { ...preset };
    
    // Build connection string if not already present
    if (!conn.connectionString) {
      try {
        conn.connectionString = buildConnectionString(conn);
      } catch (err) {
        return res.status(400).json({ error: `Invalid connection config: ${err.message}` });
      }
    }
    
    // Add expiry to connection object
    conn._expires = now + ttl;

    const token = createTokenForConnection(conn);
    tokensIssued.inc();

    const wsProtocol =
      req.secure || req.headers['x-forwarded-proto'] === 'https'
        ? 'wss'
        : 'ws';

    const wsUrl =
      `${wsProtocol}://${req.headers.host}/ws/?token=${encodeURIComponent(token)}`;

    return res.json({
      token,
      wsUrl,
      expires_at: conn._expires,
      mode: 'preset',
      connection_type: conn.type || conn.protocol || 'ssh',
    });
  }

  if (!body.connection || typeof body.connection !== 'object')
    return res.status(400).json({
      error: 'connection object required (or use preset)',
    });

  const now = Math.floor(Date.now() / 1000);
  let conn = { ...body.connection };
  
  // Build connection string
  try {
    if (!conn.connectionString) {
      conn.connectionString = buildConnectionString(conn);
    }
  } catch (err) {
    return res.status(400).json({ error: `Invalid connection config: ${err.message}` });
  }
  
  // Add expiry to connection object
  conn._expires = now + ttl;

  const token = createTokenForConnection(conn);
  tokensIssued.inc();

  const wsProtocol =
    req.secure || req.headers['x-forwarded-proto'] === 'https'
      ? 'wss'
      : 'ws';

  const wsUrl =
    `${wsProtocol}://${req.headers.host}/ws/?token=${encodeURIComponent(token)}`;

  return res.json({
    token,
    wsUrl,
    expires_at: conn._expires,
    mode: 'dynamic',
    connection_type: conn.type || conn.protocol || 'ssh',
  });
});

/* ------------------------------------------------------------------
   LIST PRESETS
-------------------------------------------------------------------*/

app.get('/presets', (req, res) => {
  const providedKey = req.headers['x-api-key'];
  if (!providedKey || providedKey !== API_KEY)
    return res.status(401).json({ error: 'invalid api key' });

  res.json({ presets: Object.keys(CONNECTIONS) });
});
/* ------------------------------------------------------------------
   WEBSOCKET UPGRADE VALIDATION

-----------------------------------------------------------*/
server.on('upgrade', (req, socket, head) => {
  try {
    const parsed = url.parse(req.url, true);
    if (parsed.pathname !== '/ws') return;

    const token = parsed.query?.token;
    if (!token) {
      tokenValidationFailed.inc();
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    let connObject;
    try {
      connObject = decryptToken(token);
      console.log('[DEBUG] Decrypted token payload:', JSON.stringify(connObject));
    } catch (e) {
      tokenValidationFailed.inc();
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!connObject._expires) {
      tokenValidationFailed.inc();
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    if (now > connObject._expires) {
      tokenExpired.inc();
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    return;
  } catch (e) {
    try {
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
    } catch {}
    socket.destroy();
  }
});
/* ------------------------------------------------------------------
   SHUTDOWN SIGNALS
-------------------------------------------------------------------*/

process.on('exit', () => {
  try { connectionsActive.set(0); } catch {}
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

/* ------------------------------------------------------------------
   START SERVER
-------------------------------------------------------------------*/

server.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
  console.log(`guacd backend: ${guacdHost}:${guacdPort}`);
});
