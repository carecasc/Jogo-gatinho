import express from 'express';
import { existsSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { GameError, type AbsEvent, type PlayerIndex } from './game/game.js';
import { ROOM_CONFIG } from './gameConfig.js';
import type { ClientToServer, ServerToClient } from './protocol.js';
import { Room, RoomManager } from './rooms.js';

interface SocketData {
  code?: string;
  index?: PlayerIndex;
}

type GameSocket = Socket<ClientToServer, ServerToClient, Record<string, never>, SocketData>;

export interface AppOptions {
  /** Pasta com o build do cliente (opcional). */
  staticDir?: string;
  manager?: RoomManager;
}

export function createApp({ staticDir, manager = new RoomManager() }: AppOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => {
    res.json({ ok: true, rooms: manager.rooms.size });
  });

  if (staticDir && existsSync(staticDir)) {
    app.use(
      express.static(staticDir, {
        index: 'index.html',
        setHeaders: (res, path) => {
          // Arquivos com hash no nome podem ficar em cache para sempre; o index.html nunca,
          // senão após um novo deploy o celular pediria assets que não existem mais.
          res.setHeader('Cache-Control', /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
        },
      }),
    );
    // SPA: links como /?sala=ABCD caem no index.html
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile('index.html', { root: staticDir });
    });
  }

  const httpServer: HttpServer = createServer(app);
  const io = new Server<ClientToServer, ServerToClient, Record<string, never>, SocketData>(httpServer, {
    pingInterval: 10_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 16_000,
    cors: process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN } : undefined,
  });

  /** Envia a visão atualizada (e eventos) para os dois jogadores da sala. */
  const broadcast = (room: Room, events: AbsEvent[] = []) => {
    room.players.forEach((pl, i) => {
      if (!pl?.socketId) return;
      const idx = i as PlayerIndex;
      io.to(pl.socketId).emit('update', { view: room.viewFor(idx), events: room.eventsFor(idx, events) });
    });
  };

  /** Liga o socket a um jogador, derrubando conexões antigas do mesmo jogador. */
  const attach = (socket: GameSocket, room: Room, index: PlayerIndex) => {
    detach(socket);
    const player = room.players[index]!;
    if (player.socketId && player.socketId !== socket.id) {
      const old = io.sockets.sockets.get(player.socketId);
      if (old) {
        old.data = {};
        old.emit('kicked', { reason: 'Você abriu o jogo em outra aba ou aparelho.' });
      }
    }
    player.socketId = socket.id;
    socket.data.code = room.code;
    socket.data.index = index;
    room.touch();
    broadcast(room);
  };

  /** Desliga o socket do jogador atual (sem tirá-lo da sala). */
  const detach = (socket: GameSocket) => {
    const { code, index } = socket.data;
    if (code === undefined || index === undefined) return;
    socket.data = {};
    const room = manager.get(code);
    const player = room?.players[index];
    if (room && player && player.socketId === socket.id) {
      player.socketId = null;
      broadcast(room);
    }
  };

  const current = (socket: GameSocket) => {
    const { code, index } = socket.data;
    const room = code ? manager.get(code) : undefined;
    if (!room || index === undefined || room.players[index]?.socketId !== socket.id) {
      throw new GameError('Você não está em uma sala.');
    }
    return { room, index };
  };

  /** Executa uma ação respondendo erros pelo ack. */
  const handle = <T extends object>(ack: unknown, fn: () => T) => {
    const reply = typeof ack === 'function' ? (ack as (r: unknown) => void) : () => {};
    try {
      reply({ ok: true, ...fn() });
    } catch (err) {
      if (err instanceof GameError) reply({ ok: false, error: err.message });
      else {
        console.error(err);
        reply({ ok: false, error: 'Erro interno.' });
      }
    }
  };

  /** Ação de jogo: executa, avisa os dois jogadores. */
  const gameAction = (socket: GameSocket, ack: unknown, fn: (room: Room, index: PlayerIndex) => AbsEvent[]) =>
    handle(ack, () => {
      const { room, index } = current(socket);
      const events = fn(room, index);
      room.touch();
      broadcast(room, events);
      return {};
    });

  io.on('connection', (socket: GameSocket) => {
    // Limite simples de taxa para evitar spam.
    let tokens = 20;
    const refill = setInterval(() => (tokens = Math.min(20, tokens + 5)), 1000);
    socket.on('error', () => {});
    socket.use((_packet, next) => {
      if (tokens-- <= 0) return next(new Error('Muitas ações, devagar!'));
      next();
    });

    socket.on('room:create', (ack) =>
      handle(ack, () => {
        const { room, player } = manager.create();
        attach(socket, room, 0);
        return { code: room.code, playerId: player.id };
      }),
    );

    socket.on('room:join', (data, ack) =>
      handle(ack, () => {
        const { room, player, index } = manager.join(String(data?.code ?? ''));
        attach(socket, room, index);
        return { code: room.code, playerId: player.id };
      }),
    );

    socket.on('room:resume', (data, ack) =>
      handle(ack, () => {
        const room = manager.get(data?.code);
        const index = room && typeof data?.playerId === 'string' ? room.indexOf(data.playerId) : -1;
        if (!room || index < 0) throw new GameError('A partida não existe mais.');
        attach(socket, room, index as PlayerIndex);
        return { code: room.code, playerId: data.playerId };
      }),
    );

    socket.on('room:leave', (ack) =>
      handle(ack, () => {
        const { code, index } = socket.data;
        const room = code ? manager.get(code) : undefined;
        if (!room || index === undefined || room.players[index]?.socketId !== socket.id) return {};
        socket.data = {};
        room.players[index]!.socketId = null;
        const events = room.leave(index);
        room.touch();
        if (!room.players[0] && !room.players[1]) manager.rooms.delete(room.code);
        else broadcast(room, events);
        return {};
      }),
    );

    socket.on('game:ready', (data, ack) =>
      gameAction(socket, ack, (room, i) => {
        if (!room.isFull()) throw new GameError('Aguarde o oponente entrar.');
        return room.game.setReady(i, data?.ships);
      }),
    );
    socket.on('game:unready', (ack) => gameAction(socket, ack, (room, i) => (room.game.unready(i), [])));
    socket.on('game:attack', (data, ack) => gameAction(socket, ack, (room, i) => room.game.attack(i, data?.x, data?.y)));
    socket.on('game:repellent', (data, ack) =>
      gameAction(socket, ack, (room, i) => room.game.placeRepellent(i, data?.x, data?.y)),
    );
    socket.on('game:rematch', (ack) => gameAction(socket, ack, (room, i) => room.requestRematch(i)));

    socket.on('disconnect', () => {
      clearInterval(refill);
      detach(socket);
    });
  });

  const sweeper = setInterval(() => {
    for (const room of manager.sweep()) {
      for (const p of room.players) {
        if (p?.socketId) io.to(p.socketId).emit('kicked', { reason: 'A sala expirou por inatividade.' });
      }
    }
  }, ROOM_CONFIG.sweepIntervalMs);
  sweeper.unref();

  return {
    app,
    httpServer,
    io,
    manager,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweeper);
        io.close(() => resolve());
      }),
  };
}
