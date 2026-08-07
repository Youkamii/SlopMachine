/**
 * SWARMFALL
 *
 * A 3D horde survivor. You move, the weapons fire themselves, and the point
 * is the escalation: hundreds of enemies on screen, gems pouring toward you,
 * a level-up every few seconds, and the whole thing getting louder and
 * brighter until it collapses.
 *
 * The design brief here is dopamine, not restraint. Every kill throws debris,
 * every gem snaps to you with a chime, every level-up freezes time and hands
 * you three cards. Numbers get big fast on purpose.
 *
 * Rendered with three.js: instanced meshes for the horde so a thousand
 * enemies cost one draw call, additive sprites for everything that glows,
 * and a bloom pass over the top.
 */

import * as THREE from "three";
import type { PostStack } from "@/engine/gl/post";
import { makePost } from "@/engine/gl/post";
import { clamp, clamp01, damp, lerp } from "@/engine/math";
import type { GameContext, GameFactory, GameInstance } from "@/games/types";

// --- tuning -----------------------------------------------------------------

const ARENA = 46;
const MAX_ENEMIES = 900;
const MAX_BULLETS = 600;
const MAX_GEMS = 700;
const MAX_DEBRIS = 900;

const PLAYER_SPEED = 15.5;
const PICKUP_BASE = 3.4;

// --- weapons ----------------------------------------------------------------

type WeaponId = "bolt" | "orbit" | "nova" | "chain" | "spray";

interface Weapon {
  id: WeaponId;
  name: string;
  blurb: string;
  level: number;
  cooldown: number;
  timer: number;
}

const WEAPON_DEFS: Record<WeaponId, { name: string; blurb: string; cd: number }> = {
  bolt: { name: "BOLT", blurb: "Fires at the nearest thing", cd: 0.42 },
  spray: { name: "SPRAY", blurb: "A cone of shrapnel", cd: 0.72 },
  orbit: { name: "ORBIT", blurb: "Blades circle you forever", cd: 0 },
  nova: { name: "NOVA", blurb: "Detonates a ring around you", cd: 2.1 },
  chain: { name: "CHAIN", blurb: "Lightning jumps between bodies", cd: 1.35 },
};

interface Card {
  id: WeaponId | "heal" | "magnet" | "speed";
  title: string;
  body: string;
}

type Phase = "title" | "playing" | "levelup" | "dead";

class Swarmfall implements GameInstance {
  private readonly c: GameContext;

  // --- three.js
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private enemyMesh!: THREE.InstancedMesh;
  private bulletMesh!: THREE.InstancedMesh;
  private gemMesh!: THREE.InstancedMesh;
  private debrisMesh!: THREE.InstancedMesh;
  private bladeMesh!: THREE.InstancedMesh;
  private playerMesh!: THREE.Mesh;
  private playerGlow!: THREE.Sprite;
  private playerRing!: THREE.Mesh;
  private novaRing!: THREE.Mesh;
  private post!: PostStack;
  private enemyOutline!: THREE.InstancedMesh;
  private ready = false;

  private dummy = new THREE.Object3D();
  private tmpColor = new THREE.Color();

  // --- state
  private w = 0;
  private h = 0;
  private phase: Phase = "title";
  private time = 0;
  private titleTime = 0;
  private deadTime = 0;

  private px = 0;
  private pz = 0;
  private pvx = 0;
  private pvz = 0;
  private facing = 0;

  private hp = 100;
  private maxHp = 100;
  private xp = 0;
  private xpNeed = 8;
  private level = 1;
  private kills = 0;
  private score = 0;
  private best = 0;
  private pickupRange = PICKUP_BASE;
  private speedMul = 1;
  private invuln = 0;

  private weapons: Weapon[] = [];
  private cards: Card[] = [];
  private cardRects: Array<{ x: number; y: number; w: number; h: number }> = [];
  private levelFlash = 0;

  // Structure-of-arrays for everything numerous.
  private ex = new Float32Array(MAX_ENEMIES);
  private ez = new Float32Array(MAX_ENEMIES);
  private ehp = new Float32Array(MAX_ENEMIES);
  private etype = new Uint8Array(MAX_ENEMIES);
  private ehit = new Float32Array(MAX_ENEMIES);
  private eCount = 0;

  private bx = new Float32Array(MAX_BULLETS);
  private bz = new Float32Array(MAX_BULLETS);
  private bvx = new Float32Array(MAX_BULLETS);
  private bvz = new Float32Array(MAX_BULLETS);
  private blife = new Float32Array(MAX_BULLETS);
  private bdmg = new Float32Array(MAX_BULLETS);
  private bCount = 0;

  private gx = new Float32Array(MAX_GEMS);
  private gz = new Float32Array(MAX_GEMS);
  private gvx = new Float32Array(MAX_GEMS);
  private gvz = new Float32Array(MAX_GEMS);
  private gval = new Float32Array(MAX_GEMS);
  private gCount = 0;

  private dx = new Float32Array(MAX_DEBRIS);
  private dy = new Float32Array(MAX_DEBRIS);
  private dz = new Float32Array(MAX_DEBRIS);
  private dvx = new Float32Array(MAX_DEBRIS);
  private dvy = new Float32Array(MAX_DEBRIS);
  private dvz = new Float32Array(MAX_DEBRIS);
  private dlife = new Float32Array(MAX_DEBRIS);
  private dhue = new Float32Array(MAX_DEBRIS);
  private dCount = 0;

  private spawnTimer = 0;
  private waveTimer = 6;
  private camX = 0;
  private camZ = 0;
  private camTarget = 24;
  private shake = 0;
  private novaTimer = 0;
  private musicStep = 0;
  private musicAcc = 0;

  constructor(ctx: GameContext) {
    this.c = ctx;
    this.best = ctx.store.best("best") ?? 0;
    this.initThree();
    ctx.report({ status: "idle", score: 0 });
  }

  // --- setup ----------------------------------------------------------------

  private initThree() {
    const canvas = this.c.canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(this.c.dpr, 2));
    this.renderer.setClearColor(0x05060d, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x05060d, 34, 78);

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 200);

    // Ground: a dark plane with an emissive grid drawn into its material.
    const groundGeo = new THREE.PlaneGeometry(ARENA * 2.4, ARENA * 2.4, 1, 1);
    const groundMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        varying vec2 vUv;
        varying float vDepth;
        void main() {
          vUv = uv;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      // The grid has to stay a floor, not become the subject. Two grid
      // scales give the plane a sense of size, and everything fades to black
      // with view depth so the frame keeps real shadow in it — a screen with
      // no darkness anywhere reads as washed out no matter how the colours
      // are tuned.
      fragmentShader: `
        varying vec2 vUv;
        varying float vDepth;
        uniform float uTime;

        float gridLine(vec2 uv, float scale, float w) {
          vec2 g = abs(fract(uv * scale) - 0.5);
          vec2 d = fwidth(uv * scale);
          vec2 l = smoothstep(vec2(0.0), d * w, g);
          return 1.0 - min(l.x, l.y);
        }

        void main() {
          float fine = gridLine(vUv, 96.0, 1.6);
          float coarse = gridLine(vUv, 12.0, 2.2);
          vec2 c = vUv - 0.5;
          float r = length(c);

          float pulse = 0.5 + 0.5 * sin(uTime * 1.6 - r * 30.0);

          vec3 col = vec3(0.006, 0.010, 0.022);
          col += vec3(0.020, 0.070, 0.130) * fine * (0.30 + pulse * 0.35);
          col += vec3(0.040, 0.180, 0.340) * coarse * (0.45 + pulse * 0.55);
          col += vec3(0.010, 0.040, 0.090) * smoothstep(0.42, 0.02, r);

          // Depth fade, plus a hard cut past the arena so the floor does not
          // stretch to the horizon as a bright haze.
          float fade = 1.0 - smoothstep(18.0, 62.0, vDepth);
          col *= fade * (1.0 - smoothstep(0.40, 0.50, r));
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);
    (ground.material as THREE.ShaderMaterial).needsUpdate = true;
    this.groundMat = groundMat;

    // Arena rim so the edge of the world reads.
    const rim = new THREE.Mesh(
      new THREE.RingGeometry(ARENA - 0.35, ARENA, 128),
      new THREE.MeshBasicMaterial({
        color: 0x2ad4ff,
        transparent: true,
        opacity: 0.45,
        side: THREE.DoubleSide,
      }),
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = 0.02;
    this.scene.add(rim);

    // --- instanced pools
    // NOTE: do NOT set vertexColors here. That switches the shader to read a
    // per-vertex colour attribute the geometry does not have, and everything
    // renders black. InstancedMesh.instanceColor is a separate path and is
    // picked up automatically.
    // Lit rather than emissive. An unlit icosahedron viewed from a high
    // camera is a flat coloured polygon — it reads as a 2D sticker lying on
    // the floor. Facet shading is what makes the horde look like objects.
    // instanceColor multiplies the diffuse term, so values above 1 still
    // blow past the bloom threshold on the lit faces while the shadowed
    // faces stay dark, which is exactly the read we want.
    this.scene.add(new THREE.AmbientLight(0x4a6bd0, 0.55));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.1);
    keyLight.position.set(0.45, 1, 0.35);
    this.scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0xff4d8d, 0.8);
    rimLight.position.set(-0.6, 0.25, -0.7);
    this.scene.add(rimLight);

    this.enemyMesh = this.makeInstanced(
      new THREE.IcosahedronGeometry(0.62, 0),
      MAX_ENEMIES,
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      true,
    );
    // A back-face hull scaled up slightly draws as a hard black silhouette
    // around every enemy. Without it the bloom eats the shapes and sixty
    // enemies read as one white smear. One extra draw call for the horde.
    this.enemyOutline = this.makeInstanced(
      new THREE.IcosahedronGeometry(0.62, 0),
      MAX_ENEMIES,
      new THREE.MeshBasicMaterial({
        color: 0x02030a,
        side: THREE.BackSide,
      }),
      false,
    );
    this.bulletMesh = this.makeInstanced(
      new THREE.SphereGeometry(0.24, 8, 6),
      MAX_BULLETS,
      new THREE.MeshBasicMaterial({
        color: 0xfff0a0,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.gemMesh = this.makeInstanced(
      new THREE.OctahedronGeometry(0.32, 0),
      MAX_GEMS,
      new THREE.MeshBasicMaterial({
        color: 0x5cf2ff,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.debrisMesh = this.makeInstanced(
      new THREE.TetrahedronGeometry(0.3, 0),
      MAX_DEBRIS,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
      true,
    );
    this.bladeMesh = this.makeInstanced(
      new THREE.BoxGeometry(1.5, 0.16, 0.32),
      12,
      new THREE.MeshBasicMaterial({
        color: 0xff5ad0,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );

    // Player. The hull is lit like the horde so it has facets, and a black
    // back-face shell keeps it legible when it is standing inside its own
    // muzzle glow — previously the ship and the glow were one white smear.
    this.playerMesh = new THREE.Mesh(
      new THREE.ConeGeometry(0.62, 1.9, 4),
      new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x0a2a3a }),
    );
    this.playerMesh.rotation.x = Math.PI / 2;
    this.scene.add(this.playerMesh);

    const hullShell = new THREE.Mesh(
      new THREE.ConeGeometry(0.62 * 1.2, 1.9 * 1.14, 4),
      new THREE.MeshBasicMaterial({ color: 0x02030a, side: THREE.BackSide }),
    );
    this.playerMesh.add(hullShell);

    // A thin ring on the floor under the ship. Without a ground contact cue
    // the player reads as floating and it becomes hard to judge pickup range.
    this.playerRing = new THREE.Mesh(
      new THREE.RingGeometry(1.5, 1.72, 48),
      new THREE.MeshBasicMaterial({
        color: 0x2ad4ff,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.playerRing.rotation.x = -Math.PI / 2;
    this.scene.add(this.playerRing);

    this.playerGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeGlowTexture(),
        color: 0x7fe9ff,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.playerGlow.scale.set(7, 7, 1);
    this.scene.add(this.playerGlow);

    this.novaRing = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.0, 64),
      new THREE.MeshBasicMaterial({
        color: 0xffe14d,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.novaRing.rotation.x = -Math.PI / 2;
    this.novaRing.position.y = 0.4;
    this.scene.add(this.novaRing);

    // Bloom is what makes this read as a modern 3D game rather than flat
    // shapes on a dark plane. Threshold is low so the additive sprites and
    // bright enemies all bleed.
    // Threshold matters more than strength. At 0.2 the ground grid and every
    // ordinary surface bloomed too, which blew the whole frame out to a white
    // haze with no readable shapes. Only genuinely HDR emitters should bleed.
    this.post = makePost(this.renderer, this.scene, this.camera, {
      strength: 0.95,
      radius: 0.55,
      threshold: 0.72,
    });
    this.post.grade.uniforms.vignette.value = 1.32;

    this.ready = true;
  }

  private groundMat!: THREE.ShaderMaterial;

  private makeInstanced(
    geo: THREE.BufferGeometry,
    count: number,
    mat: THREE.Material,
    perInstanceColour = false,
  ) {
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    if (perInstanceColour) {
      const attr = new THREE.InstancedBufferAttribute(
        new Float32Array(count * 3).fill(1),
        3,
      );
      attr.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = attr;
    }
    this.scene.add(mesh);
    return mesh;
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    if (!this.ready) return;
    this.renderer.setSize(w, h, false);
    this.post?.setSize(w, h);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    if (this.phase === "levelup") this.layoutCards();
  }

  destroy() {
    this.post?.dispose();
    this.renderer?.dispose();
  }

  // --- lifecycle ------------------------------------------------------------

  restart() {
    this.phase = "playing";
    this.time = 0;
    this.px = 0;
    this.pz = 0;
    this.pvx = 0;
    this.pvz = 0;
    this.hp = this.maxHp = 100;
    this.xp = 0;
    this.xpNeed = 8;
    this.level = 1;
    this.kills = 0;
    this.score = 0;
    this.pickupRange = PICKUP_BASE;
    this.speedMul = 1;
    this.invuln = 0;
    this.eCount = 0;
    this.bCount = 0;
    this.gCount = 0;
    this.dCount = 0;
    this.spawnTimer = 0;
    this.waveTimer = 6;
    this.camX = 0;
    this.camZ = 0;
    this.camTarget = 24;
    this.weapons = [
      { id: "bolt", name: "BOLT", blurb: "", level: 1, cooldown: WEAPON_DEFS.bolt.cd, timer: 0 },
    ];
    this.c.report({ status: "playing", score: 0 });
  }

  // --- update ---------------------------------------------------------------

  update(dt: number) {
    const { input } = this.c;
    this.time += dt;
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 3.4);
    if (this.levelFlash > 0) this.levelFlash -= dt;

    if (this.phase === "title") {
      this.titleTime += dt;
      if (this.titleTime > 0.2 && (input.pointer.justUp || input.confirmPressed)) {
        this.c.audio.play({
          wave: "sawtooth", freq: 70, freqTo: 210, glide: 0.22,
          vol: 0.2, attack: 0.005, hold: 0.08, release: 0.3, filter: 1600,
        });
        this.restart();
      }
      return;
    }

    if (this.phase === "levelup") {
      this.pickCard();
      return;
    }

    if (this.phase === "dead") {
      this.deadTime += dt;
      this.stepDebris(dt);
      if (this.deadTime > 0.8 && (input.pointer.justUp || input.confirmPressed)) {
        this.restart();
      }
      return;
    }

    this.movePlayer(dt);
    this.spawnEnemies(dt);
    this.stepEnemies(dt);
    this.fireWeapons(dt);
    this.stepBullets(dt);
    this.stepGems(dt);
    this.stepDebris(dt);
    this.music(dt);

    if (this.invuln > 0) this.invuln -= dt;
    this.score = this.kills * 10 + Math.floor(this.time * 2);
    this.publishHud();
  }

  private movePlayer(dt: number) {
    const { input } = this.c;
    let dx = input.axisX;
    let dz = input.axisY;

    // Pointer steering: hold anywhere and the ship runs that way.
    if (input.pointer.down) {
      const cx = this.w / 2;
      const cy = this.h / 2;
      const ax = input.pointer.x - cx;
      const ay = input.pointer.y - cy;
      const len = Math.hypot(ax, ay);
      if (len > 24) {
        dx = ax / len;
        dz = ay / len;
      }
    }

    const len = Math.hypot(dx, dz) || 1;
    const speed = PLAYER_SPEED * this.speedMul;
    const tvx = (dx / len) * speed * (dx || dz ? 1 : 0);
    const tvz = (dz / len) * speed * (dx || dz ? 1 : 0);
    this.pvx = damp(this.pvx, tvx, 0.35, dt);
    this.pvz = damp(this.pvz, tvz, 0.35, dt);
    this.px += this.pvx * dt;
    this.pz += this.pvz * dt;

    const r = Math.hypot(this.px, this.pz);
    if (r > ARENA - 1.2) {
      const k = (ARENA - 1.2) / r;
      this.px *= k;
      this.pz *= k;
    }
    if (Math.abs(this.pvx) + Math.abs(this.pvz) > 0.6) {
      this.facing = Math.atan2(this.pvx, this.pvz);
    }
  }

  /**
   * Spawns on a ring around the PLAYER, not around the arena centre.
   *
   * The first version used the arena centre, so once the player drifted to
   * the rim every new enemy appeared on the far side of the world and spent
   * six seconds walking. A screenshot at four seconds in had literally zero
   * enemies visible — a horde survivor with no horde.
   *
   * It also targets a live population rather than a spawn rate. Rate-based
   * spawning goes thin exactly when the player's damage output is highest,
   * which is backwards: the screen should fill up as you get stronger.
   */
  private spawnOne(angle: number, radius: number, minute: number) {
    if (this.eCount >= MAX_ENEMIES) return;
    const rng = this.c.rng;
    let x = this.px + Math.cos(angle) * radius;
    let z = this.pz + Math.sin(angle) * radius;
    // Fold anything outside the arena back across the boundary so enemies
    // never appear stranded in the void.
    const d = Math.hypot(x, z);
    if (d > ARENA * 0.97) {
      const k = (ARENA * 0.97) / d;
      x *= k;
      z *= k;
    }
    const idx = this.eCount++;
    this.ex[idx] = x;
    this.ez[idx] = z;
    const roll = rng.next();
    const tier = minute > 2.0 && roll > 0.9 ? 2 : minute > 0.7 && roll > 0.66 ? 1 : 0;
    this.etype[idx] = tier;
    this.ehp[idx] = [3, 9, 26][tier] * (1 + minute * 0.5);
    this.ehit[idx] = 0;
  }

  private spawnEnemies(dt: number) {
    const minute = this.time / 60;
    const rng = this.c.rng;

    // A ring just past the far edge of the frame, so they walk into view
    // rather than popping in, but close enough to arrive within a second.
    const ring = () => rng.range(27, 35);

    // Timed waves: a full circle drops at once and the screen visibly floods.
    this.waveTimer -= dt;
    if (this.waveTimer <= 0) {
      this.waveTimer = lerp(24, 13, clamp01(minute / 4));
      const n = Math.round(lerp(26, 90, clamp01(minute / 4)));
      const base = rng.angle();
      for (let i = 0; i < n; i++) {
        this.spawnOne(base + (i / n) * Math.PI * 2, rng.range(30, 34), minute);
      }
      this.levelFlash = Math.max(this.levelFlash, 0.5);
      this.shake = Math.max(this.shake, 0.5);
      this.c.audio.play({
        wave: "sine", freq: 78, freqTo: 34, glide: 0.55,
        vol: 0.34, attack: 0.005, hold: 0.1, release: 0.5,
      });
      this.c.audio.play({
        wave: "sawtooth", freq: 150, freqTo: 60, glide: 0.4,
        vol: 0.16, filter: 1400, filterTo: 260, release: 0.4,
      });
    }

    // Trickle toward the target population between waves.
    const target = Math.round(lerp(34, 300, clamp01(minute / 4.5)));
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnTimer = 0.18;
    const deficit = target - this.eCount;
    if (deficit <= 0) return;
    const batch = Math.min(deficit, Math.round(lerp(5, 22, clamp01(minute / 4))));
    for (let i = 0; i < batch; i++) this.spawnOne(rng.angle(), ring(), minute);
  }

  private stepEnemies(dt: number) {
    const speeds = [6.4, 4.6, 3.4];
    for (let i = 0; i < this.eCount; i++) {
      const dx = this.px - this.ex[i];
      const dz = this.pz - this.ez[i];
      const d = Math.hypot(dx, dz) || 1;
      const sp = speeds[this.etype[i]];
      this.ex[i] += (dx / d) * sp * dt;
      this.ez[i] += (dz / d) * sp * dt;
      if (this.ehit[i] > 0) this.ehit[i] -= dt;

      // Touching the player hurts.
      if (d < 1.5 && this.invuln <= 0) {
        this.hp -= [8, 14, 24][this.etype[i]];
        this.invuln = 0.7;
        this.shake = Math.max(this.shake, 1.4);
        this.c.fx.flash("#ff3355", 0.12);
        this.c.audio.play({
          wave: "noise", freq: 500, freqTo: 90, vol: 0.22,
          attack: 0.001, hold: 0.03, release: 0.2, filter: 1400, filterTo: 260,
        });
        if (this.hp <= 0) {
          this.die();
          return;
        }
      }
    }
  }

  private fireWeapons(dt: number) {
    for (const wp of this.weapons) {
      if (wp.id === "orbit") continue;
      wp.timer -= dt;
      if (wp.timer > 0) continue;
      wp.timer = wp.cooldown / (1 + (wp.level - 1) * 0.22);

      switch (wp.id) {
        case "bolt": {
          const shots = 1 + Math.floor((wp.level - 1) / 2);
          for (let s = 0; s < shots; s++) {
            const t = this.nearestEnemy(s);
            if (t < 0) break;
            this.shoot(this.ex[t], this.ez[t], 40, 5 + wp.level * 3);
          }
          this.blip(880, 0.05);
          break;
        }
        case "spray": {
          const n = 4 + wp.level;
          const base = this.facing;
          for (let s = 0; s < n; s++) {
            const a = base + (s - (n - 1) / 2) * 0.22;
            this.shootDir(Math.sin(a), Math.cos(a), 34, 3 + wp.level * 2);
          }
          this.blip(520, 0.05);
          break;
        }
        case "nova": {
          const radius = 7 + wp.level * 1.9;
          this.novaTimer = 0.42;
          let hits = 0;
          for (let i = 0; i < this.eCount; i++) {
            const d = Math.hypot(this.ex[i] - this.px, this.ez[i] - this.pz);
            if (d > radius) continue;
            hits++;
            this.damage(i, 12 + wp.level * 9);
            i--;
          }
          this.shake = Math.max(this.shake, 1.1);
          this.c.audio.play({
            wave: "sine", freq: 130, freqTo: 44, glide: 0.3,
            vol: 0.2, attack: 0.002, hold: 0.06, release: 0.3,
          });
          void hits;
          break;
        }
        case "chain": {
          let src = this.nearestEnemy(0);
          const jumps = 3 + wp.level;
          for (let j = 0; j < jumps && src >= 0; j++) {
            const sx = this.ex[src];
            const sz = this.ez[src];
            this.damage(src, 9 + wp.level * 7);
            this.spawnDebris(sx, sz, 0.55, 6);
            src = this.nearestTo(sx, sz, 12);
          }
          this.c.audio.play({
            wave: "square", freq: 1500, freqTo: 400, glide: 0.12,
            vol: 0.12, attack: 0.001, hold: 0.02, release: 0.1, filter: 4000,
          });
          break;
        }
      }
    }
    if (this.novaTimer > 0) this.novaTimer -= dt;
  }

  private nearestEnemy(skip: number): number {
    let best = -1;
    let bestD = Infinity;
    let seen = 0;
    for (let i = 0; i < this.eCount; i++) {
      const d = (this.ex[i] - this.px) ** 2 + (this.ez[i] - this.pz) ** 2;
      if (d < bestD) {
        if (seen++ < skip) continue;
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private nearestTo(x: number, z: number, maxD: number): number {
    let best = -1;
    let bestD = maxD * maxD;
    for (let i = 0; i < this.eCount; i++) {
      const d = (this.ex[i] - x) ** 2 + (this.ez[i] - z) ** 2;
      if (d < bestD && d > 0.01) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private shoot(tx: number, tz: number, speed: number, dmg: number) {
    const dx = tx - this.px;
    const dz = tz - this.pz;
    const d = Math.hypot(dx, dz) || 1;
    this.shootDir(dx / d, dz / d, speed, dmg);
  }

  private shootDir(dx: number, dz: number, speed: number, dmg: number) {
    if (this.bCount >= MAX_BULLETS) return;
    const i = this.bCount++;
    this.bx[i] = this.px;
    this.bz[i] = this.pz;
    this.bvx[i] = dx * speed;
    this.bvz[i] = dz * speed;
    this.blife[i] = 1.5;
    this.bdmg[i] = dmg;
  }

  private stepBullets(dt: number) {
    for (let i = 0; i < this.bCount; i++) {
      this.bx[i] += this.bvx[i] * dt;
      this.bz[i] += this.bvz[i] * dt;
      this.blife[i] -= dt;
      let dead = this.blife[i] <= 0;

      if (!dead) {
        for (let e = 0; e < this.eCount; e++) {
          const d2 = (this.ex[e] - this.bx[i]) ** 2 + (this.ez[e] - this.bz[i]) ** 2;
          if (d2 > 1.3) continue;
          this.damage(e, this.bdmg[i]);
          dead = true;
          break;
        }
      }
      if (dead) {
        const j = --this.bCount;
        this.bx[i] = this.bx[j]; this.bz[i] = this.bz[j];
        this.bvx[i] = this.bvx[j]; this.bvz[i] = this.bvz[j];
        this.blife[i] = this.blife[j]; this.bdmg[i] = this.bdmg[j];
        i--;
      }
    }

    // Orbiting blades damage on contact.
    const orbit = this.weapons.find((w) => w.id === "orbit");
    if (orbit) {
      const n = 2 + orbit.level;
      const r = 4.2 + orbit.level * 0.35;
      for (let b = 0; b < n; b++) {
        const a = this.time * 3.1 + (b / n) * Math.PI * 2;
        const ox = this.px + Math.cos(a) * r;
        const oz = this.pz + Math.sin(a) * r;
        for (let e = 0; e < this.eCount; e++) {
          const d2 = (this.ex[e] - ox) ** 2 + (this.ez[e] - oz) ** 2;
          if (d2 > 1.7) continue;
          this.damage(e, (6 + orbit.level * 4) * dt * 8);
          break;
        }
      }
    }
  }

  private damage(i: number, amount: number) {
    this.ehp[i] -= amount;
    this.ehit[i] = 0.12;
    if (this.ehp[i] > 0) return;

    const tier = this.etype[i];
    this.kills++;
    this.spawnDebris(this.ex[i], this.ez[i], 0.8 + tier * 0.5, 7 + tier * 6);
    this.dropGem(this.ex[i], this.ez[i], [1, 3, 9][tier]);
    this.c.audio.play({
      wave: "noise", freq: 900 - tier * 200, freqTo: 160, vol: 0.055,
      attack: 0.001, hold: 0.012, release: 0.07, filter: 2600, filterTo: 500,
    });
    if (tier > 0) this.shake = Math.max(this.shake, 0.5 + tier * 0.4);

    const j = --this.eCount;
    this.ex[i] = this.ex[j]; this.ez[i] = this.ez[j];
    this.ehp[i] = this.ehp[j]; this.etype[i] = this.etype[j];
    this.ehit[i] = this.ehit[j];
  }

  private dropGem(x: number, z: number, val: number) {
    if (this.gCount >= MAX_GEMS) return;
    const i = this.gCount++;
    this.gx[i] = x;
    this.gz[i] = z;
    this.gvx[i] = this.c.rng.spread(4);
    this.gvz[i] = this.c.rng.spread(4);
    this.gval[i] = val;
  }

  private stepGems(dt: number) {
    for (let i = 0; i < this.gCount; i++) {
      const dx = this.px - this.gx[i];
      const dz = this.pz - this.gz[i];
      const d = Math.hypot(dx, dz) || 1;

      // Magnet: inside the pickup radius they accelerate hard toward you.
      // The snap is the reward, so it is deliberately overtuned.
      if (d < this.pickupRange) {
        const pull = 70 * (1 - d / this.pickupRange) + 22;
        this.gvx[i] += (dx / d) * pull * dt * 6;
        this.gvz[i] += (dz / d) * pull * dt * 6;
      } else {
        this.gvx[i] *= 0.9;
        this.gvz[i] *= 0.9;
      }
      this.gx[i] += this.gvx[i] * dt;
      this.gz[i] += this.gvz[i] * dt;

      if (d < 1.1) {
        this.xp += this.gval[i];
        this.c.audio.play({
          wave: "square",
          freq: 1200 + Math.min(this.xp, 40) * 14,
          vol: 0.045, attack: 0.001, hold: 0.008, release: 0.05,
        });
        const j = --this.gCount;
        this.gx[i] = this.gx[j]; this.gz[i] = this.gz[j];
        this.gvx[i] = this.gvx[j]; this.gvz[i] = this.gvz[j];
        this.gval[i] = this.gval[j];
        i--;
        if (this.xp >= this.xpNeed) this.openLevelUp();
      }
    }
  }

  private spawnDebris(x: number, z: number, scale: number, n: number) {
    const rng = this.c.rng;
    for (let k = 0; k < n && this.dCount < MAX_DEBRIS; k++) {
      const i = this.dCount++;
      this.dx[i] = x;
      this.dy[i] = 0.6;
      this.dz[i] = z;
      this.dvx[i] = rng.spread(9) * scale;
      this.dvy[i] = rng.range(3, 12) * scale;
      this.dvz[i] = rng.spread(9) * scale;
      this.dlife[i] = rng.range(0.4, 0.95);
      this.dhue[i] = rng.range(0, 1);
    }
  }

  private stepDebris(dt: number) {
    for (let i = 0; i < this.dCount; i++) {
      this.dvy[i] -= 26 * dt;
      this.dx[i] += this.dvx[i] * dt;
      this.dy[i] += this.dvy[i] * dt;
      this.dz[i] += this.dvz[i] * dt;
      this.dlife[i] -= dt;
      if (this.dlife[i] <= 0 || this.dy[i] < 0) {
        const j = --this.dCount;
        this.dx[i] = this.dx[j]; this.dy[i] = this.dy[j]; this.dz[i] = this.dz[j];
        this.dvx[i] = this.dvx[j]; this.dvy[i] = this.dvy[j]; this.dvz[i] = this.dvz[j];
        this.dlife[i] = this.dlife[j]; this.dhue[i] = this.dhue[j];
        i--;
      }
    }
  }

  // --- level up -------------------------------------------------------------

  private openLevelUp() {
    this.xp -= this.xpNeed;
    this.level++;
    this.xpNeed = Math.round(this.xpNeed * 1.42 + 3);
    this.phase = "levelup";
    this.levelFlash = 0.5;
    this.shake = 1.6;
    this.cards = this.rollCards();
    this.layoutCards();
    this.publishHud();
    this.c.fx.flash("#ffe14d", 0.14);
    [0, 4, 7, 12, 16].forEach((s, i) =>
      this.c.audio.play({
        wave: "square", freq: 330 * Math.pow(2, s / 12),
        vol: 0.13, attack: 0.002, hold: 0.04, release: 0.25, delay: i * 0.05,
        filter: 3000,
      }),
    );
  }

  private rollCards(): Card[] {
    const rng = this.c.rng;
    const pool: Card[] = [];
    for (const id of Object.keys(WEAPON_DEFS) as WeaponId[]) {
      const have = this.weapons.find((w) => w.id === id);
      if (have && have.level >= 6) continue;
      pool.push({
        id,
        title: have ? `${WEAPON_DEFS[id].name} ${have.level + 1}` : WEAPON_DEFS[id].name,
        body: have ? "Stronger. Faster." : WEAPON_DEFS[id].blurb,
      });
    }
    pool.push({ id: "heal", title: "PATCH", body: "Refill health" });
    pool.push({ id: "magnet", title: "MAGNET", body: "Wider pickup radius" });
    pool.push({ id: "speed", title: "BOOST", body: "Move faster" });
    rng.shuffle(pool);
    return pool.slice(0, 3);
  }

  private pickCard() {
    const { input } = this.c;
    let choice = -1;
    if (input.wasPressed("Digit1")) choice = 0;
    if (input.wasPressed("Digit2")) choice = 1;
    if (input.wasPressed("Digit3")) choice = 2;

    if (choice < 0 && input.pointer.justUp) {
      for (let i = 0; i < this.cardRects.length; i++) {
        const r = this.cardRects[i];
        if (
          input.pointer.x >= r.x && input.pointer.x <= r.x + r.w &&
          input.pointer.y >= r.y && input.pointer.y <= r.y + r.h
        ) {
          choice = i;
          break;
        }
      }
    }
    if (choice < 0 || choice >= this.cards.length) return;

    const card = this.cards[choice];
    if (card.id === "heal") {
      this.hp = this.maxHp;
    } else if (card.id === "magnet") {
      this.pickupRange *= 1.5;
    } else if (card.id === "speed") {
      this.speedMul *= 1.14;
    } else {
      const have = this.weapons.find((w) => w.id === card.id);
      if (have) have.level++;
      else {
        this.weapons.push({
          id: card.id,
          name: WEAPON_DEFS[card.id].name,
          blurb: "",
          level: 1,
          cooldown: WEAPON_DEFS[card.id].cd,
          timer: 0,
        });
      }
    }
    this.c.audio.play({
      wave: "triangle", freq: 520, freqTo: 780, glide: 0.1,
      vol: 0.16, attack: 0.003, hold: 0.04, release: 0.2,
    });
    this.phase = "playing";
    this.publishHud();
  }

  private die() {
    this.phase = "dead";
    this.deadTime = 0;
    this.shake = 2.4;
    this.c.fx.flash("#ff3355", 0.2);
    this.spawnDebris(this.px, this.pz, 2.2, 60);
    this.c.audio.explode(0.34);
    this.c.audio.play({
      wave: "sawtooth", freq: 180, freqTo: 34, glide: 0.8,
      vol: 0.24, attack: 0.006, hold: 0.12, release: 0.6, filter: 1200, filterTo: 140,
    });
    if (this.c.store.recordBest("best", this.score)) this.best = this.score;
    this.publishHud();
  }

  private blip(freq: number, vol: number) {
    this.c.audio.play({
      wave: "square", freq, vol, attack: 0.001, hold: 0.008,
      release: 0.04, filter: 5000,
    });
  }

  /** Drums that get denser as the run escalates. */
  private music(dt: number) {
    const minute = clamp01(this.time / 240);
    const bpm = lerp(96, 158, minute);
    const step = 60 / bpm / 4;
    this.musicAcc += dt;
    while (this.musicAcc >= step) {
      this.musicAcc -= step;
      const s = this.musicStep++ % 16;
      if (s % 4 === 0) {
        this.c.audio.play({
          wave: "sine", freq: 58, freqTo: 40, glide: 0.09,
          vol: 0.15, attack: 0.002, hold: 0.03, release: 0.1,
        });
      }
      if (minute > 0.2 && s % 8 === 4) {
        this.c.audio.play({
          wave: "noise", freq: 2400, vol: 0.05,
          attack: 0.001, hold: 0.006, release: 0.05,
          filter: 5200, filterType: "highpass",
        });
      }
      if (minute > 0.45 && s % 2 === 1) {
        const arp = [0, 3, 7, 10, 12][Math.floor(this.musicStep / 2) % 5];
        this.c.audio.play({
          wave: "square", freq: 110 * Math.pow(2, arp / 12),
          vol: 0.035, attack: 0.001, hold: 0.01, release: 0.06, filter: 2400,
        });
      }
    }
  }

  // --- render ---------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D) {
    if (!this.ready) return;
    this.groundMat.uniforms.uTime.value = this.time;

    // Camera follows the player rather than easing back toward the arena
    // centre. The old rig put the ship a third of the way to the edge of the
    // frame whenever the player moved out, so the side you were running
    // toward — the side the horde was on — was the side you could not see.
    // Height doubles as the zoom: it pulls back as the horde thickens, which
    // makes the pressure legible without any HUD element saying so.
    const camPressure = clamp01(this.eCount / 260);
    this.camTarget = damp(this.camTarget, 23 + camPressure * 7, 0.04, 1 / 60);
    const camDist = this.camTarget;
    const sh = this.shake;
    const shx = sh > 0 ? Math.sin(this.time * 61) * sh * 0.6 : 0;
    const shz = sh > 0 ? Math.cos(this.time * 47) * sh * 0.6 : 0;
    // Lead the camera slightly into the direction of travel.
    const leadX = clamp(this.pvx * 0.22, -5, 5);
    const leadZ = clamp(this.pvz * 0.22, -5, 5);
    this.camX = damp(this.camX, this.px + leadX, 0.22, 1 / 60);
    this.camZ = damp(this.camZ, this.pz + leadZ, 0.22, 1 / 60);
    this.camera.position.set(
      this.camX + shx,
      camDist,
      this.camZ + camDist * 0.58 + shz,
    );
    this.camera.lookAt(this.camX, 0, this.camZ);

    this.playerMesh.position.set(this.px, 0.9, this.pz);
    this.playerMesh.rotation.z = -this.facing;
    (this.playerMesh.material as THREE.MeshBasicMaterial).color.setHex(
      this.invuln > 0 && Math.floor(this.time * 20) % 2 === 0 ? 0xff3355 : 0xffffff,
    );
    this.playerGlow.position.set(this.px, 0.5, this.pz);
    this.playerRing.position.set(this.px, 0.03, this.pz);
    const ringScale = this.pickupRange / 1.6;
    this.playerRing.scale.set(ringScale, ringScale, 1);
    (this.playerRing.material as THREE.MeshBasicMaterial).opacity =
      0.28 + Math.sin(this.time * 3.4) * 0.08;

    this.syncEnemies();
    this.syncSimple(this.bulletMesh, this.bx, this.bz, this.bCount, 0.5, 1);
    this.syncGems();
    this.syncDebris();
    this.syncBlades();

    const novaW = this.weapons.find((w) => w.id === "nova");
    const nm = this.novaRing.material as THREE.MeshBasicMaterial;
    if (novaW && this.novaTimer > 0) {
      const k = this.novaTimer / 0.42;
      const radius = (7 + novaW.level * 1.9) * (1 - k + 0.15);
      this.novaRing.scale.set(radius, radius, 1);
      this.novaRing.position.set(this.px, 0.4, this.pz);
      nm.opacity = k * 0.9;
    } else {
      nm.opacity = 0;
    }

    // Bloom strength swells with the horde, so the screen literally gets
    // brighter as things get worse — but capped, because past a point the
    // frame stops being readable and the escalation stops registering.
    const g = this.post.grade.uniforms;
    this.post.bloom.strength =
      0.85 + clamp01(this.eCount / 320) * 0.5 + this.levelFlash * 0.8;
    g.time.value = this.time;
    // Aberration and warp track the pressure the player is under, so a bad
    // moment is legible from the edges of the screen alone.
    const pressure = clamp01(this.eCount / 240);
    g.amount.value = 0.0016 + pressure * 0.005 + this.levelFlash * 0.01;
    g.warp.value = pressure * 0.045;
    g.desat.value = this.phase === "dead" ? 0.8 : 0;
    const hurt = clamp01(this.invuln / 0.9);
    (g.flash.value as THREE.Color).setRGB(
      hurt * 0.22 + this.levelFlash * 0.06,
      this.levelFlash * 0.05,
      this.levelFlash * 0.02,
    );
    this.post.composer.render();
    void ctx;
  }

  private syncEnemies() {
    const m = this.enemyMesh;
    m.count = this.eCount;
    const colors = m.instanceColor!;
    for (let i = 0; i < this.eCount; i++) {
      const tier = this.etype[i];
      const s = [1.32, 1.95, 3.1][tier];
      this.dummy.position.set(this.ex[i], 0.62 * s, this.ez[i]);
      this.dummy.rotation.set(this.time * 1.4 + i, this.time * 0.9 + i, 0);
      this.dummy.scale.setScalar(s);
      this.dummy.updateMatrix();
      m.setMatrixAt(i, this.dummy.matrix);

      this.dummy.scale.setScalar(s * 1.16);
      this.dummy.updateMatrix();
      this.enemyOutline.setMatrixAt(i, this.dummy.matrix);

      // Only one channel is allowed past 1. Pushing all three — which the
      // first pass did — makes an enemy a white ball the moment bloom hits
      // it, and a screen of white balls has no shapes in it.
      if (this.ehit[i] > 0) this.tmpColor.setRGB(3.4, 3.2, 3.6);
      else if (tier === 2) this.tmpColor.setRGB(1.85, 0.12, 0.62);
      else if (tier === 1) this.tmpColor.setRGB(1.7, 0.52, 0.06);
      else this.tmpColor.setRGB(0.32, 0.16, 1.7);
      colors.setXYZ(i, this.tmpColor.r, this.tmpColor.g, this.tmpColor.b);
    }
    this.enemyOutline.count = this.eCount;
    this.enemyOutline.instanceMatrix.needsUpdate = true;
    m.instanceMatrix.needsUpdate = true;
    colors.needsUpdate = true;
  }

  private syncSimple(
    mesh: THREE.InstancedMesh,
    xs: Float32Array,
    zs: Float32Array,
    count: number,
    y: number,
    scale: number,
  ) {
    mesh.count = count;
    for (let i = 0; i < count; i++) {
      this.dummy.position.set(xs[i], y, zs[i]);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.setScalar(scale);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(i, this.dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  private syncGems() {
    const m = this.gemMesh;
    m.count = this.gCount;
    for (let i = 0; i < this.gCount; i++) {
      const s = 0.7 + Math.min(this.gval[i], 9) * 0.12;
      this.dummy.position.set(this.gx[i], 0.5 + Math.sin(this.time * 4 + i) * 0.12, this.gz[i]);
      this.dummy.rotation.set(0, this.time * 2.5 + i, 0);
      this.dummy.scale.setScalar(s);
      this.dummy.updateMatrix();
      m.setMatrixAt(i, this.dummy.matrix);
    }
    m.instanceMatrix.needsUpdate = true;
  }

  private syncDebris() {
    const m = this.debrisMesh;
    m.count = this.dCount;
    const colors = m.instanceColor!;
    for (let i = 0; i < this.dCount; i++) {
      this.dummy.position.set(this.dx[i], this.dy[i], this.dz[i]);
      this.dummy.rotation.set(this.time * 9 + i, this.time * 7 + i, 0);
      this.dummy.scale.setScalar(clamp(this.dlife[i] * 1.4, 0.15, 1.2));
      this.dummy.updateMatrix();
      m.setMatrixAt(i, this.dummy.matrix);
      this.tmpColor.setHSL(lerp(0.72, 0.95, this.dhue[i]), 0.85, 0.62);
      colors.setXYZ(i, this.tmpColor.r, this.tmpColor.g, this.tmpColor.b);
    }
    m.instanceMatrix.needsUpdate = true;
    colors.needsUpdate = true;
  }

  private syncBlades() {
    const orbit = this.weapons.find((w) => w.id === "orbit");
    const m = this.bladeMesh;
    if (!orbit) {
      m.count = 0;
      return;
    }
    const n = 2 + orbit.level;
    const r = 4.2 + orbit.level * 0.35;
    m.count = n;
    for (let b = 0; b < n; b++) {
      const a = this.time * 3.1 + (b / n) * Math.PI * 2;
      this.dummy.position.set(
        this.px + Math.cos(a) * r,
        0.7,
        this.pz + Math.sin(a) * r,
      );
      this.dummy.rotation.set(0, -a, 0);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      m.setMatrixAt(b, this.dummy.matrix);
    }
    m.instanceMatrix.needsUpdate = true;
  }

  /**
   * A WebGL canvas cannot also carry a 2D HUD — the context type is fixed
   * for the canvas's lifetime — so the state goes up to the shell, which
   * renders it as HTML over the top. Card hit-testing stays here and uses
   * the same layout constants the shell draws with.
   */
  private publishHud() {
    this.c.report({
      score: this.score,
      status:
        this.phase === "dead" ? "over" : this.phase === "title" ? "idle" : "playing",
      hud: {
        kind: "swarm",
        hp: this.hp,
        maxHp: this.maxHp,
        xp: this.xp,
        xpNeed: this.xpNeed,
        level: this.level,
        kills: this.kills,
        seconds: this.time,
        score: this.score,
        best: this.best,
        phase: this.phase,
        cards:
          this.phase === "levelup"
            ? this.cards.map((c) => ({ title: c.title, body: c.body }))
            : undefined,
      },
    });
  }

  /** Card layout, shared with the shell so clicks land where they look. */
  private layoutCards() {
    this.cardRects = [];
    const n = 3;
    const cw = Math.min(this.w * 0.26, 260);
    const gap = Math.min(this.w * 0.025, 22);
    const total = n * cw + (n - 1) * gap;
    const x0 = (this.w - total) / 2;
    const ch = Math.min(this.h * 0.34, 240);
    const y = this.h * 0.5 - ch / 2;
    for (let i = 0; i < n; i++) {
      this.cardRects.push({ x: x0 + i * (cw + gap), y, w: cw, h: ch });
    }
  }
}

/** Radial glow sprite, generated once. */
function makeGlowTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d")!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.35)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

const factory: GameFactory = (ctx) => new Swarmfall(ctx);
export default factory;
