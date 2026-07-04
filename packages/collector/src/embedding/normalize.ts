import { FIXED_DIM } from "./embedding-provider";

/** 決定的 PRNG（mulberry32）。射影行列を再現可能にするため seed 固定で使う。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const projectionCache = new Map<string, Float32Array>();

/** nativeDim×FIXED_DIM のガウス射影行列（seed=nativeDim で固定）。 */
function projectionMatrix(nativeDim: number): Float32Array {
  const key = String(nativeDim);
  const cached = projectionCache.get(key);
  if (cached) return cached;

  const rand = mulberry32(nativeDim * 2654435761);
  const m = new Float32Array(nativeDim * FIXED_DIM);
  const scale = 1 / Math.sqrt(FIXED_DIM);
  for (let i = 0; i < m.length; i++) {
    // Box-Muller で近似ガウス
    const u = Math.max(rand(), 1e-9);
    const v = rand();
    m[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * scale;
  }
  projectionCache.set(key, m);
  return m;
}

function l2normalize(vec: Float32Array): Float32Array {
  let sum = 0;
  for (const x of vec) sum += x * x;
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = (vec[i] ?? 0) / norm;
  return out;
}

/**
 * どのプロバイダ次元でも DB の vector(1536) に合わせて正規化する。
 * ==1536: そのまま / >1536: 先頭 1536 に truncation + 再正規化 /
 * <1536: 固定 seed のランダム射影で 1536 に写像。
 */
export function normalizeTo1536(
  vec: Float32Array,
  nativeDim: number,
): Float32Array {
  if (nativeDim === FIXED_DIM) return vec;

  if (nativeDim > FIXED_DIM) {
    return l2normalize(vec.slice(0, FIXED_DIM));
  }

  // nativeDim < FIXED_DIM: 射影
  const m = projectionMatrix(nativeDim);
  const out = new Float32Array(FIXED_DIM);
  for (let j = 0; j < FIXED_DIM; j++) {
    let acc = 0;
    for (let i = 0; i < nativeDim; i++) {
      acc += (vec[i] ?? 0) * (m[i * FIXED_DIM + j] ?? 0);
    }
    out[j] = acc;
  }
  return l2normalize(out);
}
