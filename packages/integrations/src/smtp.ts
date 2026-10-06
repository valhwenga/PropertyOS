import { createConnection, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

/**
 * A minimal, dependency-free SMTP client.
 *
 * Deliberately small: PropertyOS sends transactional messages only (invitations,
 * statement notices), so it needs AUTH, STARTTLS and a single recipient — not a
 * general mail library.
 *
 * It returns the server's own acknowledgement of the queued message, including
 * the queue id where the server supplies one. Nothing here reports success
 * unless the server issued a 2xx to the final `.` — the whole point of the
 * adapter is that "sent" means the provider accepted it.
 */

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
  /** true for implicit TLS (port 465); otherwise STARTTLS is attempted. */
  secure?: boolean;
  timeoutMs?: number;
  rejectUnauthorized?: boolean;
}

export interface SmtpMessage {
  to: string;
  subject: string;
  body: string;
}

export interface SmtpAccepted {
  accepted: true;
  /** The server's final response, which usually carries its queue id. */
  response: string;
  messageId: string;
}

export class SmtpError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = 'SmtpError';
  }
}

type AnySocket = Socket | TLSSocket;

class SmtpSession {
  private buffer = '';
  private resolver: ((line: string) => void) | null = null;
  private rejecter: ((error: Error) => void) | null = null;

  constructor(private socket: AnySocket, private readonly timeoutMs: number) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', (error) => this.rejecter?.(error));
    socket.on('close', () => this.rejecter?.(new SmtpError('The SMTP connection closed unexpectedly.')));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    // A complete reply ends with "NNN " (space, not hyphen) on the last line.
    const match = /^\d{3} [^\n]*\r?\n/m.exec(this.buffer);
    if (!match) return;
    const index = this.buffer.indexOf(match[0]);
    const reply = this.buffer.slice(0, index + match[0].length);
    this.buffer = this.buffer.slice(index + match[0].length);
    const resolve = this.resolver;
    this.resolver = null;
    this.rejecter = null;
    resolve?.(reply.trim());
  }

  read(): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new SmtpError('The SMTP server did not respond in time.')),
        this.timeoutMs,
      );
      this.resolver = (line) => { clearTimeout(timer); resolve(line); };
      this.rejecter = (error) => { clearTimeout(timer); reject(error); };
    });
  }

  write(line: string): void {
    this.socket.write(`${line}\r\n`);
  }

  async command(line: string, expected: number[]): Promise<string> {
    this.write(line);
    const reply = await this.read();
    const code = Number(reply.slice(0, 3));
    if (!expected.includes(code)) {
      // The command text is included but never the credentials: AUTH arguments
      // are base64 secrets and must not reach a log or an error message.
      const safe = line.startsWith('AUTH') ? 'AUTH …' : line;
      throw new SmtpError(`SMTP server rejected "${safe}": ${reply}`, code);
    }
    return reply;
  }

  upgrade(host: string, rejectUnauthorized: boolean): void {
    const plain = this.socket;
    plain.removeAllListeners('data');
    plain.removeAllListeners('error');
    plain.removeAllListeners('close');
    const secure = tlsConnect({ socket: plain as Socket, servername: host, rejectUnauthorized });
    this.socket = secure;
    this.buffer = '';
    secure.setEncoding('utf8');
    secure.on('data', (chunk: string) => this.onData(chunk));
    secure.on('error', (error) => this.rejecter?.(error));
  }

  end(): void {
    try { this.socket.end(); } catch { /* already closed */ }
  }
}

function encodeHeader(value: string): string {
  // RFC 2047 for anything outside ASCII, so a resident's name renders correctly.
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Dot-stuffing: a line starting with "." would otherwise end the DATA block. */
function dotStuff(body: string): string {
  return body.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

export async function sendViaSmtp(
  config: SmtpConfig,
  message: SmtpMessage,
): Promise<SmtpAccepted> {
  const timeoutMs = config.timeoutMs ?? 15_000;
  const rejectUnauthorized = config.rejectUnauthorized ?? true;

  const socket: AnySocket = config.secure
    ? tlsConnect({ host: config.host, port: config.port, servername: config.host, rejectUnauthorized })
    : createConnection({ host: config.host, port: config.port });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SmtpError('Timed out connecting to the SMTP server.')), timeoutMs);
    socket.once(config.secure ? 'secureConnect' : 'connect', () => { clearTimeout(timer); resolve(); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });

  const session = new SmtpSession(socket, timeoutMs);
  try {
    await session.read(); // greeting
    let ehlo = await session.command(`EHLO ${hostnameFor(config.from)}`, [250]);

    if (!config.secure && /STARTTLS/i.test(ehlo)) {
      await session.command('STARTTLS', [220]);
      session.upgrade(config.host, rejectUnauthorized);
      ehlo = await session.command(`EHLO ${hostnameFor(config.from)}`, [250]);
    }

    if (config.user) {
      if (/AUTH[ =-].*PLAIN/i.test(ehlo)) {
        const token = Buffer.from(`\0${config.user}\0${config.password}`, 'utf8').toString('base64');
        await session.command(`AUTH PLAIN ${token}`, [235]);
      } else {
        await session.command('AUTH LOGIN', [334]);
        await session.command(Buffer.from(config.user, 'utf8').toString('base64'), [334]);
        await session.command(Buffer.from(config.password, 'utf8').toString('base64'), [235]);
      }
    }

    await session.command(`MAIL FROM:<${addressOf(config.from)}>`, [250]);
    await session.command(`RCPT TO:<${addressOf(message.to)}>`, [250, 251]);
    await session.command('DATA', [354]);

    const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@${hostnameFor(config.from)}>`;
    const headers = [
      `From: ${config.from}`,
      `To: ${message.to}`,
      `Subject: ${encodeHeader(message.subject)}`,
      `Message-ID: ${messageId}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      'Auto-Submitted: auto-generated',
    ].join('\r\n');

    session.write(`${headers}\r\n\r\n${dotStuff(message.body)}\r\n.`);
    const response = await session.read();
    const code = Number(response.slice(0, 3));
    if (code !== 250) {
      throw new SmtpError(`The SMTP server did not accept the message: ${response}`, code);
    }

    await session.command('QUIT', [221]).catch(() => undefined);
    return { accepted: true, response: response.trim(), messageId };
  } finally {
    session.end();
  }
}

function addressOf(value: string): string {
  const match = /<([^>]+)>/.exec(value);
  return (match?.[1] ?? value).trim();
}

function hostnameFor(from: string): string {
  return addressOf(from).split('@')[1] ?? 'localhost';
}
