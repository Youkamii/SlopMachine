/**
 * SPIRE
 *
 * A stacking game built like a fighting game. A slab swings on a crane above
 * your tower; one click drops it. Land it flush and the whole spire ignites —
 * a shockwave rips down every slab you have ever placed, the pitch climbs a
 * semitone, the multiplier ticks, and the platform grows back. Land it sloppy
 * and the overhang shears off, tumbles past the lens, and your platform is
 * permanently smaller.
 *
 * The design intent is that this is a RHYTHM game wearing an architecture
 * game's clothes. The crane rides a sine, so there are exactly two perfect
 * windows per cycle and a double tick pre-rolls each one. The period
 * compresses, the wind starts bending the tower out from under your aim, and
 * the world falls away beneath you — grid, fog sea, cloud banks, the curve of
 * a planet, stars. Getting to see space is the reward for a long run.
 *
 * Nothing on screen is ever still: the game boots into an attract run that is
 * playing itself, ~200 wind streaks rip across the frame at all times, embers
 * climb past the lens, and the camera orbits. There is no black title card.
 */

import * as THREE from "three";
import type { PostStack } from "@/engine/gl/post";
import { glowTexture, hdr, makePost, ringTexture } from "@/engine/gl/post";
import { InstancePool, Particles } from "@/engine/gl/pool";
import { Shake, TimeWarp } from "@/engine/gl/shake";
import { Overlay, bar, glowText, roundRectPath } from "@/engine/gl/overlay";
import {
  HALF_PI,
  TAU,
  clamp,
  clamp01,
  damp,
  easeInCubic,
  easeOutCubic,
  easeOutQuart,
  lerp,
} from "@/engine/math";
import type { GameContext, GameFactory, GameInstance } from "@/games/types";

// --- tuning -----------------------------------------------------------------

const MAX_SLABS = 400;
const MAX_DEBRIS = 84;
const MAX_RINGS = 40;
const MAX_STREAKS = 400;
const MAX_CLOUDS = 96;

const SLAB_H = 1.1;
const START_SIZE = 8;
const MAX_SIZE = 9.5;
/** Below this much surviving overlap the tower cannot stand. */
const MIN_OVERLAP = 0.25;

/** Fast enough to read as a slam, long enough to watch. ~0.24s of fall. */
const DROP_H = 5;
const FALL_V0 = 10;
const FALL_G = 95;

const BASE_FOV = 56;
const CAM_DIST = 24;

const BAND_N = [0, 15, 35, 60, 90, 130];
const BAND_NAME = [
  "GROUND LINE",
  "FOG SEA",
  "CLOUD LINE",
  "STRATOSPHERE",
  "EXOSPHERE",
  "THE VOID",
];

/** Plate colour ramps through these as the chain heats the tower up. */
const HEAT_COLORS = [
  hdr(0x35e0ff, 1.6),
  hdr(0x8a5bff, 2.4),
  hdr(0xff3cc8, 3.4),
  hdr(0xff8a1e, 4.4),
  hdr(0xfff2c0, 5.5),
];

const SKY_LOW = [0x05070e, 0xff7a3c, 0x123a6b, 0x0a1430];
const SKY_HIGH = [0x010206, 0x1c2f57, 0x060c22, 0x02030a];

/**
 * The same ramp again in plain sRGB bytes. The scene colours are HDR-gained
 * linear values, and reading them back for a CSS string produces mud — the
 * HUD needs the hue as authored.
 */
const HEAT_RGB = [
  [0x35, 0xe0, 0xff],
  [0x8a, 0x5b, 0xff],
  [0xff, 0x3c, 0xc8],
  [0xff, 0x8a, 0x1e],
  [0xff, 0xf2, 0xc0],
];

function heatCss(t: number, alpha = 1) {
  const f = clamp01(t) * 4;
  const i = Math.min(3, Math.floor(f));
  const k = f - i;
  const a = HEAT_RGB[i];
  const b = HEAT_RGB[i + 1];
  const r = Math.round(lerp(a[0], b[0], k));
  const g = Math.round(lerp(a[1], b[1], k));
  const bl = Math.round(lerp(a[2], b[2], k));
  return alpha >= 1 ? `rgb(${r},${g},${bl})` : `rgba(${r},${g},${bl},${alpha})`;
}

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const fmt = (n: number) =>
  Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

type Phase = "attract" | "playing" | "dying" | "dead";

class Spire implements GameInstance {
  private readonly c: GameContext;

  // --- three.js -------------------------------------------------------------
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private post!: PostStack;
  private hud!: Overlay;
  private ready = false;

  private bodies!: InstancePool;
  private plates!: InstancePool;
  private debrisPool!: InstancePool;
  private streaks!: InstancePool;
  private ringPool!: InstancePool;
  private cloudPool!: InstancePool;
  private parts!: Particles;

  private sky!: THREE.Mesh;
  private skyMat!: THREE.ShaderMaterial;
  private ground!: THREE.Mesh;
  private groundMat!: THREE.ShaderMaterial;
  private fog!: THREE.Mesh;
  private fogMat!: THREE.ShaderMaterial;
  private planet!: THREE.Mesh;
  private planetMat!: THREE.ShaderMaterial;
  private aurora: THREE.Mesh[] = [];
  private auroraMat!: THREE.ShaderMaterial;
  private stars!: THREE.Points;
  private starMat!: THREE.PointsMaterial;
  private key!: THREE.DirectionalLight;

  private railA!: THREE.Mesh;
  private railB!: THREE.Mesh;
  private beam!: THREE.Mesh;
  private arm!: THREE.Mesh;
  private cable!: THREE.Mesh;
  private glowTex!: THREE.CanvasTexture;
  private ringTex!: THREE.CanvasTexture;
  private partTex!: THREE.CanvasTexture;

  private shake = new Shake();
  private warp = new TimeWarp();

  // Scratch — allocating these per frame is what causes 60fps GC hitches.
  private cA = new THREE.Color();
  private cB = new THREE.Color();
  /** Kept well under 1.0 so bloom cannot see it: dark mass, light edges. */
  private cBody = new THREE.Color(0x162138);
  private cStreak = hdr(0x9fd8ff, 1.4);
  private cGust = hdr(0xff9a30, 2.4);
  private cCloud = new THREE.Color(0xc8d8ee).multiplyScalar(0.7);
  private cFlash = new THREE.Color();

  // --- tower ---------------------------------------------------------------
  private sx = new Float32Array(MAX_SLABS);
  private sz = new Float32Array(MAX_SLABS);
  private sw = new Float32Array(MAX_SLABS);
  private sd = new Float32Array(MAX_SLABS);
  private sy = new Float32Array(MAX_SLABS);
  private sPerf = new Uint8Array(MAX_SLABS);
  private sHeat = new Float32Array(MAX_SLABS);
  private n = 0;

  // --- debris --------------------------------------------------------------
  private dx = new Float32Array(MAX_DEBRIS);
  private dy = new Float32Array(MAX_DEBRIS);
  private dz = new Float32Array(MAX_DEBRIS);
  private dvx = new Float32Array(MAX_DEBRIS);
  private dvy = new Float32Array(MAX_DEBRIS);
  private dvz = new Float32Array(MAX_DEBRIS);
  private drx = new Float32Array(MAX_DEBRIS);
  private dry = new Float32Array(MAX_DEBRIS);
  private drz = new Float32Array(MAX_DEBRIS);
  private dwx = new Float32Array(MAX_DEBRIS);
  private dwy = new Float32Array(MAX_DEBRIS);
  private dwz = new Float32Array(MAX_DEBRIS);
  private dsx = new Float32Array(MAX_DEBRIS);
  private dsy = new Float32Array(MAX_DEBRIS);
  private dsz = new Float32Array(MAX_DEBRIS);
  private dLife = new Float32Array(MAX_DEBRIS);
  private dCount = 0;

  // --- shockwave rings -----------------------------------------------------
  private ry = new Float32Array(MAX_RINGS);
  private rv = new Float32Array(MAX_RINGS);
  private rLife = new Float32Array(MAX_RINGS);
  private rMax = new Float32Array(MAX_RINGS);
  private rRad = new Float32Array(MAX_RINGS);
  private rCol = new Float32Array(MAX_RINGS * 3);
  private rDelay = new Float32Array(MAX_RINGS);
  private rCount = 0;

  // --- wind streaks / clouds ------------------------------------------------
  private wx = new Float32Array(MAX_STREAKS);
  private wy = new Float32Array(MAX_STREAKS);
  private wz = new Float32Array(MAX_STREAKS);
  private clx = new Float32Array(MAX_CLOUDS);
  private cly = new Float32Array(MAX_CLOUDS);
  private clz = new Float32Array(MAX_CLOUDS);
  private clw = new Float32Array(MAX_CLOUDS);
  private clh = new Float32Array(MAX_CLOUDS);

  // --- run state -----------------------------------------------------------
  private w = 0;
  private h = 0;
  private phase: Phase = "attract";
  private tSim = 0;
  private tReal = 0;
  private placed = 0;
  private score = 0;
  private best = 0;
  private chain = 0;
  private peakChain = 0;
  private bestChain = 0;
  private heat = 0;
  private bandT = 0;
  private bandIdx = 0;
  private dieT = 0;

  private cranePhase = 0;
  private craneAmp = 6;
  private cranePos = 0;
  private cranePrev = 0;
  private armT = 0;
  private tickHi = false;
  private tickLo = false;

  private dropping = false;
  private fallY = 0;
  private fallV = 0;
  private fallPos = 0;
  private fallOther = 0;
  private fallOffset = 0;
  private fallW = 0;
  private fallD = 0;

  private wind = 0.25;
  private swayMag = 0;
  private swayX = 0;
  private swayZ = 0;
  private gustT = 8;
  private gustActive = 0;
  private gustWarn = 0;

  private camY = 4;
  private camLookY = 2;
  private camOrbit = 0;
  private camOrbitTarget = 0;
  /** Any multiple of PI keeps the 90°-per-drop axis alignment intact. */
  private camBase = 0;
  private camDist = CAM_DIST;
  private camDistTarget = CAM_DIST;
  private camRush = 0;
  private fov = BASE_FOV;
  private fovTarget = BASE_FOV;

  private desat = 0;
  private desatTarget = 0;
  private flashR = 0;
  private flashG = 0;
  private flashB = 0;
  private slowLock = 0;
  private emberAcc = 0;
  private musicAcc = 0;
  private musicStep = 0;

  // --- hud animation --------------------------------------------------------
  private scorePunch = 1;
  private chainPunch = 1;
  private chainTilt = 0;
  private shownScore = 0;
  private cardT = 0;
  private cardText = "";
  private cardSub = "";
  private threadT = 0;
  private recordT = 0;
  private recordFired = false;
  private hintPulse = 0;

  private shX = new Float32Array(8);
  private shY = new Float32Array(8);
  private shVX = new Float32Array(8);
  private shVY = new Float32Array(8);
  private shR = new Float32Array(8);
  private shVR = new Float32Array(8);
  private shLife = 0;
  private shText = "";
  private hudS = 1;

  private autoIdx = 0;
  private lastScore = -1;
  private lastLabel = "";
  private lastStatus = "";

  constructor(ctx: GameContext) {
    this.c = ctx;
    this.best = ctx.store.best("best") ?? 0;
    this.bestChain = ctx.store.get<number>("bestChain", 0);
    this.initThree();
    this.buildAttract();
    ctx.report({ status: "idle", score: 0, best: this.best });
  }

  // --- setup ----------------------------------------------------------------

  private initThree() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.c.canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(this.c.dpr);
    this.renderer.setSize(Math.max(1, this.c.width), Math.max(1, this.c.height), false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setClearColor(0x02030a, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.2, 4000);

    this.glowTex = glowTexture(128, 1.6);
    this.ringTex = ringTexture(256, 0.06);
    this.partTex = glowTexture(64, 2.2);

    this.buildSky();
    this.buildWorld();
    this.buildPools();
    this.buildRig();

    // Exactly two lights, and they only touch the two Lambert pools. They are
    // the only reason the spire is a faceted solid and not a black rectangle.
    this.key = new THREE.DirectionalLight(0xffb070, 1.3);
    this.key.position.set(-8, 4, 6);
    this.scene.add(this.key);
    this.scene.add(new THREE.HemisphereLight(0x4a7cc8, 0x0a0d18, 0.6));

    this.post = makePost(this.renderer, this.scene, this.camera, {
      strength: 0.85,
      radius: 0.62,
      threshold: 0.35,
    });
    this.hud = new Overlay();
    this.ready = true;
  }

  private buildSky() {
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        c0: { value: new THREE.Color(SKY_LOW[0]) },
        c1: { value: new THREE.Color(SKY_LOW[1]) },
        c2: { value: new THREE.Color(SKY_LOW[2]) },
        c3: { value: new THREE.Color(SKY_LOW[3]) },
        sunDir: { value: new THREE.Vector3(0.62, 0.1, -0.78).normalize() },
        sunCol: { value: hdr(0xffb070, 1.5) },
        sunAmt: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 c0; uniform vec3 c1; uniform vec3 c2; uniform vec3 c3;
        uniform vec3 sunDir; uniform vec3 sunCol; uniform float sunAmt;
        varying vec3 vDir;
        void main() {
          float hgt = vDir.y * 0.5 + 0.5;
          vec3 col = mix(c0, c1, smoothstep(0.30, 0.48, hgt));
          col = mix(col, c2, smoothstep(0.48, 0.62, hgt));
          col = mix(col, c3, smoothstep(0.62, 0.96, hgt));
          float s = max(0.0, dot(vDir, sunDir));
          col += sunCol * pow(s, 40.0) * sunAmt;
          col += sunCol * pow(s, 5.0) * sunAmt * 0.10;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1400, 32, 24), this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -20;
    this.scene.add(this.sky);
  }

  private buildWorld() {
    // Ground grid — the only thing telling you how high you started.
    this.groundMat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 1 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        varying vec2 vUv;
        void main() {
          vec2 g = fract(vUv * 110.0);
          float lx = smoothstep(0.0, 0.05, g.x) * smoothstep(0.0, 0.05, 1.0 - g.x);
          float ly = smoothstep(0.0, 0.05, g.y) * smoothstep(0.0, 0.05, 1.0 - g.y);
          float line = 1.0 - min(lx, ly);
          float r = length(vUv - 0.5) * 2.0;
          float fade = smoothstep(1.0, 0.08, r);
          vec3 col = vec3(0.13, 0.44, 0.78) * line + vec3(0.03, 0.07, 0.14);
          float a = (line * 0.85 + 0.12) * fade * uOpacity;
          if (a <= 0.001) discard;
          gl_FragColor = vec4(col, a);
        }
      `,
      transparent: true,
      depthWrite: false,
    });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(520, 520), this.groundMat);
    this.ground.rotation.x = -HALF_PI;
    this.ground.position.y = -0.6;
    this.scene.add(this.ground);

    // Fog sea: mass, not light. Deliberately kept under 1.0 so bloom ignores it.
    this.fogMat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0 }, uCol: { value: this.cCloud.clone() } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform float uOpacity; uniform vec3 uCol;
        varying vec2 vUv;
        void main() {
          float r = length(vUv - 0.5) * 2.0;
          float a = smoothstep(1.0, 0.05, r) * uOpacity;
          if (a <= 0.002) discard;
          gl_FragColor = vec4(uCol, a);
        }
      `,
      transparent: true,
      depthWrite: false,
    });
    this.fog = new THREE.Mesh(new THREE.PlaneGeometry(700, 700), this.fogMat);
    this.fog.rotation.x = -HALF_PI;
    this.fog.position.y = 13;
    this.fog.visible = false;
    this.scene.add(this.fog);

    // Planet: surface meets the tower base, so the horizon curve appears
    // naturally once the camera is a hundred units up.
    this.planetMat = new THREE.ShaderMaterial({
      uniforms: {
        uOpacity: { value: 0 },
        uBase: { value: new THREE.Color(0.012, 0.028, 0.062) },
        uRim: { value: hdr(0x5cc8ff, 2.2) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV;
        void main() {
          vN = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uOpacity; uniform vec3 uBase; uniform vec3 uRim;
        varying vec3 vN; varying vec3 vV;
        void main() {
          float f = pow(1.0 - clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0), 3.0);
          gl_FragColor = vec4(uBase + uRim * f, uOpacity);
        }
      `,
      transparent: true,
    });
    this.planet = new THREE.Mesh(new THREE.SphereGeometry(900, 96, 48), this.planetMat);
    this.planet.position.y = -900;
    this.planet.visible = false;
    this.scene.add(this.planet);

    // Aurora ribbons, unlocked in the exosphere.
    this.auroraMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 0 },
        uA: { value: hdr(0x2bff9e, 1.4) },
        uB: { value: hdr(0xff4fd0, 1.2) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform float uOpacity; uniform vec3 uA; uniform vec3 uB;
        varying vec2 vUv;
        void main() {
          float wob = sin(vUv.x * 6.0 + uTime * 0.5) * 0.13
                    + sin(vUv.x * 14.0 - uTime * 0.31) * 0.05;
          float d = abs(vUv.y - 0.5 - wob);
          float a = smoothstep(0.26, 0.0, d);
          a *= smoothstep(0.0, 0.14, vUv.x) * smoothstep(1.0, 0.86, vUv.x);
          a *= 0.6 + 0.4 * sin(vUv.x * 22.0 + uTime * 1.1);
          vec3 col = mix(uA, uB, vUv.x);
          gl_FragColor = vec4(col * a * uOpacity, 1.0);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(760, 210), this.auroraMat);
      m.position.set(0, 150 + i * 90, -320 - i * 160);
      m.rotation.y = (i - 1) * 0.55;
      m.visible = false;
      this.aurora.push(m);
      this.scene.add(m);
    }

    // Stars: Points legitimately read a per-VERTEX colour attribute, so
    // vertexColors is correct here (the InstancedMesh trap does not apply).
    const count = 1800;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const rng = this.c.rng;
    for (let i = 0; i < count; i++) {
      const u = rng.range(-1, 1);
      const t = rng.angle();
      const r = Math.sqrt(1 - u * u);
      const rad = rng.range(900, 1280);
      pos[i * 3] = Math.cos(t) * r * rad;
      pos[i * 3 + 1] = u * rad;
      pos[i * 3 + 2] = Math.sin(t) * r * rad;
      const g = rng.range(1.1, 2.4);
      const warm = rng.range(0.86, 1);
      col[i * 3] = g;
      col[i * 3 + 1] = g * warm;
      col[i * 3 + 2] = g * rng.range(0.9, 1.05);
    }
    const sgeo = new THREE.BufferGeometry();
    sgeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    sgeo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    this.starMat = new THREE.PointsMaterial({
      size: 2.4,
      sizeAttenuation: false,
      vertexColors: true,
      map: this.partTex,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.stars = new THREE.Points(sgeo, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -15;
    this.stars.visible = false;
    this.scene.add(this.stars);
  }

  private buildPools() {
    this.bodies = new InstancePool(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      MAX_SLABS + 2,
    );
    this.scene.add(this.bodies.mesh);

    this.plates = new InstancePool(
      new THREE.BoxGeometry(1, 0.06, 1),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
      MAX_SLABS + 2,
    );
    this.scene.add(this.plates.mesh);

    this.debrisPool = new InstancePool(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      MAX_DEBRIS,
    );
    this.scene.add(this.debrisPool.mesh);

    this.streaks = new InstancePool(
      new THREE.BoxGeometry(0.05, 0.05, 1),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
      MAX_STREAKS,
    );
    this.scene.add(this.streaks.mesh);

    this.ringPool = new InstancePool(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        map: this.ringTex,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        side: THREE.DoubleSide,
      }),
      MAX_RINGS,
    );
    this.scene.add(this.ringPool.mesh);

    this.cloudPool = new InstancePool(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        map: this.glowTex,
        transparent: true,
        depthWrite: false,
        opacity: 1,
      }),
      MAX_CLOUDS,
    );
    this.cloudPool.mesh.renderOrder = -5;
    this.scene.add(this.cloudPool.mesh);

    this.parts = new Particles(3000, this.partTex);
    this.scene.add(this.parts.object);

    const rng = this.c.rng;
    for (let i = 0; i < MAX_STREAKS; i++) {
      this.wx[i] = rng.range(-60, 60);
      this.wy[i] = rng.range(-30, 30);
      this.wz[i] = rng.range(-55, 55);
    }
    for (let i = 0; i < MAX_CLOUDS; i++) {
      const upper = i >= MAX_CLOUDS / 2;
      this.clx[i] = rng.range(-190, 190);
      this.cly[i] = upper ? rng.range(46, 74) : rng.range(15, 34);
      this.clz[i] = rng.range(-190, 190);
      this.clw[i] = rng.range(26, 62);
      this.clh[i] = rng.range(7, 17);
    }
  }

  private buildRig() {
    const railMat = new THREE.MeshBasicMaterial({
      color: hdr(0xfff0b0, 3.2),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.railA = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), railMat);
    this.railB = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), railMat);
    this.scene.add(this.railA, this.railB);

    this.beam = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({
        color: hdr(0x59f0ff, 1.1),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        opacity: 0.5,
      }),
    );
    this.scene.add(this.beam);

    this.arm = new THREE.Mesh(
      new THREE.BoxGeometry(1, 0.16, 0.44),
      new THREE.MeshBasicMaterial({ color: hdr(0x2c4a7a, 0.9) }),
    );
    this.scene.add(this.arm);

    this.cable = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 1, 0.06),
      new THREE.MeshBasicMaterial({ color: hdr(0x8fd0ff, 1.2) }),
    );
    this.scene.add(this.cable);
  }

  // --- derived quantities ---------------------------------------------------

  private get topY() {
    return this.n > 0 ? this.sy[this.n - 1] + SLAB_H * 0.5 : 0;
  }
  private get axis() {
    return this.placed & 1;
  }
  private get topW() {
    return this.axis === 0 ? this.sw[this.n - 1] : this.sd[this.n - 1];
  }
  private get period() {
    return 0.72 + 1.28 * Math.pow(0.5, this.placed / 42);
  }
  private get tol() {
    return clamp(0.085 * this.topW, 0.3, 0.85);
  }
  private get mult() {
    return 1 + this.chain * 0.5;
  }

  /** Wind bends the whole spire; render and gameplay share this curve. */
  private bendX(y: number) {
    const t = clamp01(y / Math.max(8, this.topY));
    return this.swayX * Math.pow(t, 1.5);
  }
  private bendZ(y: number) {
    const t = clamp01(y / Math.max(8, this.topY));
    return this.swayZ * Math.pow(t, 1.5);
  }

  private heatColor(t: number, out: THREE.Color) {
    const f = clamp01(t) * 4;
    const i = Math.min(3, Math.floor(f));
    return out.copy(HEAT_COLORS[i]).lerp(HEAT_COLORS[i + 1], f - i);
  }

  // --- lifecycle ------------------------------------------------------------

  private buildAttract() {
    const rng = this.c.rng;
    this.n = 1;
    this.sx[0] = 0;
    this.sz[0] = 0;
    this.sw[0] = START_SIZE;
    this.sd[0] = START_SIZE;
    this.sy[0] = SLAB_H * 0.5;
    this.sPerf[0] = 0;
    this.sHeat[0] = 0;

    let px = 0;
    let pz = 0;
    let w = START_SIZE;
    let d = START_SIZE;
    let ch = 0;
    for (let i = 1; i < 46; i++) {
      const ax = (i - 1) & 1;
      const perfect = rng.next() < 0.66 || (ax === 0 ? w : d) < 4.2;
      const off = perfect ? 0 : rng.range(0.5, 1.5) * rng.sign();
      if (perfect) {
        ch++;
        if (ax === 0) w = Math.min(MAX_SIZE, w + 0.24);
        else d = Math.min(MAX_SIZE, d + 0.24);
      } else {
        ch = 0;
        if (ax === 0) {
          w = Math.max(2.4, w - Math.abs(off));
          px += off * 0.5;
        } else {
          d = Math.max(2.4, d - Math.abs(off));
          pz += off * 0.5;
        }
      }
      this.sx[i] = px;
      this.sz[i] = pz;
      this.sw[i] = w;
      this.sd[i] = d;
      this.sy[i] = SLAB_H * (i + 0.5);
      this.sPerf[i] = perfect ? 1 : 0;
      this.sHeat[i] = clamp01(ch / 16);
      this.n = i + 1;
    }

    this.phase = "attract";
    this.placed = 45;
    this.chain = 6;
    this.heat = clamp01(this.chain / 16);
    this.score = 4200;
    this.shownScore = 4200;
    this.camY = this.topY + 3;
    this.camLookY = this.topY + 1.2;
    this.camBase = 0;
    this.camOrbit = this.camOrbitTarget = this.placed * HALF_PI;
    this.cranePhase = 1.1;
    this.dropping = false;
    this.armT = 0;
    this.autoIdx = 0;
    this.updateBand();
  }

  restart() {
    this.reset(false);
  }

  /**
   * `keepFx` exists because the attract-to-run transition spawns its debris
   * and its 200-particle burst BEFORE the reset — wiping them here would make
   * the one moment that has to feel violent invisible.
   */
  private reset(keepFx: boolean) {
    this.n = 1;
    this.sx[0] = 0;
    this.sz[0] = 0;
    this.sw[0] = START_SIZE;
    this.sd[0] = START_SIZE;
    this.sy[0] = SLAB_H * 0.5;
    this.sPerf[0] = 0;
    this.sHeat[0] = 0;

    this.phase = "playing";
    this.placed = 0;
    this.score = 0;
    this.shownScore = 0;
    this.chain = 0;
    this.peakChain = 0;
    this.heat = 0;
    this.tSim = 0;
    this.dieT = 0;
    this.dropping = false;
    this.armT = 0;
    this.cranePhase = 0;
    if (!keepFx) {
      this.rCount = 0;
      this.dCount = 0;
      this.parts.clear();
      this.warp.reset();
    }
    this.gustT = 11;
    this.gustActive = 0;
    this.gustWarn = 0;
    this.recordFired = false;
    this.recordT = 0;
    this.threadT = 0;
    this.shLife = 0;
    this.desat = this.desatTarget = 0;
    this.slowLock = 0;
    this.camDistTarget = CAM_DIST;
    this.fovTarget = BASE_FOV;
    // Rebase rather than reset, so the dive to ground level does not also
    // spin the camera through seventy radians.
    this.camBase = Math.round(this.camOrbit / Math.PI) * Math.PI;
    this.camOrbitTarget = this.camBase;
    this.camRush = 0.5;
    this.updateBand();
    this.cardT = 1.1;
    this.cardText = BAND_NAME[0];
    this.cardSub = "STACK";
    this.c.report({ status: "playing", score: 0, best: this.best });
  }

  private startRun() {
    // The attract tower blows apart so the first click can never read as
    // "nothing happened".
    const top = Math.max(1, this.n - MAX_DEBRIS);
    for (let i = this.n - 1; i >= top; i--) {
      const y = this.sy[i];
      const a = this.c.rng.angle();
      this.spawnDebris(
        this.sx[i] + this.bendX(y),
        y,
        this.sz[i] + this.bendZ(y),
        this.sw[i],
        SLAB_H * 0.92,
        this.sd[i],
        Math.cos(a) * this.c.rng.range(6, 22),
        this.c.rng.range(2, 16),
        Math.sin(a) * this.c.rng.range(6, 22),
      );
    }
    this.heatColor(this.heat, this.cA);
    this.parts.burst(200, 0, this.topY * 0.6, 0, 26, {
      life: 1.1,
      size: 0.5,
      endSize: 0,
      color: this.cA,
      endColor: hdr(0xff6a2a, 1.4, this.cB),
      gravity: -12,
      drag: 0.5,
    });
    this.shake.add(0.9);
    this.warp.hitStop(0.12);
    this.c.audio.explode(0.4);
    this.c.audio.play({
      wave: "sawtooth",
      freq: 60,
      freqTo: 210,
      glide: 0.3,
      vol: 0.22,
      attack: 0.005,
      hold: 0.09,
      release: 0.32,
      filter: 1800,
    });
    this.reset(true);
  }

  // --- update ---------------------------------------------------------------

  update(dtReal: number) {
    if (!this.ready) return;
    this.tReal += dtReal;
    const dt = this.warp.step(dtReal);
    this.tSim += dt;
    this.shake.update(dtReal);

    const drop = this.readDrop();
    this.stepHud(dtReal);
    this.stepCamera(dtReal);
    this.music(dtReal);

    if (this.phase === "dying") {
      this.dieT += dtReal;
      this.stepDebris(dt);
      this.stepRings(dt);
      this.parts.update(dt);
      this.stepAmbient(dt, dtReal);
      if (drop && this.dieT > 0.25) this.dieT = 1.6;
      if (this.dieT >= 1.6) {
        this.phase = "dead";
        this.c.report({
          status: "over",
          score: Math.round(this.score),
          best: this.best,
          label: `${fmt(this.topY)}m`,
        });
      }
      this.publish();
      return;
    }

    if (this.phase === "dead") {
      this.dieT += dtReal;
      this.stepDebris(dt);
      this.stepRings(dt);
      this.parts.update(dt);
      this.stepAmbient(dt, dtReal);
      if (drop && this.dieT > 1.85) this.restart();
      this.publish();
      return;
    }

    if (this.phase === "attract" && drop) {
      this.startRun();
      return;
    }

    this.stepWind(dt);
    this.stepCrane(dt, drop);
    this.stepFall(dt);
    this.stepDebris(dt);
    this.stepRings(dt);
    this.stepAmbient(dt, dtReal);
    this.parts.update(dt);
    if (this.slowLock > 0) this.slowLock -= dtReal;
    this.publish();
  }

  /** Every input path OR'd into one edge, read exactly once per fixed step. */
  private readDrop(): boolean {
    const i = this.c.input;
    return (
      i.pointer.justDown ||
      i.confirmPressed ||
      i.wasPressed("ArrowDown", "KeyS")
    );
  }

  private stepWind(dt: number) {
    this.wind = 0.25 + Math.min(1.6, this.placed * 0.013);

    if (this.gustActive > 0) {
      this.gustActive -= dt;
    } else if (this.gustWarn > 0) {
      this.gustWarn -= dt;
      if (this.gustWarn <= 0) {
        this.gustActive = lerp(1.5, 2.2, clamp01(this.placed / 140));
        this.c.audio.play({
          wave: "sawtooth",
          freq: 90,
          freqTo: 40,
          glide: 0.6,
          vol: 0.12,
          attack: 0.05,
          hold: 0.2,
          release: 0.5,
          filter: 700,
        });
      }
    } else {
      this.gustT -= dt;
      if (this.gustT <= 0) {
        this.gustT = lerp(11, 6, clamp01(this.placed / 140));
        this.gustWarn = 1;
        // Telegraph: a rising tone a full second before the gust bites.
        this.c.audio.play({
          wave: "sine",
          freq: 130,
          freqTo: 420,
          glide: 0.9,
          vol: 0.1,
          attack: 0.15,
          hold: 0.5,
          release: 0.3,
          filter: 1200,
        });
      }
    }

    const gust = this.gustActive > 0 ? 0.5 : this.gustWarn > 0 ? (1 - this.gustWarn) * 0.2 : 0;
    this.swayMag = Math.max(0, this.wind - 0.22) * 0.42 + gust;
    this.swayX = this.swayMag * Math.sin(this.tSim * 0.9 + 0.4);
    this.swayZ = this.swayMag * Math.sin(this.tSim * 0.63 + 2.1);
  }

  private stepCrane(dt: number, drop: boolean) {
    const w = this.topW;
    this.craneAmp = 0.55 * (w + 2.5);
    this.cranePhase += (TAU / this.period) * dt;
    if (this.cranePhase > TAU * 64) this.cranePhase -= TAU * 64;
    this.cranePrev = this.cranePos;
    this.cranePos = this.craneCenter() + this.craneAmp * Math.sin(this.cranePhase);

    if (this.armT < 0) {
      this.armT += dt;
      return;
    }
    this.armT += dt;

    const target = this.targetWorld();

    // Two pre-roll ticks per approach: this is an anticipation problem with a
    // steady period, not a reaction test.
    const dNow = Math.abs(this.cranePos - target) / Math.max(0.01, this.craneAmp);
    const dPrev = Math.abs(this.cranePrev - target) / Math.max(0.01, this.craneAmp);
    if (dPrev > 0.55 && dNow <= 0.55 && !this.tickHi) {
      this.c.audio.tick(0.05);
      this.tickHi = true;
      this.tickLo = false;
    }
    if (dPrev > 0.25 && dNow <= 0.25 && !this.tickLo) {
      this.c.audio.tick(0.05);
      this.tickLo = true;
    }
    if (dNow > 0.6) {
      this.tickHi = false;
      this.tickLo = false;
    }

    if (this.dropping) return;

    if (this.phase === "attract") {
      const script = [0, 0, 0, 0, 0, 0, 0, 0, 2.1, 0, 0, 0, 1.5, 0, 0, 0, 0, 2.6, 0, 0];
      let err = script[this.autoIdx % script.length];
      if (w - err < 2.6) err = 0;
      const mid = this.craneCenter();
      const aim = clamp(target + err, mid - this.craneAmp * 0.9, mid + this.craneAmp * 0.9);
      if ((this.cranePrev - aim) * (this.cranePos - aim) <= 0) {
        this.autoIdx++;
        this.release();
      }
      return;
    }

    if (drop) this.release();
  }

  /** World position, on the active axis, that the falling slab must match. */
  private targetWorld() {
    const y = this.topY;
    const i = this.n - 1;
    return this.axis === 0 ? this.sx[i] + this.bendX(y) : this.sz[i] + this.bendZ(y);
  }

  /**
   * The arc is centred on the tower's UNBENT top, never on the world origin:
   * a tower that has drifted sideways over fifty slabs must still be
   * reachable. The wind bend is deliberately left out, so a gust really does
   * pull the landing zone off the centre of the swing.
   */
  private craneCenter() {
    const i = this.n - 1;
    return this.axis === 0 ? this.sx[i] : this.sz[i];
  }

  private release() {
    const i = this.n - 1;
    this.dropping = true;
    this.fallY = this.topY + DROP_H;
    this.fallV = -FALL_V0;
    this.fallPos = this.cranePos;
    // The verdict is locked the instant you click. Judging it 0.24s later,
    // after the wind has moved the tower, would steal perfects you earned.
    this.fallOffset = this.cranePos - this.targetWorld();
    this.fallOther =
      this.axis === 0
        ? this.sz[i] + this.bendZ(this.topY)
        : this.sx[i] + this.bendX(this.topY);
    this.fallW = this.sw[i];
    this.fallD = this.sd[i];
    this.armT = 0;
    this.c.audio.whoosh(0.16);
  }

  private stepFall(dt: number) {
    if (!this.dropping) return;
    this.fallV -= FALL_G * dt;
    this.fallY += this.fallV * dt;
    // topY is the top SURFACE; a slab's stored y is its CENTRE.
    const landY = this.topY + SLAB_H * 0.5;
    if (this.fallY <= landY) {
      this.fallY = landY;
      this.dropping = false;
      this.land();
    }
  }

  // --- landing --------------------------------------------------------------

  private land() {
    const i = this.n - 1;
    const ax = this.axis;
    const offset = this.fallOffset;
    const w = this.topW;
    const overlap = w - Math.abs(offset);
    const tol = this.tol;
    /** The contact plane — where the flare belongs. */
    const seamY = this.topY;
    /** Centre of the slab that is about to exist. */
    const newY = this.topY + SLAB_H * 0.5;
    const seamX = ax === 0 ? this.fallPos : this.fallOther;
    const seamZ = ax === 0 ? this.fallOther : this.fallPos;

    if (overlap <= MIN_OVERLAP) {
      // The attract run is never allowed to end — it just quietly rebuilds.
      if (this.phase === "attract") this.buildAttract();
      else this.die(seamX, seamY, seamZ, offset, ax);
      return;
    }

    const perfect = Math.abs(offset) <= tol;
    const gale = perfect && this.gustActive > 0;

    // The tower is stored in local space and the wind bend is a shared render
    // curve, so local coordinates stay stable while the whole spire sways.
    let newLocal: number;
    let newW = this.sw[i];
    let newD = this.sd[i];

    if (perfect) {
      newLocal = ax === 0 ? this.sx[i] : this.sz[i];
      const grow = 0.18 + 0.03 * Math.min(this.chain, 10);
      if (ax === 0) newW = Math.min(MAX_SIZE, newW + grow);
      else newD = Math.min(MAX_SIZE, newD + grow);
      this.chain += gale ? 2 : 1;
    } else {
      newLocal = (ax === 0 ? this.sx[i] : this.sz[i]) + offset * 0.5;
      if (ax === 0) newW = overlap;
      else newD = overlap;
      this.shearOff(offset, ax, newY, overlap);
      this.breakChain();
    }

    // Only one axis is ever live; the other inherits the tower exactly.
    const idx = this.n;
    this.sx[idx] = ax === 0 ? newLocal : this.sx[i];
    this.sz[idx] = ax === 0 ? this.sz[i] : newLocal;
    this.sw[idx] = newW;
    this.sd[idx] = newD;
    this.sy[idx] = this.sy[i] + SLAB_H;
    this.sPerf[idx] = perfect ? 1 : 0;
    this.sHeat[idx] = this.heat;
    this.n++;
    this.placed++;

    if (this.n >= MAX_SLABS) this.dropBottom(80);

    // Heat snaps UP on a perfect but is only ever allowed to fall off slowly,
    // so a break makes you watch the whole tower cool back down to cyan.
    const wantHeat = clamp01(this.chain / 16);
    if (wantHeat > this.heat) this.heat = wantHeat;
    if (this.chain > this.peakChain) this.peakChain = this.chain;
    const gain = Math.round(25 * this.mult * (1 + this.placed * 0.02)) * (gale ? 2 : 1);
    this.score += gain;
    this.scorePunch = 1.28;

    this.camOrbitTarget = this.camBase + this.placed * HALF_PI;
    this.armT = perfect ? 0 : -0.18;
    this.tickHi = false;
    this.tickLo = false;

    if (perfect) this.onPerfect(seamX, seamY, seamZ, gale, newW, newD);
    else this.onSloppy(seamX, seamY, seamZ);

    this.checkBand();
    this.checkRecord();
  }

  private onPerfect(
    x: number,
    y: number,
    z: number,
    gale: boolean,
    newW: number,
    newD: number,
  ) {
    const a = this.c.audio;
    this.warp.hitStop(0.075);
    this.shake.add(0.28);
    this.fovTarget = BASE_FOV + 5;
    this.chainPunch = 1.35;
    this.chainTilt = (this.chain & 1 ? 1 : -1) * 0.06;

    const ringCol = gale ? hdr(0xff9a30, 3.6, this.cA) : hdr(0xfff0b0, 4, this.cA);
    this.spawnRing(y, ringCol, Math.max(newW, newD), 46, 0);

    this.heatColor(this.heat, this.cB);
    const r = Math.max(newW, newD) * 0.5;
    for (let k = 0; k < 40; k++) {
      const t = (k / 40) * TAU;
      const sp = 9 + Math.random() * 7;
      this.parts.spawn({
        x: x + Math.cos(t) * r * 0.6,
        y: y + 0.12,
        z: z + Math.sin(t) * r * 0.6,
        vx: Math.cos(t) * sp,
        vy: Math.random() * 2.5,
        vz: Math.sin(t) * sp,
        life: 0.6,
        size: 0.42,
        endSize: 0,
        color: ringCol,
        endColor: this.cB,
        drag: 0.16,
      });
    }

    const semis = Math.min(this.chain, 24);
    a.play({
      wave: "triangle",
      freq: 392 * Math.pow(2, semis / 12),
      vol: 0.2,
      attack: 0.002,
      hold: 0.05,
      release: 0.22,
      filter: 5200,
    });
    a.thud(0.24);
    if (gale) a.blip(880 * Math.pow(2, semis / 24), 0.14);

    // REFORGE — the every-eighth-perfect payoff.
    if (this.chain > 0 && this.chain % 8 === 0) this.reforge(x, y, z);
    else if (this.chain === 4 || this.chain === 12 || this.chain === 20) {
      this.spawnRing(y, hdr(0xffffff, 4.5, this.cA), Math.max(newW, newD), 60, 0);
      a.powerUp(0.16);
    }

    // THREAD THE NEEDLE — a perfect landed while the platform is nearly gone.
    if (Math.min(newW, newD) <= 2.4 && this.slowLock <= 0) {
      this.slowLock = 3;
      this.warp.slowMo(0.7, 0.22);
      this.desatTarget = 0.55;
      this.fovTarget = 42;
      this.threadT = 0.9;
      this.spawnRing(y, hdr(0xffffff, 5, this.cA), Math.max(newW, newD), 120, 0);
      a.play({
        wave: "sine",
        freq: 34,
        vol: 0.34,
        attack: 0.004,
        hold: 0.22,
        release: 0.5,
      });
    }
  }

  private reforge(x: number, y: number, z: number) {
    const a = this.c.audio;
    this.warp.hitStop(0.12);
    if (this.slowLock <= 0) {
      this.slowLock = 2.4;
      this.warp.slowMo(0.45, 0.4);
    }
    this.shake.add(0.75);
    const i = this.n - 1;
    this.sw[i] = Math.min(MAX_SIZE, this.sw[i] + 1.2);
    this.sd[i] = Math.min(MAX_SIZE, this.sd[i] + 1.2);
    this.score += 100 * this.chain;
    this.scorePunch = 1.5;
    this.flashR = 0.55;
    this.flashG = 0.55;
    this.flashB = 0.55;
    this.cardT = 1.05;
    this.cardText = "REFORGE";
    this.cardSub = `+${fmt(100 * this.chain)}`;

    for (let k = 0; k < 8; k++) {
      this.spawnRing(y, hdr(0xfff2c0, 4.6, this.cA), MAX_SIZE, 52 + k * 3, k * 0.045);
    }
    this.parts.burst(140, x, y + 0.6, z, 22, {
      life: 0.95,
      size: 0.55,
      endSize: 0,
      color: hdr(0xffffff, 5, this.cA),
      endColor: hdr(0xff8a1e, 2.4, this.cB),
      drag: 0.2,
    });
    [0, 4, 7, 12].forEach((s, k) =>
      a.play({
        wave: "square",
        freq: 330 * Math.pow(2, s / 12),
        vol: 0.17,
        attack: 0.002,
        hold: 0.05,
        release: 0.16,
        delay: k * 0.06,
        filter: 4200,
      }),
    );
    a.play({
      wave: "sine",
      freq: 48,
      freqTo: 28,
      glide: 0.3,
      vol: 0.36,
      attack: 0.003,
      hold: 0.12,
      release: 0.4,
    });
  }

  private onSloppy(x: number, y: number, z: number) {
    this.warp.hitStop(0.04);
    this.shake.add(0.5);
    this.c.audio.hit(0.24);
    this.parts.burst(24, x, y, z, 8, {
      life: 0.5,
      size: 0.3,
      endSize: 0,
      color: new THREE.Color(0.8, 0.75, 0.72),
      gravity: -22,
      drag: 0.3,
    });
  }

  /** The overhang shears off and tumbles end-over-end past the lens. */
  private shearOff(offset: number, ax: number, seamY: number, overlap: number) {
    const i = this.n - 1;
    const cut = Math.abs(offset);
    const sgn = Math.sign(offset) || 1;
    // Centre of the sheared piece: past the far edge of the surviving overlap.
    const edge = (ax === 0 ? this.sx[i] : this.sz[i]) + sgn * (overlap * 0.5 + cut);
    const bx = this.bendX(seamY);
    const bz = this.bendZ(seamY);
    const px = ax === 0 ? edge + bx : this.sx[i] + bx;
    const pz = ax === 0 ? this.sz[i] + bz : edge + bz;
    this.spawnDebris(
      px,
      seamY,
      pz,
      ax === 0 ? cut : this.sw[i],
      SLAB_H * 0.92,
      ax === 0 ? this.sd[i] : cut,
      ax === 0 ? sgn * 5.5 : 0,
      2.5,
      ax === 0 ? 0 : sgn * 5.5,
    );
  }

  private breakChain() {
    if (this.chain <= 0) return;
    const a = this.c.audio;
    this.shText = `×${this.chain}`;
    this.shLife = 0.42;
    // Shatter from exactly where the number is drawn.
    const cx = this.w - 46 * this.hudS;
    const cy = this.h * 0.34;
    for (let k = 0; k < 8; k++) {
      const ang = (k / 8) * TAU + 0.3;
      this.shX[k] = cx;
      this.shY[k] = cy;
      this.shVX[k] = Math.cos(ang) * 260;
      this.shVY[k] = Math.sin(ang) * 260 - 90;
      this.shR[k] = 0;
      this.shVR[k] = (Math.random() * 2 - 1) * 9;
    }
    this.chain = 0;
    this.desatTarget = 0.4;
    this.flashR = 0.3;
    this.flashG = 0.04;
    this.flashB = 0.07;
    const y = this.topY;
    this.parts.burst(60, this.bendX(y), y, this.bendZ(y), 12, {
      life: 0.8,
      size: 0.4,
      endSize: 0,
      color: hdr(0xff2a4d, 1.8, this.cA),
      endColor: new THREE.Color(0.25, 0.22, 0.24),
      gravity: -18,
      drag: 0.5,
    });
    [0, -3, -7].forEach((s, k) =>
      a.play({
        wave: "sawtooth",
        freq: 220 * Math.pow(2, s / 12),
        vol: 0.16,
        attack: 0.004,
        hold: 0.09,
        release: 0.24,
        delay: k * 0.045,
        filter: 1400,
        filterTo: 380,
        jitter: 25,
      }),
    );
    a.play({
      wave: "noise",
      freq: 1400,
      freqTo: 300,
      vol: 0.16,
      attack: 0.002,
      hold: 0.06,
      release: 0.3,
      filter: 3000,
      filterType: "highpass",
    });
  }

  private die(x: number, y: number, z: number, offset: number, ax: number) {
    this.phase = "dying";
    this.dieT = 0;
    this.warp.hitStop(0.35);
    this.shake.add(1);
    this.desatTarget = 0.72;
    this.fovTarget = 62;
    this.spawnDebris(
      x,
      y,
      z,
      this.fallW,
      SLAB_H * 0.92,
      this.fallD,
      ax === 0 ? Math.sign(offset) * 10 : 0,
      3,
      ax === 0 ? 0 : Math.sign(offset) * 10,
    );
    this.parts.burst(150, x, y, z, 18, {
      life: 1.2,
      size: 0.5,
      endSize: 0,
      color: hdr(0xff5a2a, 2.2, this.cA),
      endColor: new THREE.Color(0.2, 0.18, 0.2),
      gravity: -16,
      drag: 0.4,
    });
    this.c.audio.explode(0.45);
    this.c.audio.fail(0.22);
    if (this.score > this.best) {
      this.best = Math.round(this.score);
      this.c.store.set("best", this.best);
    }
    if (this.bestChain < this.peakChain) {
      this.bestChain = this.peakChain;
      this.c.store.set("bestChain", this.bestChain);
    }
  }

  private checkRecord() {
    if (this.phase !== "playing") return;
    if (this.recordFired || this.best <= 0 || this.score <= this.best) return;
    this.recordFired = true;
    this.recordT = 2.2;
    if (this.slowLock <= 0) {
      this.slowLock = 2;
      this.warp.slowMo(0.8, 0.35);
    }
    this.warp.hitStop(0.1);
    this.shake.add(0.6);
    this.flashR = 0.5;
    this.flashG = 0.4;
    this.flashB = 0.1;
    const y = this.topY;
    for (let k = 0; k < 5; k++) {
      this.spawnRing(y, hdr(0xffd24a, 5, this.cA), MAX_SIZE, 40 + k * 8, k * 0.07);
    }
    this.parts.burst(220, this.bendX(y), y, this.bendZ(y), 24, {
      life: 1.3,
      size: 0.6,
      endSize: 0,
      color: hdr(0xffd24a, 5, this.cA),
      endColor: hdr(0xff3cc8, 2, this.cB),
      drag: 0.3,
    });
    this.c.audio.powerUp(0.24);
    this.c.audio.coin(0.2);
  }

  private updateBand() {
    let i = 0;
    while (i < BAND_N.length - 1 && this.placed >= BAND_N[i + 1]) i++;
    const lo = BAND_N[i];
    const hi = i < BAND_N.length - 1 ? BAND_N[i + 1] : lo + 60;
    this.bandT = i + clamp01((this.placed - lo) / (hi - lo));
    this.bandIdx = i;
  }

  private checkBand() {
    const prev = this.bandIdx;
    this.updateBand();
    if (this.bandIdx <= prev) return;
    // APEX — the reveal. Pull the camera out so the whole spire and the new
    // backdrop land in one frame.
    if (this.slowLock <= 0) {
      this.slowLock = 2.6;
      this.warp.slowMo(0.9, 0.35);
    }
    this.desatTarget = 0.25;
    this.fovTarget = 68;
    this.camDistTarget = 38;
    this.cardT = 1.6;
    this.cardText = BAND_NAME[this.bandIdx];
    this.cardSub = `${fmt(this.topY)}m`;
    this.shake.add(0.35);
    this.c.audio.play({
      wave: "sine",
      freq: 160,
      freqTo: 640,
      glide: 0.5,
      vol: 0.2,
      attack: 0.02,
      hold: 0.2,
      release: 0.5,
      filter: 2600,
    });
    this.c.audio.powerUp(0.15);
  }

  private dropBottom(k: number) {
    const arrays: Float32Array[] = [this.sx, this.sz, this.sw, this.sd, this.sy, this.sHeat];
    for (const a of arrays) a.copyWithin(0, k, this.n);
    this.sPerf.copyWithin(0, k, this.n);
    this.n -= k;
  }

  // --- moving parts ---------------------------------------------------------

  private spawnDebris(
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    vx: number,
    vy: number,
    vz: number,
  ) {
    if (this.dCount >= MAX_DEBRIS) return;
    const i = this.dCount++;
    this.dx[i] = x;
    this.dy[i] = y;
    this.dz[i] = z;
    this.dsx[i] = sx;
    this.dsy[i] = sy;
    this.dsz[i] = sz;
    this.dvx[i] = vx;
    this.dvy[i] = vy;
    this.dvz[i] = vz;
    this.drx[i] = 0;
    this.dry[i] = 0;
    this.drz[i] = 0;
    this.dwx[i] = (Math.random() * 2 - 1) * 5;
    this.dwy[i] = (Math.random() * 2 - 1) * 3;
    this.dwz[i] = (Math.random() * 2 - 1) * 5;
    this.dLife[i] = 4.5;
  }

  private stepDebris(dt: number) {
    let i = 0;
    while (i < this.dCount) {
      this.dLife[i] -= dt;
      this.dvy[i] -= 32 * dt;
      this.dx[i] += this.dvx[i] * dt;
      this.dy[i] += this.dvy[i] * dt;
      this.dz[i] += this.dvz[i] * dt;
      this.drx[i] += this.dwx[i] * dt;
      this.dry[i] += this.dwy[i] * dt;
      this.drz[i] += this.dwz[i] * dt;
      if (this.dLife[i] <= 0 || this.dy[i] < this.camY - 130) {
        const last = --this.dCount;
        if (i !== last) {
          this.dx[i] = this.dx[last];
          this.dy[i] = this.dy[last];
          this.dz[i] = this.dz[last];
          this.dvx[i] = this.dvx[last];
          this.dvy[i] = this.dvy[last];
          this.dvz[i] = this.dvz[last];
          this.drx[i] = this.drx[last];
          this.dry[i] = this.dry[last];
          this.drz[i] = this.drz[last];
          this.dwx[i] = this.dwx[last];
          this.dwy[i] = this.dwy[last];
          this.dwz[i] = this.dwz[last];
          this.dsx[i] = this.dsx[last];
          this.dsy[i] = this.dsy[last];
          this.dsz[i] = this.dsz[last];
          this.dLife[i] = this.dLife[last];
        }
        continue;
      }
      i++;
    }
  }

  private spawnRing(y: number, col: THREE.Color, radius: number, speed: number, delay: number) {
    if (this.rCount >= MAX_RINGS) return;
    const i = this.rCount++;
    // Long enough that the wave visibly reaches the bottom of a tall spire.
    const life = clamp(150 / speed, 0.9, 2.6);
    this.ry[i] = y;
    this.rv[i] = speed;
    this.rLife[i] = life;
    this.rMax[i] = life;
    this.rRad[i] = radius;
    this.rDelay[i] = delay;
    this.rCol[i * 3] = col.r;
    this.rCol[i * 3 + 1] = col.g;
    this.rCol[i * 3 + 2] = col.b;
  }

  private stepRings(dt: number) {
    let i = 0;
    while (i < this.rCount) {
      if (this.rDelay[i] > 0) {
        this.rDelay[i] -= dt;
        i++;
        continue;
      }
      this.ry[i] -= this.rv[i] * dt;
      this.rLife[i] -= dt;
      if (this.rLife[i] <= 0 || this.ry[i] < -6) {
        const last = --this.rCount;
        if (i !== last) {
          this.ry[i] = this.ry[last];
          this.rv[i] = this.rv[last];
          this.rLife[i] = this.rLife[last];
          this.rMax[i] = this.rMax[last];
          this.rRad[i] = this.rRad[last];
          this.rDelay[i] = this.rDelay[last];
          this.rCol[i * 3] = this.rCol[last * 3];
          this.rCol[i * 3 + 1] = this.rCol[last * 3 + 1];
          this.rCol[i * 3 + 2] = this.rCol[last * 3 + 2];
        }
        continue;
      }
      i++;
    }
  }

  private stepAmbient(dt: number, dtReal: number) {
    const intensity = clamp01(this.placed / 140);
    const speed = lerp(18, 74, intensity) * (this.gustActive > 0 ? 1.7 : 1);
    const n = Math.round(lerp(120, MAX_STREAKS, intensity));
    for (let i = 0; i < n; i++) {
      this.wx[i] += speed * dt;
      if (this.wx[i] > 62) {
        this.wx[i] -= 124;
        this.wz[i] = (Math.random() * 2 - 1) * 55;
      }
      const rel = this.wy[i] - this.camY;
      if (rel > 34) this.wy[i] -= 68;
      else if (rel < -34) this.wy[i] += 68;
    }

    // Embers climb past the lens so the frame is never still.
    const rate = lerp(6, 28, intensity);
    this.emberAcc += dtReal * rate;
    while (this.emberAcc >= 1) {
      this.emberAcc -= 1;
      this.heatColor(this.heat, this.cA);
      this.parts.spawn({
        x: (Math.random() * 2 - 1) * 30,
        y: this.camY - 24 - Math.random() * 12,
        z: (Math.random() * 2 - 1) * 30,
        vx: (Math.random() * 2 - 1) * 2 + speed * 0.06,
        vy: 5 + Math.random() * 8,
        vz: (Math.random() * 2 - 1) * 2,
        life: 3.2,
        size: 0.16 + Math.random() * 0.2,
        endSize: 0,
        color: this.cA,
        endColor: hdr(0x59f0ff, 0.9, this.cB),
        drag: 0.85,
      });
    }

    for (let i = 0; i < MAX_CLOUDS; i++) {
      this.clx[i] += (3.5 + (i % 5)) * dt;
      if (this.clx[i] > 200) this.clx[i] -= 400;
    }
  }

  private music(dt: number) {
    const intensity = clamp01(this.placed / 140);
    const bpm = lerp(82, 130, intensity) + this.heat * 14;
    const step = 60 / bpm / 4;
    this.musicAcc += dt;
    let guard = 0;
    while (this.musicAcc >= step && guard++ < 8) {
      this.musicAcc -= step;
      const s = this.musicStep++ % 16;
      if (s % 4 === 0) {
        this.c.audio.play({
          wave: "sine",
          freq: 62,
          freqTo: 38,
          glide: 0.1,
          vol: 0.16,
          attack: 0.002,
          hold: 0.035,
          release: 0.12,
        });
      }
      if (this.heat > 0.25 && s % 2 === 1) {
        this.c.audio.play({
          wave: "noise",
          freq: 2600,
          vol: 0.04,
          attack: 0.001,
          hold: 0.005,
          release: 0.04,
          filter: 6000,
          filterType: "highpass",
        });
      }
      if (this.heat > 0.5 && s % 2 === 0) {
        const arp = [0, 3, 7, 10, 12, 7][Math.floor(this.musicStep / 2) % 6];
        this.c.audio.play({
          wave: "square",
          freq: 146 * Math.pow(2, arp / 12),
          vol: 0.035,
          attack: 0.001,
          hold: 0.012,
          release: 0.07,
          filter: 2600,
        });
      }
      if (this.heat > 0.8 && s === 0) {
        this.c.audio.play({
          wave: "sawtooth",
          freq: 73,
          vol: 0.05,
          attack: 0.2,
          hold: 0.5,
          release: 0.6,
          filter: 500,
        });
      }
    }
  }

  private stepHud(dt: number) {
    this.scorePunch = damp(this.scorePunch, 1, 0.2, dt);
    this.chainPunch = damp(this.chainPunch, 1, 0.2, dt);
    this.chainTilt = damp(this.chainTilt, 0, 0.18, dt);
    this.shownScore = damp(this.shownScore, this.score, 0.25, dt);
    this.hintPulse += dt;
    if (this.cardT > 0) this.cardT -= dt;
    if (this.threadT > 0) this.threadT -= dt;
    if (this.recordT > 0) this.recordT -= dt;
    if (this.shLife > 0) {
      this.shLife -= dt;
      for (let k = 0; k < 8; k++) {
        this.shX[k] += this.shVX[k] * dt;
        this.shY[k] += this.shVY[k] * dt;
        this.shVY[k] += 620 * dt;
        this.shR[k] += this.shVR[k] * dt;
      }
    }
    this.desatTarget = damp(this.desatTarget, 0, 0.045, dt);
    if (this.phase === "dying" || this.phase === "dead") this.desatTarget = 0.5;
    this.desat = damp(this.desat, this.desatTarget, 0.3, dt);
    this.flashR = Math.max(0, this.flashR - dt * 2.4);
    this.flashG = Math.max(0, this.flashG - dt * 2.4);
    this.flashB = Math.max(0, this.flashB - dt * 2.4);
    this.heat = damp(this.heat, clamp01(this.chain / 16), 0.022, dt);
    this.fovTarget = damp(this.fovTarget, BASE_FOV, 0.035, dt);
    this.camDistTarget = damp(this.camDistTarget, CAM_DIST, 0.03, dt);
  }

  /**
   * Camera damping lives in the fixed step, not in draw(): draw runs at the
   * display's rate, so damping there would make the camera faster on a 144Hz
   * panel than on a 60Hz one.
   */
  private stepCamera(dt: number) {
    const rate = this.camRush > 0 ? 0.3 : 0.11;
    if (this.camRush > 0) this.camRush -= dt;

    if (this.phase === "dying" || this.phase === "dead") {
      // One unbroken shot down the whole spire, then a pull-back that frames
      // the entire ragged thing you built.
      const t = clamp01(this.dieT / 1.6);
      const frame = clamp(this.topY * 0.62 + 20, 30, 170);
      let wantY: number;
      let wantDist: number;
      if (t < 0.72) {
        const k = easeInCubic(t / 0.72);
        wantY = lerp(this.topY + 3, 4, k);
        wantDist = lerp(CAM_DIST, 26, k);
        this.camLookY = lerp(this.topY, 2, k);
      } else {
        const k = easeOutCubic((t - 0.72) / 0.28);
        wantY = lerp(4, this.topY * 0.42 + 6, k);
        wantDist = lerp(26, frame, k);
        this.camLookY = lerp(2, this.topY * 0.5, k);
      }
      this.camY = damp(this.camY, wantY, 0.4, dt);
      this.camDist = damp(this.camDist, wantDist, 0.4, dt);
      this.camOrbit += dt * 0.28;
    } else {
      this.camY = damp(this.camY, this.topY + 3, rate, dt);
      this.camDist = damp(this.camDist, this.camDistTarget, 0.08, dt);
      this.camLookY = damp(this.camLookY, this.topY + 1.2, 0.12, dt);
      // Snapping 90° per drop keeps the live axis screen-horizontal. That is a
      // playability requirement — you cannot time a swing you see edge-on.
      // The attract camera orbits on its own so the world is in motion before
      // a single frame of gameplay. Folding it into the base keeps the
      // per-drop 90° snap from yanking it back.
      if (this.phase === "attract") this.camBase += dt * 0.22;
      this.camOrbitTarget = this.camBase + this.placed * HALF_PI;
      this.camOrbit = damp(this.camOrbit, this.camOrbitTarget, 0.16, dt);
    }

    this.fov = damp(this.fov, this.fovTarget, 0.16, dt);
  }

  private publish() {
    const s = this.phase === "attract" ? 0 : Math.round(this.score);
    const label = `${BAND_NAME[this.bandIdx]} · ${fmt(this.topY)}m`;
    const status =
      this.phase === "attract" ? "idle" : this.phase === "dead" ? "over" : "playing";
    if (s === this.lastScore && label === this.lastLabel && status === this.lastStatus) return;
    this.lastScore = s;
    this.lastLabel = label;
    this.lastStatus = status;
    this.c.report({
      status: status as "idle" | "playing" | "over",
      score: s,
      best: this.best,
      label,
    });
  }

  // --- render ---------------------------------------------------------------

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    if (!this.ready || w <= 0 || h <= 0) return;
    this.renderer.setSize(w, h, false);
    this.post.setSize(w, h);
    this.hud.resize(w, h, this.c.dpr);
    this.parts.setViewport(h * this.c.dpr);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  draw() {
    if (!this.ready || this.w <= 0 || this.h <= 0) return;

    this.placeCamera();
    this.syncWorld();
    this.syncTower();
    this.syncRig();
    this.syncEffects();
    this.applyGrade();

    this.shake.apply(this.camera, 0.5 + this.heat * 0.6);
    this.post.composer.render();
    this.drawHud();
    this.hud.commit(this.renderer);
  }

  private placeCamera() {
    if (Math.abs(this.camera.fov - this.fov) > 0.02) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    const lx = this.bendX(this.topY) * 0.6;
    const lz = this.bendZ(this.topY) * 0.6;
    this.camera.position.set(
      Math.sin(this.camOrbit) * this.camDist + lx,
      this.camY,
      Math.cos(this.camOrbit) * this.camDist + lz,
    );
    this.camera.lookAt(lx, this.camLookY, lz);
  }

  private syncWorld() {
    const b = this.bandT;
    this.sky.position.copy(this.camera.position);
    this.stars.position.copy(this.camera.position);

    const k = clamp01((b - 1) / 3);
    const u = this.skyMat.uniforms;
    for (let i = 0; i < 4; i++) {
      const c = u[`c${i}`].value as THREE.Color;
      c.setHex(SKY_LOW[i]).lerp(this.cA.setHex(SKY_HIGH[i]), k);
    }
    u.sunAmt.value = lerp(1, 0.35, k);
    // The key sinks as you climb, until it is lighting the spire from beneath.
    const sunY = lerp(0.12, -0.42, clamp01(b / 4));
    (u.sunDir.value as THREE.Vector3).set(0.62, sunY, -0.78).normalize();
    this.key.position.set(-8, lerp(4, -7, clamp01(b / 4)), 6);

    this.groundMat.uniforms.uOpacity.value = clamp01(1 - (b - 0.6) / 1.6);
    this.ground.visible = this.groundMat.uniforms.uOpacity.value > 0.01;

    const fogA = clamp01((b - 0.35) / 0.8) * clamp01(1 - (b - 2.4) / 1.2);
    this.fogMat.uniforms.uOpacity.value = fogA * 0.9;
    this.fog.visible = fogA > 0.01;

    const planetA = clamp01((b - 2.7) / 1.1);
    this.planetMat.uniforms.uOpacity.value = planetA;
    this.planet.visible = planetA > 0.01;

    const starA = clamp01((b - 2.4) / 1.2);
    this.starMat.opacity = starA;
    this.stars.visible = starA > 0.01;

    const auroraA = clamp01((b - 3.4) / 0.9);
    this.auroraMat.uniforms.uOpacity.value = auroraA;
    this.auroraMat.uniforms.uTime.value = this.tReal;
    for (const m of this.aurora) m.visible = auroraA > 0.01;

    // Clouds
    const cloudA = clamp01((b - 0.7) / 0.9) * clamp01(1 - (b - 3.1) / 1.1);
    this.cloudPool.mesh.visible = cloudA > 0.01;
    if (cloudA > 0.01) {
      const yaw = Math.atan2(
        this.camera.position.x,
        this.camera.position.z,
      );
      this.cA.copy(this.cCloud).multiplyScalar(cloudA);
      this.cloudPool.begin();
      for (let i = 0; i < MAX_CLOUDS; i++) {
        const dy = this.cly[i] - this.camY;
        if (dy < -140 || dy > 90) continue;
        this.cloudPool.write(
          this.clx[i],
          this.cly[i],
          this.clz[i],
          { x: this.clw[i], y: this.clh[i], z: 1 },
          this.cA,
          { x: 0, y: yaw, z: 0 },
        );
      }
      this.cloudPool.end();
    }
  }

  private syncTower() {
    const camY = this.camY;
    this.bodies.begin();
    this.plates.begin();

    for (let i = 0; i < this.n; i++) {
      const y = this.sy[i];
      if (y < camY - 74 || y > camY + 46) continue;
      const bx = this.bendX(y);
      const bz = this.bendZ(y);
      const slopeK = 1.5 * Math.pow(clamp01(y / Math.max(8, this.topY)), 0.5) / Math.max(8, this.topY);
      const rot = { x: this.swayZ * slopeK, y: 0, z: -this.swayX * slopeK };

      this.bodies.write(
        this.sx[i] + bx,
        y,
        this.sz[i] + bz,
        { x: this.sw[i], y: SLAB_H * 0.92, z: this.sd[i] },
        this.cBody,
        rot,
      );

      // Ring proximity is what makes a shockwave read as travelling DOWN the
      // spire: every plate it passes flares for a moment.
      let boost = 0;
      for (let r = 0; r < this.rCount; r++) {
        if (this.rDelay[r] > 0) continue;
        const d = Math.abs(y - this.ry[r]);
        if (d < 2.6) boost += (1 - d / 2.6) * (this.rLife[r] / this.rMax[r]) * 2.6;
      }
      if (boost > 3.2) boost = 3.2;
      const tier = clamp01(this.sHeat[i] * 0.5 + this.heat * 0.6);
      this.heatColor(tier, this.cA);
      const base = this.sPerf[i] ? 1.35 : 0.6;
      this.cA.multiplyScalar(base + boost);
      this.plates.write(
        this.sx[i] + bx,
        y + SLAB_H * 0.47,
        this.sz[i] + bz,
        { x: Math.max(0.05, this.sw[i] - 0.05), y: 1, z: Math.max(0.05, this.sd[i] - 0.05) },
        this.cA,
        rot,
      );
    }

    // The slab currently in play — falling or hanging on the crane.
    const ax = this.axis;
    const arrive = this.armT < 0 ? 0 : clamp01(this.armT / 0.1);
    // The next slab flies in WHILE the current one falls. There is never a
    // frame where the crane is empty — that is what kills the dead air the
    // whole genre suffers from.
    const showCrane = arrive > 0 && this.phase !== "dying" && this.phase !== "dead";
    if (this.dropping) {
      const px = ax === 0 ? this.fallPos : this.fallOther;
      const pz = ax === 0 ? this.fallOther : this.fallPos;
      this.bodies.write(px, this.fallY, pz, { x: this.fallW, y: SLAB_H * 0.92, z: this.fallD }, this.cBody);
      this.plates.write(
        px,
        this.fallY + SLAB_H * 0.47,
        pz,
        {
          x: Math.max(0.05, this.fallW - 0.05),
          y: 1,
          z: Math.max(0.05, this.fallD - 0.05),
        },
        hdr(0x59f0ff, 2.6, this.cA),
      );
    }
    if (showCrane) {
      const i = this.n - 1;
      const px = ax === 0 ? this.cranePos : this.sx[i] + this.bendX(this.topY);
      const pz = ax === 0 ? this.sz[i] + this.bendZ(this.topY) : this.cranePos;
      const s = 0.25 + 0.75 * easeOutQuart(arrive);
      this.bodies.write(
        px,
        this.topY + DROP_H,
        pz,
        { x: this.sw[i] * s, y: SLAB_H * 0.92 * s, z: this.sd[i] * s },
        this.cBody,
      );
      hdr(0x59f0ff, 2.2, this.cA).multiplyScalar(1 + 1.8 * (1 - arrive));
      this.plates.write(
        px,
        this.topY + DROP_H + SLAB_H * 0.47 * s,
        pz,
        { x: this.sw[i] * s, y: 1, z: this.sd[i] * s },
        this.cA,
      );
    }

    this.bodies.end();
    this.plates.end();

    // Debris
    this.debrisPool.begin();
    for (let i = 0; i < this.dCount; i++) {
      this.debrisPool.write(
        this.dx[i],
        this.dy[i],
        this.dz[i],
        { x: this.dsx[i], y: this.dsy[i], z: this.dsz[i] },
        this.cBody,
        { x: this.drx[i], y: this.dry[i], z: this.drz[i] },
      );
    }
    this.debrisPool.end();
  }

  private syncRig() {
    const live = this.phase === "attract" || this.phase === "playing";
    const ax = this.axis;
    const i = this.n - 1;
    const topSurf = this.topY + 0.06;
    const tol = this.tol;
    const cx = this.sx[i] + this.bendX(this.topY);
    const cz = this.sz[i] + this.bendZ(this.topY);

    this.railA.visible = this.railB.visible = live;
    this.beam.visible = live;
    this.arm.visible = live;
    this.cable.visible = live && !this.dropping && this.armT >= 0;

    if (!live) return;

    // Gate rails: the perfect window, drawn on the surface, active axis only.
    const t = 0.9 + Math.sin(this.tReal * 8) * 0.25;
    for (let k = 0; k < 2; k++) {
      const m = k === 0 ? this.railA : this.railB;
      const off = (k === 0 ? -1 : 1) * tol;
      if (ax === 0) {
        m.position.set(cx + off, topSurf, cz);
        m.scale.set(0.08, 0.05, this.sd[i]);
      } else {
        m.position.set(cx, topSurf, cz + off);
        m.scale.set(this.sw[i], 0.05, 0.08);
      }
      (m.material as THREE.MeshBasicMaterial).opacity = t;
    }

    const px = ax === 0 ? this.cranePos : cx;
    const pz = ax === 0 ? cz : this.cranePos;
    const beamTop = this.topY + DROP_H;
    this.beam.position.set(px, (topSurf + beamTop) * 0.5, pz);
    this.beam.scale.set(0.06, beamTop - topSurf, 0.06);

    const armY = this.topY + DROP_H + 2.4;
    const span = this.craneAmp * 2 + 3;
    const mid = this.craneCenter();
    this.arm.scale.set(span, 1, 1);
    if (ax === 0) {
      this.arm.position.set(mid, armY, cz);
      this.arm.rotation.y = 0;
    } else {
      this.arm.position.set(cx, armY, mid);
      this.arm.rotation.y = HALF_PI;
    }
    this.cable.position.set(px, (armY + this.topY + DROP_H) * 0.5, pz);
    this.cable.scale.set(1, Math.max(0.1, armY - (this.topY + DROP_H)), 1);
  }

  private syncEffects() {
    const intensity = clamp01(this.placed / 140);
    const n = Math.round(lerp(120, MAX_STREAKS, intensity));
    const speed = lerp(18, 74, intensity) * (this.gustActive > 0 ? 1.7 : 1);
    const col = this.gustActive > 0 || this.gustWarn > 0 ? this.cGust : this.cStreak;
    const len = 0.6 + speed * 0.09;
    this.streaks.begin();
    for (let i = 0; i < n; i++) {
      this.streaks.write(this.wx[i], this.wy[i], this.wz[i], { x: 1, y: 1, z: len }, col, {
        x: 0,
        y: HALF_PI,
        z: 0,
      });
    }
    this.streaks.end();

    this.ringPool.begin();
    for (let i = 0; i < this.rCount; i++) {
      if (this.rDelay[i] > 0) continue;
      const a = this.rLife[i] / this.rMax[i];
      const y = this.ry[i];
      const r = this.rRad[i] * 1.35 + (1 - a) * 5;
      this.cA.setRGB(this.rCol[i * 3], this.rCol[i * 3 + 1], this.rCol[i * 3 + 2]).multiplyScalar(a * a);
      this.ringPool.write(this.bendX(y), y, this.bendZ(y), { x: r, y: r, z: 1 }, this.cA, {
        x: -HALF_PI,
        y: 0,
        z: 0,
      });
    }
    this.ringPool.end();
  }

  private applyGrade() {
    const u = this.post.grade.uniforms;
    const b = clamp01(this.bandT / 4);
    const speedish = clamp01(this.placed / 140);
    u.time.value = this.tReal;
    u.amount.value = 0.0015 + speedish * 0.0055 + this.shake.amount * 0.012;
    u.warp.value = 0.02 + speedish * 0.11 + this.shake.amount * 0.06;
    u.vignette.value = 0.85 + b * 0.23 + this.desat * 0.2;
    u.scan.value = speedish * 0.035;
    u.desat.value = this.desat;
    (u.flash.value as THREE.Color).setRGB(this.flashR, this.flashG, this.flashB);
    this.post.bloom.strength = lerp(0.85, 1.15, speedish) + this.heat * 1.25;
    this.post.bloom.radius = 0.62;
  }

  // --- hud ------------------------------------------------------------------

  private drawHud() {
    const g = this.hud.begin();
    const w = this.w;
    const h = this.h;
    const s = clamp(Math.min(w / 940, h / 640), 0.6, 1.3) * (this.c.isTouch ? 1.12 : 1);
    this.hudS = s;
    const hot = heatCss(this.heat);

    // --- score, top-left
    g.save();
    g.translate(34 * s, 0);
    g.font = `700 ${13 * s}px ${MONO}`;
    g.fillStyle = "rgba(255,255,255,0.5)";
    g.fillText("SCORE", 0, 44 * s);
    g.save();
    g.translate(0, 108 * s);
    g.scale(this.scorePunch, this.scorePunch);
    g.font = `800 ${64 * s}px ${MONO}`;
    glowText(g, fmt(this.shownScore), 0, 0, "#ffffff", 18);
    g.restore();
    g.font = `700 ${13 * s}px ${MONO}`;
    g.fillStyle = "rgba(255,220,120,0.75)";
    g.fillText(`BEST ${fmt(this.best)}`, 0, 134 * s);
    g.restore();

    // --- chain, right. The second-biggest thing on screen after the tower.
    {
      const cx = w - 46 * s;
      const cy = h * 0.34;
      const live = this.chain > 0;
      g.save();
      g.translate(cx, cy);
      g.rotate(this.chainTilt);
      g.scale(this.chainPunch, this.chainPunch);
      g.textAlign = "right";
      g.font = `900 ${(live ? 112 : 74) * s}px ${MONO}`;
      glowText(g, `×${this.chain}`, 0, 0, live ? hot : "rgba(255,255,255,0.22)", live ? 28 : 8);
      g.restore();

      // Arc meter: progress to the next REFORGE.
      const prog = (this.chain % 8) / 8;
      g.save();
      g.translate(cx - 22 * s, cy + 40 * s);
      g.lineWidth = 5 * s;
      g.strokeStyle = "rgba(255,255,255,0.14)";
      g.beginPath();
      g.arc(0, 0, 26 * s, 0, TAU);
      g.stroke();
      if (live) {
        g.strokeStyle = hot;
        g.beginPath();
        g.arc(0, 0, 26 * s, -HALF_PI, -HALF_PI + TAU * prog);
        g.stroke();
      }
      g.restore();

      g.save();
      g.textAlign = "right";
      g.font = `700 ${13 * s}px ${MONO}`;
      g.fillStyle = live ? "rgba(255,255,255,0.62)" : "rgba(255,255,255,0.3)";
      g.fillText(`MULT ${this.mult.toFixed(1)}`, cx, cy + 92 * s);
      g.restore();
    }

    // Shattered chain pieces.
    if (this.shLife > 0) {
      const a = clamp01(this.shLife / 0.42);
      g.save();
      g.globalAlpha = a;
      g.font = `900 ${74 * s}px ${MONO}`;
      g.fillStyle = "#ff2a4d";
      for (let k = 0; k < 8; k++) {
        g.save();
        g.translate(this.shX[k], this.shY[k]);
        g.rotate(this.shR[k]);
        g.fillText(this.shText, -30 * s, 0);
        g.restore();
      }
      g.restore();
    }

    // --- platform meter + height, bottom-left
    const wNow = this.topW;
    g.font = `700 ${12 * s}px ${MONO}`;
    g.fillStyle = "rgba(255,255,255,0.45)";
    g.fillText("PLATFORM", 34 * s, h - 58 * s);
    const barW = 210 * s;
    const v = clamp01(wNow / START_SIZE);
    bar(
      g,
      34 * s,
      h - 48 * s,
      barW,
      10 * s,
      v,
      v,
      v < 0.32 ? "#ff2a4d" : v < 0.6 ? "#ff8a1e" : hot,
    );
    g.fillStyle = "rgba(255,255,255,0.8)";
    g.font = `800 ${22 * s}px ${MONO}`;
    g.fillText(`${fmt(this.topY)}m`, 34 * s, h - 16 * s);
    g.font = `700 ${12 * s}px ${MONO}`;
    g.fillStyle = "rgba(255,255,255,0.4)";
    g.fillText(BAND_NAME[this.bandIdx], 34 * s + 92 * s, h - 18 * s);

    // Gust warning — must be legible a full second before it bites.
    if (this.gustWarn > 0 || this.gustActive > 0) {
      const pulse = 0.5 + 0.5 * Math.sin(this.tReal * 14);
      g.textAlign = "center";
      g.font = `800 ${20 * s}px ${MONO}`;
      glowText(
        g,
        this.gustActive > 0 ? "GALE" : "GUST INCOMING",
        w * 0.5,
        h * 0.14,
        `rgba(255,154,48,${0.45 + pulse * 0.55})`,
        16,
      );
      g.textAlign = "left";
    }

    if (this.threadT > 0) {
      const a = clamp01(this.threadT / 0.9);
      g.save();
      g.globalAlpha = a;
      g.textAlign = "center";
      g.font = `800 ${64 * s}px ${MONO}`;
      glowText(g, "T H R E A D", w * 0.5, h * 0.52, "#ffffff", 34);
      g.textAlign = "left";
      g.restore();
    }

    if (this.recordT > 0) {
      const a = clamp01(this.recordT / 2.2);
      g.save();
      g.globalAlpha = Math.min(1, a * 2);
      g.fillStyle = `rgba(255,210,74,${0.14 * a})`;
      g.fillRect(0, 0, w, h);
      g.textAlign = "center";
      g.font = `900 ${72 * s}px ${MONO}`;
      glowText(g, "NEW BEST", w * 0.5, h * 0.4, "#ffd24a", 40);
      g.font = `800 ${34 * s}px ${MONO}`;
      glowText(g, fmt(this.score), w * 0.5, h * 0.4 + 52 * s, "#ffffff", 20);
      g.textAlign = "left";
      g.restore();
    }

    if (this.cardT > 0) {
      const a = clamp01(this.cardT / 0.4);
      g.save();
      g.globalAlpha = a;
      g.textAlign = "center";
      g.font = `800 ${52 * s}px ${MONO}`;
      g.letterSpacing = `${10 * s}px`;
      glowText(g, this.cardText, w * 0.5, h * 0.22, "#ffffff", 26);
      g.letterSpacing = "0px";
      g.font = `700 ${20 * s}px ${MONO}`;
      glowText(g, this.cardSub, w * 0.5, h * 0.22 + 34 * s, hot, 14);
      g.textAlign = "left";
      g.restore();
    }

    if (this.phase === "attract") this.drawTitle(g, s);
    if (this.phase === "dying" || this.phase === "dead") this.drawDeath(g, s);
  }

  private drawTitle(g: CanvasRenderingContext2D, s: number) {
    const h = this.h;
    g.save();
    g.font = `900 ${104 * s}px ${MONO}`;
    g.letterSpacing = `${16 * s}px`;
    glowText(g, "SPIRE", 34 * s, h * 0.52, "#ffffff", 40);
    g.letterSpacing = "0px";
    g.font = `700 ${15 * s}px ${MONO}`;
    g.fillStyle = "rgba(255,255,255,0.55)";
    g.fillText("STACK IT FLUSH. CHAIN IT. CLIMB.", 36 * s, h * 0.52 + 32 * s);
    const pulse = 0.55 + 0.45 * Math.sin(this.hintPulse * 6.9);
    g.font = `800 ${22 * s}px ${MONO}`;
    glowText(
      g,
      this.c.isTouch ? "TAP TO DROP" : "CLICK TO DROP",
      36 * s,
      h * 0.52 + 78 * s,
      `rgba(120,240,255,${pulse})`,
      18,
    );
    g.restore();
  }

  private drawDeath(g: CanvasRenderingContext2D, s: number) {
    const w = this.w;
    const h = this.h;
    const a = clamp01((this.dieT - 1.05) / 0.5);
    if (a <= 0) return;
    g.save();
    g.globalAlpha = a;
    const cw = Math.min(w * 0.82, 430 * s);
    const ch = 236 * s;
    const x = (w - cw) * 0.5;
    const y = h * 0.5 - ch * 0.5;
    g.fillStyle = "rgba(4,6,15,0.82)";
    roundRectPath(g, x, y, cw, ch, 16 * s);
    g.fill();
    g.strokeStyle = "rgba(255,255,255,0.14)";
    g.lineWidth = 1.5;
    g.stroke();

    g.textAlign = "center";
    g.font = `700 ${13 * s}px ${MONO}`;
    g.fillStyle = "rgba(255,255,255,0.5)";
    g.fillText("SPIRE COLLAPSED", w * 0.5, y + 34 * s);
    g.font = `900 ${58 * s}px ${MONO}`;
    glowText(g, fmt(this.score), w * 0.5, y + 96 * s, "#ffffff", 24);
    g.font = `700 ${14 * s}px ${MONO}`;
    g.fillStyle = "rgba(255,255,255,0.62)";
    g.fillText(
      `${fmt(this.topY)}m  ·  ${this.placed} SLABS  ·  BEST CHAIN ×${this.bestChain}`,
      w * 0.5,
      y + 126 * s,
    );
    g.fillStyle = "rgba(255,210,74,0.85)";
    g.fillText(`BEST ${fmt(this.best)}`, w * 0.5, y + 152 * s);

    const pulse = 0.55 + 0.45 * Math.sin(this.hintPulse * 6.9);
    g.font = `800 ${20 * s}px ${MONO}`;
    glowText(
      g,
      this.c.isTouch ? "TAP TO RETRY" : "CLICK TO RETRY",
      w * 0.5,
      y + ch - 30 * s,
      `rgba(120,240,255,${pulse})`,
      16,
    );
    g.textAlign = "left";
    g.restore();
  }

  destroy() {
    this.post?.dispose();
    this.hud?.dispose();
    this.parts?.dispose();
    this.bodies?.dispose();
    this.plates?.dispose();
    this.debrisPool?.dispose();
    this.streaks?.dispose();
    this.ringPool?.dispose();
    this.cloudPool?.dispose();
    this.sky?.geometry.dispose();
    this.skyMat?.dispose();
    this.ground?.geometry.dispose();
    this.groundMat?.dispose();
    this.fog?.geometry.dispose();
    this.fogMat?.dispose();
    this.planet?.geometry.dispose();
    this.planetMat?.dispose();
    for (const m of this.aurora) m.geometry.dispose();
    this.auroraMat?.dispose();
    this.stars?.geometry.dispose();
    this.starMat?.dispose();
    for (const m of [this.railA, this.railB, this.beam, this.arm, this.cable]) {
      m?.geometry.dispose();
      (m?.material as THREE.Material | undefined)?.dispose();
    }
    this.glowTex?.dispose();
    this.ringTex?.dispose();
    this.partTex?.dispose();
    this.renderer?.dispose();
  }
}

const factory: GameFactory = (ctx) => new Spire(ctx);
export default factory;
