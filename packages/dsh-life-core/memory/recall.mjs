/**
 * Three-route recall.
 *
 * The design: the retrieval pool is every compressed package, and the
 * routes are semantic (vector), time (when it happened) and keyword (shared
 * wording). Missing a route makes old memories hard to find, so all three run and
 * their rankings are fused.
 *
 * Fusion uses reciprocal rank fusion rather than a weighted sum of raw scores:
 * the three routes produce numbers on incomparable scales, and RRF only needs the
 * order. Per-route ranks and scores are kept on every candidate so the five-factor
 * scoring step can use them instead of re-deriving them.
 *
 * This function does not decide what enters the context; it returns candidates.
 */

import { extractTerms, blobToVector } from './encoder.mjs';

/**
 * Min-max normalisation inside one route. A route whose candidates all score the
 * same carries no discrimination and contributes nothing, rather than a free point
 * for everybody.
 */
function minMaxNormalise(route) {
  const out = new Map();
  if (route.length === 0) return out;
  if (route.length === 1) { out.set(route[0].packageId, 1); return out; }
  const scores = route.map((entry) => entry.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (max === min) return out;
  for (const entry of route) out.set(entry.packageId, (entry.score - min) / (max - min));
  return out;
}

/**
 * Fusion is a weighted sum of per-route scores, each min-max normalised inside the
 * candidate set.
 *
 * Two failures led here:
 * 1. Reciprocal rank fusion let a package that only appeared on the noisy keyword
 * route outrank the clear semantic winner, because with k=60 any second route
 * is worth far more than a first place on one route.
 * 2. Equal weights finished the job. The semantic route is the reliable one; the
 * other two are supporting signals, so they are weighted, not equal.
 */
export const ROUTE_WEIGHTS = Object.freeze({ semantic: 0.7, keyword: 0.15, time: 0.15 });

export const RECALL_MODES = Object.freeze(['semantic', 'fused']);

/**
 * Retrieval mode.
 *
 * 'semantic' (the default) ranks by cosine alone. On an internal query set the three-route
 * fusion and addressable fields scored only slightly better than pure vector, so the gain
 * was judged not worth the extra machinery for now; the extra routes stay implemented and
 * dormant.
 *
 * 'fused' keeps the keyword and time routes with ROUTE_WEIGHTS. Re-enable it when a
 * behaviour actually needs it (e.g. "which visit was this", "what happened that day"),
 * not on a hunch.
 */
export const DEFAULT_RECALL = Object.freeze({
  perRoute: 20,
  limit: 20,
  timeHalfLifeDays: 30,
  mode: 'semantic',
});

export class LifeRecallError extends Error {
  constructor(code, detail) {
    super(code + (detail === undefined ? '' : ': ' + detail));
    this.name = 'LifeRecallError';
    this.code = code;
  }
}

function requireCue(cue) {
  if (cue === null || typeof cue !== 'object') throw new LifeRecallError('invalid_cue');
  if (typeof cue.text !== 'string') throw new LifeRecallError('invalid_cue_text');
  return cue;
}

function activePackages(store) {
  return store.db.prepare("SELECT id, created_at, start_seq, end_seq, text FROM life_packages WHERE status='active' ORDER BY start_seq").all();
}

/** Semantic route: cosine against every stored vector of this encoder. */
function semanticRoute(store, cueVector, encoderName, perRoute) {
  const rows = store.db.prepare('SELECT package_id, dim, vector FROM life_package_vectors WHERE encoder=?').all(encoderName);
  const scored = [];
  for (const row of rows) {
    const vector = blobToVector(row.vector, Number(row.dim));
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < vector.length; i += 1) {
      dot += cueVector[i] * vector[i];
      na += cueVector[i] * cueVector[i];
      nb += vector[i] * vector[i];
    }
    const score = na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
    if (score > 0) scored.push({ packageId: row.package_id, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.packageId < b.packageId ? -1 : 1));
  return scored.slice(0, perRoute);
}

/**
 * Keyword route: how much of the query's *informative* wording a package shares.
 *
 * Terms are weighted by inverse document frequency, so a bi-gram that every package
 * contains ("时候", "什么") contributes almost nothing while a distinctive one
 * ("出差", "路灯") counts fully. Without this the route matched everything equally
 * and drowned the semantic winner during fusion.
 */
function keywordRoute(store, cueTerms, perRoute) {
  if (cueTerms.length === 0) return [];
  const wanted = new Set(cueTerms);
  const rows = store.db.prepare('SELECT package_id, term FROM life_package_terms').all();
  const totalPackages = Number(store.db.prepare("SELECT COUNT(*) AS n FROM life_packages WHERE status='active'").get().n);
  if (totalPackages === 0) return [];

  const documentFrequency = new Map();
  const hitsByPackage = new Map();
  for (const row of rows) {
    if (!wanted.has(row.term)) continue;
    documentFrequency.set(row.term, (documentFrequency.get(row.term) ?? 0) + 1);
    if (!hitsByPackage.has(row.package_id)) hitsByPackage.set(row.package_id, []);
    hitsByPackage.get(row.package_id).push(row.term);
  }
  const idf = (term) => Math.log((totalPackages + 1) / ((documentFrequency.get(term) ?? 0) + 1));
  let totalWeight = 0;
  for (const term of wanted) totalWeight += idf(term);
  if (totalWeight <= 0) return [];

  const scored = [];
  for (const [packageId, matched] of hitsByPackage) {
    let weight = 0;
    for (const term of new Set(matched)) weight += idf(term);
    const score = weight / totalWeight;
 // A term present in every package says nothing about this one.
    if (score > 0) scored.push({ packageId, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.packageId < b.packageId ? -1 : 1));
  return scored.slice(0, perRoute);
}

/** Time route: proximity to the cue's point in time. Undated cues stay neutral. */
function timeRoute(packages, cueTimeMs, perRoute, halfLifeDays) {
  if (!Number.isFinite(cueTimeMs)) return [];
  const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000;
  const scored = [];
  for (const row of packages) {
    const at = Date.parse(row.created_at);
    if (!Number.isFinite(at)) continue;
    const score = Math.exp(-Math.abs(cueTimeMs - at) / halfLifeMs);
    scored.push({ packageId: row.id, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.packageId < b.packageId ? -1 : 1));
  return scored.slice(0, perRoute);
}

/**
 * @param {object} input store, cue {text, at?}, encoder, options
 * @returns {{candidates:Array, routes:object, stats:object}}
 */
export function recallPackages(input) {
  if (input === null || typeof input !== 'object') throw new LifeRecallError('invalid_input');
  const { store, encoder } = input;
  if (store === null || typeof store !== 'object') throw new LifeRecallError('missing_store');
  const cue = requireCue(input.cue);
 // A synchronous encoder can embed the cue inline; a remote one is embedded by the
 // caller and handed in as cueVector, so this module stays network-free.
  const encoderName = input.encoderName
    ?? (input.encoder !== null && typeof input.encoder === 'object' ? input.encoder.name : null);
  if (typeof encoderName !== 'string' || encoderName === '') throw new LifeRecallError('missing_encoder');
  const hasSyncEncoder = input.encoder !== null && typeof input.encoder === 'object' && typeof input.encoder.encode === 'function';
  if (input.cueVector === undefined && !hasSyncEncoder) throw new LifeRecallError('missing_cue_vector');
  const options = { ...DEFAULT_RECALL, ...(input.options ?? {}) };
  if (!RECALL_MODES.includes(options.mode)) throw new LifeRecallError('invalid_recall_mode', String(options.mode));
  if (!Number.isInteger(options.perRoute) || options.perRoute <= 0) throw new LifeRecallError('invalid_per_route');
  if (!Number.isInteger(options.limit) || options.limit <= 0) throw new LifeRecallError('invalid_limit');
  if (!(options.timeHalfLifeDays > 0)) throw new LifeRecallError('invalid_time_half_life');

  const packages = activePackages(store);
  if (packages.length === 0) {
    return { candidates: [], routes: { semantic: [], keyword: [], time: [] }, stats: { pool: 0 } };
  }

  const cueVector = input.cueVector ?? input.encoder.encode(cue.text);

 // Pure vector mode: one route, cosine order, nothing else touched. The keyword table
 // is still written at index time, it is simply not consulted here.
  if (options.mode === 'semantic') {
    const byId = new Map(packages.map((row) => [row.id, row]));
    const semanticOnly = semanticRoute(store, cueVector, encoderName, options.perRoute);
    const candidates = semanticOnly
      .filter((entry) => byId.has(entry.packageId))
      .slice(0, options.limit)
      .map((entry) => {
        const row = byId.get(entry.packageId);
        return {
          packageId: entry.packageId,
          total: Number(entry.score.toFixed(6)),
          rank: { semantic: semanticOnly.indexOf(entry) + 1 },
          score: { semantic: Number(entry.score.toFixed(6)) },
          routes: ['semantic'],
          startSeq: Number(row.start_seq),
          endSeq: Number(row.end_seq),
          createdAt: row.created_at,
          text: row.text,
        };
      });
    return {
      candidates,
      routes: { semantic: semanticOnly, keyword: [], time: [] },
      stats: {
        mode: 'semantic',
        pool: packages.length,
        indexed: semanticOnly.length,
        cueTerms: 0,
        semanticCandidates: semanticOnly.length,
        keywordCandidates: 0,
        timeCandidates: 0,
        merged: semanticOnly.length,
      },
    };
  }

  const terms = Array.isArray(input.terms) && input.terms.length > 0
    ? [...new Set(input.terms.map(String))]
    : [...new Set(extractTerms(cue.text))];

  const semantic = semanticRoute(store, cueVector, encoderName, options.perRoute);
  const keyword = keywordRoute(store, terms, options.perRoute);
  const time = timeRoute(packages, cue.at === undefined ? NaN : Date.parse(cue.at), options.perRoute, options.timeHalfLifeDays);

  const merged = new Map();
  const touch = (packageId) => {
    if (!merged.has(packageId)) merged.set(packageId, { packageId, total: 0, rank: {}, score: {}, routes: [] });
    return merged.get(packageId);
  };
  for (const [routeName, route] of [['semantic', semantic], ['keyword', keyword], ['time', time]]) {
    const routeWeight = ROUTE_WEIGHTS[routeName];
    const normalised = minMaxNormalise(route);
    route.forEach((entry, index) => {
      const candidate = touch(entry.packageId);
      candidate.total += routeWeight * (normalised.get(entry.packageId) ?? 0);
      candidate.rank[routeName] = index + 1;
      candidate.score[routeName] = Number(entry.score.toFixed(6));
      candidate.routes.push(routeName);
    });
  }

  const byId = new Map(packages.map((row) => [row.id, row]));
  const candidates = [...merged.values()]
    .filter((candidate) => byId.has(candidate.packageId))
    .sort((a, b) => b.total - a.total || (a.packageId < b.packageId ? -1 : 1))
    .slice(0, options.limit)
    .map((candidate) => {
      const row = byId.get(candidate.packageId);
      return {
        packageId: candidate.packageId,
        total: Number(candidate.total.toFixed(6)),
        rank: candidate.rank,
        score: candidate.score,
        routes: candidate.routes,
        startSeq: Number(row.start_seq),
        endSeq: Number(row.end_seq),
        createdAt: row.created_at,
        text: row.text,
      };
    });

  return {
    candidates,
    routes: { semantic, keyword, time },
    stats: {
      mode: 'fused',
      pool: packages.length,
      indexed: semantic.length,
      cueTerms: terms.length,
      semanticCandidates: semantic.length,
      keywordCandidates: keyword.length,
      timeCandidates: time.length,
      merged: merged.size,
    },
  };
}

