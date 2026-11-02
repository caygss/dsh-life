/**
 * Encoders for the semantic route.
 *
 * There is no local tokenizer or embedding model in this project, and no paid
 * embedding call has been authorised for. So this ships a deterministic,
 * dependency-free "hashing" encoder: Chinese bi-grams plus ASCII words are hashed
 * into a fixed number of signed buckets and L2-normalised. Cosine similarity on it
 * reflects shared wording, which is enough to exercise and test the pipeline.
 *
 * It is NOT a semantic model. It will not match "搬家" to "换房子". The real
 * embedding port is declared here as an interface so a provider can be plugged in
 * later without touching recall code; quality is explicitly not claimed.
 */

export const HASH_ENCODER_NAME = 'hash-bigram-v1';
export const HASH_ENCODER_DIM = 64;

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/;
const ASCII_WORD = /[A-Za-z0-9]{2,}/g;

/** Chinese bi-grams plus ASCII words. Punctuation and whitespace are dropped. */
export function extractTerms(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  const terms = new Set();
  const chars = [];
  for (const ch of text) {
    if (CJK.test(ch)) chars.push(ch);
    else {
      if (chars.length >= 2) for (let i = 0; i + 1 < chars.length; i += 1) terms.add(chars[i] + chars[i + 1]);
      if (chars.length === 1) terms.add(chars[0]);
      chars.length = 0;
    }
  }
  if (chars.length >= 2) for (let i = 0; i + 1 < chars.length; i += 1) terms.add(chars[i] + chars[i + 1]);
  else if (chars.length === 1) terms.add(chars[0]);
  for (const match of text.matchAll(ASCII_WORD)) terms.add(match[0].toLowerCase());
  return [...terms];
}

/** Stable 32-bit hash so the same text always lands in the same buckets. */
function hash32(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * @param {object} [options] dim
 * @returns {{name:string, dim:number, encode:(text:string)=>Float32Array}}
 */
export function createHashEncoder(options = {}) {
  const dim = Number.isInteger(options.dim) && options.dim > 0 ? options.dim : HASH_ENCODER_DIM;
  return {
    name: HASH_ENCODER_NAME,
    dim,
    encode(text) {
      if (typeof text !== 'string') throw new TypeError('text must be a string');
      const vector = new Float32Array(dim);
      for (const term of extractTerms(text)) {
        const h = hash32(term);
        const bucket = h % dim;
        const sign = ((h >>> 31) & 1) === 0 ? 1 : -1;
        vector[bucket] += sign;
      }
      let norm = 0;
      for (let i = 0; i < dim; i += 1) norm += vector[i] * vector[i];
      norm = Math.sqrt(norm);
      if (norm > 0) for (let i = 0; i < dim; i += 1) vector[i] /= norm;
      return vector;
    },
  };
}

/** Bytes in, same bytes out. Vectors are stored as raw little-endian float32. */
export function vectorToBlob(vector) {
  const buffer = Buffer.alloc(vector.length * 4);
  for (let i = 0; i < vector.length; i += 1) buffer.writeFloatLE(vector[i], i * 4);
  return buffer;
}

export function blobToVector(blob, dim) {
  if (!(blob instanceof Uint8Array)) throw new TypeError('blob must be a Uint8Array');
  if (blob.byteLength !== dim * 4) throw new TypeError('vector length mismatch: ' + blob.byteLength + ' != ' + dim * 4);
 // sqlite returns a plain Uint8Array, which has no readFloatLE; wrap the same bytes.
  const buffer = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const vector = new Float32Array(dim);
  for (let i = 0; i < dim; i += 1) vector[i] = buffer.readFloatLE(i * 4);
  return vector;
}

/** Cosine similarity. Zero vectors score 0 rather than NaN. */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) throw new TypeError('vector length mismatch');
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
