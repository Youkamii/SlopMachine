/**
 * SWINGSHOT
 *
 * A grapple momentum runner through a neon canyon. You are a body in free
 * fall; hold the button and a rope snaps to the beacon the reticle is already
 * showing you, the rope reels itself in so every arc tightens, and then you
 * let go. Release just past the bottom of the arc and you get a PERFECT: a
 * hit-stop, a cyan flash, a shockwave, a pip of quarter-speed, and a forward
 * impulse that stacks on the speed you already had.
 *
 * The whole audiovisual system exists to tell you WHEN to let go: the rope
 * goes white-hot in the window, the tension ratchet climbs in pitch into it,
 * and a gauge around your body sweeps a needle into a green wedge. The skill
 * is one binary decision under time pressure, ten times in a row, while the
 * corridor narrows around you.
 *
 * There is no title screen. It boots into a live autopiloted run and any
 * press hands you the controls mid-flight at the bot's exact velocity.
 */

import type { PostStack } from "@/engine/gl/post";
import { glowTexture, hdr, makePost, ringTexture } from "@/engine/gl/post";
import { InstancePool, Particles } from "@/engine/gl/pool";
import { Overlay, glowText, roundRectPath } from "@/engine/gl/overlay";
import { Shake, TimeWarp } from "@/engine/gl/shake";
import { HALF_PI, TAU, clamp, clamp01, damp, lerp, remap } from "@/engine/math";
import type { GameContext, GameFactory, GameInstance } from "@/games/types";
import * as THREE from "three";

// --- tuning -----------------------------------------------------------------

const RAMP_SECONDS = 180;

const GRAV = 42;
const DIVE_GRAV = 1.7;
const FLARE_DRAG = 2.4;
/** Drag is quadratic so speed self-limits near the cap without feeling sticky low down. */
const DRAG_K = 0.055;
const DRAG_K2 = 0.0012;
const LATERAL_ACC = 26;
const ASSIST_ACC = 2.5;
const VZ_CAP = 150;
const BODY_R = 1.6;

const ROPE_MIN = 14;
const ROPE_MAX = 46;
const REEL_RATE = 9;
const HOLD_MAX = 3.6;

/** Release window, in seconds either side of the bottom of the arc. */
const WIN_EARLY = 0.12;
const WIN_LATE = 0.3;
const WHIFF_COOLDOWN = 0.45;

const NEARMISS_SPEED = 52;
const NEARMISS_COOLDOWN = 1.8;
const NEARMISS_OUTER = 4.5;

const STREAM_AHEAD = 480;
const STREAM_BEHIND = 130;

const TOWER_MAX = 300;
const WINDOW_MAX = 920;
const ANCHOR_MAX = 150;
const RING_MAX = 48;
const HAZARD_MAX = 16;
const LINE_MAX = 240;
const SHOCK_MAX = 20;
const POPUP_MAX = 14;

const MILESTONES = [5, 10, 15, 20, 25, 30];
const MILESTONE_WORDS = [
  "SMOOTH",
  "HOT",
  "BLAZING",
  "UNREAL",
  "GODSPEED",
  "SWINGSHOT",
];

const ARP = [0, 7, 3, 10, 0, 5, 3, 7];

type Phase = "attract" | "play" | "crash" | "over";

interface Popup {
  x: number;
  y: number;
  z: number;
  life: number;
  max: number;
  text: string;
  size: number;
  color: string;
}

const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);

class Swingshot implements GameInstance {
  private readonly c: GameContext;

  // --- rendering
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private post!: PostStack;
  private hud!: Overlay;
  private particles!: Particles;
  private shake = new Shake();
  private warp = new TimeWarp();

  private towerPool!: InstancePool;
  private crownPool!: InstancePool;
  private windowPool!: InstancePool;
  private anchorPool!: InstancePool;
  private ringPool!: InstancePool;
  private hazardPool!: InstancePool;
  private linePool!: InstancePool;
  private shockPool!: InstancePool;

  private body!: THREE.Mesh;
  private rope!: THREE.Mesh;
  private ropeHalo!: THREE.Mesh;
  private reticle!: THREE.Mesh;
  private ground!: THREE.Mesh;
  private sky!: THREE.Mesh;
  private groundMat!: THREE.ShaderMaterial;
  private skyMat!: THREE.ShaderMaterial;
  private glowTex!: THREE.CanvasTexture;
  private ringTex!: THREE.CanvasTexture;

  // hoisted scratch — nothing allocates in the frame loop
  private tmpC = new THREE.Color();
  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private flashC = new THREE.Color(0, 0, 0);
  private fogC = new THREE.Color();
  private pal: THREE.Color[] = [];
  private palDim: THREE.Color[] = [];

  // --- world (structure of arrays, swap-removed, zero allocation after boot)
  private tx = new Float32Array(TOWER_MAX);
  private tz = new Float32Array(TOWER_MAX);
  private tw = new Float32Array(TOWER_MAX);
  private td = new Float32Array(TOWER_MAX);
  private th = new Float32Array(TOWER_MAX);
  private tshade = new Float32Array(TOWER_MAX);
  private tflash = new Float32Array(TOWER_MAX);
  private thue = new Uint8Array(TOWER_MAX);
  private tpillar = new Uint8Array(TOWER_MAX);
  private tCount = 0;

  private ax = new Float32Array(ANCHOR_MAX);
  private ay = new Float32Array(ANCHOR_MAX);
  private az = new Float32Array(ANCHOR_MAX);
  private aphase = new Float32Array(ANCHOR_MAX);
  private aCount = 0;

  private rx = new Float32Array(RING_MAX);
  private ry = new Float32Array(RING_MAX);
  private rz = new Float32Array(RING_MAX);
  private rspin = new Float32Array(RING_MAX);
  private rtaken = new Uint8Array(RING_MAX);
  private rCount = 0;

  private hzz = new Float32Array(HAZARD_MAX);
  private hang = new Float32Array(HAZARD_MAX);
  private hspin = new Float32Array(HAZARD_MAX);
  private hlen = new Float32Array(HAZARD_MAX);
  private hCount = 0;

  private slAng = new Float32Array(LINE_MAX);
  private slRad = new Float32Array(LINE_MAX);
  private slZ = new Float32Array(LINE_MAX);

  private skx = new Float32Array(SHOCK_MAX);
  private sky_ = new Float32Array(SHOCK_MAX);
  private skz = new Float32Array(SHOCK_MAX);
  private sklife = new Float32Array(SHOCK_MAX);
  private skmax = new Float32Array(SHOCK_MAX);
  private skdur = new Float32Array(SHOCK_MAX);
  private skhue = new Uint8Array(SHOCK_MAX);
  private skCount = 0;

  private popups: Popup[] = [];

  private spawnZ = 0;
  private gapIndex = 0;

  // --- player
  private px = 0;
  private py = 46;
  private pz = 0;
  private vx = 0;
  private vy = 0;
  private vz = 44;
  private spin = 0;

  private attached = false;
  private anchorX = 0;
  private anchorY = 0;
  private anchorZ = 0;
  private ropeL = 30;
  private holdT = 0;
  private armed = false;
  private prevAng = -1;
  private angRate = 0;
  private tau = 1;
  private omega = 0;
  private swingSpeed = 0;
  private ratchet = 0;
  private fireCd = 0;
  private target = -1;
  private heldNow = false;
  private heldPrev = false;
  private botBias = 0;

  // --- run state
  private phase: Phase = "attract";
  private t = 0;
  private realT = 0;
  private ramp = 0;
  private halfW = 44;
  private score = 0;
  private scoreShown = 0;
  private best = 0;
  private chain = 0;
  private chainT = 0;
  private lives = 3;
  private bonusLives = 0;
  private crashT = 0;
  /** The tumble in progress belongs to the attract bot, not to a real run. */
  private demoCrash = false;
  private nearCd = 0;
  private beatBest = false;
  private bestCelebrate = 0;

  private chainPunch = 0;
  private speedPunch = 0;
  private scorePunch = 0;
  private bannerT = 0;
  private bannerText = "";
  private bannerColor = "#fff";
  private desatBoost = 0;
  private amountSpike = 0;
  private warpSpike = 0;
  private bloomSpike = 0;
  private shatter = 0;

  private fov = 62;
  private camX = 0;
  private camY = 52;
  private roll = 0;
  private reportAcc = 0;
  private musicBpm = 0;

  private w = 960;
  private h = 540;
  private hudK = 1;
  private ready = false;

  constructor(ctx: GameContext) {
    this.c = ctx;
    this.best = ctx.store.best("best") ?? 0;
    for (let i = 0; i < POPUP_MAX; i++) {
      this.popups.push({
        x: 0,
        y: 0,
        z: 0,
        life: 0,
        max: 1,
        text: "",
        size: 40,
        color: "#fff",
      });
    }
    this.initGL();
    this.reset(true);
    this.resize(ctx.width || 960, ctx.height || 540);
    this.ready = true;
    // Boot straight into a live run: simulate ~2s of autopilot so the very
    // first rendered frame is already mid-swing at speed, with a populated
    // trail and a chain going. Then keep stepping until the rope is actually
    // out — frame one must show a taut glowing line, not a body falling.
    for (let i = 0; i < 120; i++) this.step(1 / 60);
    for (let i = 0; i < 90 && !this.attached; i++) this.step(1 / 60);
    ctx.report({ status: "playing", score: 0, best: this.best });
  }

  // --- setup ----------------------------------------------------------------

  private initGL() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.c.canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(this.c.dpr);
    this.renderer.setSize(this.c.width || 960, this.c.height || 540, false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Under 1.0: this scene is almost entirely emissive, so a neutral exposure
    // clips the whole frame to white.
    this.renderer.toneMappingExposure = 0.78;
    this.renderer.setClearColor(0x07021a, 1);

    this.scene = new THREE.Scene();
    this.fogC.setHex(0x07021a);
    this.scene.fog = new THREE.Fog(this.fogC.getHex(), 60, 460);

    this.camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.5, 2400);
    this.scene.add(this.camera);

    this.glowTex = glowTexture(96, 2.2);
    this.ringTex = ringTexture(256, 0.1);

    const P = [
      hdr(0x22e0ff, 3.5),
      hdr(0xff2fb0, 3.2),
      hdr(0xffd24a, 3.4),
      hdr(0x8a4dff, 2.8),
      hdr(0xff5a1e, 3.0),
      hdr(0xff2d4a, 3.0),
      hdr(0xffffff, 4.0),
    ];
    this.pal = P;
    this.palDim = P.map((c) => c.clone().multiplyScalar(0.42));

    // --- instanced pools. Never vertexColors on an InstancedMesh.
    const basic = (opts?: THREE.MeshBasicMaterialParameters) =>
      new THREE.MeshBasicMaterial({ toneMapped: true, ...opts });

    this.towerPool = new InstancePool(
      new THREE.BoxGeometry(1, 1, 1),
      basic(),
      TOWER_MAX,
    );
    // Fog stays ON for everything architectural. Without it the far skyline
    // keeps emitting at full strength and the horizon fills in solid white.
    this.crownPool = new InstancePool(
      new THREE.BoxGeometry(1, 1, 1),
      basic(),
      TOWER_MAX,
    );
    this.windowPool = new InstancePool(
      new THREE.BoxGeometry(1, 1, 1),
      basic(),
      WINDOW_MAX,
    );
    this.anchorPool = new InstancePool(
      new THREE.OctahedronGeometry(1, 0),
      basic({ fog: false }),
      ANCHOR_MAX * 2 + 4,
    );
    this.ringPool = new InstancePool(
      new THREE.TorusGeometry(4.4, 0.34, 8, 26),
      basic(),
      RING_MAX,
    );
    this.hazardPool = new InstancePool(
      new THREE.BoxGeometry(1, 1, 1),
      basic(),
      HAZARD_MAX,
    );
    this.linePool = new InstancePool(
      new THREE.BoxGeometry(1, 1, 1),
      basic({
        fog: false,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
      LINE_MAX,
    );
    this.shockPool = new InstancePool(
      new THREE.TorusGeometry(1, 0.055, 6, 40),
      basic({
        fog: false,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
      SHOCK_MAX,
    );
    for (const p of [
      this.towerPool,
      this.crownPool,
      this.windowPool,
      this.anchorPool,
      this.ringPool,
      this.hazardPool,
      this.linePool,
      this.shockPool,
    ]) {
      this.scene.add(p.mesh);
    }

    // --- player, rope, reticle
    this.body = new THREE.Mesh(
      new THREE.OctahedronGeometry(1.15, 0),
      basic({ fog: false, color: this.pal[6] }),
    );
    this.body.scale.set(1, 1, 2.6);
    this.scene.add(this.body);

    this.rope = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 1, 7, 1),
      basic({ fog: false, color: this.pal[0] }),
    );
    this.ropeHalo = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 1, 7, 1),
      basic({
        fog: false,
        color: this.pal[0],
        transparent: true,
        opacity: 0.3,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.rope.visible = false;
    this.ropeHalo.visible = false;
    this.scene.add(this.rope, this.ropeHalo);

    this.reticle = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: this.ringTex,
        color: this.pal[0],
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
        fog: false,
        toneMapped: true,
      }),
    );
    this.reticle.renderOrder = 4;
    this.reticle.scale.setScalar(9);
    this.scene.add(this.reticle);

    // --- ground grid + sky dome. Custom shaders only on non-instanced meshes.
    this.groundMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uEye: { value: new THREE.Vector3() },
        uCol: { value: new THREE.Color(0.09, 0.3, 0.72) },
        uAmp: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vW;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vW = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uEye;
        uniform vec3 uCol;
        uniform float uAmp;
        varying vec3 vW;
        void main() {
          float sp = 26.0;
          float lx = pow(abs(sin(vW.x * 3.14159265 / sp)), 70.0);
          float lz = pow(abs(sin(vW.z * 3.14159265 / sp)), 70.0);
          float l = max(lx, lz);
          float wave = 0.5 + 0.5 * sin(vW.z * 0.022 - uTime * 3.2);
          float d = length(vW.xz - uEye.xz);
          float fade = exp(-d * 0.008);
          vec3 c = uCol * (l * (0.9 + wave * 1.2) + 0.010) * fade * uAmp;
          gl_FragColor = vec4(c, 1.0);
        }
      `,
      depthWrite: false,
    });
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(2600, 2600),
      this.groundMat,
    );
    this.ground.rotation.x = -HALF_PI;
    this.ground.renderOrder = -2;
    this.scene.add(this.ground);

    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: new THREE.Color(0.02, 0.01, 0.09) },
        uHorizon: { value: new THREE.Color(0.22, 0.05, 0.5) },
        uGlow: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vD;
        void main() {
          vD = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop;
        uniform vec3 uHorizon;
        uniform float uGlow;
        varying vec3 vD;
        void main() {
          float hgt = normalize(vD).y;
          vec3 c = mix(uHorizon * 0.55, uTop, clamp(hgt * 1.9, 0.0, 1.0));
          c = mix(c, uTop * 0.4, clamp(-hgt * 2.4, 0.0, 1.0));
          float band = exp(-abs(hgt) * 16.0);
          c += uHorizon * band * uGlow;
          gl_FragColor = vec4(c, 1.0);
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(900, 24, 16), this.skyMat);
    this.sky.renderOrder = -3;
    this.scene.add(this.sky);

    this.particles = new Particles(3000, this.glowTex);
    this.scene.add(this.particles.object);
    this.hud = new Overlay();

    // A low threshold makes every neon surface bloom and the frame goes white.
    // Only genuine highlights (crowns, rope, player, particles) should bleed.
    this.post = makePost(this.renderer, this.scene, this.camera, {
      strength: 0.7,
      radius: 0.62,
      threshold: 0.92,
    });
  }

  // --- lifecycle ------------------------------------------------------------

  private reset(attract: boolean) {
    this.phase = attract ? "attract" : "play";
    this.t = 0;
    this.score = 0;
    this.scoreShown = 0;
    this.chain = attract ? 2 : 0;
    this.chainT = this.chainWindow();
    this.lives = 3;
    this.bonusLives = 0;
    this.crashT = 0;
    this.demoCrash = false;
    this.nearCd = 0;
    this.beatBest = false;
    this.bestCelebrate = 0;
    this.bannerT = 0;
    this.shatter = 0;
    this.desatBoost = 0;
    this.amountSpike = 0;
    this.warpSpike = 0;
    this.bloomSpike = 0;
    this.chainPunch = 0;
    this.speedPunch = 0;
    this.scorePunch = 0;

    this.px = 0;
    this.py = 48;
    this.pz = 0;
    this.vx = 0;
    this.vy = -6;
    this.vz = 46;
    this.spin = 0;
    this.attached = false;
    this.fireCd = 0;
    this.target = -1;
    this.holdT = 0;
    this.heldNow = false;
    this.heldPrev = false;
    this.warp.reset();

    this.tCount = 0;
    this.aCount = 0;
    this.rCount = 0;
    this.hCount = 0;
    this.skCount = 0;
    for (const p of this.popups) p.life = 0;
    this.particles.clear();

    this.gapIndex = 0;
    this.spawnZ = -160;
    this.ramp = 0;
    this.halfW = this.corridor();
    while (this.spawnZ < this.pz + STREAM_AHEAD) this.emitGap();

    for (let i = 0; i < LINE_MAX; i++) {
      this.slAng[i] = this.c.rng.angle();
      this.slRad[i] = this.c.rng.range(24, 68);
      this.slZ[i] = this.pz + this.c.rng.range(-30, 150);
    }
  }

  restart() {
    this.reset(false);
    this.c.report({ status: "playing", score: 0, best: this.best });
  }

  destroy() {
    this.c.audio.stopMusic();
    for (const p of [
      this.towerPool,
      this.crownPool,
      this.windowPool,
      this.anchorPool,
      this.ringPool,
      this.hazardPool,
      this.linePool,
      this.shockPool,
    ]) {
      p.dispose();
    }
    this.particles.dispose();
    this.hud.dispose();
    this.post.dispose();
    this.body.geometry.dispose();
    (this.body.material as THREE.Material).dispose();
    this.rope.geometry.dispose();
    (this.rope.material as THREE.Material).dispose();
    this.ropeHalo.geometry.dispose();
    (this.ropeHalo.material as THREE.Material).dispose();
    this.reticle.geometry.dispose();
    (this.reticle.material as THREE.Material).dispose();
    this.ground.geometry.dispose();
    this.groundMat.dispose();
    this.sky.geometry.dispose();
    this.skyMat.dispose();
    this.glowTex.dispose();
    this.ringTex.dispose();
    this.renderer.dispose();
  }

  resize(width: number, height: number) {
    if (width < 2 || height < 2) return;
    this.w = width;
    this.h = height;
    this.hudK = clamp(Math.min(width, height) / 720, 0.58, 1.15);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.post.setSize(width, height);
    this.hud.resize(width, height, this.c.dpr);
    this.particles.setViewport(height * this.c.dpr);
  }

  // --- escalation -----------------------------------------------------------

  private corridor() {
    return lerp(44, 23, this.ramp) * (this.c.isTouch ? 1.15 : 1);
  }
  private chainWindow() {
    return lerp(5.0, 2.6, clamp01(this.chain / 15));
  }
  private get mult() {
    return 1 + this.chain * 0.25;
  }

  // --- world streaming ------------------------------------------------------

  private emitGap() {
    const r = this.c.rng;
    const z = this.spawnZ;
    const hue = (Math.floor(this.gapIndex / 8) % 4) as number;
    const hueIdx = [0, 1, 3, 2][hue];
    const half = this.halfW;
    const tall = lerp(96, 168, this.ramp);

    // Row 0 hugs the corridor so the invisible wall bound always has a visible
    // face on it; rows behind it build depth.
    for (let side = -1; side <= 1; side += 2) {
      for (let row = 0; row < 3; row++) {
        const w = r.range(14, 30);
        const d = r.range(14, 30);
        const out = row === 0 ? r.range(0.5, 2.5) : r.range(26, 42) * row;
        const x = side * (half + w * 0.5 + out);
        this.addTower(
          x,
          z + r.range(-18, 18),
          w,
          d,
          r.range(52, tall - row * 12),
          hueIdx,
          0,
        );
      }
    }

    // Pillars stand INSIDE the corridor: the crash risk and the near-miss maker.
    const pillars = lerp(0.35, 1.3, this.ramp);
    let n = Math.floor(pillars);
    if (r.next() < pillars - n) n++;
    for (let i = 0; i < n; i++) {
      const w = r.range(8, 15);
      this.addTower(
        r.range(-half * 0.72, half * 0.72),
        z + r.range(-14, 14),
        w,
        w * r.range(0.8, 1.3),
        r.range(52, 104),
        // Always hot orange: a pillar in the corridor must read as danger.
        4,
        1,
      );
    }

    // Anchors — always enough to keep the rope busy, thinning as it speeds up.
    const perGap = lerp(3.0, 1.6, this.ramp);
    let an = Math.floor(perGap);
    if (r.next() < perGap - an) an++;
    for (let i = 0; i < an; i++) {
      // The band is chosen so a grabbed anchor always sits inside the top half
      // of the frame — an off-screen target is an unfair target.
      this.addAnchor(
        r.range(-half * 0.78, half * 0.78),
        r.range(58, 82),
        z + r.range(-0.42, 0.42) * this.spacing(),
      );
    }

    this.addRing(r.range(-half * 0.5, half * 0.5), r.range(40, 62), z + this.spacing() * 0.5);

    if (this.t > 30 && this.hCount < HAZARD_MAX) {
      const interval = lerp(7.0, 2.0, this.ramp);
      if (r.next() < this.spacing() / Math.max(28, this.vz * interval)) {
        const i = this.hCount++;
        this.hzz[i] = z + r.range(-10, 10);
        this.hang[i] = r.angle();
        this.hspin[i] = r.range(0.5, 1.4) * r.sign();
        this.hlen[i] = half * 1.4;
      }
    }

    this.spawnZ += this.spacing();
    this.gapIndex++;
  }

  private spacing() {
    return lerp(78, 34, this.ramp);
  }

  private addTower(
    x: number,
    z: number,
    w: number,
    d: number,
    h: number,
    hue: number,
    pillar: number,
  ) {
    if (this.tCount >= TOWER_MAX) return;
    const i = this.tCount++;
    this.tx[i] = x;
    this.tz[i] = z;
    this.tw[i] = w;
    this.td[i] = d;
    this.th[i] = h;
    this.thue[i] = hue;
    this.tpillar[i] = pillar;
    this.tflash[i] = 0;
    this.tshade[i] = this.c.rng.range(0.1, 0.24);
  }

  private addAnchor(x: number, y: number, z: number) {
    if (this.aCount >= ANCHOR_MAX) return;
    const i = this.aCount++;
    this.ax[i] = x;
    this.ay[i] = y;
    this.az[i] = z;
    this.aphase[i] = this.c.rng.angle();
  }

  private addRing(x: number, y: number, z: number) {
    if (this.rCount >= RING_MAX) return;
    const i = this.rCount++;
    this.rx[i] = x;
    this.ry[i] = y;
    this.rz[i] = z;
    this.rspin[i] = this.c.rng.angle();
    this.rtaken[i] = 0;
  }

  private cull() {
    const back = this.pz - STREAM_BEHIND;
    for (let i = 0; i < this.tCount; ) {
      if (this.tz[i] < back) {
        const l = --this.tCount;
        this.tx[i] = this.tx[l];
        this.tz[i] = this.tz[l];
        this.tw[i] = this.tw[l];
        this.td[i] = this.td[l];
        this.th[i] = this.th[l];
        this.tshade[i] = this.tshade[l];
        this.tflash[i] = this.tflash[l];
        this.thue[i] = this.thue[l];
        this.tpillar[i] = this.tpillar[l];
      } else i++;
    }
    for (let i = 0; i < this.aCount; ) {
      if (this.az[i] < back) {
        const l = --this.aCount;
        this.ax[i] = this.ax[l];
        this.ay[i] = this.ay[l];
        this.az[i] = this.az[l];
        this.aphase[i] = this.aphase[l];
      } else i++;
    }
    for (let i = 0; i < this.rCount; ) {
      if (this.rz[i] < back) {
        const l = --this.rCount;
        this.rx[i] = this.rx[l];
        this.ry[i] = this.ry[l];
        this.rz[i] = this.rz[l];
        this.rspin[i] = this.rspin[l];
        this.rtaken[i] = this.rtaken[l];
      } else i++;
    }
    for (let i = 0; i < this.hCount; ) {
      if (this.hzz[i] < back) {
        const l = --this.hCount;
        this.hzz[i] = this.hzz[l];
        this.hang[i] = this.hang[l];
        this.hspin[i] = this.hspin[l];
        this.hlen[i] = this.hlen[l];
      } else i++;
    }
  }

  // --- update ---------------------------------------------------------------

  update(dt: number) {
    const input = this.c.input;
    // Level-based, so a hit-stop frame can never swallow a press.
    this.heldNow =
      input.isDown("Space") ||
      input.isDown("KeyJ") ||
      input.pointer.down;
    const anyPress = input.anyPressed || input.pointer.justDown;

    if ((this.phase === "attract" || this.demoCrash) && anyPress) {
      this.takeOver();
    } else if (
      this.phase === "over" &&
      (input.wasPressed("KeyR", "Space", "Enter") || input.pointer.justDown)
    ) {
      this.restart();
      return;
    }

    this.shake.update(dt);
    this.realT += dt;
    this.tickMusic();

    const d = this.warp.step(dt);
    if (this.warp.frozen) return;
    this.step(d);
  }

  private takeOver() {
    // If the bot is mid-tumble, clearing the flag hands the recovery to you
    // rather than snapping the camera somewhere new.
    if (this.phase === "attract") this.phase = "play";
    this.demoCrash = false;
    this.score = 0;
    this.scoreShown = 0;
    this.t = 0;
    this.lives = 3;
    this.bonusLives = 0;
    this.beatBest = false;
    this.banner("GO", "#22e0ff", 0.9);
    this.c.audio.play({
      wave: "sawtooth",
      freq: 180,
      freqTo: 900,
      glide: 0.22,
      vol: 0.24,
      attack: 0.004,
      hold: 0.06,
      release: 0.18,
      filter: 900,
      filterTo: 5000,
    });
  }

  /** One simulation step in game time (already scaled by TimeWarp). */
  private step(d: number) {
    const live = this.phase === "attract" || this.phase === "play";
    this.t += d;
    this.ramp = clamp01(this.t / RAMP_SECONDS);
    this.halfW = this.corridor();

    this.decay(d);
    if (this.phase === "crash") this.stepCrash(d);
    else if (this.phase === "over") this.stepOver(d);
    else this.stepFlight(d);

    // --- world bookkeeping
    this.cull();
    let guard = 0;
    while (this.spawnZ < this.pz + STREAM_AHEAD && guard++ < 40) this.emitGap();

    for (let i = 0; i < this.aCount; i++) this.aphase[i] += d * 2.4;
    for (let i = 0; i < this.rCount; i++) this.rspin[i] += d * 1.6;
    for (let i = 0; i < this.hCount; i++) this.hang[i] += this.hspin[i] * d;
    for (let i = 0; i < this.tCount; i++) {
      if (this.tflash[i] > 0) this.tflash[i] = Math.max(0, this.tflash[i] - d);
    }
    for (let i = 0; i < this.skCount; ) {
      this.sklife[i] -= d;
      if (this.sklife[i] <= 0) {
        const l = --this.skCount;
        this.skx[i] = this.skx[l];
        this.sky_[i] = this.sky_[l];
        this.skz[i] = this.skz[l];
        this.sklife[i] = this.sklife[l];
        this.skmax[i] = this.skmax[l];
        this.skdur[i] = this.skdur[l];
        this.skhue[i] = this.skhue[l];
      } else i++;
    }
    for (const p of this.popups) if (p.life > 0) p.life -= d;

    // Speed lines live in world space and recycle behind the camera.
    for (let i = 0; i < LINE_MAX; i++) {
      if (this.slZ[i] < this.pz - 34) {
        this.slZ[i] = this.pz + this.c.rng.range(90, 190);
        this.slAng[i] = this.c.rng.angle();
        // Minimum radius keeps streaks off the lens — a streak passing within
        // a couple of metres of the camera covers half the frame in white.
        this.slRad[i] = this.c.rng.range(24, 68);
      }
    }

    this.particles.update(d);

    // --- score plumbing
    if (live) {
      this.score += this.vz * d * this.mult * 1.1;
      if (this.chain > 0) {
        this.chainT -= d;
        if (this.chainT <= 0) this.breakChain(false);
      }
    }
    this.scoreShown = damp(this.scoreShown, this.score, 0.14, d);

    if (this.phase === "play") {
      const target = this.bonusLives === 0 ? 60000 : 150000;
      if (this.score > target && this.bonusLives < 2) {
        this.bonusLives++;
        this.lives = Math.min(3, this.lives + 1);
        this.banner("+1 LIFE", "#ffd24a", 1.2);
        this.c.audio.powerUp(0.22);
      }
      if (!this.beatBest && this.best > 500 && this.score > this.best) {
        this.beatBest = true;
        this.celebrateBest();
      }
    }

    this.reportAcc += d;
    if (this.reportAcc > 0.16) {
      this.reportAcc = 0;
      this.c.report({
        status: "playing",
        score: Math.floor(this.score),
        best: Math.max(this.best, Math.floor(this.score)),
        label:
          this.phase === "over"
            ? "WIPEOUT — PRESS R"
            : `${Math.round(this.vz * 3.6)} KM/H  ·  x${this.chain + 1}`,
      });
    }
  }

  private decay(d: number) {
    this.chainPunch = Math.max(0, this.chainPunch - d * 5.5);
    this.speedPunch = Math.max(0, this.speedPunch - d * 5.5);
    this.scorePunch = Math.max(0, this.scorePunch - d * 5.5);
    this.bannerT = Math.max(0, this.bannerT - d);
    this.shatter = Math.max(0, this.shatter - d);
    this.bestCelebrate = Math.max(0, this.bestCelebrate - d);
    this.desatBoost = Math.max(0, this.desatBoost - d * 1.6);
    this.amountSpike = Math.max(0, this.amountSpike - d * 0.06);
    this.warpSpike = Math.max(0, this.warpSpike - d * 0.35);
    this.bloomSpike = Math.max(0, this.bloomSpike - d * 3.2);
    this.nearCd = Math.max(0, this.nearCd - d);
    this.fireCd = Math.max(0, this.fireCd - d);
    this.flashC.multiplyScalar(Math.pow(0.008, d));
  }

  private stepOver(d: number) {
    // Never a still screen: the body keeps drifting so the city keeps streaming.
    this.vz = Math.max(20, this.vz - 6 * d);
    this.pz += this.vz * d;
    this.py = damp(this.py, 52, 0.03, d);
    this.px = damp(this.px, 0, 0.03, d);
    this.spin += d * 1.6;
    this.trail(d, 0.4);
  }

  private stepCrash(d: number) {
    this.crashT -= d;
    this.spin += d * 9;
    this.vy -= GRAV * 0.5 * d;
    this.px += this.vx * d;
    this.py += this.vy * d;
    this.pz += this.vz * d;
    this.py = Math.max(this.py, 8);
    this.trail(d, 1);
    if (this.crashT <= 0) {
      if (!this.demoCrash && this.lives <= 0) {
        this.phase = "over";
        this.recordBest();
      } else {
        // A demo wipeout must return to the attract loop, never to game over.
        this.phase = this.demoCrash ? "attract" : "play";
        this.px = 0;
        this.vx = 0;
        this.py = Math.max(this.py, 62);
        this.vy = 0;
        this.spin = 0;
        this.fireCd = 0.1;
      }
    }
  }

  private stepFlight(d: number) {
    const input = this.c.input;
    const bot = this.phase === "attract";

    let steer = 0;
    let dive = false;
    let flare = false;

    if (bot) {
      steer = this.botSteer();
    } else {
      if (input.isDown("KeyD", "ArrowRight")) steer += 1;
      if (input.isDown("KeyA", "ArrowLeft")) steer -= 1;
      if (steer === 0 && this.c.isTouch && input.pointer.down) {
        const off = input.pointer.x - input.pointer.startX;
        const dead = 12;
        if (Math.abs(off) > dead) {
          steer = clamp((off - Math.sign(off) * dead) / 90, -1, 1);
        }
      }
      dive = input.isDown("KeyS", "ArrowDown");
      flare = input.isDown("KeyW", "ArrowUp");
    }

    // Weak auto-centre so a panicking player does not wall themselves.
    if (steer === 0) {
      // One-thumb players get a weak auto-centre so letting go is survivable.
      if (this.c.isTouch && !bot) {
        this.vx -= clamp(this.px * 0.22, -7, 7) * d;
      }
      if (Math.abs(this.px) > this.halfW * 0.4) {
        this.vx -= Math.sign(this.px) * ASSIST_ACC * d;
      }
    }
    this.vx += steer * LATERAL_ACC * d;

    // --- grapple edges (level-derived, so nothing is lost to hit-stop)
    const held = bot ? this.botHold() : this.heldNow;
    if (held && !this.heldPrev && !this.attached && this.fireCd <= 0) this.fire();
    if (!held && this.heldPrev && this.attached) this.release();
    this.heldPrev = held;

    // --- integrate
    const g = GRAV * (dive ? DIVE_GRAV : 1);
    this.vy -= g * d;
    if (dive) this.vz += 9 * d;
    // A soft updraft near the floor keeps a bad run recoverable.
    if (this.py < 28) this.vy += (28 - this.py) * 0.9 * d;

    const k =
      (DRAG_K + Math.abs(this.vz) * DRAG_K2) * (flare ? FLARE_DRAG : 1);
    const f = Math.exp(-k * d);
    this.vx *= f;
    this.vy *= Math.pow(f, 0.35);
    this.vz *= f;

    const floor = lerp(26, 40, this.ramp);
    if (this.vz < floor) this.vz += (floor - this.vz) * 1.8 * d;
    if (this.vz > VZ_CAP) this.vz = VZ_CAP;

    this.px += this.vx * d;
    this.py += this.vy * d;
    this.pz += this.vz * d;

    if (this.attached) this.solveRope(d);
    else {
      this.tau = 1;
      this.omega = 0;
      this.armed = false;
    }

    this.pickTarget();
    this.trail(d, 1);
    this.collide(d);
    this.checkRings();

    if (this.py < 5 && this.phase !== "crash") this.crash("GROUND");
    if (Math.abs(this.px) > this.halfW + 3 && this.phase !== "crash") {
      this.crash("WALL");
    }
  }

  // --- grapple --------------------------------------------------------------

  private pickTarget() {
    let bi = -1;
    let bs = -1e9;
    for (let i = 0; i < this.aCount; i++) {
      const dz = this.az[i] - this.pz;
      if (dz < 9 || dz > 58) continue;
      const dy = this.ay[i] - this.py;
      if (dy < 6 || dy > 52) continue;
      const dx = this.ax[i] - this.px;
      if (Math.abs(dx) > 44) continue;
      const dist = Math.hypot(dx, dy, dz);
      // Never target further than the rope can reach — a clamped length would
      // yank the body through space on attach.
      if (dist < 16 || dist > ROPE_MAX) continue;
      const s =
        -Math.abs(dx) * 1.4 - Math.abs(dz - 28) * 0.6 - Math.abs(dy - 24) * 0.3;
      if (s > bs) {
        bs = s;
        bi = i;
      }
    }
    this.target = bi;
  }

  private fire() {
    if (this.target < 0) {
      this.fireCd = WHIFF_COOLDOWN;
      this.c.audio.play({
        wave: "noise",
        freq: 900,
        freqTo: 200,
        vol: 0.14,
        attack: 0.002,
        hold: 0.03,
        release: 0.14,
        filter: 1600,
        filterTo: 300,
      });
      this.popup("MISS", this.px, this.py + 4, this.pz, 34, "#ff2d4a", 0.5);
      return;
    }
    const i = this.target;
    this.anchorX = this.ax[i];
    this.anchorY = this.ay[i];
    this.anchorZ = this.az[i];
    const dx = this.px - this.anchorX;
    const dy = this.py - this.anchorY;
    const dz = this.pz - this.anchorZ;
    const dist = Math.hypot(dx, dy, dz) || 1e-4;
    this.attached = true;
    this.ropeL = clamp(dist, ROPE_MIN, ROPE_MAX);

    // THE SNAP. A real rope would throw away the whole radial component and
    // rob you of half your speed every grab. Instead the velocity is *rotated*
    // onto the tangent and its magnitude kept — grabbing redirects momentum,
    // it never punishes you for having it. This is the feel of the game.
    const nx = dx / dist;
    const ny = dy / dist;
    const nz = dz / dist;
    const vr = this.vx * nx + this.vy * ny + this.vz * nz;
    const tx = this.vx - nx * vr;
    const ty = this.vy - ny * vr;
    const tz = this.vz - nz * vr;
    const tl = Math.hypot(tx, ty, tz);
    if (tl > 0.01) {
      const s = (Math.hypot(this.vx, this.vy, this.vz) * 0.96) / tl;
      this.vx = tx * s;
      this.vy = ty * s;
      this.vz = tz * s;
    }

    this.holdT = 0;
    this.armed = false;
    this.prevAng = -1;
    this.angRate = 0;
    this.ratchet = 0;
    this.botBias = this.c.rng.range(-0.2, 0.05);
    this.c.audio.play({
      wave: "sawtooth",
      freq: 720,
      freqTo: 180,
      glide: 0.09,
      vol: 0.16,
      attack: 0.001,
      hold: 0.02,
      release: 0.1,
      filter: 2600,
      filterTo: 500,
    });
    this.c.audio.play({
      wave: "noise",
      freq: 2200,
      vol: 0.09,
      attack: 0.001,
      hold: 0.006,
      release: 0.04,
      filter: 3600,
      filterType: "highpass",
    });
  }

  /**
   * Position-based rigid-rod constraint plus reel-in: project the body back
   * onto the sphere every step and remove the radial velocity in BOTH
   * directions. A slack-capable rope would go limp on the approach — exactly
   * over the bottom of the arc, which is the one moment the timing gauge has
   * to mean something. Rigid keeps the pendulum honest at any speed and never
   * explodes, whatever the step size.
   */
  private solveRope(d: number) {
    this.holdT += d;

    const dx = this.px - this.anchorX;
    const dy = this.py - this.anchorY;
    const dz = this.pz - this.anchorZ;
    const dist = Math.hypot(dx, dy, dz) || 1e-4;
    const nx = dx / dist;
    const ny = dy / dist;
    const nz = dz / dist;

    this.px = this.anchorX + nx * this.ropeL;
    this.py = this.anchorY + ny * this.ropeL;
    this.pz = this.anchorZ + nz * this.ropeL;
    const vn = this.vx * nx + this.vy * ny + this.vz * nz;
    this.vx -= nx * vn;
    this.vy -= ny * vn;
    this.vz -= nz * vn;

    // --- swing phase: 0 rad at the bottom of the arc
    const ang = Math.atan2(Math.hypot(nx, nz), -ny);
    if (this.prevAng < 0) this.prevAng = ang;
    const raw = (this.prevAng - ang) / Math.max(1e-5, d);
    this.prevAng = ang;
    // Light smoothing only: heavy smoothing puts a dead frame right at the
    // sign flip, which is precisely where the player is aiming.
    this.angRate = this.angRate * 0.35 + raw * 0.65;

    this.swingSpeed = Math.hypot(this.vx, this.vy, this.vz);
    this.omega = Math.abs(this.angRate);

    if (ang > 0.22 && this.angRate > 0.25) this.armed = true;
    // ang/rate carries the sign for free: + is before the bottom, - is after.
    if (this.omega > 0.08) this.tau = clamp(ang / this.angRate, -1.2, 1.2);
    else this.tau = ang < 0.3 ? 0 : this.armed ? -1.2 : 1.2;

    // Reeling in while descending is why the arc visibly whips tighter.
    if (this.angRate > 0) {
      this.ropeL = Math.max(ROPE_MIN, this.ropeL - REEL_RATE * d);
    }

    // Tension ratchet: pitch climbs into the window.
    this.ratchet -= d;
    if (this.ratchet <= 0) {
      this.ratchet = 0.09;
      const win = this.inWindow();
      this.c.audio.play({
        wave: win ? "square" : "triangle",
        freq: 300 + this.swingSpeed * 6,
        vol: win ? 0.09 : 0.05,
        attack: 0.001,
        hold: 0.006,
        release: 0.03,
      });
    }

    // Hold past ~57 degrees up the far side and the rope slips. Without this a
    // rigid rod would carry you over the top and send vz negative, which reads
    // as the game breaking rather than as a mistake you made.
    const overswung = this.armed && this.angRate < -0.05 && ang > 1.0;
    if (overswung || this.holdT > HOLD_MAX || this.pz - this.anchorZ > 70) {
      this.release(true);
    }
  }

  private inWindow() {
    const s = this.c.isTouch ? 1.25 : 1;
    return this.armed && this.tau <= WIN_EARLY * s && this.tau >= -WIN_LATE * s;
  }

  /** `auto` is the rope timing out or being overshot — never a scoring release. */
  private release(auto = false) {
    if (!this.attached) return;
    const perfect = !auto && this.inWindow() && this.holdT > 0.14;
    this.attached = false;
    this.fireCd = 0.06;
    this.tau = 1;
    if (perfect) this.perfect();
    else {
      this.c.audio.play({
        wave: "sine",
        freq: 150,
        freqTo: 70,
        glide: 0.1,
        vol: 0.14,
        attack: 0.002,
        hold: 0.03,
        release: 0.12,
      });
    }
  }

  private perfect() {
    this.chain = Math.min(40, this.chain + 1);
    this.chainT = this.chainWindow();
    const m = this.mult;
    this.vz += 8 + Math.min(this.chain, 20) * 0.3;
    this.vy += 16;
    this.score += 120 * m;

    this.warp.hitStop(0.045);
    this.warp.slowMo(0.16, 0.35);
    this.shake.add(0.35);
    this.desatBoost = Math.max(this.desatBoost, 0.3);
    this.amountSpike = Math.max(this.amountSpike, 0.012);
    this.warpSpike = Math.max(this.warpSpike, 0.06);
    this.bloomSpike = Math.max(this.bloomSpike, 0.9);
    this.flashC.setRGB(0.1, 0.26, 0.34);
    this.chainPunch = 1;
    this.speedPunch = 1;
    this.scorePunch = 1;

    this.tmpC.copy(this.pal[6]);
    this.particles.burst(90, this.px, this.py, this.pz, 26, {
      life: 0.55,
      size: 2.4,
      endSize: 0,
      color: this.tmpC.clone(),
      endColor: this.pal[0].clone().multiplyScalar(0.7),
      drag: 0.22,
    });
    this.shock(this.px, this.py, this.pz, 0, 26, 0.5);
    this.popup("PERFECT", this.px, this.py + 5, this.pz, 44, "#22e0ff", 0.7);

    const base = 440 * Math.pow(2, Math.min(this.chain, 18) / 24);
    this.c.audio.play({
      wave: "square",
      freq: base,
      freqTo: base * 2,
      glide: 0.09,
      vol: 0.2,
      attack: 0.001,
      hold: 0.03,
      release: 0.12,
    });
    this.c.audio.play({
      wave: "sine",
      freq: base * 1.5,
      vol: 0.12,
      attack: 0.001,
      hold: 0.04,
      release: 0.18,
      delay: 0.03,
    });
    this.c.audio.play({
      wave: "noise",
      freq: 3000,
      freqTo: 800,
      vol: 0.12,
      attack: 0.001,
      hold: 0.01,
      release: 0.09,
      filter: 4000,
      filterType: "highpass",
    });

    const mi = MILESTONES.indexOf(this.chain);
    if (mi >= 0) this.milestone(mi);
  }

  private milestone(i: number) {
    this.warp.slowMo(0.3, 0.35);
    this.flashC.setRGB(0.4, 0.4, 0.5);
    this.shake.add(0.4);
    this.bloomSpike = 1.2;
    this.banner(MILESTONE_WORDS[i], "#ffffff", 1.4);
    for (let k = 0; k < this.tCount; k++) this.tflash[k] = Math.max(this.tflash[k], 0.25);
    this.c.audio.powerUp(0.22);
    this.shock(this.px, this.py, this.pz, 6, 46, 0.7);
  }

  // --- hazards, pickups, failure -------------------------------------------

  private collide(d: number) {
    let bestGap = 1e9;
    let bestTower = -1;
    for (let i = 0; i < this.tCount; i++) {
      const dz = this.tz[i] - this.pz;
      if (dz > 46 || dz < -46) continue;
      const hw = this.tw[i] * 0.5;
      const hd = this.td[i] * 0.5;
      // Two-sample sweep so a 150 m/s step cannot tunnel a 14 m tower.
      for (let s = 0; s <= 1; s++) {
        const sx = this.px - this.vx * d * 0.5 * s;
        const sy = this.py - this.vy * d * 0.5 * s;
        const sz = this.pz - this.vz * d * 0.5 * s;
        const cx = clamp(sx, this.tx[i] - hw, this.tx[i] + hw);
        const cy = clamp(sy, 0, this.th[i]);
        const cz = clamp(sz, this.tz[i] - hd, this.tz[i] + hd);
        const gap = Math.hypot(sx - cx, sy - cy, sz - cz);
        if (gap < bestGap) {
          bestGap = gap;
          bestTower = i;
        }
      }
    }

    if (bestGap <= BODY_R) {
      this.crash(this.tpillar[bestTower] ? "PILLAR" : "TOWER");
      return;
    }
    if (
      bestTower >= 0 &&
      bestGap <= NEARMISS_OUTER &&
      this.vz >= NEARMISS_SPEED &&
      this.nearCd <= 0 &&
      this.phase === "play"
    ) {
      this.nearMiss(bestTower);
    }

    for (let i = 0; i < this.hCount; i++) {
      if (Math.abs(this.hzz[i] - this.pz) > 3) continue;
      const a = this.hang[i];
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const rx = this.px;
      const ry = this.py - 46;
      const along = rx * ca + ry * sa;
      const perp = -rx * sa + ry * ca;
      if (Math.abs(along) < this.hlen[i] * 0.5 && Math.abs(perp) < 1.25 + BODY_R) {
        this.crash("BEAM");
        return;
      }
    }
  }

  private nearMiss(i: number) {
    this.nearCd = NEARMISS_COOLDOWN;
    this.chain = Math.min(40, this.chain + 1);
    this.chainT = this.chainWindow();
    this.score += 350 * this.mult;
    this.warp.slowMo(0.55, 0.22);
    this.desatBoost = 0.55;
    this.amountSpike = 0.02;
    this.warpSpike = 0.09;
    this.shake.add(0.45);
    this.bloomSpike = 0.8;
    this.tflash[i] = 0.4;
    this.chainPunch = 1;
    this.scorePunch = 1;
    this.shock(this.px, this.py, this.pz, 0, 34, 0.65);
    this.popup("NEAR MISS +1", this.px, this.py + 6, this.pz, 46, "#ff2fb0", 0.9);
    this.c.audio.play({
      wave: "noise",
      freq: 1400,
      freqTo: 300,
      vol: 0.2,
      attack: 0.06,
      hold: 0.06,
      release: 0.3,
      filter: 900,
      filterTo: 260,
      filterType: "bandpass",
      q: 2.2,
    });
    this.c.audio.play({
      wave: "sine",
      freq: 60,
      freqTo: 160,
      glide: 0.4,
      vol: 0.24,
      attack: 0.08,
      hold: 0.14,
      release: 0.28,
    });
    const mi = MILESTONES.indexOf(this.chain);
    if (mi >= 0) this.milestone(mi);
  }

  private checkRings() {
    for (let i = 0; i < this.rCount; i++) {
      if (this.rtaken[i]) continue;
      if (Math.abs(this.rz[i] - this.pz) > 3.5) continue;
      const dx = this.px - this.rx[i];
      const dy = this.py - this.ry[i];
      if (dx * dx + dy * dy > 4.6 * 4.6) continue;
      this.rtaken[i] = 1;
      this.score += 200 * this.mult;
      if (this.chain > 0) {
        this.chainT = Math.min(this.chainWindow(), this.chainT + 0.9);
      }
      this.scorePunch = 1;
      this.speedPunch = 0.6;
      this.shake.add(0.14);
      this.bloomSpike = Math.max(this.bloomSpike, 0.5);
      this.flashC.setRGB(0.16, 0.12, 0.02);
      this.particles.burst(40, this.rx[i], this.ry[i], this.rz[i], 20, {
        life: 0.5,
        size: 2.0,
        endSize: 0,
        color: this.pal[2].clone(),
        endColor: this.pal[1].clone().multiplyScalar(0.5),
        drag: 0.2,
      });
      this.popup("+RING", this.rx[i], this.ry[i] + 5, this.rz[i], 34, "#ffd24a", 0.6);
      this.c.audio.coin(0.2);
    }
  }

  private breakChain(fromCrash: boolean) {
    if (this.chain <= 0) {
      this.chainT = this.chainWindow();
      return;
    }
    const n = Math.min(40, 12 + this.chain);
    this.particles.burst(n, this.px, this.py + 3, this.pz, 16, {
      life: 0.7,
      size: 2.2,
      endSize: 0,
      color: this.pal[5].clone(),
      endColor: this.pal[3].clone().multiplyScalar(0.4),
      gravity: -22,
      drag: 0.4,
    });
    this.chain = 0;
    this.chainT = this.chainWindow();
    this.shatter = 0.55;
    this.chainPunch = 1;
    if (!fromCrash) {
      this.flashC.setRGB(0.34, 0.05, 0.08);
      this.desatBoost = Math.max(this.desatBoost, 0.5);
      this.shake.add(0.55);
      this.banner("CHAIN LOST", "#ff2d4a", 0.9);
      this.c.audio.fail(0.24);
    }
  }

  private crash(what: string) {
    if (this.phase === "crash" || this.phase === "over") return;
    this.attached = false;
    this.heldPrev = true;
    this.demoCrash = this.phase === "attract";
    if (!this.demoCrash) this.lives--;
    this.breakChain(true);
    this.phase = "crash";
    this.crashT = 0.95;
    this.warp.hitStop(0.12);
    this.warp.slowMo(0.9, 0.3);
    this.desatBoost = 0.75;
    this.amountSpike = 0.022;
    this.shake.add(1);
    this.bloomSpike = 1.4;
    this.flashC.setRGB(0.55, 0.06, 0.1);
    this.vz *= 0.45;
    this.vx *= -0.3;
    this.vy = 10;
    this.particles.burst(260, this.px, this.py, this.pz, 42, {
      life: 1.0,
      size: 2.6,
      endSize: 0,
      color: this.pal[6].clone(),
      endColor: this.pal[5].clone().multiplyScalar(0.5),
      gravity: -30,
      drag: 0.35,
    });
    this.shock(this.px, this.py, this.pz, 5, 50, 0.8);
    this.banner(what === "GROUND" ? "SPLAT" : "WIPEOUT", "#ff2d4a", 1.1);
    this.c.audio.explode(0.34);
    this.c.audio.fail(0.22);
    if (!this.demoCrash && this.lives <= 0) this.recordBest();
  }

  private recordBest() {
    const s = Math.floor(this.score);
    if (this.c.store.recordBest("best", s)) this.best = s;
  }

  private celebrateBest() {
    this.bestCelebrate = 2.4;
    this.warp.slowMo(0.7, 0.28);
    this.flashC.setRGB(0.4, 0.3, 0.05);
    this.shake.add(0.4);
    this.bloomSpike = 1.4;
    this.banner("NEW BEST", "#ffd24a", 2.0);
    this.particles.burst(140, this.px, this.py, this.pz, 34, {
      life: 1.1,
      size: 2.6,
      endSize: 0,
      color: this.pal[2].clone(),
      endColor: this.pal[1].clone().multiplyScalar(0.6),
      drag: 0.3,
    });
    this.shock(this.px, this.py, this.pz, 2, 56, 0.9);
    this.c.audio.powerUp(0.26);
  }

  // --- helpers --------------------------------------------------------------

  private shock(x: number, y: number, z: number, hue: number, max: number, life: number) {
    if (this.skCount >= SHOCK_MAX) return;
    const i = this.skCount++;
    this.skx[i] = x;
    this.sky_[i] = y;
    this.skz[i] = z;
    this.sklife[i] = life;
    this.skdur[i] = life;
    this.skmax[i] = max;
    this.skhue[i] = hue;
  }

  private popup(
    text: string,
    x: number,
    y: number,
    z: number,
    size: number,
    color: string,
    life: number,
  ) {
    let slot = -1;
    let worst = 1e9;
    for (let i = 0; i < POPUP_MAX; i++) {
      if (this.popups[i].life <= 0) {
        slot = i;
        break;
      }
      if (this.popups[i].life < worst) {
        worst = this.popups[i].life;
        slot = i;
      }
    }
    const p = this.popups[slot];
    p.x = x;
    p.y = y;
    p.z = z;
    p.text = text;
    p.size = size;
    p.color = color;
    p.life = life;
    p.max = life;
  }

  private banner(text: string, color: string, life: number) {
    this.bannerText = text;
    this.bannerColor = color;
    this.bannerT = life;
  }

  private trail(d: number, scale: number) {
    const n = this.vz > 90 ? 6 : this.vz > 55 ? 4 : 3;
    for (let i = 0; i < n; i++) {
      const f = i / n;
      this.particles.spawn({
        x: this.px - this.vx * d * f,
        y: this.py - this.vy * d * f,
        z: this.pz - this.vz * d * f,
        vx: this.c.rng.spread(2.5),
        vy: this.c.rng.spread(2.5),
        vz: -this.vz * 0.06,
        life: (0.34 + this.vz * 0.0035) * scale,
        size: 2.1,
        endSize: 0,
        color: this.pal[6],
        endColor: this.pal[3],
        drag: 0.5,
      });
    }
  }

  private botSteer() {
    const tx = this.target >= 0 ? this.ax[this.target] : 0;
    return clamp((tx - this.px) * 0.1, -1, 1);
  }

  private botHold() {
    if (!this.attached) {
      return this.fireCd <= 0 && this.target >= 0 && this.vy < 6;
    }
    return !(this.armed && this.tau <= this.botBias);
  }

  private tickMusic() {
    if (!this.c.audio.ready) return;
    const target = lerp(108, 168, this.ramp);
    const band = Math.round(target / 6) * 6;
    if (band !== this.musicBpm) {
      this.musicBpm = band;
      this.c.audio.startMusic(this.onStep, band, 4);
    }
  }

  private onStep = (step: number, time: number) => {
    const kit = this.c.audio;
    const s = step % 16;
    const cut = lerp(700, 4200, this.ramp);
    if (s % 4 === 0) {
      kit.play({
        wave: "sine",
        freq: 62,
        freqTo: 34,
        glide: 0.09,
        vol: 0.34,
        attack: 0.002,
        hold: 0.04,
        release: 0.14,
        delay: time,
      });
    }
    if (s === 4 || s === 12) {
      kit.play({
        wave: "noise",
        freq: 1100,
        vol: 0.15,
        attack: 0.001,
        hold: 0.018,
        release: 0.1,
        filter: 1500,
        filterType: "highpass",
        delay: time,
      });
    }
    if (s % 2 === 1) {
      kit.play({
        wave: "noise",
        freq: 2800,
        vol: 0.045,
        attack: 0.001,
        hold: 0.004,
        release: 0.026,
        filter: 5200,
        filterType: "highpass",
        delay: time,
      });
    }
    const n = ARP[step % ARP.length];
    kit.play({
      wave: "sawtooth",
      freq: 55 * Math.pow(2, n / 12),
      vol: 0.13,
      attack: 0.002,
      hold: 0.05,
      release: 0.08,
      filter: cut,
      q: 3,
      delay: time,
    });
    if (this.chain >= 5 && s % 8 === 0) {
      for (const o of [0, 7, 15]) {
        kit.play({
          wave: "triangle",
          freq: 110 * Math.pow(2, (n + o) / 12),
          vol: 0.08,
          attack: 0.09,
          hold: 0.24,
          release: 0.3,
          delay: time,
        });
      }
    }
    if (this.chain >= 12 && s % 2 === 0) {
      kit.play({
        wave: "square",
        freq: 440 * Math.pow(2, n / 12),
        vol: 0.055,
        attack: 0.002,
        hold: 0.02,
        release: 0.06,
        delay: time,
      });
    }
  };

  // --- draw -----------------------------------------------------------------

  draw() {
    if (!this.ready) return;
    const dt = 1 / 60;

    // Camera first: the billboarded reticle needs this frame's orientation.
    this.placeCamera(dt);
    this.writeWorld();
    this.driveGrade();

    this.camera.updateMatrixWorld();
    // HUD projection is taken pre-shake so the gauge does not jitter apart.
    this.projectHud();

    this.shake.apply(this.camera, 1.6);
    this.camera.updateMatrixWorld();
    this.post.composer.render();

    this.drawHud();
    this.hud.commit(this.renderer);
  }

  private writeWorld() {
    const speedT = clamp01((this.vz - 55) / 55);

    // --- towers, crowns, window strips
    this.towerPool.begin();
    this.crownPool.begin();
    this.windowPool.begin();
    for (let i = 0; i < this.tCount; i++) {
      const h = this.th[i];
      const sh = this.tshade[i];
      const fl = this.tflash[i] > 0 ? clamp01(this.tflash[i] / 0.4) : 0;
      this.tmpC.setRGB(sh * 0.45 + fl * 3, sh * 0.6 + fl * 3, sh * 1.5 + fl * 3);
      this.towerPool.write(
        this.tx[i],
        h * 0.5,
        this.tz[i],
        { x: this.tw[i], y: h, z: this.td[i] },
        this.tmpC,
      );

      const hue = this.pal[this.thue[i]];
      this.tmpC.copy(hue);
      if (fl > 0) this.tmpC.addScalar(fl * 3);
      this.crownPool.write(
        this.tx[i],
        h + 0.5,
        this.tz[i],
        { x: this.tw[i] + 1.6, y: 1.1, z: this.td[i] + 1.6 },
        this.tmpC,
      );

      // A vertical edge column on the corridor-facing corner draws the canyon.
      const side = this.tx[i] < 0 ? 1 : -1;
      this.tmpC.copy(hue).multiplyScalar(0.34);
      this.windowPool.write(
        this.tx[i] + (side * this.tw[i]) / 2,
        h * 0.5,
        this.tz[i] + this.td[i] / 2,
        { x: 0.7, y: h, z: 0.7 },
        this.tmpC,
      );
      this.tmpC.copy(this.pal[3]).multiplyScalar(0.26);
      this.windowPool.write(
        this.tx[i],
        h * 0.42,
        this.tz[i],
        { x: this.tw[i] + 0.4, y: 0.7, z: this.td[i] + 0.4 },
        this.tmpC,
      );
      this.windowPool.write(
        this.tx[i],
        h * 0.72,
        this.tz[i],
        { x: this.tw[i] + 0.4, y: 0.7, z: this.td[i] + 0.4 },
        this.tmpC,
      );
    }
    this.towerPool.end();
    this.crownPool.end();
    this.windowPool.end();

    // --- anchors + halos
    this.anchorPool.begin();
    for (let i = 0; i < this.aCount; i++) {
      const isTarget = i === this.target;
      const pulse = 1 + Math.sin(this.aphase[i]) * 0.18;
      this.tmpC.copy(isTarget ? this.pal[6] : this.pal[0]);
      this.anchorPool.write(
        this.ax[i],
        this.ay[i],
        this.az[i],
        1.5 * pulse * (isTarget ? 1.4 : 1),
        this.tmpC,
        { x: 0, y: this.aphase[i], z: this.aphase[i] * 0.6 },
      );
      this.tmpC.copy(this.pal[0]).multiplyScalar(0.16);
      this.anchorPool.write(
        this.ax[i],
        this.ay[i],
        this.az[i],
        4.2 * pulse,
        this.tmpC,
        { x: 0, y: -this.aphase[i] * 0.5, z: 0 },
      );
    }
    if (this.attached) {
      this.tmpC.copy(this.pal[6]);
      this.anchorPool.write(this.anchorX, this.anchorY, this.anchorZ, 2.4, this.tmpC);
    }
    this.anchorPool.end();

    // --- boost rings
    this.ringPool.begin();
    for (let i = 0; i < this.rCount; i++) {
      if (this.rtaken[i]) continue;
      this.tmpC.copy(this.pal[2]);
      this.ringPool.write(this.rx[i], this.ry[i], this.rz[i], 1, this.tmpC, {
        x: 0,
        y: 0,
        z: this.rspin[i],
      });
    }
    this.ringPool.end();

    // --- hazard sweep bars
    this.hazardPool.begin();
    for (let i = 0; i < this.hCount; i++) {
      this.tmpC.copy(this.pal[4]);
      this.hazardPool.write(
        0,
        46,
        this.hzz[i],
        { x: this.hlen[i], y: 2.5, z: 2.5 },
        this.tmpC,
        { x: 0, y: 0, z: this.hang[i] },
      );
    }
    this.hazardPool.end();

    // --- speed lines
    this.linePool.begin();
    if (speedT > 0.01) {
      const len = lerp(5, 30, speedT);
      for (let i = 0; i < LINE_MAX; i++) {
        const a = this.slAng[i];
        const r = this.slRad[i];
        this.tmpC.copy(this.pal[0]).multiplyScalar((0.25 + speedT * 0.6) * 0.6);
        this.linePool.write(
          this.px + Math.cos(a) * r,
          this.py + Math.sin(a) * r * 0.7,
          this.slZ[i],
          { x: 0.16, y: 0.16, z: len },
          this.tmpC,
        );
      }
    }
    this.linePool.end();

    // --- shockwaves
    this.shockPool.begin();
    for (let i = 0; i < this.skCount; i++) {
      const t = 1 - this.sklife[i] / this.skdur[i];
      const rad = this.skmax[i] * clamp01(t * 1.6) + 1;
      this.tmpC.copy(this.pal[this.skhue[i]]).multiplyScalar(clamp01(this.sklife[i] * 2));
      this.shockPool.write(
        this.skx[i],
        this.sky_[i],
        this.skz[i],
        rad,
        this.tmpC,
      );
    }
    this.shockPool.end();

    // --- player body
    this.body.position.set(this.px, this.py, this.pz);
    const sp = Math.hypot(this.vx, this.vy, this.vz) || 1;
    this.tmpV.set(this.vx / sp, this.vy / sp, this.vz / sp);
    this.tmpQ.setFromUnitVectors(FWD, this.tmpV);
    this.body.quaternion.copy(this.tmpQ);
    if (this.phase === "crash" || this.phase === "over") {
      this.body.rotateX(this.spin);
      this.body.rotateZ(this.spin * 0.7);
    }
    const stretch = lerp(2.2, 4.4, clamp01((this.vz - 40) / 90));
    this.body.scale.set(1, 1, stretch);

    // --- rope
    if (this.attached) {
      const mx = (this.px + this.anchorX) * 0.5;
      const my = (this.py + this.anchorY) * 0.5;
      const mz = (this.pz + this.anchorZ) * 0.5;
      this.tmpV.set(
        this.anchorX - this.px,
        this.anchorY - this.py,
        this.anchorZ - this.pz,
      );
      const len = this.tmpV.length() || 1;
      this.tmpV.multiplyScalar(1 / len);
      this.tmpQ.setFromUnitVectors(UP, this.tmpV);
      const win = this.inWindow();
      const mat = this.rope.material as THREE.MeshBasicMaterial;
      mat.color.copy(win ? this.pal[6] : this.palDim[0]);
      const hmat = this.ropeHalo.material as THREE.MeshBasicMaterial;
      hmat.color.copy(win ? this.pal[6] : this.pal[0]);
      hmat.opacity = win ? 0.55 : 0.22;
      this.rope.visible = true;
      this.ropeHalo.visible = true;
      this.rope.position.set(mx, my, mz);
      this.rope.quaternion.copy(this.tmpQ);
      this.rope.scale.set(win ? 0.28 : 0.17, len, win ? 0.28 : 0.17);
      this.ropeHalo.position.copy(this.rope.position);
      this.ropeHalo.quaternion.copy(this.tmpQ);
      this.ropeHalo.scale.set(win ? 0.95 : 0.55, len, win ? 0.95 : 0.55);
    } else {
      this.rope.visible = false;
      this.ropeHalo.visible = false;
    }

    // --- reticle on the anchor you are about to grab
    if (this.target >= 0 && !this.attached) {
      this.reticle.visible = true;
      this.reticle.position.set(
        this.ax[this.target],
        this.ay[this.target],
        this.az[this.target],
      );
      // Billboard, then spin in the camera's own plane.
      this.reticle.quaternion.copy(this.camera.quaternion);
      this.reticle.rotateZ(this.realT * 1.7);
      this.reticle.scale.setScalar(11 + Math.sin(this.realT * 6) * 1.2);
    } else {
      this.reticle.visible = false;
    }

    // --- ground + sky follow the flight
    this.ground.position.set(this.px, 0, this.pz + 300);
    this.groundMat.uniforms.uTime.value = this.realT;
    (this.groundMat.uniforms.uEye.value as THREE.Vector3).set(this.px, this.py, this.pz);
    this.groundMat.uniforms.uAmp.value = 1 + this.ramp * 0.6;
    (this.skyMat.uniforms.uHorizon.value as THREE.Color).setRGB(
      lerp(0.2, 0.75, this.ramp),
      lerp(0.05, 0.06, this.ramp),
      lerp(0.5, 0.3, this.ramp),
    );
    this.skyMat.uniforms.uGlow.value = 1.4 + this.ramp * 0.8;

    this.fogC.setRGB(
      lerp(0.027, 0.102, this.ramp),
      lerp(0.008, 0.016, this.ramp),
      lerp(0.102, 0.141, this.ramp),
    );
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(this.fogC);
    fog.near = lerp(60, 40, this.ramp);
    fog.far = lerp(460, 300, this.ramp);
    this.renderer.setClearColor(this.fogC, 1);
  }

  private placeCamera(dt: number) {
    const back = lerp(15, 23, clamp01((this.vz - 40) / 80));
    this.camX = damp(this.camX, this.px * 0.7, 0.16, dt);
    this.camY = damp(this.camY, this.py + 5.5, 0.12, dt);
    this.camera.position.set(this.camX, this.camY, this.pz - back);
    this.camera.up.set(0, 1, 0);
    this.tmpV2.set(this.px * 0.55, this.py + 5, this.pz + 34);
    this.camera.lookAt(this.tmpV2);
    this.roll = damp(this.roll, clamp(-this.vx * 0.012, -0.35, 0.35), 0.1, dt);
    this.camera.rotateZ(this.roll);

    const wantFov = lerp(62, 96, clamp01((this.vz - 30) / 90));
    this.fov = damp(this.fov, wantFov, 0.07, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.05) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    this.sky.position.copy(this.camera.position);
  }

  private driveGrade() {
    const u = this.post.grade.uniforms;
    u.amount.value =
      0.0018 + this.ramp * 0.0042 + this.vz * 0.00009 + this.amountSpike;
    u.warp.value = this.vz * 0.0013 + this.warpSpike;
    u.vignette.value = lerp(0.85, 1.05, this.ramp);
    u.scan.value = this.ramp * 0.06;
    u.time.value = this.realT;
    const slow = clamp01((1 - this.warp.scale) / 0.8);
    u.desat.value = clamp01(Math.max(this.desatBoost, slow * 0.5));
    (u.flash.value as THREE.Color).copy(this.flashC);
    this.post.bloom.strength = lerp(0.66, 1.28, this.ramp) + this.bloomSpike;
  }

  // --- HUD ------------------------------------------------------------------

  private hudBodyX = 0;
  private hudBodyY = 0;
  private hudBodyOk = false;
  private popX = new Float32Array(POPUP_MAX);
  private popY = new Float32Array(POPUP_MAX);
  private popOk = new Uint8Array(POPUP_MAX);

  private projectHud() {
    this.tmpV.set(this.px, this.py, this.pz).project(this.camera);
    this.hudBodyOk = this.tmpV.z < 1;
    this.hudBodyX = (this.tmpV.x * 0.5 + 0.5) * this.w;
    this.hudBodyY = (-this.tmpV.y * 0.5 + 0.5) * this.h;
    for (let i = 0; i < POPUP_MAX; i++) {
      const p = this.popups[i];
      if (p.life <= 0) {
        this.popOk[i] = 0;
        continue;
      }
      const rise = (1 - p.life / p.max) * 8;
      this.tmpV.set(p.x, p.y + rise, p.z).project(this.camera);
      this.popOk[i] = this.tmpV.z < 1 ? 1 : 0;
      this.popX[i] = (this.tmpV.x * 0.5 + 0.5) * this.w;
      this.popY[i] = (-this.tmpV.y * 0.5 + 0.5) * this.h;
    }
  }

  private drawHud() {
    const g = this.hud.begin();
    const k = this.hudK;
    const W = this.w;
    const H = this.h;
    const mono = (px: number, weight = 700) =>
      `${weight} ${Math.round(px * k)}px ui-monospace, "SFMono-Regular", Menlo, monospace`;

    // --- release gauge around the body
    if (this.attached && this.hudBodyOk) {
      const cx = this.hudBodyX;
      const cy = this.hudBodyY;
      const R = 56 * k;
      const ang = (tau: number) =>
        -HALF_PI + remap(clamp(tau, -0.5, 0.7), 0.7, -0.5, -2.2, 2.2);
      g.lineWidth = 7 * k;
      g.strokeStyle = "rgba(140,190,255,0.20)";
      g.beginPath();
      g.arc(cx, cy, R, ang(0.7), ang(-0.5));
      g.stroke();

      const s = this.c.isTouch ? 1.25 : 1;
      const win = this.inWindow();
      g.strokeStyle = win ? "rgba(180,255,235,0.95)" : "rgba(60,255,170,0.65)";
      g.lineWidth = (win ? 12 : 8) * k;
      g.beginPath();
      g.arc(cx, cy, R, ang(WIN_EARLY * s), ang(-WIN_LATE * s));
      g.stroke();

      const na = ang(this.tau);
      g.strokeStyle = win ? "#ffffff" : "#bfe6ff";
      g.lineWidth = 4 * k;
      g.beginPath();
      g.moveTo(cx + Math.cos(na) * (R - 15 * k), cy + Math.sin(na) * (R - 15 * k));
      g.lineTo(cx + Math.cos(na) * (R + 15 * k), cy + Math.sin(na) * (R + 15 * k));
      g.stroke();
    }

    // --- world popups
    for (let i = 0; i < POPUP_MAX; i++) {
      const p = this.popups[i];
      if (p.life <= 0 || !this.popOk[i]) continue;
      const a = clamp01(p.life / p.max);
      g.globalAlpha = a;
      g.font = mono(p.size);
      g.textAlign = "center";
      glowText(g, p.text, this.popX[i], this.popY[i], p.color, 18);
      g.globalAlpha = 1;
    }
    g.textAlign = "left";

    // --- CHAIN, the second biggest thing on screen
    const chainShown = this.chain + 1;
    const cCol =
      this.chain >= 20
        ? "#ffffff"
        : this.chain >= 12
          ? "#ff5ec8"
          : this.chain >= 5
            ? "#ffd24a"
            : "#dff3ff";
    const cs = 1 + this.chainPunch * 0.18 - this.shatter * 0.25;
    g.save();
    // Pushed down past the shell's own back-chip and mute button.
    g.translate(34 * k, 172 * k);
    g.scale(cs, cs);
    g.font = mono(88);
    glowText(g, `x${chainShown}`, 0, 0, cCol, 26);
    g.restore();

    // --- chain timer
    if (this.chain > 0) {
      const frac = clamp01(this.chainT / this.chainWindow());
      const low = this.chainT < 0.8;
      const jitter = low ? (Math.random() * 4 - 2) * k : 0;
      const bw = 260 * k;
      g.fillStyle = "rgba(0,0,0,0.5)";
      roundRectPath(g, 36 * k, 186 * k + jitter, bw, 11 * k, 5 * k);
      g.fill();
      g.fillStyle = low ? "#ff2d4a" : cCol;
      roundRectPath(
        g,
        36 * k,
        186 * k + jitter,
        Math.max(2, bw * frac),
        11 * k,
        5 * k,
      );
      g.fill();
    }

    // --- SPEED, the biggest thing on screen
    const kmh = Math.round(this.vz * 3.6);
    const sCol =
      kmh > 340 ? "#ffffff" : kmh > 280 ? "#ff5ec8" : kmh > 200 ? "#ffd24a" : "#dff3ff";
    const ss = 1 + this.speedPunch * 0.14;
    g.save();
    g.translate(W - 34 * k, 172 * k);
    g.scale(ss, ss);
    g.textAlign = "right";
    g.font = mono(104);
    glowText(g, `${kmh}`, 0, 0, sCol, 24);
    g.font = mono(26);
    glowText(g, "KM/H", 0, 30 * k, "rgba(190,225,255,0.75)", 8);
    g.restore();

    // --- SCORE
    g.textAlign = "center";
    const sc = 1 + this.scorePunch * 0.1;
    g.save();
    g.translate(W * 0.5, 56 * k);
    g.scale(sc, sc);
    g.font = mono(48);
    glowText(g, `${Math.floor(this.scoreShown).toLocaleString()}`, 0, 0, "#ffffff", 16);
    g.restore();
    g.font = mono(20);
    g.fillStyle = "rgba(180,205,235,0.55)";
    g.fillText(
      `BEST ${Math.max(this.best, Math.floor(this.score)).toLocaleString()}`,
      W * 0.5,
      80 * k,
    );

    // --- crash chevrons
    g.textAlign = "left";
    for (let i = 0; i < 3; i++) {
      const on = i < this.lives;
      g.fillStyle = on ? "#22e0ff" : "rgba(120,140,170,0.28)";
      const x = 36 * k + i * 26 * k;
      const y = H - 40 * k;
      g.beginPath();
      g.moveTo(x, y + 14 * k);
      g.lineTo(x + 9 * k, y);
      g.lineTo(x + 18 * k, y + 14 * k);
      g.lineTo(x + 9 * k, y + 8 * k);
      g.closePath();
      g.fill();
    }

    // --- banner
    if (this.bannerT > 0) {
      const a = clamp01(this.bannerT * 2.2);
      g.globalAlpha = a;
      g.textAlign = "center";
      g.font = mono(74);
      glowText(g, this.bannerText, W * 0.5, H * 0.66, this.bannerColor, 30);
      g.globalAlpha = 1;
    }

    // --- personal-best celebration
    if (this.bestCelebrate > 0) {
      const t = 1 - this.bestCelebrate / 2.4;
      g.save();
      g.globalCompositeOperation = "lighter";
      g.translate(W * 0.5, H * 0.5);
      for (let i = 0; i < 18; i++) {
        const a = (i / 18) * TAU + this.realT * 0.6;
        g.strokeStyle = `rgba(255,210,74,${0.22 * (1 - t)})`;
        g.lineWidth = 26 * k;
        g.beginPath();
        g.moveTo(0, 0);
        g.lineTo(Math.cos(a) * W, Math.sin(a) * W);
        g.stroke();
      }
      g.restore();
      g.textAlign = "center";
      g.font = mono(72);
      glowText(g, "NEW PERSONAL BEST", W * 0.5, H * 0.56, "#ffd24a", 34);
    }

    if (this.phase === "attract") this.drawAttract(g, mono);
    if (this.phase === "over") this.drawOver(g, mono);

    g.textAlign = "left";
  }

  private drawAttract(
    g: CanvasRenderingContext2D,
    mono: (px: number, w?: number) => string,
  ) {
    const W = this.w;
    const H = this.h;
    const k = this.hudK;
    g.textAlign = "center";
    g.font = mono(96, 800);
    const wob = Math.sin(this.realT * 2.2) * 2.5 * k;
    g.save();
    g.globalCompositeOperation = "lighter";
    g.fillStyle = "#ff0050";
    g.fillText("SWINGSHOT", W * 0.5 - 3 * k - wob, H * 0.34);
    g.fillStyle = "#00ffa0";
    g.fillText("SWINGSHOT", W * 0.5 + 1 * k, H * 0.34 + 1.5 * k);
    g.fillStyle = "#4090ff";
    g.fillText("SWINGSHOT", W * 0.5 + 3 * k + wob, H * 0.34);
    g.restore();
    glowText(g, "SWINGSHOT", W * 0.5, H * 0.34, "#ffffff", 26);

    const pulse = 0.55 + 0.45 * Math.sin(this.realT * TAU * 1.2);
    g.globalAlpha = pulse;
    g.font = mono(30);
    glowText(
      g,
      this.c.isTouch ? "TOUCH AND HOLD TO FLY" : "CLICK OR SPACE TO FLY",
      W * 0.5,
      H * 0.34 + 66 * k,
      "#22e0ff",
      18,
    );
    g.globalAlpha = 1;
    g.font = mono(19);
    g.fillStyle = "rgba(190,215,245,0.6)";
    g.fillText(
      this.c.isTouch
        ? "hold to grapple · slide to steer · release at the bottom of the arc"
        : "HOLD to grapple · A/D steer · S dive · W flare · RELEASE in the green",
      W * 0.5,
      H * 0.34 + 100 * k,
    );
  }

  private drawOver(
    g: CanvasRenderingContext2D,
    mono: (px: number, w?: number) => string,
  ) {
    const W = this.w;
    const H = this.h;
    const k = this.hudK;
    g.fillStyle = "rgba(6,2,20,0.55)";
    g.fillRect(0, 0, W, H);
    g.textAlign = "center";
    g.font = mono(84, 800);
    glowText(g, "WIPEOUT", W * 0.5, H * 0.38, "#ff2d4a", 30);
    g.font = mono(56);
    glowText(g, `${Math.floor(this.score).toLocaleString()}`, W * 0.5, H * 0.5, "#ffffff", 20);
    g.font = mono(24);
    const beat = Math.floor(this.score) >= this.best && this.best > 0;
    glowText(
      g,
      beat ? `NEW BEST` : `BEST ${this.best.toLocaleString()}`,
      W * 0.5,
      H * 0.5 + 38 * k,
      beat ? "#ffd24a" : "rgba(190,215,245,0.7)",
      12,
    );
    const pulse = 0.5 + 0.5 * Math.sin(this.realT * TAU * 1.4);
    g.globalAlpha = pulse;
    g.font = mono(30);
    glowText(
      g,
      this.c.isTouch ? "TAP TO FLY AGAIN" : "PRESS R OR CLICK TO FLY AGAIN",
      W * 0.5,
      H * 0.64,
      "#22e0ff",
      18,
    );
    g.globalAlpha = 1;
  }
}

const factory: GameFactory = (ctx) => new Swingshot(ctx);
export default factory;
