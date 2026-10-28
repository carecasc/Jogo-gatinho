import * as THREE from 'three';
import type { Cell, Mark, Placement, ShipKind, ShipView, Side } from '../../../server/src/protocol';
import { sound } from '../audio';
import { bake, Cat, mat } from './cats';
import { ease, Tweener } from './tween';

export type Focus = 'home' | 'mine' | 'enemy' | 'both';

const BOARD_GAP = 2.4;
const ELEVATION = THREE.MathUtils.degToRad(56);

const GEO = {
  disc: new THREE.CylinderGeometry(1, 1, 1, 8),
  ball: new THREE.IcosahedronGeometry(1, 0),
  roundBall: new THREE.IcosahedronGeometry(1, 1),
  plane: new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
  ring: new THREE.RingGeometry(0.7, 1, 16).rotateX(-Math.PI / 2),
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 8),
  cone: new THREE.ConeGeometry(1, 1, 6),
  tetra: new THREE.TetrahedronGeometry(1, 0),
};

interface Particle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  gravity: number;
  spin: THREE.Vector3;
  shrink: boolean;
}

class BoardView {
  readonly group = new THREE.Group();
  readonly top: THREE.Mesh;
  readonly cats = new Map<ShipKind, Cat>();
  readonly marks = new Map<string, { obj: THREE.Object3D; sig: string }>();
  readonly repellents = new Map<string, THREE.Object3D>();
  readonly highlight: THREE.Group;
  readonly shipGlow: THREE.Mesh;

  constructor(
    readonly side: Side,
    readonly n: number,
    z: number,
  ) {
    this.group.position.z = z;
    const frame = side === 'me' ? '#8fcbb3' : '#efa190';
    const base = new THREE.Mesh(GEO.box, mat(frame));
    base.scale.set(n + 0.8, 0.34, n + 0.8);
    base.position.y = -0.17;
    base.receiveShadow = true;
    this.group.add(base);
    // borda arredondadinha (detalhe)
    const lip = new THREE.Mesh(GEO.box, mat(side === 'me' ? '#7bb9a0' : '#de8e7e'));
    lip.scale.set(n + 1.0, 0.18, n + 1.0);
    lip.position.y = -0.3;
    this.group.add(lip);

    this.top = new THREE.Mesh(
      GEO.plane,
      new THREE.MeshStandardMaterial({ map: boardTexture(n, side), roughness: 0.95 }),
    );
    this.top.scale.set(n, 1, n);
    this.top.position.y = 0.004;
    this.top.receiveShadow = true;
    this.top.userData.side = side;
    this.group.add(this.top);

    // destaque da casa selecionada
    this.highlight = new THREE.Group();
    const hp = new THREE.Mesh(GEO.plane, new THREE.MeshBasicMaterial({ color: '#ffe066', transparent: true, opacity: 0.6, depthWrite: false }));
    hp.scale.set(0.94, 1, 0.94);
    hp.position.y = 0.02;
    const ring = new THREE.Mesh(GEO.ring, new THREE.MeshBasicMaterial({ color: '#ff8a3d', transparent: true, opacity: 0.9, depthWrite: false }));
    ring.scale.setScalar(0.42);
    ring.position.y = 0.03;
    const arrow = new THREE.Mesh(GEO.cone, mat('#ff8a3d', { emissive: '#7a3000' }));
    arrow.scale.set(0.16, 0.3, 0.16);
    arrow.rotation.x = Math.PI;
    arrow.position.y = 1.0;
    arrow.name = 'arrow';
    this.highlight.add(hp, ring, arrow);
    this.highlight.visible = false;
    this.group.add(this.highlight);

    this.shipGlow = new THREE.Mesh(GEO.plane, new THREE.MeshBasicMaterial({ color: '#fff3a8', transparent: true, opacity: 0.55, depthWrite: false }));
    this.shipGlow.position.y = 0.015;
    this.shipGlow.visible = false;
    this.group.add(this.shipGlow);
  }

  cellPos(x: number, y: number, out = new THREE.Vector3()) {
    return out.set(x - this.n / 2 + 0.5, 0, y - this.n / 2 + 0.5);
  }

  worldCell(x: number, y: number) {
    return this.group.localToWorld(this.cellPos(x, y));
  }

  placeCat(cat: Cat, p: Placement & { size: number }) {
    const a = this.cellPos(p.x, p.y);
    const b = p.vertical ? this.cellPos(p.x, p.y + p.size - 1) : this.cellPos(p.x + p.size - 1, p.y);
    cat.group.position.copy(a.add(b).multiplyScalar(0.5));
    cat.group.rotation.y = p.vertical ? -Math.PI / 2 : 0;
    cat.faceYaw = p.vertical ? 0 : -0.75;
  }
}

function boardTexture(n: number, side: Side) {
  const px = 64;
  const c = document.createElement('canvas');
  c.width = c.height = n * px;
  const g = c.getContext('2d')!;
  const [a, b, line] = side === 'me' ? ['#eaf8ef', '#d4efdf', '#a9d8c1'] : ['#fdeee8', '#f9dbd0', '#efb7a7'];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      g.fillStyle = (x + y) % 2 ? b : a;
      g.fillRect(x * px, y * px, px, px);
    }
  }
  g.strokeStyle = line;
  g.lineWidth = 3;
  for (let i = 0; i <= n; i++) {
    g.beginPath();
    g.moveTo(i * px, 0);
    g.lineTo(i * px, n * px);
    g.moveTo(0, i * px);
    g.lineTo(n * px, i * px);
    g.stroke();
  }
  // patinhas decorativas bem clarinhas nos cantos
  g.fillStyle = side === 'me' ? 'rgba(120,190,160,0.25)' : 'rgba(230,140,120,0.25)';
  const paw = (cx: number, cy: number, s: number) => {
    g.beginPath();
    g.ellipse(cx, cy + s * 0.25, s * 0.45, s * 0.35, 0, 0, Math.PI * 2);
    g.fill();
    for (const [dx, dy] of [[-0.45, -0.3], [-0.15, -0.55], [0.15, -0.55], [0.45, -0.3]] as const) {
      g.beginPath();
      g.arc(cx + dx * s, cy + dy * s, s * 0.15, 0, Math.PI * 2);
      g.fill();
    }
  };
  paw(px * 0.5, px * 0.5, px * 0.4);
  paw(n * px - px * 0.5, n * px - px * 0.5, px * 0.4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function labelTexture(text: string, color: string) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 96;
  const g = c.getContext('2d')!;
  g.font = '800 64px system-ui, -apple-system, "Segoe UI", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = color;
  g.fillText(text, 256, 52);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(42, 1, 0.5, 200);
  readonly tweens = new Tweener();
  private boards!: Record<Side, BoardView>;
  private n = 10;
  private particles: Particle[] = [];
  private transient = new Set<{ update: (t: number, dt: number) => void }>();
  private clock = new THREE.Clock();
  private time = 0;
  private focus: Focus = 'home';
  private camPos = new THREE.Vector3(0, 30, 30);
  private camLook = new THREE.Vector3();
  private shake = 0;
  private insets = { top: 0, bottom: 0 };
  private raycaster = new THREE.Raycaster();
  private showcaseCats: Cat[] = [];
  private pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  private frameTimes: number[] = [];
  private labels: THREE.Mesh[] = [];
  /** Multiplicador de velocidade das animações (testes automatizados). */
  speed = 1;
  onCellTap: (side: Side, x: number, y: number) => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: this.pixelRatio < 2, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.buildEnvironment();
    this.setBoardSize(10);
    this.bindInput();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.visualViewport?.addEventListener('resize', () => this.resize());
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ---------- cenário ----------
  private buildEnvironment() {
    const s = this.scene;
    s.background = new THREE.Color('#f4dccb');
    s.fog = new THREE.Fog('#f4dccb', 38, 78);

    s.add(new THREE.HemisphereLight('#fff6ec', '#c9a48a', 1.4));
    const sun = new THREE.DirectionalLight('#fff1dd', 2.0);
    sun.position.set(-8, 22, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const sc = sun.shadow.camera;
    sc.left = -9;
    sc.right = 9;
    sc.top = 15;
    sc.bottom = -15;
    sc.near = 5;
    sc.far = 50;
    sun.shadow.bias = -0.002;
    s.add(sun);

    // piso de madeira
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(240, 240).rotateX(-Math.PI / 2), mat('#d9ae86'));
    floor.position.y = -3.3;
    s.add(floor);
    // tapete redondo com faixas
    const rugColors = ['#eebcae', '#f5cfc0', '#eebcae'];
    rugColors.forEach((c, i) => {
      const r = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 32), mat(c));
      const rad = 34 - i * 2.2;
      r.scale.set(rad, 0.06, rad);
      r.position.y = -3.27 + i * 0.012;
      s.add(r);
    });
    // mesa
    const table = new THREE.Mesh(GEO.box, mat('#c99568'));
    table.scale.set(15.5, 0.7, 30);
    table.position.y = -0.7;
    table.receiveShadow = true;
    s.add(table);
    const trim = new THREE.Mesh(GEO.box, mat('#b07f56'));
    trim.scale.set(15.9, 0.25, 30.4);
    trim.position.y = -1.1;
    s.add(trim);
    for (const [x, z] of [[-6.8, -13.8], [6.8, -13.8], [-6.8, 13.8], [6.8, 13.8]]) {
      const leg = new THREE.Mesh(GEO.cyl, mat('#a8754d'));
      leg.scale.set(0.45, 2.2, 0.45);
      leg.position.set(x!, -2.2, z!);
      s.add(leg);
    }
    // almofadas fofinhas
    const cushions: Array<[number, number, string, number]> = [
      [-12, 6, '#a9cbe8', 0.3],
      [12.5, -4, '#f6dc8f', -0.4],
      [-12.5, -9, '#cdb8ea', 0.8],
      [12, 12, '#b1e0c8', -0.2],
      [-11, 18, '#f7b6c8', 0.5],
    ];
    for (const [x, z, c, r] of cushions) {
      const cg = new THREE.Group();
      const body = new THREE.Mesh(GEO.roundBall, mat(c));
      body.scale.set(3.2, 1.1, 3.2);
      cg.add(body);
      const btn = new THREE.Mesh(GEO.roundBall, mat('#ffffff'));
      btn.scale.set(0.35, 0.2, 0.35);
      btn.position.y = 1.0;
      cg.add(btn);
      cg.position.set(x, -2.5, z);
      cg.rotation.y = r;
      s.add(cg);
    }
    // novelo de lã e potinho de ração em cima da mesa
    const yarn = new THREE.Group();
    const yb = new THREE.Mesh(GEO.roundBall, mat('#f08a9a'));
    yb.castShadow = true;
    yarn.add(yb);
    for (let i = 0; i < 3; i++) {
      const t = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.06, 4, 16), mat('#d96b7e'));
      t.rotation.set(i * 1.1, i * 0.7, 0);
      yarn.add(t);
    }
    yarn.scale.setScalar(0.55);
    yarn.position.set(-6.6, 0.2, 0);
    s.add(yarn);
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.5, 0.4, 10), mat('#8fb8e8'));
    bowl.position.set(6.6, -0.15, 0.3);
    bowl.castShadow = true;
    s.add(bowl);
    const food = new THREE.Mesh(GEO.disc, mat('#c58b5a'));
    food.scale.set(0.6, 0.1, 0.6);
    food.position.set(6.6, 0.06, 0.3);
    s.add(food);
  }

  setBoardSize(n: number) {
    if (this.boards && this.n === n) return;
    if (this.boards) {
      this.scene.remove(this.boards.me.group, this.boards.enemy.group);
    }
    this.labels.forEach((l) => this.scene.remove(l));
    this.n = n;
    const off = n / 2 + BOARD_GAP / 2 + 0.4;
    this.boards = { me: new BoardView('me', n, off), enemy: new BoardView('enemy', n, -off) };
    this.scene.add(this.boards.me.group, this.boards.enemy.group);
    const mk = (text: string, color: string, z: number) => {
      const m = new THREE.Mesh(GEO.plane, new THREE.MeshBasicMaterial({ map: labelTexture(text, color), transparent: true, depthWrite: false }));
      m.scale.set(5.3, 1, 1);
      m.position.set(0, -0.33, z);
      this.labels.push(m);
      this.scene.add(m);
    };
    mk('🐾 VOCÊ', '#3f8f72', off + n / 2 + 1.0);
    mk('ADVERSÁRIO 🐾', '#c0604f', -off + n / 2 + 0.95);
  }

  board(side: Side) {
    return this.boards[side];
  }

  // ---------- câmera ----------
  setInsets(top: number, bottom: number) {
    this.insets = { top, bottom };
  }

  setFocus(f: Focus) {
    this.focus = f;
  }

  getFocus() {
    return this.focus;
  }

  private desiredCamera() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const n = this.n;
    const meZ = this.boards.me.group.position.z;
    const enZ = this.boards.enemy.group.position.z;
    let target: THREE.Vector3;
    let width = n + 1.6;
    let depth = n + 1.2;
    let azimuth = 0;
    switch (this.focus) {
      case 'mine':
        target = new THREE.Vector3(0, 0, meZ);
        break;
      case 'enemy':
        target = new THREE.Vector3(0, 0, enZ);
        break;
      case 'both':
        target = new THREE.Vector3(0, 0, (meZ + enZ) / 2);
        depth = meZ - enZ + n + 1.2;
        break;
      case 'home':
        target = new THREE.Vector3(0, 0.5, meZ);
        width = n * 0.85;
        depth = n * 0.85;
        azimuth = Math.sin(this.time * 0.15) * 0.35;
        break;
    }
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const availH = Math.max(0.3, (h - this.insets.top - this.insets.bottom) / h);
    const tanV = Math.tan(vfov / 2) * availH;
    const tanH = Math.tan(vfov / 2) * (w / h);
    // aproximação: profundidade projetada + altura dos gatos
    const projDepth = depth * Math.sin(ELEVATION) + 1.2 * Math.cos(ELEVATION);
    const dist = Math.max(width / 2 / tanH, projDepth / 2 / tanV) * 1.08;
    const dir = new THREE.Vector3(Math.sin(azimuth) * Math.cos(ELEVATION), Math.sin(ELEVATION), Math.cos(azimuth) * Math.cos(ELEVATION));
    return { pos: target.clone().addScaledVector(dir, dist), look: target };
  }

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.updateViewOffset();
  }

  /** Desloca o centro da projeção para o meio da área livre entre as barras da interface. */
  private updateViewOffset() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const shift = (this.insets.bottom - this.insets.top) / 2;
    this.camera.setViewOffset(w, h, 0, shift, w, h);
    this.camera.updateProjectionMatrix();
  }

  /** A câmera já chegou ao destino? (usado por testes automatizados) */
  isSettled() {
    return this.camPos.distanceTo(this.desiredCamera().pos) < 0.05;
  }

  snapCamera() {
    const d = this.desiredCamera();
    this.camPos.copy(d.pos);
    this.camLook.copy(d.look);
  }

  addShake(amount: number) {
    this.shake = Math.min(1.2, this.shake + amount);
  }

  // ---------- entrada (toque) ----------
  private bindInput() {
    let start: { x: number; y: number; t: number; id: number } | null = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      start = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!start || start.id !== e.pointerId) return;
      const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
      const dt = performance.now() - start.t;
      start = null;
      if (moved > 14 || dt > 700) return;
      this.tap(e.clientX, e.clientY);
    });
    this.canvas.addEventListener('pointercancel', () => (start = null));
  }

  /** Posição na tela (px) do centro de uma casa — usada em testes automatizados. */
  cellToScreen(side: Side, x: number, y: number) {
    const v = this.boards[side].worldCell(x, y).project(this.camera);
    return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight };
  }

  private tap(cx: number, cy: number) {
    const ndc = new THREE.Vector2((cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects([this.boards.me.top, this.boards.enemy.top], false);
    const hit = hits[0];
    if (!hit) return;
    const side = hit.object.userData.side as Side;
    const local = this.boards[side].group.worldToLocal(hit.point.clone());
    const x = Math.floor(local.x + this.n / 2);
    const y = Math.floor(local.z + this.n / 2);
    if (x < 0 || y < 0 || x >= this.n || y >= this.n) return;
    this.onCellTap(side, x, y);
  }

  // ---------- sincronização com o estado ----------
  /** Mostra exatamente estes gatos (vivos) num tabuleiro. */
  setShips(side: Side, ships: Array<Placement & { size: number }>) {
    const b = this.boards[side];
    const keep = new Set<ShipKind>();
    for (const s of ships) {
      keep.add(s.kind);
      let cat = b.cats.get(s.kind);
      if (cat && cat.length !== s.size) {
        b.group.remove(cat.group);
        cat.dispose();
        cat = undefined;
      }
      if (!cat) {
        cat = new Cat(s.kind, s.size);
        b.cats.set(s.kind, cat);
        b.group.add(cat.group);
        this.popIn(cat.group);
      }
      b.placeCat(cat, s);
    }
    for (const [kind, cat] of b.cats) {
      if (!keep.has(kind)) {
        b.group.remove(cat.group);
        cat.dispose();
        b.cats.delete(kind);
      }
    }
  }

  /** Destaca um gato selecionado (preparação). */
  setShipGlow(side: Side, ship: (Placement & { size: number }) | null) {
    const b = this.boards[side];
    b.shipGlow.visible = !!ship;
    if (!ship) return;
    const w = ship.vertical ? 1 : ship.size;
    const d = ship.vertical ? ship.size : 1;
    b.shipGlow.scale.set(w - 0.06, 1, d - 0.06);
    b.shipGlow.position.set(ship.x + w / 2 - this.n / 2, 0.015, ship.y + d / 2 - this.n / 2);
  }

  setHighlight(side: Side | null, cell: Cell | null, valid = true) {
    for (const s of ['me', 'enemy'] as const) {
      const h = this.boards[s].highlight;
      h.visible = s === side && !!cell;
      if (h.visible && cell) {
        this.boards[s].cellPos(cell.x, cell.y, h.position);
        const col = valid ? '#ffe066' : '#ff6b6b';
        ((h.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial).color.set(col);
        ((h.children[1] as THREE.Mesh).material as THREE.MeshBasicMaterial).color.set(valid ? '#ff8a3d' : '#d62f2f');
      }
    }
  }

  /** Pisca uma casa inválida em vermelho. */
  flashInvalid(side: Side, cell: Cell) {
    const b = this.boards[side];
    const m = new THREE.Mesh(GEO.plane, new THREE.MeshBasicMaterial({ color: '#ff5b5b', transparent: true, opacity: 0.7, depthWrite: false }));
    b.cellPos(cell.x, cell.y, m.position);
    m.position.y = 0.025;
    m.scale.set(0.94, 1, 0.94);
    b.group.add(m);
    void this.tweens.tween(0.45, (t) => ((m.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - t))).then(() => {
      b.group.remove(m);
      m.material.dispose();
    });
  }

  setMarks(side: Side, marks: Mark[], sunkCells: Set<string>) {
    const b = this.boards[side];
    const seen = new Set<string>();
    for (const m of marks) {
      const k = `${m.x},${m.y}`;
      seen.add(k);
      this.addMark(side, m, sunkCells.has(k));
    }
    for (const [k, v] of b.marks) {
      if (!seen.has(k)) {
        b.group.remove(v.obj);
        b.marks.delete(k);
      }
    }
  }

  addMark(side: Side, m: Pick<Mark, 'x' | 'y' | 'type'>, sunk = false) {
    const b = this.boards[side];
    const k = `${m.x},${m.y}`;
    const sig = `${m.type}|${sunk}`;
    const prev = b.marks.get(k);
    if (prev?.sig === sig) return;
    if (prev) b.group.remove(prev.obj);
    const obj = makeMarker(m.type, sunk);
    b.cellPos(m.x, m.y, obj.position);
    b.group.add(obj);
    b.marks.set(k, { obj, sig });
    if (!prev) this.popIn(obj, 0.25);
  }

  setRepellents(cells: Cell[]) {
    const b = this.boards.me;
    const keys = new Set(cells.map((c) => `${c.x},${c.y}`));
    for (const c of cells) {
      const k = `${c.x},${c.y}`;
      if (b.repellents.has(k)) continue;
      const bottle = makeBottle();
      b.cellPos(c.x, c.y, bottle.position);
      b.group.add(bottle);
      b.repellents.set(k, bottle);
      this.popIn(bottle);
    }
    for (const [k, obj] of b.repellents) {
      if (!keys.has(k)) {
        b.group.remove(obj);
        b.repellents.delete(k);
      }
    }
  }

  /** Gatinhos de vitrine na tela inicial. */
  setShowcase(on: boolean) {
    for (const c of this.showcaseCats) {
      this.boards.me.group.remove(c.group);
      c.dispose();
    }
    this.showcaseCats = [];
    if (!on) return;
    const kinds: Array<[ShipKind, number, number, number, boolean]> = [
      ['gordo', 5, 1, 1, false],
      ['siames', 4, 5, 3, false],
      ['malhado', 3, 1, 5, false],
      ['preto', 3, 8, 4, true],
      ['filhote', 2, 3, 8, false],
    ];
    for (const [kind, size, x, y, vertical] of kinds) {
      const cat = new Cat(kind, size);
      this.boards.me.placeCat(cat, { kind, size, x, y, vertical });
      this.boards.me.group.add(cat.group);
      this.showcaseCats.push(cat);
    }
  }

  /** Faz o gato da vitrine pular (toque na tela inicial). */
  pokeShowcase() {
    const cat = this.showcaseCats[Math.floor(Math.random() * this.showcaseCats.length)];
    if (!cat) return;
    cat.scare();
    sound.meow(cat.kind);
  }

  // ---------- animações de jogo ----------
  private popIn(obj: THREE.Object3D, dur = 0.35) {
    const base = obj.scale.clone();
    void this.tweens.tween(dur, (t) => obj.scale.copy(base).multiplyScalar(Math.max(0.001, t)), ease.outBack);
  }

  wait(s: number) {
    return this.tweens.wait(s);
  }

  /** Novelo de lã caindo sobre a casa atacada. */
  async dropProjectile(side: Side, x: number, y: number) {
    const b = this.boards[side];
    const target = b.cellPos(x, y);
    const ball = new THREE.Group();
    const core = new THREE.Mesh(GEO.roundBall, mat('#f08a9a'));
    core.castShadow = true;
    ball.add(core);
    const wrap = new THREE.Mesh(new THREE.TorusGeometry(1, 0.12, 4, 12), mat('#d96b7e'));
    wrap.rotation.x = 1.2;
    ball.add(wrap);
    ball.scale.setScalar(0.28);
    b.group.add(ball);
    const from = target.clone().add(new THREE.Vector3(side === 'enemy' ? 0 : 0, 9, side === 'enemy' ? 7 : -7));
    await this.tweens.tween(0.55, (t) => {
      ball.position.lerpVectors(from, target, t);
      ball.position.y = THREE.MathUtils.lerp(from.y, 0.25, t) + Math.sin(t * Math.PI) * 2;
      ball.rotation.x += 0.3;
      ball.rotation.z += 0.2;
    }, ease.inCubic);
    b.group.remove(ball);
    wrap.geometry.dispose();
  }

  /** Resultado de um ataque (direto ou da explosão) numa casa. */
  async impact(side: Side, x: number, y: number, result: 'miss' | 'hit' | 'sunk' | 'trap' | 'ignored', ship?: ShipKind, sunkShip?: ShipView) {
    const b = this.boards[side];
    const pos = b.worldCell(x, y);
    if (result === 'ignored') {
      this.puff(pos, '#d8d0e0', 6);
      return;
    }
    if (result === 'miss') {
      sound.splash();
      this.splash(pos);
      this.addMark(side, { x, y, type: 'miss' });
      await this.wait(0.45);
      return;
    }
    if (result === 'trap') {
      this.addMark(side, { x, y, type: 'trap' });
      const bottle = b.repellents.get(`${x},${y}`);
      if (bottle) {
        b.group.remove(bottle);
        b.repellents.delete(`${x},${y}`);
      }
      return;
    }
    // acerto
    this.sparks(pos, '#ffb347');
    this.addMark(side, { x, y, type: 'hit' }, result === 'sunk');
    this.addShake(0.15);
    const kind = ship ?? sunkShip?.kind;
    if (!kind) return;
    let cat = b.cats.get(kind);
    let temp: Cat | null = null;
    if (!cat) {
      // tabuleiro adversário: um gatinho espia assustado da casa atingida
      temp = new Cat(kind, 1);
      b.cellPos(x, y, temp.group.position);
      temp.group.rotation.y = -Math.PI / 2; // olhando para a câmera
      b.group.add(temp.group);
      this.popIn(temp.group, 0.2);
      cat = temp;
    }
    cat.scare();
    sound.meow(kind, false);
    await this.wait(0.95);
    if (temp) {
      const g = temp.group;
      await this.tweens.tween(0.25, (t) => g.scale.setScalar(Math.max(0.001, 1 - t)));
      b.group.remove(g);
      temp.dispose();
    }
    if (result === 'sunk' && sunkShip) {
      await this.flee(side, sunkShip);
    }
  }

  /** Gato eliminado: miado forte, pula e foge para fora da mesa, caindo. */
  async flee(side: Side, ship: ShipView) {
    const b = this.boards[side];
    let cat = b.cats.get(ship.kind);
    if (!cat) {
      cat = new Cat(ship.kind, ship.size);
      b.placeCat(cat, ship);
      b.group.add(cat.group);
      this.popIn(cat.group, 0.25);
      await this.wait(0.25);
    }
    b.cats.delete(ship.kind);
    for (const c of ship.vertical ? range(ship.size).map((i) => ({ x: ship.x, y: ship.y + i })) : range(ship.size).map((i) => ({ x: ship.x + i, y: ship.y }))) {
      this.addMark(side, { x: c.x, y: c.y, type: 'hit' }, true);
    }
    sound.meow(ship.kind, true);
    cat.scare(1.2);
    cat.excitement = 3;
    await this.wait(1.0);
    const g = cat.group;
    const start = g.position.clone();
    const dirX = start.x >= 0 ? 1 : -1;
    const startRot = g.rotation.y;
    const targetRot = dirX > 0 ? 0 : Math.PI;
    await this.tweens.tween(0.2, (t) => (g.rotation.y = THREE.MathUtils.lerp(startRot, targetRot, t)));
    const runDist = this.n / 2 + 3.5 - start.x * dirX;
    await this.tweens.tween(0.85, (t) => {
      g.position.x = start.x + dirX * runDist * t;
      g.position.y = Math.abs(Math.sin(t * Math.PI * 5)) * 0.35;
    }, ease.inCubic);
    // cai da mesa
    const fallStart = g.position.clone();
    await this.tweens.tween(0.55, (t) => {
      g.position.x = fallStart.x + dirX * t * 1.2;
      g.position.y = fallStart.y - t * t * 5;
      g.rotation.z = -dirX * t * 2.5;
      g.scale.setScalar(Math.max(0.001, 1 - t * 0.6));
    });
    b.group.remove(g);
    cat.dispose();
  }

  /** Explosão do repelente na casa (x, y) do tabuleiro `side`. */
  async explode(side: Side, x: number, y: number) {
    const b = this.boards[side];
    const pos = b.worldCell(x, y);
    sound.boom();
    this.addShake(0.9);
    // clarão
    const flash = new THREE.Mesh(GEO.roundBall, new THREE.MeshBasicMaterial({ color: '#fff2a6', transparent: true, opacity: 0.9, depthWrite: false }));
    flash.position.copy(pos).setY(0.5);
    this.scene.add(flash);
    void this.tweens.tween(0.5, (t) => {
      flash.scale.setScalar(0.3 + t * 2.2);
      (flash.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t);
    }, ease.outCubic).then(() => {
      this.scene.remove(flash);
      flash.material.dispose();
    });
    // partículas em cruz
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
    const colors = ['#b9a4e8', '#f59bb8', '#fff2a6', '#ffffff'];
    for (const [dx, dz] of dirs) {
      for (let i = 0; i < 9; i++) {
        const speed = 3 + Math.random() * 5;
        this.spawn(pos.clone().setY(0.4), new THREE.Vector3(dx * speed + (Math.random() - 0.5) * 0.6, 1.5 + Math.random() * 2.5, dz * speed + (Math.random() - 0.5) * 0.6), colors[i % colors.length]!, 0.09 + Math.random() * 0.08, 0.7 + Math.random() * 0.3, 6);
      }
    }
    this.puff(pos, '#e9defa', 14);
    await this.wait(0.55);
  }

  /** Faíscas viajando do repelente até as casas atingidas no outro tabuleiro. */
  async crossWave(fromSide: Side, x: number, y: number, toSide: Side, cells: Cell[]) {
    const from = this.boards[fromSide].worldCell(x, y).setY(0.6);
    const tos = cells.map((c) => this.boards[toSide].worldCell(c.x, c.y).setY(0.3));
    const center = this.boards[toSide].worldCell(x, y).setY(0.3);
    const orbs = tos.map(() => {
      const m = new THREE.Mesh(GEO.ball, new THREE.MeshBasicMaterial({ color: '#c6a8ff' }));
      m.scale.setScalar(0.22);
      this.scene.add(m);
      return m;
    });
    const tmp = new THREE.Vector3();
    await this.tweens.tween(0.75, (t) => {
      orbs.forEach((m, i) => {
        // sobe, viaja até o centro da cruz no outro tabuleiro e se espalha
        const mid = t < 0.7 ? t / 0.7 : 1;
        const spread = t < 0.7 ? 0 : (t - 0.7) / 0.3;
        tmp.lerpVectors(from, center, mid);
        tmp.y += Math.sin(mid * Math.PI) * 4;
        tmp.lerp(tos[i]!, spread);
        m.position.copy(tmp);
        m.rotation.x += 0.4;
        if (Math.random() < 0.5) this.spawn(tmp.clone(), new THREE.Vector3((Math.random() - 0.5) * 0.5, 0.3, (Math.random() - 0.5) * 0.5), '#e9dcff', 0.06, 0.35, 0);
      });
    }, ease.inOutSine);
    orbs.forEach((m) => {
      this.scene.remove(m);
      (m.material as THREE.Material).dispose();
    });
    this.addShake(0.5);
    for (const p of tos) this.puff(p, '#c6a8ff', 8);
  }

  /** Spray ao esconder um repelente. */
  sprayAt(cell: Cell) {
    const pos = this.boards.me.worldCell(cell.x, cell.y);
    sound.spray();
    this.puff(pos, '#e5dcff', 10);
  }

  private splash(pos: THREE.Vector3) {
    const ring = new THREE.Mesh(GEO.ring, new THREE.MeshBasicMaterial({ color: '#7cc3ee', transparent: true, depthWrite: false }));
    ring.position.copy(pos).setY(0.05);
    this.scene.add(ring);
    void this.tweens.tween(0.6, (t) => {
      ring.scale.setScalar(0.2 + t * 0.9);
      (ring.material as THREE.MeshBasicMaterial).opacity = 1 - t;
    }, ease.outCubic).then(() => {
      this.scene.remove(ring);
      ring.material.dispose();
    });
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      this.spawn(pos.clone().setY(0.1), new THREE.Vector3(Math.cos(a) * 1.3, 3 + Math.random() * 2, Math.sin(a) * 1.3), i % 2 ? '#8fd0f5' : '#d4efff', 0.07, 0.6, 12);
    }
  }

  private sparks(pos: THREE.Vector3, color: string) {
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 1.5 + Math.random() * 2.5;
      this.spawn(pos.clone().setY(0.4), new THREE.Vector3(Math.cos(a) * s, 2 + Math.random() * 3, Math.sin(a) * s), i % 3 ? color : '#fff6c2', 0.07, 0.5, 9);
    }
  }

  private puff(pos: THREE.Vector3, color: string, count: number) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const p = this.spawn(pos.clone().setY(0.25), new THREE.Vector3(Math.cos(a) * 0.8, 0.8 + Math.random(), Math.sin(a) * 0.8), color, 0.18 + Math.random() * 0.12, 0.7, -0.5);
      p.shrink = true;
    }
  }

  private spawn(pos: THREE.Vector3, vel: THREE.Vector3, color: string, size: number, life: number, gravity: number): Particle {
    const mesh = new THREE.Mesh(GEO.tetra, mat(color, { emissive: color, rough: 1 }));
    mesh.position.copy(pos);
    mesh.scale.setScalar(size);
    this.scene.add(mesh);
    const p: Particle = { mesh, vel, life, maxLife: life, gravity, spin: new THREE.Vector3(Math.random() * 8, Math.random() * 8, 0), shrink: true };
    this.particles.push(p);
    return p;
  }

  // ---------- loop ----------
  private frame() {
    const dt = Math.min(0.05, this.clock.getDelta()) * this.speed;
    this.time += dt;
    this.tweens.tick(dt);

    for (const b of Object.values(this.boards)) {
      for (const c of b.cats.values()) c.update(this.time, dt);
      if (b.highlight.visible) {
        const arrow = b.highlight.getObjectByName('arrow')!;
        arrow.position.y = 0.9 + Math.sin(this.time * 5) * 0.15;
        arrow.rotation.y += dt * 2;
        ((b.highlight.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.45 + Math.sin(this.time * 6) * 0.15;
      }
      let i = 0;
      for (const bottle of b.repellents.values()) {
        bottle.rotation.y = Math.sin(this.time * 1.5 + i++) * 0.3;
      }
    }
    for (const c of this.showcaseCats) c.update(this.time, dt);

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!;
      p.life -= dt;
      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        this.particles.splice(i, 1);
        continue;
      }
      p.vel.y -= p.gravity * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.rotation.x += p.spin.x * dt;
      p.mesh.rotation.y += p.spin.y * dt;
      if (p.shrink) p.mesh.scale.multiplyScalar(1 - dt * 1.5);
    }

    // câmera suave
    const d = this.desiredCamera();
    const k = 1 - Math.exp(-dt * 3.2);
    this.camPos.lerp(d.pos, k);
    this.camLook.lerp(d.look, k);
    this.camera.position.copy(this.camPos);
    if (this.shake > 0.001) {
      const s = this.shake * 0.35;
      this.camera.position.add(new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s));
      this.shake *= Math.exp(-dt * 6);
    }
    this.camera.lookAt(this.camLook);
    this.updateViewOffset();

    this.renderer.render(this.scene, this.camera);
    this.adaptQuality(dt);
  }

  /** Reduz a resolução se o aparelho não estiver aguentando ~60fps. */
  private adaptQuality(dt: number) {
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 90) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes = [];
    if (avg > 1 / 45 && this.pixelRatio > 1) {
      this.pixelRatio = Math.max(1, this.pixelRatio - 0.25);
      this.renderer.setPixelRatio(this.pixelRatio);
      this.resize();
    } else if (avg > 1 / 30 && this.renderer.shadowMap.enabled && this.pixelRatio <= 1) {
      this.renderer.shadowMap.enabled = false;
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (m) m.needsUpdate = true;
      });
    }
  }
}

function range(n: number) {
  return Array.from({ length: n }, (_, i) => i);
}

const bakedCache = new Map<string, THREE.Mesh>();

/** Instancia uma malha assada e cacheada (geometria compartilhada, 1 draw call). */
function baked(key: string, build: () => THREE.Group, castShadow: boolean): THREE.Mesh {
  let proto = bakedCache.get(key);
  if (!proto) {
    proto = bake(build().children as THREE.Mesh[], castShadow);
    bakedCache.set(key, proto);
  }
  const m = new THREE.Mesh(proto.geometry, proto.material);
  m.castShadow = castShadow;
  m.receiveShadow = true;
  return m;
}

function makeMarker(type: Mark['type'], sunk: boolean): THREE.Object3D {
  return baked(`mark|${type}|${sunk}`, () => buildMarker(type, sunk), false);
}

function makeBottle(): THREE.Object3D {
  return baked('bottle', buildBottle, true);
}

function buildMarker(type: Mark['type'], sunk: boolean): THREE.Group {
  const g = new THREE.Group();
  if (type === 'miss') {
    const drop = new THREE.Mesh(GEO.disc, mat('#8cc6ea'));
    drop.scale.set(0.3, 0.04, 0.3);
    drop.position.y = 0.02;
    const dot = new THREE.Mesh(GEO.disc, mat('#d8efff'));
    dot.scale.set(0.12, 0.05, 0.12);
    dot.position.set(-0.07, 0.03, -0.07);
    g.add(drop, dot);
  } else if (type === 'hit') {
    // patinha (almofada + dedinhos)
    const color = sunk ? '#b23a52' : '#f06a6a';
    const pad = new THREE.Mesh(GEO.disc, mat(color));
    pad.scale.set(0.2, 0.05, 0.17);
    pad.position.set(0, 0.03, 0.07);
    g.add(pad);
    for (const [x, z] of [[-0.19, -0.06], [-0.07, -0.17], [0.07, -0.17], [0.19, -0.06]] as const) {
      const toe = new THREE.Mesh(GEO.disc, mat(color));
      toe.scale.set(0.07, 0.05, 0.08);
      toe.position.set(x, 0.03, z);
      g.add(toe);
    }
    // fundo da casa avermelhado: continua visível mesmo com o gato deitado em cima
    const bg = new THREE.Mesh(GEO.plane, mat(sunk ? '#f4b6be' : '#fbd0cc'));
    bg.scale.set(0.92, 1, 0.92);
    bg.position.y = 0.008;
    bg.receiveShadow = true;
    g.add(bg);
  } else {
    // marca de queimado da explosão
    const scorch = new THREE.Mesh(GEO.disc, mat('#5a4b58'));
    scorch.scale.set(0.42, 0.03, 0.42);
    scorch.rotation.y = 0.4;
    scorch.position.y = 0.015;
    g.add(scorch);
    for (let i = 0; i < 4; i++) {
      const shard = new THREE.Mesh(GEO.tetra, mat(i % 2 ? '#b9a4e8' : '#8e7fb0'));
      const a = (i / 4) * Math.PI * 2 + 0.3;
      shard.scale.setScalar(0.07);
      shard.position.set(Math.cos(a) * 0.22, 0.05, Math.sin(a) * 0.22);
      shard.rotation.set(a, a * 2, 0);
      g.add(shard);
    }
  }
  return g;
}

function buildBottle(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(GEO.cyl, mat('#b9a4e8'));
  body.scale.set(0.17, 0.42, 0.17);
  body.position.y = 0.21;
  body.castShadow = true;
  const label = new THREE.Mesh(GEO.cyl, mat('#ffffff'));
  label.scale.set(0.176, 0.14, 0.176);
  label.position.y = 0.22;
  const shoulder = new THREE.Mesh(GEO.cone, mat('#b9a4e8'));
  shoulder.scale.set(0.17, 0.12, 0.17);
  shoulder.position.y = 0.48;
  const cap = new THREE.Mesh(GEO.cyl, mat('#f59bb8'));
  cap.scale.set(0.07, 0.12, 0.07);
  cap.position.y = 0.58;
  const nozzle = new THREE.Mesh(GEO.box, mat('#f59bb8'));
  nozzle.scale.set(0.12, 0.05, 0.05);
  nozzle.position.set(0.07, 0.6, 0);
  // gotinha "X" de proibido gato no rótulo
  const dot = new THREE.Mesh(GEO.disc, mat('#ff8fa3'));
  dot.scale.set(0.06, 0.02, 0.06);
  dot.rotation.x = Math.PI / 2;
  dot.position.set(0, 0.22, 0.18);
  g.add(body, label, shoulder, cap, nozzle, dot);
  return g;
}
