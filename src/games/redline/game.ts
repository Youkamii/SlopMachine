/**
 * REDLINE
 *
 * A hyper-speed tunnel racer built around one greedy idea: the safe line
 * scores nothing. You rotate around the axis of a tube rushing at you and
 * thread gaps in obstacle rings. Only shaving the EDGE of a gap feeds the
 * chain, and the chain is simultaneously the score multiplier, the boost fuel
 * and the gate on the slow-motion THREAD. Fly down the middle and the chain
 * timer bleeds out and collapses.
 *
 * Design intent is dopamine, not restraint. The game boots straight into a
 * live attract run — the real simulation with a scripted pilot and collision
 * disabled — so the very first rendered frame is already a tunnel at 155 u/s
 * with the lens bent, bloom blown out and a chain counter climbing. There is
 * no black screen and no menu anywhere in the product.
 *
 * Nothing here is lit: every surface is emissive, every spark is additive, and
 * bloom does the rest. Three instanced pools and one shader cylinder carry the
 * entire frame.
 */

import { transpose } from "@/engine/audio";
import { Overlay, roundRectPath } from "@/engine/gl/overlay";
import { InstancePool, Particles } from "@/engine/gl/pool";
import type { PostStack } from "@/engine/gl/post";
import { glowTexture, hdr, makePost, ringTexture } from "@/engine/gl/post";
import { Shake, TimeWarp } from "@/engine/gl/shake";
import {
  angleDelta,
  approach,
  clamp,
  clamp01,
  damp,
  HALF_PI,
  lerp,
  TAU,
} from "@/engine/math";
import type { GameContext, GameFactory, GameInstance } from "@/games/types";
import * as THREE from "three";

// --- tuning -----------------------------------------------------------------

const TUNNEL_R = 13.6;
const SHIP_R = 9.9;
const OBST_R_IN = 7.2;
const OBST_R_OUT = 13.5;
const SEGMENTS = 30;
const SEG_STEP = TAU / SEGMENTS;

const CAM_Z = 16;
const SPAWN_Z = -380;
const RECYCLE_Z = 26;

const MAX_PLANES = 48;
const MAX_OBSTACLE_BOXES = 1500;
const STREAKS = 900;
const MAX_PARTICLES = 3000;
const MAX_WAVES = 8;

/** Angular half-width of the ship. Less clearance than this and you die. */
const FORGIVE = 0.06;
/** Deliberately loose: starting a chain is easy, the 2.4s timer is the tax. */
const NEAR_WINDOW = 0.34;
const THREAD_WINDOW = 0.11;
const THREAD_COOLDOWN = 2.5;

const OMEGA_ACCEL = 30;
const OMEGA_FRICTION = 12;

const V_BASE = 88;
const V_RAMP = 0.42;
const V_CAP = 190;
const REDLINE_MUL = 1.55;

const FIRST_GATE = 20;
const GATE_EVERY = 30;

interface Palette {
  name: string;
  wall: number;
  deep: number;
  accent: number;
  edge: number;
  /** Root of the bass and drone. Every sector is a different key. */
  root: number;
}

const PALETTES: Palette[] = [
  { name: "CRIMSON", wall: 0xff2d3f, deep: 0x300a12, accent: 0xffb03a, edge: 0xfff0c8, root: 55.0 },
  { name: "COBALT", wall: 0x2f8bff, deep: 0x05132e, accent: 0x59f0ff, edge: 0xdff6ff, root: 61.7 },
  { name: "VENOM", wall: 0x56ff8a, deep: 0x05220f, accent: 0xd8ff3a, edge: 0xf2ffd0, root: 49.0 },
  { name: "VIOLET", wall: 0xb23cff, deep: 0x1a0530, accent: 0xff4fd8, edge: 0xf6d9ff, root: 65.4 },
  { name: "GOLD", wall: 0xffb400, deep: 0x2a1200, accent: 0xfff27a, edge: 0xfffbe0, root: 58.3 },
  { name: "VOID", wall: 0xffffff, deep: 0x0a0a12, accent: 0xff2d55, edge: 0x9df0ff, root: 51.9 },
];

/**
 * One obstacle plane.
 *
 * Every dynamic (spin, iris, wobble) is a function of the plane's REMAINING
 * DISTANCE rather than of elapsed time, so its state at the instant it reaches
 * the ship is exactly `center` / `half` no matter how the speed changed during
 * its flight. That one decision is what makes the gaps honest and lets the
 * attract pilot aim at a gap four seconds before it arrives.
 */
interface Plane {
  live: boolean;
  z: number;
  prevZ: number;
  center: number;
  half: number;
  spin: number;
  shrink: number;
  wob: number;
  wobK: number;
  depth: number;
  gate: boolean;
  /** Which edge the attract pilot shaves, and how close. */
  bias: number;
  aim: number;
}

type Phase = "attract" | "playing" | "dead";

class Redline implements GameInstance {
  private readonly c: GameContext;

  // --- three.js
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private post!: PostStack;
  private hud!: Overlay;
  private tunnelMat!: THREE.ShaderMaterial;
  private tunnel!: THREE.Mesh;
  private obstacles!: InstancePool;
  private streaks!: InstancePool;
  private parts!: Particles;
  private shipRoot!: THREE.Group;
  private shipMesh!: THREE.Mesh;
  private shipHalo!: THREE.Sprite;
  private vanish!: THREE.Sprite;
  private glowTex!: THREE.Texture;
  private ringTex!: THREE.Texture;
  private ready = false;

  private waves: Array<{
    sprite: THREE.Sprite;
    mat: THREE.SpriteMaterial;
    life: number;
    maxLife: number;
    from: number;
    to: number;
  }> = [];

  // --- hoisted scratch. Nothing in the frame loop may allocate.
  private cWall = new THREE.Color();
  private cDeep = new THREE.Color();
  private cAccent = new THREE.Color();
  private cEdge = new THREE.Color();
  private cTmpA = new THREE.Color();
  private cTmpB = new THREE.Color();
  private cTmpC = new THREE.Color();
  private palScratch = new THREE.Color();
  private flashCol = new THREE.Color(0, 0, 0);
  private baseWall = new THREE.Color();
  private baseDeep = new THREE.Color();
  private baseAccent = new THREE.Color();
  private baseEdge = new THREE.Color();
  private fromWall = new THREE.Color();
  private fromDeep = new THREE.Color();
  private fromAccent = new THREE.Color();
  private fromEdge = new THREE.Color();
  private rotT = { x: 0, y: 0, z: 0 };
  private sclT = { x: 1, y: 1, z: 1 };

  // --- timing
  private warp = new TimeWarp();
  private shake = new Shake();
  private tReal = 0;
  private runT = 0;
  private w = 0;
  private h = 0;

  // --- run state
  private phase: Phase = "attract";
  private pa = 0;
  private omega = 0;
  private camRoll = 0;
  private v = 155;
  private rampT = 0;
  private travelled = 0;

  private score = 0;
  private best = 0;
  private chain = 0;
  private chainTimer = 0;
  private chainBest = 0;
  private boost = 0;
  private redline = false;
  private shields = 3;
  private sector = 0;
  private sectorIndex = 0;
  private nextGate = FIRST_GATE;
  private gatePending = false;
  private grace = 0;
  private stunned = 0;
  private threadCooldown = 0;
  private lastArrival = 0;
  private spawnTimer = 0;
  private newBest = false;

  // --- presentation
  private fov = 96;
  private fovKick = 0;
  private desat = 0;
  private scanSpike = 0;
  private palMix = 1;
  private scorePunch = 0;
  private chainPunch = 0;
  private threadT = 0;
  private threadChainShown = 0;
  private bannerT = 0;
  private banner = "";
  private pbT = 0;
  private breakT = 0;
  private deadT = 0;
  private kickPulse = 0;
  private tickAcc = 0;
  private attractSectorT = 0;
  private anchorX = 0;
  private hudAccent = "#ffb03a";
  private hudEdge = "#fff0c8";
  private hudWall = "#ff2d3f";

  // --- audio
  private musicBpm = 0;
  private musicOn = false;
  private musicCheck = 0;

  // --- pools
  private planes: Plane[] = [];
  private sAng = new Float32Array(STREAKS);
  private sRad = new Float32Array(STREAKS);
  private sZ = new Float32Array(STREAKS);
  private sBright = new Float32Array(STREAKS);

  private reportAcc = 0;

  constructor(ctx: GameContext) {
    this.c = ctx;
    this.best = ctx.store.get<number>("best", 0);
    for (let i = 0; i < MAX_PLANES; i++) {
      this.planes.push({
        live: false,
        z: 0,
        prevZ: 0,
        center: 0,
        half: 1,
        spin: 0,
        shrink: 0,
        wob: 0,
        wobK: 0,
        depth: 1.9,
        gate: false,
        bias: 1,
        aim: 0.1,
      });
    }
    this.initThree();
    this.enterAttract();
    ctx.report({ status: "idle", score: 0, best: this.best, label: "REDLINE" });
  }

  // --- setup ----------------------------------------------------------------

  private initThree() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.c.canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(this.c.dpr);
    this.renderer.setSize(this.c.width, this.c.height, false);
    this.renderer.setClearColor(0x01020a, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.fov, 1, 0.1, 520);
    this.camera.position.set(0, 0, CAM_Z);

    this.glowTex = glowTexture(128, 2.1);
    this.ringTex = ringTexture(256, 0.07);

    // The tunnel is one draw call: scrolling ribs and rungs whose falloff
    // exponent collapses as uSpeed rises, so the rungs physically smear into
    // streaks under acceleration.
    const tubeGeo = new THREE.CylinderGeometry(TUNNEL_R, TUNNEL_R, 460, 48, 1, true);
    tubeGeo.rotateX(HALF_PI);
    this.tunnelMat = new THREE.ShaderMaterial({
      uniforms: {
        uWall: { value: new THREE.Color(1, 1, 1) },
        uDeep: { value: new THREE.Color(0, 0, 0) },
        uScroll: { value: 0 },
        uSpeed: { value: 0 },
      },
      side: THREE.BackSide,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying float vDepth;
        void main() {
          vUv = uv;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uWall;
        uniform vec3 uDeep;
        uniform float uScroll;
        uniform float uSpeed;
        varying vec2 vUv;
        varying float vDepth;
        void main() {
          float rib = 1.0 - abs(fract(vUv.x * 32.0) - 0.5) * 2.0;
          rib = pow(max(rib, 0.0), 11.0);
          float rp = fract(vUv.y * 55.0 - uScroll);
          float rung = 1.0 - abs(rp - 0.5) * 2.0;
          rung = pow(max(rung, 0.0), mix(28.0, 2.6, uSpeed));
          float fade = exp(-max(vDepth, 0.0) * 0.009);
          vec3 col = uDeep * 0.55;
          col += uWall * rib * (0.30 + 0.55 * uSpeed);
          col += uWall * rung * (0.85 + 1.60 * uSpeed);
          col += uWall * rib * rung * 1.5;
          gl_FragColor = vec4(col * fade, 1.0);
        }
      `,
    });
    this.tunnel = new THREE.Mesh(tubeGeo, this.tunnelMat);
    this.tunnel.position.z = -180;
    this.tunnel.frustumCulled = false;
    this.scene.add(this.tunnel);

    // Every obstacle archetype is this one box pool, scaled and rotated.
    this.obstacles = new InstancePool(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial(),
      MAX_OBSTACLE_BOXES,
    );
    this.scene.add(this.obstacles.mesh);

    this.streaks = new InstancePool(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial(),
      STREAKS,
    );
    this.scene.add(this.streaks.mesh);
    for (let i = 0; i < STREAKS; i++) {
      this.sAng[i] = this.c.rng.next() * TAU;
      this.sRad[i] = this.c.rng.range(10.6, 13.0);
      this.sZ[i] = this.c.rng.range(SPAWN_Z, RECYCLE_Z);
      this.sBright[i] = this.c.rng.range(0.35, 1.3);
    }

    this.parts = new Particles(MAX_PARTICLES, this.glowTex);
    this.scene.add(this.parts.object);

    const shipGeo = new THREE.ConeGeometry(0.62, 2.2, 4);
    shipGeo.rotateX(-HALF_PI);
    this.shipMesh = new THREE.Mesh(
      shipGeo,
      new THREE.MeshBasicMaterial({ color: hdr(0xffffff, 3.6) }),
    );
    this.shipRoot = new THREE.Group();
    this.shipRoot.add(this.shipMesh);
    this.shipHalo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.glowTex,
        color: hdr(0xffffff, 2.4),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
    );
    this.shipHalo.scale.setScalar(5.2);
    this.shipRoot.add(this.shipHalo);
    this.scene.add(this.shipRoot);

    // The far end of the tube. The eye needs one bright thing to fixate on
    // while the walls scream past, so this never leaves the frame.
    this.vanish = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.glowTex,
        color: hdr(0xffffff, 1.6),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
    );
    this.vanish.position.set(0, 0, SPAWN_Z + 40);
    this.vanish.scale.setScalar(70);
    this.scene.add(this.vanish);

    for (let i = 0; i < MAX_WAVES; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.ringTex,
        color: new THREE.Color(1, 1, 1),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      this.scene.add(sprite);
      this.waves.push({ sprite, mat, life: 0, maxLife: 1, from: 1, to: 1 });
    }

    this.post = makePost(this.renderer, this.scene, this.camera, {
      strength: 1.15,
      radius: 0.72,
      threshold: 0.7,
    });
    this.hud = new Overlay();

    this.applyPalette(0, true);
    this.ready = true;
  }

  // --- palette --------------------------------------------------------------

  private applyPalette(index: number, instant: boolean) {
    const p = PALETTES[index % PALETTES.length];
    this.fromWall.copy(this.baseWall);
    this.fromDeep.copy(this.baseDeep);
    this.fromAccent.copy(this.baseAccent);
    this.fromEdge.copy(this.baseEdge);
    if (instant) {
      this.baseWall.setHex(p.wall, THREE.SRGBColorSpace);
      this.baseDeep.setHex(p.deep, THREE.SRGBColorSpace);
      this.baseAccent.setHex(p.accent, THREE.SRGBColorSpace);
      this.baseEdge.setHex(p.edge, THREE.SRGBColorSpace);
      this.palMix = 1;
    } else {
      this.palMix = 0;
    }
    this.hudAccent = `#${p.accent.toString(16).padStart(6, "0")}`;
    this.hudEdge = `#${p.edge.toString(16).padStart(6, "0")}`;
    this.hudWall = `#${p.wall.toString(16).padStart(6, "0")}`;
  }

  private get pal(): Palette {
    return PALETTES[this.sector % PALETTES.length];
  }

  private stepPalette(dt: number) {
    if (this.palMix >= 1) return;
    this.palMix = clamp01(this.palMix + dt / 0.9);
    const t = this.palMix;
    const p = this.pal;
    this.baseWall.lerpColors(this.fromWall, this.palScratch.setHex(p.wall, THREE.SRGBColorSpace), t);
    this.baseDeep.lerpColors(this.fromDeep, this.palScratch.setHex(p.deep, THREE.SRGBColorSpace), t);
    this.baseAccent.lerpColors(this.fromAccent, this.palScratch.setHex(p.accent, THREE.SRGBColorSpace), t);
    this.baseEdge.lerpColors(this.fromEdge, this.palScratch.setHex(p.edge, THREE.SRGBColorSpace), t);
  }

  // --- run lifecycle --------------------------------------------------------

  private enterAttract() {
    this.phase = "attract";
    this.runT = 0;
    this.rampT = 34;
    this.v = 155;
    this.pa = 0;
    this.omega = 0;
    this.camRoll = 0;
    this.score = 0;
    this.chain = 14;
    this.chainBest = 14;
    this.chainTimer = 2.0;
    this.boost = 1;
    this.redline = true;
    this.shields = 3;
    this.sector = 0;
    this.sectorIndex = 0;
    this.attractSectorT = 0;
    this.nextGate = Number.POSITIVE_INFINITY;
    this.gatePending = false;
    this.grace = 0;
    this.stunned = 0;
    this.newBest = false;
    this.deadT = 0;
    this.fov = 96;
    this.applyPalette(0, true);
    this.seedField();
  }

  private beginRun() {
    this.phase = "playing";
    this.runT = 0;
    this.rampT = 0;
    this.score = 0;
    this.chain = 0;
    this.chainBest = 0;
    this.chainTimer = 0;
    this.boost = 0;
    this.redline = false;
    this.shields = 3;
    this.sector = 0;
    this.sectorIndex = 0;
    this.nextGate = FIRST_GATE;
    this.gatePending = false;
    this.grace = 1.6;
    this.stunned = 0;
    this.newBest = false;
    this.deadT = 0;
    this.threadCooldown = 0;
    this.threadT = 0;
    this.breakT = 0;
    this.pbT = 0;
    this.musicCheck = 0;
    this.applyPalette(0, true);

    // The title letters blow apart into the scene. No fade, no reload — the
    // run continues from the exact camera state the attract left behind.
    this.flash(1.1, 1.1, 1.1);
    this.parts.burst(220, 0, -SHIP_R * 0.45, CAM_Z - 7, 26, {
      life: 0.75,
      size: 1.5,
      endSize: 0,
      color: this.cTmpA.setRGB(3, 3, 3),
      endColor: this.cTmpB.copy(this.baseAccent).multiplyScalar(2.4),
      drag: 0.25,
    });
    this.shake.add(0.42);
    this.c.audio.powerUp(0.26);
    this.c.report({ status: "playing", score: 0, best: this.best });
  }

  /** Fill the whole tube so no frame is ever an empty corridor. */
  private seedField() {
    for (const p of this.planes) p.live = false;
    this.lastArrival = this.pa;
    let z = -24;
    while (z > SPAWN_Z) {
      const gap = this.c.rng.range(30, 52);
      this.spawnPlane(z, false, gap / Math.max(60, this.v));
      z -= gap;
    }
    this.spawnTimer = 0.3;
  }

  restart() {
    this.warp.reset();
    this.parts.clear();
    for (const wv of this.waves) {
      wv.life = 0;
      wv.sprite.visible = false;
    }
    this.pa = 0;
    this.omega = 0;
    this.camRoll = 0;
    this.v = 120;
    this.desat = 0;
    this.scanSpike = 0;
    this.seedField();
    this.beginRun();
  }

  // --- spawning -------------------------------------------------------------

  private free(): Plane | null {
    for (const p of this.planes) if (!p.live) return p;
    return null;
  }

  private get omegaMax() {
    return lerp(3.4, 5.0, clamp01((this.v - V_BASE) / 150));
  }

  private get spawnInterval() {
    // The attract run is denser than minute zero on purpose — the title has to
    // look like a corridor, not like a tutorial.
    if (this.phase === "attract") return 0.34;
    return clamp(0.62 - this.runT * 0.00178, 0.3, 0.62);
  }

  /** Stored as a HALF width, so this is the design's 1.05 rad -> 0.58 rad. */
  private get gapHalf() {
    const tighter = this.sectorIndex >= 6 ? 0.06 : 0;
    return clamp(1.05 - this.runT * 0.00261 - tighter, 0.5, 1.05) * 0.5;
  }

  /**
   * `gapSeconds` is how long after the previous plane this one arrives, and it
   * is the entire fairness lever: the gap may only walk as far as the ship can
   * physically turn in that time, with 38% margin.
   */
  private spawnPlane(z: number, gate: boolean, gapSeconds: number) {
    const p = this.free();
    if (!p) return;
    const rng = this.c.rng;
    const reach = clamp(this.omegaMax * gapSeconds * 0.62, 0.05, 1.15);

    // Drift the chain toward where the pilot actually is, so a long random
    // walk can never strand them on the far side of the tube.
    const toPlayer = angleDelta(this.lastArrival, this.pa);
    this.lastArrival +=
      clamp(toPlayer, -reach * 0.45, reach * 0.45) + rng.spread(reach * 0.7);

    p.live = true;
    p.z = z;
    p.prevZ = z;
    p.center = this.lastArrival;
    p.gate = gate;
    p.bias = rng.sign();
    p.aim = rng.range(0.065, 0.26);
    p.spin = 0;
    p.shrink = 0;
    p.wob = 0;
    p.wobK = 0;
    p.depth = 1.9;

    if (gate) {
      p.half = 0.95;
      p.depth = 3.4;
      return;
    }

    p.half = this.gapHalf;
    // The vocabulary widens with the sector, so minute three is a different
    // set of shapes rather than faster copies of ring one.
    const kinds = 1 + Math.min(4, this.sectorIndex);
    switch (rng.int(0, kinds)) {
      case 1: // SPINNER — the gap sweeps around as it closes on you
        p.spin = rng.sign() * rng.range(0.004, 0.009);
        p.half *= 1.08;
        break;
      case 2: // IRIS — far wider on approach, arrives at exactly `half`
        p.shrink = rng.range(0.0011, 0.0019);
        p.half *= 0.94;
        break;
      case 3: // BARS — an oscillating shutter
        p.wob = rng.range(0.35, 0.62);
        p.wobK = rng.range(0.013, 0.022);
        break;
      case 4: // SHEAR — a long section you must hold a line through
        p.depth = rng.range(4.5, 8.0);
        p.spin = rng.sign() * rng.range(0.002, 0.005);
        p.half *= 1.12;
        break;
      default: // RING
        break;
    }
  }

  private centerAt(p: Plane, d: number) {
    return p.center + p.spin * d + (p.wob !== 0 ? p.wob * Math.sin(p.wobK * d) : 0);
  }

  private halfAt(p: Plane, d: number) {
    return p.half + p.shrink * d;
  }

  // --- update ---------------------------------------------------------------

  update(dtReal: number) {
    if (!this.ready) return;
    this.tReal += dtReal;

    const input = this.c.input;
    // Edge state must be read inside the fixed step or a catch-up frame eats
    // the press.
    const anyKey = input.anyPressed;
    const restartKey = input.wasPressed("KeyR");

    if (this.phase === "attract") {
      if (anyKey) this.beginRun();
    } else if (this.phase === "dead") {
      this.deadT += dtReal;
      if (anyKey && this.deadT > 0.5) this.restart();
    } else if (restartKey) {
      this.restart();
    }

    this.shake.update(dtReal);
    this.stepPresentation(dtReal);
    this.stepAudioState(dtReal);

    const dt = this.warp.step(dtReal);
    if (dt <= 0) return;

    this.stepPalette(dt);
    this.stepSpeed(dt);
    this.stepSteering(dt);
    this.stepPlanes(dt);
    this.stepStreaks(dt);
    this.stepChain(dt);
    this.stepWaves(dt);
    this.parts.update(dt);
    this.spawnTrail(dt);

    if (this.phase !== "dead") {
      const mult = (1 + this.chain * 0.06) * (this.redline ? 2 : 1);
      this.score += this.v * mult * dt;
      if (this.phase === "playing") {
        this.runT += dt;
        this.rampT += dt;
        if (this.best > 0 && !this.newBest && this.score > this.best) {
          this.celebrateBest();
        }
      }
    }

    if (this.phase === "attract") {
      this.attractSectorT += dt;
      if (this.attractSectorT > 6) {
        this.attractSectorT = 0;
        this.sector = (this.sector + 1) % PALETTES.length;
        this.sectorIndex++;
        this.applyPalette(this.sector, false);
        this.spawnWave(-90, 5, 130, 0.7, this.baseEdge, 3.2);
      }
    }

    this.pushReport(dtReal);
  }

  /** Everything that must keep breathing even during hit-stop. */
  private stepPresentation(dt: number) {
    this.scorePunch = Math.max(0, this.scorePunch - dt * 3.4);
    this.chainPunch = Math.max(0, this.chainPunch - dt * 3.0);
    this.fovKick = damp(this.fovKick, 0, 0.09, dt);
    this.threadT = Math.max(0, this.threadT - dt);
    this.bannerT = Math.max(0, this.bannerT - dt);
    this.pbT = Math.max(0, this.pbT - dt);
    this.breakT = Math.max(0, this.breakT - dt);
    this.scanSpike = Math.max(0, this.scanSpike - dt * 1.1);
    this.kickPulse = Math.max(0, this.kickPulse - dt * 5.5);
    this.threadCooldown = Math.max(0, this.threadCooldown - dt);
    this.grace = Math.max(0, this.grace - dt);
    this.stunned = Math.max(0, this.stunned - dt);
    this.flashCol.multiplyScalar(Math.exp(-dt * 13));

    const desatTarget = this.phase === "dead" ? 0.85 : this.threadT > 0 ? 0.55 : 0;
    this.desat = damp(this.desat, desatTarget, 0.16, dt);

    // Camera roll lags the player angle by ~0.15s, so a hard turn visibly
    // counter-rotates the whole tunnel. This is the game's visual identity.
    this.camRoll += angleDelta(this.camRoll, this.pa) * (1 - Math.pow(0.895, dt * 60));

    const sn = this.speedNorm;
    const fovTarget = lerp(74, 108, this.redline ? 1 : sn * 0.72) + this.fovKick;
    this.fov = damp(this.fov, fovTarget, 0.1, dt);
  }

  private stepSpeed(dt: number) {
    if (this.phase === "dead") {
      this.v = approach(this.v, 14, 90 * dt);
      this.travelled += this.v * dt;
      return;
    }
    const base = Math.min(V_CAP, V_BASE + V_RAMP * this.rampT);
    const target = base * (this.redline ? REDLINE_MUL : 1);
    // A crash leaves you stunned, so clawing the bend back into the screen
    // takes about ten seconds. That is the real punishment, not the shield.
    const accel = this.stunned > 0 ? 8 : 24;
    this.v =
      this.v < target
        ? approach(this.v, target, accel * dt)
        : approach(this.v, target, 70 * dt);
    this.travelled += this.v * dt;

    if (this.phase === "attract") {
      this.boost = 1;
      return;
    }
    if (this.redline) {
      this.boost -= 0.115 * dt;
      if (this.boost <= 0) {
        this.boost = 0;
        this.redline = false;
        this.c.audio.play({ wave: "sawtooth", freq: 300, freqTo: 90, glide: 0.3, vol: 0.15, attack: 0.004, hold: 0.06, release: 0.25, filter: 900, filterTo: 200 });
      }
    } else {
      this.boost = Math.max(0, this.boost - 0.035 * dt);
      if (this.boost >= 1) this.enterRedline();
    }
  }

  private stepSteering(dt: number) {
    if (this.phase === "attract") {
      this.attractPilot(dt);
    } else if (this.phase === "dead") {
      this.omega = damp(this.omega, 0, 0.06, dt);
    } else {
      const input = this.c.input;
      const p = input.pointer;
      const om = this.omegaMax;
      if (p.down) {
        // A virtual stick, not delta-based. The anchor creeps toward the
        // finger so a long drag never runs out of screen.
        if (p.justDown) this.anchorX = p.startX;
        else this.anchorX = damp(this.anchorX, p.x, 0.007, dt);
        const span = Math.max(60, this.w * 0.22);
        const t = clamp((p.x - this.anchorX) / span, -1, 1);
        this.omega = approach(this.omega, t * om, OMEGA_ACCEL * dt);
      } else {
        const axis =
          (input.isDown("KeyD", "ArrowRight") ? 1 : 0) -
          (input.isDown("KeyA", "ArrowLeft") ? 1 : 0);
        if (axis !== 0) {
          this.omega = clamp(this.omega + axis * OMEGA_ACCEL * dt, -om, om);
        } else {
          this.omega -= this.omega * Math.min(1, OMEGA_FRICTION * dt);
        }
      }
    }
    this.pa += this.omega * dt;
    if (this.pa > Math.PI) this.pa -= TAU;
    if (this.pa < -Math.PI) this.pa += TAU;
  }

  /** The attract pilot flies the real simulation, and it aims at gap EDGES. */
  private attractPilot(dt: number) {
    let target = this.pa;
    let bestD = Number.POSITIVE_INFINITY;
    for (const p of this.planes) {
      if (!p.live) continue;
      const d = -p.z;
      if (d < 10 || d > bestD) continue;
      bestD = d;
      target = p.center + p.bias * Math.max(0, p.half - p.aim);
    }
    const want = clamp(angleDelta(this.pa, target) * 3.4, -this.omegaMax, this.omegaMax);
    this.omega = damp(this.omega, want, 0.28, dt);
  }

  private stepPlanes(dt: number) {
    const move = this.v * dt;
    for (const p of this.planes) {
      if (!p.live) continue;
      p.prevZ = p.z;
      p.z += move;
      if (p.prevZ < 0 && p.z >= 0) this.crossPlane(p);
      if (p.z > RECYCLE_Z) p.live = false;
    }

    if (this.phase === "dead") return;

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer += this.spawnInterval;
      if (this.phase === "playing" && !this.gatePending && this.runT >= this.nextGate) {
        this.gatePending = true;
        this.nextGate += GATE_EVERY;
        this.spawnPlane(SPAWN_Z, true, this.spawnInterval);
      } else {
        // Clusters are the density escalation: a single ring at 0:00 becomes
        // a three-beat flick by 3:00.
        const cluster = 1 + Math.min(2, Math.floor(this.runT / 68));
        const gapDist = Math.max(10, this.v * 0.085);
        for (let i = 0; i < cluster; i++) {
          this.spawnPlane(
            SPAWN_Z - i * gapDist,
            false,
            i === 0 ? this.spawnInterval : gapDist / Math.max(60, this.v),
          );
        }
      }
    }

    // Sparks on the nearest gap edges drag the eye to the aiming point before
    // the shape is consciously read.
    let sparked = 0;
    for (const p of this.planes) {
      if (!p.live || sparked >= 4) continue;
      const d = -p.z;
      if (d < 6 || d > 150) continue;
      sparked++;
      const c = this.centerAt(p, d);
      const hw = this.halfAt(p, d);
      for (let s = -1; s <= 1; s += 2) {
        const a = c + s * hw;
        this.parts.spawn({
          x: Math.sin(a) * SHIP_R,
          y: -Math.cos(a) * SHIP_R,
          z: p.z,
          vx: this.c.rng.spread(1.5),
          vy: this.c.rng.spread(1.5),
          vz: this.v * 0.5,
          life: 0.3,
          size: 0.85,
          endSize: 0,
          color: this.cTmpA.copy(this.baseEdge).multiplyScalar(4.2),
          drag: 0.5,
        });
      }
    }
  }

  private spawnTrail(dt: number) {
    const sx = Math.sin(this.pa) * SHIP_R;
    const sy = -Math.cos(this.pa) * SHIP_R;
    const tangential = this.omega * SHIP_R * 0.5;
    // Five per step: at 250 u/s a spark only lives 0.07s inside the camera's
    // frustum, so the ribbon needs the density to read as a continuous streak.
    for (let i = 0; i < 5; i++) {
      this.parts.spawn({
        x: sx + this.c.rng.spread(0.32),
        y: sy + this.c.rng.spread(0.32),
        z: -1 + this.v * dt * (i / 5),
        vx: -Math.cos(this.pa) * tangential,
        vy: -Math.sin(this.pa) * tangential,
        vz: this.v * 0.98,
        life: 0.45,
        size: 0.7,
        endSize: 0,
        color: this.cTmpA.copy(this.baseEdge).multiplyScalar(3.4),
        endColor: this.cTmpB.copy(this.baseWall).multiplyScalar(1.6),
        drag: 0.9,
      });
    }
  }

  private stepStreaks(dt: number) {
    const move = this.v * 1.35 * dt;
    for (let i = 0; i < STREAKS; i++) {
      this.sZ[i] += move;
      if (this.sZ[i] > RECYCLE_Z) {
        this.sZ[i] = SPAWN_Z - this.c.rng.next() * 40;
        this.sAng[i] = this.c.rng.next() * TAU;
        this.sRad[i] = this.c.rng.range(10.6, 13.0);
      }
    }
  }

  private get chainWindow() {
    return Math.max(1.2, 2.4 - 0.02 * this.chain);
  }

  private stepChain(dt: number) {
    if (this.chain <= 0) return;
    this.chainTimer -= dt;
    if (this.chainTimer <= 0) {
      this.breakChain();
      return;
    }
    if (this.chainTimer / this.chainWindow < 0.25) {
      this.tickAcc += dt;
      if (this.tickAcc > 0.25) {
        this.tickAcc = 0;
        this.c.audio.play({ wave: "square", freq: 1200, vol: 0.09, attack: 0.001, hold: 0.004, release: 0.02 });
      }
    }
  }

  private breakChain() {
    this.chain = 0;
    this.chainTimer = 0;
    this.breakT = 0.5;
    this.flash(0.35, 0.04, 0.06);
    this.c.audio.fail(0.2);
    this.c.audio.play({ wave: "sawtooth", freq: 140, freqTo: 60, glide: 0.3, vol: 0.14, attack: 0.004, hold: 0.08, release: 0.3, filter: 700, filterTo: 180 });
    this.c.audio.play({ wave: "sawtooth", freq: 147, freqTo: 63, glide: 0.3, vol: 0.14, attack: 0.004, hold: 0.08, release: 0.3, filter: 700, filterTo: 180 });
  }

  private stepWaves(dt: number) {
    for (const wv of this.waves) {
      if (wv.life <= 0) continue;
      wv.life -= dt;
      if (wv.life <= 0) {
        wv.sprite.visible = false;
        continue;
      }
      const t = 1 - wv.life / wv.maxLife;
      wv.sprite.scale.setScalar(lerp(wv.from, wv.to, t * t * (3 - 2 * t)));
      wv.sprite.position.z += this.v * dt;
      wv.mat.opacity = 1 - t;
    }
  }

  private spawnWave(
    z: number,
    from: number,
    to: number,
    life: number,
    color: THREE.Color,
    gain: number,
  ) {
    for (const wv of this.waves) {
      if (wv.life > 0) continue;
      wv.life = life;
      wv.maxLife = life;
      wv.from = from;
      wv.to = to;
      wv.sprite.visible = true;
      wv.sprite.position.set(0, 0, z);
      wv.sprite.scale.setScalar(from);
      wv.mat.color.copy(color).multiplyScalar(gain);
      wv.mat.opacity = 1;
      return;
    }
  }

  // --- the moment of truth --------------------------------------------------

  private crossPlane(p: Plane) {
    if (this.phase === "dead") return;
    const delta = angleDelta(p.center, this.pa);
    const clearance = p.half - Math.abs(delta);
    // Increasing tunnel angle is screen-right, so this pans the air rip to
    // the ear you passed on.
    const side = clamp(delta * 4, -1, 1);

    if (p.gate) {
      this.passGate(clearance);
      return;
    }
    if (clearance < FORGIVE) {
      if (this.phase === "attract" || this.grace > 0) {
        this.nearMiss(0.14, side);
        return;
      }
      this.crash();
      return;
    }
    if (clearance < NEAR_WINDOW) this.nearMiss(clearance, side);
  }

  private nearMiss(clearance: number, side: number) {
    const closeness = clamp01(1 - clearance / NEAR_WINDOW);
    const thread =
      clearance < THREAD_WINDOW &&
      this.redline &&
      this.chain >= 8 &&
      this.threadCooldown <= 0 &&
      this.phase !== "dead";

    this.chain += thread ? 3 : 1;
    this.chainBest = Math.max(this.chainBest, this.chain);
    this.chainTimer = this.chainWindow;
    this.chainPunch = 1;
    this.scorePunch = Math.max(this.scorePunch, 0.6);
    this.boost = clamp01(this.boost + 0.09 + this.chain * 0.0025);

    this.warp.hitStop(thread ? 0.06 : 0.05);
    this.shake.add(thread ? 0.35 : 0.12 + closeness * 0.2);

    this.parts.burst(26, Math.sin(this.pa) * SHIP_R, -Math.cos(this.pa) * SHIP_R, 0, 9, {
      life: 0.36,
      size: 0.9,
      endSize: 0,
      color: this.cTmpA.copy(this.baseEdge).multiplyScalar(4.0),
      endColor: this.cTmpB.copy(this.baseAccent).multiplyScalar(2.0),
      drag: 0.35,
    });

    // The chain is literally audible: a rising chromatic scale that resets
    // every two octaves, so you can hear how deep you are.
    const f = transpose(520, this.chain % 24);
    this.c.audio.play({ wave: "square", freq: f, vol: 0.13, attack: 0.001, hold: 0.02, release: 0.06, pan: side });
    this.c.audio.play({ wave: "noise", freq: 900, freqTo: 2600, vol: 0.1, attack: 0.01, hold: 0.02, release: 0.1, filter: 1200, filterTo: 3400, filterType: "bandpass", q: 3, pan: side });

    if (thread) this.doThread();
  }

  private doThread() {
    this.threadCooldown = THREAD_COOLDOWN;
    this.threadT = 0.85;
    this.threadChainShown = this.chain;
    this.warp.slowMo(0.55, 0.28);
    this.fovKick = 14;
    this.score += 250 * this.chain;
    this.scorePunch = 1;
    this.flash(0.5, 0.5, 0.5);
    this.spawnWave(-4, 4, 200, 0.55, this.cTmpA.setRGB(1, 1, 1), 3.4);
    this.parts.burst(90, Math.sin(this.pa) * SHIP_R, -Math.cos(this.pa) * SHIP_R, 0, 16, {
      life: 0.7,
      size: 1.3,
      endSize: 0,
      color: this.cTmpB.setRGB(3.2, 3.2, 3.2),
      endColor: this.cTmpC.copy(this.baseAccent).multiplyScalar(2.6),
      drag: 0.4,
    });
    this.c.audio.chord([
      { wave: "sine", freq: 880, vol: 0.2, attack: 0.004, hold: 0.1, release: 0.6 },
      { wave: "sine", freq: 1320, vol: 0.16, attack: 0.004, hold: 0.1, release: 0.6 },
      { wave: "sine", freq: 1760, vol: 0.12, attack: 0.004, hold: 0.1, release: 0.6 },
    ]);
    this.c.audio.play({ wave: "noise", freq: 1200, freqTo: 200, vol: 0.16, attack: 0.01, hold: 0.14, release: 0.4, filter: 3200, filterTo: 300 });
  }

  private enterRedline() {
    this.redline = true;
    this.boost = 1;
    this.fovKick = 10;
    this.flash(0.28, 0.24, 0.34);
    this.shake.add(0.3);
    this.spawnWave(-10, 6, 160, 0.6, this.baseAccent, 3.0);
    this.c.audio.powerUp(0.22);
    this.banner = "REDLINE";
    this.bannerT = 1.2;
  }

  private passGate(clearance: number) {
    this.gatePending = false;
    this.sector = (this.sector + 1) % PALETTES.length;
    this.sectorIndex++;
    this.applyPalette(this.sector, false);
    this.shields = Math.min(5, this.shields + 1);
    // Guaranteed slow-mo: every player feels the effect inside 30 seconds
    // regardless of skill.
    this.warp.slowMo(0.7, 0.22);
    this.warp.hitStop(0.05);
    this.fovKick = 12;
    this.shake.add(0.3);
    this.flash(0.3, 0.3, 0.34);
    this.spawnWave(-2, 6, 220, 0.75, this.baseAccent, 3.4);
    this.parts.burst(120, 0, 0, -2, 30, {
      life: 0.85,
      size: 1.2,
      endSize: 0,
      color: this.cTmpA.copy(this.baseAccent).multiplyScalar(3.2),
      endColor: this.cTmpB.copy(this.baseWall).multiplyScalar(1.4),
      drag: 0.5,
    });
    this.c.audio.powerUp(0.24);
    this.banner = `SECTOR ${this.sectorIndex + 1} · ${this.pal.name}`;
    this.bannerT = 2.0;
    if (clearance < NEAR_WINDOW) this.nearMiss(Math.max(clearance, FORGIVE + 0.02), 0);
    this.restartMusic();
  }

  private crash() {
    this.shields--;
    this.chain = 0;
    this.chainTimer = 0;
    this.boost = 0;
    this.redline = false;
    this.v *= 0.45;
    this.rampT = Math.max(0, this.rampT - 12);
    this.stunned = 9;
    this.grace = 0.9;
    this.scanSpike = 0.22;
    this.warp.hitStop(0.14);
    this.warp.slowMo(0.4, 0.15);
    this.shake.add(0.95);
    this.flash(0.6, 0.08, 0.1);
    this.fovKick = -10;
    this.breakT = 0;
    this.spawnWave(-2, 4, 140, 0.5, this.cTmpA.setRGB(1, 0.2, 0.25), 3.2);
    this.parts.burst(180, Math.sin(this.pa) * SHIP_R, -Math.cos(this.pa) * SHIP_R, 0, 26, {
      life: 0.95,
      size: 1.4,
      endSize: 0,
      color: this.cTmpB.setRGB(3.4, 1.4, 0.6),
      endColor: this.cTmpC.setRGB(0.9, 0.1, 0.1),
      drag: 0.4,
    });
    this.c.audio.explode(0.34);
    this.c.audio.hit(0.26);
    if (this.shields <= 0) this.die();
  }

  private die() {
    this.phase = "dead";
    this.deadT = 0;
    this.warp.slowMo(0.9, 0.18);
    this.shake.add(0.6);
    const final = Math.floor(this.score);
    if (final > this.best) {
      this.best = final;
      this.newBest = true;
      this.c.store.set("best", final);
    }
    this.c.audio.stopMusic();
    this.musicOn = false;
    this.c.audio.fail(0.3);
    this.c.report({ status: "over", score: final, best: this.best });
  }

  private celebrateBest() {
    this.newBest = true;
    this.pbT = 2.4;
    this.flash(0.55, 0.45, 0.12);
    this.shake.add(0.4);
    this.warp.hitStop(0.08);
    this.spawnWave(-6, 6, 210, 0.8, this.cTmpA.setRGB(1, 0.78, 0.2), 3.6);
    this.parts.burst(160, 0, 0, -4, 34, {
      life: 1.0,
      size: 1.4,
      endSize: 0,
      color: this.cTmpB.setRGB(3.4, 2.6, 0.8),
      endColor: this.cTmpC.setRGB(1.2, 0.5, 0.05),
      drag: 0.5,
    });
    this.c.audio.powerUp(0.3);
  }

  private flash(r: number, g: number, b: number) {
    this.flashCol.setRGB(
      Math.max(this.flashCol.r, r),
      Math.max(this.flashCol.g, g),
      Math.max(this.flashCol.b, b),
    );
  }

  // --- audio ----------------------------------------------------------------

  private get speedNorm() {
    return clamp01((this.v - V_BASE) / (V_CAP * REDLINE_MUL - V_BASE));
  }

  private stepAudioState(dt: number) {
    this.musicCheck -= dt;
    if (this.musicCheck > 0) return;
    this.musicCheck = 0.5;
    if (!this.c.audio.ready || this.phase === "dead") return;
    const want = Math.round(lerp(124, 170, this.speedNorm) / 6) * 6;
    if (!this.musicOn || Math.abs(want - this.musicBpm) >= 6) {
      this.musicBpm = want;
      this.restartMusic();
    }
  }

  private restartMusic() {
    if (!this.c.audio.ready || this.phase === "dead") return;
    if (this.musicBpm <= 0) this.musicBpm = 124;
    this.musicOn = true;
    this.c.audio.startMusic((step) => this.musicStep(step), this.musicBpm, 4);
  }

  private musicStep(step: number) {
    const a = this.c.audio;
    const s = step % 16;
    const root = this.pal.root;
    const sn = this.speedNorm;

    if (s % 4 === 0) {
      a.play({ wave: "sine", freq: 130, freqTo: 38, glide: 0.09, vol: 0.32, attack: 0.002, hold: 0.03, release: 0.16 });
      this.kickPulse = 1;
    }
    if (sn > 0.25 && s % 2 === 1) {
      a.play({ wave: "noise", freq: 4200, vol: 0.05 + sn * 0.05, attack: 0.001, hold: 0.004, release: 0.03, filter: 6000, filterType: "highpass" });
    }
    if (s % 2 === 0) {
      // Engine drone: the root climbs and its lowpass opens as you accelerate.
      a.play({
        wave: "sawtooth",
        freq: lerp(root * 0.78, root * 2.1, sn),
        vol: 0.09,
        attack: 0.01,
        hold: 0.1,
        release: 0.1,
        filter: lerp(220, 2820, sn),
        q: 4,
      });
      const bass = [0, 0, 7, 0, 5, 0, 10, 3];
      a.play({ wave: "square", freq: transpose(root * 2, bass[(s / 2) % 8]), vol: 0.11, attack: 0.003, hold: 0.05, release: 0.1, filter: 900 });
    }
    if (this.redline) {
      // A whole extra voice that only exists while redlined.
      const arp = [0, 7, 12, 16, 19, 16, 12, 7];
      a.play({ wave: "square", freq: transpose(root * 8, arp[s % 8]), vol: 0.075, attack: 0.002, hold: 0.02, release: 0.07, filter: 5200 });
    }
  }

  private pushReport(dt: number) {
    this.reportAcc -= dt;
    if (this.reportAcc > 0) return;
    this.reportAcc = 0.25;
    this.c.report({
      score: Math.floor(this.score),
      best: this.best,
      status:
        this.phase === "dead" ? "over" : this.phase === "attract" ? "idle" : "playing",
      label: `SECTOR ${this.sectorIndex + 1} · x${this.chain}`,
    });
  }

  // --- draw -----------------------------------------------------------------

  draw() {
    if (!this.ready) return;
    const sn = this.speedNorm;

    this.cWall.copy(this.baseWall).multiplyScalar(2.0);
    this.cDeep.copy(this.baseDeep);
    this.cAccent.copy(this.baseAccent).multiplyScalar(3.0);
    this.cEdge.copy(this.baseEdge).multiplyScalar(4.2);

    this.tunnelMat.uniforms.uWall.value.copy(this.cWall);
    this.tunnelMat.uniforms.uDeep.value.copy(this.cDeep);
    this.tunnelMat.uniforms.uScroll.value = this.travelled / 8;
    this.tunnelMat.uniforms.uSpeed.value = sn;

    this.writeObstacles();
    this.writeStreaks(sn);

    const sx = Math.sin(this.pa) * SHIP_R;
    const sy = -Math.cos(this.pa) * SHIP_R;
    this.shipRoot.position.set(sx, sy, 0);
    this.shipRoot.rotation.z = this.pa;
    this.shipMesh.rotation.z = -this.omega * 0.1;
    this.shipMesh.visible = this.phase !== "dead";
    this.shipHalo.scale.setScalar(4.4 + sn * 2.6 + this.chainPunch * 2.4);
    (this.shipHalo.material as THREE.SpriteMaterial).color
      .copy(this.baseEdge)
      .multiplyScalar(1.7 + this.chainPunch * 1.8);

    // The vanishing point pulses on the kick, so the anchor breathes with the
    // music instead of sitting there.
    this.vanish.scale.setScalar(62 + this.kickPulse * 26 + sn * 22);
    (this.vanish.material as THREE.SpriteMaterial).color
      .copy(this.baseAccent)
      .multiplyScalar(1.2 + this.kickPulse * 0.9);

    const off = 2.0;
    this.camera.position.set(
      Math.sin(this.camRoll) * off,
      -Math.cos(this.camRoll) * off,
      CAM_Z,
    );
    this.camera.rotation.set(0, 0, this.camRoll);
    if (Math.abs(this.camera.fov - this.fov) > 0.02) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    this.shake.apply(this.camera, 1.5);

    const u = this.post.grade.uniforms;
    u.amount.value = lerp(0.0016, 0.016, sn) + this.chainPunch * 0.005 + this.threadT * 0.02;
    u.warp.value = lerp(0.02, 0.26, sn) + this.threadT * 0.05;
    u.vignette.value = lerp(0.85, 1.15, this.redline ? 1 : sn);
    u.desat.value = this.desat;
    u.scan.value = 0.04 + this.scanSpike;
    u.time.value = this.tReal;
    u.flash.value.copy(this.flashCol);
    this.post.bloom.strength =
      lerp(0.9, 1.75, sn) + (this.redline ? 0.5 : 0) + this.threadT * 0.4;

    this.post.composer.render();

    if (this.w >= 2 && this.h >= 2) {
      this.drawHud(sn);
      this.hud.commit(this.renderer);
    }
  }

  private writeObstacles() {
    const pool = this.obstacles;
    pool.begin();
    const rc = (OBST_R_OUT + OBST_R_IN) * 0.5;
    const chord = 2 * OBST_R_OUT * Math.sin(Math.PI / SEGMENTS) * 1.06;
    this.sclT.x = OBST_R_OUT - OBST_R_IN;
    this.sclT.y = chord;
    for (const p of this.planes) {
      if (!p.live) continue;
      const d = Math.max(0, -p.z);
      const c = this.centerAt(p, d);
      const hw = this.halfAt(p, d);
      const fade = clamp(1.05 - d / 430, 0.3, 1);
      const gain = p.gate ? 1.5 : 1;
      this.sclT.z = p.depth;
      for (let s = 0; s < SEGMENTS; s++) {
        const a = (s + 0.5) * SEG_STEP;
        const off = Math.abs(angleDelta(c, a));
        if (off < hw) continue;
        // The two segments flanking the gap are the brightest things in the
        // frame, so the aiming point reads before the shape does.
        const isEdge = off - hw < SEG_STEP * 1.15;
        this.cTmpA
          .copy(isEdge ? this.cEdge : p.gate ? this.cAccent : this.cWall)
          .multiplyScalar(fade * gain);
        this.rotT.z = a - HALF_PI;
        pool.write(
          Math.sin(a) * rc,
          -Math.cos(a) * rc,
          p.z,
          this.sclT,
          this.cTmpA,
          this.rotT,
        );
      }
    }
    pool.end();
  }

  private writeStreaks(sn: number) {
    const pool = this.streaks;
    pool.begin();
    // Rods physically elongate with velocity. Biggest payoff per line here.
    const len = clamp(this.v * 0.06, 4, 13) * (this.redline ? 1.9 : 1);
    this.sclT.x = 0.15;
    this.sclT.y = 0.15;
    this.sclT.z = len;
    this.rotT.z = 0;
    for (let i = 0; i < STREAKS; i++) {
      const z = this.sZ[i];
      const fade = clamp(1.1 - Math.max(0, -z) / 400, 0.06, 1) * this.sBright[i];
      this.cTmpA
        .copy(this.sBright[i] > 1.05 ? this.cEdge : this.cWall)
        .multiplyScalar(fade * (0.5 + sn));
      pool.write(
        Math.sin(this.sAng[i]) * this.sRad[i],
        -Math.cos(this.sAng[i]) * this.sRad[i],
        z,
        this.sclT,
        this.cTmpA,
      );
    }
    pool.end();
  }

  // --- HUD ------------------------------------------------------------------

  private drawHud(sn: number) {
    const g = this.hud.begin();
    const w = this.w;
    const h = this.h;
    const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";
    const top = 64;

    // SCORE. Hero string one of three, so it gets a shadow blur.
    const scoreSize = Math.min(h * 0.085, w * 0.125) * (1 + this.scorePunch * 0.16);
    g.textAlign = "left";
    g.font = `700 ${scoreSize}px ${mono}`;
    g.fillStyle = "#ffffff";
    g.shadowColor = this.hudEdge;
    g.shadowBlur = 18 + this.scorePunch * 24;
    g.fillText(fmt(Math.floor(this.score)), 22, top + scoreSize * 0.85);
    g.shadowBlur = 0;

    const line2 = top + scoreSize * 1.16;
    g.font = `600 ${Math.max(10, h * 0.018)}px ${mono}`;
    g.fillStyle = "rgba(255,255,255,0.45)";
    g.fillText(`BEST ${fmt(this.best)}`, 23, line2);

    const spSize = Math.min(h * 0.05, w * 0.07);
    g.font = `700 ${spSize}px ${mono}`;
    g.fillStyle = this.hudAccent;
    g.fillText(`${Math.round(this.v)}`, 22, line2 + spSize * 1.05);
    g.font = `600 ${Math.max(9, h * 0.016)}px ${mono}`;
    g.fillStyle = "rgba(255,255,255,0.4)";
    g.fillText("U/S", 26 + spSize * 1.85, line2 + spSize * 1.05);

    // Sector + shields, top right, clear of the shell's mute button.
    g.textAlign = "right";
    g.font = `600 ${Math.max(10, h * 0.019)}px ${mono}`;
    g.fillStyle = "rgba(255,255,255,0.6)";
    g.fillText(`SECTOR ${this.sectorIndex + 1} · ${this.pal.name}`, w - 22, top);
    const cw = 14;
    for (let i = 0; i < 5; i++) {
      const x = w - 22 - i * (cw + 6) - cw;
      g.fillStyle = i < this.shields ? this.hudAccent : "rgba(255,255,255,0.14)";
      g.beginPath();
      g.moveTo(x + cw * 0.5, top + 12);
      g.lineTo(x + cw, top + 26);
      g.lineTo(x + cw * 0.5, top + 22);
      g.lineTo(x, top + 26);
      g.closePath();
      g.fill();
    }

    this.drawChain(g, w, h, mono);
    this.drawBoost(g, w, h, mono);

    g.textAlign = "center";
    if (this.threadT > 0) {
      const a = clamp01(this.threadT / 0.85);
      const size = Math.min(h * 0.16, w * 0.15) * (0.86 + a * 0.22);
      g.globalAlpha = Math.min(1, a * 1.7);
      g.font = `800 ${size}px ${mono}`;
      g.fillStyle = "#ffffff";
      g.shadowColor = "#ffffff";
      g.shadowBlur = 30;
      g.fillText("THREADED", w * 0.5, h * 0.4);
      g.shadowBlur = 0;
      g.font = `800 ${size * 0.46}px ${mono}`;
      g.fillStyle = this.hudAccent;
      g.fillText(`+3   x${this.threadChainShown}`, w * 0.5, h * 0.4 + size * 0.55);
      g.globalAlpha = 1;
    }
    if (this.pbT > 0) {
      g.globalAlpha = clamp01(this.pbT / 2.4);
      g.font = `800 ${Math.min(h * 0.075, w * 0.08)}px ${mono}`;
      g.fillStyle = Math.sin(this.tReal * 16) > 0 ? "#ffd45a" : "#fff6d0";
      g.fillText("NEW RECORD", w * 0.5, h * 0.24);
      g.globalAlpha = 1;
    }
    if (this.bannerT > 0 && this.threadT <= 0) {
      g.globalAlpha = clamp01(this.bannerT / 0.7);
      g.font = `800 ${Math.min(h * 0.055, w * 0.055)}px ${mono}`;
      g.fillStyle = this.hudEdge;
      g.fillText(this.banner, w * 0.5, h * 0.19);
      g.globalAlpha = 1;
    }
    if (this.breakT > 0) {
      g.globalAlpha = clamp01(this.breakT / 0.5);
      g.font = `800 ${Math.min(h * 0.05, w * 0.06)}px ${mono}`;
      g.fillStyle = "#ff3344";
      g.fillText("CHAIN LOST", w * 0.5, h * 0.32);
      g.globalAlpha = 1;
    }

    if (this.phase === "attract") this.drawTitle(g, w, h, mono, sn);
    if (this.phase === "dead") this.drawDeath(g, w, h, mono);
  }

  private drawChain(g: CanvasRenderingContext2D, w: number, h: number, mono: string) {
    if (this.chain <= 0) return;
    const size = Math.min(h * 0.15, w * 0.19) * (1 + this.chainPunch * 0.22);
    const cx = w - Math.min(w * 0.17, 118);
    const cy = h - Math.min(h * 0.19, 128);
    const frac = clamp01(this.chainTimer / this.chainWindow);
    const low = frac < 0.25;
    const strobe = low && Math.sin(this.tReal * 26) > 0;

    let color = "#ffffff";
    if (this.chain >= 30) color = Math.sin(this.tReal * 30) > 0 ? "#ffffff" : this.hudEdge;
    else if (this.chain >= 16) color = "#ffd45a";
    else if (this.chain >= 8) color = this.hudAccent;
    if (strobe) color = "#ff3344";

    // The countdown ring is the whole point: coasting visibly drains it.
    const r = size * 0.66;
    g.lineWidth = Math.max(4, size * 0.05);
    g.strokeStyle = "rgba(255,255,255,0.1)";
    g.beginPath();
    g.arc(cx, cy, r, 0, TAU);
    g.stroke();
    g.strokeStyle = low ? "#ff3344" : color;
    g.beginPath();
    g.arc(cx, cy, r, -HALF_PI, -HALF_PI + TAU * frac);
    g.stroke();

    g.textAlign = "center";
    g.font = `800 ${size}px ${mono}`;
    g.fillStyle = color;
    g.shadowColor = color;
    g.shadowBlur = 16 + this.chainPunch * 28;
    g.fillText(`x${this.chain}`, cx, cy + size * 0.34);
    g.shadowBlur = 0;
    g.font = `600 ${Math.max(9, h * 0.015)}px ${mono}`;
    g.fillStyle = "rgba(255,255,255,0.42)";
    g.fillText("CHAIN", cx, cy + r + h * 0.032);
  }

  private drawBoost(g: CanvasRenderingContext2D, w: number, h: number, mono: string) {
    const bw = Math.min(w * 0.42, 460);
    const bh = Math.max(10, h * 0.017);
    const x = (w - bw) * 0.5;
    const y = h - bh - 30;
    g.fillStyle = "rgba(0,0,0,0.5)";
    roundRectPath(g, x - 2, y - 2, bw + 4, bh + 4, 4);
    g.fill();
    const lit = this.redline;
    g.fillStyle = lit
      ? Math.sin(this.tReal * 22) > 0
        ? "#ffffff"
        : this.hudAccent
      : this.hudWall;
    roundRectPath(g, x, y, Math.max(2, bw * clamp01(this.boost)), bh, 3);
    g.fill();
    g.textAlign = "center";
    g.font = `700 ${Math.max(10, h * 0.019)}px ${mono}`;
    g.fillStyle = lit ? "#ffffff" : "rgba(255,255,255,0.5)";
    g.fillText(lit ? "R E D L I N E" : "BOOST", w * 0.5, y - 9);
  }

  private drawTitle(
    g: CanvasRenderingContext2D,
    w: number,
    h: number,
    mono: string,
    sn: number,
  ) {
    const size = Math.min(h * 0.17, w * 0.185);
    const y = h * 0.44;
    g.textAlign = "center";
    g.font = `800 ${size}px ${mono}`;
    // Cheap RGB split: three offset fills under `lighter`.
    const j = 3 + Math.sin(this.tReal * 7) * 2 + sn * 4;
    g.globalCompositeOperation = "lighter";
    g.fillStyle = "#ff1030";
    g.fillText("REDLINE", w * 0.5 - j, y);
    g.fillStyle = "#10ff80";
    g.fillText("REDLINE", w * 0.5, y);
    g.fillStyle = "#2060ff";
    g.fillText("REDLINE", w * 0.5 + j, y);
    g.globalCompositeOperation = "source-over";
    g.fillStyle = "rgba(255,255,255,0.94)";
    g.fillText("REDLINE", w * 0.5, y);

    g.font = `600 ${Math.max(11, h * 0.02)}px ${mono}`;
    g.fillStyle = "rgba(255,255,255,0.62)";
    g.fillText(
      this.c.isTouch ? "DRAG TO ROTATE — SHAVE THE EDGES" : "A / D TO ROTATE — SHAVE THE EDGES",
      w * 0.5,
      y + size * 0.62,
    );

    if (Math.sin(this.tReal * 5) > -0.35) {
      g.font = `700 ${Math.max(12, h * 0.026)}px ${mono}`;
      g.fillStyle = this.hudEdge;
      g.fillText(this.c.isTouch ? "TAP TO FLY" : "PRESS ANY KEY", w * 0.5, h * 0.83);
    }
  }

  private drawDeath(g: CanvasRenderingContext2D, w: number, h: number, mono: string) {
    const a = clamp01(this.deadT / 0.4);
    g.fillStyle = `rgba(4,2,6,${0.6 * a})`;
    g.fillRect(0, 0, w, h);
    g.textAlign = "center";
    g.font = `800 ${Math.min(h * 0.085, w * 0.1)}px ${mono}`;
    g.fillStyle = "#ff3344";
    g.shadowColor = "#ff2233";
    g.shadowBlur = 26;
    g.fillText("SIGNAL LOST", w * 0.5, h * 0.33);
    g.shadowBlur = 0;

    g.font = `800 ${Math.min(h * 0.11, w * 0.16)}px ${mono}`;
    g.fillStyle = "#ffffff";
    g.fillText(fmt(Math.floor(this.score)), w * 0.5, h * 0.5);

    g.font = `700 ${Math.max(11, h * 0.023)}px ${mono}`;
    if (this.newBest) {
      g.fillStyle = Math.sin(this.tReal * 12) > 0 ? "#ffd45a" : "#fff6d0";
      g.fillText("NEW PERSONAL BEST", w * 0.5, h * 0.58);
    } else {
      g.fillStyle = "rgba(255,255,255,0.55)";
      g.fillText(`BEST ${fmt(this.best)}`, w * 0.5, h * 0.58);
    }
    g.fillStyle = "rgba(255,255,255,0.68)";
    g.fillText(
      `PEAK CHAIN x${this.chainBest}   SECTOR ${this.sectorIndex + 1}`,
      w * 0.5,
      h * 0.64,
    );

    if (this.deadT > 0.5 && Math.sin(this.tReal * 6) > -0.3) {
      g.fillStyle = this.hudEdge;
      g.fillText(
        this.c.isTouch ? "TAP TO RUN AGAIN" : "ANY KEY TO RUN AGAIN",
        w * 0.5,
        h * 0.78,
      );
    }
  }

  // --- shell hooks ----------------------------------------------------------

  resize(width: number, height: number) {
    if (!this.ready || width < 2 || height < 2) return;
    this.w = width;
    this.h = height;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.post.setSize(width, height);
    this.hud.resize(width, height, this.c.dpr);
    this.parts.setViewport(height * this.c.dpr);
  }

  destroy() {
    this.c.audio.stopMusic();
    this.obstacles.dispose();
    this.streaks.dispose();
    this.parts.dispose();
    this.hud.dispose();
    this.post.dispose();
    this.tunnel.geometry.dispose();
    this.tunnelMat.dispose();
    this.shipMesh.geometry.dispose();
    (this.shipMesh.material as THREE.Material).dispose();
    (this.shipHalo.material as THREE.Material).dispose();
    (this.vanish.material as THREE.Material).dispose();
    for (const wv of this.waves) wv.mat.dispose();
    this.glowTex.dispose();
    this.ringTex.dispose();
    this.renderer.dispose();
  }
}

const fmt = (n: number) => n.toLocaleString("en-US");

const factory: GameFactory = (ctx: GameContext) => new Redline(ctx);
export default factory;
