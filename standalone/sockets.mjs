import { connect as netConnect } from 'node:net';
import { Readable, Writable } from 'node:stream';

/** Cloudflare's TCP stream shape, backed by Node sockets and backpressure. */
export function connect({ hostname, port }) {
  const socket = netConnect({ host: hostname.replace(/^\[|\]$/g, ''), port });
  socket.setNoDelay(true);
  const timer = setTimeout(() => socket.destroy(new Error('TCP connection timed out')), 15000);
  const opened = new Promise((resolve, reject) => {
    socket.once('connect', () => { clearTimeout(timer); resolve({}); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  const closed = new Promise((resolve) => socket.once('close', resolve));
  // Callers may close a failed connection before they await opened.
  void opened.catch(() => {});
  return {
    opened, closed,
    readable: Readable.toWeb(socket),
    writable: Writable.toWeb(socket),
    close: () => { clearTimeout(timer); socket.destroy(); },
  };
}
