import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../src/gameConfig.js';
import type { ClientToServer, Placement, ServerToClient, SessionInfo, UpdatePayload } from '../src/protocol.js';
import { createApp } from '../src/server.js';

type C = Socket<ServerToClient, ClientToServer>;

let server: ReturnType<typeof createApp>;
let url: string;
const clients: C[] = [];

beforeAll(async () => {
  server = createApp();
  await new Promise<void>((r) => server.httpServer.listen(0, r));
  url = `http://localhost:${(server.httpServer.address() as AddressInfo).port}`;
});
afterAll(async () => {
  clients.forEach((c) => c.close());
  await server.close();
});

/** Cliente que guarda todos os payloads recebidos. */
function client() {
  const socket: C = ioClient(url, { transports: ['websocket'], forceNew: true });
  clients.push(socket);
  const log: UpdatePayload[] = [];
  socket.on('update', (p) => log.push(p));
  const call = <T = object>(ev: string, ...args: unknown[]) =>
    new Promise<any>((resolve) => (socket.emit as any)(ev, ...args, (r: T) => resolve(r)));
  const last = () => log.at(-1)!;
  const waitFor = async (pred: (p: UpdatePayload) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const hit = log.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('timeout');
  };
  return { socket, log, call, last, waitFor };
}

const fleetA: Placement[] = GAME_CONFIG.fleet.map((f, i) => ({ kind: f.kind, x: 0, y: i * 2, vertical: false }));
const fleetB: Placement[] = GAME_CONFIG.fleet.map((f, i) => ({ kind: f.kind, x: 9 - i * 2, y: 0, vertical: true }));

describe('multiplayer', () => {
  it('cria sala, entra, joga e nunca vaza posições secretas', async () => {
    const a = client();
    const b = client();
    const created: { ok: true } & SessionInfo = await a.call('room:create');
    expect(created.ok).toBe(true);
    expect(created.code).toMatch(/^[A-Z]{4,5}$/);
    await a.waitFor((p) => p.view.phase === 'waiting');

    const joined = await b.call('room:join', { code: created.code.toLowerCase() });
    expect(joined.ok).toBe(true);
    await a.waitFor((p) => p.view.phase === 'placing' && p.view.opponentConnected);

    // sala cheia
    const c = client();
    expect(await c.call('room:join', { code: created.code })).toMatchObject({ ok: false });
    expect(await c.call('room:join', { code: 'ZZZZZ' })).toMatchObject({ ok: false });
    c.socket.close();

    expect((await a.call('game:ready', { ships: fleetA })).ok).toBe(true);
    expect((await b.call('game:ready', { ships: fleetB })).ok).toBe(true);
    const start = await a.waitFor((p) => p.view.phase === 'battle');
    expect(start.events[0]?.t).toBe('battleStart');

    // quem começa
    const [first, second] = start.view.turn === 'me' ? [a, b] : [b, a];
    expect((await second.call('game:attack', { x: 0, y: 0 })).ok).toBe(false);

    // ataque + repelente
    expect((await first.call('game:attack', { x: 5, y: 9 })).ok).toBe(true);
    expect((await first.call('game:attack', { x: 4, y: 9 })).ok).toBe(false); // falta o repelente
    const shipCell = first === a ? { x: 0, y: 0 } : { x: 9, y: 0 };
    expect((await first.call('game:repellent', shipCell)).ok).toBe(false); // casa com gato
    const emptyFor = first === a ? { x: 8, y: 9 } : { x: 0, y: 9 };
    expect((await first.call('game:repellent', emptyFor)).ok).toBe(true);
    await second.waitFor((p) => p.view.turn === 'me');

    // segundo jogador ataca exatamente o repelente => explosão
    const res = await second.call('game:attack', emptyFor);
    expect(res.ok).toBe(true);
    const blastSeen = await second.waitFor((p) => p.events.some((e) => e.t === 'blast'));
    const blast = blastSeen.events.find((e) => e.t === 'blast')!;
    expect(blast).toMatchObject({ side: 'me', trapSide: 'enemy' });
    const blastOther = await first.waitFor((p) => p.events.some((e) => e.t === 'blast'));
    expect(blastOther.events.find((e) => e.t === 'blast')).toMatchObject({ side: 'enemy', trapSide: 'me' });

    // Nenhum payload recebido por um jogador contém repelentes ou gatos vivos do outro.
    for (const [me, otherFleet] of [
      [a, fleetB],
      [b, fleetA],
    ] as const) {
      for (const p of me.log) {
        for (const s of p.view.enemyShips) expect(s.sunk || p.view.phase === 'finished').toBe(true);
        for (const e of p.events) {
          if (e.t === 'repellent' && e.side === 'enemy') expect(e.cell).toBeUndefined();
        }
      }
      const raw = JSON.stringify(me.log.map((p) => ({ ...p, view: { ...p.view, myShips: null, myRepellents: [] } })));
      // posições de gatos adversários não aparecem (além das marcas de acerto)
      expect(raw).not.toContain(JSON.stringify(otherFleet[0]).slice(1, -1));
    }
  });

  it('reconecta na mesma partida com o playerId', async () => {
    const a = client();
    const b = client();
    const created = await a.call('room:create');
    await b.call('room:join', { code: created.code });
    await a.call('game:ready', { ships: fleetA });

    b.socket.disconnect();
    await a.waitFor((p) => p.view.opponentJoined && !p.view.opponentConnected);

    const intruder = client();
    expect((await intruder.call('room:resume', { code: created.code, playerId: 'id-falso' })).ok).toBe(false);

    const a2 = client();
    const r2 = await a2.call('room:resume', { code: created.code, playerId: created.playerId });
    expect(r2.ok).toBe(true);
    const v = await a2.waitFor((p) => p.view.youReady);
    expect(v.view.myShips).toHaveLength(5);
    // a aba antiga foi desconectada da partida
    expect((await a.call('game:unready')).ok).toBe(false);
  });

  it('sair na preparação libera a vaga; sair na batalha é desistência', async () => {
    const a = client();
    const b = client();
    const created = await a.call('room:create');
    await b.call('room:join', { code: created.code });
    await b.call('game:ready', { ships: fleetB });
    expect((await b.call('room:leave')).ok).toBe(true);
    await a.waitFor((p) => p.view.phase === 'waiting' && !p.view.opponentJoined);

    // outra pessoa entra no lugar
    const c = client();
    expect((await c.call('room:join', { code: created.code })).ok).toBe(true);
    const placing = await c.waitFor((p) => p.view.phase === 'placing');
    expect(placing.view.youReady).toBe(false);
    await a.call('game:ready', { ships: fleetA });
    await c.call('game:ready', { ships: fleetB });
    await a.waitFor((p) => p.view.phase === 'battle');

    expect((await c.call('room:leave')).ok).toBe(true);
    const end = await a.waitFor((p) => p.view.phase === 'finished');
    expect(end.view.winner).toBe('me');
    expect(end.view.opponentLeft).toBe(true);
    expect(end.events).toContainEqual({ t: 'gameOver', winner: 'me' });
    expect((await a.call('game:rematch')).ok).toBe(false);
  });
});
