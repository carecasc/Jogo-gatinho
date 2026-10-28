/**
 * Gatinhos low poly construídos só com primitivas do Three.js.
 * Cada gato é montado deitado/espreguiçado ao longo do eixo +X local
 * (cabeça em +X), ocupando `length` casas de 1 unidade.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ShipKind } from '../../../server/src/protocol';

interface CatLook {
  body: string;
  belly: string;
  points?: string; // orelhas/focinho/patas/rabo (siamês)
  stripes?: string;
  patches?: string[];
  iris: string;
  nose: string;
  bodyW: number;
  bodyH: number;
  headR: number;
}

export const CAT_LOOKS: Record<ShipKind, CatLook> = {
  gordo: { body: '#f6b98c', belly: '#fde7d2', stripes: '#e48f5c', iris: '#a6d672', nose: '#e88a8a', bodyW: 0.47, bodyH: 0.4, headR: 0.41 },
  siames: { body: '#f5e9d8', belly: '#fffaf2', points: '#7d605a', iris: '#76c1f2', nose: '#7d605a', bodyW: 0.33, bodyH: 0.3, headR: 0.35 },
  malhado: { body: '#fbf7f1', belly: '#ffffff', patches: ['#f4b27d', '#9c97aa'], iris: '#e8c45c', nose: '#f19aa7', bodyW: 0.37, bodyH: 0.33, headR: 0.37 },
  preto: { body: '#4f4b5f', belly: '#67637a', iris: '#f4d46a', nose: '#8d7183', bodyW: 0.36, bodyH: 0.32, headR: 0.37 },
  filhote: { body: '#d3c6ec', belly: '#fbf8ff', iris: '#6aa6dc', nose: '#f3a0b5', bodyW: 0.3, bodyH: 0.26, headR: 0.36 },
};

/** Cor principal de cada gato (usada também na interface). */
export const catColor = (kind: ShipKind) => CAT_LOOKS[kind].points ?? CAT_LOOKS[kind].body;

// ---- geometrias e materiais compartilhados ----
const GEO = {
  ball: new THREE.IcosahedronGeometry(1, 1),
  lowBall: new THREE.IcosahedronGeometry(1, 0),
  cone: new THREE.ConeGeometry(1, 1, 4),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 6).rotateZ(Math.PI / 2), // eixo em X
  box: new THREE.BoxGeometry(1, 1, 1),
};
// cilindro do rabo com origem na base (eixo X de 0 a 1)
const TAIL_GEO = new THREE.CylinderGeometry(0.8, 1, 1, 6).rotateZ(Math.PI / 2).translate(0.5, 0, 0);

const matCache = new Map<string, THREE.MeshStandardMaterial>();
export function mat(color: string, opts: { emissive?: string; rough?: number } = {}) {
  const k = `${color}|${opts.emissive ?? ''}|${opts.rough ?? ''}`;
  let m = matCache.get(k);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      flatShading: true,
      roughness: opts.rough ?? 0.85,
      metalness: 0,
      emissive: opts.emissive ?? '#000000',
    });
    matCache.set(k, m);
  }
  return m;
}

const vertexColorMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0 });

/**
 * Junta várias partes estáticas numa única malha com cores por vértice
 * (1 draw call em vez de várias — importante para celulares).
 */
export function bake(meshes: THREE.Mesh[], castShadow = true): THREE.Mesh {
  const geos = meshes.map((m) => {
    m.updateMatrix();
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    g.deleteAttribute('uv');
    g.applyMatrix4(m.matrix);
    const c = (m.material as THREE.MeshStandardMaterial).color;
    const n = g.attributes.position!.count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return g;
  });
  const mesh = new THREE.Mesh(mergeGeometries(geos)!, vertexColorMat);
  geos.forEach((g) => g.dispose());
  mesh.castShadow = castShadow;
  return mesh;
}

function part(geo: THREE.BufferGeometry, color: string, sx: number, sy: number, sz: number, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat(color));
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

export class Cat {
  /** Raiz: posicionada no centro do gato no tabuleiro. */
  readonly group = new THREE.Group();
  /** Rig interno usado para pulos/sustos sem perder a posição base. */
  readonly rig = new THREE.Group();
  private body!: THREE.Mesh;
  private bodyScale = new THREE.Vector3();
  private head = new THREE.Group();
  private headY = 0;
  private eyes: THREE.Group[] = [];
  private pupils: THREE.Mesh[] = [];
  private ears: THREE.Group[] = [];
  private tail: THREE.Group[] = [];
  private tailMeshes: Array<{ mesh: THREE.Mesh; base: THREE.Vector3 }> = [];
  private tailRoot = new THREE.Group();
  private phase = Math.random() * 100;
  private nextBlink = 1 + Math.random() * 3;
  private blinkT = -1;
  private scareT = -1;
  private scareDur = 0.9;
  /** Multiplicador do balanço do rabo (gatos em fuga balançam mais). */
  excitement = 1;
  /** Giro da cabeça para olhar a câmera (gatos na horizontal olham de ¾). */
  faceYaw = 0;

  constructor(
    readonly kind: ShipKind,
    readonly length: number,
  ) {
    this.group.add(this.rig);
    this.build();
  }

  private build() {
    const L = this.length;
    const look = CAT_LOOKS[this.kind];
    const s = L <= 1 ? 0.75 : 1;
    const bodyW = look.bodyW * s;
    const bodyH = look.bodyH * s;
    const headR = look.headR * s;
    const pts = look.points ?? look.body;
    const total = L * 0.9;
    const headX = total / 2 - headR * 0.9;
    const rearX = -total / 2 + 0.12;
    const frontX = headX - headR * 0.4;
    const bodyLen = Math.max(0.35, frontX - rearX + 0.1);
    const bodyCx = (frontX + rearX) / 2;

    const rigStatic: THREE.Mesh[] = [];
    const headStatic: THREE.Mesh[] = [];

    // corpo deitado (separado: anima a respiração)
    this.body = part(GEO.ball, look.body, bodyLen / 2, bodyH, bodyW, bodyCx, bodyH * 0.92, 0);
    this.bodyScale.copy(this.body.scale);
    this.rig.add(this.body);
    // peito/barriga clarinho
    rigStatic.push(part(GEO.ball, look.belly, Math.min(0.3, bodyLen * 0.25), bodyH * 0.75, bodyW * 0.8, frontX - 0.05, bodyH * 0.8, 0));

    // seção do corpo (0..1) numa posição x — usada para listras/manchas abraçarem o corpo
    const section = (x: number) => Math.sqrt(Math.max(0.05, 1 - ((x - bodyCx) / (bodyLen / 2)) ** 2));
    // quadril arredondado
    const hipX = rearX + Math.min(0.32, bodyLen * 0.22);
    rigStatic.push(part(GEO.ball, look.body, Math.min(0.36, bodyLen * 0.28), bodyH * 1.02, bodyW * 1.04, hipX, bodyH * 0.95, 0));

    if (look.stripes) {
      const n = Math.max(2, Math.round(bodyLen / 0.38));
      for (let i = 0; i < n; i++) {
        const x = rearX + 0.3 + (i * (bodyLen - 0.55)) / Math.max(1, n - 1);
        const f = section(x) * 1.04;
        rigStatic.push(part(GEO.ball, look.stripes, 0.06, bodyH * f, bodyW * f, x, bodyH * 0.92 + 0.004, 0));
      }
    }
    if (look.patches) {
      look.patches.forEach((c, i) => {
        const x = bodyCx + (i === 0 ? -bodyLen * 0.18 : bodyLen * 0.16);
        const f = section(x);
        const z = i === 0 ? bodyW * 0.2 : -bodyW * 0.25;
        rigStatic.push(part(GEO.ball, c, bodyLen * 0.2, bodyH * 0.25, bodyW * 0.55 * f, x, bodyH * 0.92 + bodyH * f * 0.86, z));
      });
    }

    // patas da frente esticadas
    const pawR = bodyW * 0.26;
    const pawFront = headX + headR * 0.95;
    const pawLen = pawFront - (frontX - 0.15);
    for (const side of [-1, 1]) {
      rigStatic.push(part(GEO.cyl, look.body, pawLen, pawR, pawR, frontX - 0.15 + pawLen / 2, pawR, side * bodyW * 0.5));
      rigStatic.push(part(GEO.ball, look.points ? pts : look.belly, pawR * 1.25, pawR * 0.9, pawR * 1.15, pawFront, pawR * 0.9, side * bodyW * 0.5));
      // coxas traseiras
      rigStatic.push(part(GEO.ball, look.body, Math.min(0.24, bodyLen * 0.22), bodyH * 0.75, 0.1, rearX + 0.18, bodyH * 0.72, side * bodyW * 0.88));
      rigStatic.push(part(GEO.ball, look.points ? pts : look.belly, 0.14, 0.06, 0.07, rearX + 0.32, 0.06, side * bodyW * 1.0));
    }

    // cabeça
    this.headY = bodyH * 1.45 + headR * 0.35;
    this.head.position.set(headX, this.headY, 0);
    this.rig.add(this.head);
    headStatic.push(part(GEO.ball, look.body, headR * 0.95, headR * 0.85, headR, 0, 0, 0));
    // bochechas / focinho
    headStatic.push(part(GEO.ball, look.points ? pts : look.belly, headR * 0.35, headR * 0.32, headR * 0.55, headR * 0.72, -headR * 0.32, 0));
    headStatic.push(part(GEO.cone, look.nose, headR * 0.12, headR * 0.12, headR * 0.12, headR * 1.03, -headR * 0.14, 0).rotateZ(Math.PI / 2 + Math.PI));
    // olhos
    for (const side of [-1, 1]) {
      const eye = new THREE.Group();
      eye.position.set(headR * 0.74, headR * 0.12, side * headR * 0.42);
      eye.rotation.y = side * -0.45;
      const irisR = headR * (this.kind === 'filhote' ? 0.27 : 0.22);
      const iris = part(GEO.ball, look.iris, irisR * 0.5, irisR, irisR, 0, 0, 0);
      const pupil = part(GEO.ball, '#2a2230', irisR * 0.3, irisR * 0.85, irisR * 0.32, irisR * 0.3, 0, 0);
      this.pupils.push(pupil);
      eye.add(pupil);
      eye.add(bake([iris, part(GEO.lowBall, '#ffffff', irisR * 0.15, irisR * 0.2, irisR * 0.2, irisR * 0.45, irisR * 0.4, irisR * 0.25)], false));
      this.eyes.push(eye);
      this.head.add(eye);
      // orelhas
      const ear = new THREE.Group();
      ear.position.set(-headR * 0.1, headR * 0.62, side * headR * 0.52);
      ear.rotation.x = side * 0.38;
      ear.add(bake([part(GEO.cone, pts, headR * 0.42, headR * 0.65, headR * 0.3, 0, headR * 0.3, 0), part(GEO.cone, '#f6b6c2', headR * 0.24, headR * 0.42, headR * 0.12, headR * 0.12, headR * 0.24, 0)]));
      this.ears.push(ear);
      this.head.add(ear);
      // bigodes
      for (const a of [-0.2, 0.15]) {
        const w = part(GEO.box, '#ffffff', headR * 0.9, 0.012, 0.012, headR * 0.85, -headR * 0.3 + a * 0.2, side * headR * 0.6);
        w.rotation.set(0, side * -0.5, a);
        headStatic.push(w);
      }
    }
    this.rig.add(bake(rigStatic));
    this.head.add(bake(headStatic));

    // rabo: correntinha de segmentos
    const tailR = bodyW * 0.22;
    const segLen = L <= 2 ? 0.16 : 0.2 + Math.min(0.06, (L - 3) * 0.03);
    this.tailRoot.position.set(rearX - 0.02, bodyH * 0.55, 0);
    this.tailRoot.rotation.y = Math.PI;
    this.rig.add(this.tailRoot);
    let parent: THREE.Object3D = this.tailRoot;
    const segs = 6;
    for (let i = 0; i < segs; i++) {
      const g = new THREE.Group();
      if (i > 0) g.position.x = segLen * 0.92;
      const r = tailR * (1 - i * 0.08);
      const color = look.points ?? (look.stripes && i % 2 === 1 ? look.stripes : i === segs - 1 && this.kind === 'malhado' ? look.patches![0]! : look.body);
      const mesh = part(TAIL_GEO, color, segLen, r, r);
      this.tailMeshes.push({ mesh, base: mesh.scale.clone() });
      g.add(mesh);
      parent.add(g);
      this.tail.push(g);
      parent = g;
    }
  }

  /** Libera as geometrias exclusivas deste gato (as partes assadas). */
  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.material === vertexColorMat) m.geometry.dispose();
    });
  }

  /** Susto (gato atingido). */
  scare(duration = 0.9) {
    this.scareT = 0;
    this.scareDur = duration;
  }

  get scared() {
    return this.scareT >= 0;
  }

  update(time: number, dt: number) {
    const t = time + this.phase;
    // respiração
    const breath = Math.sin(t * 2.2) * 0.035;
    this.body.scale.set(this.bodyScale.x, this.bodyScale.y * (1 + breath), this.bodyScale.z * (1 + breath * 0.6));

    // susto
    let k = 0;
    if (this.scareT >= 0) {
      this.scareT += dt;
      const p = this.scareT / this.scareDur;
      if (p >= 1) this.scareT = -1;
      else k = Math.sin(Math.PI * Math.min(1, p * 1.15));
    }
    this.rig.position.y = k * 0.55;
    this.rig.rotation.x = k * Math.sin(this.scareT * 40) * 0.08; // tremidinha
    const puff = 1 + k * 0.15;
    this.rig.scale.set(puff, puff, puff);

    // cabeça
    this.head.position.y = this.headY + Math.sin(t * 2.2) * 0.012;
    this.head.rotation.x = Math.sin(t * 0.6) * 0.1 * (1 - k);
    this.head.rotation.z = Math.sin(t * 0.45) * 0.06 + k * 0.25;
    this.head.rotation.y = this.faceYaw * (1 - k) + Math.sin(t * 0.33) * 0.12;
    for (const [i, ear] of this.ears.entries()) {
      const side = i === 0 ? -1 : 1;
      ear.rotation.x = side * (0.38 + k * 0.9);
      ear.rotation.z = Math.max(0, Math.sin(t * 3.1 + i) - 0.97) * 6 * 0.3; // tremelique ocasional
    }

    // piscar
    this.nextBlink -= dt;
    if (this.nextBlink <= 0 && this.blinkT < 0) {
      this.blinkT = 0;
      this.nextBlink = 2 + Math.random() * 4;
    }
    let lid = 1;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      lid = Math.abs(Math.cos((this.blinkT / 0.16) * Math.PI));
      if (this.blinkT > 0.16) this.blinkT = -1;
    }
    for (const e of this.eyes) e.scale.set(1 + k * 0.4, Math.max(0.08, lid) * (1 + k * 0.5), 1 + k * 0.4);
    for (const p of this.pupils) p.scale.z = p.scale.y * (0.38 + k * 0.6);

    // rabo
    const n = this.tail.length;
    for (let i = 0; i < n; i++) {
      const seg = this.tail[i]!;
      const wag = Math.sin(t * 2.6 * this.excitement - i * 0.7) * 0.2 * (0.3 + i / n) * this.excitement;
      const restPitch = i === 0 ? -0.55 : i < 3 ? 0.2 : 0.05;
      const restYaw = i === 0 ? 0.3 : 0.28;
      seg.rotation.z = THREE.MathUtils.lerp(restPitch, i === 0 ? 1.35 : -0.05, k);
      seg.rotation.y = THREE.MathUtils.lerp(restYaw + wag, Math.sin(this.scareT * 30 + i) * 0.1, k);
      // rabo eriçado: escala só a malha (não o grupo, senão acumula na hierarquia)
      const fluff = 1 + k * 0.9;
      const tm = this.tailMeshes[i]!;
      tm.mesh.scale.set(tm.base.x, tm.base.y * fluff, tm.base.z * fluff);
    }
  }
}
