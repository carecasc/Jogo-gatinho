import { io, type Socket } from 'socket.io-client';
import type { ClientToServer, ServerToClient, SessionInfo, UpdatePayload } from '../../server/src/protocol';

const SESSION_KEY = 'gatinhos.session';

type Res<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export class Net {
  readonly socket: Socket<ServerToClient, ClientToServer>;
  session: SessionInfo | null = loadSession();
  onUpdate: (p: UpdatePayload) => void = () => {};
  onStatus: (connected: boolean) => void = () => {};
  onLost: (reason: string) => void = () => {};

  constructor() {
    this.socket = io({ transports: ['websocket', 'polling'], reconnectionDelayMax: 3000 });
    this.socket.on('connect', () => {
      this.onStatus(true);
      void this.resume();
    });
    this.socket.on('disconnect', () => this.onStatus(false));
    this.socket.on('update', (p) => this.onUpdate(p));
    this.socket.on('kicked', ({ reason }) => {
      this.setSession(null);
      this.onLost(reason);
    });
    // Ao voltar do bloqueio de tela, força uma reconexão rápida.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !this.socket.connected) this.socket.connect();
    });
    window.addEventListener('online', () => {
      if (!this.socket.connected) this.socket.connect();
    });
  }

  get connected() {
    return this.socket.connected;
  }

  setSession(s: SessionInfo | null) {
    this.session = s;
    for (const store of ['sessionStorage', 'localStorage'] as const) {
      try {
        if (s) window[store].setItem(SESSION_KEY, JSON.stringify(s));
        else window[store].removeItem(SESSION_KEY);
      } catch {
        /* storage indisponível (modo privado etc.) */
      }
    }
  }

  private async resume() {
    if (!this.session) return;
    const res = await this.call<SessionInfo>('room:resume', this.session);
    if (!res.ok) {
      this.setSession(null);
      this.onLost(res.error);
    }
  }

  /** Emite um evento esperando o ack (com timeout). */
  call<T = object>(event: keyof ClientToServer, ...args: unknown[]): Promise<Res<T>> {
    return new Promise((resolve) => {
      if (!this.socket.connected) {
        resolve({ ok: false, error: 'Sem conexão. Tentando reconectar…' });
        return;
      }
      (this.socket.timeout(8000).emit as any)(event, ...args, (err: unknown, res: Res<T>) => {
        if (err) resolve({ ok: false, error: 'O servidor não respondeu. Tente de novo.' });
        else resolve(res);
      });
    });
  }

  async createRoom() {
    const res = await this.call<SessionInfo>('room:create');
    if (res.ok) this.setSession({ code: res.code, playerId: res.playerId });
    return res;
  }

  async joinRoom(code: string) {
    const res = await this.call<SessionInfo>('room:join', { code });
    if (res.ok) this.setSession({ code: res.code, playerId: res.playerId });
    return res;
  }

  async leave() {
    await this.call('room:leave');
    this.setSession(null);
  }
}

/**
 * A sessão fica no sessionStorage (por aba: duas abas no mesmo navegador são dois
 * jogadores diferentes) e, como reserva, no localStorage — usado só quando a aba é
 * nova e não veio de um link de convite (ex.: o navegador do celular fechou a aba).
 */
function loadSession(): SessionInfo | null {
  const read = (store: 'sessionStorage' | 'localStorage') => {
    try {
      const s = JSON.parse(window[store].getItem(SESSION_KEY) ?? 'null');
      return typeof s?.code === 'string' && typeof s?.playerId === 'string' ? (s as SessionInfo) : null;
    } catch {
      return null;
    }
  };
  const own = read('sessionStorage');
  if (own) return own;
  if (new URLSearchParams(location.search).has('sala')) return null;
  return read('localStorage');
}
