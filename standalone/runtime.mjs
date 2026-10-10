import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export class SQLiteStorage {
  constructor(file) {
    this.database = new DatabaseSync(file);
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.sql = { exec: (sql, ...params) => {
      let rows = [];
      // Schema creation contains multiple statements; ordinary queries use bindings.
      if (params.length === 0 && sql.trim().replace(/;$/, '').includes(';')) {
        this.database.exec(sql);
      } else {
        const statement = this.database.prepare(sql);
        if (statement.columns().length) rows = statement.all(...params);
        else statement.run(...params);
      }
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error('Expected exactly one SQLite row');
          return rows[0];
        },
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    } };
    this.database.exec('CREATE TABLE IF NOT EXISTS _runtime_alarm (id INTEGER PRIMARY KEY, due INTEGER)');
  }
  transactionSync(callback) {
    this.database.exec('SAVEPOINT runtime_transaction');
    try {
      const result = callback();
      this.database.exec('RELEASE runtime_transaction');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK TO runtime_transaction; RELEASE runtime_transaction');
      throw error;
    }
  }
  async setAlarm(due) {
    this.database.prepare('INSERT OR REPLACE INTO _runtime_alarm VALUES (1, ?)').run(Number(due));
    this.scheduleAlarm();
  }
  async deleteAlarm() {
    clearTimeout(this.alarmTimer);
    this.database.exec('DELETE FROM _runtime_alarm');
  }
  scheduleAlarm() {
    clearTimeout(this.alarmTimer);
    const alarm = this.database.prepare('SELECT due FROM _runtime_alarm WHERE id=1').get();
    if (!alarm || !this.onAlarm) return;
    this.alarmTimer = setTimeout(async () => {
      this.database.exec('DELETE FROM _runtime_alarm');
      try { await this.onAlarm(); } catch { console.error('Durable object alarm failed'); }
    }, Math.max(0, Math.min(alarm.due - Date.now(), 2147483647)));
    this.alarmTimer.unref();
  }
  close() { clearTimeout(this.alarmTimer); this.database.close(); }
}

class PairedSocket extends EventTarget {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 1;
  queue = [];
  send(data) {
    if (this.readyState !== 1) throw new Error('WebSocket is closed');
    if (this.peer.network) this.peer.network.send(data);
    else if (this.peer.handler) this.peer.handler(data);
    else this.peer.queue.push(data);
  }
  accept() {}
  serializeAttachment(value) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = this.peer.readyState = 3;
    const safeCode = code === 1005 || code === 1006 ? 1000 : code;
    this.network?.close(safeCode, reason);
    this.peer.network?.close(safeCode, reason);
    this.onClose?.(safeCode, reason);
    this.peer.onClose?.(safeCode, reason);
  }
  receive(data) {
    this.dispatchEvent(new MessageEvent('message', { data }));
    this.handler?.(data);
  }
  attach(network) {
    this.network = network;
    for (const data of this.queue.splice(0)) network.send(data);
    network.on('message', (data, binary) => {
      this.peer.receive(binary ? new Uint8Array(data).buffer : data.toString());
    });
    network.on('close', (code, reason) => this.close(code, reason.toString()));
    network.on('error', () => this.peer.onError?.());
  }
}

export function installWorkerGlobals() {
  const NativeResponse = globalThis.Response;
  globalThis.Response = class extends NativeResponse {
    constructor(body, init = {}) {
      super(body, init.status === 101 ? { ...init, status: 200 } : init);
      if (init.status === 101) Object.defineProperty(this, 'status', { value: 101 });
      if (init.webSocket) this.webSocket = init.webSocket;
    }
  };
  globalThis.WebSocketPair = class {
    constructor() {
      this[0] = new PairedSocket();
      this[1] = new PairedSocket();
      this[0].peer = this[1]; this[1].peer = this[0];
    }
  };
  globalThis.WebSocket = PairedSocket;
}

export class LocalNamespace {
  instances = new Map();
  constructor(name, Class, env, dataDir) {
    this.name = name; this.Class = Class; this.env = env; this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    if (name === 'ssh') {
      this.cleanupTimer = setInterval(() => {
        for (const [id, { object, storage, sockets }] of this.instances) {
          if (!sockets.size && !object.hasActiveConnections()) {
            storage.close(); this.instances.delete(id);
          }
        }
      }, 30000);
      this.cleanupTimer.unref();
    }
  }
  idFromName(name) { return String(name); }
  get(id) {
    id = String(id);
    if (!this.instances.has(id)) {
      if (this.name === 'ssh' && this.instances.size >= 256) throw new Error('Maximum SSH sessions reached');
      const hash = createHash('sha256').update(id).digest('hex');
      const storage = new SQLiteStorage(this.name === 'ssh' ? ':memory:' : join(this.dataDir, `${this.name}-${hash}.sqlite`));
      let object;
      const sockets = new Set();
      const state = {
        storage,
        waitUntil: (promise) => void promise.catch(() => console.error('Background operation failed')),
        acceptWebSocket: (ws) => {
          sockets.add(ws);
          // Serialize frames as Durable Objects do; never race SSH packet parsing.
          let pending = Promise.resolve();
          ws.handler = (data) => {
            if (typeof data === 'string') {
              try {
                if (['agent_confirm', 'agent_stop', 'agent_reset'].includes(JSON.parse(data).type)) {
                  void object.webSocketMessage(ws, data); return;
                }
              } catch { /* Normal terminal frames use the serialized queue. */ }
            }
            pending = pending.then(() => object.webSocketMessage(ws, data)).catch(() => {
              console.error('WebSocket operation failed'); ws.close(1011);
            });
          };
          ws.onClose = (code, reason) => {
            sockets.delete(ws);
            void object.webSocketClose?.(ws, code, reason, true);
          };
          ws.onError = () => void object.webSocketError?.(ws, new Error('WebSocket error'));
        },
        getWebSockets: () => [...sockets],
      };
      object = new this.Class(state, this.env);
      storage.onAlarm = () => object.alarm?.();
      storage.scheduleAlarm();
      this.instances.set(id, { object, storage, sockets });
    }
    return this.instances.get(id).object;
  }
  close() {
    clearInterval(this.cleanupTimer);
    for (const { storage, sockets } of this.instances.values()) {
      for (const socket of sockets) socket.close(1001, 'Service shutting down');
      storage.close();
    }
  }
}
