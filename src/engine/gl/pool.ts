/**
 * Instanced draw pools.
 *
 * Both classes here exist so a game can put thousands of moving, glowing
 * things on screen without allocating in the hot loop and without paying a
 * draw call each. Everything is structure-of-arrays backed by typed arrays,
 * and removal is a swap with the last live element.
 */

import * as THREE from "three";
import { glowTexture } from "./post";

// --- instanced meshes -------------------------------------------------------

/**
 * A fixed-capacity InstancedMesh with a live count and per-instance colour.
 *
 * The one trap worth spelling out: per-instance colour goes through
 * `instanceColor`, which is what `setColorAt` writes. Setting
 * `vertexColors: true` on the material switches the shader to a per-VERTEX
 * colour attribute that the geometry does not have, and every instance
 * renders black. Never set that flag on an instanced mesh.
 */
export class InstancePool {
  readonly mesh: THREE.InstancedMesh;
  count = 0;

  private readonly max: number;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly e = new THREE.Euler();

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    max: number,
  ) {
    this.max = max;
    this.mesh = new THREE.InstancedMesh(geometry, material, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    // Allocate the colour buffer up front so setColorAt never has to.
    const colors = new Float32Array(max * 3).fill(1);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  }

  /** Call once at the top of the frame, then `write()` for each live thing. */
  begin() {
    this.count = 0;
  }

  /** Position + uniform-or-vector scale + optional rotation and colour. */
  write(
    x: number,
    y: number,
    z: number,
    scale: number | { x: number; y: number; z: number },
    color?: THREE.Color,
    rot?: { x: number; y: number; z: number },
  ) {
    if (this.count >= this.max) return;
    const i = this.count++;
    this.p.set(x, y, z);
    if (typeof scale === "number") this.s.set(scale, scale, scale);
    else this.s.set(scale.x, scale.y, scale.z);
    if (rot) {
      this.e.set(rot.x, rot.y, rot.z);
      this.q.setFromEuler(this.e);
    } else {
      this.q.set(0, 0, 0, 1);
    }
    this.m.compose(this.p, this.q, this.s);
    this.mesh.setMatrixAt(i, this.m);
    if (color) this.mesh.setColorAt(i, color);
  }

  /** Uploads whatever was written and sets the visible instance count. */
  end() {
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}

// --- particles --------------------------------------------------------------

export interface ParticleSpec {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  /** Seconds. */
  life?: number;
  size?: number;
  /** Size at death; defaults to 0 so particles shrink out. */
  endSize?: number;
  color?: THREE.Color;
  /** Colour at death. Defaults to `color`. */
  endColor?: THREE.Color;
  gravity?: number;
  /** Fraction of velocity kept per second, e.g. 0.2 is heavy air. */
  drag?: number;
}

const PARTICLE_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  varying vec3 vColor;
  varying float vAlpha;
  uniform float uScale;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // Perspective-correct point size: things get smaller with distance.
    gl_PointSize = aSize * uScale / max(0.0001, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const PARTICLE_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 t = texture2D(uMap, gl_PointCoord);
    gl_FragColor = vec4(vColor, 1.0) * t.a * vAlpha;
  }
`;

/**
 * An additive point-sprite system. One draw call for the whole pool.
 *
 * Sizes are in world units at one unit from the camera — `uScale` converts
 * that to pixels using the viewport height, so a particle keeps its physical
 * size when the window resizes.
 */
export class Particles {
  readonly object: THREE.Points;

  private readonly max: number;
  private live = 0;

  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly col: Float32Array;
  private readonly colA: Float32Array;
  private readonly colB: Float32Array;
  private readonly size: Float32Array;
  private readonly sizeA: Float32Array;
  private readonly sizeB: Float32Array;
  private readonly alpha: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly grav: Float32Array;
  private readonly drag: Float32Array;

  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.ShaderMaterial;

  constructor(max = 4000, map?: THREE.Texture) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.colA = new Float32Array(max * 3);
    this.colB = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.sizeA = new Float32Array(max);
    this.sizeB = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute("aColor", new THREE.BufferAttribute(this.col, 3));
    this.geo.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1));
    this.geo.setAttribute("aAlpha", new THREE.BufferAttribute(this.alpha, 1));
    this.geo.setDrawRange(0, 0);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: map ?? glowTexture(64, 2.4) },
        uScale: { value: 500 },
      },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.object = new THREE.Points(this.geo, this.mat);
    this.object.frustumCulled = false;
  }

  get count() {
    return this.live;
  }

  /** Feed the viewport height in device pixels so sizes stay physical. */
  setViewport(heightPx: number) {
    this.mat.uniforms.uScale.value = heightPx * 0.5;
  }

  spawn(spec: ParticleSpec) {
    if (this.live >= this.max) return;
    const i = this.live++;
    const i3 = i * 3;
    this.pos[i3] = spec.x;
    this.pos[i3 + 1] = spec.y;
    this.pos[i3 + 2] = spec.z;
    this.vel[i3] = spec.vx ?? 0;
    this.vel[i3 + 1] = spec.vy ?? 0;
    this.vel[i3 + 2] = spec.vz ?? 0;

    const c = spec.color;
    const e = spec.endColor ?? spec.color;
    this.colA[i3] = c ? c.r : 1;
    this.colA[i3 + 1] = c ? c.g : 1;
    this.colA[i3 + 2] = c ? c.b : 1;
    this.colB[i3] = e ? e.r : 1;
    this.colB[i3 + 1] = e ? e.g : 1;
    this.colB[i3 + 2] = e ? e.b : 1;

    this.sizeA[i] = spec.size ?? 1;
    this.sizeB[i] = spec.endSize ?? 0;
    const l = spec.life ?? 0.7;
    this.life[i] = l;
    this.maxLife[i] = l;
    this.grav[i] = spec.gravity ?? 0;
    this.drag[i] = spec.drag ?? 1;
    this.alpha[i] = 1;
  }

  /** Convenience: an outward burst from a point. */
  burst(
    n: number,
    x: number,
    y: number,
    z: number,
    speed: number,
    spec: Omit<ParticleSpec, "x" | "y" | "z" | "vx" | "vy" | "vz"> = {},
  ) {
    for (let i = 0; i < n; i++) {
      // Uniform direction on the sphere.
      const u = Math.random() * 2 - 1;
      const t = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const m = speed * (0.35 + Math.random() * 0.65);
      this.spawn({
        ...spec,
        x,
        y,
        z,
        vx: Math.cos(t) * r * m,
        vy: u * m,
        vz: Math.sin(t) * r * m,
        life: (spec.life ?? 0.7) * (0.7 + Math.random() * 0.6),
      });
    }
  }

  update(dt: number) {
    let i = 0;
    while (i < this.live) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.swapRemove(i);
        continue;
      }
      const i3 = i * 3;
      const d = Math.pow(this.drag[i], dt);
      this.vel[i3] *= d;
      this.vel[i3 + 1] = this.vel[i3 + 1] * d + this.grav[i] * dt;
      this.vel[i3 + 2] *= d;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;

      // t goes 0 -> 1 across the particle's life.
      const t = 1 - this.life[i] / this.maxLife[i];
      this.size[i] = this.sizeA[i] + (this.sizeB[i] - this.sizeA[i]) * t;
      this.col[i3] = this.colA[i3] + (this.colB[i3] - this.colA[i3]) * t;
      this.col[i3 + 1] =
        this.colA[i3 + 1] + (this.colB[i3 + 1] - this.colA[i3 + 1]) * t;
      this.col[i3 + 2] =
        this.colA[i3 + 2] + (this.colB[i3 + 2] - this.colA[i3 + 2]) * t;
      // Hold full brightness then fade late — a linear fade reads as mush.
      this.alpha[i] = t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45;
      i++;
    }

    this.geo.setDrawRange(0, this.live);
    if (this.live > 0) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.aColor.needsUpdate = true;
      this.geo.attributes.aSize.needsUpdate = true;
      this.geo.attributes.aAlpha.needsUpdate = true;
    }
  }

  clear() {
    this.live = 0;
    this.geo.setDrawRange(0, 0);
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }

  private swapRemove(i: number) {
    const last = --this.live;
    if (i === last) return;
    const a = i * 3;
    const b = last * 3;
    for (let k = 0; k < 3; k++) {
      this.pos[a + k] = this.pos[b + k];
      this.vel[a + k] = this.vel[b + k];
      this.col[a + k] = this.col[b + k];
      this.colA[a + k] = this.colA[b + k];
      this.colB[a + k] = this.colB[b + k];
    }
    this.size[i] = this.size[last];
    this.sizeA[i] = this.sizeA[last];
    this.sizeB[i] = this.sizeB[last];
    this.alpha[i] = this.alpha[last];
    this.life[i] = this.life[last];
    this.maxLife[i] = this.maxLife[last];
    this.grav[i] = this.grav[last];
    this.drag[i] = this.drag[last];
  }
}
