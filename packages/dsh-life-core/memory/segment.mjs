/**
 * Turns a cue into the text of the memory segment.
 *
 * The loop end to end: cue -> three-route recall -> five-factor scoring -> sampling ->
 * ordered parts that the frame assembler fills into the memory budget.
 *
 * Nothing here decides the budget: assembleFrame owns that and reports what it dropped,
 * so the two pieces cannot disagree about how much fits.
 */
import { recallPackages } from './recall.mjs';
import { selectMemories } from './score.mjs';
import { readAllActivations } from './activation.mjs';

/**
 * @param {object} input store, cue, encoder/cueVector + encoderName, weights, sampling, now, openLoops
 * @returns {{parts:Array, selected:Array, recall:object, scored:Array}}
 */
export function buildMemoryParts(input) {
  if (input === null || typeof input !== 'object') throw new TypeError('invalid_input');
  const recall = recallPackages(input);
  if (recall.candidates.length === 0) return { parts: [], selected: [], recall, scored: [] };

  const activations = input.activations instanceof Map ? input.activations : readAllActivations(input.store);
  const links = new Map();
  for (const candidate of recall.candidates) {
    const record = input.store.db.prepare('SELECT links_json FROM life_packages WHERE id=?').get(candidate.packageId);
    if (record !== undefined) links.set(candidate.packageId, JSON.parse(record.links_json));
  }

  const result = selectMemories({
    candidates: recall.candidates.map((candidate) => ({
      ...candidate,
      importance: candidate.importance ?? input.store.db.prepare('SELECT importance FROM life_packages WHERE id=?')
        .get(candidate.packageId)?.importance ?? 3,
    })),
    weights: input.weights,
    sampling: input.sampling,
    now: input.now,
    activations,
    links,
    openLoops: input.openLoops,
    recentPackageIds: input.recentPackageIds,
    seed: input.seed,
  });

  return {
    parts: result.selected.map((entry) => ({ id: entry.packageId, text: entry.text })),
    selected: result.selected,
    recall,
    scored: result.scored,
  };
}
