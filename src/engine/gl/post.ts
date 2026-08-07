/**
 * The post-processing stack these games share.
 *
 * Bloom is doing most of the work visually, and bloom only sees pixels whose
 * colour channels exceed 1. That is the single most important thing to know
 * here: a material coloured `0x88ccff` will never glow no matter how the
 * bloom is tuned. Use `hdr()` for anything meant to be a light source.
 */

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

export interface PostStack {
  composer: EffectComposer;
  bloom: UnrealBloomPass;
  /** Radial RGB split + vignette + scanline. Drive `.uniforms` per frame. */
  grade: ShaderPass;
  setSize(width: number, height: number): void;
  dispose(): void;
}

/**
 * Screen-space grade applied after bloom.
 *
 * - `amount`  radial chromatic aberration, 0 at the centre, max at the edges
 * - `warp`    barrel distortion, sells speed and impact far better than shake
 * - `vignette` darkens the corners
 * - `flash`   full-screen additive tint, for hits and phase changes
 * - `desat`   pulls colour out, for slow-motion and death
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    amount: { value: 0 },
    warp: { value: 0 },
    vignette: { value: 0.85 },
    flash: { value: new THREE.Color(0, 0, 0) },
    desat: { value: 0 },
    time: { value: 0 },
    scan: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float amount;
    uniform float warp;
    uniform float vignette;
    uniform vec3 flash;
    uniform float desat;
    uniform float time;
    uniform float scan;
    varying vec2 vUv;

    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);

      // Barrel warp first so the aberration follows the warped image.
      vec2 uv = 0.5 + c * (1.0 + warp * r2);

      vec2 dir = c * (amount * (0.25 + r2));
      float rr = texture2D(tDiffuse, uv + dir).r;
      vec4 g  = texture2D(tDiffuse, uv);
      float bb = texture2D(tDiffuse, uv - dir).b;
      vec3 col = vec3(rr, g.g, bb);

      col = mix(col, vec3(dot(col, vec3(0.299, 0.587, 0.114))), desat);
      col += flash;

      // Scanlines are keyed to device pixels, not UV, so they do not crawl
      // when the window resizes.
      if (scan > 0.0) {
        float s = sin(vUv.y * 900.0 + time * 6.0) * 0.5 + 0.5;
        col *= 1.0 - scan * s;
      }

      col *= 1.0 - vignette * r2 * r2 * 2.2;

      // Sampling outside the frame after a warp shows garbage; clamp to black.
      float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
      gl_FragColor = vec4(col * inside, g.a);
    }
  `,
};

export function makePost(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  opts: { strength?: number; radius?: number; threshold?: number } = {},
): PostStack {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(1, 1),
    opts.strength ?? 1.1,
    opts.radius ?? 0.6,
    opts.threshold ?? 0.25,
  );
  composer.addPass(bloom);

  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);

  // OutputPass does tone mapping + colour space. It has to be last.
  composer.addPass(new OutputPass());

  return {
    composer,
    bloom,
    grade,
    setSize(width, height) {
      composer.setSize(width, height);
      bloom.setSize(width, height);
    },
    dispose() {
      composer.dispose();
    },
  };
}

/**
 * A colour scaled past 1 so bloom picks it up.
 *
 * `hdr(0x66ddff, 3)` is the same hue as the hex but three times as bright,
 * which reads as "this thing is emitting light" rather than "this thing is
 * painted light blue".
 */
export function hdr(hex: number, gain = 2.5, out = new THREE.Color()) {
  return out.setHex(hex, THREE.SRGBColorSpace).multiplyScalar(gain);
}

/**
 * A soft radial sprite texture, built in code so nothing has to be fetched.
 * Use it for glows, muzzle flashes, impact flares and light shafts.
 */
export function glowTexture(size = 128, falloff = 2.2): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  const img = g.createImageData(size, size);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - half + 0.5) / half;
      const dy = (y - half + 0.5) / half;
      const d = Math.sqrt(dx * dx + dy * dy);
      const a = Math.max(0, 1 - d);
      const v = Math.pow(a, falloff) * 255;
      const i = (y * size + x) * 4;
      img.data[i] = 255;
      img.data[i + 1] = 255;
      img.data[i + 2] = 255;
      img.data[i + 3] = v;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A hard-edged ring texture — shockwaves, targeting reticles, portals. */
export function ringTexture(size = 256, thickness = 0.08): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  const img = g.createImageData(size, size);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - half + 0.5) / half;
      const dy = (y - half + 0.5) / half;
      const d = Math.sqrt(dx * dx + dy * dy);
      const edge = Math.max(0, 1 - Math.abs(d - (1 - thickness)) / thickness);
      const i = (y * size + x) * 4;
      img.data[i] = 255;
      img.data[i + 1] = 255;
      img.data[i + 2] = 255;
      img.data[i + 3] = Math.pow(edge, 1.6) * 255 * (d <= 1 ? 1 : 0);
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
