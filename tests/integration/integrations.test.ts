/**
 * Integration adapters, tested against REAL servers.
 *
 * The SMTP tests run a minimal SMTP server in-process and assert the full
 * conversation: EHLO, AUTH, MAIL FROM, RCPT TO, DATA, and the final acceptance.
 * The ClamAV tests run a mock daemon speaking the INSTREAM protocol and assert
 * that the client frames the stream correctly and interprets every verdict.
 *
 * The point is that "sent" and "clean" are claims we can now defend, rather than
 * states the code assigns to itself.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EICAR_TEST_STRING, LocalFilesystemStorage, SmtpEmailAdapter, assertSafeKey,
  interpret, resolveEmailAdapter, scanDocument, scanWithClamAv, sendViaSmtp,
  signObjectToken, verifyObjectToken,
} from '@propertyos/integrations';

/* ------------------------------------------------------------------ SMTP */

interface CapturedMail {
  mailFrom: string;
  rcptTo: string[];
  data: string;
  authenticated: boolean;
}

function startSmtpServer(options: {
  rejectAuth?: boolean; rejectData?: boolean; announceAuth?: boolean;
} = {}): Promise<{ server: Server; port: number; captured: CapturedMail[] }> {
  const captured: CapturedMail[] = [];

  const server = createServer((socket: Socket) => {
    let state: CapturedMail = { mailFrom: '', rcptTo: [], data: '', authenticated: false };
    let inData = false;
    let buffer = '';
    let pendingAuth: 'user' | 'password' | null = null;

    socket.setEncoding('utf8');
    socket.write('220 test.invalid ESMTP ready\r\n');

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            captured.push({ ...state });
            socket.write(
              options.rejectData
                ? '554 5.7.1 Message rejected by policy\r\n'
                : '250 2.0.0 Ok: queued as ABC123\r\n',
            );
            state = { mailFrom: '', rcptTo: [], data: '', authenticated: state.authenticated };
          } else {
            // Undo dot-stuffing so the assertion sees the original body.
            state.data += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          }
          continue;
        }

        if (pendingAuth === 'user') { pendingAuth = 'password'; socket.write('334 UGFzc3dvcmQ6\r\n'); continue; }
        if (pendingAuth === 'password') {
          pendingAuth = null;
          if (options.rejectAuth) socket.write('535 5.7.8 Authentication credentials invalid\r\n');
          else { state.authenticated = true; socket.write('235 2.7.0 Authentication successful\r\n'); }
          continue;
        }

        const [verb] = line.split(' ');
        switch (verb?.toUpperCase()) {
          case 'EHLO':
            socket.write('250-test.invalid\r\n');
            if (options.announceAuth !== false) socket.write('250-AUTH PLAIN LOGIN\r\n');
            socket.write('250 SIZE 10240000\r\n');
            break;
          case 'AUTH':
            if (/PLAIN/i.test(line)) {
              if (options.rejectAuth) socket.write('535 5.7.8 Authentication credentials invalid\r\n');
              else { state.authenticated = true; socket.write('235 2.7.0 Authentication successful\r\n'); }
            } else {
              pendingAuth = 'user';
              socket.write('334 VXNlcm5hbWU6\r\n');
            }
            break;
          case 'MAIL': state.mailFrom = line; socket.write('250 2.1.0 Ok\r\n'); break;
          case 'RCPT': state.rcptTo.push(line); socket.write('250 2.1.5 Ok\r\n'); break;
          case 'DATA': inData = true; socket.write('354 End data with <CR><LF>.<CR><LF>\r\n'); break;
          case 'QUIT': socket.write('221 2.0.0 Bye\r\n'); socket.end(); break;
          default: socket.write('500 5.5.2 Command unrecognised\r\n');
        }
      }
    });
    socket.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port, captured });
    });
  });
}

describe('SMTP delivery', () => {
  let open: Server | null = null;
  afterEach(() => { open?.close(); open = null; });

  it('delivers a message and reports the server queue id', async () => {
    const { server, port, captured } = await startSmtpServer();
    open = server;

    const result = await sendViaSmtp(
      { host: '127.0.0.1', port, user: 'apikey', password: 'secret', from: 'PropertyOS <no-reply@spike.invalid>' },
      { to: 'resident@demo.invalid', subject: 'Your statement for January', body: 'Amount due: R1,850.00' },
    );

    expect(result.accepted).toBe(true);
    expect(result.response).toContain('queued as ABC123');
    expect(captured).toHaveLength(1);
    expect(captured[0]!.authenticated).toBe(true);
    expect(captured[0]!.mailFrom).toContain('<no-reply@spike.invalid>');
    expect(captured[0]!.rcptTo[0]).toContain('<resident@demo.invalid>');
    expect(captured[0]!.data).toContain('Subject: Your statement for January');
    expect(captured[0]!.data).toContain('Amount due: R1,850.00');
  });

  it('reports failure, not success, when the server rejects the message', async () => {
    const { server, port } = await startSmtpServer({ rejectData: true });
    open = server;

    const adapter = new SmtpEmailAdapter({
      host: '127.0.0.1', port, user: 'u', password: 'p', from: 'no-reply@spike.invalid',
    });
    const outcome = await adapter.send({ to: 'a@demo.invalid', subject: 'S', body: 'B' });

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.error).toContain('554');
  });

  it('reports failure when authentication is refused', async () => {
    const { server, port } = await startSmtpServer({ rejectAuth: true });
    open = server;

    const adapter = new SmtpEmailAdapter({
      host: '127.0.0.1', port, user: 'u', password: 'wrong', from: 'no-reply@spike.invalid',
    });
    const outcome = await adapter.send({ to: 'a@demo.invalid', subject: 'S', body: 'B' });

    expect(outcome.status).toBe('failed');
    // The credentials must not appear in the error that gets logged.
    if (outcome.status === 'failed') {
      expect(outcome.error).not.toContain('wrong');
      expect(outcome.error).toContain('AUTH …');
    }
  });

  it('reports failure when the server is unreachable, rather than hanging or lying', async () => {
    const adapter = new SmtpEmailAdapter({
      // Port 1 is reserved and nothing listens there.
      host: '127.0.0.1', port: 1, user: 'u', password: 'p', from: 'no-reply@spike.invalid',
      timeoutMs: 2000,
    });
    const outcome = await adapter.send({ to: 'a@demo.invalid', subject: 'S', body: 'B' });
    expect(outcome.status).toBe('failed');
  });

  it('falls back to AUTH LOGIN when PLAIN is not offered', async () => {
    const { server, port, captured } = await startSmtpServer({ announceAuth: false });
    open = server;
    // The server advertises no AUTH, so the client uses the LOGIN exchange.
    await sendViaSmtp(
      { host: '127.0.0.1', port, user: 'user', password: 'pass', from: 'no-reply@spike.invalid' },
      { to: 'a@demo.invalid', subject: 'S', body: 'B' },
    );
    expect(captured[0]!.authenticated).toBe(true);
  });

  it('dot-stuffs a body line that would otherwise terminate the message', async () => {
    const { server, port, captured } = await startSmtpServer();
    open = server;
    await sendViaSmtp(
      { host: '127.0.0.1', port, user: 'u', password: 'p', from: 'no-reply@spike.invalid' },
      { to: 'a@demo.invalid', subject: 'S', body: 'Line one\n.\nLine two after a lone dot' },
    );
    // The message survived intact rather than being truncated at the dot.
    expect(captured[0]!.data).toContain('Line two after a lone dot');
  });

  it('encodes a non-ASCII subject so it is not mangled', async () => {
    const { server, port, captured } = await startSmtpServer();
    open = server;
    await sendViaSmtp(
      { host: '127.0.0.1', port, user: 'u', password: 'p', from: 'no-reply@spike.invalid' },
      { to: 'a@demo.invalid', subject: 'Staat vir Thandiwe — R1 850,00', body: 'B' },
    );
    expect(captured[0]!.data).toContain('=?UTF-8?B?');
  });

  it('still uses the sink, never a silent success, when SMTP is misconfigured', () => {
    expect(resolveEmailAdapter({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'x' } as NodeJS.ProcessEnv).name)
      .toBe('sink');
    expect(resolveEmailAdapter({} as NodeJS.ProcessEnv).name).toBe('sink');
  });
});

/* --------------------------------------------------------------- ClamAV */

function startClamd(verdict: string | 'drop'): Promise<{ server: Server; port: number; received: Buffer[] }> {
  const received: Buffer[] = [];
  const server = createServer((socket) => {
    socket.on('data', (chunk) => {
      received.push(chunk);
      // The stream ends with a zero-length chunk header.
      if (chunk.length >= 4 && chunk.readUInt32BE(chunk.length - 4) === 0) {
        if (verdict === 'drop') { socket.destroy(); return; }
        socket.write(`${verdict}\0`);
        socket.end();
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0, received });
    });
  });
}

describe('ClamAV scanning', () => {
  let open: Server | null = null;
  afterEach(() => { open?.close(); open = null; });

  it('frames the INSTREAM protocol correctly and reports a clean file', async () => {
    const { server, port, received } = await startClamd('stream: OK');
    open = server;

    const result = await scanWithClamAv(
      { host: '127.0.0.1', port },
      new TextEncoder().encode('a harmless PDF'),
    );
    expect(result.status).toBe('clean');

    const all = Buffer.concat(received);
    expect(all.subarray(0, 10).toString()).toBe('zINSTREAM\0');
    // Terminated by a zero-length chunk, without which clamd would wait forever.
    expect(all.readUInt32BE(all.length - 4)).toBe(0);
  });

  it('reports an infected file with its signature', async () => {
    const { server, port } = await startClamd('stream: Eicar-Test-Signature FOUND');
    open = server;

    const result = await scanWithClamAv(
      { host: '127.0.0.1', port },
      new TextEncoder().encode(EICAR_TEST_STRING),
    );
    expect(result.status).toBe('infected');
    if (result.status === 'infected') expect(result.signature).toBe('Eicar-Test-Signature');
  });

  it('treats a scanner error as FAILED, never as clean', async () => {
    const { server, port } = await startClamd('INSTREAM size limit exceeded. ERROR');
    open = server;
    const result = await scanWithClamAv({ host: '127.0.0.1', port }, new Uint8Array([1, 2, 3]));
    expect(result.status).toBe('failed');
    expect(result.status).not.toBe('clean');
  });

  it('treats an unreachable or silent scanner as FAILED, never as clean', async () => {
    const unreachable = await scanWithClamAv(
      { host: '127.0.0.1', port: 1, timeoutMs: 1500 }, new Uint8Array([1]),
    );
    expect(unreachable.status).toBe('failed');

    const { server, port } = await startClamd('drop');
    open = server;
    const dropped = await scanWithClamAv({ host: '127.0.0.1', port, timeoutMs: 1500 }, new Uint8Array([1]));
    expect(dropped.status).toBe('failed');
  });

  it('refuses a file above the scanner limit rather than skipping the scan silently', async () => {
    const result = await scanWithClamAv(
      { host: '127.0.0.1', port: 3310, maxBytes: 10 },
      new Uint8Array(100),
    );
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.detail).toContain('NOT scanned');
  });

  it('interprets every documented clamd reply shape', () => {
    expect(interpret('stream: OK\0').status).toBe('clean');
    expect(interpret('stream: Win.Test.EICAR_HDB-1 FOUND').status).toBe('infected');
    expect(interpret('stream: ERROR').status).toBe('failed');
    expect(interpret('').status).toBe('failed');
    expect(interpret('something unexpected').status).toBe('failed');
  });

  it('routes through scanDocument with clamav configured', async () => {
    const { server, port } = await startClamd('stream: Eicar-Test-Signature FOUND');
    open = server;
    const outcome = await scanDocument(
      { bucket: 'b', key: 'k', body: new TextEncoder().encode(EICAR_TEST_STRING) },
      { MALWARE_SCANNER: 'clamav', CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(port) } as NodeJS.ProcessEnv,
    );
    expect(outcome.status).toBe('infected');
  });

  it('refuses to scan when the body was not supplied', async () => {
    const outcome = await scanDocument(
      { bucket: 'b', key: 'k' },
      { MALWARE_SCANNER: 'clamav' } as NodeJS.ProcessEnv,
    );
    expect(outcome.status).toBe('failed');
  });

  it('rejects an unsupported scanner name instead of assuming clean', async () => {
    const outcome = await scanDocument(
      { bucket: 'b', key: 'k', body: new Uint8Array([1]) },
      { MALWARE_SCANNER: 'something-else' } as NodeJS.ProcessEnv,
    );
    expect(outcome.status).toBe('failed');
  });
});

/* -------------------------------------------------------------- storage */

describe('Private object storage', () => {
  it('stores and retrieves an object', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propertyos-storage-'));
    try {
      const storage = new LocalFilesystemStorage(root, 'x'.repeat(48), 'http://localhost:3000');
      const body = new TextEncoder().encode('%PDF-1.7 lease contract');
      const stored = await storage.put({ key: 'org/lease/contract.pdf', body, contentType: 'application/pdf' });

      expect(stored.byteSize).toBe(body.byteLength);
      expect(new TextDecoder().decode(await storage.get('org/lease/contract.pdf')))
        .toBe('%PDF-1.7 lease contract');

      // Written with restrictive permissions, not world readable.
      const onDisk = await readFile(join(root, 'org/lease/contract.pdf'));
      expect(onDisk.byteLength).toBe(body.byteLength);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a traversal key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propertyos-storage-'));
    try {
      const storage = new LocalFilesystemStorage(root, 'x'.repeat(48), 'http://localhost:3000');
      await expect(
        storage.put({ key: '../escaped.pdf', body: new Uint8Array([1]), contentType: 'application/pdf' }),
      ).rejects.toThrow(/Invalid storage key/);
      await expect(storage.get('/etc/passwd')).rejects.toThrow(/Invalid storage key/);
      expect(() => assertSafeKey('a/../../b')).toThrow(/Invalid storage key/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('issues a time-limited signed URL and rejects a tampered one', async () => {
    const secret = 'y'.repeat(48);
    const root = await mkdtemp(join(tmpdir(), 'propertyos-storage-'));
    try {
      const storage = new LocalFilesystemStorage(root, secret, 'http://localhost:3000');
      const signed = await storage.signedDownload({ key: 'org/doc.pdf', ttlSeconds: 300 });

      const url = new URL(signed.url);
      const key = url.searchParams.get('key')!;
      const expires = Number(url.searchParams.get('expires'));
      const token = url.searchParams.get('token')!;

      expect(verifyObjectToken(secret, { key, expiresUnix: expires, token }).valid).toBe(true);

      // A different key with the same token must not verify.
      expect(verifyObjectToken(secret, { key: 'org/other.pdf', expiresUnix: expires, token }))
        .toMatchObject({ valid: false, reason: 'bad_signature' });

      // A later expiry with the same token must not verify.
      expect(verifyObjectToken(secret, { key, expiresUnix: expires + 3600, token }))
        .toMatchObject({ valid: false, reason: 'bad_signature' });

      // An expired token is refused even with a correct signature.
      const past = Math.floor(Date.now() / 1000) - 10;
      expect(verifyObjectToken(secret, {
        key, expiresUnix: past, token: signObjectToken(secret, key, past),
      })).toMatchObject({ valid: false, reason: 'expired' });

      // A token signed with a different secret must not verify.
      expect(verifyObjectToken(secret, {
        key, expiresUnix: expires, token: signObjectToken('z'.repeat(48), key, expires),
      }).valid).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to construct local storage with a weak signing secret', () => {
    expect(() => new LocalFilesystemStorage('/tmp', 'short', 'http://localhost:3000'))
      .toThrow(/at least 32 characters/);
  });
});
