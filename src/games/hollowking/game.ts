/**
 * HOLLOWKING
 *
 * A third-person boss fight where the dodge is the entire game. One arena, one
 * enormous multi-part boss, three phases, and a dash that rewards you for
 * moving INTO the thing trying to kill you.
 *
 * The design intent is bait. The boss never stops spraying, so there is always
 * something worth dashing through; a dash that passes close to a live threat
 * while its i-frames are up is a PERFECT DODGE — hit-stop, a white ring, a
 * semitone-higher ping, +1 chain, and triple damage for 2.5s. Perfect dodges
 * fill a focus meter that drains if you play safe, and filling it BREACHES:
 * the world drops to a fifth speed, colour drains out, every core cracks open
 * and you get three seconds of quadruple damage to delete a phase.
 *
 * Rendered with three.js. No lights at all — every surface is an emissive
 * MeshBasicMaterial and the whole sense of illumination comes from hdr()
 * colours plus bloom. The hull is deliberately left under the bloom threshold
 * so it stays a dark mass with light bleeding out of its joints.
 */

import * as THREE from "three";
import type { PostStack } from "@/engine/gl/post";
import { glowTexture, hdr, makePost, ringTexture } from "@/engine/gl/post";
import { InstancePool, Particles } from "@/engine/gl/pool";
import { Shake, TimeWarp } from "@/engine/gl/shake";
import { Overlay, glowText, roundRectPath } from "@/engine/gl/overlay";
import {
  TAU,
  angleDelta,
  clamp,
  clamp01,
  damp,
  easeOutCubic,
  easeOutQuart,
  lerp,
} from "@/engine/math";
import type { GameContext, GameFactory, GameInstance } from "@/games/types";

// --- tuning -----------------------------------------------------------------

const ARENA = 29;
const PLANE_Y = 1.0;
const BOSS_Y = 8.2;

const GRID = 12;
const TILE_PITCH = 4.9;

const MAX_BULLETS = 900;
const MAX_TRACERS = 300;
const MAX_ORBS = 28;
const MAX_PILLARS = 26;
const MAX_RINGS = 20;
const MAX_DISCS = 80;
const MAX_DMG = 48;
const MAX_BEAMS = 2;

const BOSS_HP = 13000;
const PLATES = 6;
const PLATE_HP = 780;
const PLATE_ORBIT = 9.4;

const PLAYER_R = 0.34;
const PLAYER_SPEED = 13.5;
const GRAZE_R = 1.05;
const BULLET_R = 0.24;
const BULLET_VIS = 0.32;

const DASH_SPEED = 46;
const DASH_TIME = 0.2;
const DASH_IFRAME = 0.26;
const DASH_CD = 0.62;
const DASH_CHARGES = 2;

const FIRE_AUTO = 1 / 7.5;
const FIRE_HELD = 1 / 13;
const TRACER_SPEED = 62;
const CORE_R = 0.85;

const EDGE_TIME = 2.5;
const BREACH_TIME = 3.0;

const HEARTS = 4;

// Attack ids.
const A_RING = 0;
const A_SWEEP = 1;
const A_ORBS = 2;
const A_SLAM = 3;
const A_PILLARS = 4;
const A_CHARGE = 5;
const A_HOLLOW = 6;

interface Palette {
  skyTop: number;
  skyBot: number;
  fog: number;
  tile: number;
  seam: number;
  seamG: number;
  rim: number;
  rimG: number;
  hull: number;
  hullG: number;
  crown: number;
  crownG: number;
  eye: number;
  eyeG: number;
  core: number;
  coreG: number;
  bullet: number;
  bulletG: number;
  beam: number;
  beamG: number;
  tracer: number;
  tracerG: number;
  rib: number;
  hudAccent: string;
}

const PALETTES: Palette[] = [
  {
    skyTop: 0x0b1420, skyBot: 0x04060c, fog: 0x061220,
    tile: 0x0d1826, seam: 0x1b4a6b, seamG: 1.5,
    rim: 0x2ad4ff, rimG: 2.2,
    hull: 0x6f8399, hullG: 0.36,
    crown: 0x8fd8ff, crownG: 2.6,
    eye: 0x4fe6ff, eyeG: 3.6,
    core: 0x4fe6ff, coreG: 4.0,
    bullet: 0xff4d6a, bulletG: 2.8,
    beam: 0xff2d55, beamG: 3.2,
    tracer: 0xa8ff5a, tracerG: 3.4,
    rib: 0x1d4763,
    hudAccent: "#4fe6ff",
  },
  {
    skyTop: 0x1e0d04, skyBot: 0x0a0503, fog: 0x1a0a03,
    tile: 0x241206, seam: 0x7a3208, seamG: 1.7,
    rim: 0xff8a1f, rimG: 2.4,
    hull: 0x99765f, hullG: 0.38,
    crown: 0xffb24d, crownG: 3.0,
    eye: 0xffc24a, eyeG: 3.8,
    core: 0xffd24a, coreG: 4.4,
    bullet: 0xff6a1f, bulletG: 3.0,
    beam: 0xff3d12, beamG: 3.3,
    tracer: 0x7ef0ff, tracerG: 3.4,
    rib: 0x5c2a0b,
    hudAccent: "#ffb24d",
  },
  {
    skyTop: 0x1c0a2c, skyBot: 0x08030e, fog: 0x140725,
    tile: 0x1c0a2c, seam: 0x7b2fd6, seamG: 1.9,
    rim: 0xe08cff, rimG: 2.8,
    hull: 0x8d7aa8, hullG: 0.42,
    crown: 0xe08cff, crownG: 3.4,
    eye: 0xffffff, eyeG: 4.6,
    core: 0xffffff, coreG: 5.5,
    bullet: 0xff2fd0, bulletG: 3.2,
    beam: 0xff2fd0, beamG: 3.4,
    tracer: 0xffffff, tracerG: 3.8,
    rib: 0x4a1d7a,
    hudAccent: "#e08cff",
  },
];

type Mode = "attract" | "intro" | "playing" | "dead" | "won";

interface Attack {
  kind: number;
  t: number;
  tell: number;
  dur: number;
  step: number;
  ang: number;
  n: number;
  live: boolean;
}

interface Callout {
  text: string;
  t: number;
  life: number;
  size: number;
  color: string;
  live: boolean;
}

const ROMAN = ["I", "II", "III"];

class Hollowking implements GameInstance {
  private readonly c: GameContext;

  // --- three.js -------------------------------------------------------------
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private post!: PostStack;
  private hud!: Overlay;
  private particles!: Particles;

  private skyMat!: THREE.ShaderMaterial;
  private dustMat!: THREE.ShaderMaterial;
  private ribs: THREE.Mesh[] = [];
  private ribMat!: THREE.MeshBasicMaterial;
  private rimMesh!: THREE.Mesh;
  private rimMat!: THREE.MeshBasicMaterial;

  private tilePool!: InstancePool;
  private bulletPool!: InstancePool;
  private tracerPool!: InstancePool;
  private orbPool!: InstancePool;
  private pillarPool!: InstancePool;
  private discPool!: InstancePool;

  private glowTex!: THREE.CanvasTexture;
  private ringTex!: THREE.CanvasTexture;

  // Boss assembly.
  private bossRoot!: THREE.Group;
  private hullMesh!: THREE.Mesh;
  private hullMat!: THREE.MeshBasicMaterial;
  private jawPivot!: THREE.Object3D;
  private jawMat!: THREE.MeshBasicMaterial;
  private crownRoot!: THREE.Object3D;
  private crownMat!: THREE.MeshBasicMaterial;
  private eyeMat!: THREE.MeshBasicMaterial;
  private eyeL!: THREE.Mesh;
  private eyeR!: THREE.Mesh;
  private haloMat!: THREE.MeshBasicMaterial;

  private plateGroups: THREE.Group[] = [];
  private plateMats: THREE.MeshBasicMaterial[] = [];
  private coreMats: THREE.MeshBasicMaterial[] = [];
  private coreMeshes: THREE.Mesh[] = [];

  private beamRoots: THREE.Group[] = [];
  private beamMats: THREE.MeshBasicMaterial[] = [];
  private beamDecalMats: THREE.MeshBasicMaterial[] = [];

  private playerMesh!: THREE.Mesh;
  private playerMat!: THREE.MeshBasicMaterial;
  private playerGlow!: THREE.Sprite;
  private playerGlowMat!: THREE.SpriteMaterial;

  private disposables: Array<{ dispose(): void }> = [];

  // --- timing ---------------------------------------------------------------
  private shake = new Shake();
  private warp = new TimeWarp();
  private time = 0;
  private realTime = 0;
  private w = 1;
  private h = 1;
  private ready = false;

  // --- palette blend --------------------------------------------------------
  private palA = 0;
  private palB = 0;
  private palT = 1;
  private cSeam = new THREE.Color();
  private cTile = new THREE.Color();
  private cRim = new THREE.Color();
  private cHull = new THREE.Color();
  private cCrown = new THREE.Color();
  private cEye = new THREE.Color();
  private cCore = new THREE.Color();
  private cBullet = new THREE.Color();
  private cBeam = new THREE.Color();
  private cTracer = new THREE.Color();
  private cRib = new THREE.Color();
  private cSkyTop = new THREE.Color();
  private cSkyBot = new THREE.Color();
  private cFog = new THREE.Color();
  private _ca = new THREE.Color();
  private _cb = new THREE.Color();
  private _cs = new THREE.Color();
  private _v3 = new THREE.Vector3();
  private _v3b = new THREE.Vector3();

  // --- run state ------------------------------------------------------------
  private mode: Mode = "attract";
  private modeT = 0;
  private score = 0;
  private best = 0;
  private bestBeaten = false;
  private newBestT = 0;
  private reportT = 0;
  private lastReported = -1;

  private phase = 0;
  private phaseT = 0;
  private bossHp = BOSS_HP;
  private bossHpGhost = 1;
  private hearts = HEARTS;
  private platesBroken = 0;

  private chain = 0;
  private chainPeak = 0;
  private chainTimer = 0;
  private chainPunch = 0;
  private chainShatter = 0;
  private mult = 1;

  private focus = 0;
  private edgeT = 0;
  private breachT = 0;
  private breachSlow = 0;

  private hintT = 12;
  private hintDone = false;

  // player
  private px = 0;
  private pz = 16;
  private pvx = 0;
  private pvz = 0;
  private aimX = 0;
  private aimZ = 0;
  private aimAng = 0;
  private fireT = 0;
  private dashT = 0;
  private dashIframe = 0;
  private invuln = 0;
  private dashDirX = 0;
  private dashDirZ = 1;
  private dashCd = [0, 0];
  private dashId = 1;
  private dashDodges = 0;
  private hurtT = 0;
  private deathT = 0;
  private trailX = new Float32Array(14);
  private trailZ = new Float32Array(14);
  private trailHead = 0;

  // boss
  private bx = 0;
  private bz = 0;
  private by = BOSS_Y;
  private bossSpin = 0;
  private bossHitFlash = 0;
  private jawOpen = 0;
  private chargeT = 0;
  private chargeDodge = 0;
  private roarT = 0;
  private sprayT = 0;
  private sprayAng = 0;
  private atkT = 3;
  private hollowTimer = 0;

  private attacks: Attack[] = [];
  private callouts: Callout[] = [];

  // --- entity arrays --------------------------------------------------------
  private ax = new Float32Array(MAX_BULLETS);
  private az = new Float32Array(MAX_BULLETS);
  private avx = new Float32Array(MAX_BULLETS);
  private avz = new Float32Array(MAX_BULLETS);
  private alife = new Float32Array(MAX_BULLETS);
  private atag = new Float32Array(MAX_BULLETS);
  private asz = new Float32Array(MAX_BULLETS);
  private aCount = 0;

  private tx = new Float32Array(MAX_TRACERS);
  private tz = new Float32Array(MAX_TRACERS);
  private tvx = new Float32Array(MAX_TRACERS);
  private tvz = new Float32Array(MAX_TRACERS);
  private tlife = new Float32Array(MAX_TRACERS);
  private tCount = 0;

  private ox = new Float32Array(MAX_ORBS);
  private oz = new Float32Array(MAX_ORBS);
  private ovx = new Float32Array(MAX_ORBS);
  private ovz = new Float32Array(MAX_ORBS);
  private olife = new Float32Array(MAX_ORBS);
  private otag = new Float32Array(MAX_ORBS);
  private oturn = new Float32Array(MAX_ORBS);
  private ododges = new Float32Array(MAX_ORBS);
  private oCount = 0;

  private lx = new Float32Array(MAX_PILLARS);
  private lz = new Float32Array(MAX_PILLARS);
  private lt = new Float32Array(MAX_PILLARS);
  private ltell = new Float32Array(MAX_PILLARS);
  private ltag = new Float32Array(MAX_PILLARS);
  private lCount = 0;

  private rx = new Float32Array(MAX_RINGS);
  private rz = new Float32Array(MAX_RINGS);
  private rr = new Float32Array(MAX_RINGS);
  private rspd = new Float32Array(MAX_RINGS);
  private rlife = new Float32Array(MAX_RINGS);
  private rtag = new Float32Array(MAX_RINGS);
  private rCount = 0;

  private dx = new Float32Array(MAX_DISCS);
  private dz = new Float32Array(MAX_DISCS);
  private dr = new Float32Array(MAX_DISCS);
  private dgrow = new Float32Array(MAX_DISCS);
  private dlife = new Float32Array(MAX_DISCS);
  private dmax = new Float32Array(MAX_DISCS);
  private dcr = new Float32Array(MAX_DISCS);
  private dcg = new Float32Array(MAX_DISCS);
  private dcb = new Float32Array(MAX_DISCS);
  private dCount = 0;

  private beamLive = new Float32Array(MAX_BEAMS);
  private beamAng = new Float32Array(MAX_BEAMS);
  private beamRate = new Float32Array(MAX_BEAMS);
  private beamT = new Float32Array(MAX_BEAMS);
  private beamTell = new Float32Array(MAX_BEAMS);
  private beamDur = new Float32Array(MAX_BEAMS);
  private beamTag = new Float32Array(MAX_BEAMS);

  // damage numbers
  private nX = new Float32Array(MAX_DMG);
  private nY = new Float32Array(MAX_DMG);
  private nZ = new Float32Array(MAX_DMG);
  private nVal = new Float32Array(MAX_DMG);
  private nAge = new Float32Array(MAX_DMG);
  private nLife = new Float32Array(MAX_DMG);
  private nPunch = new Float32Array(MAX_DMG);
  private nTarget = new Float32Array(MAX_DMG);
  private nCrit = new Float32Array(MAX_DMG);
  private nCount = 0;

  // plates
  private plHp = new Float32Array(PLATES);
  private plBroken = new Uint8Array(PLATES);
  private plHit = new Float32Array(PLATES);
  private plX = new Float32Array(PLATES);
  private plY = new Float32Array(PLATES);
  private plZ = new Float32Array(PLATES);
  private plVx = new Float32Array(PLATES);
  private plVy = new Float32Array(PLATES);
  private plVz = new Float32Array(PLATES);
  private plRx = new Float32Array(PLATES);
  private plRy = new Float32Array(PLATES);
  private plRz = new Float32Array(PLATES);
  private plWx = new Float32Array(PLATES);
  private plWy = new Float32Array(PLATES);
  private plWz = new Float32Array(PLATES);
  private plRest = new Uint8Array(PLATES);

  // floor tiles
  private fX = new Float32Array(GRID * GRID);
  private fZ = new Float32Array(GRID * GRID);
  private fY = new Float32Array(GRID * GRID);
  private fVy = new Float32Array(GRID * GRID);
  private fRx = new Float32Array(GRID * GRID);
  private fRz = new Float32Array(GRID * GRID);
  private fVrx = new Float32Array(GRID * GRID);
  private fVrz = new Float32Array(GRID * GRID);
  private fAlive = new Uint8Array(GRID * GRID);
  private fCount = 0;

  // camera rig
  private camYaw = 0;
  private camPos = new THREE.Vector3(0, 22, 34);
  private camLook = new THREE.Vector3(0, 4, 0);
  private camCx = 0;
  private camCz = 0;
  private fov = 58;
  private fovTarget = 58;

  // grade accumulators
  private flashR = 0;
  private flashG = 0;
  private flashB = 0;
  private hitPulse = 0;
  private desatHold = 0;

  // touch
  private stickActive = false;
  private stickId = -1;
  private stickX = 0;
  private stickY = 0;
  private stickCx = 0;
  private stickCy = 0;
  private touchDash = false;

  // music
  private musicBpm = 0;

  constructor(ctx: GameContext) {
    this.c = ctx;
    this.best = ctx.store.get<number>("best", 0);
    for (let i = 0; i < 4; i++) {
      this.attacks.push({ kind: 0, t: 0, tell: 0, dur: 0, step: 0, ang: 0, n: 0, live: false });
    }
    for (let i = 0; i < 6; i++) {
      this.callouts.push({ text: "", t: 0, life: 1, size: 64, color: "#fff", live: false });
    }
    this.initThree();
    this.resetRun(true);
    this.ready = true;
    ctx.report({ status: "idle", score: 0, best: this.best, label: "ATTRACT" });
  }

  // --- setup ----------------------------------------------------------------

  private initThree() {
    const c = this.c;
    this.renderer = new THREE.WebGLRenderer({
      canvas: c.canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.setSize(c.width, c.height, false);
    this.renderer.setClearColor(0x04060c, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x061220, 0.0075);

    this.camera = new THREE.PerspectiveCamera(58, 1, 0.5, 700);
    this.camera.position.set(0, 22, 34);

    this.glowTex = glowTexture(64, 2.4);
    this.ringTex = ringTexture(256, 0.07);
    this.disposables.push(this.glowTex, this.ringTex);

    this.buildSky();
    this.buildFloor();
    this.buildBoss();
    this.buildPools();
    this.buildPlayer();

    this.particles = new Particles(5000, this.glowTex);
    this.scene.add(this.particles.object);

    this.post = makePost(this.renderer, this.scene, this.camera, {
      strength: 1.05,
      radius: 0.62,
      threshold: 0.2,
    });
    this.hud = new Overlay();
  }

  /** Bloom is the frame-cost bottleneck at 200 bullets; cap the buffer. */
  private pixelRatio() {
    const c = this.c;
    const px = c.width * c.height * c.dpr * c.dpr;
    return px > 4.2e6 ? Math.min(c.dpr, 1.75) : c.dpr;
  }

  private buildSky() {
    const skyGeo = new THREE.SphereGeometry(300, 24, 16);
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTop: { value: new THREE.Color(0x0b1420) },
        uBot: { value: new THREE.Color(0x04060c) },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vPos;
        void main() {
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop; uniform vec3 uBot; uniform float uTime;
        varying vec3 vPos;
        void main() {
          vec3 n = normalize(vPos);
          float h = clamp(n.y * 0.5 + 0.55, 0.0, 1.0);
          vec3 col = mix(uBot, uTop, smoothstep(0.05, 0.95, h));
          // Slow mottle so the backdrop is never a flat wash.
          float m = sin(n.x * 9.0 + uTime * 0.07) * sin(n.z * 7.3 - uTime * 0.05)
                  + sin(n.y * 13.0 + uTime * 0.03) * 0.5;
          col += col * m * 0.45;
          gl_FragColor = vec4(max(col, 0.0), 1.0);
        }
      `,
    });
    const sky = new THREE.Mesh(skyGeo, this.skyMat);
    sky.frustumCulled = false;
    this.scene.add(sky);
    this.disposables.push(skyGeo, this.skyMat);

    // Six enormous arcs behind the arena — the inside of a ribcage.
    this.ribMat = new THREE.MeshBasicMaterial({ color: 0x1d4763, fog: true });
    this.disposables.push(this.ribMat);
    for (let i = 0; i < 6; i++) {
      const r = 88 + i * 4.4;
      const geo = new THREE.TorusGeometry(r, 1.25, 6, 72, Math.PI * 1.35);
      const m = new THREE.Mesh(geo, this.ribMat);
      m.rotation.set(1.05 + i * 0.16, i * 1.04, i * 0.42);
      m.position.y = 14 + i * 3;
      m.userData.spin = (i % 2 === 0 ? 1 : -1) * (0.03 + i * 0.008);
      this.scene.add(m);
      this.ribs.push(m);
      this.disposables.push(geo);
    }

    // Dust motes: static points, scrolled and wrapped in the shader.
    const n = 420;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() * 2 - 1) * 80;
      pos[i * 3 + 1] = Math.random() * 120;
      pos[i * 3 + 2] = (Math.random() * 2 - 1) * 80;
    }
    const dgeo = new THREE.BufferGeometry();
    dgeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    dgeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.dustMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      uniforms: { uTime: { value: 0 }, uScale: { value: 500 }, uTint: { value: new THREE.Color(0.4, 0.6, 0.9) } },
      vertexShader: /* glsl */ `
        uniform float uTime; uniform float uScale;
        void main() {
          vec3 p = position;
          p.y = mod(p.y + uTime * 1.4, 120.0) - 14.0;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = 2.4 * uScale / max(0.001, -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uTint;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d) * 0.35;
          gl_FragColor = vec4(uTint, 1.0) * a;
        }
      `,
    });
    const dust = new THREE.Points(dgeo, this.dustMat);
    dust.frustumCulled = false;
    this.scene.add(dust);
    this.disposables.push(dgeo, this.dustMat);
  }

  private buildFloor() {
    const geo = new THREE.BoxGeometry(4.6, 0.5, 4.6);
    const mat = new THREE.MeshBasicMaterial({ fog: true });
    this.tilePool = new InstancePool(geo, mat, GRID * GRID);
    this.scene.add(this.tilePool.mesh);

    let k = 0;
    const half = (GRID - 1) * 0.5;
    for (let iz = 0; iz < GRID; iz++) {
      for (let ix = 0; ix < GRID; ix++) {
        const x = (ix - half) * TILE_PITCH;
        const z = (iz - half) * TILE_PITCH;
        if (Math.hypot(x, z) > ARENA + 1.5) continue;
        this.fX[k] = x;
        this.fZ[k] = z;
        this.fY[k] = 0;
        this.fAlive[k] = 1;
        k++;
      }
    }
    this.fCount = k;

    const rimGeo = new THREE.RingGeometry(ARENA - 0.55, ARENA + 0.45, 128);
    rimGeo.rotateX(-Math.PI / 2);
    this.rimMat = new THREE.MeshBasicMaterial({
      side: THREE.DoubleSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this.rimMesh = new THREE.Mesh(rimGeo, this.rimMat);
    this.rimMesh.position.y = 0.35;
    this.scene.add(this.rimMesh);
    this.disposables.push(rimGeo, this.rimMat);
  }

  private buildBoss() {
    this.bossRoot = new THREE.Group();
    this.bossRoot.position.set(0, BOSS_Y, 0);
    this.scene.add(this.bossRoot);

    this.hullMat = new THREE.MeshBasicMaterial({ fog: true });
    const hullGeo = new THREE.IcosahedronGeometry(5.6, 1);
    this.hullMesh = new THREE.Mesh(hullGeo, this.hullMat);
    this.hullMesh.scale.set(1.05, 1.25, 0.95);
    this.bossRoot.add(this.hullMesh);
    this.disposables.push(hullGeo, this.hullMat);

    // Brow ridge: a second, wider shell that reads as a skull rather than a rock.
    const browGeo = new THREE.BoxGeometry(9.4, 1.5, 2.2);
    const brow = new THREE.Mesh(browGeo, this.hullMat);
    brow.position.set(0, 2.1, 3.4);
    brow.rotation.x = -0.22;
    this.bossRoot.add(brow);
    this.disposables.push(browGeo);

    this.jawPivot = new THREE.Object3D();
    this.jawPivot.position.set(0, -2.6, 1.4);
    this.bossRoot.add(this.jawPivot);
    this.jawMat = new THREE.MeshBasicMaterial({ fog: true });
    const jawGeo = new THREE.BoxGeometry(6.6, 2.0, 4.4);
    const jaw = new THREE.Mesh(jawGeo, this.jawMat);
    jaw.position.set(0, -1.0, 1.1);
    this.jawPivot.add(jaw);
    this.disposables.push(jawGeo, this.jawMat);

    // Teeth so the open jaw reads at distance.
    const toothGeo = new THREE.ConeGeometry(0.34, 1.3, 4);
    for (let i = 0; i < 7; i++) {
      const t = new THREE.Mesh(toothGeo, this.crownMatLazy());
      t.position.set((i - 3) * 0.95, -0.1, 3.0);
      t.rotation.x = Math.PI;
      this.jawPivot.add(t);
    }
    this.disposables.push(toothGeo);

    this.crownRoot = new THREE.Object3D();
    this.crownRoot.position.y = 3.6;
    this.bossRoot.add(this.crownRoot);
    const spikeGeo = new THREE.ConeGeometry(0.85, 5.2, 5);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU;
      const s = new THREE.Mesh(spikeGeo, this.crownMatLazy());
      s.position.set(Math.cos(a) * 4.1, 2.2 + Math.sin(i * 1.7) * 0.5, Math.sin(a) * 4.1);
      s.rotation.z = -Math.cos(a) * 0.42;
      s.rotation.x = Math.sin(a) * 0.42;
      this.crownRoot.add(s);
    }
    this.disposables.push(spikeGeo);

    this.eyeMat = new THREE.MeshBasicMaterial({ fog: false });
    const eyeGeo = new THREE.SphereGeometry(1.05, 16, 12);
    this.eyeL = new THREE.Mesh(eyeGeo, this.eyeMat);
    this.eyeL.position.set(-2.0, 0.7, 4.4);
    this.eyeR = new THREE.Mesh(eyeGeo, this.eyeMat);
    this.eyeR.position.set(2.0, 0.7, 4.4);
    this.bossRoot.add(this.eyeL, this.eyeR);
    this.disposables.push(eyeGeo, this.eyeMat);

    this.haloMat = new THREE.MeshBasicMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const haloGeo = new THREE.TorusGeometry(12.5, 0.18, 6, 96);
    haloGeo.rotateX(-Math.PI / 2);
    const halo = new THREE.Mesh(haloGeo, this.haloMat);
    this.bossRoot.add(halo);
    this.disposables.push(haloGeo, this.haloMat);

    // Six armour plates. Not instanced: only six, and each needs its own
    // animated colour plus its own detach physics once it breaks off.
    const plateGeo = new THREE.BoxGeometry(4.8, 1.5, 3.1);
    const coreGeo = new THREE.SphereGeometry(CORE_R, 14, 10);
    const capGeo = new THREE.ConeGeometry(1.5, 2.4, 4);
    for (let i = 0; i < PLATES; i++) {
      const g = new THREE.Group();
      const pm = new THREE.MeshBasicMaterial({ fog: true });
      const armour = new THREE.Mesh(plateGeo, pm);
      g.add(armour);
      const cap = new THREE.Mesh(capGeo, pm);
      cap.position.set(-2.4, 0, 0);
      cap.rotation.z = Math.PI / 2;
      g.add(cap);
      const cm = new THREE.MeshBasicMaterial({ fog: false });
      const core = new THREE.Mesh(coreGeo, cm);
      core.position.set(1.5, 0, 0);
      g.add(core);
      this.scene.add(g);
      this.plateGroups.push(g);
      this.plateMats.push(pm);
      this.coreMats.push(cm);
      this.coreMeshes.push(core);
      this.disposables.push(pm, cm);
    }
    this.disposables.push(plateGeo, coreGeo, capGeo);

    // Sweep beams: geometry pushed onto +X so aiming is one rotation.y write.
    const beamGeo = new THREE.CylinderGeometry(1.3, 1.6, 74, 12, 1, true);
    beamGeo.rotateZ(-Math.PI / 2);
    beamGeo.translate(37, 0, 0);
    const decalGeo = new THREE.PlaneGeometry(74, 3.0);
    decalGeo.rotateX(-Math.PI / 2);
    decalGeo.translate(37, 0, 0);
    for (let i = 0; i < MAX_BEAMS; i++) {
      const root = new THREE.Group();
      const bm = new THREE.MeshBasicMaterial({
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      const beam = new THREE.Mesh(beamGeo, bm);
      root.add(beam);
      const dm = new THREE.MeshBasicMaterial({
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      const decal = new THREE.Mesh(decalGeo, dm);
      decal.position.y = -BOSS_Y + 0.08;
      root.add(decal);
      root.visible = false;
      this.scene.add(root);
      this.beamRoots.push(root);
      this.beamMats.push(bm);
      this.beamDecalMats.push(dm);
      this.disposables.push(bm, dm);
    }
    this.disposables.push(beamGeo, decalGeo);
  }

  /** The crown material is shared by spikes and teeth; created on first use. */
  private crownMatLazy(): THREE.MeshBasicMaterial {
    if (!this.crownMat) {
      this.crownMat = new THREE.MeshBasicMaterial({ fog: false });
      this.disposables.push(this.crownMat);
    }
    return this.crownMat;
  }

  private buildPools() {
    const bulletGeo = new THREE.IcosahedronGeometry(BULLET_VIS, 0);
    this.bulletPool = new InstancePool(
      bulletGeo,
      new THREE.MeshBasicMaterial({ fog: false }),
      MAX_BULLETS,
    );
    this.scene.add(this.bulletPool.mesh);

    const tracerGeo = new THREE.BoxGeometry(0.16, 0.16, 1.5);
    this.tracerPool = new InstancePool(
      tracerGeo,
      new THREE.MeshBasicMaterial({ fog: false }),
      MAX_TRACERS,
    );
    this.scene.add(this.tracerPool.mesh);

    const orbGeo = new THREE.IcosahedronGeometry(0.72, 1);
    this.orbPool = new InstancePool(
      orbGeo,
      new THREE.MeshBasicMaterial({ fog: false }),
      MAX_ORBS,
    );
    this.scene.add(this.orbPool.mesh);

    const pillarGeo = new THREE.CylinderGeometry(1.7, 1.9, 30, 10, 1, true);
    pillarGeo.translate(0, 15, 0);
    this.pillarPool = new InstancePool(
      pillarGeo,
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      }),
      MAX_PILLARS,
    );
    this.scene.add(this.pillarPool.mesh);

    const discGeo = new THREE.PlaneGeometry(1, 1);
    discGeo.rotateX(-Math.PI / 2);
    this.discPool = new InstancePool(
      discGeo,
      new THREE.MeshBasicMaterial({
        map: this.ringTex,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      }),
      MAX_DISCS,
    );
    this.scene.add(this.discPool.mesh);
  }

  private buildPlayer() {
    this.playerMat = new THREE.MeshBasicMaterial({ fog: false });
    const geo = new THREE.OctahedronGeometry(0.62, 0);
    this.playerMesh = new THREE.Mesh(geo, this.playerMat);
    this.playerMesh.position.set(0, PLANE_Y, 16);
    this.scene.add(this.playerMesh);
    this.disposables.push(geo, this.playerMat);

    this.playerGlowMat = new THREE.SpriteMaterial({
      map: this.glowTex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this.playerGlow = new THREE.Sprite(this.playerGlowMat);
    this.playerGlow.scale.setScalar(4.2);
    this.playerGlow.position.copy(this.playerMesh.position);
    this.scene.add(this.playerGlow);
    this.disposables.push(this.playerGlowMat);
  }

  // --- run lifecycle --------------------------------------------------------

  private resetRun(attract: boolean) {
    this.mode = attract ? "attract" : "playing";
    this.modeT = 0;
    this.time = 0;
    this.score = 0;
    this.bestBeaten = false;
    this.newBestT = 0;
    this.phase = 0;
    this.phaseT = 0;
    this.bossHp = BOSS_HP;
    this.bossHpGhost = 1;
    this.hearts = HEARTS;
    this.platesBroken = 0;
    this.chain = 0;
    this.chainPeak = 0;
    this.chainTimer = 0;
    this.chainPunch = 0;
    this.chainShatter = 0;
    this.mult = 1;
    this.focus = 0;
    this.edgeT = 0;
    this.breachT = 0;
    this.breachSlow = 0;
    this.hintT = attract ? 0 : 12;
    this.hintDone = false;
    this.deathT = 0;
    this.hurtT = 0;

    this.px = 0;
    this.pz = 16;
    this.pvx = 0;
    this.pvz = 0;
    this.aimX = 0;
    this.aimZ = 0;
    this.aimAng = 0;
    this.dashT = 0;
    this.dashIframe = 0;
    this.invuln = 0;
    this.dashCd[0] = 0;
    this.dashCd[1] = 0;
    this.dashDodges = 0;
    for (let i = 0; i < this.trailX.length; i++) {
      this.trailX[i] = this.px;
      this.trailZ[i] = this.pz;
    }

    this.bx = 0;
    this.bz = 0;
    this.by = BOSS_Y;
    this.bossSpin = 0;
    this.bossHitFlash = 0;
    this.jawOpen = 0;
    this.chargeT = 0;
    this.roarT = 0;
    this.sprayT = 0.6;
    this.sprayAng = 0;
    this.atkT = attract ? 0.7 : 3.0;
    this.hollowTimer = 0;

    this.aCount = 0;
    this.tCount = 0;
    this.oCount = 0;
    this.lCount = 0;
    this.rCount = 0;
    this.dCount = 0;
    this.nCount = 0;
    for (let i = 0; i < MAX_BEAMS; i++) this.beamLive[i] = 0;
    for (const a of this.attacks) a.live = false;
    for (const co of this.callouts) co.live = false;
    this.particles.clear();

    for (let i = 0; i < PLATES; i++) {
      this.plHp[i] = PLATE_HP;
      this.plBroken[i] = 0;
      this.plHit[i] = 0;
      this.plRest[i] = 0;
      this.plateGroups[i].visible = true;
    }
    for (let i = 0; i < this.fCount; i++) {
      this.fY[i] = 0;
      this.fVy[i] = 0;
      this.fRx[i] = 0;
      this.fRz[i] = 0;
      this.fVrx[i] = 0;
      this.fVrz[i] = 0;
      this.fAlive[i] = 1;
    }

    this.palA = 0;
    this.palB = 0;
    this.palT = 1;
    this.blendPalette();

    this.warp.reset();
    this.flashR = this.flashG = this.flashB = 0;
    this.hitPulse = 0;
    this.desatHold = 0;
    this.fov = this.fovTarget = 58;
    this.camYaw = attract ? 0.6 : 0;

    if (!attract) {
      this.startMusic();
    } else {
      this.c.audio.stopMusic();
      this.primeAttract();
    }
  }

  /**
   * The very first frame must not be an empty arena. Fast-forward the ambient
   * spiral so the attract screen opens with the sky already full of fire.
   */
  private primeAttract() {
    for (let k = 0; k < 24; k++) {
      const a = k * 0.51;
      const age = 0.42 * (24 - k);
      for (let e = 0; e < 2; e++) {
        const ang = a + e * Math.PI;
        const vx = Math.sin(ang) * 13;
        const vz = Math.cos(ang) * 13;
        const x = Math.sin(ang) * 2 + vx * age;
        const z = Math.cos(ang) * 2 + vz * age;
        if (Math.hypot(x, z) > ARENA + 2) continue;
        this.spawnBullet(x, z, vx, vz, 1);
      }
    }
    this.sprayAng = 24 * 0.51;
    this.addDisc(0, 0, 6, 26, 1.4, this.cBullet);
    this.addDisc(0, 0, 2, 15, 0.9, this.cCore);
    this.particles.burst(120, 0, BOSS_Y, 0, 16, {
      life: 1.4, size: 2.6, endSize: 0, color: this.cCore, drag: 0.5,
    });
  }

  restart() {
    this.resetRun(false);
    this.c.report({ status: "playing", score: 0, best: this.best, label: "PHASE I" });
  }

  // --- audio ----------------------------------------------------------------

  private startMusic() {
    const bpm = this.phase === 0 ? 104 : this.phase === 1 ? 128 : 148;
    if (bpm === this.musicBpm) return;
    this.musicBpm = bpm;
    const kitPhase = () => this.phase;
    this.c.audio.startMusic((step, when, kit) => {
      const p = kitPhase();
      const s = step % 16;
      if (s % 4 === 0) {
        kit.play({ wave: "sine", freq: 78, freqTo: 34, glide: 0.09, vol: 0.34, attack: 0.002, hold: 0.03, release: 0.13, delay: when });
      }
      if (s % 8 === 0) {
        kit.play({ wave: "sine", freq: 55, vol: 0.2, attack: 0.01, hold: 0.18, release: 0.2, delay: when });
      }
      if (p >= 0 && s % 4 === 2) {
        kit.play({ wave: "noise", freq: 5200, vol: 0.05, attack: 0.001, hold: 0.005, release: 0.03, filter: 4000, filterType: "highpass", delay: when });
      }
      if (p >= 1) {
        const seq = [0, 7, 3, 10, 0, 5, 3, 8];
        const n = 110 * Math.pow(2, seq[s % 8] / 12);
        kit.play({ wave: "square", freq: n, vol: 0.055, attack: 0.002, hold: 0.03, release: 0.09, filter: 1800, delay: when });
      }
      if (p >= 2 && s % 8 === 0) {
        kit.play({ wave: "sawtooth", freq: 82, vol: 0.06, attack: 0.06, hold: 0.5, release: 0.4, filter: 700, filterTo: 1500, delay: when });
        kit.play({ wave: "sawtooth", freq: 82.9, vol: 0.06, attack: 0.06, hold: 0.5, release: 0.4, filter: 700, filterTo: 1500, delay: when });
      }
    }, bpm, 4);
  }

  // --- palette --------------------------------------------------------------

  private blendPalette() {
    const A = PALETTES[this.palA];
    const B = PALETTES[this.palB];
    const t = clamp01(this.palT);
    const mix = (ha: number, ga: number, hb: number, gb: number, out: THREE.Color) => {
      hdr(ha, ga, this._ca);
      hdr(hb, gb, this._cb);
      out.copy(this._ca).lerp(this._cb, t);
    };
    mix(A.tile, 1, B.tile, 1, this.cTile);
    mix(A.seam, A.seamG, B.seam, B.seamG, this.cSeam);
    mix(A.rim, A.rimG, B.rim, B.rimG, this.cRim);
    mix(A.hull, A.hullG, B.hull, B.hullG, this.cHull);
    mix(A.crown, A.crownG, B.crown, B.crownG, this.cCrown);
    mix(A.eye, A.eyeG, B.eye, B.eyeG, this.cEye);
    mix(A.core, A.coreG, B.core, B.coreG, this.cCore);
    mix(A.bullet, A.bulletG, B.bullet, B.bulletG, this.cBullet);
    mix(A.beam, A.beamG, B.beam, B.beamG, this.cBeam);
    mix(A.tracer, A.tracerG, B.tracer, B.tracerG, this.cTracer);
    mix(A.rib, 0.5, B.rib, 0.5, this.cRib);
    mix(A.skyTop, 1, B.skyTop, 1, this.cSkyTop);
    mix(A.skyBot, 1, B.skyBot, 1, this.cSkyBot);
    mix(A.fog, 1, B.fog, 1, this.cFog);
  }

  private get pal() {
    return PALETTES[this.palT > 0.5 ? this.palB : this.palA];
  }

  // --- update ---------------------------------------------------------------

  update(dtReal: number) {
    if (!this.ready) return;
    this.realTime += dtReal;

    // Edge state is only valid inside update, so read it before any early out.
    this.readEdges();

    this.shake.update(dtReal);
    const dt = this.warp.step(dtReal);

    this.modeT += dtReal;
    this.flashR = Math.max(0, this.flashR - dtReal * 6);
    this.flashG = Math.max(0, this.flashG - dtReal * 6);
    this.flashB = Math.max(0, this.flashB - dtReal * 6);
    this.hitPulse = Math.max(0, this.hitPulse - dtReal * 3.5);
    this.desatHold = Math.max(0, this.desatHold - dtReal * 2);
    this.newBestT = Math.max(0, this.newBestT - dtReal);
    this.chainPunch = damp(this.chainPunch, 0, 0.22, dtReal);
    this.chainShatter = Math.max(0, this.chainShatter - dtReal);
    for (const co of this.callouts) {
      if (!co.live) continue;
      co.t += dtReal;
      if (co.t >= co.life) co.live = false;
    }

    if (this.warp.frozen) return;
    if (dt <= 0) return;

    this.time += dt;
    if (this.palT < 1) {
      this.palT = Math.min(1, this.palT + dt / 1.2);
      this.blendPalette();
    }

    if (this.mode === "dead" || this.mode === "won") {
      this.deathT += dt;
      this.stepParticlesOnly(dt);
      this.updateCamera(dt);
      return;
    }

    if (this.mode === "intro") {
      this.updateIntro(dt);
      return;
    }

    // Two independent ramps: phase (damage-gated) and the hollow timer (time).
    this.hollowTimer += dt;

    this.updatePlayer(dt);
    this.updateBoss(dt);
    this.updatePlates(dt);
    this.updateEntities(dt);
    this.checkThreats(dt);
    this.updateTracerHits();
    this.updateMeters(dt);
    this.updateTiles(dt);
    this.particles.update(dt);
    this.updateCamera(dt);
    this.pushReport();
  }

  private stepParticlesOnly(dt: number) {
    this.updateEntities(dt);
    this.updateTiles(dt);
    this.updatePlates(dt);
    this.particles.update(dt);
    this.bossSpin += dt * 0.2;
  }

  private readEdges() {
    const inp = this.c.input;
    const p = inp.pointer;

    if (this.mode === "attract") {
      if (inp.anyPressed || p.justDown) this.beginRun();
      return;
    }
    if (this.mode === "dead" || this.mode === "won") {
      if (this.deathT > 0.45 && (p.justDown || inp.wasPressed("Space", "Enter", "KeyR"))) {
        this.resetRun(false);
        this.c.audio.powerUp(0.2);
      }
      return;
    }
    if (this.mode !== "playing") return;

    // Touch: left half places a virtual stick, right half is the dash button.
    if (this.c.isTouch) {
      this.touchDash = false;
      let stick: { x: number; y: number; startX: number; startY: number } | null = null;
      for (const t of this.c.input.touches.values()) {
        if (t.startX < this.w * 0.5) {
          stick = t;
        } else if (t.id !== this.stickId) {
          const dx = t.x - (this.w - 96);
          const dy = t.y - (this.h - 96);
          if (dx * dx + dy * dy < 128 * 128 && p.justDown) this.touchDash = true;
        }
      }
      if (stick) {
        this.stickActive = true;
        this.stickCx = stick.startX;
        this.stickCy = stick.startY;
        this.stickX = stick.x;
        this.stickY = stick.y;
      } else {
        this.stickActive = false;
      }
      if (this.touchDash) this.tryDash();
    }

    if (inp.wasPressed("Space", "ShiftLeft", "ShiftRight")) this.tryDash();
    // Right mouse also dashes on desktop; pointer.justDown with button state is
    // not exposed, so the keyboard paths carry it.
  }

  private beginRun() {
    this.mode = "intro";
    this.modeT = 0;
    this.c.audio.unlock();
    // The ghost autopilot shatters and the arena clears for the real fight.
    this.particles.burst(200, this.px, PLANE_Y, this.pz, 16, {
      life: 0.9, size: 2.4, endSize: 0, color: hdr(0xffffff, 5, this._cs).clone(), drag: 0.2,
    });
    this.aCount = 0;
    this.oCount = 0;
    this.lCount = 0;
    this.rCount = 0;
    for (let i = 0; i < MAX_BEAMS; i++) this.beamLive[i] = 0;
    for (const a of this.attacks) a.live = false;
    this.warp.slowMo(0.5, 0.4);
    this.shake.add(0.8);
    this.roarT = 1.1;
    this.jawOpen = 1;
    this.flash(0.5, 0.9, 1.2);
    this.c.audio.explode(0.4);
    this.c.audio.play({ wave: "sawtooth", freq: 60, freqTo: 200, glide: 0.9, vol: 0.3, attack: 0.05, hold: 0.5, release: 0.5, filter: 400, filterTo: 2200 });
  }

  private updateIntro(dt: number) {
    this.bossSpin += dt * 0.4;
    this.roarT = Math.max(0, this.roarT - dt);
    this.jawOpen = damp(this.jawOpen, 0.15, 0.1, dt);
    this.particles.update(dt);
    this.updateTiles(dt);
    this.updatePlates(dt);
    this.updateCamera(dt);
    if (this.modeT > 0.45) {
      this.resetRun(false);
      this.mode = "playing";
      this.modeT = 0;
      this.say("HOLLOWKING", 0.9, 74, "#ffffff");
      this.c.report({ status: "playing", score: 0, best: this.best, label: "PHASE I" });
    }
  }

  // --- player ---------------------------------------------------------------

  private updatePlayer(dt: number) {
    const inp = this.c.input;
    const attract = this.mode === "attract";
    const lowHp = this.hearts <= 1 && !attract;

    let mx = 0;
    let mz = 0;
    let wantFire = true;
    let held = false;

    if (attract) {
      // Autopilot: orbit the boss, hose the nearest core, and dash INTO the
      // nearest bullet — the attract loop has to teach the perfect dodge.
      const orbit = this.time * 0.55 + 1.2;
      const tx = this.bx + Math.cos(orbit) * 16;
      const tz = this.bz + Math.sin(orbit) * 16;
      mx = tx - this.px;
      mz = tz - this.pz;
      held = true;
      let bi = -1;
      let bd = 1e9;
      for (let i = 0; i < this.aCount; i++) {
        const d = Math.hypot(this.ax[i] - this.px, this.az[i] - this.pz);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      if (bi >= 0 && bd > 1.5 && bd < 3.6 && this.dashT <= 0) {
        this.tryDash(this.ax[bi] - this.px, this.az[bi] - this.pz);
      }
    } else if (this.c.isTouch && this.stickActive) {
      const dxp = this.stickX - this.stickCx;
      const dyp = this.stickY - this.stickCy;
      const len = Math.hypot(dxp, dyp);
      if (len > 14) {
        const f = Math.min(1, (len - 14) / 48) / len;
        mx = dxp * f;
        mz = dyp * f;
      }
      held = true;
    } else {
      mx = inp.axisX;
      mz = inp.axisY;
      held = inp.pointer.down || inp.isDown("KeyJ");
    }

    // Camera-relative: the camera's flattened forward is the "up" of the stick.
    const cy = this.camYaw;
    const fwdX = -Math.sin(cy);
    const fwdZ = -Math.cos(cy);
    const rgtX = Math.cos(cy);
    const rgtZ = -Math.sin(cy);
    let wx = rgtX * mx + fwdX * mz;
    let wz = rgtZ * mx + fwdZ * mz;
    const ml = Math.hypot(wx, wz);
    if (ml > 1) {
      wx /= ml;
      wz /= ml;
    }

    const speed = PLAYER_SPEED * (lowHp ? 1.12 : 1);
    if (this.dashT > 0) {
      this.dashT -= dt;
      this.px += this.dashDirX * DASH_SPEED * dt;
      this.pz += this.dashDirZ * DASH_SPEED * dt;
      this.pvx = this.dashDirX * DASH_SPEED;
      this.pvz = this.dashDirZ * DASH_SPEED;
      if (this.dashT <= 0) this.dashDodges = 0;
    } else {
      this.pvx = damp(this.pvx, wx * speed, 0.42, dt);
      this.pvz = damp(this.pvz, wz * speed, 0.42, dt);
      this.px += this.pvx * dt;
      this.pz += this.pvz * dt;
    }

    const rad = Math.hypot(this.px, this.pz);
    if (rad > ARENA - 1.2) {
      const k = (ARENA - 1.2) / rad;
      this.px *= k;
      this.pz *= k;
    }

    this.dashIframe = Math.max(0, this.dashIframe - dt);
    this.invuln = Math.max(0, this.invuln - dt);
    this.hurtT = Math.max(0, this.hurtT - dt);
    const cdRate = (this.breachT > 0 ? 2.2 : 1) * (lowHp ? 1.15 : 1);
    for (let i = 0; i < DASH_CHARGES; i++) {
      if (this.dashCd[i] > 0) this.dashCd[i] = Math.max(0, this.dashCd[i] - dt * cdRate);
    }

    // Trail history at a fixed cadence so it reads as motion, not a smear.
    this.trailHead = (this.trailHead + 1) % this.trailX.length;
    this.trailX[this.trailHead] = this.px;
    this.trailZ[this.trailHead] = this.pz;

    // Aim: manual ray/plane intersection against the combat plane.
    if (attract || this.c.isTouch) {
      const t = this.nearestCore();
      const ax2 = t < 0 ? this.bx : this.plX[t];
      const az2 = t < 0 ? this.bz : this.plZ[t];
      this.aimAng = Math.atan2(ax2 - this.px, az2 - this.pz);
      this.aimX = ax2;
      this.aimZ = az2;
    } else {
      this.aimFromPointer();
      this.aimAng = Math.atan2(this.aimX - this.px, this.aimZ - this.pz);
    }

    // Auto-fire always: the screen is never empty even if nobody touches a key.
    this.edgeT = Math.max(0, this.edgeT - dt);
    this.fireT -= dt;
    const interval = held ? FIRE_HELD : FIRE_AUTO;
    if (this.fireT <= 0) {
      this.fireT += interval;
      if (this.fireT < -interval) this.fireT = interval;
      this.fire(held);
    }
  }

  private aimFromPointer() {
    const p = this.c.input.pointer;
    if (!p.everMoved) {
      this.aimX = this.bx;
      this.aimZ = this.bz;
      return;
    }
    const ndcX = (p.x / Math.max(1, this.w)) * 2 - 1;
    const ndcY = -((p.y / Math.max(1, this.h)) * 2 - 1);
    this._v3.set(ndcX, ndcY, 0.5).unproject(this.camera);
    this._v3.sub(this.camera.position);
    const dy = this._v3.y;
    if (Math.abs(dy) < 1e-4) return;
    const t = (PLANE_Y - this.camera.position.y) / dy;
    if (t <= 0) return;
    this.aimX = this.camera.position.x + this._v3.x * t;
    this.aimZ = this.camera.position.z + this._v3.z * t;
  }

  private nearestCore(): number {
    let bi = -1;
    let bd = 1e9;
    for (let i = 0; i < PLATES; i++) {
      if (this.plBroken[i]) continue;
      const d = (this.plX[i] - this.px) ** 2 + (this.plZ[i] - this.pz) ** 2;
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    return bi;
  }

  private fire(assist: boolean) {
    let ang = this.aimAng;
    if (assist) {
      // 12 degrees of snap toward the nearest exposed core.
      const t = this.nearestCore();
      if (t >= 0) {
        const want = Math.atan2(this.plX[t] - this.px, this.plZ[t] - this.pz);
        const d = angleDelta(ang, want);
        if (Math.abs(d) < 0.21) ang = want;
      }
    }
    const sx = Math.sin(ang);
    const sz = Math.cos(ang);
    for (let k = -1; k <= 1; k += 2) {
      if (this.tCount >= MAX_TRACERS) break;
      const i = this.tCount++;
      const px = this.px + sz * 0.34 * k;
      const pz = this.pz - sx * 0.34 * k;
      this.tx[i] = px;
      this.tz[i] = pz;
      this.tvx[i] = sx * TRACER_SPEED;
      this.tvz[i] = sz * TRACER_SPEED;
      this.tlife[i] = 0.9;
    }
    this.particles.spawn({
      x: this.px + sx * 0.8, y: PLANE_Y, z: this.pz + sz * 0.8,
      vx: sx * 6, vy: 1.5, vz: sz * 6,
      life: 0.14, size: 1.6, endSize: 0,
      color: this.edgeT > 0 ? hdr(0xffffff, 5, this._cs) : this.cTracer,
    });
    if (this.mode === "playing") {
      const f = this.edgeT > 0 ? 1500 : 1180;
      this.c.audio.play({
        wave: "square", freq: f, freqTo: f * 0.55, glide: 0.04,
        vol: 0.028, attack: 0.001, hold: 0.008, release: 0.035, jitter: 40,
      });
    }
  }

  private tryDash(dirX = 0, dirZ = 0) {
    if (this.mode === "attract") {
      if (this.dashT > 0) return;
    } else if (this.mode !== "playing") {
      return;
    }
    let slot = -1;
    if (this.breachT > 0) {
      slot = 0;
    } else {
      for (let i = 0; i < DASH_CHARGES; i++) {
        if (this.dashCd[i] <= 0) {
          slot = i;
          break;
        }
      }
    }
    if (slot < 0) return;
    if (this.breachT <= 0) this.dashCd[slot] = DASH_CD;

    let dx = dirX;
    let dz = dirZ;
    if (dx === 0 && dz === 0) {
      dx = this.pvx;
      dz = this.pvz;
    }
    if (Math.abs(dx) < 0.01 && Math.abs(dz) < 0.01) {
      dx = Math.sin(this.aimAng);
      dz = Math.cos(this.aimAng);
    }
    const l = Math.hypot(dx, dz) || 1;
    this.dashDirX = dx / l;
    this.dashDirZ = dz / l;
    this.dashT = DASH_TIME;
    this.dashIframe = DASH_IFRAME;
    this.invuln = Math.max(this.invuln, DASH_IFRAME);
    this.dashId++;
    this.dashDodges = 0;
    this.fovTarget = 66;
    this.shake.add(0.07);
    this.c.audio.play({
      wave: "noise", freq: 900, freqTo: 2600, vol: 0.11,
      attack: 0.005, hold: 0.02, release: 0.1, filter: 700, filterTo: 3600,
      filterType: "bandpass", q: 2.2,
    });
    for (let i = 0; i < 10; i++) {
      this.particles.spawn({
        x: this.px, y: PLANE_Y, z: this.pz,
        vx: -this.dashDirX * 9 + (Math.random() - 0.5) * 5,
        vy: (Math.random() - 0.3) * 3,
        vz: -this.dashDirZ * 9 + (Math.random() - 0.5) * 5,
        life: 0.3, size: 1.4, endSize: 0, color: this.cTracer, drag: 0.15,
      });
    }
  }

  // --- boss -----------------------------------------------------------------

  private get rateMult() {
    return 1 + Math.min(0.6, Math.floor(this.hollowTimer / 25) * 0.07);
  }
  private get speedMult() {
    return 1 + Math.min(0.45, Math.floor(this.hollowTimer / 25) * 0.05);
  }
  private get rage() {
    return this.hollowTimer >= 150;
  }

  private updateBoss(dt: number) {
    this.bossSpin += dt * (0.42 + this.phase * 0.14);
    this.bossHitFlash = Math.max(0, this.bossHitFlash - dt * 4);
    this.roarT = Math.max(0, this.roarT - dt);
    this.jawOpen = damp(this.jawOpen, this.telegraphing() ? 1 : 0.12, 0.12, dt);

    if (this.chargeT > 0) {
      this.chargeT -= dt;
    } else {
      // Idle drift: a lissajous so the silhouette is never still.
      const tX = Math.sin(this.time * 0.31) * 5.5;
      const tZ = Math.cos(this.time * 0.24) * 4.5;
      this.bx = damp(this.bx, tX, 0.02, dt);
      this.bz = damp(this.bz, tZ, 0.02, dt);
    }
    this.by = damp(this.by, BOSS_Y + Math.sin(this.time * 0.8) * 0.7, 0.08, dt);

    // Ambient spiral spray — never stops, so a chain is always available.
    const base = this.phase === 0 ? 0.42 : this.phase === 1 ? 0.3 : 0.22;
    const interval = Math.max(0.1, (base / this.rateMult) * (this.rage ? 0.55 : 1));
    this.sprayT -= dt;
    if (this.sprayT <= 0 && this.aCount < 240) {
      this.sprayT = interval;
      this.sprayAng += 0.51;
      for (let e = 0; e < 2; e++) {
        const a = this.sprayAng + e * Math.PI;
        this.spawnBullet(
          this.bx + Math.sin(a) * 2.0,
          this.bz + Math.cos(a) * 2.0,
          Math.sin(a) * 13 * this.speedMult,
          Math.cos(a) * 13 * this.speedMult,
          1,
        );
      }
      this.c.audio.play({ wave: "square", freq: 300, freqTo: 180, glide: 0.05, vol: 0.03, attack: 0.001, hold: 0.01, release: 0.05 });
    }

    // Attack scheduler.
    let liveAtk = 0;
    for (const a of this.attacks) if (a.live) liveAtk++;
    const maxConcurrent = this.phase === 0 ? 1 : this.phase === 1 ? 2 : 3;
    const cadence = (this.phase === 0 ? 3.0 : this.phase === 1 ? 1.9 : 1.4) / this.rateMult;
    this.atkT -= dt;
    if (this.atkT <= 0 && liveAtk < maxConcurrent && this.mode !== "intro") {
      this.atkT = cadence;
      this.launchAttack(liveAtk);
    }

    for (const a of this.attacks) if (a.live) this.stepAttack(a, dt);
  }

  private telegraphing(): boolean {
    for (const a of this.attacks) if (a.live && a.t < a.tell) return true;
    for (let i = 0; i < MAX_BEAMS; i++) {
      if (this.beamLive[i] && this.beamT[i] < this.beamTell[i]) return true;
    }
    return false;
  }

  private launchAttack(liveAtk: number) {
    const rng = this.c.rng;
    const pool: number[] = [A_RING, A_SWEEP, A_ORBS, A_SLAM, A_PILLARS];
    if (this.phase >= 1) pool.push(A_CHARGE);
    if (this.rage) pool.push(A_HOLLOW);
    // Safety valve: a screen already full of bullets biases toward sparse
    // patterns, so phase three can never become an unsurvivable soup.
    const crowded = this.aCount > 190 || liveAtk > 0;
    const kind = crowded
      ? rng.pick([A_SWEEP, A_PILLARS, A_CHARGE, A_SLAM].filter((k) => pool.includes(k)))
      : rng.pick(pool);

    const a = this.attacks.find((x) => !x.live);
    if (!a) return;
    a.kind = kind;
    a.t = 0;
    a.step = 0;
    a.n = 0;
    a.live = true;
    a.ang = Math.atan2(this.px - this.bx, this.pz - this.bz);

    switch (kind) {
      case A_RING:
        a.tell = 0.85;
        a.n = this.phase === 0 ? 3 : this.phase === 1 ? 4 : 5;
        a.dur = a.n * 0.3;
        break;
      case A_SWEEP:
        a.tell = 1.05;
        a.dur = 1.7;
        break;
      case A_ORBS:
        a.tell = 0.75;
        a.dur = 0.1;
        a.n = this.phase === 0 ? 4 : this.phase === 1 ? 6 : 8;
        break;
      case A_SLAM:
        a.tell = 0.9;
        a.dur = 1.4;
        break;
      case A_PILLARS:
        a.tell = 1.0;
        a.n = this.phase === 0 ? 7 : this.phase === 1 ? 11 : 16;
        a.dur = (this.phase === 0 ? 1 : this.phase === 1 ? 2 : 3) * 0.55;
        break;
      case A_CHARGE:
        a.tell = 0.8;
        a.n = this.phase === 1 ? 2 : 3;
        a.dur = a.n * 0.95;
        break;
      case A_HOLLOW:
        a.tell = 1.1;
        a.dur = 2.7;
        break;
    }
    this.telegraphSound(kind);
  }

  private telegraphSound(kind: number) {
    switch (kind) {
      case A_RING:
        this.c.audio.play({ wave: "square", freq: 300, freqTo: 1200, glide: 0.8, vol: 0.13, attack: 0.02, hold: 0.6, release: 0.2, filter: 900, filterTo: 3000 });
        break;
      case A_SWEEP:
      case A_HOLLOW:
        this.c.audio.play({ wave: "sawtooth", freq: 220, freqTo: 880, glide: 1.0, vol: 0.13, attack: 0.03, hold: 0.7, release: 0.2, filter: 700, filterTo: 2600 });
        break;
      case A_SLAM:
        this.c.audio.play({ wave: "sine", freq: 120, freqTo: 300, glide: 0.8, vol: 0.16, attack: 0.05, hold: 0.6, release: 0.2 });
        break;
      case A_PILLARS:
        this.c.audio.play({ wave: "triangle", freq: 520, freqTo: 1400, glide: 0.9, vol: 0.11, attack: 0.03, hold: 0.6, release: 0.2 });
        break;
      case A_ORBS:
        this.c.audio.play({ wave: "square", freq: 700, freqTo: 460, glide: 0.6, vol: 0.11, attack: 0.02, hold: 0.5, release: 0.2 });
        break;
      case A_CHARGE:
        this.c.audio.play({ wave: "sawtooth", freq: 90, freqTo: 60, glide: 0.7, vol: 0.2, attack: 0.05, hold: 0.5, release: 0.25, filter: 500 });
        break;
    }
  }

  private stepAttack(a: Attack, dt: number) {
    const prev = a.t;
    a.t += dt;
    const telling = a.t < a.tell;

    if (telling) {
      // Every telegraph pulls sparks into the skull, so a wind-up is legible
      // even when three of them overlap.
      if (Math.random() < dt * 30) {
        const ang = Math.random() * TAU;
        const r = 10 + Math.random() * 8;
        this.particles.spawn({
          x: this.bx + Math.cos(ang) * r, y: this.by + (Math.random() - 0.5) * 8, z: this.bz + Math.sin(ang) * r,
          vx: -Math.cos(ang) * r * 1.6, vy: 0, vz: -Math.sin(ang) * r * 1.6,
          life: 0.6, size: 1.8, endSize: 0, color: this.cBeam, drag: 0.6,
        });
      }
      if (a.kind === A_SWEEP || a.kind === A_HOLLOW) {
        // The beam line locks onto the player, then holds — dodge is skill.
        if (a.t < a.tell * 0.55) a.ang = Math.atan2(this.px - this.bx, this.pz - this.bz);
      }
      if (a.kind === A_PILLARS && a.step === 0 && a.t > a.tell * 0.25) {
        a.step = 1;
        this.spawnPillarSalvo(a.n, a.tell - a.t);
      }
      if (a.kind === A_CHARGE && prev < a.tell * 0.5 && a.t >= a.tell * 0.5) {
        this.addDisc(this.px, this.pz, 3.4, 6, 0.5, this.cBeam);
      }
      return;
    }

    const at = a.t - a.tell;
    const pat = prev - a.tell;

    switch (a.kind) {
      case A_RING: {
        const gap = 0.3;
        const idx = Math.floor(at / gap);
        if (idx > a.step - 1 && a.step < a.n) {
          const count = this.phase === 0 ? 26 : this.phase === 1 ? 34 : 40;
          const off = a.step * 0.112;
          for (let i = 0; i < count; i++) {
            const ang = (i / count) * TAU + off;
            this.spawnBullet(
              this.bx + Math.sin(ang) * 2.4, this.bz + Math.cos(ang) * 2.4,
              Math.sin(ang) * 13 * this.speedMult, Math.cos(ang) * 13 * this.speedMult, 1,
            );
          }
          a.step++;
          this.shake.add(0.14);
          this.addDisc(this.bx, this.bz, 3, 40, 0.5, this.cBullet);
          this.c.audio.play({ wave: "square", freq: 420, freqTo: 160, glide: 0.15, vol: 0.16, attack: 0.002, hold: 0.04, release: 0.16 });
        }
        break;
      }
      case A_SWEEP: {
        if (a.step === 0) {
          a.step = 1;
          const rate = (this.phase === 0 ? 1.83 : this.phase === 1 ? 2.53 : 3.3) * (this.rage ? 1.25 : 1);
          this.spawnBeam(a.ang, (this.c.rng.bool() ? 1 : -1) * rate, a.dur);
        }
        break;
      }
      case A_HOLLOW: {
        if (a.step === 0) {
          a.step = 1;
          this.spawnBeam(a.ang, 2.4, a.dur);
          this.spawnBeam(a.ang + Math.PI, -2.4, a.dur);
          this.say("HOLLOW SWEEP", 0.8, 44, "#ff6a8a");
        }
        break;
      }
      case A_ORBS: {
        if (a.step === 0) {
          a.step = 1;
          const turn = this.phase === 0 ? 2.6 : this.phase === 1 ? 3.0 : 3.4;
          for (let i = 0; i < a.n; i++) {
            if (this.oCount >= MAX_ORBS) break;
            const k = this.oCount++;
            const ang = (i / a.n) * TAU + this.time;
            this.ox[k] = this.bx + Math.sin(ang) * 5;
            this.oz[k] = this.bz + Math.cos(ang) * 5;
            this.ovx[k] = Math.sin(ang) * 11;
            this.ovz[k] = Math.cos(ang) * 11;
            this.olife[k] = 7;
            this.otag[k] = 0;
            this.oturn[k] = turn;
            this.ododges[k] = 0;
          }
          this.c.audio.play({ wave: "square", freq: 620, freqTo: 900, glide: 0.2, vol: 0.15, attack: 0.005, hold: 0.06, release: 0.2 });
        }
        break;
      }
      case A_SLAM: {
        if (at < 0.22) {
          this.by = damp(this.by, BOSS_Y + 7, 0.3, dt);
        } else if (a.step === 0) {
          a.step = 1;
          this.by = BOSS_Y - 3.5;
          this.shake.add(0.9);
          this.warp.hitStop(0.08);
          this.flash(0.5, 0.25, 0.2);
          this.c.audio.explode(0.4);
          for (let r = 0; r < 3; r++) this.spawnRing(this.bx, this.bz, -r * 3.2, 26 * this.speedMult);
          this.particles.burst(70, this.bx, 0.6, this.bz, 22, {
            life: 0.8, size: 2.4, endSize: 0, color: this.cBeam, gravity: -12, drag: 0.3,
          });
          this.tileImpulse(this.bx, this.bz, 10, 7);
        }
        break;
      }
      case A_PILLARS: {
        const salvos = Math.round(a.dur / 0.55);
        const idx = Math.floor(at / 0.55) + 1;
        if (idx > a.step - 1 && a.step <= salvos) {
          this.spawnPillarSalvo(a.n, 0.75);
          a.step++;
        }
        break;
      }
      case A_CHARGE: {
        const seg = 0.95;
        const idx = Math.floor(at / seg);
        if (idx > a.step - 1 && a.step < a.n) {
          a.step++;
          a.ang = Math.atan2(this.px - this.bx, this.pz - this.bz);
          this.chargeT = 0.55;
          this.chargeDodge = 0;
          this.shake.add(0.4);
          this.c.audio.play({ wave: "sawtooth", freq: 180, freqTo: 55, glide: 0.4, vol: 0.26, attack: 0.005, hold: 0.1, release: 0.3, filter: 1400, filterTo: 300 });
        }
        if (this.chargeT > 0) {
          const sp = 34 * this.speedMult;
          this.bx += Math.sin(a.ang) * sp * dt;
          this.bz += Math.cos(a.ang) * sp * dt;
          const r = Math.hypot(this.bx, this.bz);
          if (r > ARENA - 6) {
            this.bx *= (ARENA - 6) / r;
            this.bz *= (ARENA - 6) / r;
          }
          if (Math.random() < dt * 26) {
            this.spawnBullet(this.bx, this.bz, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, 1);
          }
          this.particles.spawn({
            x: this.bx + (Math.random() - 0.5) * 8, y: this.by + (Math.random() - 0.5) * 8, z: this.bz + (Math.random() - 0.5) * 8,
            vx: 0, vy: -6, vz: 0, life: 0.4, size: 2.6, endSize: 0, color: this.cBeam, drag: 0.4,
          });
        }
        break;
      }
    }

    if (pat >= 0 && at >= a.dur) a.live = false;
  }

  private spawnPillarSalvo(n: number, tell: number) {
    for (let i = 0; i < n; i++) {
      if (this.lCount >= MAX_PILLARS) break;
      const k = this.lCount++;
      let x: number;
      let z: number;
      if (i === 0) {
        // One disc leads the player's current heading so strafing is punished.
        x = this.px + this.pvx * 0.8;
        z = this.pz + this.pvz * 0.8;
      } else {
        const ang = this.c.rng.range(0, TAU);
        const r = this.c.rng.range(3, ARENA - 3);
        x = Math.cos(ang) * r;
        z = Math.sin(ang) * r;
      }
      const rr = Math.hypot(x, z);
      if (rr > ARENA - 2) {
        x *= (ARENA - 2) / rr;
        z *= (ARENA - 2) / rr;
      }
      this.lx[k] = x;
      this.lz[k] = z;
      this.lt[k] = -tell;
      this.ltell[k] = tell;
      this.ltag[k] = 0;
    }
  }

  private spawnBeam(ang: number, rate: number, dur: number) {
    for (let i = 0; i < MAX_BEAMS; i++) {
      if (this.beamLive[i]) continue;
      this.beamLive[i] = 1;
      this.beamAng[i] = ang;
      this.beamRate[i] = rate;
      this.beamT[i] = 0;
      this.beamTell[i] = 0;
      this.beamDur[i] = dur;
      this.beamTag[i] = 0;
      this.c.audio.play({ wave: "sawtooth", freq: 1600, freqTo: 300, glide: 0.3, vol: 0.2, attack: 0.005, hold: 0.2, release: 0.4, filter: 3000, filterTo: 800 });
      this.shake.add(0.3);
      return;
    }
  }

  private spawnRing(x: number, z: number, r0: number, spd: number) {
    if (this.rCount >= MAX_RINGS) return;
    const i = this.rCount++;
    this.rx[i] = x;
    this.rz[i] = z;
    this.rr[i] = r0;
    this.rspd[i] = spd;
    this.rlife[i] = 2.2;
    this.rtag[i] = 0;
  }

  private spawnBullet(x: number, z: number, vx: number, vz: number, sz: number) {
    if (this.aCount >= MAX_BULLETS) return;
    const i = this.aCount++;
    this.ax[i] = x;
    this.az[i] = z;
    this.avx[i] = vx;
    this.avz[i] = vz;
    this.alife[i] = 9;
    this.atag[i] = 0;
    this.asz[i] = sz;
  }

  private addDisc(x: number, z: number, r0: number, rMax: number, life: number, col: THREE.Color) {
    if (this.dCount >= MAX_DISCS) return;
    const i = this.dCount++;
    this.dx[i] = x;
    this.dz[i] = z;
    this.dr[i] = r0;
    this.dgrow[i] = rMax;
    this.dlife[i] = life;
    this.dmax[i] = life;
    this.dcr[i] = col.r;
    this.dcg[i] = col.g;
    this.dcb[i] = col.b;
  }

  // --- entity integration ---------------------------------------------------

  private updateEntities(dt: number) {
    const lim = (ARENA + 6) * (ARENA + 6);

    let i = 0;
    while (i < this.aCount) {
      this.alife[i] -= dt;
      this.ax[i] += this.avx[i] * dt;
      this.az[i] += this.avz[i] * dt;
      if (this.alife[i] <= 0 || this.ax[i] * this.ax[i] + this.az[i] * this.az[i] > lim) {
        const l = --this.aCount;
        this.ax[i] = this.ax[l]; this.az[i] = this.az[l];
        this.avx[i] = this.avx[l]; this.avz[i] = this.avz[l];
        this.alife[i] = this.alife[l]; this.atag[i] = this.atag[l]; this.asz[i] = this.asz[l];
        continue;
      }
      i++;
    }

    i = 0;
    while (i < this.tCount) {
      this.tlife[i] -= dt;
      this.tx[i] += this.tvx[i] * dt;
      this.tz[i] += this.tvz[i] * dt;
      if (this.tlife[i] <= 0) {
        const l = --this.tCount;
        this.tx[i] = this.tx[l]; this.tz[i] = this.tz[l];
        this.tvx[i] = this.tvx[l]; this.tvz[i] = this.tvz[l];
        this.tlife[i] = this.tlife[l];
        continue;
      }
      i++;
    }

    i = 0;
    while (i < this.oCount) {
      this.olife[i] -= dt;
      const want = Math.atan2(this.px - this.ox[i], this.pz - this.oz[i]);
      const cur = Math.atan2(this.ovx[i], this.ovz[i]);
      const na = cur + clamp(angleDelta(cur, want), -this.oturn[i] * dt, this.oturn[i] * dt);
      const sp = 13 * this.speedMult;
      this.ovx[i] = Math.sin(na) * sp;
      this.ovz[i] = Math.cos(na) * sp;
      this.ox[i] += this.ovx[i] * dt;
      this.oz[i] += this.ovz[i] * dt;
      if (this.olife[i] <= 0) {
        this.particles.burst(10, this.ox[i], PLANE_Y, this.oz[i], 8, {
          life: 0.4, size: 1.6, endSize: 0, color: this.cBullet,
        });
        const l = --this.oCount;
        this.ox[i] = this.ox[l]; this.oz[i] = this.oz[l];
        this.ovx[i] = this.ovx[l]; this.ovz[i] = this.ovz[l];
        this.olife[i] = this.olife[l]; this.otag[i] = this.otag[l];
        this.oturn[i] = this.oturn[l]; this.ododges[i] = this.ododges[l];
        continue;
      }
      i++;
    }

    i = 0;
    while (i < this.lCount) {
      const was = this.lt[i];
      this.lt[i] += dt;
      if (was < 0 && this.lt[i] >= 0) {
        this.shake.add(0.12);
        this.particles.burst(16, this.lx[i], 0.4, this.lz[i], 12, {
          life: 0.5, size: 2, endSize: 0, color: this.cBeam, gravity: 6,
        });
        this.c.audio.play({ wave: "noise", freq: 1400, freqTo: 300, vol: 0.14, attack: 0.002, hold: 0.05, release: 0.2, filter: 2600, filterTo: 400 });
      }
      if (this.lt[i] > 0.5) {
        const l = --this.lCount;
        this.lx[i] = this.lx[l]; this.lz[i] = this.lz[l];
        this.lt[i] = this.lt[l]; this.ltell[i] = this.ltell[l]; this.ltag[i] = this.ltag[l];
        continue;
      }
      i++;
    }

    i = 0;
    while (i < this.rCount) {
      this.rr[i] += this.rspd[i] * dt;
      this.rlife[i] -= dt;
      if (this.rlife[i] <= 0 || this.rr[i] > ARENA + 8) {
        const l = --this.rCount;
        this.rx[i] = this.rx[l]; this.rz[i] = this.rz[l]; this.rr[i] = this.rr[l];
        this.rspd[i] = this.rspd[l]; this.rlife[i] = this.rlife[l]; this.rtag[i] = this.rtag[l];
        continue;
      }
      i++;
    }

    i = 0;
    while (i < this.dCount) {
      this.dlife[i] -= dt;
      this.dr[i] = lerp(this.dr[i], this.dgrow[i], 1 - Math.pow(0.001, dt));
      if (this.dlife[i] <= 0) {
        const l = --this.dCount;
        this.dx[i] = this.dx[l]; this.dz[i] = this.dz[l]; this.dr[i] = this.dr[l];
        this.dgrow[i] = this.dgrow[l]; this.dlife[i] = this.dlife[l]; this.dmax[i] = this.dmax[l];
        this.dcr[i] = this.dcr[l]; this.dcg[i] = this.dcg[l]; this.dcb[i] = this.dcb[l];
        continue;
      }
      i++;
    }

    for (let b = 0; b < MAX_BEAMS; b++) {
      if (!this.beamLive[b]) continue;
      this.beamT[b] += dt;
      this.beamAng[b] += this.beamRate[b] * dt;
      if (this.beamT[b] >= this.beamDur[b]) this.beamLive[b] = 0;
    }

    i = 0;
    while (i < this.nCount) {
      this.nAge[i] += dt;
      this.nPunch[i] = damp(this.nPunch[i], 0, 0.25, dt);
      this.nY[i] += dt * 3.2;
      if (this.nAge[i] >= this.nLife[i]) {
        const l = --this.nCount;
        this.nX[i] = this.nX[l]; this.nY[i] = this.nY[l]; this.nZ[i] = this.nZ[l];
        this.nVal[i] = this.nVal[l]; this.nAge[i] = this.nAge[l]; this.nLife[i] = this.nLife[l];
        this.nPunch[i] = this.nPunch[l]; this.nTarget[i] = this.nTarget[l]; this.nCrit[i] = this.nCrit[l];
        continue;
      }
      i++;
    }
  }

  // --- threats --------------------------------------------------------------

  /** 0 nothing, 1 perfect dodge, 2 hit, 3 graze. `d` is surface distance. */
  private hazard(d: number, tag: number): number {
    if (this.dashIframe > 0) {
      if (d <= GRAZE_R && tag !== this.dashId) return 1;
      return 0;
    }
    if (this.invuln > 0) return 0;
    if (d <= 0) return 2;
    if (d <= 1.5) return 3;
    return 0;
  }

  private checkThreats(dt: number) {
    let grazes = 0;

    for (let i = 0; i < this.aCount; i++) {
      const d = Math.hypot(this.ax[i] - this.px, this.az[i] - this.pz) - BULLET_R - PLAYER_R;
      const r = this.hazard(d, this.atag[i]);
      if (r === 1) {
        this.atag[i] = this.dashId;
        this.perfectDodge(this.ax[i], this.az[i]);
      } else if (r === 2) {
        this.takeHit();
        return;
      } else if (r === 3) grazes++;
    }

    for (let i = 0; i < this.oCount; i++) {
      const d = Math.hypot(this.ox[i] - this.px, this.oz[i] - this.pz) - 0.72 - PLAYER_R;
      const r = this.hazard(d, this.otag[i]);
      if (r === 1) {
        this.otag[i] = this.dashId;
        this.ododges[i]++;
        this.perfectDodge(this.ox[i], this.oz[i]);
        if (this.ododges[i] === 3) {
          this.addChain(3);
          this.say("TEASING", 0.7, 46, "#ffd24a");
        }
      } else if (r === 2) {
        this.takeHit();
        return;
      } else if (r === 3) grazes++;
    }

    for (let i = 0; i < this.lCount; i++) {
      if (this.lt[i] < 0 || this.lt[i] > 0.35) continue;
      const d = Math.hypot(this.lx[i] - this.px, this.lz[i] - this.pz) - 1.9 - PLAYER_R;
      const r = this.hazard(d, this.ltag[i]);
      if (r === 1) {
        this.ltag[i] = this.dashId;
        this.perfectDodge(this.lx[i], this.lz[i]);
      } else if (r === 2) {
        this.takeHit();
        return;
      } else if (r === 3) grazes++;
    }

    for (let i = 0; i < this.rCount; i++) {
      if (this.rr[i] < 0) continue;
      const d = Math.abs(Math.hypot(this.rx[i] - this.px, this.rz[i] - this.pz) - this.rr[i]) - 1.1 - PLAYER_R;
      const r = this.hazard(d, this.rtag[i]);
      if (r === 1) {
        this.rtag[i] = this.dashId;
        this.perfectDodge(this.px, this.pz);
      } else if (r === 2) {
        this.takeHit();
        return;
      } else if (r === 3) grazes++;
    }

    for (let b = 0; b < MAX_BEAMS; b++) {
      if (!this.beamLive[b]) continue;
      const dxp = this.px - this.bx;
      const dzp = this.pz - this.bz;
      const along = Math.sin(this.beamAng[b]) * dxp + Math.cos(this.beamAng[b]) * dzp;
      if (along <= 0) continue;
      const perp = Math.abs(Math.cos(this.beamAng[b]) * dxp - Math.sin(this.beamAng[b]) * dzp);
      const d = perp - 1.5 - PLAYER_R;
      const r = this.hazard(d, this.beamTag[b]);
      if (r === 1) {
        this.beamTag[b] = this.dashId;
        this.perfectDodge(this.px, this.pz);
      } else if (r === 2) {
        this.takeHit();
        return;
      } else if (r === 3) grazes++;
    }

    if (this.chargeT > 0) {
      const d = Math.hypot(this.bx - this.px, this.bz - this.pz) - 5.6 - PLAYER_R;
      const r = this.hazard(d, this.chargeDodge);
      if (r === 1) {
        this.chargeDodge = this.dashId;
        this.perfectDodge(this.px, this.pz);
        this.addChain(1);
      } else if (r === 2) {
        this.takeHit();
        return;
      } else if (r === 3) grazes++;
    }

    // Grazing without dashing trickles focus. Deliberately slow: focus is
    // meant to be earned by dashing into fire, not by standing near it.
    if (grazes > 0 && this.mode === "playing") {
      this.focus = clamp01(this.focus + Math.min(grazes, 4) * 0.02 * dt);
    }
  }

  private perfectDodge(x: number, z: number) {
    this.dashDodges++;
    this.addChain(1);
    this.focus = clamp01(this.focus + 0.14);
    this.edgeT = EDGE_TIME;
    this.warp.hitStop(0.05);
    this.shake.add(0.22);
    this.hitPulse = Math.max(this.hitPulse, 0.7);
    this.hintDone = true;

    this.addDisc(this.px, this.pz, 0.4, 4.4, 0.42, hdr(0xffffff, 6, this._cs));
    this.particles.burst(26, x, PLANE_Y, z, 13, {
      life: 0.45, size: 2.0, endSize: 0,
      color: hdr(0xffffff, 5, this._cs), drag: 0.25,
    });

    const f = 520 * Math.pow(2, Math.min(this.chain, 24) / 12);
    this.c.audio.play({ wave: "square", freq: f, freqTo: f * 1.5, glide: 0.05, vol: 0.16, attack: 0.001, hold: 0.03, release: 0.09 });
    this.c.audio.play({ wave: "sine", freq: f * 2, vol: 0.08, attack: 0.001, hold: 0.02, release: 0.12 });

    if (this.dashDodges === 1) {
      this.say("PERFECT", 0.55, 58, "#ffffff");
    } else if (this.dashDodges === 2) {
      this.say("DOUBLE", 0.6, 64, "#ffd24a");
    } else if (this.dashDodges === 3) {
      this.say("TRIPLE", 0.7, 72, "#b8f6ff");
      this.flourish();
    } else if (this.dashDodges >= 5) {
      this.say("IMPOSSIBLE", 0.9, 78, "#ff4fd8");
      this.flourish();
    }
    this.score += Math.round(120 * this.mult);
  }

  private flourish() {
    this.warp.slowMo(0.4, 0.3);
    this.desatHold = Math.max(this.desatHold, 0.35);
    this.flash(0.35, 0.5, 0.7);
    this.c.audio.play({ wave: "sine", freq: 1800, freqTo: 420, glide: 0.35, vol: 0.16, attack: 0.005, hold: 0.1, release: 0.3, filter: 4000, filterTo: 900 });
  }

  private addChain(n: number) {
    this.chain += n;
    this.chainPeak = Math.max(this.chainPeak, this.chain);
    this.chainTimer = this.chain >= 30 ? 2.4 : this.chain >= 10 ? 3.2 : 4.2;
    this.chainPunch = 0.35;
    this.mult = Math.min(8, 1 + Math.floor(this.chain / 5) * 0.5);
  }

  private takeHit() {
    if (this.mode !== "playing") return;
    this.hearts--;
    this.invuln = 1.3;
    this.hurtT = 0.55;
    this.focus = clamp01(this.focus - 0.4);
    this.edgeT = 0;
    this.warp.hitStop(0.12);
    this.warp.slowMo(0.35, 0.4);
    this.shake.add(0.75);
    this.flash(1.4, 0.12, 0.2);
    this.desatHold = 0.5;
    this.hitPulse = 1;
    this.c.audio.hit(0.4);
    this.c.audio.play({ wave: "sawtooth", freq: 160, freqTo: 50, glide: 0.4, vol: 0.3, attack: 0.002, hold: 0.1, release: 0.4, filter: 1200, filterTo: 200 });

    // The chain physically shatters where it is drawn.
    if (this.chain > 0) {
      this.chainShatter = 0.6;
      this.particles.burst(40, this.px, PLANE_Y + 1.5, this.pz, 14, {
        life: 0.7, size: 2.4, endSize: 0, color: hdr(0xff3355, 4, this._cs).clone(), gravity: -10,
      });
    }
    this.chain = 0;
    this.mult = 1;

    this.particles.burst(50, this.px, PLANE_Y, this.pz, 16, {
      life: 0.7, size: 2.6, endSize: 0, color: hdr(0xff2244, 4, this._cs).clone(), drag: 0.3,
    });
    this.addDisc(this.px, this.pz, 0.5, 7, 0.5, hdr(0xff2244, 4, this._cs));

    // Never re-hit out of hitstun: shove everything nearby back out.
    for (let i = 0; i < this.aCount; i++) {
      const dxp = this.ax[i] - this.px;
      const dzp = this.az[i] - this.pz;
      const d = Math.hypot(dxp, dzp);
      if (d < 3 && d > 0.001) {
        this.ax[i] = this.px + (dxp / d) * 3.5;
        this.az[i] = this.pz + (dzp / d) * 3.5;
      }
    }

    if (this.hearts <= 0) this.die();
    else this.say("HIT", 0.5, 52, "#ff4466");
  }

  private die() {
    this.mode = "dead";
    this.deathT = 0;
    this.warp.slowMo(2.0, 0.15);
    this.shake.add(1);
    this.desatHold = 3;
    this.flash(1.6, 0.3, 0.4);
    this.particles.burst(200, this.px, PLANE_Y, this.pz, 20, {
      life: 1.2, size: 3, endSize: 0, color: hdr(0xffffff, 4, this._cs).clone(), gravity: -6, drag: 0.4,
    });
    this.c.audio.stopMusic();
    this.musicBpm = 0;
    this.c.audio.explode(0.5);
    this.c.audio.fail(0.3);
    this.finishRun("over");
  }

  private finishRun(status: "over" | "won") {
    if (this.score > this.best) {
      this.best = Math.round(this.score);
      this.c.store.set("best", this.best);
    }
    this.c.report({
      status,
      score: Math.round(this.score),
      best: this.best,
      label: status === "won" ? "HOLLOW KING FELLED" : `PHASE ${ROMAN[this.phase]}`,
    });
  }

  // --- plates & damage ------------------------------------------------------

  private updatePlates(dt: number) {
    for (let i = 0; i < PLATES; i++) {
      this.plHit[i] = Math.max(0, this.plHit[i] - dt * 4);
      const g = this.plateGroups[i];
      if (!this.plBroken[i]) {
        const a = this.bossSpin + (i / PLATES) * TAU;
        const bob = Math.sin(this.time * 0.7 + i * 1.3) * 1.8;
        this.plX[i] = this.bx + Math.cos(a) * PLATE_ORBIT;
        this.plZ[i] = this.bz + Math.sin(a) * PLATE_ORBIT;
        this.plY[i] = this.by + bob;
        g.position.set(this.plX[i], this.plY[i], this.plZ[i]);
        g.rotation.set(Math.sin(this.time * 0.5 + i) * 0.2, -a, Math.cos(this.time * 0.4 + i) * 0.25);
      } else if (!this.plRest[i]) {
        // Detached: outward+up impulse, gravity 28, one bounce, then wreckage.
        this.plVy[i] -= 28 * dt;
        g.position.x += this.plVx[i] * dt;
        g.position.y += this.plVy[i] * dt;
        g.position.z += this.plVz[i] * dt;
        g.rotation.x += this.plWx[i] * dt;
        g.rotation.y += this.plWy[i] * dt;
        g.rotation.z += this.plWz[i] * dt;
        if (g.position.y < 0.8) {
          g.position.y = 0.8;
          if (this.plVy[i] < -4) {
            this.plVy[i] *= -0.35;
            this.plVx[i] *= 0.5;
            this.plVz[i] *= 0.5;
            this.plWx[i] *= 0.4;
            this.plWy[i] *= 0.4;
            this.plWz[i] *= 0.4;
            this.shake.add(0.14);
            this.c.audio.thud(0.2);
            this.particles.burst(14, g.position.x, 0.6, g.position.z, 9, {
              life: 0.5, size: 2, endSize: 0, color: this.cSeam, gravity: -14,
            });
          } else {
            this.plRest[i] = 1;
            this.plVy[i] = 0;
            g.rotation.x = Math.PI * 0.5 * 0.32;
            g.rotation.z = -0.28;
          }
        }
      }
    }
  }

  private updateTracerHits() {
    if (this.mode === "dead" || this.mode === "won") return;
    const coreR = this.breachT > 0 ? CORE_R * 2 : CORE_R;
    const dmgMul = (this.edgeT > 0 ? 3 : 1) * (this.breachT > 0 ? 4 : 1);
    const bodyDmg = 8 + 4 * this.platesBroken;

    let i = 0;
    while (i < this.tCount) {
      let hitTarget = -2;
      let hx = 0;
      let hy = 0;
      let hz = 0;
      for (let p = 0; p < PLATES; p++) {
        if (this.plBroken[p]) continue;
        const dxp = this.tx[i] - this.plX[p];
        const dzp = this.tz[i] - this.plZ[p];
        const dyp = PLANE_Y + 6 - this.plY[p];
        if (dxp * dxp + dzp * dzp < (coreR + 1.6) * (coreR + 1.6) && Math.abs(dyp) < 9) {
          hitTarget = p;
          hx = this.plX[p];
          hy = this.plY[p];
          hz = this.plZ[p];
          break;
        }
      }
      if (hitTarget === -2) {
        const dxp = this.tx[i] - this.bx;
        const dzp = this.tz[i] - this.bz;
        if (dxp * dxp + dzp * dzp < 6.4 * 6.4) {
          hitTarget = -1;
          hx = this.tx[i];
          hy = this.by + this.c.rng.range(-3, 3);
          hz = this.tz[i];
        }
      }

      if (hitTarget !== -2) {
        const raw = hitTarget >= 0 ? 22 : bodyDmg;
        const dmg = Math.round(raw * dmgMul);
        if (hitTarget >= 0) {
          this.plHp[hitTarget] -= dmg;
          this.plHit[hitTarget] = 1;
          if (this.plHp[hitTarget] <= 0) this.breakPlate(hitTarget);
        } else {
          this.bossHitFlash = 1;
        }
        this.damageBoss(dmg);
        this.pushNumber(hitTarget, hx, hy, hz, dmg, dmgMul > 1);
        this.score += Math.round(12 * this.mult);
        this.particles.burst(4, this.tx[i], PLANE_Y + 5.5, this.tz[i], 7, {
          life: 0.28, size: 1.7, endSize: 0, color: dmgMul > 1 ? hdr(0xffffff, 5, this._cs) : this.cTracer,
        });
        const l = --this.tCount;
        this.tx[i] = this.tx[l]; this.tz[i] = this.tz[l];
        this.tvx[i] = this.tvx[l]; this.tvz[i] = this.tvz[l];
        this.tlife[i] = this.tlife[l];
        continue;
      }
      i++;
    }
  }

  private damageBoss(dmg: number) {
    if (this.mode !== "playing") return;
    this.bossHp -= dmg;
    const frac = this.bossHp / BOSS_HP;
    if (this.bossHp <= 0) {
      this.win();
    } else if (this.phase === 0 && frac <= 0.66) {
      this.enterPhase(1);
    } else if (this.phase === 1 && frac <= 0.33) {
      this.enterPhase(2);
    }
  }

  private breakPlate(i: number) {
    this.plBroken[i] = 1;
    this.platesBroken++;
    const g = this.plateGroups[i];
    const a = Math.atan2(this.plZ[i] - this.bz, this.plX[i] - this.bx);
    this.plVx[i] = Math.cos(a) * 16;
    this.plVz[i] = Math.sin(a) * 16;
    this.plVy[i] = 13;
    this.plWx[i] = this.c.rng.range(-6, 6);
    this.plWy[i] = this.c.rng.range(-6, 6);
    this.plWz[i] = this.c.rng.range(-6, 6);

    this.warp.hitStop(0.16);
    this.warp.slowMo(0.4, 0.3);
    this.shake.add(0.8);
    this.flash(0.7, 0.9, 1.1);
    this.hitPulse = 1;
    this.addChain(3);
    this.focus = clamp01(this.focus + 0.2);
    this.score += Math.round(2000 * this.mult);
    this.say("PLATE BREAK", 0.8, 56, "#b8f6ff");
    this.particles.burst(90, this.plX[i], this.plY[i], this.plZ[i], 22, {
      life: 0.9, size: 2.8, endSize: 0, color: this.cCore.clone(), drag: 0.35,
    });
    this.addDisc(this.plX[i], this.plZ[i], 1, 16, 0.55, this.cCore);
    this.c.audio.explode(0.4);
    this.c.audio.play({ wave: "square", freq: 900, freqTo: 220, glide: 0.25, vol: 0.2, attack: 0.002, hold: 0.06, release: 0.25 });
    // Stripping the boss accelerates the kill instead of grinding it out.
    this.damageBoss(Math.round(BOSS_HP * 0.06));
  }

  private enterPhase(p: number) {
    this.phase = p;
    this.palA = this.palB;
    this.palB = p;
    this.palT = 0;
    this.phaseT = 3.2;
    this.invuln = 3.2;
    this.dashCd[0] = 0;
    this.dashCd[1] = 0;
    this.roarT = 1.4;
    this.jawOpen = 1;

    this.warp.hitStop(0.3);
    this.warp.slowMo(1.4, 0.35);
    this.shake.add(1);
    this.flash(1.2, 1.2, 1.4);
    this.desatHold = 0.4;
    this.say(`PHASE ${ROMAN[p]}`, 1.4, 92, "#ffffff");
    this.score += Math.round(5000 * this.mult);

    this.aCount = 0;
    this.oCount = 0;
    this.lCount = 0;
    this.rCount = 0;
    for (let i = 0; i < MAX_BEAMS; i++) this.beamLive[i] = 0;
    for (const a of this.attacks) a.live = false;
    this.atkT = 2.4;

    this.tileImpulse(this.bx, this.bz, 18, 12);
    // ~11 tiles per transition never come back; visual only, never lethal.
    for (let k = 0; k < 11; k++) {
      const i = this.c.rng.int(0, this.fCount - 1);
      this.fAlive[i] = 0;
    }
    this.spawnRing(this.bx, this.bz, 0, 40);
    this.particles.burst(220, this.bx, this.by, this.bz, 30, {
      life: 1.1, size: 3.2, endSize: 0, color: this.cCore.clone(), drag: 0.35,
    });
    this.c.audio.explode(0.5);
    this.c.audio.play({ wave: "sawtooth", freq: 70, freqTo: 240, glide: 1.1, vol: 0.32, attack: 0.06, hold: 0.7, release: 0.6, filter: 400, filterTo: 2400 });
    this.c.audio.stopMusic();
    this.musicBpm = 0;
    this.startMusic();
  }

  private win() {
    this.mode = "won";
    this.deathT = 0;
    this.bossHp = 0;
    this.warp.hitStop(0.35);
    this.warp.slowMo(2.6, 0.18);
    this.shake.add(1);
    this.flash(1.6, 1.6, 1.8);
    this.score += Math.round(25000 * this.mult);
    this.say("HOLLOW KING FELLED", 3, 74, "#ffffff");
    for (let k = 0; k < 6; k++) {
      this.spawnRing(this.bx, this.bz, -k * 4, 30);
    }
    this.particles.burst(600, this.bx, this.by, this.bz, 34, {
      life: 1.8, size: 3.4, endSize: 0, color: hdr(0xffffff, 5, this._cs).clone(), drag: 0.4, gravity: -4,
    });
    this.c.audio.stopMusic();
    this.musicBpm = 0;
    this.c.audio.explode(0.6);
    this.c.audio.powerUp(0.3);
    this.finishRun("won");
  }

  private pushNumber(target: number, x: number, y: number, z: number, dmg: number, crit: boolean) {
    // Thirteen hits a second would be soup; merge same-target hits inside 0.1s.
    for (let i = 0; i < this.nCount; i++) {
      if (this.nTarget[i] === target && this.nAge[i] < 0.1) {
        this.nVal[i] += dmg;
        this.nAge[i] = 0;
        this.nPunch[i] = 0.45;
        this.nX[i] = x;
        this.nY[i] = y;
        this.nZ[i] = z;
        if (crit) this.nCrit[i] = 1;
        return;
      }
    }
    if (this.nCount >= MAX_DMG) return;
    const i = this.nCount++;
    this.nX[i] = x;
    this.nY[i] = y;
    this.nZ[i] = z;
    this.nVal[i] = dmg;
    this.nAge[i] = 0;
    this.nLife[i] = 0.85;
    this.nPunch[i] = 0.5;
    this.nTarget[i] = target;
    this.nCrit[i] = crit ? 1 : 0;
  }

  // --- meters ---------------------------------------------------------------

  private updateMeters(dt: number) {
    this.phaseT = Math.max(0, this.phaseT - dt);
    this.bossHpGhost = damp(this.bossHpGhost, clamp01(this.bossHp / BOSS_HP), 0.06, dt);

    if (this.chain > 0) {
      this.chainTimer -= dt;
      if (this.chainTimer <= 0) {
        // Decay HALVES rather than zeroing — a lapse is not a run-ender.
        this.chain = Math.floor(this.chain / 2);
        this.mult = Math.min(8, 1 + Math.floor(this.chain / 5) * 0.5);
        this.chainTimer = this.chain >= 30 ? 2.4 : this.chain >= 10 ? 3.2 : 4.2;
        this.chainPunch = -0.25;
        this.c.audio.play({ wave: "triangle", freq: 420, freqTo: 340, glide: 0.18, vol: 0.13, attack: 0.005, hold: 0.06, release: 0.2 });
      }
    }

    if (this.breachT > 0) {
      this.breachT -= dt;
      this.focus = clamp01(this.breachT / BREACH_TIME);
      if (this.breachT <= 0) this.focus = 0;
    } else {
      if (this.focus > 0) this.focus = clamp01(this.focus - 0.045 * dt);
      if (this.focus >= 1 && this.mode === "playing") this.breach();
    }
    this.breachSlow = Math.max(0, this.breachSlow - dt);

    if (this.hintT > 0 && !this.hintDone) this.hintT -= dt;

    if (!this.bestBeaten && this.score > this.best && this.best > 0 && this.mode === "playing") {
      this.bestBeaten = true;
      this.newBestT = 2.4;
      this.flash(0.9, 0.8, 0.2);
      this.shake.add(0.5);
      this.say("NEW BEST", 1.6, 84, "#ffd24a");
      this.particles.burst(180, this.px, PLANE_Y, this.pz, 18, {
        life: 1.5, size: 2.8, endSize: 0, color: hdr(0xffd24a, 4.5, this._cs).clone(), gravity: 5, drag: 0.4,
      });
      this.c.audio.powerUp(0.28);
    }

    this.fovTarget = damp(this.fovTarget, this.breachT > 0 ? 66 : 58, 0.06, dt);
  }

  /** The earned slow-motion beat. Fires the frame focus fills — never fumbled. */
  private breach() {
    this.breachT = BREACH_TIME;
    this.breachSlow = 1.2;
    this.focus = 1;
    this.warp.hitStop(0.14);
    this.warp.slowMo(1.2, 0.22);
    this.shake.add(0.6);
    this.flash(0.4, 1.3, 1.6);
    this.fovTarget = 66;
    this.say("BREACH", 1.2, 88, "#b8f6ff");
    this.addDisc(this.px, this.pz, 0.5, 34, 0.45, hdr(0xffffff, 6, this._cs));

    // Particles converge onto the player, then blow back out.
    hdr(0x9ff0ff, 5, this._cs);
    for (let i = 0; i < 200; i++) {
      const a = Math.random() * TAU;
      const el = (Math.random() - 0.5) * 1.4;
      const r = 20;
      const x = this.px + Math.cos(a) * r;
      const y = PLANE_Y + el * r;
      const z = this.pz + Math.sin(a) * r;
      this.particles.spawn({
        x, y, z,
        vx: (this.px - x) * 3.4, vy: (PLANE_Y - y) * 3.4, vz: (this.pz - z) * 3.4,
        life: 0.34, size: 2.2, endSize: 0.4,
        color: this._cs, drag: 0.9,
      });
    }
    this.c.audio.play({ wave: "sawtooth", freq: 2400, freqTo: 180, glide: 0.5, vol: 0.26, attack: 0.005, hold: 0.2, release: 0.4, filter: 5000, filterTo: 300 });
    this.c.audio.chord([
      { wave: "square", freq: 220, vol: 0.11, attack: 0.01, hold: 0.4, release: 0.5 },
      { wave: "square", freq: 262, vol: 0.11, attack: 0.01, hold: 0.4, release: 0.5 },
      { wave: "square", freq: 330, vol: 0.11, attack: 0.01, hold: 0.4, release: 0.5 },
      { wave: "square", freq: 392, vol: 0.09, attack: 0.01, hold: 0.4, release: 0.5 },
      { wave: "square", freq: 523, vol: 0.09, attack: 0.01, hold: 0.4, release: 0.5 },
    ]);
  }

  // --- floor ----------------------------------------------------------------

  private tileImpulse(cx: number, cz: number, out: number, up: number) {
    for (let i = 0; i < this.fCount; i++) {
      if (!this.fAlive[i]) continue;
      const d = Math.hypot(this.fX[i] - cx, this.fZ[i] - cz);
      const k = clamp01(1 - d / (ARENA * 1.2));
      this.fVy[i] += up * (0.4 + k);
      this.fVrx[i] += (Math.random() - 0.5) * out * 0.4;
      this.fVrz[i] += (Math.random() - 0.5) * out * 0.4;
    }
  }

  private updateTiles(dt: number) {
    for (let i = 0; i < this.fCount; i++) {
      if (this.fVy[i] === 0 && this.fY[i] === 0) continue;
      this.fVy[i] -= 34 * dt;
      this.fY[i] += this.fVy[i] * dt;
      this.fRx[i] += this.fVrx[i] * dt;
      this.fRz[i] += this.fVrz[i] * dt;
      if (this.fY[i] <= 0) {
        this.fY[i] = 0;
        this.fVy[i] = 0;
        this.fVrx[i] *= 0.2;
        this.fVrz[i] *= 0.2;
        if (Math.abs(this.fVrx[i]) < 0.2) this.fVrx[i] = 0;
        if (Math.abs(this.fVrz[i]) < 0.2) this.fVrz[i] = 0;
      }
    }
  }

  // --- camera ---------------------------------------------------------------

  private updateCamera(dt: number) {
    if (this.mode === "attract") {
      this.camYaw += dt * 0.105;
      const r = 36;
      this.camCx = damp(this.camCx, 0, 0.05, dt);
      this.camCz = damp(this.camCz, 0, 0.05, dt);
      this.camPos.set(Math.sin(this.camYaw) * r, 19, Math.cos(this.camYaw) * r);
      this.camLook.set(0, 6.5, 0);
    } else {
      this.camYaw = damp(this.camYaw, 0, 0.07, dt);
      // Frame the boss in the upper third by biasing the centre toward it.
      const cx = lerp(this.px, this.bx, 0.42);
      const cz = lerp(this.pz, this.bz, 0.42);
      this.camCx = damp(this.camCx, cx, 0.11, dt);
      this.camCz = damp(this.camCz, cz, 0.11, dt);
      const s = Math.sin(this.camYaw);
      const c = Math.cos(this.camYaw);
      this.camPos.set(this.camCx + s * 23, 18.5, this.camCz + c * 23);
      this.camLook.set(this.camCx, 4.2, this.camCz);
    }
  }

  // --- misc -----------------------------------------------------------------

  private say(text: string, life: number, size: number, color: string) {
    let slot = this.callouts.find((c) => !c.live);
    if (!slot) slot = this.callouts[0];
    slot.text = text;
    slot.t = 0;
    slot.life = life;
    slot.size = size;
    slot.color = color;
    slot.live = true;
  }

  private flash(r: number, g: number, b: number) {
    this.flashR = Math.max(this.flashR, r);
    this.flashG = Math.max(this.flashG, g);
    this.flashB = Math.max(this.flashB, b);
  }

  private pushReport() {
    this.reportT -= 1 / 60;
    const s = Math.round(this.score);
    if (this.reportT <= 0 && s !== this.lastReported) {
      this.reportT = 0.2;
      this.lastReported = s;
      this.c.report({
        status: "playing",
        score: s,
        best: this.best,
        label: `PHASE ${ROMAN[this.phase]}  ×${this.mult.toFixed(1)}`,
      });
    }
  }

  // --- draw -----------------------------------------------------------------

  draw() {
    if (!this.ready) return;
    this.syncScene();
    this.writePools();
    this.driveGrade();

    this.camera.position.copy(this.camPos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.camLook);
    if (Math.abs(this.camera.fov - this.fovTarget) > 0.05) {
      this.camera.fov = this.fovTarget;
      this.camera.updateProjectionMatrix();
    }
    this.shake.apply(this.camera, 0.55);
    this.camera.updateMatrixWorld();
    this.post.composer.render();
    this.drawHud();
    this.hud.commit(this.renderer);
  }

  private syncScene() {
    const t = this.time;
    this.skyMat.uniforms.uTime.value = t;
    (this.skyMat.uniforms.uTop.value as THREE.Color).copy(this.cSkyTop);
    (this.skyMat.uniforms.uBot.value as THREE.Color).copy(this.cSkyBot);
    this.dustMat.uniforms.uTime.value = t;
    (this.dustMat.uniforms.uTint.value as THREE.Color).copy(this.cRim).multiplyScalar(0.4);
    (this.scene.fog as THREE.FogExp2).color.copy(this.cFog);
    this.ribMat.color.copy(this.cRib);
    for (const r of this.ribs) r.rotation.z += (r.userData.spin as number) * 0.016;

    const rimPulse = 0.7 + 0.3 * Math.sin(t * 2.2);
    this.rimMat.color.copy(this.cRim).multiplyScalar(rimPulse);
    this.rimMat.opacity = 0.85;

    // Boss.
    this.bossRoot.position.set(this.bx, this.by, this.bz);
    this.bossRoot.rotation.y = Math.sin(t * 0.35) * 0.22;
    this.bossRoot.rotation.z = Math.sin(t * 0.27) * 0.06;
    this.crownRoot.rotation.y = -this.bossSpin * 1.3;
    this.jawPivot.rotation.x = this.jawOpen * 0.6 + this.roarT * 0.35;

    this._cs.copy(this.cHull).multiplyScalar(1 + this.bossHitFlash * 3);
    this.hullMat.color.copy(this._cs);
    this.jawMat.color.copy(this._cs);
    const roar = 1 + this.roarT * 1.2 + this.jawOpen * 0.4;
    this.crownMat.color.copy(this.cCrown).multiplyScalar(roar);
    const eyeP = 1 + 0.25 * Math.sin(t * 5) + this.roarT * 1.5;
    this.eyeMat.color.copy(this.cEye).multiplyScalar(eyeP);
    this.haloMat.color.copy(this.cRim).multiplyScalar(0.7 + this.jawOpen * 0.6);
    this.haloMat.opacity = 0.5;

    for (let i = 0; i < PLATES; i++) {
      if (this.plBroken[i]) {
        // Wreckage keeps a dying ember pulse just under the bloom threshold.
        const ember = 0.9 * (0.7 + 0.3 * Math.sin(t * 1.6 + i));
        this.plateMats[i].color.copy(this.cHull).multiplyScalar(0.7);
        this.coreMats[i].color.copy(this.cCore).multiplyScalar(ember * 0.22);
        this.coreMeshes[i].scale.setScalar(0.7);
      } else {
        this.plateMats[i].color.copy(this.cHull).multiplyScalar(1 + this.plHit[i] * 2);
        const hp = clamp01(this.plHp[i] / PLATE_HP);
        const low = hp < 0.3 ? 1 + Math.sin(t * 18) * 0.5 : 1;
        this.coreMats[i].color.copy(this.cCore).multiplyScalar((1 + this.plHit[i] * 1.6) * low);
        this.coreMeshes[i].scale.setScalar(this.breachT > 0 ? 2 : 1);
      }
    }

    for (let b = 0; b < MAX_BEAMS; b++) {
      const root = this.beamRoots[b];
      if (!this.beamLive[b]) {
        root.visible = false;
        continue;
      }
      root.visible = true;
      root.position.set(this.bx, this.by, this.bz);
      // Geometry points along local +X; rotation.y maps +X to (cos, -sin), so
      // matching the collision convention (sin a, cos a) needs the -90 offset.
      root.rotation.y = this.beamAng[b] - Math.PI / 2;
      const life = this.beamT[b] / Math.max(0.001, this.beamDur[b]);
      const fade = life > 0.85 ? 1 - (life - 0.85) / 0.15 : 1;
      const flick = 0.82 + 0.18 * Math.sin(this.time * 40);
      this.beamMats[b].color.copy(this.cBeam).multiplyScalar(flick);
      this.beamMats[b].opacity = 0.9 * fade;
      this.beamDecalMats[b].color.copy(this.cBeam).multiplyScalar(0.7);
      this.beamDecalMats[b].opacity = 0.55 * fade;
    }

    // Player.
    const hurt = this.hurtT > 0 && Math.sin(this.realTime * 60) > 0;
    const edge = this.edgeT > 0 || this.breachT > 0;
    this.playerMesh.position.set(this.px, PLANE_Y, this.pz);
    this.playerMesh.rotation.set(t * 2.1, this.aimAng, t * 1.4);
    this.playerMesh.scale.setScalar(this.dashT > 0 ? 1.35 : 1);
    const pcol = edge ? hdr(0xffffff, 4.4, this._cs) : hdr(0xffffff, 2.2, this._cs);
    this.playerMat.color.copy(pcol);
    if (hurt) this.playerMat.color.setRGB(4, 0.4, 0.7);
    this.playerMesh.visible = this.mode !== "dead";
    this.playerGlow.position.set(this.px, PLANE_Y, this.pz);
    this.playerGlow.scale.setScalar(3.6 + (this.dashIframe > 0 ? 3.2 : 0) + this.focus * 2);
    this.playerGlowMat.color.copy(this.cTracer).multiplyScalar(this.dashIframe > 0 ? 1.6 : 0.8);
    this.playerGlowMat.opacity = this.mode === "dead" ? 0 : this.mode === "attract" ? 0.45 : 0.8;
  }

  private writePools() {
    const t = this.time;

    // Floor: a radial pulse rides outward from the boss at 14 u/s.
    const tp = this.tilePool;
    tp.begin();
    for (let i = 0; i < this.fCount; i++) {
      if (!this.fAlive[i]) continue;
      const d = Math.hypot(this.fX[i] - this.bx, this.fZ[i] - this.bz);
      const w = Math.sin(d * 0.42 - t * 5.9);
      const lift = Math.max(0, w) * 0.35;
      const glow = Math.max(0, w) ** 3;
      this._cs.copy(this.cTile).lerp(this.cSeam, glow * 0.85);
      tp.write(this.fX[i], this.fY[i] + lift - 0.25, this.fZ[i], 1, this._cs, {
        x: this.fRx[i], y: 0, z: this.fRz[i],
      });
    }
    tp.end();

    const bp = this.bulletPool;
    bp.begin();
    const bpulse = 1 + 0.18 * Math.sin(t * 12);
    this._cs.copy(this.cBullet).multiplyScalar(bpulse);
    for (let i = 0; i < this.aCount; i++) {
      bp.write(this.ax[i], PLANE_Y, this.az[i], this.asz[i], this._cs, {
        x: t * 3 + i, y: t * 2.4, z: 0,
      });
    }
    bp.end();

    const trp = this.tracerPool;
    trp.begin();
    const tcol = this.edgeT > 0 ? hdr(0xffffff, 4.2, this._ca) : this.cTracer;
    for (let i = 0; i < this.tCount; i++) {
      // Tracers climb as they close on the boss so the stream visibly lands on
      // the cores instead of sliding along the floor underneath them.
      const dB = Math.hypot(this.tx[i] - this.bx, this.tz[i] - this.bz);
      const y = PLANE_Y + clamp01(1 - dB / 15) ** 2 * 6.2;
      trp.write(this.tx[i], y, this.tz[i], { x: 1, y: 1, z: 1.6 }, tcol, {
        x: 0, y: Math.atan2(this.tvx[i], this.tvz[i]), z: 0,
      });
    }
    // The 12-segment motion trail rides the same pool — same material, no cost.
    const n = this.trailX.length;
    for (let k = 1; k <= 12; k++) {
      const idx = (this.trailHead - k + n * 2) % n;
      const f = 1 - k / 13;
      this._cb.copy(this.cTracer).multiplyScalar(f * 0.8);
      trp.write(this.trailX[idx], PLANE_Y, this.trailZ[idx], f * 1.6, this._cb);
    }
    trp.end();

    const op = this.orbPool;
    op.begin();
    this._cs.copy(this.cBullet).multiplyScalar(1.3 + 0.3 * Math.sin(t * 9));
    for (let i = 0; i < this.oCount; i++) {
      op.write(this.ox[i], PLANE_Y, this.oz[i], 1, this._cs, { x: t * 4, y: t * 3, z: 0 });
    }
    op.end();

    const lp = this.pillarPool;
    lp.begin();
    for (let i = 0; i < this.lCount; i++) {
      if (this.lt[i] < 0) continue;
      const k = clamp01(1 - this.lt[i] / 0.5);
      this._cs.copy(this.cBeam).multiplyScalar(1.4 * k);
      lp.write(this.lx[i], 0, this.lz[i], { x: k * 0.6 + 0.6, y: 1, z: k * 0.6 + 0.6 }, this._cs);
    }
    lp.end();

    const dp = this.discPool;
    dp.begin();
    for (let i = 0; i < this.dCount; i++) {
      const k = clamp01(this.dlife[i] / this.dmax[i]);
      const e = easeOutQuart(1 - k);
      const r = lerp(this.dr[i], this.dgrow[i], e);
      this._cs.setRGB(this.dcr[i] * k, this.dcg[i] * k, this.dcb[i] * k);
      dp.write(this.dx[i], 0.12, this.dz[i], { x: r * 2, y: 1, z: r * 2 }, this._cs);
    }
    // Pillar telegraphs and shockwaves share the ring pool.
    for (let i = 0; i < this.lCount; i++) {
      if (this.lt[i] >= 0) continue;
      const k = clamp01(1 + this.lt[i] / Math.max(0.05, this.ltell[i]));
      const pulse = 0.5 + 0.5 * Math.sin(this.realTime * 22);
      this._cs.copy(this.cBeam).multiplyScalar((0.5 + k * 0.9) * pulse);
      dp.write(this.lx[i], 0.1, this.lz[i], { x: 4.2, y: 1, z: 4.2 }, this._cs);
    }
    for (let i = 0; i < this.rCount; i++) {
      if (this.rr[i] <= 0) continue;
      this._cs.copy(this.cBeam).multiplyScalar(clamp01(this.rlife[i]) * 1.5);
      dp.write(this.rx[i], 0.14, this.rz[i], { x: this.rr[i] * 2, y: 1, z: this.rr[i] * 2 }, this._cs);
    }
    dp.end();
  }

  private driveGrade() {
    const u = this.post.grade.uniforms;
    const dashN = clamp01(this.dashT / DASH_TIME);
    const breachN = clamp01(this.breachSlow / 1.2);
    const phaseN = clamp01(this.phaseT / 3.2);
    const chargeN = clamp01(this.chargeT / 0.55);
    const lowHp = this.mode === "playing" && this.hearts <= 1 ? 1 : 0;
    const dead = this.mode === "dead" ? clamp01(this.deathT * 1.6) : 0;

    u.amount.value = 0.0016 + dashN * 0.004 + this.hitPulse * 0.012 + breachN * 0.008;
    u.warp.value = dashN * 0.09 + chargeN * 0.14 + phaseN * 0.22;
    u.vignette.value = 0.85 + lowHp * 0.35 + breachN * 0.2 + dead * 0.3;
    u.desat.value = Math.max(breachN * 0.72, this.desatHold, dead * 0.85);
    u.scan.value = 0.03 + (this.phase === 2 ? 0.05 : this.phase === 1 ? 0.02 : 0);
    u.time.value = this.realTime;
    (u.flash.value as THREE.Color).setRGB(this.flashR, this.flashG, this.flashB);

    this.post.bloom.strength =
      1.05 + this.phase * 0.35 + breachN * 1.0 + this.hitPulse * 0.6 + this.focus * 0.25;
  }

  // --- HUD ------------------------------------------------------------------

  private drawHud() {
    const g = this.hud.begin();
    const w = this.w;
    const h = this.h;
    const accent = this.pal.hudAccent;

    this.drawBossBar(g, w, accent);
    this.drawDamageNumbers(g, w, h);

    if (this.mode !== "attract") {
      this.drawScore(g, w, accent);
      this.drawChain(g, w, h);
      this.drawFocus(g, w, h, accent);
      this.drawHearts(g, h);
    }

    this.drawCallouts(g, w, h);

    if (this.mode === "attract") this.drawTitle(g, w, h, accent);
    if (this.mode === "dead" || this.mode === "won") this.drawEndCard(g, w, h, accent);

    if (this.mode === "playing" && this.hintT > 0 && !this.hintDone) {
      g.globalAlpha = clamp01(this.hintT / 2);
      g.textAlign = "center";
      g.font = "700 20px ui-monospace, SFMono-Regular, Menlo, monospace";
      glowText(g, "SPACE THROUGH THE RED", w * 0.5, h - 132, "#ffffff", 16);
      g.globalAlpha = 1;
    }

    if (this.c.isTouch && this.mode === "playing") this.drawTouch(g, w, h, accent);
  }

  private drawBossBar(g: CanvasRenderingContext2D, w: number, accent: string) {
    const x = w * 0.13;
    const y = 30;
    const bw = w * 0.74;
    const bh = 17;
    const v = clamp01(this.bossHp / BOSS_HP);

    g.fillStyle = "rgba(0,0,0,0.55)";
    g.fillRect(x - 3, y - 3, bw + 6, bh + 6);
    if (this.bossHpGhost > v) {
      g.fillStyle = "rgba(255,255,255,0.42)";
      g.fillRect(x + bw * v, y, bw * (this.bossHpGhost - v), bh);
    }
    const grd = g.createLinearGradient(x, 0, x + bw, 0);
    grd.addColorStop(0, accent);
    grd.addColorStop(1, "#ffffff");
    g.fillStyle = grd;
    g.fillRect(x, y, bw * v, bh);

    g.strokeStyle = "rgba(0,0,0,0.55)";
    g.lineWidth = 1;
    for (let i = 1; i < 20; i++) {
      const cx = x + (bw * i) / 20;
      g.beginPath();
      g.moveTo(cx, y);
      g.lineTo(cx, y + bh);
      g.stroke();
    }
    g.fillStyle = "#ff3355";
    for (const m of [0.33, 0.66]) {
      g.fillRect(x + bw * m - 1.5, y - 4, 3, bh + 8);
    }

    g.font = "700 12px ui-monospace, SFMono-Regular, Menlo, monospace";
    g.textAlign = "left";
    g.fillStyle = "rgba(255,255,255,0.85)";
    this.spaced(g, "HOLLOWKING", x, y - 8, 3.2);
    g.textAlign = "right";
    g.fillStyle = accent;
    const tag = this.rage ? `PHASE ${ROMAN[this.phase]} · RAGE` : `PHASE ${ROMAN[this.phase]}`;
    g.fillText(tag, x + bw, y - 8);
    g.textAlign = "left";
  }

  private drawScore(g: CanvasRenderingContext2D, w: number, accent: string) {
    const x = w * 0.13;
    g.textAlign = "left";
    g.font = "800 42px ui-monospace, SFMono-Regular, Menlo, monospace";
    glowText(g, fmt(Math.round(this.score)), x, 96, this.bestBeaten ? "#ffd24a" : "#ffffff", 14);
    g.font = "700 12px ui-monospace, SFMono-Regular, Menlo, monospace";
    g.fillStyle = "rgba(255,255,255,0.5)";
    g.fillText(`BEST ${fmt(this.best)}`, x, 116);
    if (this.newBestT > 0) {
      g.fillStyle = accent;
      g.fillText("RECORD BROKEN", x + 130, 116);
    }
  }

  private drawChain(g: CanvasRenderingContext2D, w: number, h: number) {
    const cy = h * 0.4;
    // Always on screen, dimmed at zero — the player must know it exists before
    // they earn one.
    g.globalAlpha = this.chain > 0 || this.chainShatter > 0 ? 1 : 0.4;
    const cx = w - 56;
    const col =
      this.chain >= 50 ? "#ff4fd8" : this.chain >= 30 ? "#b8f6ff" : this.chain >= 15 ? "#ffd24a" : "#ffffff";
    const scale = 1 + this.chainPunch;
    const jitter = this.chain >= 50 ? (Math.random() - 0.5) * 2 : 0;

    g.save();
    g.translate(cx + jitter, cy);
    g.scale(scale, scale);
    g.textAlign = "right";
    g.font = "800 92px ui-monospace, SFMono-Regular, Menlo, monospace";
    if (this.chainShatter > 0) g.globalAlpha = clamp01(this.chainShatter / 0.6);
    glowText(g, String(this.chain), 0, 0, this.chainShatter > 0 ? "#ff3355" : col, 26);
    g.font = "800 34px ui-monospace, SFMono-Regular, Menlo, monospace";
    glowText(g, `×${this.mult.toFixed(1)}`, 0, -74, col, 16);
    g.font = "700 12px ui-monospace, SFMono-Regular, Menlo, monospace";
    g.fillStyle = "rgba(255,255,255,0.45)";
    g.fillText("CHAIN", 0, 24);
    g.restore();

    // Decay arc: the tension meter.
    const full = this.chain >= 30 ? 2.4 : this.chain >= 10 ? 3.2 : 4.2;
    const k = clamp01(this.chainTimer / full);
    g.save();
    g.translate(cx - 46, cy - 26);
    g.lineWidth = 4;
    g.strokeStyle = "rgba(255,255,255,0.12)";
    g.beginPath();
    g.arc(0, 0, 74, 0, TAU);
    g.stroke();
    g.strokeStyle = k < 0.3 ? "#ff3355" : col;
    g.beginPath();
    g.arc(0, 0, 74, -Math.PI / 2, -Math.PI / 2 + TAU * k);
    g.stroke();
    g.restore();
    g.globalAlpha = 1;
  }

  private drawFocus(g: CanvasRenderingContext2D, w: number, h: number, accent: string) {
    const bw = w * 0.24;
    const x = (w - bw) * 0.5;
    const y = h - 54;
    const breaching = this.breachT > 0;
    g.fillStyle = "rgba(0,0,0,0.5)";
    roundRectPath(g, x - 2, y - 2, bw + 4, 14, 7);
    g.fill();
    g.fillStyle = breaching ? "#ffffff" : this.focus >= 1 ? "#ff4fd8" : accent;
    roundRectPath(g, x, y, bw * this.focus, 10, 5);
    g.fill();
    g.textAlign = "center";
    g.font = "700 12px ui-monospace, SFMono-Regular, Menlo, monospace";
    const label = breaching ? "BREACH" : this.edgeT > 0 ? "EDGE ×3" : "FOCUS";
    glowText(g, label, w * 0.5, y + 30, breaching ? "#b8f6ff" : this.edgeT > 0 ? "#ffffff" : "rgba(255,255,255,0.55)", breaching ? 18 : 8);
    g.textAlign = "left";
  }

  private drawHearts(g: CanvasRenderingContext2D, h: number) {
    const y = h - 52;
    for (let i = 0; i < HEARTS; i++) {
      const x = 34 + i * 26;
      const on = i < this.hearts;
      g.save();
      g.translate(x, y);
      g.rotate(Math.PI / 4);
      if (on) {
        g.shadowColor = "#ff3f6a";
        g.shadowBlur = 14;
        g.fillStyle = i === 0 && this.hearts === 1 ? "#ffffff" : "#ff3f6a";
        g.fillRect(-8, -8, 16, 16);
      } else {
        g.strokeStyle = "rgba(255,255,255,0.22)";
        g.lineWidth = 2;
        g.strokeRect(-8, -8, 16, 16);
      }
      g.restore();
    }
    // Dash charges.
    for (let i = 0; i < DASH_CHARGES; i++) {
      const x = 40 + i * 30;
      const k = this.breachT > 0 ? 1 : 1 - clamp01(this.dashCd[i] / DASH_CD);
      g.save();
      g.translate(x, h - 96);
      g.lineWidth = 3.5;
      g.strokeStyle = "rgba(255,255,255,0.15)";
      g.beginPath();
      g.arc(0, 0, 11, 0, TAU);
      g.stroke();
      g.strokeStyle = k >= 1 ? "#a8ff5a" : "rgba(168,255,90,0.45)";
      g.beginPath();
      g.arc(0, 0, 11, -Math.PI / 2, -Math.PI / 2 + TAU * k);
      g.stroke();
      g.restore();
    }
    g.font = "700 11px ui-monospace, SFMono-Regular, Menlo, monospace";
    g.fillStyle = "rgba(255,255,255,0.4)";
    g.textAlign = "left";
    g.fillText("DASH", 106, h - 92);
  }

  private drawDamageNumbers(g: CanvasRenderingContext2D, w: number, h: number) {
    g.textAlign = "center";
    for (let i = 0; i < this.nCount; i++) {
      this._v3.set(this.nX[i], this.nY[i], this.nZ[i]).project(this.camera);
      if (this._v3.z > 1) continue;
      const sx = (this._v3.x * 0.5 + 0.5) * w;
      const sy = (1 - (this._v3.y * 0.5 + 0.5)) * h;
      const k = 1 - this.nAge[i] / this.nLife[i];
      const crit = this.nCrit[i] > 0;
      const size = (crit ? 30 : 20) + Math.min(26, this.nVal[i] / 22);
      g.globalAlpha = clamp01(k * 2);
      g.font = `800 ${(size * (1 + this.nPunch[i])).toFixed(1)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      glowText(g, String(Math.round(this.nVal[i])), sx, sy, crit ? "#ffffff" : "#ffd24a", crit ? 18 : 10);
    }
    g.globalAlpha = 1;
    g.textAlign = "left";
  }

  private drawCallouts(g: CanvasRenderingContext2D, w: number, h: number) {
    for (const co of this.callouts) {
      if (!co.live) continue;
      const k = co.t / co.life;
      const pop = easeOutCubic(clamp01(co.t / 0.16));
      const size = co.size * (0.7 + pop * 0.3) * (1 + (1 - pop) * 0.25);
      g.globalAlpha = clamp01((1 - k) * 2.2);
      g.textAlign = "center";
      g.font = `800 ${size.toFixed(1)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      this.spacedCentered(g, co.text, w * 0.5, h * 0.32 - k * 26, size * 0.09, co.color);
    }
    g.globalAlpha = 1;
    g.textAlign = "left";
  }

  private drawTitle(g: CanvasRenderingContext2D, w: number, h: number, accent: string) {
    const size = Math.min(112, w * 0.13);
    g.textAlign = "center";
    g.font = `800 ${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    this.spacedCentered(g, "HOLLOWKING", w * 0.5, h * 0.46, size * 0.22, "#ffffff", true);
    g.font = "700 15px ui-monospace, SFMono-Regular, Menlo, monospace";
    this.spacedCentered(g, "DASH INTO WHAT IS TRYING TO KILL YOU", w * 0.5, h * 0.46 + 42, 4, accent);
    const pulse = 0.55 + 0.45 * Math.sin(this.realTime * 3.4);
    g.globalAlpha = pulse;
    g.font = "700 24px ui-monospace, SFMono-Regular, Menlo, monospace";
    this.spacedCentered(g, this.c.isTouch ? "TAP TO WAKE IT" : "CLICK TO WAKE IT", w * 0.5, h - 76, 6, "#ffffff");
    g.globalAlpha = 1;
    g.font = "700 12px ui-monospace, SFMono-Regular, Menlo, monospace";
    g.fillStyle = "rgba(255,255,255,0.42)";
    g.textAlign = "center";
    g.fillText(
      this.c.isTouch ? "LEFT THUMB MOVES · RIGHT THUMB DASHES" : "WASD MOVE · MOUSE AIM · HOLD TO FIRE · SPACE DASH",
      w * 0.5,
      h - 46,
    );
    if (this.best > 0) {
      g.fillStyle = accent;
      g.fillText(`BEST ${fmt(this.best)}`, w * 0.5, h * 0.46 + 74);
    }
    g.textAlign = "left";
  }

  private drawEndCard(g: CanvasRenderingContext2D, w: number, h: number, accent: string) {
    const a = clamp01(this.deathT * 1.4);
    g.fillStyle = `rgba(4,4,10,${0.62 * a})`;
    g.fillRect(0, 0, w, h);
    const won = this.mode === "won";
    g.textAlign = "center";
    g.globalAlpha = a;
    const size = Math.min(84, w * 0.1);
    g.font = `800 ${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    this.spacedCentered(g, won ? "FELLED" : "HOLLOW", w * 0.5, h * 0.36, size * 0.16, won ? "#b8f6ff" : "#ff3355");

    g.font = "800 62px ui-monospace, SFMono-Regular, Menlo, monospace";
    glowText(g, fmt(Math.round(this.score)), w * 0.5, h * 0.36 + 84, "#ffffff", 18);
    g.font = "700 14px ui-monospace, SFMono-Regular, Menlo, monospace";
    g.fillStyle = "rgba(255,255,255,0.6)";
    g.fillText(
      `BEST ${fmt(this.best)}   ·   PEAK CHAIN ${this.chainPeak}   ·   PHASE ${ROMAN[this.phase]}   ·   PLATES ${this.platesBroken}/6`,
      w * 0.5,
      h * 0.36 + 118,
    );
    if (this.bestBeaten) {
      g.font = "800 22px ui-monospace, SFMono-Regular, Menlo, monospace";
      this.spacedCentered(g, "NEW PERSONAL BEST", w * 0.5, h * 0.36 + 158, 6, "#ffd24a");
    }
    if (this.deathT > 0.45) {
      const pulse = 0.5 + 0.5 * Math.sin(this.realTime * 4);
      g.globalAlpha = a * pulse;
      g.font = "700 22px ui-monospace, SFMono-Regular, Menlo, monospace";
      this.spacedCentered(g, this.c.isTouch ? "TAP TO GO AGAIN" : "CLICK OR SPACE TO GO AGAIN", w * 0.5, h * 0.74, 5, accent);
    }
    g.globalAlpha = 1;
    g.textAlign = "left";
  }

  private drawTouch(g: CanvasRenderingContext2D, w: number, h: number, accent: string) {
    if (this.stickActive) {
      g.strokeStyle = "rgba(255,255,255,0.22)";
      g.lineWidth = 2;
      g.beginPath();
      g.arc(this.stickCx, this.stickCy, 62, 0, TAU);
      g.stroke();
      const dxp = this.stickX - this.stickCx;
      const dyp = this.stickY - this.stickCy;
      const l = Math.min(62, Math.hypot(dxp, dyp)) / Math.max(1, Math.hypot(dxp, dyp));
      g.fillStyle = "rgba(255,255,255,0.5)";
      g.beginPath();
      g.arc(this.stickCx + dxp * l, this.stickCy + dyp * l, 22, 0, TAU);
      g.fill();
    }
    const bx = w - 96;
    const by = h - 96;
    g.lineWidth = 6;
    g.strokeStyle = "rgba(255,255,255,0.14)";
    g.beginPath();
    g.arc(bx, by, 42, 0, TAU);
    g.stroke();
    for (let i = 0; i < DASH_CHARGES; i++) {
      const k = this.breachT > 0 ? 1 : 1 - clamp01(this.dashCd[i] / DASH_CD);
      const a0 = -Math.PI / 2 + i * Math.PI + 0.08;
      g.strokeStyle = k >= 1 ? accent : "rgba(255,255,255,0.3)";
      g.beginPath();
      g.arc(bx, by, 42, a0, a0 + (Math.PI - 0.16) * k);
      g.stroke();
    }
    g.textAlign = "center";
    g.font = "700 14px ui-monospace, SFMono-Regular, Menlo, monospace";
    g.fillStyle = "rgba(255,255,255,0.7)";
    g.fillText("DASH", bx, by + 5);
    g.textAlign = "left";
  }

  /** Manual letterspacing — `ctx.letterSpacing` is not universally available. */
  private spaced(g: CanvasRenderingContext2D, text: string, x: number, y: number, sp: number) {
    let cx = x;
    for (const ch of text) {
      g.fillText(ch, cx, y);
      cx += g.measureText(ch).width + sp;
    }
  }

  private spacedCentered(
    g: CanvasRenderingContext2D,
    text: string,
    cx: number,
    y: number,
    sp: number,
    color: string,
    glitch = false,
  ) {
    let total = 0;
    for (const ch of text) total += g.measureText(ch).width + sp;
    total -= sp;
    let x = cx - total / 2;
    const prevAlign = g.textAlign;
    g.textAlign = "left";
    g.save();
    g.shadowColor = color;
    g.shadowBlur = 22;
    g.fillStyle = color;
    for (const ch of text) {
      const jx = glitch && ch === "K" ? (Math.random() - 0.5) * 3 : 0;
      g.fillText(ch, x + jx, y);
      g.fillText(ch, x + jx, y);
      x += g.measureText(ch).width + sp;
    }
    g.restore();
    g.textAlign = prevAlign;
  }

  // --- lifecycle ------------------------------------------------------------

  resize(width: number, height: number) {
    if (width < 2 || height < 2) return;
    this.w = width;
    this.h = height;
    if (!this.ready && !this.renderer) return;
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.post.setSize(width, height);
    this.hud.resize(width, height, this.c.dpr);
    this.particles.setViewport(height * this.c.dpr);
    this.dustMat.uniforms.uScale.value = height * this.c.dpr * 0.5;
  }

  destroy() {
    this.ready = false;
    this.c.audio.stopMusic();
    for (const d of this.disposables) d.dispose();
    this.tilePool.dispose();
    this.bulletPool.dispose();
    this.tracerPool.dispose();
    this.orbPool.dispose();
    this.pillarPool.dispose();
    this.discPool.dispose();
    this.particles.dispose();
    this.hud.dispose();
    this.post.dispose();
    this.renderer.dispose();
  }
}

function fmt(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const factory: GameFactory = (ctx) => new Hollowking(ctx);
export default factory;
