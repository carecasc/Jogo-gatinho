/**
 * Tipos compartilhados entre servidor e cliente (o cliente importa só os tipos).
 * Este arquivo não pode ter código em tempo de execução.
 */
import type { FleetEntry, ShipKind } from './gameConfig.js';

export type { FleetEntry, ShipKind };

export interface Cell {
  x: number;
  y: number;
}

/** Posicionamento enviado pelo cliente. */
export interface Placement {
  kind: ShipKind;
  x: number;
  y: number;
  vertical: boolean;
}

/** Gato posicionado (com as casas e quais foram atingidas). */
export interface ShipView extends Placement {
  size: number;
  hits: Cell[];
  sunk: boolean;
}

export type MarkType = 'miss' | 'hit' | 'trap';

/** Marca visível numa casa de um tabuleiro. */
export interface Mark {
  x: number;
  y: number;
  type: MarkType;
  /** Tipo do gato atingido (para 'hit'). */
  ship?: ShipKind;
  /** Origem: ataque direto ou explosão de repelente. */
  source: 'shot' | 'blast';
}

export type Phase = 'waiting' | 'placing' | 'battle' | 'finished';
export type Side = 'me' | 'enemy';

export interface PublicConfig {
  boardSize: number;
  fleet: FleetEntry[];
  repellent: {
    enabled: boolean;
    maxActive: number | null;
    blastPattern: Array<[number, number]>;
  };
}

/** Visão personalizada do jogo enviada para cada jogador. */
export interface PlayerView {
  code: string;
  phase: Phase;
  config: PublicConfig;
  youReady: boolean;
  opponentJoined: boolean;
  opponentReady: boolean;
  opponentConnected: boolean;
  /** De quem é a vez (null fora da batalha). */
  turn: Side | null;
  /** Etapa do turno atual. */
  step: 'attack' | 'repellent' | null;
  /** Meus gatos (null antes de ficar pronto). */
  myShips: ShipView[] | null;
  /** Meus repelentes ativos (nunca enviados ao adversário). */
  myRepellents: Cell[];
  /** Marcas no meu tabuleiro (ataques recebidos e explosões). */
  myMarks: Mark[];
  /** Marcas no tabuleiro do adversário (resultados dos meus ataques). */
  enemyMarks: Mark[];
  /** Gatos do adversário já eliminados (revelados). No fim do jogo, todos. */
  enemyShips: ShipView[];
  /** Quantos gatos de cada lado ainda estão no jogo. */
  myRemaining: number;
  enemyRemaining: number;
  winner: Side | null;
  youWantRematch: boolean;
  opponentWantsRematch: boolean;
  /** O adversário saiu da partida (desistiu). */
  opponentLeft: boolean;
}

/** Eventos para animação/som, relativos a quem recebe. */
export type GameEvent =
  | {
      t: 'shot';
      /** Tabuleiro atingido. */
      side: Side;
      x: number;
      y: number;
      result: 'miss' | 'hit' | 'sunk' | 'trap';
      ship?: ShipKind;
      /** Gato eliminado (quando result === 'sunk'). */
      sunkShip?: ShipView;
    }
  | {
      t: 'blast';
      /** Tabuleiro onde estava o repelente. */
      trapSide: Side;
      x: number;
      y: number;
      /** Tabuleiro atingido pela explosão (o de quem atacou). */
      side: Side;
      cells: Array<{
        x: number;
        y: number;
        result: 'miss' | 'hit' | 'sunk' | 'ignored';
        ship?: ShipKind;
        sunkShip?: ShipView;
      }>;
    }
  | { t: 'repellent'; side: Side; cell?: Cell; replaced?: Cell }
  | { t: 'turn'; turn: Side }
  | { t: 'gameOver'; winner: Side }
  | { t: 'battleStart'; turn: Side };

export interface UpdatePayload {
  view: PlayerView;
  events: GameEvent[];
}

export type Ack<T = object> = (res: ({ ok: true } & T) | { ok: false; error: string }) => void;

export interface SessionInfo {
  code: string;
  playerId: string;
}

export interface ClientToServer {
  'room:create': (ack: Ack<SessionInfo>) => void;
  'room:join': (data: { code: string }, ack: Ack<SessionInfo>) => void;
  'room:resume': (data: SessionInfo, ack: Ack<SessionInfo>) => void;
  'room:leave': (ack?: Ack) => void;
  'game:ready': (data: { ships: Placement[] }, ack: Ack) => void;
  'game:unready': (ack: Ack) => void;
  'game:attack': (data: Cell, ack: Ack) => void;
  'game:repellent': (data: Cell, ack: Ack) => void;
  'game:rematch': (ack: Ack) => void;
}

export interface ServerToClient {
  update: (payload: UpdatePayload) => void;
  kicked: (data: { reason: string }) => void;
}
