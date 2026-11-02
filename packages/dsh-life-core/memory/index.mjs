/**
 * Package indexing: vectors and keyword terms.
 *
 * Both are written in the same transaction as nothing else: an indexed package is
 * either fully searchable by every route or not searchable at all.
 */
import { LifeStoreError } from '../store/db.mjs';
import { extractTerms, vectorToBlob } from './encoder.mjs';

/** Writes only the keyword terms. Used when vectors come from a remote encoder. */
export function indexTerms(store, input) {
  if (input === null || typeof input !== 'object') throw new LifeStoreError('invalid_index_input');
  const { packageId, text } = input;
  if (typeof packageId !== 'string' || packageId === '') throw new LifeStoreError('invalid_index_package');
  if (typeof text !== 'string' || text === '') throw new LifeStoreError('invalid_index_text');
  const terms = extractTerms(text);
  return store.atomic((db) => {
    const insertTerm = db.prepare('INSERT OR IGNORE INTO life_package_terms(package_id, term) VALUES(?,?)');
    for (const term of terms) insertTerm.run(packageId, term);
    return { packageId, terms: terms.length };
  });
}

/** Writes one vector that was produced elsewhere (a remote encoder is async). */
export function writeVector(store, input) {
  if (input === null || typeof input !== 'object') throw new LifeStoreError('invalid_vector_input');
  const { packageId, encoderName, vector } = input;
  if (typeof packageId !== 'string' || packageId === '') throw new LifeStoreError('invalid_index_package');
  if (typeof encoderName !== 'string' || encoderName === '') throw new LifeStoreError('missing_encoder_name');
  if (!(vector instanceof Float32Array) || vector.length === 0) throw new LifeStoreError('invalid_vector');
  return store.atomic((db) => {
    db.prepare('INSERT INTO life_package_vectors(package_id, encoder, dim, vector) VALUES(?,?,?,?) ' +
      'ON CONFLICT(package_id, encoder) DO UPDATE SET dim=excluded.dim, vector=excluded.vector')
      .run(packageId, encoderName, vector.length, vectorToBlob(vector));
    return { packageId, dim: vector.length };
  });
}

export function indexPackage(store, input) {
  if (input === null || typeof input !== 'object') throw new LifeStoreError('invalid_index_input');
  const { packageId, text, encoder } = input;
  if (typeof packageId !== 'string' || packageId === '') throw new LifeStoreError('invalid_index_package');
  if (typeof text !== 'string' || text === '') throw new LifeStoreError('invalid_index_text');
  if (encoder === null || typeof encoder !== 'object' || typeof encoder.encode !== 'function') {
    throw new LifeStoreError('missing_encoder');
  }
  const vector = encoder.encode(text);
  if (vector !== null && typeof vector === 'object' && typeof vector.then === 'function') {
 // Remote encoders are async; use writeVector with the awaited result instead,
 // otherwise a pending Promise would be stored as a vector.
    throw new LifeStoreError('async_encoder_requires_write_vector');
  }
  const terms = extractTerms(text);

  return store.atomic((db) => {
    db.prepare('INSERT INTO life_package_vectors(package_id, encoder, dim, vector) VALUES(?,?,?,?) ' +
      'ON CONFLICT(package_id, encoder) DO UPDATE SET dim=excluded.dim, vector=excluded.vector')
      .run(packageId, encoder.name, vector.length, vectorToBlob(vector));
    const insertTerm = db.prepare('INSERT OR IGNORE INTO life_package_terms(package_id, term) VALUES(?,?)');
    for (const term of terms) insertTerm.run(packageId, term);
    return { packageId, dim: vector.length, terms: terms.length };
  });
}

export function readVector(store, packageId, encoderName) {
  return store.db.prepare('SELECT dim, vector FROM life_package_vectors WHERE package_id=? AND encoder=?')
    .get(String(packageId), String(encoderName)) ?? null;
}

export function readTerms(store, packageId) {
  return store.db.prepare('SELECT term FROM life_package_terms WHERE package_id=?').all(String(packageId))
    .map((row) => row.term);
}

export function countIndexed(store, encoderName) {
  return Number(store.db.prepare('SELECT COUNT(*) AS n FROM life_package_vectors WHERE encoder=?').get(String(encoderName)).n);
}
