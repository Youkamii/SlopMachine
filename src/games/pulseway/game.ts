/**
 * PULSEWAY
 *
 * A 3D rhythm highway. Four lanes of neon slabs rush at the camera down a road
 * that IS the beat grid. The engine plays kick/snare/hats/bass/pad; the lead
 * arpeggio is silent until your fingers make it — every lane is a chord tone of
 * a rolling Am-F-C-G loop, so the song only exists while you are playing it.
 *
 * Two escalation axes, deliberately kept apart so they never mush together:
 * SECTION (song time) owns the track — speed, density, FOV, drum layers.
 * CHAIN owns the light — bloom, edge fire, sky geometry, chrome, aberration.
 * A single miss extinguishes all of it at once, which is the whole punishment.
 *
 * The one structural rule that keeps a rhythm game honest: the note transport
 * reads song time straight off the audio clock, and hit-stop / slow-motion are
 * firewalled to the camera, sky, particles and HUD. Time can warp all it likes;
 * the chart cannot desync from the music.
 */

import type { AudioKit } from "@/engine/audio";
import type { PostStack } from "@/engine/gl/post";
import { glowTexture, hdr, makePost, ringTexture } from "@/engine/gl/post";
import { InstancePool, Particles } from "@/engine/gl/pool";
import { Shake, TimeWarp } from "@/engine/gl/shake";
import { Overlay, bar as meterBar, glowText, roundRectPath } from "@/engine/gl/overlay";
import { clamp, clamp01, damp, easeOutCubic, easeOutQuart, lerp, TAU } from "@/engine/math";
import type { GameContext, GameFactory, GameInstance } from "@/games/types";
import * as THREE from "three";

// --- tuning -----------------------------------------------------------------

const BPM = 132;
const STEP = 60 / BPM / 4; // 0.113636s — one 16th
const BEAT = STEP * 4;
const BAR = STEP * 16;
const SECTION_STEPS = 128;
const SECTION_SEC = STEP * SECTION_STEPS; // 14.545s

const LANE_X = [-3.9, -1.3, 1.3, 3.9];
const ROAD_W = 10.4;
const SPAWN_Z = -54;
const ROAD_FAR = -62;

const W_PERFECT = 0.058;
const W_GREAT = 0.1;
const W_GOOD = 0.15;
const JAM_TIME = 0.12;

const LANE_HEX = [0xff2f6e, 0xffc233, 0x35f0c0, 0x7b5cff];
const LANE_CSS = ["#ff2f6e", "#ffc233", "#35f0c0", "#7b5cff"];
const LANE_LABEL = ["D", "F", "J", "K"];
const KEY_MAIN = ["KeyD", "KeyF", "KeyJ", "KeyK"];
const KEY_ALT = ["ArrowLeft", "ArrowDown", "ArrowUp", "ArrowRight"];

const CHROME = 0xdfe9ff;

const TIER_AT = [0, 10, 25, 50, 80];
const TIER_SKY = [70, 150, 250, 340, 440];
const TIER_BLOOM = [0.95, 1.25, 1.5, 1.75, 1.95];
const TIER_VIG = [0.95, 0.88, 0.72, 0.6, 0.52];
const TIER_CHROMA = [0.0008, 0.0016, 0.0026, 0.004, 0.006];
const TIER_METAL = [0, 0, 0.15, 0.55, 0.8];
const TIER_SCAN = [0, 0, 0, 0.05, 0.08];
const TIER_NAME = ["", "EDGES LIT", "SKY OPEN", "CHROME", "OVERDRIVE"];
const TIER_CSS = ["#8fa2c8", "#ff2f6e", "#ffc233", "#dfe9ff", "#35f0c0"];
const TIER_HEX = [0x8fa2c8, 0xff2f6e, 0xffc233, 0xdfe9ff, 0x35f0c0];

const SCORE_PERFECT = 100;
const SCORE_GREAT = 55;
const SCORE_GOOD = 20;
const SCORE_HOLD_TICK = 15;
const SCORE_HOLD_END = 150;
const SCORE_PULSE = 250; // per half, so the slam is worth 500
const SCORE_SECTION = 2000;

// Am - F - C - G. Lane 0..3 = root / third / fifth / octave, so no lane choice
// can ever be dissonant; a miss just punches a hole in the melody.
const CHORD_ROOT = [110.0, 87.307, 130.813, 98.0];
const CHORD_TONE = [
  [0, 3, 7, 12],
  [0, 4, 7, 12],
  [0, 4, 7, 12],
  [0, 4, 7, 12],
];

// --- chart ------------------------------------------------------------------

const ALL16 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const P_Q = [0, 4, 8, 12];
const P_QO = [0, 4, 6, 8, 12, 14];
const P_E = [0, 2, 4, 6, 8, 10, 12, 14];
const P_E3 = [0, 2, 3, 4, 6, 8, 10, 11, 12, 14];
const P_E7 = [0, 2, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15];
const P_D14 = [0, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];

/** Adjacent-lane zigzag: 16ths are always a physical roll, never a stretch. */
const STAIR = [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 0, 1, 2, 3];
const ARP = [0, 2, 1, 3, 2, 0, 3, 1, 0, 1, 3, 2, 0, 3, 1, 2];

interface SecDef {
  pat: number[];
  /** Bars (0..7) replaced by a 16th staircase. */
  stairs: number[];
  /** Bars whose downbeat becomes a two-lane double. */
  dbl: number[];
  holdBars: number[];
  holdBeats: number;
}

const SECTIONS: SecDef[] = [
  { pat: P_Q, stairs: [], dbl: [], holdBars: [], holdBeats: 0 },
  { pat: P_QO, stairs: [], dbl: [], holdBars: [], holdBeats: 0 },
  { pat: P_E, stairs: [], dbl: [], holdBars: [3, 6], holdBeats: 2 },
  { pat: P_E, stairs: [], dbl: [0, 2, 4, 6], holdBars: [], holdBeats: 0 },
  { pat: P_E, stairs: [5], dbl: [0, 4], holdBars: [2], holdBeats: 2 },
  { pat: P_E3, stairs: [3, 6], dbl: [0, 4], holdBars: [], holdBeats: 0 },
  { pat: P_E7, stairs: [], dbl: [0, 2, 4, 6], holdBars: [5], holdBeats: 2 },
  { pat: P_E7, stairs: [3], dbl: [0, 4], holdBars: [2, 6], holdBeats: 4 },
  { pat: P_D14, stairs: [6], dbl: [0, 4], holdBars: [], holdBeats: 0 },
  { pat: P_D14, stairs: [3, 6], dbl: [0, 4], holdBars: [5], holdBeats: 2 },
  { pat: P_D14, stairs: [2, 5, 6], dbl: [0, 4], holdBars: [], holdBeats: 0 },
  { pat: P_D14, stairs: [3, 6], dbl: [0, 2, 4, 6], holdBars: [], holdBeats: 0 },
];

const secDef = (s: number) => SECTIONS[s < 12 ? s : 9 + ((s - 12) % 3)];

/**
 * Two silent bars at the top of the song. The drums are already rolling before
 * the first note exists, and because the lead-in is longer than the approach
 * time the first slab still gets its full read-distance down the road.
 */
const LEAD_BARS = 2;

const MAX_NOTES = 512;
const KIND_TAP = 0;
const KIND_HOLD = 1;
const KIND_DOUBLE = 2;
const KIND_PULSE = 3;
const ST_PENDING = 0;
const ST_HOLDING = 1;
const ST_DONE = 2;
const ST_MISSED = 3;

const MAX_RINGS = 56;
const MAX_BEAMS = 24;
const EDGE_SHARDS = 640;
const SKY_MAX = 440;

type Phase = "attract" | "playing" | "over";

class Pulseway implements GameInstance {
  private readonly c: GameContext;

  // --- three.js
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private post!: PostStack;
  private hud = new Overlay();
  private particles!: Particles;
  private shake = new Shake();
  private warp = new TimeWarp();

  private slabs!: InstancePool;
  private slabGlow!: InstancePool;
  private rungs!: InstancePool;
  private boxes!: InstancePool;
  private edges!: InstancePool;
  private sky!: InstancePool;
  private pylons!: InstancePool;
  private rings!: InstancePool;
  private beams!: InstancePool;
  private road!: THREE.Mesh;
  private horizon!: THREE.Mesh;
  private vanish!: THREE.Mesh;
  private textures: THREE.Texture[] = [];

  private c1 = new THREE.Color();
  private c2 = new THREE.Color();
  private c3 = new THREE.Color();
  private c4 = new THREE.Color();
  private chromeCol = new THREE.Color().setHex(CHROME, THREE.SRGBColorSpace);
  private flashCol = new THREE.Color(0, 0, 0);

  // --- shell state
  private w = 1;
  private h = 1;
  private reportTick = 0;
  private lastStatus = "";
  private phase: Phase = "attract";
  private realTime = 0;
  private vTime = 0;
  private overLock = 0;

  // --- song clock. songTime is the ONLY thing the chart is allowed to read.
  private songTime = 0;
  private songT0 = 0;
  private anchored = false;
  private musicPending = false;
  private padMuteUntil = -1;

  // --- notes (ring buffer, struct of arrays)
  private nTime = new Float32Array(MAX_NOTES);
  private nHold = new Float32Array(MAX_NOTES);
  private nTick = new Float32Array(MAX_NOTES);
  private nLane = new Uint8Array(MAX_NOTES);
  private nKind = new Uint8Array(MAX_NOTES);
  private nState = new Uint8Array(MAX_NOTES);
  private nGrade = new Uint8Array(MAX_NOTES);
  private nPartner = new Int16Array(MAX_NOTES);
  private nHead = 0;
  private nCount = 0;
  private nextBar = 0;
  private genPrevLane = -1;
  private genPrevStep = -99;

  // --- run state
  private score = 0;
  private scoreShown = 0;
  private best = 0;
  private chain = 0;
  private tier = 0;
  private signal = 100;
  private signalGhost = 100;
  private section = 0;
  private curSection = -1;
  private missesThisSection = 0;
  private pulseHits = 0;
  private pulsePerfect = true;
  private newBest = false;
  private hitCount = 0;

  // --- input
  private keyHeld = [false, false, false, false];
  private touchHeld = [0, 0, 0, 0];
  private laneJam = [0, 0, 0, 0];
  private laneFlash = [0, 0, 0, 0];
  private autoHold = [0, 0, 0, 0];
  private ptrLane = new Map<number, number>();
  private deadPtrs: number[] = [];

  // --- juice / animation
  private chainScale = 1;
  private chainJit = 0;
  private breakVal = 0;
  private breakT = 0;
  private judgeText = "";
  private judgeCss = "#fff";
  private judgeT = 0;
  private bannerText = "";
  private bannerSub = "";
  private bannerT = 0;
  private bannerCss = "#fff";
  private sectionBanner = "";
  private sectionT = 0;
  private bestCelebrate = 0;
  private titleT = 0;
  private titleBlast = 0;
  private flourishT = 0;
  private flourishFired = false;
  private dimT = 0;
  private skyPush = 0;
  private hitWarp = 0;

  // damped world params
  private bloomV = 0.95;
  private vigV = 0.95;
  private chromaV = 0.001;
  private metalV = 0;
  private scanV = 0;
  private skyV = 70;
  private fireV = 0;
  private rollV = 0;
  private desatV = 0;
  private camY = 3.4;
  private camZ = 7.2;

  // --- rings / beams
  private rx = new Float32Array(MAX_RINGS);
  private ry = new Float32Array(MAX_RINGS);
  private rz = new Float32Array(MAX_RINGS);
  private rvz = new Float32Array(MAX_RINGS);
  private rAge = new Float32Array(MAX_RINGS);
  private rLife = new Float32Array(MAX_RINGS);
  private rR0 = new Float32Array(MAX_RINGS);
  private rR1 = new Float32Array(MAX_RINGS);
  private rHex = new Int32Array(MAX_RINGS);
  private rCount = 0;

  private bLane = new Uint8Array(MAX_BEAMS);
  private bAge = new Float32Array(MAX_BEAMS);
  private bMag = new Float32Array(MAX_BEAMS);
  private bCount = 0;

  constructor(ctx: GameContext) {
    this.c = ctx;
    this.best = ctx.store.best("best") ?? 0;
    this.initThree();
    this.enterAttract();
    ctx.report({ status: "idle", score: 0, best: this.best, label: "PULSEWAY" });
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
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setClearColor(0x05030f, 1);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x05030f, 0.017);

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 260);

    const glow = glowTexture(128, 2.0);
    const ring = ringTexture(256, 0.07);
    const grad = makeGradient();
    this.textures.push(glow, ring, grad);

    // Horizon: the only non-emissive colour in the scene, and the reason the
    // vanishing point reads as a place rather than a hole.
    this.horizon = new THREE.Mesh(
      new THREE.PlaneGeometry(260, 54),
      new THREE.MeshBasicMaterial({ map: grad, fog: false, depthWrite: false, toneMapped: false }),
    );
    this.horizon.position.set(0, 16, -74);
    this.horizon.renderOrder = -2;
    this.scene.add(this.horizon);

    this.vanish = new THREE.Mesh(
      new THREE.PlaneGeometry(46, 18),
      new THREE.MeshBasicMaterial({
        map: glow,
        color: hdr(0xff2f6e, 1.5),
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      }),
    );
    this.vanish.position.set(0, 1.4, -70);
    this.vanish.renderOrder = -1;
    this.scene.add(this.vanish);

    this.road = new THREE.Mesh(
      new THREE.PlaneGeometry(ROAD_W, 84),
      new THREE.MeshBasicMaterial({ color: 0x0a0820, toneMapped: false }),
    );
    this.road.rotation.x = -Math.PI / 2;
    this.road.position.set(0, -0.02, -30);
    this.scene.add(this.road);

    const basic = (max: number, geo: THREE.BufferGeometry) =>
      new InstancePool(geo, new THREE.MeshBasicMaterial({ toneMapped: false }), max);
    const additive = (max: number, geo: THREE.BufferGeometry, map: THREE.Texture) =>
      new InstancePool(
        geo,
        new THREE.MeshBasicMaterial({
          map,
          blending: THREE.AdditiveBlending,
          transparent: true,
          depthWrite: false,
          fog: false,
          toneMapped: false,
        }),
        max,
      );

    this.rungs = basic(96, new THREE.BoxGeometry(ROAD_W, 0.03, 0.1));
    this.boxes = basic(16, new THREE.BoxGeometry(1, 1, 1));
    this.slabs = basic(192, new THREE.BoxGeometry(2.05, 0.22, 0.7));
    this.edges = basic(EDGE_SHARDS, new THREE.TetrahedronGeometry(0.5));
    this.sky = basic(SKY_MAX, new THREE.OctahedronGeometry(0.72));
    this.pylons = basic(128, new THREE.BoxGeometry(1, 1, 1));
    this.slabGlow = additive(192, new THREE.PlaneGeometry(1, 1), glow);
    this.rings = additive(MAX_RINGS, new THREE.PlaneGeometry(1, 1), ring);
    this.beams = additive(MAX_BEAMS, new THREE.PlaneGeometry(1, 1), glow);

    for (const p of this.pools()) this.scene.add(p.mesh);
    this.slabGlow.mesh.renderOrder = 4;
    this.rings.mesh.renderOrder = 5;
    this.beams.mesh.renderOrder = 5;

    const spark = glowTexture(64, 2.4);
    this.textures.push(spark);
    this.particles = new Particles(4200, spark);
    this.particles.object.renderOrder = 6;
    this.scene.add(this.particles.object);

    this.post = makePost(this.renderer, this.scene, this.camera, {
      strength: 1.1,
      radius: 0.62,
      threshold: 0.22,
    });
  }

  private pools() {
    return [
      this.rungs,
      this.boxes,
      this.slabs,
      this.edges,
      this.sky,
      this.pylons,
      this.slabGlow,
      this.rings,
      this.beams,
    ];
  }

  // --- phases ---------------------------------------------------------------

  /**
   * Attract is not a menu: it is the real game running deep into a run with a
   * ghost autoplayer, so frame one is already a screen full of moving light.
   */
  private enterAttract() {
    this.phase = "attract";
    this.c.audio.stopMusic();
    this.anchored = false;
    this.musicPending = false;
    this.songTime = 152; // section 10 — dense chart, wide FOV, chrome tier
    this.resetRun();
    this.chain = 46;
    this.tier = tierOf(this.chain);
    this.score = 184220;
    this.scoreShown = 170000;
    this.skyV = TIER_SKY[this.tier];
    this.fireV = 1;
    this.bloomV = TIER_BLOOM[this.tier];
    this.metalV = TIER_METAL[this.tier];
    this.chromaV = TIER_CHROMA[this.tier];
    this.titleT = 0.22; // already mid-animation on the very first rendered frame
    this.titleBlast = 0;
    this.prewarm();
  }

  private resetRun() {
    this.nHead = 0;
    this.nCount = 0;
    this.nextBar = Math.max(0, Math.floor((this.songTime - 0.4) / BAR));
    this.genPrevLane = -1;
    this.genPrevStep = -99;
    this.chain = 0;
    this.tier = 0;
    this.score = 0;
    this.scoreShown = 0;
    this.signal = 100;
    this.signalGhost = 100;
    this.curSection = -1;
    this.missesThisSection = 0;
    this.pulseHits = 0;
    this.pulsePerfect = true;
    this.hitCount = 0;
    this.newBest = false;
    this.rCount = 0;
    this.bCount = 0;
    this.breakT = 0;
    this.judgeT = 0;
    this.bannerT = 0;
    this.sectionT = 0;
    this.bestCelebrate = 0;
    this.flourishT = 0;
    this.dimT = 0;
    this.skyPush = 0;
    this.warp.reset();
    for (let i = 0; i < 4; i++) {
      this.laneJam[i] = 0;
      this.autoHold[i] = 0;
      this.touchHeld[i] = 0;
    }
    this.ptrLane.clear();
  }

  private beginRun() {
    this.particles.clear();
    this.songTime = -0.1;
    this.resetRun();
    this.phase = "playing";
    this.anchored = false;
    this.musicPending = true;
    this.padMuteUntil = -1;
    this.c.audio.stopMusic();

    // The title physically blows apart and the world flashes white.
    this.titleBlast = 1;
    this.flashCol.setRGB(1.5, 1.5, 1.8);
    this.shake.add(0.5);
    this.camZ = 11;
    this.particles.burst(300, 0, 1.6, -3, 17, {
      life: 0.75,
      size: 0.5,
      endSize: 0,
      color: hdr(0xffffff, 4, this.c1),
      endColor: hdr(0x7b5cff, 0.8, this.c2),
      drag: 0.3,
    });
    this.addRing(0, 1.2, -2, 0xffffff, 0, 0.55, 1.5, 34, 12);
    this.c.audio.whoosh(0.3);
    this.c.report({ status: "playing", score: 0, best: this.best, label: "SECTION 0" });
  }

  private burnout() {
    this.phase = "over";
    this.overLock = 0.4;
    this.c.audio.stopMusic();
    this.anchored = false;
    this.c.audio.fail(0.34);
    this.c.audio.explode(0.4);
    this.warp.hitStop(0.16);
    this.warp.slowMo(1.4, 0.35);
    this.shake.add(0.7);
    this.flashCol.setRGB(1.6, 0.2, 0.25);
    this.dimT = 1;
    this.particles.burst(260, 0, 0.6, 0, 14, {
      life: 1.1,
      size: 0.5,
      endSize: 0,
      color: hdr(0xff2b2b, 3.4, this.c1),
      endColor: hdr(0x220208, 0.4, this.c2),
      gravity: -4,
      drag: 0.4,
    });
    if (this.c.store.recordBest("best", this.score)) {
      this.best = this.score;
      this.newBest = true;
      this.bestCelebrate = 1;
    }
    this.c.report({ status: "over", score: this.score, best: this.best, label: "BURNOUT" });
  }

  private prewarm() {
    for (let i = 0; i < 7; i++) {
      const lane = i & 3;
      this.addRing(LANE_X[lane], 0.14, -i * 1.1, LANE_HEX[lane], 0.05 + i * 0.04);
      this.particles.burst(70, LANE_X[lane], 0.35, -i * 1.4, 9, {
        life: 0.55,
        size: 0.5,
        endSize: 0,
        color: hdr(LANE_HEX[lane], 4, this.c1),
        endColor: hdr(LANE_HEX[lane], 0.6, this.c2),
        gravity: -6,
        drag: 0.25,
      });
      this.addBeam(lane, 0.7);
      this.bAge[this.bCount - 1] = i * 0.03;
    }
    this.particles.update(0.1);
    this.particles.update(0.1);
  }

  // --- chart ----------------------------------------------------------------

  private addNote(t: number, lane: number, kind: number, hold: number): number {
    if (this.nCount >= MAX_NOTES) return -1;
    const i = (this.nHead + this.nCount) % MAX_NOTES;
    this.nCount++;
    this.nTime[i] = t;
    this.nLane[i] = lane;
    this.nKind[i] = kind;
    this.nHold[i] = hold;
    this.nTick[i] = t + STEP;
    this.nState[i] = ST_PENDING;
    this.nGrade[i] = 255;
    this.nPartner[i] = -1;
    return i;
  }

  /** One bar at a time, so a hold can reserve its lane for the whole bar. */
  private genBar(b: number) {
    if (b < LEAD_BARS) return;
    const s = Math.floor(b / 8);
    const lb = b % 8;
    const def = secDef(s);
    const t0 = b * BAR;
    const stair = def.stairs.indexOf(lb) >= 0;
    const steps = stair ? ALL16 : def.pat;
    const holdBar = !stair && def.holdBars.indexOf(lb) >= 0;
    const holdLen = holdBar ? def.holdBeats * BEAT : 0;
    let holdLane = -1;

    for (let j = 0; j < steps.length; j++) {
      const st = steps[j];
      // Bar 7 empties early: the tail of a section is the flourish's runway,
      // and the PULSE needs clear air in front of it.
      if (lb === 7 && st >= 6) break;
      const gs = b * 16 + st;
      let lane = stair ? ((b & 1) === 0 ? STAIR[st] : 3 - STAIR[st]) : ARP[(b * 5 + j) & 15];
      // Anything a single 16th behind the last note must be a neighbouring
      // lane. That turns every fast run into a physical roll instead of a
      // cross-hand stretch, and it is what keeps 8.8 notes/second playable.
      if (this.genPrevLane >= 0 && gs - this.genPrevStep === 1) {
        let cand = this.genPrevLane + (lane >= this.genPrevLane ? 1 : -1);
        if (cand < 0) cand = 1;
        if (cand > 3) cand = 2;
        lane = cand;
      }
      if (holdLane >= 0 && lane === holdLane && st * STEP < holdLen + 0.01) {
        lane = (lane + 1) & 3;
      }
      this.genPrevLane = lane;
      this.genPrevStep = gs;
      const t = t0 + st * STEP;
      if (holdBar && j === 0) {
        holdLane = lane;
        this.addNote(t, lane, KIND_HOLD, holdLen);
        continue;
      }
      if (!stair && def.dbl.indexOf(lb) >= 0 && st === 0) {
        const a = this.addNote(t, lane, KIND_DOUBLE, 0);
        const c = this.addNote(t, (lane + 2) & 3, KIND_DOUBLE, 0);
        if (a >= 0 && c >= 0) {
          this.nPartner[a] = c;
          this.nPartner[c] = a;
        }
      } else {
        this.addNote(t, lane, KIND_TAP, 0);
      }
    }

    if (lb === 7) {
      const t = t0 + 8 * STEP;
      const a = this.addNote(t, 0, KIND_PULSE, 0);
      const c = this.addNote(t, 3, KIND_PULSE, 0);
      if (a >= 0 && c >= 0) {
        this.nPartner[a] = c;
        this.nPartner[c] = a;
      }
      // Nothing follows for two bars' worth of steps, so drop the constraint.
      this.genPrevLane = -1;
    }
  }

  private approach() {
    return Math.max(1.4, 1.9 - 0.045 * this.section);
  }

  private noteSpeed() {
    return -SPAWN_Z / this.approach();
  }

  // --- update ---------------------------------------------------------------

  update(dt: number) {
    this.realTime += dt;
    const wdt = this.warp.step(dt);
    this.vTime += wdt;
    this.shake.update(dt);

    // Song clock: audio owns it the moment audio exists.
    if (this.anchored && this.c.audio.ready) {
      this.songTime = this.c.audio.currentTime - this.songT0;
    } else {
      this.songTime += dt;
    }
    if (this.musicPending && this.c.audio.ready) {
      this.musicPending = false;
      this.c.audio.startMusic(this.onStep, BPM, 4);
    }

    this.section = Math.max(0, Math.floor(Math.max(0, this.songTime) / SECTION_SEC));

    this.pollInput(dt);
    if (this.phase !== "over") {
      this.genAhead();
      this.stepNotes();
      this.checkSection();
    }
    this.stepWorld(dt, wdt);
    this.pushReport();
  }

  private genAhead() {
    const horizon = this.songTime + this.approach() + 1.2;
    let guard = 0;
    while (this.nextBar * BAR < horizon && this.nCount < MAX_NOTES - 40 && guard++ < 8) {
      this.genBar(this.nextBar++);
    }
  }

  private checkSection() {
    if (this.section === this.curSection) return;
    const first = this.curSection < 0;
    this.curSection = this.section;
    this.missesThisSection = 0;
    this.pulseHits = 0;
    this.pulsePerfect = true;
    if (first || this.phase !== "playing") return;
    this.sectionBanner = `SECTION ${this.section.toString().padStart(2, "0")}  ·  ${this.noteSpeed().toFixed(
      1,
    )} u/s`;
    this.sectionT = 1;
    this.flashCol.setRGB(0.35, 0.4, 0.7);
    this.c.audio.play({
      wave: "square",
      freq: 660,
      freqTo: 1320,
      glide: 0.18,
      vol: 0.16,
      attack: 0.004,
      hold: 0.06,
      release: 0.22,
      filter: 3000,
    });
  }

  // --- input ----------------------------------------------------------------

  private pollInput(dt: number) {
    const inp = this.c.input;

    for (let i = 0; i < 4; i++) {
      this.laneJam[i] = Math.max(0, this.laneJam[i] - dt);
      this.keyHeld[i] = inp.isDown(KEY_MAIN[i], KEY_ALT[i]);
    }

    if (this.phase === "attract") {
      if (
        inp.wasPressed(...KEY_MAIN, ...KEY_ALT, "Space", "Enter") ||
        inp.pointer.justDown
      ) {
        this.beginRun();
      }
      return;
    }

    if (this.phase === "over") {
      this.overLock = Math.max(0, this.overLock - dt);
      if (
        this.overLock === 0 &&
        (inp.wasPressed(...KEY_MAIN, ...KEY_ALT, "Space", "Enter", "KeyR") ||
          inp.pointer.justDown)
      ) {
        this.beginRun();
      }
      return;
    }

    for (let i = 0; i < 4; i++) {
      if (inp.wasPressed(KEY_MAIN[i], KEY_ALT[i])) this.pressLane(i);
      if (inp.wasReleased(KEY_MAIN[i], KEY_ALT[i])) this.releaseLane(i);
    }

    // Multi-touch by pointerId diff: pointer.justDown collapses two fingers
    // landing in the same 16.7ms step into one event, which would eat every
    // double-note on a phone.
    const zone = this.w / 4;
    for (const [id, t] of inp.touches) {
      if (this.ptrLane.has(id)) continue;
      const lane = clamp(Math.floor(t.startX / zone), 0, 3);
      this.ptrLane.set(id, lane);
      this.touchHeld[lane]++;
      this.pressLane(lane);
    }
    this.deadPtrs.length = 0;
    for (const id of this.ptrLane.keys()) if (!inp.touches.has(id)) this.deadPtrs.push(id);
    for (const id of this.deadPtrs) {
      const lane = this.ptrLane.get(id)!;
      this.ptrLane.delete(id);
      this.touchHeld[lane] = Math.max(0, this.touchHeld[lane] - 1);
      this.releaseLane(lane);
    }
  }

  private laneIsHeld(lane: number) {
    if (this.phase === "attract") return this.autoHold[lane] > this.songTime;
    return this.keyHeld[lane] || this.touchHeld[lane] > 0;
  }

  private pressLane(lane: number) {
    this.laneFlash[lane] = 1;
    if (this.laneJam[lane] > 0) return;

    let best = -1;
    let bestAbs = 1e9;
    for (let k = 0; k < this.nCount; k++) {
      const i = (this.nHead + k) % MAX_NOTES;
      if (this.nState[i] !== ST_PENDING || this.nLane[i] !== lane) continue;
      const ad = Math.abs(this.nTime[i] - this.songTime);
      if (ad < bestAbs) {
        bestAbs = ad;
        best = i;
      }
    }
    if (best < 0 || bestAbs > W_GOOD) {
      // Anti-mash: a press into empty air jams that lane briefly. It never
      // breaks the chain, so an honest early press is not punished.
      this.laneJam[lane] = JAM_TIME;
      this.c.audio.play({
        wave: "noise",
        freq: 260,
        vol: 0.05,
        attack: 0.001,
        hold: 0.01,
        release: 0.05,
        filter: 900,
      });
      return;
    }
    this.judge(best, this.songTime - this.nTime[best]);
  }

  private releaseLane(lane: number) {
    for (let k = 0; k < this.nCount; k++) {
      const i = (this.nHead + k) % MAX_NOTES;
      if (this.nState[i] !== ST_HOLDING || this.nLane[i] !== lane) continue;
      const end = this.nTime[i] + this.nHold[i];
      if (this.songTime >= end - 0.12) this.completeHold(i);
      else {
        // A mis-release is a keyboard slip, not a rhythm error: it forfeits the
        // remaining ticks but never breaks the chain.
        this.nState[i] = ST_DONE;
        this.judgeText = "DROP";
        this.judgeCss = "#7f8fb5";
        this.judgeT = 1;
        this.c.audio.play({ wave: "triangle", freq: 300, freqTo: 150, glide: 0.1, vol: 0.09 });
      }
      return;
    }
  }

  // --- judging --------------------------------------------------------------

  private judge(i: number, delta: number) {
    const ad = Math.abs(delta);
    const grade = ad <= W_PERFECT ? 0 : ad <= W_GREAT ? 1 : 2;
    const lane = this.nLane[i];
    const kind = this.nKind[i];
    this.nGrade[i] = grade;
    this.hitCount++;

    if (this.nHold[i] > 0) {
      this.nState[i] = ST_HOLDING;
      this.nTick[i] = this.nTime[i] + STEP;
      if (this.phase === "attract") this.autoHold[lane] = this.nTime[i] + this.nHold[i] + 0.03;
    } else {
      this.nState[i] = ST_DONE;
    }

    const prevTier = this.tier;
    this.chain++;
    this.tier = tierOf(this.chain);
    this.chainScale = 1.35;
    if (this.tier > prevTier) this.tierUp(this.tier);

    const base =
      kind === KIND_PULSE
        ? SCORE_PULSE
        : grade === 0
          ? SCORE_PERFECT
          : grade === 1
            ? SCORE_GREAT
            : SCORE_GOOD;
    this.addScore(base * this.mult());
    this.signal = Math.min(100, this.signal + (grade === 0 ? 3 : grade === 1 ? 2 : 1));

    this.judgeText = grade === 0 ? "PERFECT" : grade === 1 ? "GREAT" : "GOOD";
    this.judgeCss = grade === 0 ? "#ffe9a3" : grade === 1 ? "#35f0c0" : "#7f8fb5";
    this.judgeT = 1;

    this.hitFx(lane, grade, kind);
    this.playArp(lane, grade);

    if (kind === KIND_PULSE) {
      this.pulseHits++;
      if (grade !== 0) this.pulsePerfect = false;
      if (this.pulseHits >= 2) this.resolvePulse();
    } else if (kind === KIND_DOUBLE && grade === 0 && this.chain >= 25) {
      const p = this.nPartner[i];
      if (p >= 0 && this.nGrade[p] === 0) {
        // A cheap earned flinch: 220ms of hitch for nailing both halves.
        this.warp.slowMo(0.22, 0.55);
        this.desatV = Math.max(this.desatV, 0.25);
        this.shake.add(0.09);
        this.addRing(0, 0.3, 0, 0xffffff, 0, 0.5, 1, 16, 6);
      }
    }
  }

  private completeHold(i: number) {
    this.nState[i] = ST_DONE;
    const lane = this.nLane[i];
    this.addScore(SCORE_HOLD_END * this.mult());
    this.signal = Math.min(100, this.signal + 2);
    this.judgeText = "HELD";
    this.judgeCss = "#ffe9a3";
    this.judgeT = 1;
    this.addRing(LANE_X[lane], 0.2, 0, LANE_HEX[lane], 0, 0.4, 0.8, 7, 0);
    this.particles.burst(34, LANE_X[lane], 0.4, 0, 8, {
      life: 0.55,
      size: 0.5,
      endSize: 0,
      color: hdr(0xffffff, 4, this.c1),
      endColor: hdr(LANE_HEX[lane], 0.8, this.c2),
      gravity: -5,
      drag: 0.3,
    });
    const f = this.laneFreq(lane) * 2;
    this.c.audio.play({ wave: "triangle", freq: f, vol: 0.13, attack: 0.003, hold: 0.06, release: 0.3 });
    this.c.audio.play({ wave: "sine", freq: f * 1.5, vol: 0.09, attack: 0.003, hold: 0.05, release: 0.35 });
  }

  private missNote(i: number) {
    this.nState[i] = ST_MISSED;
    const lane = this.nLane[i];
    this.missesThisSection++;
    this.pulsePerfect = false;
    this.breakChain();

    this.signal -= 18;
    this.judgeText = "MISS";
    this.judgeCss = "#ff2b2b";
    this.judgeT = 1;

    this.warp.hitStop(0.075);
    this.shake.add(0.35);
    this.dimT = 1;
    this.skyPush = 1;
    this.flashCol.setRGB(0.9, 0.08, 0.12);
    this.padMuteUntil = this.songTime + BAR * 2;

    this.particles.burst(24, LANE_X[lane], 0.3, 0, 5, {
      life: 0.9,
      size: 0.42,
      endSize: 0,
      color: hdr(0x6a6a78, 1.4, this.c1),
      endColor: hdr(0x141420, 0.2, this.c2),
      gravity: -12,
      drag: 0.5,
    });
    this.c.audio.chord([
      { wave: "sawtooth", freq: 55, vol: 0.2, attack: 0.002, hold: 0.1, release: 0.3, filter: 700 },
      { wave: "sawtooth", freq: 58.2, vol: 0.18, attack: 0.002, hold: 0.1, release: 0.3, filter: 700 },
      { wave: "sawtooth", freq: 61.7, vol: 0.16, attack: 0.002, hold: 0.1, release: 0.3, filter: 700 },
    ]);

    if (this.signal <= 0) {
      this.signal = 0;
      this.burnout();
    }
  }

  private breakChain() {
    if (this.chain > 0) {
      this.breakVal = this.chain;
      this.breakT = 1;
    }
    this.chain = 0;
    this.tier = 0;
  }

  private resolvePulse() {
    this.warp.hitStop(0.09);
    this.shake.add(0.14);
    this.addRing(0, 0.4, 0, 0xffffff, 0, 0.6, 2, 26, 9);
    this.particles.burst(120, 0, 0.5, 0, 13, {
      life: 0.8,
      size: 0.55,
      endSize: 0,
      color: hdr(0xffffff, 4, this.c1),
      endColor: hdr(0x35f0c0, 0.8, this.c2),
      drag: 0.35,
    });
    this.c.audio.play({ wave: "square", freq: 220, freqTo: 880, glide: 0.14, vol: 0.2, hold: 0.06, release: 0.24 });
    if (this.pulsePerfect && this.missesThisSection === 0) this.perfectSection();
  }

  /**
   * The earned slow-motion. It fires into the deliberately note-free tail of a
   * section and snaps back exactly on the next downbeat, so it can never eat a
   * note and always lands on the beat.
   */
  private perfectSection() {
    this.addScore(SCORE_SECTION * this.mult());
    this.warp.slowMo(0.9, 0.3);
    this.flourishT = 0.95;
    this.flourishFired = true;
    this.bannerText = "PERFECT SECTION";
    this.bannerSub = `+${(SCORE_SECTION * this.mult()).toLocaleString("en-US")}`;
    this.bannerCss = "#ffe9a3";
    this.bannerT = 1;
    this.shake.add(0.25);

    // Streaks straight at the viewer.
    for (let i = 0; i < 400; i++) {
      const a = Math.random() * TAU;
      const r = Math.random() * 7;
      this.particles.spawn({
        x: Math.cos(a) * r,
        y: 0.3 + Math.abs(Math.sin(a)) * r * 0.5,
        z: -1,
        vx: Math.cos(a) * 1.5,
        vy: Math.sin(a) * 1.2,
        vz: 22,
        life: 0.9,
        size: 0.55,
        endSize: 0.1,
        color: hdr(0xffffff, 4, this.c1),
        endColor: hdr(0x7b5cff, 1, this.c2),
      });
    }
    this.c.audio.play({
      wave: "noise",
      freq: 200,
      freqTo: 2400,
      vol: 0.2,
      attack: 0.05,
      hold: 0.6,
      release: 0.25,
      filter: 400,
      filterTo: 6000,
      filterType: "bandpass",
      q: 2,
    });
    const root = CHORD_ROOT[this.chordIndex()] * 4;
    [0, 4, 7, 12].forEach((s, i) => {
      this.c.audio.play({
        wave: "triangle",
        freq: root * Math.pow(2, s / 12),
        vol: 0.14,
        attack: 0.01,
        hold: 0.3,
        release: 0.5,
        delay: i * 0.09,
      });
    });
  }

  private tierUp(t: number) {
    this.bannerText = TIER_NAME[t];
    this.bannerSub = `CHAIN ${TIER_AT[t]}`;
    this.bannerCss = TIER_CSS[t];
    this.bannerT = 1;
    this.chainScale = 1.7;
    this.shake.add(0.28);
    this.warp.hitStop(0.05);
    hdr(TIER_HEX[t], 0.9, this.flashCol);
    this.addRing(0, 1.2, -3, TIER_HEX[t], 0, 0.6, 2, 40, 14);
    this.c.audio.whoosh(0.24);
    this.c.audio.powerUp(0.2);
  }

  private addScore(v: number) {
    this.score += v;
    if (!this.newBest && this.best > 0 && this.score > this.best && this.phase === "playing") {
      this.newBest = true;
      this.bestCelebrate = 1;
      this.flashCol.setRGB(1.4, 1.1, 0.4);
      this.shake.add(0.3);
      this.warp.hitStop(0.06);
      this.c.audio.powerUp(0.28);
      this.particles.burst(260, 0, 1.2, -2, 15, {
        life: 1,
        size: 0.55,
        endSize: 0,
        color: hdr(0xffd76a, 4, this.c1),
        endColor: hdr(0xff2f6e, 0.8, this.c2),
        drag: 0.35,
      });
      this.addRing(0, 1.2, -2, 0xffd76a, 0, 0.6, 1.8, 36, 11);
    }
  }

  private mult() {
    return 1 + Math.min(7, Math.floor(this.chain / 12));
  }

  // --- note transport -------------------------------------------------------

  private stepNotes() {
    const t = this.songTime;
    for (let k = 0; k < this.nCount; k++) {
      const i = (this.nHead + k) % MAX_NOTES;
      const st = this.nState[i];
      if (st === ST_PENDING) {
        if (this.phase === "attract") {
          if (this.nTime[i] <= t) this.judge(i, 0);
        } else if (t > this.nTime[i] + W_GOOD) {
          this.missNote(i);
        }
      } else if (st === ST_HOLDING) {
        const end = this.nTime[i] + this.nHold[i];
        const lane = this.nLane[i];
        let ticks = 0;
        while (this.nTick[i] <= Math.min(t, end) && ticks < 8) {
          this.nTick[i] += STEP;
          ticks++;
        }
        if (ticks > 0) {
          this.addScore(SCORE_HOLD_TICK * ticks * this.mult());
          this.particles.burst(6 * ticks, LANE_X[lane], 0.3, 0, 6, {
            life: 0.35,
            size: 0.4,
            endSize: 0,
            color: hdr(LANE_HEX[lane], 3.6, this.c1),
            endColor: hdr(LANE_HEX[lane], 0.5, this.c2),
            gravity: -4,
            drag: 0.3,
          });
        }
        if (t >= end) this.completeHold(i);
        else if (!this.laneIsHeld(lane)) {
          this.nState[i] = ST_DONE;
        }
      }
    }
    // Retire from the head once a note is well behind the camera.
    while (this.nCount > 0) {
      const i = this.nHead;
      if (t <= this.nTime[i] + this.nHold[i] + 0.9) break;
      this.nHead = (this.nHead + 1) % MAX_NOTES;
      this.nCount--;
    }
  }

  // --- world ----------------------------------------------------------------

  private stepWorld(dt: number, wdt: number) {
    const tier = this.tier;
    this.dimT = Math.max(0, this.dimT - dt / 0.9);
    this.skyPush = Math.max(0, this.skyPush - dt / 1.2);
    this.hitWarp = damp(this.hitWarp, 0, 0.2, dt);
    for (let i = 0; i < 4; i++) this.laneFlash[i] = Math.max(0, this.laneFlash[i] - wdt * 5);

    const dim = this.dimT * this.dimT;
    this.bloomV = damp(this.bloomV, lerp(TIER_BLOOM[tier], 0.3, dim), 0.14, dt);
    this.vigV = damp(this.vigV, lerp(TIER_VIG[tier], 1.3, dim), 0.14, dt);
    this.chromaV = damp(this.chromaV, TIER_CHROMA[tier], 0.12, dt);
    this.metalV = damp(this.metalV, TIER_METAL[tier], 0.1, dt);
    this.scanV = damp(this.scanV, TIER_SCAN[tier], 0.1, dt);
    this.skyV = damp(this.skyV, TIER_SKY[tier], 0.08, dt);
    this.fireV = damp(this.fireV, tier >= 1 ? 1 - dim * 0.9 : 0.06, 0.12, dt);
    this.rollV = damp(this.rollV, tier >= 3 ? Math.min(5.5, 0.5 * this.section) : 0, 0.06, dt);

    this.flourishT = Math.max(0, this.flourishT - dt);
    if (this.flourishFired && this.flourishT === 0) {
      this.flourishFired = false;
      this.flashCol.setRGB(1.6, 1.6, 1.7);
      this.c.audio.play({ wave: "square", freq: 1320, vol: 0.16, hold: 0.03, release: 0.2 });
    }
    const flo = clamp01(this.flourishT / 0.9);
    const desatTarget = Math.max(dim * 0.65, flo * 0.55, this.phase === "over" ? 0.7 : 0);
    this.desatV = damp(this.desatV, desatTarget, 0.22, dt);

    // Signal drifts back up so a single bad bar is not a death sentence.
    if (this.phase === "playing") this.signal = Math.min(100, this.signal + dt * 0.6);
    this.signalGhost = damp(this.signalGhost, this.signal, 0.06, dt);
    this.scoreShown = damp(this.scoreShown, this.score, 0.16, dt);

    this.chainScale = damp(this.chainScale, 1, 0.22, dt);
    this.chainJit =
      this.chain >= 50 ? Math.sin(this.songTime / BEAT * TAU) * 0.026 * clamp01((this.chain - 50) / 40) : 0;
    this.breakT = Math.max(0, this.breakT - dt / 1.1);
    this.judgeT = Math.max(0, this.judgeT - dt / 0.45);
    this.bannerT = Math.max(0, this.bannerT - dt / 1.5);
    this.sectionT = Math.max(0, this.sectionT - dt / 2.2);
    this.bestCelebrate = Math.max(0, this.bestCelebrate - dt / 2.4);
    this.titleT = Math.min(1, this.titleT + dt / 0.6);
    this.titleBlast = Math.max(0, this.titleBlast - dt / 0.35);

    this.updateRings(wdt);
    this.updateBeams(wdt);
    this.particles.update(wdt);

    // --- camera
    const flourishDip = easeOutCubic(1 - flo);
    const targetY = lerp(1.6, 3.4, flourishDip);
    const targetZ = lerp(3.2, 7.2, flourishDip);
    this.camY = damp(this.camY, targetY, 0.12, dt);
    this.camZ = damp(this.camZ, targetZ, 0.12, dt);
    const drift = Math.sin(this.vTime * 0.9) * 0.8;
    this.camera.position.set(drift, this.camY, this.camZ);
    this.camera.lookAt(drift * 0.35, 0.9, -14);
    const barPhase = (this.songTime / BAR) * TAU;
    let roll = (Math.sin(barPhase) * this.rollV * Math.PI) / 180;
    if (tier >= 4) roll += (Math.sin(barPhase * 2) * this.rollV * 0.35 * Math.PI) / 180;
    this.camera.rotateZ(roll);

    const fovWant = Math.min(82, 70 + this.section) + flo * 5;
    if (Math.abs(fovWant - this.camera.fov) > 0.03) {
      this.camera.fov = fovWant;
      this.camera.updateProjectionMatrix();
    }
    this.shake.apply(this.camera, 0.35);

    // --- grade
    const gu = this.post.grade.uniforms;
    gu.time.value = this.realTime;
    gu.amount.value = this.chromaV + this.hitWarp * 0.01 + dim * 0.01;
    gu.warp.value = 0.02 + this.section * 0.004 + flo * 0.2 + this.hitWarp * 0.05;
    const lowSignal = this.signal < 30 ? (1 - this.signal / 30) * Math.abs(Math.sin(this.realTime * 5)) : 0;
    gu.vignette.value = this.vigV + lowSignal * 0.5;
    gu.desat.value = this.desatV;
    gu.scan.value = this.scanV;
    this.flashCol.multiplyScalar(Math.exp(-8 * dt));
    (gu.flash.value as THREE.Color).copy(this.flashCol);
    if (lowSignal > 0) (gu.flash.value as THREE.Color).r += lowSignal * 0.12;
    this.post.bloom.strength = this.bloomV + flo * 0.6;
  }

  private updateRings(dt: number) {
    let i = 0;
    while (i < this.rCount) {
      this.rAge[i] += dt;
      this.rz[i] += this.rvz[i] * dt;
      if (this.rAge[i] >= this.rLife[i]) {
        const last = --this.rCount;
        this.rx[i] = this.rx[last];
        this.ry[i] = this.ry[last];
        this.rz[i] = this.rz[last];
        this.rvz[i] = this.rvz[last];
        this.rAge[i] = this.rAge[last];
        this.rLife[i] = this.rLife[last];
        this.rR0[i] = this.rR0[last];
        this.rR1[i] = this.rR1[last];
        this.rHex[i] = this.rHex[last];
        continue;
      }
      i++;
    }
  }

  private updateBeams(dt: number) {
    let i = 0;
    while (i < this.bCount) {
      this.bAge[i] += dt;
      if (this.bAge[i] >= 0.3) {
        const last = --this.bCount;
        this.bAge[i] = this.bAge[last];
        this.bLane[i] = this.bLane[last];
        this.bMag[i] = this.bMag[last];
        continue;
      }
      i++;
    }
  }

  private addRing(
    x: number,
    y: number,
    z: number,
    hex: number,
    age = 0,
    life = 0.35,
    r0 = 0.6,
    r1 = 5.5,
    vz = 0,
  ) {
    if (this.rCount >= MAX_RINGS) this.rCount = MAX_RINGS - 1;
    const i = this.rCount++;
    this.rx[i] = x;
    this.ry[i] = y;
    this.rz[i] = z;
    this.rvz[i] = vz;
    this.rAge[i] = age;
    this.rLife[i] = life;
    this.rR0[i] = r0;
    this.rR1[i] = r1;
    this.rHex[i] = hex;
  }

  private addBeam(lane: number, mag: number) {
    if (this.bCount >= MAX_BEAMS) this.bCount = MAX_BEAMS - 1;
    const i = this.bCount++;
    this.bLane[i] = lane;
    this.bAge[i] = 0;
    this.bMag[i] = mag;
  }

  private hitFx(lane: number, grade: number, kind: number) {
    const x = LANE_X[lane];
    const hex = LANE_HEX[lane];
    const n = grade === 0 ? 28 : grade === 1 ? 18 : 10;
    this.particles.burst(n, x, 0.28, 0, 9, {
      life: 0.5,
      size: 0.52,
      endSize: 0,
      color: hdr(hex, 4, this.c1),
      endColor: hdr(hex, 0.6, this.c2),
      gravity: -6,
      drag: 0.25,
    });
    this.addRing(x, 0.12, 0, hex, 0, 0.35, 0.6, grade === 0 ? 5.5 : 3.6);
    this.addBeam(lane, grade === 0 ? 1 : 0.6);
    this.shake.add(grade === 0 ? 0.05 : grade === 1 ? 0.03 : 0.015);
    this.warp.hitStop(kind === KIND_PULSE ? 0.03 : grade === 0 ? 0.016 : 0.008);
    this.hitWarp = Math.min(1, this.hitWarp + (grade === 0 ? 0.5 : 0.25));
    hdr(hex, grade === 0 ? 0.12 : 0.07, this.c3);
    this.flashCol.add(this.c3);
    this.laneFlash[lane] = 1;
  }

  // --- audio ----------------------------------------------------------------

  private chordIndex() {
    return Math.floor(Math.max(0, this.songTime) / BAR) % 4;
  }

  private laneFreq(lane: number) {
    const ci = this.chordIndex();
    return CHORD_ROOT[ci] * 4 * Math.pow(2, CHORD_TONE[ci][lane] / 12);
  }

  private playArp(lane: number, grade: number) {
    let f = this.laneFreq(lane);
    if (this.tier >= 3) f *= 2;
    const v = grade === 0 ? 0.17 : grade === 1 ? 0.13 : 0.08;
    const pan = (lane - 1.5) * 0.45;
    this.c.audio.play({
      wave: "square",
      freq: f,
      vol: v,
      attack: 0.002,
      hold: 0.04,
      release: 0.17,
      filter: grade === 2 ? 1200 : 3400,
      filterTo: 900,
      q: 1.1,
      jitter: 8,
      pan,
    });
    this.c.audio.play({
      wave: "triangle",
      freq: f * 2,
      vol: v * 0.55,
      attack: 0.002,
      hold: 0.03,
      release: 0.13,
      pan,
    });
    if (this.tier >= 4) {
      this.c.audio.play({ wave: "square", freq: f * 1.5, vol: v * 0.35, hold: 0.03, release: 0.12, pan });
    }
    if (grade === 0) {
      this.c.audio.play({ wave: "sine", freq: f * 4, vol: 0.055, attack: 0.001, hold: 0.01, release: 0.08 });
    }
  }

  /** Backing only. The lead is played by the player's fingers, never here. */
  private onStep = (step: number, until: number, kit: AudioKit) => {
    if (!this.anchored) {
      this.songT0 = this.c.audio.currentTime + until;
      this.anchored = true;
    }
    const s = Math.floor(step / SECTION_STEPS);
    const l = step % 16;
    const bi = Math.floor(step / 16) % 4;
    const root = CHORD_ROOT[bi];
    const d = until;

    if (s >= 8 ? l % 2 === 0 : l % 4 === 0) {
      kit.play({
        wave: "sine",
        freq: 130,
        freqTo: 42,
        glide: 0.09,
        vol: l % 4 === 0 ? 0.5 : 0.3,
        attack: 0.002,
        hold: 0.03,
        release: 0.16,
        delay: d,
      });
    }
    if (s >= 1 && (l === 4 || l === 12)) {
      kit.play({
        wave: "noise",
        freq: 900,
        vol: 0.22,
        attack: 0.001,
        hold: 0.02,
        release: 0.13,
        filter: 1800,
        filterType: "bandpass",
        q: 1.5,
        delay: d,
      });
      kit.play({ wave: "triangle", freq: 190, freqTo: 110, glide: 0.06, vol: 0.11, hold: 0.02, release: 0.08, delay: d });
    }
    if (s >= 4 || l % 2 === 0) {
      kit.play({
        wave: "noise",
        freq: 2600,
        vol: l % 4 === 0 ? 0.05 : 0.032,
        attack: 0.001,
        hold: 0.004,
        release: 0.03,
        filter: 6000,
        filterType: "highpass",
        delay: d,
      });
    }
    if (l === 0 || l === 6 || l === 10 || (s >= 6 && l === 14)) {
      kit.play({
        wave: "sawtooth",
        freq: root,
        vol: 0.15,
        attack: 0.004,
        hold: 0.06,
        release: 0.12,
        filter: 420 + s * 26,
        filterTo: 260,
        q: 2.5,
        delay: d,
      });
    }
    if (l === 0 && s >= 2 && this.songTime > this.padMuteUntil) {
      for (const semi of [0, CHORD_TONE[bi][1], 7]) {
        kit.play({
          wave: "triangle",
          freq: root * 2 * Math.pow(2, semi / 12),
          vol: 0.05,
          attack: 0.14,
          hold: 1.2,
          release: 0.5,
          filter: 1500,
          delay: d,
        });
      }
    }
    if (this.signal < 30 && this.phase === "playing" && l % 4 === 0) {
      kit.play({ wave: "sine", freq: 60, freqTo: 34, glide: 0.12, vol: 0.3, hold: 0.05, release: 0.2, delay: d });
    }
  };

  // --- render ---------------------------------------------------------------

  draw() {
    this.buildScene();
    this.post.composer.render();
    this.drawHud();
    this.hud.commit(this.renderer);
  }

  private buildScene() {
    const t = this.songTime;
    const speed = this.noteSpeed();
    const metal = this.metalV;
    const kick = Math.pow(1 - mod(t, BEAT) / BEAT, 3);
    const barPulse = Math.pow(1 - mod(t, BAR) / BAR, 4);

    // --- road rungs: the road is a literal metronome
    this.rungs.begin();
    const step0 = Math.floor((t - 10 / speed) / STEP);
    const step1 = Math.ceil((t + 58 / speed) / STEP);
    for (let s = step0; s <= step1; s++) {
      const z = -(s * STEP - t) * speed;
      if (z < ROAD_FAR || z > 9) continue;
      const isBar = ((s % 16) + 16) % 16 === 0;
      const isBeat = ((s % 4) + 4) % 4 === 0;
      const gain = isBar ? 2.6 + barPulse * 2 : isBeat ? 1.1 : 0.34;
      this.tint(0x6a5cff, gain * (1 - this.dimT * 0.6), metal);
      this.rungs.write(0, 0.005, z, { x: isBar ? 1.04 : isBeat ? 1 : 0.84, y: isBar ? 2.4 : 1, z: isBar ? 2.2 : 1 }, this.c1);
    }
    this.rungs.end();

    // --- judgement line, lane pads, lane dividers
    this.boxes.begin();
    this.tint(0xffffff, 4 + kick * 3.2, metal * 0.4);
    this.boxes.write(0, 0.06, 0, { x: ROAD_W, y: 0.09, z: 0.16 }, this.c1);
    for (let i = 0; i < 4; i++) {
      const f = this.laneFlash[i];
      this.tint(LANE_HEX[i], 0.5 + f * 4.5, metal);
      this.boxes.write(LANE_X[i], 0.03 + f * 0.05, 0, { x: 2.3, y: 0.06 + f * 0.14, z: 0.6 + f * 0.5 }, this.c1);
    }
    for (let i = 0; i < 5; i++) {
      this.tint(0x2b1f7a, 0.9, metal * 0.5);
      this.boxes.write(-ROAD_W / 2 + i * 2.6, 0.001, -26, { x: 0.05, y: 0.02, z: 80 }, this.c1);
    }
    this.boxes.end();

    // --- notes
    this.slabs.begin();
    this.slabGlow.begin();
    for (let k = 0; k < this.nCount; k++) {
      const i = (this.nHead + k) % MAX_NOTES;
      const st = this.nState[i];
      if (st === ST_MISSED) continue;
      const lane = this.nLane[i];
      const hex = LANE_HEX[lane];
      const x = LANE_X[lane];
      const headZ = -(this.nTime[i] - t) * speed;

      if (this.nHold[i] > 0 && st !== ST_DONE) {
        const tailZ = headZ - this.nHold[i] * speed;
        const nearZ = st === ST_HOLDING ? 0 : headZ;
        if (tailZ < 9 && nearZ > ROAD_FAR) {
          const a = Math.min(9, nearZ);
          const b = Math.max(ROAD_FAR, tailZ);
          const len = a - b;
          if (len > 0.05) {
            this.tint(hex, st === ST_HOLDING ? 2.6 : 1.2, metal);
            this.slabs.write(x, 0.16, (a + b) / 2, { x: 0.5, y: 0.5, z: len / 0.7 }, this.c1);
          }
        }
      }
      // A judged note vanishes into its own detonation; only its body lingers.
      if (st !== ST_PENDING) continue;
      if (headZ > 9 || headZ < ROAD_FAR) continue;

      if (this.nKind[i] === KIND_PULSE) {
        // The slam is one bar across the whole road; the lane-0 half draws it
        // so the two notes never stack two copies on top of each other.
        if (lane === 0) {
          this.tint(0xffe9a3, 2.6, metal);
          this.slabs.write(0, 0.2, headZ, { x: ROAD_W / 2.05, y: 1.1, z: 1.3 }, this.c1);
          this.tint(0xffffff, 3.4, 0);
          this.slabs.write(0, 0.27, headZ, { x: (ROAD_W / 2.05) * 0.92, y: 0.4, z: 0.5 }, this.c1);
        }
        this.tint(hex, 3, metal);
        this.slabs.write(x, 0.42, headZ, { x: 0.8, y: 2.4, z: 1 }, this.c1);
        this.slabGlow.write(x, 0.4, headZ, 3.6, this.c1);
        continue;
      }

      this.tint(hex, 2.2, metal);
      this.slabs.write(x, 0.2, headZ, 1, this.c1);
      this.tint(0xffffff, 3.2, 0);
      this.slabs.write(x, 0.24, headZ, { x: 0.62, y: 0.55, z: 0.42 }, this.c1);
      this.tint(hex, 1.7, metal);
      this.slabGlow.write(x, 0.24, headZ, 2.5, this.c1);

      // Connector bar so a double reads as one chord, not two taps.
      const p = this.nPartner[i];
      if (p >= 0 && this.nLane[i] < this.nLane[p] && this.nState[p] === ST_PENDING) {
        const px = LANE_X[this.nLane[p]];
        this.tint(0xffffff, 1.6, 0);
        this.slabs.write((x + px) / 2, 0.18, headZ, { x: Math.abs(px - x) / 2.05, y: 0.16, z: 0.3 }, this.c1);
      }
    }
    this.slabs.end();
    this.slabGlow.end();

    // --- edge fire
    this.edges.begin();
    const fire = this.fireV;
    // Always all 640 — the ribbon's length is the road's, only its heat changes.
    for (let i = 0; i < EDGE_SHARDS; i++) {
      const side = i & 1 ? 1 : -1;
      const k = i >> 1;
      const z = mod(k * 0.4126 + t * speed, 72) - 66;
      if (z > 9) continue;
      const wob = Math.sin(z * 0.42 + this.vTime * 3 + k) * 0.22;
      const y = 0.08 + Math.abs(Math.sin(k * 1.7 + this.vTime * 2.4)) * 1.05 * fire;
      this.tint(LANE_HEX[k & 3], 0.2 + fire * 2.9, metal);
      this.edges.write(
        side * (5.35 + wob * fire),
        y,
        z,
        0.15 + fire * 0.2,
        this.c1,
        { x: this.vTime * 2 + k, y: this.vTime * 1.3, z: k },
      );
    }
    this.edges.end();

    // --- sky solids
    this.sky.begin();
    const skyN = Math.round(this.skyV);
    const push = this.skyPush * this.skyPush * 9;
    for (let i = 0; i < skyN; i++) {
      const a = i * 2.3999; // golden angle: even coverage without a lookup table
      const spread = 5 + (i % 11) * 1.5 + push;
      // Held clear of the road's half-width so the sky frames the lanes rather
      // than sitting on top of the notes the player is trying to read.
      const x = (i & 1 ? 1 : -1) * (6.6 + Math.abs(Math.sin(a)) * spread);
      const y = 4.6 + Math.abs(Math.sin(a * 1.7)) * 11 + Math.sin(this.vTime * 0.6 + i) * 0.9 + push * 0.5;
      const z = mod(i * 3.11 + this.vTime * 15, 78) - 72;
      if (z > 9) continue;
      const sc = (0.35 + (i % 5) * 0.12) * (1 + kick * 0.3);
      this.tint(LANE_HEX[i & 3], 1.6, metal);
      this.sky.write(x, y, z, sc, this.c1, {
        x: this.vTime * (0.4 + (i % 3) * 0.2) + i,
        y: this.vTime * 0.7 + i * 0.3,
        z: 0,
      });
    }
    this.sky.end();

    // --- pylons + tunnel ring
    this.pylons.begin();
    if (this.tier >= 3) {
      for (let i = 0; i < 40; i++) {
        const z = mod(i * 4.7 + t * speed, 80) - 74;
        if (z > 9) continue;
        const side = i & 1 ? 1 : -1;
        this.tint(i & 1 ? 0x7b5cff : 0x35f0c0, 2.2, metal);
        this.pylons.write(side * 7.6, 2.4, z, { x: 0.24, y: 5 + (i % 3), z: 0.24 }, this.c1);
      }
    }
    if (this.tier >= 4) {
      const spin = this.vTime * 0.5;
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * TAU + spin;
        this.tint(TIER_HEX[4], 2.6, metal);
        this.pylons.write(Math.cos(a) * 15, 6 + Math.sin(a) * 15, -66, { x: 0.9, y: 0.9, z: 0.9 }, this.c1, {
          x: 0,
          y: 0,
          z: a,
        });
      }
    }
    this.pylons.end();

    // --- shockwaves + hit beams
    this.rings.begin();
    for (let i = 0; i < this.rCount; i++) {
      const p = clamp01(this.rAge[i] / this.rLife[i]);
      const r = lerp(this.rR0[i], this.rR1[i], easeOutQuart(p));
      this.tint(this.rHex[i], 3.5 * (1 - p), 0);
      this.rings.write(this.rx[i], this.ry[i], this.rz[i], { x: r * 2, y: r * 2, z: 1 }, this.c1);
    }
    this.rings.end();

    this.beams.begin();
    for (let i = 0; i < this.bCount; i++) {
      const p = clamp01(this.bAge[i] / 0.3);
      const lane = this.bLane[i];
      this.tint(LANE_HEX[lane], 2.6 * (1 - p) * this.bMag[i], 0);
      this.beams.write(LANE_X[lane], 7, 0.05, { x: 2.2 * (1 - p * 0.4), y: 26, z: 1 }, this.c1);
    }
    this.beams.end();

    (this.vanish.material as THREE.MeshBasicMaterial).color.copy(
      hdr(0xff2f6e, 1.1 + kick * 0.8 + this.tier * 0.25, this.c4),
    );
  }

  /** hdr() with the chrome tier's pull toward #dfe9ff folded in. */
  private tint(hex: number, gain: number, metal: number) {
    hdr(hex, 1, this.c1);
    if (metal > 0) this.c1.lerp(this.chromeCol, metal);
    this.c1.multiplyScalar(gain);
    return this.c1;
  }

  // --- HUD ------------------------------------------------------------------

  private drawHud() {
    const g = this.hud.begin();
    const W = this.w;
    const H = this.h;
    const tierCss = TIER_CSS[this.tier];
    const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";

    // Lane plates — the control map, always visible, lit on press.
    const plateH = Math.min(88, H * 0.12);
    const py = H - plateH - 8;
    const pw = W / 4;
    for (let i = 0; i < 4; i++) {
      const lit = this.laneFlash[i];
      roundRectPath(g, i * pw + 7, py, pw - 14, plateH, 12);
      g.globalAlpha = 0.08 + lit * 0.5;
      g.fillStyle = LANE_CSS[i];
      g.fill();
      g.globalAlpha = 0.3 + lit * 0.7;
      g.strokeStyle = LANE_CSS[i];
      g.lineWidth = 2;
      g.stroke();
      g.globalAlpha = 0.5 + lit * 0.5;
      g.fillStyle = "#ffffff";
      g.font = `700 ${Math.round(plateH * 0.4)}px ${mono}`;
      g.textAlign = "center";
      g.fillText(LANE_LABEL[i], i * pw + pw / 2, py + plateH * 0.66);
    }
    g.globalAlpha = 1;

    // SIGNAL
    const bw = W * 0.4;
    const by = py - 26;
    meterBar(
      g,
      (W - bw) / 2,
      by,
      bw,
      10,
      clamp01(this.signal / 100),
      clamp01(this.signalGhost / 100),
      this.signal < 30 ? "#ff2b2b" : tierCss,
    );
    g.font = `600 12px ${mono}`;
    g.fillStyle = "rgba(255,255,255,0.45)";
    g.textAlign = "center";
    g.fillText("SIGNAL", W / 2, by - 7);

    // CHAIN — the biggest thing on screen, by a mile.
    const cs = Math.min(190, W * 0.17, H * 0.23);
    const cy = 52 + cs * 0.78;
    g.font = `700 ${Math.round(cs)}px ${mono}`;
    g.textAlign = "center";
    if (this.breakT > 0) {
      const p = 1 - this.breakT;
      const spread = easeOutCubic(clamp01((p - 0.3) / 0.7));
      const txt = String(this.breakVal);
      g.globalAlpha = clamp01(this.breakT * 1.6);
      for (let i = 0; i < 3; i++) {
        const dx = (i - 1) * spread * cs * 0.35;
        const dy = spread * cs * (0.2 + i * 0.35);
        glowText(g, txt, W / 2 + dx, cy + dy, "#ff2b2b", 22);
      }
      g.globalAlpha = 1;
    }
    g.save();
    g.translate(W / 2, cy);
    g.scale(this.chainScale, this.chainScale);
    if (this.chainJit !== 0) g.rotate(this.chainJit);
    glowText(g, String(this.chain), 0, 0, tierCss, 28);
    g.restore();
    const chainW = g.measureText(String(this.chain)).width;
    g.font = `700 16px ${mono}`;
    g.fillStyle = "rgba(255,255,255,0.42)";
    g.fillText("CHAIN", W / 2, cy + 24);
    // Plain fill, not glowText: shadowBlur is the expensive call and the budget
    // is spent on the three things that must read instantly.
    const ms = Math.min(64, W * 0.055);
    g.font = `700 ${Math.round(ms)}px ${mono}`;
    g.textAlign = "left";
    g.fillStyle = tierCss;
    g.fillText(`×${this.mult()}`, W / 2 + chainW / 2 + 14, cy - cs * 0.05);

    // SCORE / BEST
    g.textAlign = "left";
    g.font = `700 ${Math.round(Math.min(50, W * 0.045))}px ${mono}`;
    glowText(g, Math.round(this.scoreShown).toLocaleString("en-US"), 22, 104, "#ffffff", 12);
    g.font = `600 13px ${mono}`;
    g.fillStyle = "rgba(255,255,255,0.45)";
    g.fillText("SCORE", 22, 124);
    g.textAlign = "right";
    g.font = `700 ${Math.round(Math.min(26, W * 0.024))}px ${mono}`;
    g.fillStyle = this.newBest ? "#ffd76a" : "rgba(255,255,255,0.6)";
    g.fillText(this.best.toLocaleString("en-US"), W - 22, 104);
    g.font = `600 13px ${mono}`;
    g.fillStyle = "rgba(255,255,255,0.45)";
    g.fillText(this.newBest ? "NEW BEST" : "BEST", W - 22, 124);

    // Judgement pop, right above the line.
    if (this.judgeT > 0) {
      const p = 1 - this.judgeT;
      g.globalAlpha = clamp01(this.judgeT * 1.7);
      g.textAlign = "center";
      const js = Math.min(52, W * 0.048) * (1 + (1 - p) * 0.25);
      g.font = `700 ${Math.round(js)}px ${mono}`;
      glowText(g, this.judgeText, W / 2, H * 0.66 - p * 30, this.judgeCss, 18);
      g.globalAlpha = 1;
    }

    // Section ticker
    if (this.sectionT > 0) {
      g.globalAlpha = clamp01(this.sectionT * 2);
      g.textAlign = "left";
      g.font = `700 ${Math.round(Math.min(24, W * 0.022))}px ${mono}`;
      const slide = (1 - easeOutCubic(clamp01((1 - this.sectionT) * 4))) * -160;
      g.fillStyle = "#8fa2c8";
      g.fillText(this.sectionBanner, 22 + slide, H * 0.3);
      g.globalAlpha = 1;
    }

    // Tier / flourish banner
    if (this.bannerT > 0) {
      const p = clamp01((1 - this.bannerT) * 5);
      const sc = 0.7 + easeOutCubic(p) * 0.3;
      g.globalAlpha = clamp01(this.bannerT * 2.2);
      g.save();
      g.translate(W / 2, H * 0.44);
      g.scale(sc, sc);
      g.textAlign = "center";
      g.font = `700 ${Math.round(Math.min(84, W * 0.076))}px ${mono}`;
      glowText(g, this.bannerText, 0, 0, this.bannerCss, 26);
      g.font = `700 ${Math.round(Math.min(30, W * 0.028))}px ${mono}`;
      g.fillStyle = "rgba(255,255,255,0.75)";
      g.fillText(this.bannerSub, 0, 40);
      g.restore();
      g.globalAlpha = 1;
    }

    if (this.bestCelebrate > 0 && this.phase === "playing") {
      g.globalAlpha = clamp01(this.bestCelebrate * 1.4);
      g.textAlign = "center";
      g.font = `700 ${Math.round(Math.min(64, W * 0.058))}px ${mono}`;
      glowText(g, "NEW PERSONAL BEST", W / 2, H * 0.56, "#ffd76a", 30);
      g.globalAlpha = 1;
    }

    if (this.phase === "attract") this.drawTitle(g, mono);
    if (this.titleBlast > 0 && this.phase === "playing") {
      // The title does not fade out, it is blown off the screen by the start.
      const p = 1 - this.titleBlast;
      g.globalAlpha = this.titleBlast;
      g.textAlign = "center";
      g.save();
      g.translate(this.w / 2, this.h * 0.5);
      g.scale(1 + p * 1.8, 1 + p * 1.8);
      g.font = `700 ${Math.round(Math.min(140, this.w * 0.13, this.h * 0.2))}px ${mono}`;
      glowText(g, "PULSEWAY", 0, 0, "#dfe9ff", 30);
      g.restore();
      g.globalAlpha = 1;
    }
    if (this.phase === "over") this.drawOver(g, mono);
  }

  private drawTitle(g: CanvasRenderingContext2D, mono: string) {
    const W = this.w;
    const H = this.h;
    const t = easeOutCubic(this.titleT);
    const breathe = 1 + Math.sin(this.realTime * 2.2) * 0.03;
    const size = Math.min(140, W * 0.13, H * 0.2);
    const ty = H * 0.5;
    g.save();
    g.translate(W / 2, ty);
    g.scale(lerp(1.5, 1, t) * breathe, lerp(1.5, 1, t) * breathe);
    g.globalAlpha = t;
    g.textAlign = "center";
    g.font = `700 ${Math.round(size)}px ${mono}`;
    const grd = g.createLinearGradient(0, -size * 0.7, 0, size * 0.25);
    grd.addColorStop(0, "#ffffff");
    grd.addColorStop(0.45, "#dfe9ff");
    grd.addColorStop(0.55, "#7f8fb5");
    grd.addColorStop(1, "#ffffff");
    g.shadowColor = "#7b5cff";
    g.shadowBlur = 34;
    g.fillStyle = grd;
    g.fillText("PULSEWAY", 0, 0);
    g.fillText("PULSEWAY", 0, 0);
    g.restore();
    g.globalAlpha = 1;

    g.textAlign = "center";
    g.font = `700 ${Math.round(Math.min(30, W * 0.028))}px ${mono}`;
    const py = ty + size * 0.62;
    const label = this.c.isTouch ? "TAP  A  LANE  TO  RUN" : "PRESS   D   F   J   K";
    g.fillStyle = "rgba(255,255,255,0.85)";
    g.fillText(label, W / 2, py);
    const lw = g.measureText(label).width;
    for (let i = 0; i < 4; i++) {
      g.fillStyle = LANE_CSS[i];
      g.globalAlpha = 0.5 + Math.abs(Math.sin(this.realTime * 3 + i * 0.7)) * 0.5;
      g.fillRect(W / 2 - lw / 2 + (lw / 4) * i + 8, py + 10, lw / 4 - 16, 4);
    }
    g.globalAlpha = 1;
    g.font = `600 14px ${mono}`;
    g.fillStyle = "rgba(255,255,255,0.4)";
    g.fillText("SOUND STARTS ON YOUR FIRST KEY", W / 2, py + 40);
  }

  private drawOver(g: CanvasRenderingContext2D, mono: string) {
    const W = this.w;
    const H = this.h;
    g.fillStyle = "rgba(4,2,12,0.62)";
    g.fillRect(0, 0, W, H);
    g.textAlign = "center";
    g.font = `700 ${Math.round(Math.min(92, W * 0.085))}px ${mono}`;
    glowText(g, "BURNOUT", W / 2, H * 0.3, "#ff2b2b", 30);
    g.font = `700 ${Math.round(Math.min(110, W * 0.1))}px ${mono}`;
    glowText(g, this.score.toLocaleString("en-US"), W / 2, H * 0.48, this.newBest ? "#ffd76a" : "#ffffff", 26);
    g.font = `700 ${Math.round(Math.min(30, W * 0.028))}px ${mono}`;
    if (this.newBest) {
      g.globalAlpha = 0.6 + Math.abs(Math.sin(this.realTime * 4)) * 0.4;
      glowText(g, "NEW PERSONAL BEST", W / 2, H * 0.56, "#ffd76a", 24);
      g.globalAlpha = 1;
    } else {
      g.fillStyle = "rgba(255,255,255,0.55)";
      g.fillText(`BEST  ${this.best.toLocaleString("en-US")}`, W / 2, H * 0.56);
    }
    g.font = `600 ${Math.round(Math.min(22, W * 0.02))}px ${mono}`;
    g.fillStyle = "rgba(255,255,255,0.6)";
    g.fillText(`${this.hitCount} NOTES  ·  SECTION ${this.curSection}`, W / 2, H * 0.63);
    g.font = `700 ${Math.round(Math.min(26, W * 0.024))}px ${mono}`;
    g.globalAlpha = 0.55 + Math.abs(Math.sin(this.realTime * 3)) * 0.45;
    g.fillStyle = "#dfe9ff";
    g.fillText(this.c.isTouch ? "TAP TO RUN AGAIN" : "SPACE  ·  RUN AGAIN", W / 2, H * 0.74);
    g.globalAlpha = 1;
  }

  /**
   * The shell's report is a React state write, so it is throttled to 10Hz —
   * a per-frame push would re-render the chrome sixty times a second for a
   * number the player is already reading off the canvas.
   */
  private pushReport() {
    const status = this.phase === "playing" ? "playing" : this.phase === "over" ? "over" : "idle";
    this.reportTick++;
    if (status === this.lastStatus && this.reportTick % 6 !== 0) return;
    this.lastStatus = status;
    const label =
      this.phase === "attract"
        ? "ATTRACT"
        : this.phase === "over"
          ? "BURNOUT"
          : `SEC ${this.section} · ×${this.mult()}`;
    this.c.report({ score: this.score, best: this.best, label, status });
  }

  // --- lifecycle ------------------------------------------------------------

  resize(width: number, height: number) {
    if (width < 2 || height < 2) return;
    this.w = width;
    this.h = height;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.post.setSize(width, height);
    this.hud.resize(width, height, this.c.dpr);
    this.particles.setViewport(height * this.c.dpr);
  }

  restart() {
    this.beginRun();
  }

  destroy() {
    this.c.audio.stopMusic();
    this.post.dispose();
    this.hud.dispose();
    this.particles.dispose();
    for (const p of this.pools()) p.dispose();
    for (const m of [this.road, this.horizon, this.vanish]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    for (const t of this.textures) t.dispose();
    this.renderer.dispose();
  }
}

// --- helpers ----------------------------------------------------------------

const mod = (v: number, m: number) => ((v % m) + m) % m;

function tierOf(chain: number) {
  let t = 0;
  for (let i = 1; i < TIER_AT.length; i++) if (chain >= TIER_AT[i]) t = i;
  return t;
}

/** Vertical sky gradient, built in code so nothing has to be fetched. */
function makeGradient(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 256;
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, "#05030f");
  grd.addColorStop(0.5, "#1b0a40");
  grd.addColorStop(0.84, "#5a1b7a");
  grd.addColorStop(1, "#ff3a72");
  g.fillStyle = grd;
  g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const factory: GameFactory = (ctx) => new Pulseway(ctx);
export default factory;
