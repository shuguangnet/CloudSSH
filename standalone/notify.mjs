// Notification dispatchers shared by scheduled tasks and uptime monitoring.
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

const FETCH_TIMEOUT_MS = 15000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HTTP_URL = /^https?:\/\/[^\s]{3,2000}$/;

function httpUrl(value) {
  return typeof value === 'string' && HTTP_URL.test(value.trim()) ? value.trim() : null;
}

export function validateChannel(type, config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid channel settings');
  if (type === 'bark') {
    const url = httpUrl(config.url);
    if (!url) throw new Error('Bark server URL must be an http(s) address');
    const key = config.key === undefined || config.key === null || config.key === '' ? null : config.key;
    if (key !== null && (typeof key !== 'string' || key.length > 128)) throw new Error('Invalid Bark device key');
    return { type, config: { url, key } };
  }
  if (type === 'telegram') {
    if (typeof config.token !== 'string' || !/^\d+:[A-Za-z0-9_-]{30,60}$/.test(config.token)) {
      throw new Error('Invalid Telegram bot token');
    }
    if (typeof config.chat_id !== 'string' || !/^-?\d{1,16}$/.test(config.chat_id)) {
      throw new Error('Invalid Telegram chat id');
    }
    return { type, config: { token: config.token, chat_id: config.chat_id } };
  }
  if (type === 'webhook') {
    const url = httpUrl(config.url);
    if (!url) throw new Error('Webhook URL must be an http(s) address');
    return { type, config: { url } };
  }
  if (type === 'smtp') {
    if (typeof config.host !== 'string' || !config.host.trim() || config.host.length > 253) throw new Error('Invalid SMTP host');
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Invalid SMTP port');
    if (!['ssl', 'starttls', 'none'].includes(config.security)) throw new Error('SMTP security must be ssl, starttls or none');
    if (typeof config.from !== 'string' || !EMAIL.test(config.from)) throw new Error('Invalid sender address');
    if (typeof config.to !== 'string' || !EMAIL.test(config.to)) throw new Error('Invalid recipient address');
    const username = config.username === undefined || config.username === null || config.username === ''
      ? null : String(config.username);
    const password = config.password === undefined || config.password === null || config.password === ''
      ? null : String(config.password);
    if (username && username.length > 128) throw new Error('Invalid SMTP username');
    if (password && password.length > 256) throw new Error('Invalid SMTP password');
    if (username && !password) throw new Error('SMTP password is required when a username is set');
    return { type, config: { host: config.host.trim(), port: config.port, security: config.security, from: config.from, to: config.to, username, password } };
  }
  throw new Error('Unknown channel type');
}

async function fetchJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json().catch(() => ({}));
}

// ---------- Minimal SMTP client (plain / implicit TLS / STARTTLS) ----------

function createSmtpDialog(socket) {
  const pending = [];
  let waiting = null;
  let buffer = '';
  let lines = [];
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (!/^\d{3}[- ]/.test(line)) continue;
      lines.push(line.slice(4).trim());
      if (line[3] !== ' ') continue;
      const reply = { code: Number(line.slice(0, 3)), lines, text: lines.join(' ') };
      lines = [];
      if (waiting) { const done = waiting; waiting = null; done(reply); } else pending.push(reply);
    }
  });
  return {
    wait(timeoutMs = FETCH_TIMEOUT_MS) {
      if (pending.length) return Promise.resolve(pending.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting = null;
          reject(new Error('SMTP reply timed out'));
        }, timeoutMs);
        waiting = (reply) => { clearTimeout(timer); resolve(reply); };
      });
    },
    async expect(codes, timeoutMs) {
      const reply = await this.wait(timeoutMs);
      if (!codes.includes(reply.code)) throw new Error(`SMTP ${reply.code}: ${reply.text}`);
      return reply;
    },
    command(line, codes, timeoutMs) {
      socket.write(`${line}\r\n`);
      return this.expect(codes, timeoutMs);
    },
    write(data) { socket.write(data); },
  };
}

function socketOpened(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SMTP connection timed out')), FETCH_TIMEOUT_MS);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function wrapBase64(text) {
  return Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
}

export async function smtpSend({ host, port, security, username, password, from, to, subject, text }) {
  let socket;
  let dialog;
  let ehloLines = [];
  try {
    if (security === 'ssl') {
      socket = tlsConnect({ host, port, servername: host });
      await socketOpened(socket);
    } else {
      socket = netConnect({ host, port });
      await socketOpened(socket);
    }
    dialog = createSmtpDialog(socket);
    await dialog.expect([220]);
    let ehlo = await dialog.command('EHLO cloudssh', [250]);
    ehloLines = ehlo.lines;
    if (security === 'starttls') {
      await dialog.command('STARTTLS', [220]);
      socket.removeAllListeners('data');
      const upgraded = tlsConnect({ socket, servername: host });
      await socketOpened(upgraded);
      socket = upgraded;
      dialog = createSmtpDialog(socket);
      ehlo = await dialog.command('EHLO cloudssh', [250]);
      ehloLines = ehlo.lines;
    }
    const authLine = ehloLines.find((line) => /^AUTH\b/i.test(line)) || '';
    if (username && password) {
      if (/PLAIN/i.test(authLine)) {
        await dialog.command(`AUTH PLAIN ${Buffer.from(`\0${username}\0${password}`).toString('base64')}`, [235]);
      } else if (/LOGIN/i.test(authLine)) {
        await dialog.command('AUTH LOGIN', [334]);
        await dialog.command(Buffer.from(username).toString('base64'), [334]);
        await dialog.command(Buffer.from(password).toString('base64'), [235]);
      } else {
        throw new Error('SMTP server does not advertise PLAIN or LOGIN authentication');
      }
    }
    await dialog.command(`MAIL FROM:<${from}>`, [250]);
    await dialog.command(`RCPT TO:<${to}>`, [250, 251]);
    await dialog.command('DATA', [354]);
    const boundary = `cloudssh-${Date.now()}`;
    const message = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${boundary}@cloudssh>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(text),
      '.',
      '',
    ].join('\r\n');
    dialog.write(message);
    await dialog.expect([250]);
    dialog.write('QUIT\r\n');
    await dialog.expect([221], 5000).catch(() => {});
  } finally {
    socket?.destroy();
  }
}

async function sendToChannel(channel, { title, body }) {
  const { type, config } = channel;
  if (type === 'bark') {
    const base = config.url.replace(/\/+$/, '');
    const payload = { title, body, group: 'CloudSSH' };
    if (config.key) payload.device_key = config.key;
    const result = await fetchJson(`${base}/push`, payload);
    if (result.code !== undefined && result.code !== 200) throw new Error(result.message || `Bark error ${result.code}`);
    return true;
  }
  if (type === 'telegram') {
    const result = await fetchJson(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      chat_id: config.chat_id,
      text: `${title}\n${body}`,
      disable_web_page_preview: true,
    });
    if (result.ok !== true) throw new Error(result.description || 'Telegram send failed');
    return true;
  }
  if (type === 'webhook') {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, timestamp: Date.now() }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return true;
  }
  if (type === 'smtp') {
    await smtpSend({ ...config, subject: title, text: body });
    return true;
  }
  throw new Error(`Unknown channel type: ${type}`);
}

/** Returns [{id, type, ok, error?}] per channel; never throws. */
export async function sendToChannels(channels, message) {
  return await Promise.all(channels.map(async (channel) => {
    try {
      await sendToChannel(channel, message);
      return { id: channel.id, type: channel.type, ok: true };
    } catch (error) {
      return { id: channel.id, type: channel.type, ok: false, error: String(error?.message || error).slice(0, 300) };
    }
  }));
}
