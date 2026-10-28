import { describe, expect, it } from 'vitest';
import { Game, GameError, type AbsEvent } from '../src/game/game.js';
import { GAME_CONFIG, type GameConfig } from '../src/gameConfig.js';
import type { Placement } from '../src/protocol.js';

/** Frota padrão: cada gato numa linha, começando na coluna 0. */
const rowsFleet = (rows = [0, 2, 4, 6, 8]): Placement[] =>
  GAME_CONFIG.fleet.map((f, i) => ({ kind: f.kind, x: 0, y: rows[i]!, vertical: false }));

function cfg(overrides: Partial<GameConfig['repellent']> = {}): GameConfig {
  return { ...GAME_CONFIG, repellent: { ...GAME_CONFIG.repellent, ...overrides } };
}

/** Jogo já em batalha com o jogador 0 começando. */
function battle(config = cfg(), f0 = rowsFleet(), f1 = rowsFleet()) {
  const g = new Game(config, () => 0); // rng 0 => jogador 0 começa
  g.setReady(0, f0);
  g.setReady(1, f1);
  expect(g.phase).toBe('battle');
  expect(g.turn).toBe(0);
  return g;
}

const types = (ev: AbsEvent[]) => ev.map((e) => e.t);

describe('preparação', () => {
  it('aceita frota válida e inicia batalha quando ambos estão prontos', () => {
    const g = new Game(GAME_CONFIG, () => 0.9);
    expect(g.setReady(0, rowsFleet())).toEqual([]);
    const ev = g.setReady(1, rowsFleet());
    expect(ev).toEqual([{ t: 'battleStart', turn: 1 }]);
    expect(g.phase).toBe('battle');
  });

  it('rejeita gatos fora do tabuleiro', () => {
    const g = new Game(GAME_CONFIG);
    const fleet = rowsFleet();
    fleet[0] = { ...fleet[0]!, x: 6 }; // tamanho 5 a partir da coluna 6 => sai
    expect(() => g.setReady(0, fleet)).toThrow(GameError);
  });

  it('rejeita sobreposição', () => {
    const g = new Game(GAME_CONFIG);
    const fleet = rowsFleet();
    fleet[1] = { ...fleet[1]!, x: 0, y: 0, vertical: true }; // cruza o gordo em (0,0)
    expect(() => g.setReady(0, fleet)).toThrow(/sobrepostos/);
  });

  it('rejeita frota incompleta, repetida ou malformada', () => {
    const g = new Game(GAME_CONFIG);
    expect(() => g.setReady(0, rowsFleet().slice(1))).toThrow(GameError);
    const dup = rowsFleet();
    dup[4] = { ...dup[4]!, kind: 'gordo' };
    expect(() => g.setReady(0, dup)).toThrow(GameError);
    expect(() => g.setReady(0, 'oi')).toThrow(GameError);
    expect(() => g.setReady(0, [null, 1, 2, 3, 4])).toThrow(GameError);
    const bad = rowsFleet();
    (bad[0] as any).x = 1.5;
    expect(() => g.setReady(0, bad)).toThrow(GameError);
  });

  it('aceita gatos na vertical', () => {
    const g = new Game(GAME_CONFIG);
    const fleet = GAME_CONFIG.fleet.map((f, i) => ({ kind: f.kind, x: i * 2, y: 0, vertical: true }));
    g.setReady(0, fleet);
    expect(g.boards[0].ships![0]!.cells.at(-1)).toEqual({ x: 0, y: 4 });
  });

  it('permite desfazer o pronto', () => {
    const g = new Game(GAME_CONFIG);
    g.setReady(0, rowsFleet());
    g.unready(0);
    expect(g.ready[0]).toBe(false);
    g.setReady(0, rowsFleet());
  });
});

describe('turno e ataque', () => {
  it('erro na água vira miss e exige repelente', () => {
    const g = battle();
    const ev = g.attack(0, 9, 9);
    expect(ev).toEqual([{ t: 'shot', board: 1, x: 9, y: 9, result: 'miss' }]);
    expect(g.step).toBe('repellent');
    expect(g.turn).toBe(0);
  });

  it('acerto informa o tipo do gato', () => {
    const g = battle();
    const ev = g.attack(0, 0, 2);
    expect(ev[0]).toMatchObject({ t: 'shot', result: 'hit', ship: 'siames' });
  });

  it('não permite atacar fora da vez, duas vezes, nem sem colocar repelente', () => {
    const g = battle();
    expect(() => g.attack(1, 0, 0)).toThrow(/vez/);
    g.attack(0, 9, 9);
    expect(() => g.attack(0, 8, 9)).toThrow(/repelente/);
    g.placeRepellent(0, 9, 7);
    expect(g.turn).toBe(1);
    g.attack(1, 5, 5);
    g.placeRepellent(1, 9, 7);
    expect(() => g.attack(0, 9, 9)).toThrow(/já foi atacada/);
  });

  it('rejeita coordenadas inválidas', () => {
    const g = battle();
    expect(() => g.attack(0, -1, 0)).toThrow(GameError);
    expect(() => g.attack(0, 10, 0)).toThrow(GameError);
    expect(() => g.attack(0, '1', 0)).toThrow(GameError);
    expect(() => g.attack(0, 0.5, 0)).toThrow(GameError);
  });

  it('elimina gato e vence ao eliminar todos', () => {
    const g = battle(cfg({ enabled: false }));
    const targets = g.boards[1].ships!.flatMap((s) => s.cells);
    let last: AbsEvent[] = [];
    for (const c of targets) {
      last = g.attack(0, c.x, c.y);
      if (g.phase === 'finished') break;
      // repelente desligado: turno passa direto; jogador 1 erra na última linha
      const i = targets.indexOf(c);
      g.attack(1, i % 10, 1 + 2 * Math.floor(i / 10));
    }
    expect(g.phase).toBe('finished');
    expect(g.winner).toBe(0);
    expect(types(last)).toEqual(['shot', 'gameOver']);
    expect(last[0]).toMatchObject({ result: 'sunk', ship: 'filhote' });
  });

  it('sunk inclui o gato revelado', () => {
    const g = battle();
    g.attack(0, 0, 8);
    g.placeRepellent(0, 9, 9);
    g.attack(1, 9, 0);
    g.placeRepellent(1, 9, 9);
    const ev = g.attack(0, 1, 8);
    expect(ev[0]).toMatchObject({ result: 'sunk', sunkShip: { kind: 'filhote', size: 2, sunk: true } });
  });
});

describe('repelente', () => {
  it('só pode ser colocado em casa vazia do próprio tabuleiro', () => {
    const g = battle();
    g.attack(0, 9, 9);
    expect(() => g.placeRepellent(0, 0, 0)).toThrow(/vazia/); // gato
    expect(() => g.placeRepellent(1, 9, 8)).toThrow(/vez/);
    g.placeRepellent(0, 9, 8);
    // jogador 1 ataca (9,9) do jogador 0 => marca; depois jogador 0 não pode por repelente lá
    g.attack(1, 9, 9);
    g.placeRepellent(1, 5, 9);
    g.attack(0, 5, 5);
    expect(() => g.placeRepellent(0, 9, 8)).toThrow(/vazia/); // já tem repelente
    expect(() => g.placeRepellent(0, 9, 9)).toThrow(/vazia/); // já atacada
    g.placeRepellent(0, 8, 9);
  });

  it('não pode atacar antes do repelente nem colocar repelente antes de atacar', () => {
    const g = battle();
    expect(() => g.placeRepellent(0, 9, 9)).toThrow(/Ataque/);
  });

  it('explode em cruz no tabuleiro de quem atacou, atingindo gatos', () => {
    // Jogador 0 tem o siamês na linha 2 (x 0..3). Jogador 1 coloca repelente em (1,2).
    // Jogador 0 ataca (1,2) do jogador 1 => cruz em (1,1),(1,3),(0,2),(2,2) no tabuleiro do 0.
    const g = battle();
    g.attack(0, 9, 9);
    g.placeRepellent(0, 9, 9);
    g.attack(1, 9, 9);
    g.placeRepellent(1, 1, 3); // casa vazia no tabuleiro do 1 (linha 3 está livre)
    const ev = g.attack(0, 1, 3);
    expect(ev[0]).toEqual({ t: 'shot', board: 1, x: 1, y: 3, result: 'trap' });
    const blast = ev[1] as Extract<AbsEvent, { t: 'blast' }>;
    expect(blast.t).toBe('blast');
    expect(blast.board).toBe(0);
    expect(blast.trapBoard).toBe(1);
    // cruz em volta de (1,3) no tabuleiro do jogador 0
    expect(blast.cells).toEqual([
      { x: 1, y: 2, result: 'hit', ship: 'siames' },
      { x: 1, y: 4, result: 'hit', ship: 'malhado' },
      { x: 0, y: 3, result: 'miss' },
      { x: 2, y: 3, result: 'miss' },
    ]);
    // repelente consumido e casa marcada como armadilha
    expect(g.boards[1].repellents).toEqual([]);
    expect(g.boards[1].marks.get('1,3')).toMatchObject({ type: 'trap' });
    // dano real no tabuleiro do atacante
    expect(g.boards[0].marks.get('1,2')).toMatchObject({ type: 'hit', source: 'blast' });
    expect(g.boards[0].ships![1]!.hits.has('1,2')).toBe(true);
    // atacante ainda precisa colocar repelente
    expect(g.step).toBe('repellent');
    // casas atingidas pela explosão não são mais "vazias"
    expect(() => g.placeRepellent(0, 0, 3)).toThrow(/vazia/);
  });

  it('ignora casas fora do tabuleiro (canto)', () => {
    const g = battle();
    g.attack(0, 9, 9);
    g.placeRepellent(0, 9, 9);
    g.attack(1, 9, 8);
    g.placeRepellent(1, 9, 1);
    const ev = g.attack(0, 9, 1);
    const blast = ev[1] as Extract<AbsEvent, { t: 'blast' }>;
    // (9,0),(9,2),(8,1) dentro; (10,1) fora
    expect(blast.cells.map((c) => [c.x, c.y])).toEqual([
      [9, 0],
      [9, 2],
      [8, 1],
    ]);
  });

  it('casas da cruz já atingidas são ignoradas', () => {
    const g = battle();
    g.attack(0, 9, 9);
    g.placeRepellent(0, 8, 9);
    g.attack(1, 5, 5); // jogador 1 atinge (5,5) do jogador 0 (água)
    g.placeRepellent(1, 5, 3);
    const ev = g.attack(0, 5, 3); // armadilha => cruz em volta de (5,3) no tabuleiro do 0
    const blast = ev[1] as Extract<AbsEvent, { t: 'blast' }>;
    expect(blast.cells).toEqual([
      { x: 5, y: 2, result: 'miss' },
      { x: 5, y: 4, result: 'miss' },
      { x: 4, y: 3, result: 'miss' },
      { x: 6, y: 3, result: 'miss' },
    ]);
    const ev2 = (() => {
      g.placeRepellent(0, 7, 9);
      g.attack(1, 0, 9);
      g.placeRepellent(1, 5, 5);
      return g.attack(0, 5, 5); // cruz em volta de (5,5): (5,4) já atingida
    })();
    const blast2 = ev2[1] as Extract<AbsEvent, { t: 'blast' }>;
    expect(blast2.cells).toContainEqual({ x: 5, y: 4, result: 'ignored' });
    expect(blast2.cells).toContainEqual({ x: 5, y: 6, result: 'miss' });
  });

  it('explosão que elimina o último gato do atacante dá vitória ao defensor', () => {
    // Jogador 0 só tem o filhote vivo, posicionado em (4,4)-(5,4).
    const f0: Placement[] = [
      { kind: 'gordo', x: 0, y: 0, vertical: false },
      { kind: 'siames', x: 0, y: 1, vertical: false },
      { kind: 'malhado', x: 0, y: 2, vertical: false },
      { kind: 'preto', x: 0, y: 3, vertical: false },
      { kind: 'filhote', x: 4, y: 4, vertical: false },
    ];
    const g = battle(cfg(), f0);
    // Mata manualmente todos os gatos do jogador 0 exceto (5,4) do filhote.
    for (const s of g.boards[0].ships!) for (const c of s.cells) if (!(c.x === 5 && c.y === 4)) s.hits.add(`${c.x},${c.y}`);
    g.boards[1].repellents.push({ x: 5, y: 5 }); // repelente do jogador 1 em (5,5)
    const ev = g.attack(0, 5, 5); // cruz atinge (5,4) => filhote eliminado
    expect(types(ev)).toEqual(['shot', 'blast', 'gameOver']);
    const blast = ev[1] as Extract<AbsEvent, { t: 'blast' }>;
    expect(blast.cells[0]).toMatchObject({ x: 5, y: 4, result: 'sunk', ship: 'filhote' });
    expect(g.winner).toBe(1);
    expect(g.phase).toBe('finished');
    expect(() => g.placeRepellent(0, 9, 9)).toThrow();
  });

  it('respeita o limite de repelentes ativos (substitui o mais antigo)', () => {
    const g = battle(cfg({ maxActive: 2, whenLimitReached: 'replaceOldest' }));
    const play = (rx: number) => {
      g.attack(0, rx, 9);
      const ev = g.placeRepellent(0, rx, 7);
      g.attack(1, rx, 9);
      g.placeRepellent(1, rx, 7);
      return ev;
    };
    play(0);
    play(1);
    const ev = play(2);
    expect(ev[0]).toEqual({ t: 'repellent', board: 0, cell: { x: 2, y: 7 }, replaced: { x: 0, y: 7 } });
    expect(g.boards[0].repellents).toEqual([{ x: 1, y: 7 }, { x: 2, y: 7 }]);
  });

  it('com política "skip" o turno passa direto quando no limite', () => {
    const g = battle(cfg({ maxActive: 1, whenLimitReached: 'skip' }));
    g.attack(0, 0, 9);
    g.placeRepellent(0, 0, 7);
    g.attack(1, 0, 9);
    g.placeRepellent(1, 0, 7);
    const ev = g.attack(0, 1, 9);
    expect(types(ev)).toEqual(['shot', 'turn']);
    expect(g.turn).toBe(1);
  });

  it('padrão de explosão configurável (incluindo centro e cruz maior)', () => {
    const g = battle(cfg({ blastPattern: [[0, 0], [0, -2]] }));
    g.boards[1].repellents.push({ x: 0, y: 4 });
    const ev = g.attack(0, 0, 4);
    const blast = ev[1] as Extract<AbsEvent, { t: 'blast' }>;
    expect(blast.cells).toEqual([
      { x: 0, y: 4, result: 'hit', ship: 'malhado' },
      { x: 0, y: 2, result: 'hit', ship: 'siames' },
    ]);
  });

  it('sem reação em cadeia, repelente do atacante na cruz é ignorado e permanece', () => {
    const g = battle();
    g.boards[0].repellents.push({ x: 5, y: 5 });
    g.boards[1].repellents.push({ x: 5, y: 4 });
    const ev = g.attack(0, 5, 4); // cruz atinge (5,5) do jogador 0
    const blast = ev[1] as Extract<AbsEvent, { t: 'blast' }>;
    expect(blast.cells).toContainEqual({ x: 5, y: 5, result: 'ignored' });
    expect(g.boards[0].repellents).toEqual([{ x: 5, y: 5 }]);
  });

  it('com reação em cadeia, repelente do atacante explode e atinge o defensor', () => {
    const g = battle(cfg({ chainReaction: true }));
    g.boards[0].repellents.push({ x: 2, y: 5 });
    g.boards[1].repellents.push({ x: 1, y: 5 });
    const ev = g.attack(0, 1, 5);
    expect(types(ev)).toEqual(['shot', 'blast', 'blast']);
    const first = ev[1] as Extract<AbsEvent, { t: 'blast' }>;
    expect(first.board).toBe(0);
    expect(first.cells).toContainEqual({ x: 1, y: 4, result: 'hit', ship: 'malhado' });
    expect(first.cells).toContainEqual({ x: 2, y: 5, result: 'ignored' });
    const chain = ev[2] as Extract<AbsEvent, { t: 'blast' }>;
    expect(chain.board).toBe(1);
    expect(chain.cells).toEqual([
      { x: 2, y: 4, result: 'hit', ship: 'malhado' },
      { x: 2, y: 6, result: 'hit', ship: 'preto' },
      { x: 1, y: 5, result: 'ignored' },
      { x: 3, y: 5, result: 'miss' },
    ]);
    expect(g.boards[0].repellents).toEqual([]);
  });

  it('se não há casa vazia, o turno passa sem repelente', () => {
    const g = battle();
    const b = g.boards[0];
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) if (!g.shipAt(b, x, y)) b.marks.set(`${x},${y}`, { x, y, type: 'miss', source: 'shot' });
    const ev = g.attack(0, 9, 9);
    expect(types(ev)).toEqual(['shot', 'turn']);
  });
});
