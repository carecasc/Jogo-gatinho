import { randomBytes, randomUUID } from 'node:crypto';
import { Game, GameError, toShipView, type AbsEvent, type PlayerIndex } from './game/game.js';
import { GAME_CONFIG, ROOM_CONFIG, type GameConfig } from './gameConfig.js';
import type { GameEvent, PlayerView, PublicConfig, Side } from './protocol.js';

// Sem letras ambíguas (I, L, O) para facilitar digitar no celular.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';

export interface Player {
  id: string;
  socketId: string | null;
}

export class Room {
  game: Game;
  players: [Player | null, Player | null] = [null, null];
  rematch: [boolean, boolean] = [false, false];
  /** Jogador saiu de vez (desistiu). */
  left: [boolean, boolean] = [false, false];
  lastActivity = Date.now();

  constructor(
    readonly code: string,
    readonly config: GameConfig,
  ) {
    this.game = new Game(config);
  }

  touch() {
    this.lastActivity = Date.now();
  }

  indexOf(playerId: string): PlayerIndex | -1 {
    if (this.players[0]?.id === playerId) return 0;
    if (this.players[1]?.id === playerId) return 1;
    return -1;
  }

  isFull() {
    return !!this.players[0] && !!this.players[1];
  }

  anyConnected() {
    return this.players.some((p) => p?.socketId);
  }

  /**
   * Jogador saiu da sala. Na preparação a vaga é liberada (outra pessoa pode entrar
   * com o mesmo código); na batalha conta como desistência.
   */
  leave(p: PlayerIndex): AbsEvent[] {
    const g = this.game;
    if (g.phase === 'placing') {
      this.players[p] = null;
      g.unready(p);
      return [];
    }
    this.left[p] = true;
    this.rematch = [false, false];
    return g.forfeit(p);
  }

  requestRematch(p: PlayerIndex): AbsEvent[] {
    if (this.game.phase !== 'finished') throw new GameError('A partida ainda não acabou.');
    if (this.left[p === 0 ? 1 : 0]) throw new GameError('O adversário saiu da sala.');
    this.rematch[p] = true;
    if (this.rematch[0] && this.rematch[1]) {
      this.game = new Game(this.config);
      this.rematch = [false, false];
    }
    return [];
  }

  publicConfig(): PublicConfig {
    const r = this.config.repellent;
    return {
      boardSize: this.config.boardSize,
      fleet: this.config.fleet,
      repellent: {
        enabled: r.enabled,
        maxActive: Number.isFinite(r.maxActive) ? r.maxActive : null,
        blastPattern: r.blastPattern,
      },
    };
  }

  /** Visão personalizada: nunca inclui gatos ou repelentes do adversário (exceto gatos eliminados / fim de jogo). */
  viewFor(p: PlayerIndex): PlayerView {
    const g = this.game;
    const o: PlayerIndex = p === 0 ? 1 : 0;
    const side = (i: PlayerIndex): Side => (i === p ? 'me' : 'enemy');
    const myBoard = g.boards[p];
    const enemyBoard = g.boards[o];
    const phase = !this.players[o] ? 'waiting' : g.phase;
    const enemyShips = (enemyBoard.ships ?? [])
      .filter((s) => g.phase === 'finished' || s.hits.size >= s.size)
      .map(toShipView);
    return {
      code: this.code,
      phase,
      config: this.publicConfig(),
      youReady: g.ready[p],
      opponentJoined: !!this.players[o],
      opponentReady: g.ready[o],
      opponentConnected: !!this.players[o]?.socketId,
      turn: g.phase === 'battle' ? side(g.turn) : null,
      step: g.phase === 'battle' ? g.step : null,
      myShips: myBoard.ships ? myBoard.ships.map(toShipView) : null,
      myRepellents: myBoard.repellents.map((c) => ({ ...c })),
      myMarks: [...myBoard.marks.values()],
      enemyMarks: [...enemyBoard.marks.values()],
      enemyShips,
      myRemaining: g.remaining(p),
      enemyRemaining: g.remaining(o),
      winner: g.winner === null ? null : side(g.winner),
      youWantRematch: this.rematch[p],
      opponentWantsRematch: this.rematch[o],
      opponentLeft: this.left[o],
    };
  }

  /** Converte eventos absolutos para a visão do jogador, escondendo o que ele não pode ver. */
  eventsFor(p: PlayerIndex, events: AbsEvent[]): GameEvent[] {
    const side = (i: PlayerIndex): Side => (i === p ? 'me' : 'enemy');
    return events.map((e): GameEvent => {
      switch (e.t) {
        case 'shot': {
          const { board, ...rest } = e;
          return { ...rest, side: side(board) };
        }
        case 'blast': {
          const { board, trapBoard, ...rest } = e;
          return { ...rest, side: side(board), trapSide: side(trapBoard) };
        }
        case 'repellent':
          // O adversário só fica sabendo que um repelente foi colocado, nunca onde.
          return e.board === p
            ? { t: 'repellent', side: 'me', cell: e.cell ?? undefined, replaced: e.replaced ?? undefined }
            : { t: 'repellent', side: 'enemy' };
        case 'turn':
          return { t: 'turn', turn: side(e.turn) };
        case 'battleStart':
          return { t: 'battleStart', turn: side(e.turn) };
        case 'gameOver':
          return { t: 'gameOver', winner: side(e.winner) };
      }
    });
  }
}

export class RoomManager {
  rooms = new Map<string, Room>();

  constructor(private readonly config: GameConfig = GAME_CONFIG) {}

  private newCode(): string {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const len = ROOM_CONFIG.codeLength + (attempt > 500 ? 1 : 0);
      const bytes = randomBytes(len);
      let code = '';
      for (let i = 0; i < len; i++) code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
      if (!this.rooms.has(code)) return code;
    }
    throw new GameError('Não foi possível criar a sala.');
  }

  create(): { room: Room; player: Player } {
    if (this.rooms.size >= ROOM_CONFIG.maxRooms) throw new GameError('Servidor cheio, tente mais tarde.');
    const room = new Room(this.newCode(), this.config);
    const player: Player = { id: randomUUID(), socketId: null };
    room.players[0] = player;
    this.rooms.set(room.code, room);
    return { room, player };
  }

  join(code: string): { room: Room; player: Player; index: PlayerIndex } {
    const room = this.get(code);
    if (!room) throw new GameError('Sala não encontrada.');
    if (room.isFull()) throw new GameError('A sala já está cheia.');
    const index: PlayerIndex = !room.players[0] ? 0 : 1;
    const player: Player = { id: randomUUID(), socketId: null };
    room.players[index] = player;
    room.touch();
    return { room, player, index };
  }

  get(code: unknown): Room | undefined {
    if (typeof code !== 'string') return undefined;
    return this.rooms.get(code.trim().toUpperCase());
  }

  /** Remove salas inativas. Retorna as salas removidas. */
  sweep(now = Date.now()): Room[] {
    const removed: Room[] = [];
    for (const room of this.rooms.values()) {
      const idle = now - room.lastActivity;
      if (idle > ROOM_CONFIG.idleTimeoutMs || (!room.anyConnected() && idle > ROOM_CONFIG.emptyTimeoutMs)) {
        this.rooms.delete(room.code);
        removed.push(room);
      }
    }
    return removed;
  }
}
