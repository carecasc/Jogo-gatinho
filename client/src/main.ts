import type { Cell, GameEvent, Placement, PlayerView, ShipKind, Side, UpdatePayload } from '../../server/src/protocol';
import { sound } from './audio';
import { Net } from './net';
import { catColor } from './scene/cats';
import { World, type Focus } from './scene/world';
import './style.css';

// ---------------------------------------------------------------- estado
type Draft = Map<ShipKind, Placement>;

const state = {
  view: null as PlayerView | null,
  queue: [] as UpdatePayload[],
  busy: false,
  connected: false,
  draft: new Map() as Draft,
  draftCode: '',
  selectedKind: null as ShipKind | null,
  vertical: false,
  target: null as Cell | null,
  overview: false,
  homeMode: 'menu' as 'menu' | 'join' | 'rules',
  joinCode: '',
  pending: false,
  resuming: false,
  hideModal: false,
};

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const root = document.getElementById('ui')!;
root.innerHTML = `
  <div id="top" class="inset-top"></div>
  <div id="banner"></div>
  <div id="toast"></div>
  <div id="bottom" class="inset-bottom"></div>
  <div id="overlay"></div>`;
const el = {
  top: root.querySelector<HTMLElement>('#top')!,
  banner: root.querySelector<HTMLElement>('#banner')!,
  toast: root.querySelector<HTMLElement>('#toast')!,
  bottom: root.querySelector<HTMLElement>('#bottom')!,
  overlay: root.querySelector<HTMLElement>('#overlay')!,
};

const world = new World(canvas);
const net = new Net();

// Código vindo do link compartilhado (?sala=ABCD)
const urlCode = new URLSearchParams(location.search).get('sala')?.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5) ?? '';
if (urlCode && net.session?.code !== urlCode) {
  state.homeMode = 'join';
  state.joinCode = urlCode;
}
state.resuming = !!net.session;

// ---------------------------------------------------------------- helpers
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const coord = (c: Cell) => `${LETTERS[c.x]}${c.y + 1}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fleet = () => state.view?.config.fleet ?? [];
const sizeOf = (kind: ShipKind) => fleet().find((f) => f.kind === kind)?.size ?? 1;
const nameOf = (kind: ShipKind) => fleet().find((f) => f.kind === kind)?.name ?? 'gatinho';
const boardSize = () => state.view?.config.boardSize ?? 10;
const key = (c: Cell) => `${c.x},${c.y}`;

function cellsOf(p: Placement, size = sizeOf(p.kind)): Cell[] {
  return Array.from({ length: size }, (_, i) => (p.vertical ? { x: p.x, y: p.y + i } : { x: p.x + i, y: p.y }));
}

function draftList() {
  return [...state.draft.values()].map((p) => ({ ...p, size: sizeOf(p.kind) }));
}

function fits(p: Placement, ignore: ShipKind | null = p.kind) {
  const n = boardSize();
  const taken = new Set<string>();
  for (const d of state.draft.values()) if (d.kind !== ignore) cellsOf(d).forEach((c) => taken.add(key(c)));
  return cellsOf(p).every((c) => c.x >= 0 && c.y >= 0 && c.x < n && c.y < n && !taken.has(key(c)));
}

/** Ajusta a âncora para o gato caber no tabuleiro. */
function clampPlacement(kind: ShipKind, x: number, y: number, vertical: boolean): Placement {
  const n = boardSize();
  const s = sizeOf(kind);
  return { kind, vertical, x: vertical ? x : Math.min(x, n - s), y: vertical ? Math.min(y, n - s) : y };
}

function randomFleet(): Draft {
  const n = boardSize();
  for (let attempt = 0; attempt < 200; attempt++) {
    const draft: Draft = new Map();
    const taken = new Set<string>();
    let ok = true;
    for (const f of fleet()) {
      let placed = false;
      for (let i = 0; i < 200 && !placed; i++) {
        const vertical = Math.random() < 0.5;
        const x = Math.floor(Math.random() * (vertical ? n : n - f.size + 1));
        const y = Math.floor(Math.random() * (vertical ? n - f.size + 1 : n));
        const p: Placement = { kind: f.kind, x, y, vertical };
        const cells = cellsOf(p, f.size);
        if (cells.some((c) => taken.has(key(c)))) continue;
        cells.forEach((c) => taken.add(key(c)));
        draft.set(f.kind, p);
        placed = true;
      }
      if (!placed) ok = false;
    }
    if (ok) return draft;
  }
  return new Map();
}

function saveDraft() {
  if (!state.view) return;
  try {
    localStorage.setItem(`gatinhos.draft.${state.view.code}`, JSON.stringify([...state.draft.values()]));
  } catch {
    /* ignore */
  }
}

function loadDraft(code: string) {
  state.draftCode = code;
  state.draft = new Map();
  try {
    const raw = JSON.parse(localStorage.getItem(`gatinhos.draft.${code}`) ?? '[]') as Placement[];
    for (const p of raw) if (fleet().some((f) => f.kind === p.kind) && fits(p, null)) state.draft.set(p.kind, p);
  } catch {
    /* ignore */
  }
}

function clearDrafts() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('gatinhos.draft.')) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

let toastTimer = 0;
function toast(msg: string, kind: 'info' | 'error' | 'good' = 'info', ms = 2200) {
  el.toast.innerHTML = `<div class="toast ${kind}">${esc(msg)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.toast.innerHTML = ''), ms);
}

function fail(msg: string) {
  sound.error();
  toast(msg, 'error');
}

/** Casa vazia no meu tabuleiro (para o repelente). */
function myCellEmpty(c: Cell) {
  const v = state.view!;
  if (v.myShips?.some((s) => cellsOf(s, s.size).some((sc) => sc.x === c.x && sc.y === c.y))) return false;
  if (v.myRepellents.some((r) => r.x === c.x && r.y === c.y)) return false;
  if (v.myMarks.some((m) => m.x === c.x && m.y === c.y)) return false;
  return true;
}

// ---------------------------------------------------------------- foco da câmera
function autoFocus(): Focus {
  const v = state.view;
  if (!v) return 'home';
  if (state.overview) return 'both';
  if (v.phase === 'finished') return 'both';
  if (v.phase === 'battle') {
    if (v.turn === 'me' && v.step === 'attack') return 'enemy';
    return 'mine';
  }
  return 'mine';
}

// ---------------------------------------------------------------- aplicação da visão
function applyView(v: PlayerView) {
  const prev = state.view;
  state.view = v;
  world.setBoardSize(v.config.boardSize);
  world.setShowcase(false);
  if (state.draftCode !== v.code) loadDraft(v.code);
  if (prev?.phase !== v.phase) {
    state.overview = false;
    state.target = null;
    state.hideModal = false;
    if (v.phase === 'battle') clearDrafts();
    if (v.phase === 'placing' && prev?.phase === 'finished') state.draft = new Map();
  }
  if (!(v.phase === 'battle' && v.turn === 'me')) state.target = null;
  if (prev && prev.step !== v.step) state.target = null;

  const placingDraft = v.phase === 'placing' && !v.youReady;
  if (placingDraft) world.setShips('me', draftList());
  else world.setShips('me', (v.myShips ?? []).filter((s) => !s.sunk));
  world.setShips('enemy', v.enemyShips.filter((s) => !s.sunk));
  world.setShipGlow('me', placingDraft && state.selectedKind && state.draft.has(state.selectedKind) ? { ...state.draft.get(state.selectedKind)!, size: sizeOf(state.selectedKind) } : null);

  const sunkCells = (ships: PlayerView['enemyShips']) => new Set(ships.filter((s) => s.sunk).flatMap((s) => cellsOf(s, s.size).map(key)));
  world.setMarks('me', v.myMarks, sunkCells(v.myShips ?? []));
  world.setMarks('enemy', v.enemyMarks, sunkCells(v.enemyShips));
  world.setRepellents(v.myRepellents);
  world.setHighlight(state.target ? (v.step === 'attack' ? 'enemy' : 'me') : null, state.target);
  world.setFocus(autoFocus());
  render();
}

// ---------------------------------------------------------------- fila de atualizações/animações
net.onUpdate = (p) => {
  state.resuming = false;
  state.queue.push(p);
  void processQueue();
};

async function processQueue() {
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    while (state.queue.length) {
      // Se acumulou muita coisa (ex.: celular bloqueado), pula direto para o estado final.
      if (state.queue.length > 3) {
        const last = state.queue[state.queue.length - 1]!;
        state.queue = [];
        world.tweens.finishAll();
        applyView(last.view);
        continue;
      }
      const u = state.queue.shift()!;
      if (state.view && u.events.length) {
        world.setHighlight(null, null);
        for (const ev of u.events) await playEvent(ev, u.view);
      } else if (!state.view) {
        applyView(u.view);
        world.snapCamera();
        continue;
      }
      applyView(u.view);
    }
  } finally {
    state.busy = false;
    render();
  }
}

async function focusOn(f: Focus) {
  if (world.getFocus() !== f) {
    world.setFocus(f);
    await world.wait(0.65);
  }
}

async function playEvent(ev: GameEvent, next: PlayerView) {
  const name = (k?: ShipKind) => (k ? nameOf(k) : 'gatinho');
  switch (ev.t) {
    case 'battleStart':
      toast(ev.turn === 'me' ? 'A batalha começou! Você começa 🐾' : 'A batalha começou! O adversário começa', 'good');
      if (ev.turn === 'me') sound.yourTurn();
      await world.wait(0.4);
      break;
    case 'shot': {
      await focusOn(ev.side === 'me' ? 'mine' : 'enemy');
      await world.dropProjectile(ev.side, ev.x, ev.y);
      const mine = ev.side === 'me';
      if (ev.result === 'miss') toast(mine ? `O adversário errou (${coord(ev)}) 💦` : `Água! Errou em ${coord(ev)} 💦`);
      else if (ev.result === 'hit') toast(mine ? `Seu ${name(ev.ship)} levou um susto! 🙀` : `Acertou um ${name(ev.ship)}! 😼`, mine ? 'error' : 'good');
      else if (ev.result === 'sunk') toast(mine ? `Seu ${name(ev.ship)} fugiu! 😿` : `${name(ev.ship)} eliminado! Fugiu correndo! 🏃`, mine ? 'error' : 'good', 2800);
      else toast(mine ? 'Seu repelente explodiu! 💥' : 'Era um repelente! 💥', mine ? 'good' : 'error', 2800);
      await world.impact(ev.side, ev.x, ev.y, ev.result, ev.ship, ev.sunkShip);
      break;
    }
    case 'blast': {
      await focusOn('both');
      await world.explode(ev.trapSide, ev.x, ev.y);
      await world.crossWave(ev.trapSide, ev.x, ev.y, ev.side, ev.cells);
      const hits = ev.cells.filter((c) => c.result === 'hit' || c.result === 'sunk').length;
      const mine = ev.side === 'me';
      toast(
        mine
          ? hits ? `A explosão voltou e atingiu ${hits} casa(s) com seus gatos! 🙀` : 'A explosão voltou, mas não pegou nenhum gato seu 😅'
          : hits ? `Seu repelente acertou ${hits} gato(s) do adversário! 💥` : 'Seu repelente explodiu, mas não pegou ninguém',
        mine === !!hits ? 'error' : 'good',
        3000,
      );
      await Promise.all(
        ev.cells.map((c, i) => world.wait(i * 0.15).then(() => world.impact(ev.side, c.x, c.y, c.result, c.ship, c.sunkShip))),
      );
      await world.wait(0.3);
      break;
    }
    case 'repellent':
      if (ev.side === 'me' && ev.cell) {
        await focusOn('mine');
        world.sprayAt(ev.cell);
        world.setRepellents(next.myRepellents);
        if (ev.replaced) toast('Limite atingido: seu repelente mais antigo sumiu', 'info');
        await world.wait(0.4);
      } else if (ev.side === 'enemy') {
        toast('O adversário escondeu um repelente 🧴');
        await world.wait(0.3);
      }
      break;
    case 'turn':
      if (ev.turn === 'me') sound.yourTurn();
      break;
    case 'gameOver':
      await world.wait(0.5);
      if (ev.winner === 'me') sound.win();
      else sound.lose();
      break;
  }
}

// ---------------------------------------------------------------- toques no tabuleiro
world.onCellTap = (side, x, y) => {
  const v = state.view;
  if (!v) {
    world.pokeShowcase();
    return;
  }
  if (state.busy || state.pending) return;
  const cell = { x, y };

  if (v.phase === 'placing' && !v.youReady) {
    if (side !== 'me') return;
    placementTap(cell);
    return;
  }
  if (v.phase !== 'battle') return;
  if (v.turn !== 'me') {
    if (side === 'enemy') toast('Espere sua vez 🐾');
    return;
  }
  if (v.step === 'attack') {
    if (side !== 'enemy') {
      toast('Ataque o tabuleiro do adversário 🎯');
      world.setFocus('enemy');
      return;
    }
    if (v.enemyMarks.some((m) => m.x === x && m.y === y)) {
      world.flashInvalid('enemy', cell);
      fail('Você já atacou essa casa');
      return;
    }
    if (state.target && state.target.x === x && state.target.y === y) {
      void doAttack();
      return;
    }
    state.target = cell;
    sound.click();
    world.setHighlight('enemy', cell);
    render();
  } else if (v.step === 'repellent') {
    if (side !== 'me') {
      toast('Esconda o repelente no SEU tabuleiro 🧴');
      world.setFocus('mine');
      return;
    }
    if (!myCellEmpty(cell)) {
      world.flashInvalid('me', cell);
      fail('Escolha uma casa vazia (sem gato, repelente ou ataque)');
      return;
    }
    if (state.target && state.target.x === x && state.target.y === y) {
      void doRepellent();
      return;
    }
    state.target = cell;
    sound.click();
    world.setHighlight('me', cell);
    render();
  }
};

function placementTap(cell: Cell) {
  const sel = state.selectedKind;
  if (sel) {
    const current = state.draft.get(sel);
    const p = clampPlacement(sel, cell.x, cell.y, current?.vertical ?? state.vertical);
    if (!fits(p)) {
      world.flashInvalid('me', cell);
      fail('Não cabe aí — os gatinhos não podem se sobrepor');
      return;
    }
    state.draft.set(sel, p);
    sound.pop();
    // seleciona automaticamente o próximo gato que falta
    state.selectedKind = fleet().find((f) => !state.draft.has(f.kind))?.kind ?? null;
  } else {
    const hit = [...state.draft.values()].find((p) => cellsOf(p).some((c) => c.x === cell.x && c.y === cell.y));
    if (!hit) return;
    state.selectedKind = hit.kind;
    sound.click();
  }
  saveDraft();
  applyView(state.view!);
}

// ---------------------------------------------------------------- ações
async function withPending<T>(fn: () => Promise<T>) {
  if (state.pending) return;
  state.pending = true;
  render();
  try {
    return await fn();
  } finally {
    state.pending = false;
    render();
  }
}

async function doAttack() {
  const t = state.target;
  if (!t) return;
  await withPending(async () => {
    const res = await net.call('game:attack', t);
    if (!res.ok) fail(res.error);
  });
}

async function doRepellent() {
  const t = state.target;
  if (!t) return;
  await withPending(async () => {
    const res = await net.call('game:repellent', t);
    if (!res.ok) fail(res.error);
  });
}

async function share() {
  const code = state.view?.code ?? net.session?.code;
  if (!code) return;
  const url = `${location.origin}/?sala=${code}`;
  const text = `Vem jogar Batalha dos Gatinhos comigo! 🐱 Sala ${code}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Batalha dos Gatinhos', text, url });
      return;
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copiado! Mande para seu amigo 📋', 'good');
  } catch {
    window.prompt('Copie o link da sala:', url);
  }
}

function resetToHome(msg?: string) {
  state.view = null;
  state.queue = [];
  state.target = null;
  state.selectedKind = null;
  state.homeMode = 'menu';
  state.draftCode = '';
  world.tweens.finishAll();
  world.setShips('me', []);
  world.setShips('enemy', []);
  world.setMarks('me', [], new Set());
  world.setMarks('enemy', [], new Set());
  world.setRepellents([]);
  world.setHighlight(null, null);
  world.setShipGlow('me', null);
  world.setShowcase(true);
  world.setFocus('home');
  if (location.search) history.replaceState(null, '', location.pathname);
  if (msg) toast(msg, 'error', 3500);
  render();
}

net.onLost = (reason) => {
  state.resuming = false;
  resetToHome(reason);
};
net.onStatus = (connected) => {
  state.connected = connected;
  if (connected && !net.session) state.resuming = false;
  render();
};

const actions: Record<string, (arg?: string) => void | Promise<void>> = {
  create: () =>
    withPending(async () => {
      const res = await net.createRoom();
      if (!res.ok) fail(res.error);
    }),
  showJoin: () => {
    state.homeMode = 'join';
    render();
    root.querySelector<HTMLInputElement>('#code-input')?.focus();
  },
  rules: () => {
    state.homeMode = 'rules';
    render();
  },
  back: () => {
    state.homeMode = 'menu';
    render();
  },
  join: () =>
    withPending(async () => {
      const code = state.joinCode.trim().toUpperCase();
      if (code.length < 4) return fail('Digite o código da sala');
      const res = await net.joinRoom(code);
      if (!res.ok) fail(res.error);
      else if (location.search) history.replaceState(null, '', location.pathname);
    }),
  share: () => share(),
  mute: () => {
    sound.setMuted(!sound.muted);
    render();
  },
  overview: () => {
    state.overview = !state.overview;
    world.setFocus(autoFocus());
    render();
  },
  select: (kind) => {
    const k = kind as ShipKind;
    state.selectedKind = state.selectedKind === k ? null : k;
    if (state.selectedKind) state.vertical = state.draft.get(k)?.vertical ?? state.vertical;
    sound.click();
    applyView(state.view!);
  },
  rotate: () => {
    const sel = state.selectedKind;
    const cur = sel ? state.draft.get(sel) : undefined;
    if (sel && cur) {
      const p = clampPlacement(sel, cur.x, cur.y, !cur.vertical);
      if (!fits(p)) return fail('Sem espaço para girar aqui');
      state.draft.set(sel, p);
      state.vertical = p.vertical;
      saveDraft();
      sound.pop();
    } else {
      state.vertical = !state.vertical;
      sound.click();
    }
    applyView(state.view!);
  },
  random: () => {
    state.draft = randomFleet();
    state.selectedKind = null;
    saveDraft();
    sound.pop();
    applyView(state.view!);
  },
  clear: () => {
    state.draft = new Map();
    state.selectedKind = fleet()[0]?.kind ?? null;
    saveDraft();
    applyView(state.view!);
  },
  ready: () =>
    withPending(async () => {
      if (state.draft.size !== fleet().length) return fail('Posicione todos os gatinhos primeiro');
      const res = await net.call('game:ready', { ships: [...state.draft.values()] });
      if (!res.ok) fail(res.error);
      else {
        state.selectedKind = null;
        sound.pop();
      }
    }),
  unready: () =>
    withPending(async () => {
      const res = await net.call('game:unready');
      if (!res.ok) fail(res.error);
    }),
  hideModal: () => {
    state.hideModal = true;
    render();
  },
  showModal: () => {
    state.hideModal = false;
    render();
  },
  attack: () => doAttack(),
  repellent: () => doRepellent(),
  rematch: () =>
    withPending(async () => {
      const res = await net.call('game:rematch');
      if (!res.ok) fail(res.error);
    }),
  leave: async () => {
    const v = state.view;
    if (v && v.phase === 'battle' && !window.confirm('Sair da partida? Isso conta como desistência.')) return;
    await net.leave();
    resetToHome();
  },
};

root.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!target || target.hasAttribute('disabled')) return;
  const fn = actions[target.dataset.act!];
  if (fn) void fn(target.dataset.arg);
});
root.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === 'code-input') {
    const v = t.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
    if (t.value !== v) t.value = v;
    state.joinCode = v;
  }
});
root.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).id === 'code-input' && e.key === 'Enter') void actions.join!();
});

// ---------------------------------------------------------------- renderização da interface
const cache = new Map<HTMLElement, string>();
function set(node: HTMLElement, html: string) {
  if (cache.get(node) === html) return;
  cache.set(node, html);
  node.innerHTML = html;
}

const muteBtn = () => `<button class="icon" data-act="mute" aria-label="Som">${sound.muted ? '🔇' : '🔊'}</button>`;

function catDot(kind: ShipKind, extra = '') {
  return `<span class="dot ${extra}" style="--c:${catColor(kind)}"></span>`;
}

function fleetRow(label: string, side: Side) {
  const v = state.view!;
  const ships = side === 'me' ? v.myShips ?? [] : v.enemyShips;
  return `<div class="fleet-row"><span class="fleet-label">${label}</span>${fleet()
    .map((f) => {
      const sunk = ships.find((s) => s.kind === f.kind)?.sunk;
      return `<span class="mini ${sunk ? 'sunk' : ''}" title="${esc(f.name)}">${catDot(f.kind)}${'<i></i>'.repeat(f.size)}</span>`;
    })
    .join('')}</div>`;
}

function statusLine(v: PlayerView): { text: string; cls: string } {
  switch (v.phase) {
    case 'waiting':
      return { text: 'Aguardando oponente entrar…', cls: 'wait' };
    case 'placing':
      if (!v.youReady) return { text: state.selectedKind ? `Toque no tabuleiro para posicionar o ${nameOf(state.selectedKind)}` : 'Posicione seus gatinhos', cls: 'me' };
      return { text: 'Aguardando o oponente ficar pronto…', cls: 'wait' };
    case 'battle':
      if (v.turn === 'me') return v.step === 'attack' ? { text: 'Sua vez! Escolha uma casa para atacar 🎯', cls: 'me' } : { text: 'Esconda um repelente no seu tabuleiro 🧴', cls: 'me' };
      return v.step === 'attack' ? { text: 'Vez do adversário…', cls: 'wait' } : { text: 'Adversário escondendo um repelente…', cls: 'wait' };
    case 'finished':
      return { text: v.winner === 'me' ? 'Você venceu! 🏆' : 'Você perdeu 😿', cls: v.winner === 'me' ? 'me' : 'wait' };
  }
}

function render() {
  const v = state.view;
  root.classList.toggle('in-game', !!v);

  // banners de conexão
  let banner = '';
  if (!state.connected) banner = '<div class="banner warn">📡 Reconectando…</div>';
  else if (v && v.opponentJoined && !v.opponentConnected && !v.opponentLeft && v.phase !== 'finished') banner = '<div class="banner warn">😴 Oponente desconectado — aguardando voltar…</div>';
  set(el.banner, banner);

  if (!v) {
    set(el.top, `<div class="topbar home-top"><span></span>${muteBtn()}</div>`);
    set(el.bottom, homeHtml());
    set(el.overlay, '');
    layout();
    return;
  }

  const st = statusLine(v);
  set(
    el.top,
    `<div class="topbar">
      <button class="room-chip" data-act="share">Sala <b>${esc(v.code)}</b> <span>🔗</span></button>
      ${v.phase === 'battle' || v.phase === 'finished' ? `<div class="score"><span class="me">🐱 ${v.myRemaining}</span><span class="x">×</span><span class="en">${v.enemyRemaining} 🐱</span></div>` : '<span></span>'}
      <div class="top-actions">
        ${v.phase === 'battle' ? `<button class="icon ${state.overview ? 'on' : ''}" data-act="overview" aria-label="Ver tudo">👁</button>` : ''}
        ${muteBtn()}
      </div>
    </div>
    <div class="status ${st.cls} ${state.busy ? 'busy' : ''}">${esc(st.text)}</div>`,
  );
  set(el.bottom, gameBottomHtml(v));
  set(el.overlay, v.phase === 'finished' && !state.busy && !state.hideModal ? finishedHtml(v) : '');
  layout();
}

function homeHtml() {
  const pending = state.pending ? 'disabled' : '';
  if (state.resuming) {
    return `<div class="panel home"><h1>Batalha dos <em>Gatinhos</em></h1><p class="sub">Voltando para a partida… 🐾</p></div>`;
  }
  let body = '';
  if (state.homeMode === 'menu') {
    body = `
      <button class="btn primary big" data-act="create" ${pending}>🏠 Criar sala</button>
      <button class="btn big" data-act="showJoin">🔑 Entrar com código</button>
      <button class="btn link" data-act="rules">Como jogar?</button>`;
  } else if (state.homeMode === 'join') {
    body = `
      <label class="field-label" for="code-input">Código da sala</label>
      <input id="code-input" class="code-input" maxlength="5" autocomplete="off" autocapitalize="characters" spellcheck="false" inputmode="text" placeholder="ABCD" value="${esc(state.joinCode)}" />
      <button class="btn primary big" data-act="join" ${pending}>${state.joinCode && state.joinCode === urlCode ? `Entrar na sala ${esc(urlCode)}` : 'Entrar'}</button>
      <button class="btn link" data-act="back">Voltar</button>`;
  } else {
    body = `
      <ol class="rules">
        <li>Cada jogador esconde 5 gatinhos no seu tabuleiro 10×10.</li>
        <li>Na sua vez, ataque uma casa do adversário: se acertar, o gato mia de susto; se pegar todas as casas, ele foge!</li>
        <li>Depois de atacar, esconda um <b>repelente 🧴</b> numa casa vazia do seu tabuleiro.</li>
        <li>Se o adversário atacar um repelente, ele explode e devolve o ataque em <b>cruz</b> no tabuleiro dele!</li>
        <li>Vence quem eliminar todos os gatos do outro primeiro.</li>
      </ol>
      <button class="btn big" data-act="back">Entendi!</button>`;
  }
  return `<div class="panel home">
    <h1>Batalha dos <em>Gatinhos</em></h1>
    <p class="sub">Esconda seus gatinhos, espalhe repelentes e faça o adversário miar!</p>
    ${body}
  </div>`;
}

function gameBottomHtml(v: PlayerView) {
  const pending = state.pending || state.busy ? 'disabled' : '';
  if (v.phase === 'waiting') {
    return `<div class="panel">
      <p class="big-code-label">Código da sala</p>
      <div class="big-code">${esc(v.code)}</div>
      <p class="hint">Mande o código ou o link para quem vai jogar com você.</p>
      <button class="btn primary big" data-act="share">📤 Compartilhar link</button>
      <button class="btn link" data-act="leave">Sair</button>
    </div>`;
  }
  if (v.phase === 'placing') {
    if (v.youReady) {
      return `<div class="panel">
        <p class="hint center">${v.opponentReady ? 'Começando…' : '✅ Pronto! O adversário ainda está escondendo os gatinhos.'}</p>
        <button class="btn big" data-act="unready" ${pending}>✏️ Mudar posições</button>
      </div>`;
    }
    const chips = fleet()
      .map((f) => {
        const placed = state.draft.has(f.kind);
        const sel = state.selectedKind === f.kind;
        return `<button class="chip ${placed ? 'placed' : ''} ${sel ? 'sel' : ''}" data-act="select" data-arg="${f.kind}">
          ${catDot(f.kind)}<span class="chip-name">${esc(f.name)}</span><span class="pips">${'<i></i>'.repeat(f.size)}</span>${placed ? '<span class="ok">✓</span>' : ''}
        </button>`;
      })
      .join('');
    const allPlaced = state.draft.size === fleet().length;
    const orient = (state.selectedKind && state.draft.get(state.selectedKind)?.vertical) ?? state.vertical;
    return `<div class="panel">
      <div class="tray">${chips}</div>
      <div class="row">
        <button class="btn" data-act="rotate">↻ ${orient ? 'Vertical' : 'Horizontal'}</button>
        <button class="btn" data-act="random">🎲 Aleatório</button>
        <button class="btn" data-act="clear">🧹</button>
      </div>
      <button class="btn primary big" data-act="ready" ${allPlaced && !state.pending ? '' : 'disabled'}>${allPlaced ? '✔ Pronto!' : `Faltam ${fleet().length - state.draft.size} gatinho(s)`}</button>
      ${v.opponentReady ? '<p class="hint center small">O adversário já está pronto!</p>' : ''}
    </div>`;
  }
  // batalha / fim
  let action = '';
  if (v.phase === 'battle') {
    if (v.turn === 'me' && v.step === 'attack') {
      action = `<button class="btn primary big attack" data-act="attack" ${state.target && !pending ? '' : 'disabled'}>${state.target ? `🧶 Atacar ${coord(state.target)}` : 'Toque numa casa do adversário'}</button>`;
    } else if (v.turn === 'me' && v.step === 'repellent') {
      const left = v.config.repellent.maxActive;
      action = `<button class="btn primary big repel" data-act="repellent" ${state.target && !pending ? '' : 'disabled'}>${state.target ? `🧴 Esconder repelente em ${coord(state.target)}` : 'Toque numa casa vazia sua'}</button>
        <p class="hint center small">Repelentes ativos: ${v.myRepellents.length}${left !== null ? ` / ${left}` : ''}</p>`;
    } else {
      action = `<div class="waiting-pill"><span class="paws"><i>🐾</i><i>🐾</i><i>🐾</i></span> ${state.busy ? 'Assistindo…' : 'Vez do adversário'}</div>`;
    }
  } else if (state.hideModal) {
    action = `<button class="btn primary big" data-act="showModal">${v.winner === 'me' ? '🏆' : '😿'} Ver resultado</button>`;
  }
  return `<div class="panel compact">
    ${fleetRow('Seus', 'me')}
    ${fleetRow('Dele', 'enemy')}
    ${action}
  </div>`;
}

function finishedHtml(v: PlayerView) {
  const won = v.winner === 'me';
  const rematch = v.opponentLeft
    ? ''
    : v.youWantRematch
    ? `<p class="hint center">Esperando o adversário aceitar a revanche…</p>`
    : `<button class="btn primary big" data-act="rematch" ${state.pending ? 'disabled' : ''}>🔁 ${v.opponentWantsRematch ? 'Aceitar revanche!' : 'Revanche'}</button>`;
  return `<div class="modal-bg"><div class="modal ${won ? 'won' : 'lost'}">
    <div class="emoji">${won ? '😻🏆' : '😿'}</div>
    <h2>${won ? 'Você venceu!' : 'Você perdeu…'}</h2>
    <p>${v.opponentLeft ? 'O adversário saiu da partida. 🏳️' : won ? 'Todos os gatinhos do adversário fugiram!' : 'Seus gatinhos fugiram todos.'}</p>
    ${v.opponentWantsRematch && !v.youWantRematch ? '<p class="hint center">O adversário quer revanche!</p>' : ''}
    ${rematch}
    <button class="btn" data-act="leave">Sair</button>
    <button class="btn link" data-act="hideModal">Ver tabuleiros</button>
  </div></div>`;
}

/** Informa à câmera quanto da tela está coberto pela interface. */
function layout() {
  requestAnimationFrame(() => {
    const top = el.top.getBoundingClientRect().bottom;
    const bottomRect = el.bottom.firstElementChild?.getBoundingClientRect();
    const bottom = bottomRect ? window.innerHeight - bottomRect.top : 0;
    world.setInsets(Math.max(0, top), Math.max(0, bottom));
  });
}
window.addEventListener('resize', layout);

// Gancho para testes automatizados (só contém dados do próprio jogador).
(window as any).__gatinhos = { world, state, sound };

// ---------------------------------------------------------------- início
world.setShowcase(true);
world.setFocus('home');
world.snapCamera();
render();
if (state.resuming) {
  // Se não conseguir voltar em alguns segundos, mostra o menu.
  setTimeout(() => {
    if (state.resuming && !state.view) {
      state.resuming = false;
      render();
    }
  }, 6000);
}
