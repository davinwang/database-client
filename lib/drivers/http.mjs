/** Minimal HTTP client (node:http/https) shared by the ClickHouse / Elasticsearch drivers.
 * Global fetch is avoided because self-signed certs must be controlled per connection (--insecure-tls) without touching process env. */

import http from 'node:http';
import https from 'node:https';

export function httpRequest(urlString, { method = 'GET', headers = {}, body, timeoutMs = 30000, insecureTls = false } = {}) {
  const url = new URL(urlString);
  const transport = url.protocol === 'https:' ? https : http;
  const payload = body === undefined || body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const finalHeaders = { ...headers };
  if (payload) finalHeaders['Content-Length'] = String(payload.length);

  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers: finalHeaders,
        rejectUnauthorized: !insecureTls,
        // One-shot CLI: no keep-alive pool, so no socket is left dangling before the process exits
        agent: false,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`HTTP request timed out (${timeoutMs}ms): ${url.host}`));
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}
