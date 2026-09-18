const http = require('http');
const net  = require('net');

const UPSTREAM = process.env.PROXY_URL;
let AUTH, HOST, PORT;

if (UPSTREAM) {
  const parsed = new URL(UPSTREAM);
  AUTH = 'Basic ' + Buffer.from(parsed.username + ':' + parsed.password).toString('base64');
  HOST = parsed.hostname;
  PORT = parseInt(parsed.port) || 3120;
}

// Hosts that KPSDK uses for its challenge — route these DIRECT (no upstream proxy)
// so Kasada's backend sees a clean IP instead of the proxy IP which may be flagged.
function isKpsdkHost(hostPort) {
  const host = hostPort.split(':')[0];
  return host === 'k.twitchcdn.net' ||
         host.endsWith('.twitchcdn.net') ||
         host === 'twitchcdn.net';
}

// HTTPS CONNECT tunnel — either direct (for KPSDK hosts) or via upstream proxy
function handleConnect(req, clientSocket, head, auth, host, port) {
  if (isKpsdkHost(req.url)) {
    // KPSDK host — bypass the upstream proxy so Kasada sees our real IP
    console.log(`DEBUG [proxy-direct] KPSDK host ${req.url} → going DIRECT (no proxy)`);
    const [targetHost, targetPort] = req.url.split(':');
    const srv = net.connect(parseInt(targetPort) || 443, targetHost, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const leftover = head && head.length ? head : null;
      if (leftover) srv.write(leftover);
      srv.pipe(clientSocket);
      clientSocket.pipe(srv);
    });
    srv.on('error',   () => { try { clientSocket.end(); } catch(e) {} });
    clientSocket.on('error', () => { try { srv.end(); } catch(e) {} });
    return;
  }

  // Normal host — tunnel through upstream proxy
  if (!host) { clientSocket.end(); return; }
  const srv = net.connect(port, host, () => {
    srv.write('CONNECT ' + req.url + ' HTTP/1.1\r\nHost: ' + req.url +
              '\r\nProxy-Authorization: ' + auth +
              '\r\nProxy-Connection: Keep-Alive\r\n\r\n');
    let chunks = [];
    srv.on('data', function onData(data) {
      chunks.push(data);
      const full = Buffer.concat(chunks).toString('utf8');
      const idx  = full.indexOf('\r\n\r\n');
      if (idx >= 0) {
        srv.removeListener('data', onData);
        if (full.startsWith('HTTP/1.1 200') || full.startsWith('HTTP/1.0 200')) {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          const leftover = Buffer.concat(chunks).slice(idx + 4);
          if (leftover.length) clientSocket.write(leftover);
          srv.pipe(clientSocket);
          clientSocket.pipe(srv);
          if (head && head.length) srv.write(head);
        } else {
          clientSocket.end();
          srv.end();
        }
      }
    });
  });
  srv.on('error',   () => { try { clientSocket.end(); } catch(e) {} });
  clientSocket.on('error', () => { try { srv.end(); } catch(e) {} });
}

function createLocalProxy() {
  const server = http.createServer((req, res) => {
    if (!UPSTREAM) { res.writeHead(502); res.end('No proxy configured'); return; }
    const opts = {
      host: HOST, port: PORT, path: req.url, method: req.method,
      headers: { ...req.headers, 'Proxy-Authorization': AUTH },
    };
    const proxyReq = http.request(opts, proxyRes => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => { try { res.writeHead(502); res.end(); } catch(e) {} });
    req.on('error', () => proxyReq.destroy());
    req.pipe(proxyReq);
  });

  server.on('connect', (req, clientSocket, head) => {
    if (!UPSTREAM) { clientSocket.end(); return; }
    handleConnect(req, clientSocket, head, AUTH, HOST, PORT);
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, server }));
    server.on('error', reject);
  });
}

let sharedServer = null;
let sharedPort   = null;

async function startLocalProxy(forceUrl) {
  const upstream = forceUrl || process.env.PROXY_URL;
  if (!upstream) return null;

  const parsed = new URL(upstream);
  const auth   = 'Basic ' + Buffer.from(parsed.username + ':' + parsed.password).toString('base64');
  const host   = parsed.hostname;
  const port   = parseInt(parsed.port) || 3120;

  if (!forceUrl && sharedServer && sharedPort) {
    try { if (sharedServer.address()) return sharedPort; } catch(e) {}
    sharedServer = null;
    sharedPort   = null;
  }

  const server = http.createServer((req, res) => {
    const opts = {
      host, port, path: req.url, method: req.method,
      headers: { ...req.headers, 'Proxy-Authorization': auth },
    };
    const proxyReq = http.request(opts, proxyRes => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => { try { res.writeHead(502); res.end(); } catch(e) {} });
    req.on('error', () => proxyReq.destroy());
    req.pipe(proxyReq);
  });

  server.on('connect', (req, clientSocket, head) => {
    handleConnect(req, clientSocket, head, auth, host, port);
  });

  const result = await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, server }));
    server.on('error', reject);
  });

  if (!forceUrl) {
    sharedServer = result.server;
    sharedPort   = result.port;
    sharedServer.on('error', () => { sharedServer = null; sharedPort = null; });
  }
  return result.port;
}

async function resetLocalProxy() {
  console.log('DEBUG [proxy] resetting proxy for fresh IP...');
  if (sharedServer) { try { sharedServer.close(); } catch(e) {} }
  sharedServer = null;
  sharedPort   = null;
  return startLocalProxy();
}

module.exports = { startLocalProxy, resetLocalProxy, get server() { return sharedServer; } };
