/**
 * Lógica pura do jogo (sem rede). Toda regra é validada aqui.
 * Eventos são gerados com índices absolutos de jogador (0/1) e depois
 * convertidos para a visão de cada jogador pela sala.
 */
import type { GameConfig, ShipKind } from '../gameConfig.js';
import type { Cell, Mark, Placement, ShipView } from '../protocol.js';

export type PlayerIndex = 0 | 1;

export class GameError extends Error {}

export interface Ship {
  kind: ShipKind;
  x: number;
  y: number;
  vertical: boolean;
  size: number;
  cells: Cell[];
  hits: Set<string>;
}

export interface Board {
  ships: Ship[] | null;
  /** Repelentes ativos, do mais antigo para o mais novo. */
  repellents: Cell[];
  /** Marcas por chave "x,y". */
  marks: Map<string, Mark>;
}

export type AbsEvent =
  | {
      t: 'shot';
      board: PlayerIndex;
      x: number;
      y: number;
      result: 'miss' | 'hit' | 'sunk' | 'trap';
      ship?: ShipKind;
      sunkShip?: ShipView;
    }
  | {
      t: 'blast';
      trapBoard: PlayerIndex;
      x: number;
      y: number;
      board: PlayerIndex;
      cells: Array<{
        x: number;
        y: number;
        result: 'miss' | 'hit' | 'sunk' | 'ignored';
        ship?: ShipKind;
        sunkShip?: ShipView;
      }>;
    }
  | { t: 'repellent'; board: PlayerIndex; cell: Cell | null; replaced: Cell | null }
  | { t: 'turn'; turn: PlayerIndex }
  | { t: 'gameOver'; winner: PlayerIndex }
  | { t: 'battleStart'; turn: PlayerIndex };

export type GamePhase = 'placing' | 'battle' | 'finished';

export const key = (x: number, y: number) => `${x},${y}`;
const other = (p: PlayerIndex): PlayerIndex => (p === 0 ? 1 : 0);

export function shipCells(p: { x: number; y: number; vertical: boolean }, size: number): Cell[] {
  const cells: Cell[] = [];
  for (let i = 0; i < size; i++) {
    cells.push(p.vertical ? { x: p.x, y: p.y + i } : { x: p.x + i, y: p.y });
  }
  return cells;
}

export function toShipView(s: Ship): ShipView {
  return {
    kind: s.kind,
    x: s.x,
    y: s.y,
    vertical: s.vertical,
    size: s.size,
    hits: [...s.hits].map((k) => {
      const [x, y] = k.split(',').map(Number);
      return { x: x!, y: y! };
    }),
    sunk: s.hits.size >= s.size,
  };
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

export class Game {
  phase: GamePhase = 'placing';
  boards: [Board, Board] = [newBoard(), newBoard()];
  ready: [boolean, boolean] = [false, false];
  turn: PlayerIndex = 0;
  step: 'attack' | 'repellent' = 'attack';
  winner: PlayerIndex | null = null;

  constructor(
    readonly config: GameConfig,
    private readonly rng: () => number = Math.random,
  ) {}

  inBounds(x: number, y: number) {
    const n = this.config.boardSize;
    return isInt(x) && isInt(y) && x >= 0 && y >= 0 && x < n && y < n;
  }

  /** Valida e grava a frota de um jogador, marcando-o como pronto. */
  setReady(p: PlayerIndex, placements: unknown): AbsEvent[] {
    if (this.phase !== 'placing') throw new GameError('Não é a fase de preparação.');
    if (this.ready[p]) throw new GameError('Você já está pronto.');
    const ships = this.validateFleet(placements);
    this.boards[p].ships = ships;
    this.ready[p] = true;
    if (this.ready[0] && this.ready[1]) {
      this.phase = 'battle';
      this.turn = this.rng() < 0.5 ? 0 : 1;
      this.step = 'attack';
      return [{ t: 'battleStart', turn: this.turn }];
    }
    return [];
  }

  unready(p: PlayerIndex) {
    if (this.phase !== 'placing') throw new GameError('A batalha já começou.');
    this.ready[p] = false;
    this.boards[p].ships = null;
  }

  /** Jogador desistiu (saiu da partida): o outro vence. */
  forfeit(p: PlayerIndex): AbsEvent[] {
    if (this.phase !== 'battle') return [];
    this.winner = other(p);
    this.phase = 'finished';
    return [{ t: 'gameOver', winner: this.winner }];
  }

  validateFleet(placements: unknown): Ship[] {
    if (!Array.isArray(placements)) throw new GameError('Posicionamento inválido.');
    const fleet = this.config.fleet;
    if (placements.length !== fleet.length) throw new GameError('Posicione todos os gatinhos.');
    const remaining = fleet.map((f) => f.kind);
    const occupied = new Set<string>();
    const ships: Ship[] = [];
    for (const raw of placements as Placement[]) {
      if (!raw || typeof raw !== 'object') throw new GameError('Posicionamento inválido.');
      const { kind, x, y, vertical } = raw;
      const idx = remaining.indexOf(kind);
      if (idx < 0) throw new GameError('Gatinho desconhecido ou repetido.');
      remaining.splice(idx, 1);
      if (typeof vertical !== 'boolean') throw new GameError('Orientação inválida.');
      const entry = fleet.find((f) => f.kind === kind)!;
      const cells = shipCells({ x, y, vertical }, entry.size);
      for (const c of cells) {
        if (!this.inBounds(c.x, c.y)) throw new GameError('Gatinho fora do tabuleiro.');
        const k = key(c.x, c.y);
        if (occupied.has(k)) throw new GameError('Gatinhos sobrepostos.');
        occupied.add(k);
      }
      ships.push({ kind, x, y, vertical, size: entry.size, cells, hits: new Set() });
    }
    return ships;
  }

  shipAt(board: Board, x: number, y: number): Ship | undefined {
    return board.ships?.find((s) => s.cells.some((c) => c.x === x && c.y === y));
  }

  repellentIndex(board: Board, x: number, y: number) {
    return board.repellents.findIndex((c) => c.x === x && c.y === y);
  }

  /** Casa vazia: sem gato, sem repelente e ainda não atingida. */
  isEmptyCell(board: Board, x: number, y: number) {
    return (
      !this.shipAt(board, x, y) &&
      this.repellentIndex(board, x, y) < 0 &&
      !board.marks.has(key(x, y))
    );
  }

  hasEmptyCell(board: Board) {
    const n = this.config.boardSize;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (this.isEmptyCell(board, x, y)) return true;
    return false;
  }

  allSunk(board: Board) {
    return !!board.ships && board.ships.every((s) => s.hits.size >= s.size);
  }

  remaining(p: PlayerIndex) {
    return this.boards[p].ships?.filter((s) => s.hits.size < s.size).length ?? this.config.fleet.length;
  }

  private assertTurn(p: PlayerIndex, step: 'attack' | 'repellent') {
    if (this.phase !== 'battle') throw new GameError('A batalha não está em andamento.');
    if (this.turn !== p) throw new GameError('Não é a sua vez.');
    if (this.step !== step) {
      throw new GameError(step === 'attack' ? 'Coloque um repelente primeiro.' : 'Ataque primeiro.');
    }
  }

  /** Aplica dano a uma casa de um tabuleiro. */
  private hitCell(board: Board, x: number, y: number, source: 'shot' | 'blast') {
    const ship = this.shipAt(board, x, y);
    if (ship) {
      ship.hits.add(key(x, y));
      board.marks.set(key(x, y), { x, y, type: 'hit', ship: ship.kind, source });
      const sunk = ship.hits.size >= ship.size;
      return { result: sunk ? ('sunk' as const) : ('hit' as const), ship: ship.kind, sunkShip: sunk ? toShipView(ship) : undefined };
    }
    board.marks.set(key(x, y), { x, y, type: 'miss', source });
    return { result: 'miss' as const };
  }

  /** Explosão de repelente: atinge o tabuleiro `targetIdx` em volta de (x, y). */
  private blast(trapIdx: PlayerIndex, targetIdx: PlayerIndex, x: number, y: number, depth: number): AbsEvent[] {
    const cfg = this.config.repellent;
    const target = this.boards[targetIdx];
    const events: AbsEvent[] = [];
    const blastEvent: Extract<AbsEvent, { t: 'blast' }> = { t: 'blast', trapBoard: trapIdx, x, y, board: targetIdx, cells: [] };
    events.push(blastEvent);
    const chained: Cell[] = [];
    for (const [dx, dy] of cfg.blastPattern) {
      const cx = x + dx;
      const cy = y + dy;
      if (!this.inBounds(cx, cy)) continue;
      if (target.marks.has(key(cx, cy))) {
        blastEvent.cells.push({ x: cx, y: cy, result: 'ignored' });
        continue;
      }
      const rIdx = this.repellentIndex(target, cx, cy);
      if (rIdx >= 0) {
        if (cfg.chainReaction && depth < 1) {
          target.repellents.splice(rIdx, 1);
          target.marks.set(key(cx, cy), { x: cx, y: cy, type: 'trap', source: 'blast' });
          blastEvent.cells.push({ x: cx, y: cy, result: 'ignored' });
          chained.push({ x: cx, y: cy });
        } else {
          blastEvent.cells.push({ x: cx, y: cy, result: 'ignored' });
        }
        continue;
      }
      blastEvent.cells.push({ x: cx, y: cy, ...this.hitCell(target, cx, cy, 'blast') });
    }
    for (const c of chained) events.push(...this.blast(targetIdx, trapIdx, c.x, c.y, depth + 1));
    return events;
  }

  attack(p: PlayerIndex, x: unknown, y: unknown): AbsEvent[] {
    this.assertTurn(p, 'attack');
    if (!isInt(x) || !isInt(y) || !this.inBounds(x, y)) throw new GameError('Casa inválida.');
    const defIdx = other(p);
    const def = this.boards[defIdx];
    if (def.marks.has(key(x, y))) throw new GameError('Essa casa já foi atacada.');

    const events: AbsEvent[] = [];
    const rIdx = this.repellentIndex(def, x, y);
    if (this.config.repellent.enabled && rIdx >= 0) {
      def.repellents.splice(rIdx, 1);
      def.marks.set(key(x, y), { x, y, type: 'trap', source: 'shot' });
      events.push({ t: 'shot', board: defIdx, x, y, result: 'trap' });
      events.push(...this.blast(defIdx, p, x, y, 0));
    } else {
      const r = this.hitCell(def, x, y, 'shot');
      events.push({ t: 'shot', board: defIdx, x, y, ...r });
    }

    // Vitória: quem atacou pode vencer pelo ataque ou perder pela explosão.
    const defLost = this.allSunk(def);
    const atkLost = this.allSunk(this.boards[p]);
    if (defLost || atkLost) {
      // Em caso de reação em cadeia eliminar os dois lados, o atacante vence
      // (ele fez a jogada que eliminou o último gato adversário).
      this.winner = defLost ? p : defIdx;
      this.phase = 'finished';
      events.push({ t: 'gameOver', winner: this.winner });
      return events;
    }

    const rep = this.config.repellent;
    const atkBoard = this.boards[p];
    const atLimit = atkBoard.repellents.length >= rep.maxActive;
    if (!rep.enabled || rep.maxActive <= 0 || (atLimit && rep.whenLimitReached === 'skip') || !this.hasEmptyCell(atkBoard)) {
      events.push(...this.endTurn());
    } else {
      this.step = 'repellent';
    }
    return events;
  }

  placeRepellent(p: PlayerIndex, x: unknown, y: unknown): AbsEvent[] {
    this.assertTurn(p, 'repellent');
    if (!isInt(x) || !isInt(y) || !this.inBounds(x, y)) throw new GameError('Casa inválida.');
    const board = this.boards[p];
    if (!this.isEmptyCell(board, x, y)) throw new GameError('Escolha uma casa vazia do seu tabuleiro.');
    let replaced: Cell | null = null;
    if (board.repellents.length >= this.config.repellent.maxActive) {
      replaced = board.repellents.shift() ?? null;
    }
    board.repellents.push({ x, y });
    return [{ t: 'repellent', board: p, cell: { x, y }, replaced }, ...this.endTurn()];
  }

  private endTurn(): AbsEvent[] {
    this.turn = other(this.turn);
    this.step = 'attack';
    return [{ t: 'turn', turn: this.turn }];
  }
}

function newBoard(): Board {
  return { ships: null, repellents: [], marks: new Map() };
}
