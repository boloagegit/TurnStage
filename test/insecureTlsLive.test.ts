import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PreparedRequest } from '../src/shared/types';
import { fetchBoundedText } from '../src/extension/transport/boundedFetch';

const certificatePath = process.env.TURNSTAGE_TEST_TLS_CERT;
const keyPath = process.env.TURNSTAGE_TEST_TLS_KEY;
const live = Boolean(certificatePath && keyPath);

describe.skipIf(!live)('request-scoped invalid-certificate live transport', () => {
  const httpsServer = createHttpsServer();
  const proxyServer = createHttpServer();
  let endpoint = '';
  let proxyUrl = '';
  let proxyConnects = 0;

  beforeAll(async () => {
    httpsServer.setSecureContext({ cert: await readFile(certificatePath!), key: await readFile(keyPath!) });
    httpsServer.on('request', (request, response) => {
      if (request.url === '/slow') {
        setTimeout(() => { response.writeHead(200).end('late'); }, 250);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"ok":true}\n\n');
    });
    await new Promise<void>((resolve) => httpsServer.listen(0, '127.0.0.1', resolve));
    endpoint = `https://127.0.0.1:${(httpsServer.address() as AddressInfo).port}`;

    proxyServer.on('connect', (request, clientSocket, head) => {
      proxyConnects++;
      const [host, port] = (request.url ?? '').split(':');
      const target = connect(Number(port), host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) target.write(head);
        target.pipe(clientSocket);
        clientSocket.pipe(target);
      });
      target.on('error', () => clientSocket.destroy());
    });
    await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
    proxyUrl = `http://127.0.0.1:${(proxyServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await Promise.all([
      new Promise<void>((resolve) => httpsServer.close(() => resolve())),
      new Promise<void>((resolve) => proxyServer.close(() => resolve())),
    ]);
  });

  it('rejects the self-signed endpoint under the default strict policy', async () => {
    await expect(fetchBoundedText(prepared(`${endpoint}/stream`, false), { maxBytes: 4_096, timeoutMs: 2_000 }))
      .rejects.toMatchObject({ type: 'NetworkError' });
  });

  it('streams successfully only with a request-local direct bypass', async () => {
    const result = await fetchBoundedText(prepared(`${endpoint}/stream`, true), {
      maxBytes: 4_096,
      timeoutMs: 2_000,
      insecureTlsRoute: { mode: 'direct' },
    });
    expect(result.response.status).toBe(200);
    expect(result.text).toContain('{"ok":true}');
  });

  it('retains timeout enforcement while invalid-certificate access is active', async () => {
    await expect(fetchBoundedText(prepared(`${endpoint}/slow`, true), {
      maxBytes: 4_096,
      timeoutMs: 30,
      insecureTlsRoute: { mode: 'direct' },
    })).rejects.toMatchObject({ type: 'TimeoutError' });
  });

  it('uses an explicit HTTP CONNECT proxy without disabling proxy TLS', async () => {
    const result = await fetchBoundedText(prepared(`${endpoint}/stream`, true), {
      maxBytes: 4_096,
      timeoutMs: 2_000,
      insecureTlsRoute: { mode: 'manual-proxy', proxyUrl },
    });
    expect(result.text).toContain('{"ok":true}');
    expect(proxyConnects).toBe(1);
  });
});

function prepared(url: string, allowInvalidCertificates: boolean): PreparedRequest {
  return {
    method: 'GET',
    url,
    headers: { Accept: 'text/event-stream' },
    ...(allowInvalidCertificates ? { tls: { allowInvalidCertificates: true } } : {}),
    redacted: { method: 'GET', url, headers: { Accept: 'text/event-stream' }, ...(allowInvalidCertificates ? { tls: { allowInvalidCertificates: true } } : {}) },
  };
}
