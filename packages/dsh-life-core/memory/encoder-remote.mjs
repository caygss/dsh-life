/**
 * Remote embedding encoder (OpenAI-compatible /v1/embeddings).
 *
 * Reference deployment: a self-hosted Qwen3-Embedding-8B behind an
 * OpenAI-compatible endpoint, 4096 dimensions (the model supports MRL, so the
 * width is a deployment choice - whatever you pick has to stay fixed per table).
 * Any model that speaks the same contract works: keep `name` distinct per model,
 * because the table that stores the vectors is keyed by it.
 *
 * This is the real semantic route: unlike the local hash encoder, it can match a
 * paraphrase ("搬家" -> "换房子"). It costs a network call, so recall
 * splits in two: index time embeds a batch of packages, query time embeds one cue
 * and then runs the pure-SQL recall over stored vectors.
 *
 * The key is passed in by the caller and never logged, echoed or persisted here.
 */
/** Loopback default: the reference deployment serves the model on its own host. */
export const DEFAULT_EMBEDDING_ENDPOINT = 'http://127.0.0.1:8080/v1/embeddings';

export class LifeEncoderError extends Error {
  constructor(code, detail) {
    super(code + (detail === undefined ? '' : ': ' + detail));
    this.name = 'LifeEncoderError';
    this.code = code;
  }
}

/**
 * @param {object} options model, apiKey, endpoint?, fetchImpl?, timeoutMs?
 */
export function createRemoteEncoder(options) {
  if (options === null || typeof options !== 'object') throw new LifeEncoderError('invalid_options');
  const {
    model,
    endpoint = DEFAULT_EMBEDDING_ENDPOINT,
    fetchImpl = globalThis.fetch,
    timeoutMs = 60_000,
  } = options;
  if (typeof model !== 'string' || model === '') throw new LifeEncoderError('missing_model');
  if (typeof options.apiKey !== 'string' || options.apiKey === '') throw new LifeEncoderError('missing_api_key');
  if (typeof fetchImpl !== 'function') throw new LifeEncoderError('missing_fetch');
  const apiKey = options.apiKey;
  let dim = null;

  async function encodeMany(texts) {
    if (!Array.isArray(texts) || texts.length === 0) throw new LifeEncoderError('invalid_texts');
    for (const text of texts) {
      if (typeof text !== 'string' || text === '') throw new LifeEncoderError('invalid_text');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({ model, input: texts, encoding_format: 'float' }),
      });
    } catch {
      throw new LifeEncoderError(controller.signal.aborted ? 'encoder_timeout' : 'encoder_transport_failed');
    } finally {
      clearTimeout(timer);
    }
    if (!response || typeof response.json !== 'function') throw new LifeEncoderError('encoder_invalid_response');
    if (response.ok !== true) throw new LifeEncoderError('encoder_http_error', String(response.status));
    let body;
    try { body = await response.json(); } catch { throw new LifeEncoderError('encoder_invalid_json'); }
    const data = body?.data;
    if (!Array.isArray(data) || data.length !== texts.length) throw new LifeEncoderError('encoder_incomplete_output');
    const vectors = data
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((entry) => {
        const values = entry?.embedding;
        if (!Array.isArray(values) || values.length === 0) throw new LifeEncoderError('encoder_invalid_vector');
        const vector = Float32Array.from(values);
        let norm = 0;
        for (const value of vector) norm += value * value;
        norm = Math.sqrt(norm);
        if (norm > 0) for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
        return vector;
      });
    dim = vectors[0].length;
    return vectors.map((vector) => {
      if (vector.length !== dim) throw new LifeEncoderError('encoder_dim_mismatch');
      return vector;
    });
  }

 // 名字是向量表的键：换名字等于换一套向量，所以允许宿主指定（自部署服务别沿用别的服务的名字）。
  const encoderName = typeof options.name === 'string' && options.name !== ''
    ? options.name
    : 'emb-' + model.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();

  return {
    name: encoderName,
    get dim() { return dim; },
    encodeMany,
    async encode(text) {
      const [vector] = await encodeMany([text]);
      return vector;
    },
  };
}
