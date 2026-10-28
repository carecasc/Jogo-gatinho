/**
 * Configuração ajustável do jogo "Batalha dos Gatinhos".
 *
 * Edite este arquivo para mudar as regras. O servidor envia as partes
 * públicas desta configuração para os clientes, então a interface se
 * adapta automaticamente (tamanho do tabuleiro, frota etc.).
 */

export type ShipKind = 'gordo' | 'siames' | 'malhado' | 'preto' | 'filhote';

export interface FleetEntry {
  kind: ShipKind;
  name: string;
  size: number;
}

/** Política quando o jogador já tem o máximo de repelentes ativos. */
export type RepellentLimitPolicy =
  /** Remove o repelente mais antigo e coloca o novo. */
  | 'replaceOldest'
  /** Não coloca repelente nesse turno (o turno passa automaticamente). */
  | 'skip';

export interface RepellentConfig {
  /** Liga/desliga a mecânica de repelente. */
  enabled: boolean;
  /**
   * Casas atingidas no tabuleiro de quem atacou, relativas à coordenada do ataque.
   * [dx, dy] — dx = coluna, dy = linha. Padrão: cruz ortogonal (sem o centro).
   * Para incluir o centro, adicione [0, 0]. Para uma cruz maior, adicione
   * [0, -2], [0, 2], [-2, 0], [2, 0] etc. Casas fora do tabuleiro são ignoradas.
   */
  blastPattern: Array<[number, number]>;
  /** Máximo de repelentes ativos ao mesmo tempo por jogador (Infinity = sem limite). */
  maxActive: number;
  /** O que fazer quando o limite de repelentes ativos for atingido. */
  whenLimitReached: RepellentLimitPolicy;
  /**
   * Se a explosão atingir uma casa com repelente de quem atacou:
   * true = esse repelente também explode (reação em cadeia, 1 nível),
   * false = a casa é ignorada e o repelente continua lá.
   */
  chainReaction: boolean;
}

export interface GameConfig {
  boardSize: number;
  fleet: FleetEntry[];
  repellent: RepellentConfig;
}

export const GAME_CONFIG: GameConfig = {
  boardSize: 10,
  fleet: [
    { kind: 'gordo', name: 'Gato Gordo', size: 5 },
    { kind: 'siames', name: 'Gato Siamês', size: 4 },
    { kind: 'malhado', name: 'Gato Malhado', size: 3 },
    { kind: 'preto', name: 'Gato Preto', size: 3 },
    { kind: 'filhote', name: 'Filhote', size: 2 },
  ],
  repellent: {
    enabled: true,
    blastPattern: [
      [0, -1], // cima
      [0, 1], // baixo
      [-1, 0], // esquerda
      [1, 0], // direita
    ],
    maxActive: 3,
    whenLimitReached: 'replaceOldest',
    chainReaction: false,
  },
};

/** Configuração das salas (servidor). */
export const ROOM_CONFIG = {
  /** Tamanho do código da sala. */
  codeLength: 4,
  /** Sala expira após esse tempo sem nenhuma ação (ms). */
  idleTimeoutMs: 30 * 60 * 1000,
  /** Sala expira mais rápido se ninguém estiver conectado (ms). */
  emptyTimeoutMs: 10 * 60 * 1000,
  /** Intervalo de varredura de salas expiradas (ms). */
  sweepIntervalMs: 60 * 1000,
  /** Limite de salas simultâneas (proteção simples). */
  maxRooms: 2000,
};
