/**
 * SUNDER
 *
 * A 3D brick breaker where the wall is a bomb and the ball is the fuse.
 *
 * Design intent: the payoff is never "I hit a brick", it is "I hit ONE brick
 * and a fifth of the wall came apart in my face". Volatile bricks detonate
 * their neighbours on a staggered timer, so a cascade is a visible ripple
 * travelling outward rather than a pop. Every link adds +1 CHAIN, a semitone
 * of pitch, ball speed, and white to the frame. Twelve links inside a single
 * propagating event fires SUNDER: the world drops to 0.28x and you watch your
 * own explosion finish itself in slow motion.
 *
 * The chain has a draining window, so the game is a constant push to keep
 * something exploding, and the wall descends continuously so there is a hard
 * clock underneath the greed.
 *
 * The title screen is the game running: the wall is built with an extra-hot
 * volatile mix, a detonation is seeded at its centre, and the sim is warmed up
 * before the first draw. Frame one already has a shockwave mid-flight.
 */

import * as THREE from "three";
import type { PostStack } from "@/engine/gl/post";
import { makePost, hdr, glowTexture, ringTexture } from "@/engine/gl/post";
import { InstancePool, Particles } from "@/engine/gl/pool";
import { Shake, TimeWarp } from "@/engine/gl/shake";
import { Overlay, roundRectPath, glowText } from "@/engine/gl/overlay";
import { clamp, clamp01, damp, lerp, easeOutBack, TAU } from "@/engine/math";
import type { GameContext, GameFactory, GameInstance } from "@/games/types";

// --- playfield ---------------------------------------------------------------

const COLS = 13;
const ROWS = 22;
const MAX_BRICKS = COLS * ROWS;

const COL_W = 3.15;
const ROW_H = 1.62;
const BRICK_W = 2.86;
const BRICK_H = 1.34;
const BRICK_D = 1.15;

const PLAY_HALF_W = 21;
const WALL_TOP_Y = 22;
const CEIL_Y = 24;
const PADDLE_Y = -20.5;

/** The playfield is a plane raked toward the camera, so it reads as a tunnel. */
const TILT = 0.24;
const zOf = (y: number) => -y * TILT;
const colX = (col: number) => (col - (COLS - 1) / 2) * COL_W;

// --- tuning ------------------------------------------------------------------

const MAX_BALLS = 9;
const TRAIL = 18;
const MAX_DEBRIS = 560;
const MAX_SHARDS = 24;
const MAX_BOLTS = 40;
const MAX_RINGS = 56;
const MAX_HUD_BITS = 120;

const BALL_R = 0.62;
const CHAIN_MULT_CAP = 25;
/**
 * Blast radii, in world units. These set the cascade branching factor:
 * a 3.2 radius reaches 4 grid cells, so at the wave-1 volatile share of 18%
 * a chain averages ~0.7 children per link (subcritical, cascades of 3-6),
 * and by wave 5 (28% volatile + 10% supercharged) it crosses 1.0 and the wall
 * genuinely unzips. Supercharged reaches 16 cells and fires SUNDER on its own.
 */
const DET_R = 3.2;
const DET_R_SUPER = 5.2;
const SUNDER_LINKS = 12;
const LINK_CAP = 90;
const MIN_BRICKS = 42;
/** Cumulative kills that advance a wave. Playing well escalates you faster. */
const WAVE_KILLS = [40, 100, 180, 280, 400, 540];

const T_NORMAL = 0;
const T_VOLATILE = 1;
const T_ARMOUR = 2;
const T_ANCHOR = 3;
const T_PHASE = 4;
const T_SUPER = 5;

const BASE_SCORE = [100, 400, 250, 600, 350, 750];
const BRICK_HEX = [0x2fd8ff, 0xff4d2e, 0x8fa6c4, 0xa855ff, 0xdff6ff, 0xfff3c4];
const BRICK_GAIN = [2.2, 3.0, 1.5, 2.6, 2.0, 5.0];

const PU_SPLIT = 0;
const PU_LANCE = 1;
const PU_HEAVY = 2;
const PU_WELL = 3;
const PU_WIDE = 4;
const PU_SHIELD = 5;
const PU_HEX = [0xffffff, 0xff3355, 0xff9a2b, 0xa855ff, 0x2fd8ff, 0x39ffd0];
const PU_NAME = ["SPLIT", "LANCE", "HEAVY", "WELL", "WIDE", "SHIELD"];

const CALLOUTS: Array<[number, string]> = [
  [1, "ORANGE BRICKS DETONATE — CHAIN THEM"],
  [2, "ARMOURED BRICKS TAKE TWO HITS"],
  [3, "WHITE CORES BLAST WIDE — ANCHORS UNLOCK FROM ABOVE"],
  [4, "PHASE BRICKS FLICKER — STRIKE AS THEY RETURN"],
  [5, "THE WALL IS COMING FASTER"],
];

type Phase = "title" | "playing" | "dead";
type Pool = Float32Array | Uint8Array;

const f32 = (n: number) => new Float32Array(n);
const u8 = (n: number) => new Uint8Array(n);

/** Swap-remove across a group of parallel typed arrays. */
const swapOut = (arrs: Pool[], i: number, last: number) => {
  if (i === last) return;
  for (let k = 0; k < arrs.length; k++) arrs[k][i] = arrs[k][last];
};

const comma = (n: number) => {
  const s = Math.floor(n).toString();
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ",";
    out += s[i];
  }
  return out;
};

class Sunder implements GameInstance {
  private readonly c: GameContext;

  // --- three.js
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private post!: PostStack;
  private hud!: Overlay;
  private shake = new Shake();
  private warp = new TimeWarp();

  private brickPool!: InstancePool;
  private debrisPool!: InstancePool;
  private shardPool!: InstancePool;
  private boltPool!: InstancePool;
  private ringPool!: InstancePool;
  private glowPool!: InstancePool;
  private ballPool!: InstancePool;
  private tetherPool!: InstancePool;
  private sparks!: Particles;

  private paddleMesh!: THREE.Mesh;
  private paddleGlow!: THREE.Mesh;
  private rails: THREE.Mesh[] = [];
  private railFlash = [0, 0, 0];
  private backdrop!: THREE.Mesh;
  private backdropMat!: THREE.ShaderMaterial;
  private stars!: THREE.Points;
  private starPos!: Float32Array;
  private textures: THREE.Texture[] = [];
  private ready = false;

  // scratch — nothing in the frame loop may allocate
  private tc = new THREE.Color();
  private tc2 = new THREE.Color();
  private sc = { x: 1, y: 1, z: 1 };
  private rot = { x: 0, y: 0, z: 0 };

  // --- bricks (the pool IS the grid: index = row * COLS + col, so a row push
  //     is one copyWithin per array and every queued cascade link follows)
  private bAlive = u8(MAX_BRICKS); private bType = u8(MAX_BRICKS); private bHp = u8(MAX_BRICKS);
  private bQueued = u8(MAX_BRICKS); private bFireAt = f32(MAX_BRICKS);
  private bPhase = f32(MAX_BRICKS); private bHit = f32(MAX_BRICKS);
  private aliveBricks = 0;
  private pending = 0;

  // --- balls
  private ballX = f32(MAX_BALLS); private ballY = f32(MAX_BALLS);
  private ballVX = f32(MAX_BALLS); private ballVY = f32(MAX_BALLS);
  private ballStuck = u8(MAX_BALLS); private trailHead = u8(MAX_BALLS);
  private ballAll = [this.ballX, this.ballY, this.ballVX, this.ballVY, this.ballStuck, this.trailHead];
  private trail = f32(MAX_BALLS * TRAIL * 2);
  private ballCount = 0;
  private stickTimer = 0;

  // --- debris / shards / bolts / rings / HUD shatter bits.
  //     Each group keeps a hoisted array-of-arrays so swap-remove is one call.
  private dX = f32(MAX_DEBRIS); private dY = f32(MAX_DEBRIS); private dZ = f32(MAX_DEBRIS);
  private dVX = f32(MAX_DEBRIS); private dVY = f32(MAX_DEBRIS); private dVZ = f32(MAX_DEBRIS);
  private dRX = f32(MAX_DEBRIS); private dRY = f32(MAX_DEBRIS); private dSpin = f32(MAX_DEBRIS);
  private dLife = f32(MAX_DEBRIS); private dSize = f32(MAX_DEBRIS); private dType = u8(MAX_DEBRIS);
  private dAll = [this.dX, this.dY, this.dZ, this.dVX, this.dVY, this.dVZ,
    this.dRX, this.dRY, this.dSpin, this.dLife, this.dSize, this.dType];
  private dCount = 0;

  private sX = f32(MAX_SHARDS); private sY = f32(MAX_SHARDS); private sVX = f32(MAX_SHARDS);
  private sVY = f32(MAX_SHARDS); private sSpin = f32(MAX_SHARDS); private sType = u8(MAX_SHARDS);
  private sAll = [this.sX, this.sY, this.sVX, this.sVY, this.sSpin, this.sType];
  private sCount = 0;

  private lX = f32(MAX_BOLTS); private lY = f32(MAX_BOLTS);
  private lAll = [this.lX, this.lY];
  private lCount = 0;

  private rX = f32(MAX_RINGS); private rY = f32(MAX_RINGS); private rR = f32(MAX_RINGS);
  private rLife = f32(MAX_RINGS); private rMax = f32(MAX_RINGS); private rType = u8(MAX_RINGS);
  private rAll = [this.rX, this.rY, this.rR, this.rLife, this.rMax, this.rType];
  private rCount = 0;

  private hbX = f32(MAX_HUD_BITS); private hbY = f32(MAX_HUD_BITS); private hbVX = f32(MAX_HUD_BITS);
  private hbVY = f32(MAX_HUD_BITS); private hbLife = f32(MAX_HUD_BITS); private hbSize = f32(MAX_HUD_BITS);
  private hbAll = [this.hbX, this.hbY, this.hbVX, this.hbVY, this.hbLife, this.hbSize];
  private hbCount = 0;

  // --- run state
  private w = 1;
  private h = 1;
  private phase: Phase = "title";
  /** Simulation clock. Slows with TimeWarp, which is what makes the cascade
   *  ripple audibly stretch out during SUNDER instead of finishing early. */
  private time = 0;
  /** Wall clock, for HUD strobes that must keep blinking through a hit-stop. */
  private realT = 0;
  private runTime = 0;
  private score = 0;
  private best = 0;
  private bestChain = 0;
  private lives = 3;
  private destroyed = 0;
  private wave = 1;
  private prevWave = 0;
  private wallFrac = 0;
  private paddleX = 0;
  private paddleVX = 0;
  private paddleSquash = 0;
  private keyT = 0;
  private danger = 0;
  private deadT = 0;
  private lowestRow = ROWS;
  private emergencyCd = 0;
  private bestDirty = false;
  private saveCd = 0;

  private chain = 0;
  private chainWindow = 0;
  private chainMax = 0;
  private eventLinks = 0;
  private eventSundered = false;
  private linkPitch = 0;

  // power-ups
  private heavyT = 0;
  private lanceT = 0;
  private wellT = 0;
  private wideT = 0;
  private shields = 0;
  private boltCd = 0;
  private wellX = 0;
  private wellY = 0;

  // presentation
  private multPunch = 1;
  private scorePunch = 1;
  private sunderT = 0;
  private sunderLinks = 0;
  private sunderDur = 1;
  private flashR = 0;
  private flashG = 0;
  private flashB = 0;
  private bloomBoost = 0;
  private camDolly = 0;
  private camZ = 60;
  private breakT = 0;
  private pbT = 0;
  private pbChainT = 0;
  private calloutT = 0;
  private calloutText = "";
  private bannerT = 0;
  private bannerText = "";
  private musicAcc = 0;
  private musicStep = 0;
  private reportAcc = 0;

  constructor(ctx: GameContext) {
    this.c = ctx;
    this.best = ctx.store.get<number>("best", 0);
    this.bestChain = ctx.store.get<number>("bestChain", 0);
    this.initThree();
    this.buildAttract();
    this.resize(ctx.width, ctx.height);
    ctx.report({ status: "idle", score: 0, best: this.best, label: "SUNDER" });
  }

  // --- setup -----------------------------------------------------------------

  private initThree() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.c.canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(this.c.dpr);
    this.renderer.setSize(this.c.width, this.c.height, false);
    this.renderer.setClearColor(0x0a0620, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x140a2e, 46, 132);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.5, 400);

    this.buildBackdrop();
    this.buildStars();

    const glow = glowTexture(64, 2.2);
    const ring = ringTexture(256, 0.07);
    this.textures.push(glow, ring);

    this.brickPool = new InstancePool(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_BRICKS );
    // Debris is deliberately NOT additive and never HDR: solid matter tumbling
    // in front of light is what sells the depth of the blast.
    this.debrisPool = new InstancePool(new THREE.TetrahedronGeometry(0.62, 0), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_DEBRIS );
    this.shardPool = new InstancePool(new THREE.OctahedronGeometry(0.78, 0), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_SHARDS );
    this.boltPool = new InstancePool(
      new THREE.BoxGeometry(0.22, 2.2, 0.22),
      new THREE.MeshBasicMaterial({ color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }),
      MAX_BOLTS,
    );
    this.ringPool = new InstancePool(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: ring, color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false }),
      MAX_RINGS + MAX_BALLS,
    );
    this.glowPool = new InstancePool(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: glow, color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false }),
      MAX_BALLS * TRAIL + 64,
    );
    this.ballPool = new InstancePool(new THREE.SphereGeometry(BALL_R, 14, 10), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }), MAX_BALLS );
    this.tetherPool = new InstancePool(
      new THREE.BoxGeometry(0.18, 1, 0.18),
      new THREE.MeshBasicMaterial({ color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }),
      32,
    );

    for (const p of [
      this.brickPool,
      this.debrisPool,
      this.tetherPool,
      this.shardPool,
      this.boltPool,
      this.ringPool,
      this.glowPool,
      this.ballPool,
    ]) {
      this.scene.add(p.mesh);
    }
    // Balls last in the additive stack so they stay readable inside a cascade.
    this.ballPool.mesh.renderOrder = 10;

    this.sparks = new Particles(3000, this.keepTex(glowTexture(64, 2.4)));
    this.scene.add(this.sparks.object);

    this.buildPaddle();
    this.buildRails();

    this.post = makePost(this.renderer, this.scene, this.camera, { strength: 1.05, radius: 0.62, threshold: 0.2 });
    this.hud = new Overlay();
    this.ready = true;
  }

  private buildBackdrop() {
    this.backdropMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uChain: { value: 0 }, uDanger: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform float uTime;
        uniform float uChain;
        uniform float uDanger;
        void main() {
          float y = vUv.y;
          vec3 col = mix(vec3(0.039,0.024,0.125), vec3(0.102,0.043,0.220), smoothstep(0.0,0.58,y));
          col = mix(col, vec3(0.165,0.063,0.333), smoothstep(0.46,1.0,y));

          // Three line families 60 degrees apart make a slowly turning hex lattice.
          float a = uTime * 0.055;
          vec2 p = (vUv - 0.5) * 22.0;
          p = mat2(cos(a), -sin(a), sin(a), cos(a)) * p;
          float tri = 0.0;
          for (int i = 0; i < 3; i++) {
            float ang = float(i) * 1.04719755;
            float v = dot(p, vec2(cos(ang), sin(ang)));
            tri = max(tri, 1.0 - smoothstep(0.0, 0.05, abs(fract(v) - 0.5)));
          }
          col += vec3(0.35,0.55,1.0) * tri * 0.075;

          // The sky literally gets hotter as the combo climbs.
          float band = exp(-pow((y - 0.60) * 5.2, 2.0));
          vec3 hot = mix(vec3(0.25,0.45,1.0), vec3(1.0,0.52,0.16), clamp(uChain * 0.022, 0.0, 1.0));
          col += hot * band * min(1.1, 0.13 + uChain * 0.013 + uDanger * 0.16);
          col += vec3(0.5,0.05,0.08) * uDanger * smoothstep(0.42, 0.0, y) * 0.45;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
      depthWrite: false,
      depthTest: false,
    });
    this.backdrop = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.backdropMat);
    this.backdrop.frustumCulled = false;
    this.backdrop.renderOrder = -10;
    this.backdrop.position.z = -80;
    this.scene.add(this.backdrop);
  }

  private keepTex<T extends THREE.Texture>(t: T): T { this.textures.push(t); return t; }

  private buildStars() {
    const n = 400;
    this.starPos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      this.starPos[i * 3] = this.c.rng.range(-46, 46);
      this.starPos[i * 3 + 1] = this.c.rng.range(-40, 40);
      this.starPos[i * 3 + 2] = this.c.rng.range(-72, 22);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.starPos, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    const mat = new THREE.PointsMaterial({
      size: 0.55,
      map: this.keepTex(glowTexture(32, 2.0)),
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      sizeAttenuation: true,
      fog: false,
    });
    mat.color.setRGB(1.5, 1.9, 3.2);
    this.stars = new THREE.Points(geo, mat);
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);
  }

  private buildPaddle() {
    this.paddleMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 0.9, 1.5), new THREE.MeshBasicMaterial({ color: hdr(0x39ffd0, 3.2), fog: false }) );
    this.paddleMesh.rotation.x = -Math.atan(TILT);
    this.scene.add(this.paddleMesh);

    this.paddleGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: this.keepTex(glowTexture(128, 1.8)), color: hdr(0x39ffd0, 1.6), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false }),
    );
    this.scene.add(this.paddleGlow);
  }

  private buildRails() {
    const tiltA = -Math.atan(TILT);
    const span = CEIL_Y - PADDLE_Y + 6;
    for (let s = 0; s < 2; s++) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.55, span, 1.2), new THREE.MeshBasicMaterial({ color: hdr(0x2b6cff, 1.6), fog: false }) );
      const y = (CEIL_Y + PADDLE_Y) / 2;
      rail.position.set(s === 0 ? -PLAY_HALF_W - 0.3 : PLAY_HALF_W + 0.3, y, zOf(y));
      rail.rotation.x = tiltA;
      this.scene.add(rail);
      this.rails.push(rail);
    }
    const ceil = new THREE.Mesh(new THREE.BoxGeometry(PLAY_HALF_W * 2 + 1.2, 0.55, 1.2), new THREE.MeshBasicMaterial({ color: hdr(0x2b6cff, 1.6), fog: false }) );
    ceil.position.set(0, CEIL_Y + 0.3, zOf(CEIL_Y));
    this.scene.add(ceil);
    this.rails.push(ceil);
  }

  // --- wall construction -----------------------------------------------------

  private rowY(row: number) { return WALL_TOP_Y - (row + this.wallFrac) * ROW_H; }

  private rollType(volShare: number, superShare: number): number {
    const r = this.c.rng;
    if (r.next() < superShare) return T_SUPER;
    if (r.next() < volShare) return T_VOLATILE;
    if (this.wave >= 2 && r.next() < 0.1) return T_ARMOUR;
    if (this.wave >= 3 && r.next() < 0.06) return T_ANCHOR;
    if (this.wave >= 4 && r.next() < 0.08) return T_PHASE;
    return T_NORMAL;
  }

  private fillRow(row: number, volShare: number, superShare: number) {
    for (let col = 0; col < COLS; col++) {
      const i = row * COLS + col;
      if (this.c.rng.next() < 0.06) {
        this.bAlive[i] = 0;
        continue;
      }
      const t = this.rollType(volShare, superShare);
      this.bAlive[i] = 1;
      this.bType[i] = t;
      this.bHp[i] = t === T_ARMOUR ? 2 : 1;
      this.bPhase[i] = this.c.rng.range(0, TAU);
      this.bHit[i] = 0;
      this.bQueued[i] = 0;
      this.aliveBricks++;
    }
  }

  /**
   * The title screen is the game already mid-cascade. Build a hot wall, seed a
   * detonation at its centre, then warm the sim so frame one is never static.
   */
  private buildAttract() {
    this.bAlive.fill(0);
    this.aliveBricks = 0;
    this.wave = 3;
    for (let row = 0; row < 9; row++) this.fillRow(row, 0.34, 0.08);
    this.wave = 1;
    this.spawnBall(0, PADDLE_Y + 2, true);
    this.launchAll();
    this.spawnBall(-8, 4, false);
    this.ballVX[this.ballCount - 1] = 18;
    this.ballVY[this.ballCount - 1] = -22;
    this.spawnBall(9, 1, false);
    this.ballVX[this.ballCount - 1] = -16;
    this.ballVY[this.ballCount - 1] = -24;

    const seed = 4 * COLS + ((COLS / 2) | 0);
    if (!this.bAlive[seed]) this.aliveBricks++;
    this.bAlive[seed] = 1;
    this.bType[seed] = T_SUPER;
    this.killBrick(seed, "cascade");

    for (let i = 0; i < 15; i++) this.stepSim(1 / 60);
    // Frame one is mid-blast, but not so blown out that the wall is unreadable.
    this.flashR *= 0.5;
    this.flashG *= 0.5;
    this.flashB *= 0.5;
    // The opening frame is 5 units closer than rest, easing back over ~1.5s.
    this.camDolly = 5;
  }

  // --- lifecycle -------------------------------------------------------------

  restart() {
    this.phase = "playing";
    this.runTime = 0;
    this.score = 0;
    this.lives = 3;
    this.destroyed = 0;
    this.wave = 1;
    this.prevWave = 0;
    this.chain = 0;
    this.chainWindow = 0;
    this.chainMax = 0;
    this.eventLinks = 0;
    this.eventSundered = false;
    this.heavyT = this.lanceT = this.wellT = this.wideT = 0;
    this.shields = 0;
    this.deadT = 0;
    this.pbT = 0;
    this.pbChainT = 0;
    this.hbCount = 0;
    this.sCount = 0;
    this.lCount = 0;
    this.bannerT = 0;
    this.lowestRow = ROWS;
    this.warp.reset();

    this.bAlive.fill(0);
    this.bQueued.fill(0);
    this.aliveBricks = 0;
    this.pending = 0;
    this.wallFrac = 0;
    for (let row = 0; row < 9; row++) this.fillRow(row, 0.18, 0);

    this.ballCount = 0;
    this.spawnBall(this.paddleX, PADDLE_Y + 2, true);
    this.spawnBall(this.paddleX, PADDLE_Y + 2, true);
    this.stickTimer = 0.9;
    this.callout(1);
    this.c.report({ status: "playing", score: 0, best: this.best, label: "WAVE 1" });
  }

  /** Hands the attract wall straight over to the player — no black frame. */
  private beginRun() {
    this.c.audio.unlock();
    this.phase = "playing";
    this.runTime = 0;
    this.score = 0;
    this.lives = 3;
    this.destroyed = 0;
    this.wave = 1;
    this.prevWave = 0;
    this.chain = 0;
    this.chainMax = 0;
    this.chainWindow = 0;
    this.heavyT = this.lanceT = this.wellT = this.wideT = 0;
    this.shields = 0;
    this.pbT = 0;
    this.pbChainT = 0;
    this.hbCount = 0;
    this.deadT = 0;
    this.lowestRow = ROWS;

    // The title dissolving upward.
    for (let i = 0; i < 420; i++) {
      const x = this.c.rng.range(-22, 22);
      const y = this.c.rng.range(-3, 7);
      this.sparks.spawn({
        x,
        y,
        z: zOf(y) + 2,
        vx: this.c.rng.spread(6),
        vy: this.c.rng.range(10, 34),
        vz: this.c.rng.range(2, 12),
        life: this.c.rng.range(0.5, 1.1),
        size: this.c.rng.range(0.5, 1.5),
        endSize: 0,
        color: hdr(0xbfe9ff, 3.2, this.tc),
        gravity: -12,
        drag: 0.5,
      });
    }
    this.shake.add(0.3);
    this.flashPump(0.28, 0.34, 0.42);
    this.c.audio.play({ wave: "sawtooth", freq: 70, freqTo: 240, glide: 0.3, vol: 0.22, attack: 0.005, hold: 0.08, release: 0.3, filter: 2400 });
    if (this.ballCount === 0) this.spawnBall(this.paddleX, PADDLE_Y + 2, true);
    this.callout(1);
    this.c.report({ status: "playing", score: 0, best: this.best, label: "WAVE 1" });
  }

  destroy() {
    this.post?.dispose();
    this.hud?.dispose();
    this.sparks?.dispose();
    for (const p of [
      this.brickPool,
      this.debrisPool,
      this.shardPool,
      this.boltPool,
      this.ringPool,
      this.glowPool,
      this.ballPool,
      this.tetherPool,
    ]) {
      p?.dispose();
    }
    this.backdropMat?.dispose();
    this.backdrop?.geometry.dispose();
    (this.stars?.material as THREE.Material)?.dispose();
    this.stars?.geometry.dispose();
    this.paddleMesh?.geometry.dispose();
    (this.paddleMesh?.material as THREE.Material)?.dispose();
    this.paddleGlow?.geometry.dispose();
    (this.paddleGlow?.material as THREE.Material)?.dispose();
    for (const r of this.rails) {
      r.geometry.dispose();
      (r.material as THREE.Material).dispose();
    }
    for (const t of this.textures) t.dispose();
    this.renderer?.dispose();
  }

  resize(w: number, h: number) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    if (!this.ready) return;
    this.renderer.setSize(this.w, this.h, false);
    this.post.setSize(this.w, this.h);
    this.hud.resize(this.w, this.h, this.c.dpr);
    this.sparks.setViewport(this.h * this.c.dpr);

    const aspect = this.w / this.h;
    this.camera.aspect = aspect;
    const tanHalf = Math.tan((55 * Math.PI) / 360);
    const distH = 24.5 / tanHalf;
    const distW = 21.8 / (tanHalf * aspect);
    this.camZ = clamp(Math.max(distH, distW) + 6.5, 42, 130);
    this.camera.updateProjectionMatrix();

    // Size the backdrop to exactly cover the frustum at its depth.
    const d = this.camZ + 80;
    const bh = 2 * d * tanHalf * 1.14;
    this.backdrop.scale.set(bh * aspect, bh, 1);
  }

  // --- update ----------------------------------------------------------------

  update(dtReal: number) {
    const inp = this.c.input;
    this.realT += dtReal;

    // Edge-triggered input must be read here, outside the time-warp gate.
    const confirm = inp.confirmPressed || inp.pointer.justDown;
    if (this.phase === "title") {
      if (confirm) this.beginRun();
    } else if (this.phase === "dead") {
      this.deadT += dtReal;
      if (this.deadT > 0.35 && (confirm || inp.wasPressed("KeyR"))) this.restart();
    } else {
      if (inp.wasPressed("KeyR")) this.restart();
      if (confirm) this.launchAll();
    }

    if (inp.isDown("ArrowLeft", "ArrowRight", "KeyA", "KeyD")) this.keyT = 0.6;
    else this.keyT = Math.max(0, this.keyT - dtReal);

    this.shake.update(dtReal);
    this.tickPresentation(dtReal);

    const dt = this.warp.step(dtReal);
    if (dt > 0) this.stepSim(dt);

    this.reportAcc += dtReal;
    if (this.reportAcc > 0.12) {
      this.reportAcc = 0;
      this.c.report({
        score: this.score,
        best: this.best,
        label: this.phase === "title" ? "SUNDER" : `WAVE ${this.wave}`,
        status: this.phase === "dead" ? "over" : this.phase === "title" ? "idle" : "playing",
      });
    }
  }

  private tickPresentation(dt: number) {
    this.multPunch = damp(this.multPunch, 1, 0.25, dt);
    this.scorePunch = damp(this.scorePunch, 1, 0.28, dt);
    this.flashR = damp(this.flashR, 0, 0.3, dt);
    this.flashG = damp(this.flashG, 0, 0.3, dt);
    this.flashB = damp(this.flashB, 0, 0.3, dt);
    this.bloomBoost = damp(this.bloomBoost, 0, 0.11, dt);
    this.camDolly = damp(this.camDolly, 0, 0.14, dt);
    this.paddleSquash = damp(this.paddleSquash, 0, 0.22, dt);
    if (this.sunderT > 0) this.sunderT -= dt;
    if (this.breakT > 0) this.breakT -= dt;
    if (this.pbT > 0) this.pbT -= dt;
    if (this.pbChainT > 0) this.pbChainT -= dt;
    if (this.calloutT > 0) this.calloutT -= dt;
    if (this.bannerT > 0) this.bannerT -= dt;
    for (let i = 0; i < 3; i++) this.railFlash[i] = Math.max(0, this.railFlash[i] - dt * 8);

    // HUD shatter bits live in screen space, so they use real time.
    for (let i = 0; i < this.hbCount; i++) {
      this.hbVY[i] += 900 * dt;
      this.hbX[i] += this.hbVX[i] * dt;
      this.hbY[i] += this.hbVY[i] * dt;
      this.hbLife[i] -= dt;
      if (this.hbLife[i] <= 0) {
        swapOut(this.hbAll, i--, --this.hbCount);
      }
    }
    this.music(dt);
  }

  // --- simulation ------------------------------------------------------------

  private get chainMult() { return Math.min(CHAIN_MULT_CAP, 1 + this.chain * 0.25); }

  private get pushInterval() { return Math.max(2.6, 7.0 - Math.min(this.wave - 1, 6) * 0.67); }

  private get ballSpeed() { const base = 26 * Math.min(1.5, 1 + (this.wave - 1) * 0.055); return Math.min(60, base * (1 + Math.min(this.chain, 40) * 0.009)); }

  private get paddleHalf() {
    let wdt = Math.max(4.4, 5.6 - (this.wave - 1) * 0.25);
    if (this.c.isTouch) wdt *= 1.12;
    if (this.wideT > 0) wdt *= 1.4;
    if (this.ballCount <= 1 && this.phase === "playing") wdt *= 1.15;
    return wdt * 0.5;
  }

  private stepSim(dt: number) {
    this.time += dt;
    if (this.emergencyCd > 0) this.emergencyCd -= dt;
    if (this.bestDirty) {
      this.saveCd -= dt;
      if (this.saveCd <= 0) {
        this.saveCd = 1;
        this.bestDirty = false;
        this.c.store.set("best", this.best);
      }
    }
    if (this.phase === "playing") {
      this.runTime += dt;
      const byTime = Math.floor(this.runTime / 45) + 1;
      let byKills = 1;
      for (let i = 0; i < WAVE_KILLS.length; i++) if (this.destroyed >= WAVE_KILLS[i]) byKills = i + 2;
      const nextWave = Math.max(byTime, byKills);
      if (nextWave !== this.wave) {
        this.wave = nextWave;
        this.callout(this.wave);
      }
    }

    this.movePaddle(dt);
    this.stepWall(dt);
    this.stepPending();
    this.stepBalls(dt);
    this.stepBolts(dt);
    this.stepShards(dt);
    this.stepDebris(dt);
    this.stepRings(dt);
    this.stepChain(dt);
    this.sparks.update(dt);
    this.stepStars(dt);

    for (const k of ["heavyT", "lanceT", "wellT", "wideT"] as const) {
      if (this[k] > 0) this[k] = Math.max(0, this[k] - dt);
    }
    if (this.stickTimer > 0) {
      this.stickTimer -= dt;
      if (this.stickTimer <= 0) this.launchAll();
    }

    // Danger: how close the lowest live brick has come to the paddle.
    let lowRow = ROWS;
    for (let i = MAX_BRICKS - 1; i >= 0; i--) {
      if (this.bAlive[i]) {
        lowRow = (i / COLS) | 0;
        break;
      }
    }
    const lowest = lowRow >= ROWS ? WALL_TOP_Y : this.rowY(lowRow);
    this.danger = clamp01((-2 - lowest) / 12);

    // WALL BREACH: a whole bottom row wiped while the wall is on top of you.
    // Deliberately weaker than SUNDER so it never competes with it.
    if (
      this.phase === "playing" &&
      lowRow < this.lowestRow &&
      this.lowestRow < ROWS &&
      this.danger > 0.45
    ) {
      this.warp.slowMo(0.7, 0.3);
      this.addChain(4);
      this.banner("WALL BREACH +4");
      this.shake.add(0.24);
      this.flashPump(0.2, 0.3, 0.36);
      this.spawnRing(0, lowest, 22, T_NORMAL);
      this.c.audio.play({ wave: "sawtooth", freq: 120, freqTo: 520, glide: 0.3, vol: 0.2, attack: 0.004, hold: 0.06, release: 0.26, filter: 3000 });
    }
    this.lowestRow = lowRow;
  }

  private movePaddle(dt: number) {
    const half = this.paddleHalf;
    const limit = PLAY_HALF_W - half;
    const prev = this.paddleX;

    if (this.phase === "title") {
      // Autopilot: track the lowest descending ball so the attract loop plays.
      let tx = 0;
      let low = 1e9;
      for (let i = 0; i < this.ballCount; i++) {
        if (this.ballVY[i] < 0 && this.ballY[i] < low) {
          low = this.ballY[i];
          tx = this.ballX[i];
        }
      }
      this.paddleX = damp(this.paddleX, clamp(tx, -limit, limit), 0.28, dt);
    } else if (this.keyT > 0) {
      const axis = (this.c.input.isDown("ArrowRight", "KeyD") ? 1 : 0) -
        (this.c.input.isDown("ArrowLeft", "KeyA") ? 1 : 0);
      this.paddleVX += axis * 190 * dt;
      this.paddleVX *= Math.pow(0.86, dt * 60);
      this.paddleVX = clamp(this.paddleVX, -44, 44);
      this.paddleX = clamp(this.paddleX + this.paddleVX * dt, -limit, limit);
    } else if (this.c.input.pointer.everMoved) {
      // 1.25x gain around centre so the edges are reachable without leaving
      // the canvas, then one frame of weight.
      const nx = clamp(((this.c.input.pointer.x / this.w) - 0.5) * 2.5, -1, 1);
      this.paddleX = damp(this.paddleX, nx * limit, 0.6, dt);
    }
    this.paddleX = clamp(this.paddleX, -limit, limit);
    this.paddleVX = dt > 0 ? (this.paddleX - prev) / dt : 0;

    for (let i = 0; i < this.ballCount; i++) {
      if (!this.ballStuck[i]) continue;
      this.ballX[i] = this.paddleX;
      this.ballY[i] = PADDLE_Y + 1.6;
    }
  }

  private stepWall(dt: number) {
    const descent = ROW_H / this.pushInterval;
    this.wallFrac += (descent * dt) / ROW_H;
    if (this.wallFrac >= 1) {
      this.wallFrac -= 1;
      this.pushRow();
    } else if (
      this.aliveBricks < MIN_BRICKS &&
      this.phase !== "dead" &&
      this.emergencyCd <= 0
    ) {
      // Anti-emptiness clamp: never let the board go sparse for long.
      this.emergencyCd = 0.4;
      this.pushRow();
    }
  }

  private pushRow() {
    let crushed = 0;
    for (let c = 0; c < COLS; c++) {
      const i = (ROWS - 1) * COLS + c;
      if (this.bAlive[i]) {
        crushed++;
        this.bAlive[i] = 0;
        this.aliveBricks--;
        this.spawnDebris(colX(c), this.rowY(ROWS - 1), T_VOLATILE, 4);
      }
      // A queued link dying with the row would otherwise leak the pending
      // count and leave the cascade event permanently "open".
      this.bQueued[i] = 0;
    }

    const span = (ROWS - 1) * COLS;
    this.bAlive.copyWithin(COLS, 0, span);
    this.bType.copyWithin(COLS, 0, span);
    this.bHp.copyWithin(COLS, 0, span);
    this.bQueued.copyWithin(COLS, 0, span);
    this.bFireAt.copyWithin(COLS, 0, span);
    this.bPhase.copyWithin(COLS, 0, span);
    this.bHit.copyWithin(COLS, 0, span);
    for (let c = 0; c < COLS; c++) this.bAlive[c] = 0;

    const volShare = Math.min(0.28, 0.18 + (this.wave - 1) * 0.025);
    const superShare = this.wave >= 3 ? Math.min(0.1, (this.wave - 2) * 0.035) : 0;
    this.fillRow(0, volShare, superShare);

    this.railFlash[2] = 1;
    this.shake.add(0.07);
    this.c.audio.play({ wave: "sine", freq: 96, freqTo: 38, glide: 0.16, vol: 0.2, attack: 0.002, hold: 0.04, release: 0.22 });
    if (crushed > 0 && this.phase === "playing") this.loseLife("CRUSHED");
  }

  /** Queued cascade links live on the brick itself, so a row shift moves them. */
  private stepPending() {
    if (this.pending > 0) {
      for (let i = 0; i < MAX_BRICKS; i++) {
        if (!this.bQueued[i]) continue;
        if (this.bFireAt[i] > this.time) continue;
        this.bQueued[i] = 0;
        if (this.bAlive[i]) this.killBrick(i, "cascade");
      }
      // Recount rather than decrement: kills above can queue new links behind
      // the cursor, and a crushed row can drop queued links silently.
      let n = 0;
      for (let i = 0; i < MAX_BRICKS; i++) if (this.bQueued[i]) n++;
      this.pending = n;
    }
    if (this.pending <= 0 && this.eventLinks > 0) {
      this.pending = 0;
      this.eventLinks = 0;
      this.eventSundered = false;
      this.linkPitch = 0;
    }
  }

  private stepStars(dt: number) {
    const drift = 2 + Math.min(this.wave - 1, 6) * 0.5;
    const p = this.starPos;
    for (let i = 0; i < p.length; i += 3) {
      p[i + 2] += drift * dt;
      if (p[i + 2] > 24) {
        p[i + 2] = -72;
        p[i] = this.c.rng.range(-46, 46);
        p[i + 1] = this.c.rng.range(-40, 40);
      }
    }
    this.stars.geometry.attributes.position.needsUpdate = true;
  }

  // --- balls -----------------------------------------------------------------

  private spawnBall(x: number, y: number, stuck: boolean) {
    if (this.ballCount >= MAX_BALLS) return;
    const i = this.ballCount++;
    this.ballX[i] = x;
    this.ballY[i] = y;
    this.ballVX[i] = 0;
    this.ballVY[i] = 0;
    this.ballStuck[i] = stuck ? 1 : 0;
    this.trailHead[i] = 0;
    for (let k = 0; k < TRAIL; k++) {
      this.trail[(i * TRAIL + k) * 2] = x;
      this.trail[(i * TRAIL + k) * 2 + 1] = y;
    }
  }

  private launchAll() {
    let any = false;
    for (let i = 0; i < this.ballCount; i++) {
      if (!this.ballStuck[i]) continue;
      this.ballStuck[i] = 0;
      const a = this.c.rng.range(-0.42, 0.42);
      const s = this.ballSpeed;
      this.ballVX[i] = Math.sin(a) * s;
      this.ballVY[i] = Math.cos(a) * s;
      any = true;
    }
    if (any) {
      this.stickTimer = 0;
      this.c.audio.play({ wave: "square", freq: 420, freqTo: 900, glide: 0.09, vol: 0.16, attack: 0.002, hold: 0.03, release: 0.08 });
    }
  }

  private removeBall(i: number) {
    const j = --this.ballCount;
    if (i !== j) {
      swapOut(this.ballAll, i, j);
      this.trail.copyWithin(i * TRAIL * 2, j * TRAIL * 2, (j + 1) * TRAIL * 2);
    }
  }

  private stepBalls(dt: number) {
    const target = this.ballSpeed;

    // Gravity well aims at the densest surviving cluster.
    if (this.wellT > 0) {
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let i = 0; i < MAX_BRICKS; i++) {
        if (!this.bAlive[i]) continue;
        const row = (i / COLS) | 0;
        sx += colX(i - row * COLS);
        sy += this.rowY(row);
        n++;
      }
      if (n > 0) {
        this.wellX = sx / n;
        this.wellY = sy / n;
      }
    }

    for (let i = 0; i < this.ballCount; i++) {
      if (this.ballStuck[i]) {
        this.pushTrail(i);
        continue;
      }

      let vx = this.ballVX[i];
      let vy = this.ballVY[i];

      if (this.wellT > 0) {
        const dx = this.wellX - this.ballX[i];
        const dy = this.wellY - this.ballY[i];
        const d = Math.hypot(dx, dy) || 1;
        vx += (dx / d) * 34 * dt;
        vy += (dy / d) * 34 * dt;
      }

      // Renormalise every step: speed is owned by the chain, not by physics.
      const sp = Math.hypot(vx, vy) || 1;
      vx = (vx / sp) * target;
      vy = (vy / sp) * target;
      // No-progress guard. A flat rally between the two side rails is the most
      // boring failure this genre has, so it is made geometrically impossible.
      const floor = target * 0.14;
      if (Math.abs(vy) < floor) {
        vy = (vy >= 0 ? 1 : -1) * floor;
        vx = (vx >= 0 ? 1 : -1) * Math.sqrt(Math.max(0, target * target - floor * floor));
      }

      // Sub-step so a 60 u/s ball can never tunnel a 1.34-unit brick.
      const steps = clamp(Math.ceil((target * dt) / 0.45), 1, 8);
      const sdt = dt / steps;
      for (let s = 0; s < steps; s++) {
        this.ballX[i] += vx * sdt;
        this.ballY[i] += vy * sdt;

        const lim = PLAY_HALF_W - BALL_R;
        if (this.ballX[i] < -lim) {
          this.ballX[i] = -lim;
          vx = Math.abs(vx);
          this.bounceRail(0);
        } else if (this.ballX[i] > lim) {
          this.ballX[i] = lim;
          vx = -Math.abs(vx);
          this.bounceRail(1);
        }
        if (this.ballY[i] > CEIL_Y - BALL_R) {
          this.ballY[i] = CEIL_Y - BALL_R;
          vy = -Math.abs(vy);
          this.bounceRail(2);
        }

        const r = this.hitBricks(i, vx, vy);
        if (r !== 0) {
          if (r === 1) vx = -vx;
          else if (r === 2) vy = -vy;
        }

        // Paddle
        if (vy < 0 && this.ballY[i] - BALL_R <= PADDLE_Y + 0.75 && this.ballY[i] > PADDLE_Y - 2.5) {
          const half = this.paddleHalf;
          const off = (this.ballX[i] - this.paddleX) / half;
          if (Math.abs(off) <= 1.18) {
            const a = clamp(off, -1, 1) * 1.082; // 62 degrees off vertical
            vx = Math.sin(a) * target + this.paddleVX * 0.16;
            vy = Math.cos(a) * target;
            const m = Math.hypot(vx, vy) || 1;
            vx = (vx / m) * target;
            vy = (vy / m) * target;
            if (vy < target * 0.375) {
              vy = target * 0.375;
              vx = Math.sign(vx) * Math.sqrt(Math.max(0, target * target - vy * vy));
            }
            this.ballY[i] = PADDLE_Y + 0.75 + BALL_R;
            this.onPaddleHit(off, this.ballX[i]);
          }
        }
      }

      this.ballVX[i] = vx;
      this.ballVY[i] = vy;
      this.pushTrail(i);

      if (this.ballY[i] < PADDLE_Y - 5) {
        this.removeBall(i);
        i--;
        if (this.ballCount > 0) {
          // Losing one of several balls costs half the remaining window.
          this.chainWindow *= 0.5;
          this.c.audio.play({ wave: "sawtooth", freq: 220, freqTo: 70, glide: 0.2, vol: 0.16, attack: 0.003, hold: 0.04, release: 0.2, filter: 1200 });
        } else if (this.phase === "playing") {
          this.loseLife("BALL LOST");
        } else {
          this.spawnBall(this.paddleX, PADDLE_Y + 2, true);
          this.launchAll();
        }
      }
    }

    // The attract loop keeps a healthy field so the frame is never quiet.
    if (this.phase === "title" && this.ballCount < 3) {
      this.spawnBall(this.c.rng.range(-12, 12), 2, false);
      const k = this.ballCount - 1;
      const a = this.c.rng.range(-0.6, 0.6);
      this.ballVX[k] = Math.sin(a) * 28;
      this.ballVY[k] = -Math.cos(a) * 28;
    }
  }

  private pushTrail(i: number) {
    const h = (this.trailHead[i] + 1) % TRAIL;
    this.trailHead[i] = h;
    this.trail[(i * TRAIL + h) * 2] = this.ballX[i];
    this.trail[(i * TRAIL + h) * 2 + 1] = this.ballY[i];
  }

  private bounceRail(which: number) {
    this.railFlash[which] = 1;
    this.c.audio.play({ wave: "square", freq: 640 + which * 120, vol: 0.06, attack: 0.001, hold: 0.008, release: 0.05, filter: 3600 });
  }

  private onPaddleHit(off: number, x: number) {
    this.paddleSquash = 1;
    this.shake.add(0.06);
    this.c.audio.play({ wave: "sine", freq: 240, freqTo: 120, glide: 0.08, vol: 0.2, attack: 0.002, hold: 0.03, release: 0.12 });
    this.sparks.burst(10, x, PADDLE_Y + 1, zOf(PADDLE_Y) + 0.5, 9, { life: 0.3, size: 0.55, endSize: 0, color: hdr(0x39ffd0, 3.4, this.tc), drag: 0.25 });
    // EDGE SAVE: caught on the very tip. Deliberately weaker than SUNDER.
    if (Math.abs(off) > 0.86 && this.phase === "playing") {
      this.warp.slowMo(0.45, 0.35);
      this.addChain(6);
      this.banner("EDGE SAVE +6");
      this.shake.add(0.16);
      this.flashPump(0.18, 0.26, 0.3);
      this.c.audio.play({ wave: "square", freq: 880, freqTo: 1760, glide: 0.16, vol: 0.18, attack: 0.002, hold: 0.05, release: 0.18 });
    }
  }

  // --- brick collision -------------------------------------------------------

  private rowOfY(y: number) { return Math.round((WALL_TOP_Y - y) / ROW_H - this.wallFrac); }

  private phaseValue(i: number) { return 0.5 + 0.5 * Math.sin((this.time * TAU) / 3 + this.bPhase[i]); }

  /** Returns 0 = no hit, 1 = reflect X, 2 = reflect Y. */
  private hitBricks(bi: number, vx: number, vy: number): number {
    const bx = this.ballX[bi];
    const by = this.ballY[bi];
    const cc = Math.round(bx / COL_W + (COLS - 1) / 2);
    const cr = this.rowOfY(by);
    let result = 0;

    for (let dr = -1; dr <= 1; dr++) {
      const row = cr + dr;
      if (row < 0 || row >= ROWS) continue;
      const ry = this.rowY(row);
      for (let dc = -1; dc <= 1; dc++) {
        const col = cc + dc;
        if (col < 0 || col >= COLS) continue;
        const i = row * COLS + col;
        if (!this.bAlive[i]) continue;
        if (this.bType[i] === T_PHASE && this.phaseValue(i) < 0.35) continue;

        const rx = colX(col);
        const ox = BRICK_W / 2 + BALL_R - Math.abs(bx - rx);
        const oy = BRICK_H / 2 + BALL_R - Math.abs(by - ry);
        if (ox <= 0 || oy <= 0) continue;

        const ghost =
          this.bType[i] === T_PHASE && this.phaseValue(i) < 0.5 ? 2 : 0;
        const locked =
          this.bType[i] === T_ANCHOR && row > 0 && this.bAlive[i - COLS] === 1;

        if (this.heavyT > 0 && !locked) {
          this.damageBrick(i, "ball", ghost);
          continue;
        }

        // Push out on the shallower axis, reflect that component.
        if (ox < oy) {
          this.ballX[bi] += bx > rx ? ox : -ox;
          if (result === 0 && Math.sign(vx) !== Math.sign(bx - rx)) result = 1;
        } else {
          this.ballY[bi] += by > ry ? oy : -oy;
          if (result === 0 && Math.sign(vy) !== Math.sign(by - ry)) result = 2;
        }

        if (locked) {
          this.bHit[i] = 0.12;
          this.chainWindow = Math.min(this.chainWindow + 0.2, this.windowLength());
          this.sparks.burst(6, rx, ry, zOf(ry) + 0.8, 8, { life: 0.25, size: 0.5, endSize: 0, color: hdr(0xa855ff, 3.4, this.tc) });
          this.c.audio.play({ wave: "square", freq: 300, vol: 0.1, attack: 0.001, hold: 0.02, release: 0.08, filter: 1400 });
        } else {
          this.damageBrick(i, "ball", ghost);
        }
        return result;
      }
    }
    return result;
  }

  private damageBrick(i: number, cause: "ball" | "bolt", ghostBonus = 0) {
    if (this.bType[i] === T_ARMOUR && this.bHp[i] > 1) {
      this.bHp[i] = 1;
      this.bHit[i] = 0.18;
      // Chipping armour keeps you alive without inflating the number.
      this.chainWindow = Math.min(this.chainWindow + 0.35, this.windowLength());
      this.shake.add(0.04);
      this.warp.hitStop(0.02);
      const x = colX(i % COLS);
      const y = this.rowY((i / COLS) | 0);
      this.sparks.burst(9, x, y, zOf(y) + 0.9, 11, { life: 0.32, size: 0.6, endSize: 0, color: hdr(0xd8e6ff, 3.6, this.tc) });
      this.c.audio.play({ wave: "noise", freq: 1500, freqTo: 500, vol: 0.13, attack: 0.001, hold: 0.02, release: 0.09, filter: 4200, filterType: "highpass" });
      return;
    }
    if (ghostBonus > 0) {
      this.addChain(ghostBonus);
      this.banner("GHOST +2");
    }
    this.killBrick(i, cause);
  }

  // --- destruction & cascades ------------------------------------------------

  private windowLength() { return 1.55 - Math.min(this.chain, 50) * 0.016; }

  private addChain(n: number) {
    this.chain += n;
    this.multPunch = 1.22;
    this.chainWindow = this.windowLength();
    if (this.chain > this.chainMax) {
      this.chainMax = this.chain;
      if (this.chainMax > this.bestChain && this.phase === "playing") {
        this.bestChain = this.chainMax;
        this.c.store.set("bestChain", this.bestChain);
        if (this.pbChainT <= 0) {
          this.pbChainT = 1.2;
          [0, 4, 7, 12].forEach((s, k) =>
            this.c.audio.play({ wave: "square", freq: 660 * Math.pow(2, s / 12), vol: 0.12, attack: 0.002, hold: 0.03, release: 0.12, delay: k * 0.05 }),
          );
        }
      }
    }
  }

  private killBrick(i: number, cause: "ball" | "bolt" | "cascade") {
    if (!this.bAlive[i]) return;
    const type = this.bType[i];
    const row = (i / COLS) | 0;
    const col = i - row * COLS;
    const x = colX(col);
    const y = this.rowY(row);
    const z = zOf(y);

    this.bAlive[i] = 0;
    this.bQueued[i] = 0;
    this.aliveBricks--;
    this.destroyed++;

    this.addChain(1);
    const gained = BASE_SCORE[type] * this.chainMult;
    this.score += Math.round(gained);
    this.scorePunch = 1.18;
    if (this.phase === "playing" && this.score > this.best) {
      const wasBest = this.best;
      this.best = this.score;
      // Deferred: writing localStorage per brick would stall a 60-link cascade.
      this.bestDirty = true;
      if (wasBest > 0 && this.pbT <= 0) this.celebratePB();
    }

    const detonates = type === T_VOLATILE || type === T_SUPER;
    if (cause === "cascade" || detonates) {
      this.eventLinks++;
      this.linkPitch++;
      if (this.eventLinks >= SUNDER_LINKS && !this.eventSundered) this.fireSunder();
    }

    // Impact package: hit-stop, shake, particles, debris, ring, sound.
    this.warp.hitStop(type === T_SUPER ? 0.05 : detonates ? 0.04 : 0.03);
    this.shake.add(type === T_SUPER ? 0.14 : detonates ? 0.09 : 0.05);
    this.spawnDebris(x, y, type, type === T_SUPER ? 8 : 5);
    hdr(BRICK_HEX[type], 3.6, this.tc);
    this.sparks.burst(detonates ? 22 : 14, x, y, z + 0.6, detonates ? 20 : 13, {
      life: 0.45,
      size: 0.75,
      endSize: 0,
      color: this.tc,
      endColor: hdr(0xffffff, 1.4, this.tc2),
      drag: 0.35,
      gravity: -4,
    });
    this.spawnRing(x, y, detonates ? (type === T_SUPER ? DET_R_SUPER : DET_R) : 1.8, type);

    const semis = Math.min(this.linkPitch, 36) % 36;
    this.c.audio.play({
      wave: detonates ? "sawtooth" : "square",
      freq: 220 * Math.pow(2, semis / 12),
      vol: detonates ? 0.13 : 0.085,
      attack: 0.001,
      hold: 0.018,
      release: 0.09,
      filter: 5200,
      jitter: 8,
    });
    if (detonates) {
      this.c.audio.play({ wave: "noise", freq: 900, freqTo: 150, vol: 0.1, attack: 0.001, hold: 0.02, release: 0.16, filter: 2600, filterTo: 300 });
      this.detonate(x, y, type === T_SUPER ? DET_R_SUPER : DET_R);
      this.flashPump(0.05, 0.045, 0.04);
      this.bloomBoost = Math.min(1.6, this.bloomBoost + 0.1);
    }

    // Cascades of 6+ are much more generous with power-ups.
    const dropChance = this.eventLinks >= 6 ? 0.09 : 0.035;
    if (this.phase === "playing" && this.c.rng.next() < dropChance) this.dropShard(x, y);
  }

  private detonate(x: number, y: number, radius: number) {
    if (this.eventLinks >= LINK_CAP) {
      // Overload: bank the score, stop the propagation, keep a board to play.
      this.score += 2500 * Math.round(this.chainMult);
      return;
    }
    const dr = Math.ceil(radius / ROW_H) + 1;
    const dc = Math.ceil(radius / COL_W) + 1;
    const cc = Math.round(x / COL_W + (COLS - 1) / 2);
    const cr = this.rowOfY(y);
    for (let r = cr - dr; r <= cr + dr; r++) {
      if (r < 0 || r >= ROWS) continue;
      const ry = this.rowY(r);
      for (let c = cc - dc; c <= cc + dc; c++) {
        if (c < 0 || c >= COLS) continue;
        const i = r * COLS + c;
        if (!this.bAlive[i] || this.bQueued[i]) continue;
        const d = Math.hypot(colX(c) - x, ry - y);
        if (d > radius) continue;
        this.bQueued[i] = 1;
        // Stagger by distance so the kill is a visible expanding ripple.
        this.bFireAt[i] = this.time + 0.045 + (d / radius) * 0.055;
        this.pending++;
      }
    }
  }

  private fireSunder() {
    this.eventSundered = true;
    this.sunderLinks = this.eventLinks;
    const k = clamp01((this.eventLinks - 12) / 28);
    this.sunderDur = lerp(0.7, 1.1, k);
    this.sunderT = this.sunderDur + 0.45;
    this.warp.hitStop(0.09);
    this.warp.slowMo(this.sunderDur, 0.28);
    this.shake.add(0.42);
    this.bloomBoost = 1.4;
    this.camDolly = 3;
    this.flashPump(0.55, 0.48, 0.42);
    this.c.audio.play({ wave: "sine", freq: 140, freqTo: 34, glide: 0.8, vol: 0.3, attack: 0.004, hold: 0.12, release: 0.6 });
    this.c.audio.play({ wave: "noise", freq: 200, freqTo: 1800, vol: 0.16, attack: 0.16, hold: 0.06, release: 0.4, filter: 400, filterTo: 4000, filterType: "bandpass", q: 2 });
  }

  private celebratePB() {
    this.pbT = 2.2;
    this.flashPump(0.4, 0.34, 0.1);
    this.shake.add(0.24);
    this.bloomBoost = Math.max(this.bloomBoost, 1.0);
    for (let i = 0; i < 160; i++) {
      const a = this.c.rng.angle();
      this.sparks.spawn({
        x: 0,
        y: 2,
        z: zOf(2) + 3,
        vx: Math.cos(a) * this.c.rng.range(8, 40),
        vy: Math.sin(a) * this.c.rng.range(8, 40),
        vz: this.c.rng.range(2, 16),
        life: this.c.rng.range(0.6, 1.2),
        size: 1.1,
        endSize: 0,
        color: hdr(0xffd24a, 4, this.tc),
        drag: 0.4,
      });
    }
    [0, 4, 7, 12, 16, 19].forEach((s, k) =>
      this.c.audio.play({ wave: "square", freq: 440 * Math.pow(2, s / 12), vol: 0.14, attack: 0.002, hold: 0.04, release: 0.2, delay: k * 0.06, filter: 4000 }),
    );
  }

  private stepChain(dt: number) { if (this.chain <= 0) return; this.chainWindow -= dt; if (this.chainWindow > 0) return; this.breakChain(); }

  private breakChain() {
    const lost = this.chain;
    this.chain = 0;
    this.chainWindow = 0;
    this.breakT = 0.4;
    this.shake.add(0.25);
    this.c.audio.fail(0.22);
    // The big number shatters and falls off the bottom of the HUD.
    const cx = this.w * 0.5;
    const cy = this.h * 0.18;
    const n = Math.min(MAX_HUD_BITS, 90);
    for (let i = 0; i < n; i++) {
      if (this.hbCount >= MAX_HUD_BITS) break;
      const k = this.hbCount++;
      this.hbX[k] = cx + this.c.rng.spread(this.w * 0.13);
      this.hbY[k] = cy + this.c.rng.spread(this.h * 0.045);
      this.hbVX[k] = this.c.rng.spread(220);
      this.hbVY[k] = this.c.rng.range(-320, -60);
      this.hbLife[k] = this.c.rng.range(0.7, 1.4);
      this.hbSize[k] = this.c.rng.range(3, 11);
    }
    void lost;
  }

  private loseLife(reason: string) {
    if (this.shields > 0) {
      this.shields--;
      this.banner("SHIELD HELD");
      this.spawnBall(this.paddleX, PADDLE_Y + 2, true);
      this.stickTimer = 0.7;
      this.c.audio.powerUp(0.2);
      return;
    }
    this.lives--;
    this.shake.add(0.5);
    this.flashPump(0.5, 0.08, 0.12);
    this.warp.hitStop(0.12);
    this.c.audio.explode(0.34);
    this.banner(reason);
    this.breakChain();

    // Mercy: blow the two lowest live rows away so death cannot spiral.
    let cleared = 0;
    for (let row = ROWS - 1; row >= 0 && cleared < 2; row--) {
      let any = false;
      for (let c = 0; c < COLS; c++) {
        const i = row * COLS + c;
        if (!this.bAlive[i]) continue;
        any = true;
        this.bAlive[i] = 0;
        this.bQueued[i] = 0;
        this.aliveBricks--;
        this.spawnDebris(colX(c), this.rowY(row), this.bType[i], 4);
      }
      if (any) cleared++;
    }

    if (this.lives <= 0) {
      this.die();
      return;
    }
    this.ballCount = 0;
    this.spawnBall(this.paddleX, PADDLE_Y + 2, true);
    this.stickTimer = 0.9;
  }

  private die() {
    this.phase = "dead";
    this.deadT = 0;
    this.shake.add(0.8);
    this.warp.slowMo(1.2, 0.25);
    this.flashPump(0.6, 0.12, 0.14);
    this.c.audio.explode(0.4);
    this.c.audio.play({ wave: "sawtooth", freq: 180, freqTo: 30, glide: 0.9, vol: 0.26, attack: 0.006, hold: 0.14, release: 0.7, filter: 1200, filterTo: 120 });
    this.c.report({ score: this.score, best: this.best, label: `WAVE ${this.wave}`, status: "over" });
  }

  // --- power-ups -------------------------------------------------------------

  private dropShard(x: number, y: number) {
    if (this.sCount >= MAX_SHARDS) return;
    const i = this.sCount++;
    this.sX[i] = x;
    this.sY[i] = y;
    this.sVX[i] = this.c.rng.spread(3);
    this.sVY[i] = -this.c.rng.range(5, 9);
    this.sSpin[i] = this.c.rng.range(2, 7);
    this.sType[i] = this.c.rng.int(0, 5);
  }

  private stepShards(dt: number) {
    const half = this.paddleHalf;
    for (let i = 0; i < this.sCount; i++) {
      this.sVY[i] -= 11 * dt;
      this.sX[i] += this.sVX[i] * dt;
      this.sY[i] += this.sVY[i] * dt;
      let gone = false;
      if (
        this.sY[i] < PADDLE_Y + 1.4 &&
        this.sY[i] > PADDLE_Y - 2 &&
        Math.abs(this.sX[i] - this.paddleX) < half + 1.4
      ) {
        this.applyPower(this.sType[i]);
        gone = true;
      } else if (this.sY[i] < PADDLE_Y - 5) {
        gone = true;
      }
      if (gone) {
        swapOut(this.sAll, i--, --this.sCount);
      }
    }
  }

  private applyPower(t: number) {
    this.banner(PU_NAME[t]);
    this.c.audio.powerUp(0.22);
    this.flashPump(0.12, 0.16, 0.2);
    this.shake.add(0.1);
    hdr(PU_HEX[t], 4, this.tc);
    this.sparks.burst(40, this.paddleX, PADDLE_Y + 1.5, zOf(PADDLE_Y) + 1, 20, { life: 0.6, size: 0.9, endSize: 0, color: this.tc, drag: 0.35 });
    switch (t) {
      case PU_SPLIT: {
        const n = this.ballCount;
        for (let i = 0; i < n; i++) {
          if (this.ballCount >= MAX_BALLS) break;
          this.spawnBall(this.ballX[i], this.ballY[i], false);
          const k = this.ballCount - 1;
          const a = Math.atan2(this.ballVY[i], this.ballVX[i]) + 0.55;
          const sp = this.ballSpeed;
          this.ballVX[k] = Math.cos(a) * sp;
          this.ballVY[k] = Math.sin(a) * sp;
          if (this.ballVY[k] === 0) this.ballVY[k] = sp * 0.5;
        }
        break;
      }
      case PU_LANCE:
        this.lanceT = 8;
        break;
      case PU_HEAVY:
        this.heavyT = 6;
        break;
      case PU_WELL:
        this.wellT = 5;
        break;
      case PU_WIDE:
        this.wideT = 10;
        break;
      case PU_SHIELD:
        this.shields = Math.min(3, this.shields + 1);
        break;
    }
  }

  private stepBolts(dt: number) {
    if (this.lanceT > 0) {
      this.boltCd -= dt;
      if (this.boltCd <= 0) {
        this.boltCd = 0.22;
        const half = this.paddleHalf;
        for (const off of [-half + 0.4, half - 0.4]) {
          if (this.lCount >= MAX_BOLTS) break;
          const i = this.lCount++;
          this.lX[i] = this.paddleX + off;
          this.lY[i] = PADDLE_Y + 1.2;
        }
        this.c.audio.laser(0.09);
      }
    }
    for (let i = 0; i < this.lCount; i++) {
      this.lY[i] += 58 * dt;
      let gone = this.lY[i] > CEIL_Y;
      if (!gone) {
        const col = Math.round(this.lX[i] / COL_W + (COLS - 1) / 2);
        const row = this.rowOfY(this.lY[i]);
        if (col >= 0 && col < COLS && row >= 0 && row < ROWS) {
          const bi = row * COLS + col;
          if (
            this.bAlive[bi] &&
            Math.abs(this.rowY(row) - this.lY[i]) < BRICK_H / 2 + 0.6 &&
            !(this.bType[bi] === T_ANCHOR && row > 0 && this.bAlive[bi - COLS] === 1)
          ) {
            this.damageBrick(bi, "bolt");
            gone = true;
          }
        }
      }
      if (gone) {
        swapOut(this.lAll, i--, --this.lCount);
      }
    }
  }

  // --- debris, rings ---------------------------------------------------------

  private spawnDebris(x: number, y: number, type: number, n: number) {
    const r = this.c.rng;
    for (let k = 0; k < n && this.dCount < MAX_DEBRIS; k++) {
      const i = this.dCount++;
      this.dX[i] = x + r.spread(1.2);
      this.dY[i] = y + r.spread(0.5);
      this.dZ[i] = zOf(y) + r.spread(0.5);
      this.dVX[i] = r.spread(11);
      this.dVY[i] = r.range(-2, 13);
      // Positive vz is straight at the lens.
      this.dVZ[i] = r.range(3, 17);
      this.dRX[i] = r.angle();
      this.dRY[i] = r.angle();
      this.dSpin[i] = r.range(-9, 9);
      this.dLife[i] = r.range(0.9, 1.9);
      this.dSize[i] = r.range(0.4, 0.95);
      this.dType[i] = type;
    }
  }

  private stepDebris(dt: number) {
    for (let i = 0; i < this.dCount; i++) {
      this.dVY[i] -= 24 * dt;
      this.dX[i] += this.dVX[i] * dt;
      this.dY[i] += this.dVY[i] * dt;
      this.dZ[i] += this.dVZ[i] * dt;
      this.dRX[i] += this.dSpin[i] * dt;
      this.dRY[i] += this.dSpin[i] * 0.7 * dt;
      this.dLife[i] -= dt;
      if (this.dLife[i] <= 0 || this.dZ[i] > this.camZ - 4) {
        swapOut(this.dAll, i--, --this.dCount);
      }
    }
  }

  private spawnRing(x: number, y: number, radius: number, type: number) {
    if (this.rCount >= MAX_RINGS) return;
    const i = this.rCount++;
    this.rX[i] = x;
    this.rY[i] = y;
    this.rR[i] = radius;
    this.rLife[i] = 0.42;
    this.rMax[i] = 0.42;
    this.rType[i] = type;
  }

  private stepRings(dt: number) {
    for (let i = 0; i < this.rCount; i++) {
      this.rLife[i] -= dt;
      if (this.rLife[i] <= 0) {
        swapOut(this.rAll, i--, --this.rCount);
      }
    }
  }

  // --- feedback helpers ------------------------------------------------------

  private flashPump(r: number, g: number, b: number) {
    this.flashR = Math.min(0.85, this.flashR + r);
    this.flashG = Math.min(0.85, this.flashG + g);
    this.flashB = Math.min(0.85, this.flashB + b);
  }

  private banner(text: string) { this.bannerText = text; this.bannerT = 1.0; }

  private callout(wave: number) {
    for (const [w, t] of CALLOUTS) {
      if (w === wave) {
        this.calloutText = t;
        this.calloutT = 3.4;
        if (wave !== this.prevWave && wave > 1) {
          this.flashPump(0.14, 0.2, 0.26);
          this.shake.add(0.18);
          this.c.audio.play({ wave: "square", freq: 330, freqTo: 660, glide: 0.2, vol: 0.16, attack: 0.003, hold: 0.06, release: 0.22, filter: 3000 });
        }
        this.prevWave = wave;
        return;
      }
    }
    this.prevWave = wave;
  }

  private music(dt: number) {
    const bpm = lerp(104, 148, clamp01((this.wave - 1) / 5));
    const step = 60 / bpm / 4;
    this.musicAcc += dt;
    let guard = 0;
    while (this.musicAcc >= step && guard++ < 8) {
      this.musicAcc -= step;
      const s = this.musicStep++ % 16;
      const a = this.c.audio;
      if (s % 4 === 0) {
        a.play({ wave: "sine", freq: 62, freqTo: 40, glide: 0.1, vol: 0.14, attack: 0.002, hold: 0.03, release: 0.12 });
      }
      if (this.wave >= 2 && s % 4 === 2) {
        a.play({ wave: "noise", freq: 2600, vol: 0.04, attack: 0.001, hold: 0.005, release: 0.04, filter: 5600, filterType: "highpass" });
      }
      if (this.wave >= 3 && s % 2 === 1) {
        // The arp root climbs with the chain multiplier.
        const root = 110 * Math.pow(2, Math.floor(this.chainMult / 4) / 12);
        const arp = [0, 3, 7, 10, 12][Math.floor(this.musicStep / 2) % 5];
        a.play({ wave: "square", freq: root * Math.pow(2, arp / 12), vol: 0.035, attack: 0.001, hold: 0.012, release: 0.07, filter: 2600 });
      }
      // The window running out becomes an audible clock.
      if (this.chain > 0 && this.chainWindow < 0.35 && s % 2 === 0) a.tick(0.06);
    }
  }

  // --- render ----------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D) {
    if (!this.ready) return;

    this.syncBricks();
    this.syncDebris();
    this.syncShards();
    this.syncBolts();
    this.syncRingsAndTrails();
    this.syncPaddleAndRails();

    const bu = this.backdropMat.uniforms;
    bu.uTime.value = this.time;
    bu.uChain.value = this.chain;
    bu.uDanger.value = this.danger;

    // Camera: fixed frame, a forward dolly on SUNDER, shake applied last.
    this.camera.position.set(0, -2.5, this.camZ - this.camDolly);
    this.camera.lookAt(0, 1.5, -3);
    this.backdrop.position.set(0, 0, -80);
    this.shake.apply(this.camera, 1.4);

    const g = this.post.grade.uniforms;
    const speedNorm = clamp01((this.ballSpeed - 26) / 34);
    const waveNorm = clamp01((this.wave - 1) / 5);
    const sunderK = this.sunderT > 0 ? clamp01(this.sunderT / this.sunderDur) : 0;
    g.time.value = this.time;
    g.amount.value = 0.0018 + speedNorm * 0.006 + this.flashR * 0.02 + sunderK * 0.012;
    g.warp.value = 0.02 + speedNorm * 0.06 + waveNorm * 0.02 + sunderK * 0.17;
    g.vignette.value = 0.85 + waveNorm * 0.27 + clamp01((this.danger - 0.7) / 0.3) * 0.23;
    g.scan.value = waveNorm * 0.06;
    g.desat.value = Math.max(this.phase === "dead" ? clamp01(this.deadT * 1.6) * 0.75 : 0, Math.max(sunderK * 0.55, this.breakT > 0 ? 0.5 : 0) );
    (g.flash.value as THREE.Color).setRGB(this.flashR, this.flashG, this.flashB);
    this.post.bloom.strength = 1.05 + waveNorm * 0.5 + this.bloomBoost;

    this.post.composer.render();
    this.drawHud();
    this.hud.commit(this.renderer);
    void ctx;
  }

  private syncBricks() {
    const p = this.brickPool;
    p.begin();
    const tp = this.tetherPool;
    tp.begin();
    for (let i = 0; i < MAX_BRICKS; i++) {
      if (!this.bAlive[i]) continue;
      const row = (i / COLS) | 0;
      const col = i - row * COLS;
      const y = this.rowY(row);
      if (y < PADDLE_Y - 3) continue;
      const x = colX(col);
      const z = zOf(y);
      const type = this.bType[i];

      let sx = BRICK_W;
      let sy = BRICK_H;
      let sz = BRICK_D;
      if (type === T_VOLATILE) {
        const k = 0.5 + 0.5 * Math.sin(this.time * 2.4 * TAU + this.bPhase[i]);
        hdr(BRICK_HEX[type], 3.0 + k * 2.5, this.tc);
      } else if (type === T_ARMOUR && this.bHp[i] === 1) {
        hdr(0xd8e6ff, 2.6, this.tc);
        sy *= 0.82;
      } else if (type === T_PHASE) {
        const v = this.phaseValue(i);
        if (v < 0.35) {
          hdr(BRICK_HEX[type], 0.5, this.tc);
          sy *= 0.22;
          sz *= 0.22;
        } else {
          hdr(BRICK_HEX[type], 0.6 + v * 2.2, this.tc);
        }
      } else if (type === T_SUPER) {
        const k = 0.5 + 0.5 * Math.sin(this.time * 3.4 * TAU + this.bPhase[i]);
        hdr(BRICK_HEX[type], 4.2 + k * 2.4, this.tc);
      } else {
        hdr(BRICK_HEX[type], BRICK_GAIN[type], this.tc);
      }

      if (this.bHit[i] > 0) {
        this.bHit[i] = Math.max(0, this.bHit[i] - 1 / 60);
        this.tc.setRGB(5, 5, 5);
      }
      if (this.bQueued[i]) {
        // Bricks about to blow flare white so the ripple front is readable.
        const k = clamp01(1 - (this.bFireAt[i] - this.time) / 0.1);
        this.tc.r += k * 4;
        this.tc.g += k * 3.4;
        this.tc.b += k * 3;
        sx *= 1 + k * 0.12;
        sy *= 1 + k * 0.12;
      }

      this.sc.x = sx;
      this.sc.y = sy;
      this.sc.z = sz;
      p.write(x, y, z, this.sc, this.tc);

      if (type === T_ANCHOR && row > 0 && this.bAlive[i - COLS]) {
        const ly = this.rowY(row - 1);
        const mid = (y + ly) / 2;
        this.sc.x = 1;
        this.sc.y = Math.abs(ly - y);
        this.sc.z = 1;
        this.rot.x = -Math.atan(TILT);
        this.rot.y = 0;
        this.rot.z = 0;
        const pulse = 0.6 + 0.4 * Math.sin(this.time * 9 + this.bPhase[i]);
        tp.write(x, mid, zOf(mid) + 0.7, this.sc, hdr(0xa855ff, 2.5 + pulse * 3, this.tc), this.rot);
      }
    }
    p.end();
    tp.end();
  }

  private syncDebris() {
    const p = this.debrisPool;
    p.begin();
    for (let i = 0; i < this.dCount; i++) {
      const k = clamp01(this.dLife[i] * 1.6);
      this.rot.x = this.dRX[i];
      this.rot.y = this.dRY[i];
      this.rot.z = this.dRX[i] * 0.6;
      // Deliberately sub-1.0 so debris reads as solid matter, not light.
      this.tc.setHex(BRICK_HEX[this.dType[i]], THREE.SRGBColorSpace).multiplyScalar(0.65);
      p.write(this.dX[i], this.dY[i], this.dZ[i], this.dSize[i] * k, this.tc, this.rot);
    }
    p.end();
  }

  private syncShards() {
    const p = this.shardPool;
    p.begin();
    for (let i = 0; i < this.sCount; i++) {
      this.rot.x = this.time * this.sSpin[i];
      this.rot.y = this.time * this.sSpin[i] * 0.8;
      this.rot.z = 0;
      const pulse = 1 + 0.14 * Math.sin(this.time * 12 + i);
      p.write(this.sX[i], this.sY[i], zOf(this.sY[i]) + 1.2, pulse, hdr(PU_HEX[this.sType[i]], 4, this.tc), this.rot );
    }
    p.end();
  }

  private syncBolts() {
    const p = this.boltPool;
    p.begin();
    for (let i = 0; i < this.lCount; i++) {
      p.write(this.lX[i], this.lY[i], zOf(this.lY[i]) + 0.9, 1, hdr(0xff3355, 5, this.tc));
    }
    p.end();
  }

  private syncRingsAndTrails() {
    const rp = this.ringPool;
    rp.begin();
    for (let i = 0; i < this.rCount; i++) {
      const k = 1 - this.rLife[i] / this.rMax[i];
      const rad = this.rR[i] * (0.25 + k * 1.15);
      const fade = 1 - k;
      hdr(BRICK_HEX[this.rType[i]], 1.5 + fade * 4.5, this.tc);
      rp.write(this.rX[i], this.rY[i], zOf(this.rY[i]) + 1.4, rad * 2, this.tc);
    }
    // Predicted-landing markers so a ball can be read through the debris.
    for (let i = 0; i < this.ballCount; i++) {
      if (this.ballY[i] > -8 || this.ballVY[i] >= 0) continue;
      const t = (PADDLE_Y - this.ballY[i]) / this.ballVY[i];
      if (t <= 0) continue;
      let px = this.ballX[i] + this.ballVX[i] * t;
      const lim = PLAY_HALF_W - BALL_R;
      // Fold the prediction through the side rails.
      for (let n = 0; n < 8 && (px < -lim || px > lim); n++) {
        if (px < -lim) px = -2 * lim - px;
        else px = 2 * lim - px;
      }
      px = clamp(px, -lim, lim);
      rp.write(px, PADDLE_Y + 0.6, zOf(PADDLE_Y) + 1.6, 2.4, hdr(0xffffff, 1.6, this.tc));
    }
    rp.end();

    const gp = this.glowPool;
    gp.begin();
    for (let i = 0; i < this.ballCount; i++) {
      const head = this.trailHead[i];
      for (let k = 0; k < TRAIL; k++) {
        const idx = (head - k + TRAIL * 2) % TRAIL;
        const f = 1 - k / TRAIL;
        const bx = this.trail[(i * TRAIL + idx) * 2];
        const by = this.trail[(i * TRAIL + idx) * 2 + 1];
        hdr(this.heavyT > 0 ? 0xff9a2b : 0x66e0ff, 1.2 + f * 2.6, this.tc);
        gp.write(bx, by, zOf(by) + 0.4, 1.1 + f * 2.6, this.tc);
      }
    }
    // Paddle underglow lives in the same additive pool.
    const half = this.paddleHalf;
    gp.write(this.paddleX, PADDLE_Y - 1.1, zOf(PADDLE_Y) + 0.2, half * 3.4, hdr(0x39ffd0, 1.5, this.tc) );
    if (this.wellT > 0) {
      const pulse = 3 + Math.sin(this.time * 10) * 1.5;
      gp.write(this.wellX, this.wellY, zOf(this.wellY) + 1.5, 9 + pulse, hdr(0xa855ff, 2.2, this.tc));
    }
    gp.end();

    const bp = this.ballPool;
    bp.begin();
    for (let i = 0; i < this.ballCount; i++) {
      const s = this.heavyT > 0 ? 1.55 : 1;
      bp.write(this.ballX[i], this.ballY[i], zOf(this.ballY[i]) + 0.4, s, hdr(0xffffff, 6, this.tc) );
    }
    bp.end();
  }

  private syncPaddleAndRails() {
    const half = this.paddleHalf;
    const squash = 1 - this.paddleSquash * 0.28;
    this.paddleMesh.position.set(this.paddleX, PADDLE_Y, zOf(PADDLE_Y));
    this.paddleMesh.scale.set(half * 2, squash, 1 + this.paddleSquash * 0.4);
    (this.paddleMesh.material as THREE.MeshBasicMaterial).color.copy(hdr(this.shields > 0 ? 0x9dffe8 : 0x39ffd0, 3.2 + this.paddleSquash * 3, this.tc) );
    this.paddleGlow.position.set(this.paddleX, PADDLE_Y - 0.4, zOf(PADDLE_Y) - 0.4);
    this.paddleGlow.scale.set(half * 5, 7, 1);

    for (let i = 0; i < 3; i++) {
      const f = this.railFlash[i];
      const mat = this.rails[i].material as THREE.MeshBasicMaterial;
      mat.color.copy(hdr(f > 0 ? 0x9fd8ff : 0x2b6cff, f > 0 ? 1.6 + f * 4.4 : 1.6, this.tc));
    }
    // Floor line heats up as the wall closes in.
    (this.rails[0].material as THREE.MeshBasicMaterial).color.lerp(hdr(0xff2a3c, 2.2, this.tc2), this.danger * 0.6 );
    (this.rails[1].material as THREE.MeshBasicMaterial).color.lerp(hdr(0xff2a3c, 2.2, this.tc2), this.danger * 0.6 );
  }

  // --- HUD -------------------------------------------------------------------

  private drawHud() {
    const g = this.hud.begin();
    const W = this.w;
    const H = this.h;
    const mono = 'ui-monospace, "SF Mono", Menlo, monospace';
    const small = Math.max(11, Math.min(W, H) * 0.018);

    // --- score, top left
    const scoreSize = clamp(W * 0.038, 24, 52);
    g.save();
    g.translate(W * 0.035, H * 0.085);
    g.scale(this.scorePunch, this.scorePunch);
    g.font = `800 ${scoreSize}px ${mono}`;
    g.textAlign = "left";
    glowText(g, comma(this.score), 0, 0, "#eaf6ff", 16);
    g.restore();
    g.font = `600 ${small}px ${mono}`;
    g.textAlign = "left";
    g.fillStyle = "rgba(160,190,220,0.8)";
    g.fillText(`BEST ${comma(this.best)}`, W * 0.035, H * 0.085 + small * 1.7);

    // --- wave, lives, danger, top right
    g.textAlign = "right";
    g.font = `800 ${clamp(W * 0.022, 16, 30)}px ${mono}`;
    g.fillStyle = "#8fd2ff";
    g.fillText(`WAVE ${this.wave}`, W - W * 0.035, H * 0.075);
    for (let i = 0; i < 3; i++) {
      const x = W - W * 0.035 - i * 20;
      const y = H * 0.075 + small * 1.8;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x - 7, y - 9);
      g.lineTo(x - 14, y);
      g.closePath();
      g.fillStyle = i < this.lives ? "#39ffd0" : "rgba(255,255,255,0.16)";
      g.fill();
    }
    if (this.shields > 0) {
      g.font = `700 ${small}px ${mono}`;
      g.fillStyle = "#39ffd0";
      g.fillText(`SHIELD x${this.shields}`, W - W * 0.035, H * 0.075 + small * 3.4);
    }

    // --- power-up timers
    const powers: Array<[number, number, number]> = [
      [PU_LANCE, this.lanceT, 8],
      [PU_HEAVY, this.heavyT, 6],
      [PU_WELL, this.wellT, 5],
      [PU_WIDE, this.wideT, 10],
    ];
    let py = H * 0.075 + small * (this.shields > 0 ? 5 : 3.4);
    g.font = `700 ${small}px ${mono}`;
    for (const [t, left, max] of powers) {
      if (left <= 0) continue;
      const col = `#${PU_HEX[t].toString(16).padStart(6, "0")}`;
      g.fillStyle = col;
      g.textAlign = "right";
      g.fillText(PU_NAME[t], W - W * 0.035 - 46, py);
      g.fillStyle = "rgba(255,255,255,0.16)";
      g.fillRect(W - W * 0.035 - 42, py - small * 0.8, 42, small * 0.75);
      g.fillStyle = col;
      g.fillRect(W - W * 0.035 - 42, py - small * 0.8, 42 * (left / max), small * 0.75);
      py += small * 1.6;
    }

    // --- the chain multiplier: the biggest thing on screen
    const cx = W * 0.5;
    const cy = H * 0.185;
    const multSize = clamp(W * 0.09, 62, 170);
    const chain = this.chain;
    let colour = "#7ff0ff";
    if (chain >= 50) colour = "#ffffff";
    else if (chain >= 30) colour = "#ff8a2b";
    else if (chain >= 15) colour = "#ffd24a";
    const jitter = chain > 30 ? 2 : 0;
    g.save();
    g.translate(cx + (jitter ? (Math.random() - 0.5) * jitter * 2 : 0), cy + (jitter ? (Math.random() - 0.5) * jitter * 2 : 0) );
    g.scale(this.multPunch, this.multPunch);
    g.textAlign = "center";
    if (chain > 60) {
      g.beginPath();
      g.arc(0, -multSize * 0.28, multSize * 0.62, 0, TAU);
      g.strokeStyle = "rgba(255,180,60,0.35)";
      g.lineWidth = 6 + Math.sin(this.realT * 14) * 3;
      g.stroke();
    }
    g.font = `900 ${multSize}px ${mono}`;
    const mult = this.chainMult;
    glowText(g, `x${mult.toFixed(1)}`, 0, 0, colour, 34);
    g.restore();

    g.textAlign = "center";
    g.font = `700 ${clamp(W * 0.02, 15, 26)}px ${mono}`;
    g.fillStyle = "rgba(220,240,255,0.9)";
    g.fillText(`${chain} LINKS`, cx, cy + multSize * 0.36);

    // --- draining chain window
    const barW = Math.min(300, W * 0.42);
    const barH = 9;
    const barX = cx - barW / 2;
    const barY = cy + multSize * 0.36 + 14;
    const frac = clamp01(this.chainWindow / Math.max(0.001, this.windowLength()));
    g.fillStyle = "rgba(0,0,0,0.5)";
    roundRectPath(g, barX, barY, barW, barH, 4);
    g.fill();
    const low = this.chainWindow < 0.35 && chain > 0;
    const strobe = low && Math.sin(this.realT * 6 * TAU) > 0;
    g.fillStyle = low ? (strobe ? "#ff3355" : "#ff7a2b") : colour;
    roundRectPath(g, barX, barY, barW * frac, barH, 4);
    g.fill();

    g.font = `600 ${small}px ${mono}`;
    g.fillStyle = "rgba(150,180,210,0.75)";
    g.fillText(`BEST CHAIN ${this.bestChain}   ·   THIS RUN ${this.chainMax}`, cx, barY + barH + small * 1.5 );

    // --- HUD shatter bits from a broken chain
    for (let i = 0; i < this.hbCount; i++) {
      g.globalAlpha = clamp01(this.hbLife[i]);
      g.fillStyle = "#ff7a4a";
      g.fillRect(this.hbX[i], this.hbY[i], this.hbSize[i], this.hbSize[i]);
    }
    g.globalAlpha = 1;

    // --- SUNDER slam
    if (this.sunderT > 0) {
      const age = this.sunderDur + 0.45 - this.sunderT;
      const k = clamp01(age / 0.18);
      const s = lerp(1.6, 1, easeOutBack(k));
      const fade = clamp01(this.sunderT / 0.4);
      g.save();
      g.globalAlpha = fade;
      g.translate(W * 0.5, H * 0.52);
      const wipe = clamp01(age / 0.3);
      g.fillStyle = "rgba(255,255,255,0.16)";
      g.fillRect(-W * wipe, -H * 0.06, W * 2 * wipe, H * 0.12);
      g.scale(s, s);
      g.textAlign = "center";
      g.font = `900 ${clamp(W * 0.075, 46, 140)}px ${mono}`;
      glowText(g, `SUNDER x${this.sunderLinks}`, 0, 0, "#ffffff", 46);
      g.restore();
    }

    // --- transient banners and callouts
    if (this.bannerT > 0 && this.sunderT <= 0) {
      g.save();
      g.globalAlpha = clamp01(this.bannerT * 1.6);
      g.textAlign = "center";
      g.font = `900 ${clamp(W * 0.032, 22, 48)}px ${mono}`;
      glowText(g, this.bannerText, W * 0.5, H * 0.66, "#ffe6a0", 22);
      g.restore();
    }
    if (this.calloutT > 0) {
      g.save();
      g.globalAlpha = clamp01(this.calloutT * 0.8);
      g.textAlign = "center";
      g.font = `700 ${clamp(W * 0.019, 13, 22)}px ${mono}`;
      g.fillStyle = "#9fe8ff";
      g.fillText(this.calloutText, W * 0.5, H * 0.755);
      g.restore();
    }
    if (this.pbT > 0) {
      g.save();
      g.globalAlpha = clamp01(this.pbT);
      g.textAlign = "center";
      g.font = `900 ${clamp(W * 0.05, 30, 84)}px ${mono}`;
      glowText(g, "NEW BEST", W * 0.5, H * 0.44, "#ffd24a", 40);
      g.restore();
    }
    if (this.pbChainT > 0 && this.pbT <= 0) {
      g.save();
      g.globalAlpha = clamp01(this.pbChainT);
      g.textAlign = "center";
      g.font = `800 ${clamp(W * 0.028, 18, 40)}px ${mono}`;
      glowText(g, "CHAIN RECORD", W * 0.5, H * 0.44, "#ffd24a", 24);
      g.restore();
    }

    if (this.phase === "title") this.drawTitle(g, mono);
    if (this.phase === "dead") this.drawDead(g, mono);
  }

  private drawTitle(g: CanvasRenderingContext2D, mono: string) {
    const W = this.w;
    const H = this.h;
    g.save();
    g.textAlign = "center";
    g.font = `900 ${clamp(W * 0.13, 64, 190)}px ${mono}`;
    const beat = 1 + Math.sin(this.realT * 2.4) * 0.012;
    g.translate(W * 0.5, H * 0.52);
    g.scale(beat, beat);
    g.globalCompositeOperation = "lighter";
    glowText(g, "SUNDER", 0, 0, "rgba(255,255,255,0.92)", 50);
    g.restore();

    g.save();
    g.textAlign = "center";
    g.font = `700 ${clamp(W * 0.02, 14, 26)}px ${mono}`;
    g.globalAlpha = 0.6 + 0.4 * Math.sin(this.realT * 4);
    glowText(g, this.c.isTouch ? "TAP TO PLAY" : "CLICK OR PRESS SPACE", W * 0.5, H * 0.68, "#9fe8ff", 18 );
    g.restore();
    g.textAlign = "center";
    g.font = `600 ${clamp(W * 0.015, 11, 17)}px ${mono}`;
    g.fillStyle = "rgba(180,210,240,0.7)";
    g.fillText("CHAIN THE VOLATILE BRICKS — 12 LINKS FIRES SUNDER", W * 0.5, H * 0.735);
  }

  private drawDead(g: CanvasRenderingContext2D, mono: string) {
    const W = this.w;
    const H = this.h;
    const k = clamp01(this.deadT * 1.4);
    g.save();
    g.globalAlpha = k * 0.72;
    g.fillStyle = "#12061c";
    g.fillRect(0, 0, W, H);
    g.restore();
    g.textAlign = "center";
    g.font = `900 ${clamp(W * 0.07, 40, 108)}px ${mono}`;
    glowText(g, "WALL WINS", W * 0.5, H * 0.44, "#ff5a3c", 36);
    g.font = `800 ${clamp(W * 0.035, 22, 48)}px ${mono}`;
    glowText(g, comma(this.score), W * 0.5, H * 0.54, "#eaf6ff", 20);
    g.font = `700 ${clamp(W * 0.018, 13, 22)}px ${mono}`;
    g.fillStyle = "rgba(190,215,240,0.85)";
    g.fillText(`BEST ${comma(this.best)}   ·   LONGEST CHAIN ${this.chainMax}   ·   WAVE ${this.wave}`, W * 0.5, H * 0.6 );
    g.globalAlpha = 0.6 + 0.4 * Math.sin(this.realT * 5);
    glowText(g, "CLICK / SPACE / R TO GO AGAIN", W * 0.5, H * 0.68, "#9fe8ff", 16);
    g.globalAlpha = 1;
  }
}

const factory: GameFactory = (ctx) => new Sunder(ctx);
export default factory;
