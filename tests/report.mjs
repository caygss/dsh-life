/**
 * 离线测试报告脚本（零依赖、零网络、零密钥）。
 *
 * 只测本仓库自己的代码：记忆召回（本地 hash 编码器，含维度扫描）、五因子打分标定、
 * 抽样确定性、usage 投影与缓存命中、token 估算比例。不调用任何模型或 embedding 服务；
 * 语料与夹具数字都由本文件生成。
 *
 *   node tests/report.mjs
 *
 * 数据库建在系统临时目录，跑完即删。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../packages/dsh-life-core/store/db.mjs';
import { writePackage } from '../packages/dsh-life-core/memory/packages.mjs';
import { indexPackage } from '../packages/dsh-life-core/memory/index.mjs';
import { recallPackages } from '../packages/dsh-life-core/memory/recall.mjs';
import { writeVector, indexTerms } from '../packages/dsh-life-core/memory/index.mjs';
import { createRemoteEncoder, DEFAULT_EMBEDDING_ENDPOINT } from '../packages/dsh-life-core/memory/encoder-remote.mjs';
import { createHashEncoder, extractTerms } from '../packages/dsh-life-core/memory/encoder.mjs';
import { fiveFactorScore, selectMemories, sampleCandidates, DEFAULT_WEIGHTS, DEFAULT_SAMPLING } from '../packages/dsh-life-core/memory/score.mjs';
import { projectProviderUsage } from '../packages/dsh-life-core/model/request-metrics.mjs';
import { estimateTokens } from '../packages/dsh-life-core/tokens.mjs';

const CORPUS = [
  ['m01', '路灯坏了，物业说下周二来修。'],
  ['m02', '楼下新开了一家面包店，晚上八点后打折。'],
  ['m03', '把阳台那盆薄荷挪到窗边，晒到太阳了。'],
  ['m04', '搬家那天纸箱堆到门口，电梯还坏了。'],
  ['m05', '体检报告出来，医生说少喝咖啡。'],
  ['m06', '隔壁小孩在练钢琴，一直弹同一段。'],
  ['m07', '旧自行车链条掉了，自己装回去。'],
  ['m08', '快递柜超时，取件码过期。'],
  ['m09', '洗衣机排水管漏水，用胶带缠了几圈。'],
  ['m10', '图书馆闭馆，只好把书带回家。'],
  ['m11', '夜里下暴雨，窗户没关，地板湿了一片。'],
  ['m12', '买了新的保温杯，倒进去的水到中午还热。'],
  ['m13', '公交车改线，绕到菜市场那边。'],
  ['m14', '冰箱里那盒草莓忘了吃，长毛了。'],
];

// [问题, 期望命中的包 id]；前 14 条刻意复用原话词，后 14 条刻意换说法
const QUERIES = [
  ['路灯什么时候能修好', 'm01'],
  ['面包店晚上几点打折', 'm02'],
  ['那盆薄荷该放哪儿', 'm03'],
  ['搬家那天电梯怎么了', 'm04'],
  ['体检报告要少喝什么', 'm05'],
  ['钢琴为什么一直弹同一段', 'm06'],
  ['自行车链条掉了怎么办', 'm07'],
  ['快递柜超时了怎么办', 'm08'],
  ['洗衣机排水管漏水', 'm09'],
  ['图书馆闭馆了', 'm10'],
  ['暴雨地板湿了', 'm11'],
  ['保温杯到中午还热', 'm12'],
  ['公交车改线绕到哪', 'm13'],
  ['草莓忘了吃长毛了', 'm14'],
  ['街灯熄了找谁', 'm01'],
  ['糕点头子什么时候便宜', 'm02'],
  ['那盆香草放哪儿好', 'm03'],
  ['换房子那天累坏了吧', 'm04'],
  ['查体结果有什么忌口', 'm05'],
  ['邻居小孩在弹琴', 'm06'],
  ['单车链子掉了', 'm07'],
  ['包裹过了时间没取', 'm08'],
  ['那台洗衣服的机器底下积水', 'm09'],
  ['看书的地方关门了', 'm10'],
  ['夜里下了好大的雨', 'm11'],
  ['装热水的杯子还烫手', 'm12'],
  ['公交绕路了', 'm13'],
  ['水果放坏了', 'm14'],
];

const round = (value, digits = 3) => Number(value.toFixed(digits));
const section = (title) => console.log('\n## ' + title + '\n');
const textOf = (id) => CORPUS.find(([key]) => key === id)[1];
const overlap = (query, id) => {
  const target = new Set(extractTerms(textOf(id)));
  return extractTerms(query).filter((term) => target.has(term));
};

function evaluate(dim) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-life-report-'));
  const store = openStore(join(dir, 'life.sqlite'), { identityId: 'report' });
  try {
    const encoder = createHashEncoder({ dim });
    const base = 1_700_000_000_000;
    CORPUS.forEach(([id, text], index) => {
      writePackage(store, {
        id,
        text,
        startSeq: index * 10 + 1,
        endSeq: index * 10 + 10,
        createdAt: new Date(base + index * 86_400_000).toISOString(),
      });
      indexPackage(store, { packageId: id, text, encoder });
    });
    const rows = QUERIES.map(([query, expected]) => {
      const result = recallPackages({ store, encoder, cue: { text: query }, options: { mode: 'semantic', perRoute: 20, limit: 20 } });
      const order = result.candidates.map((candidate) => candidate.packageId);
      const rank = order.indexOf(expected);
      return {
        query,
        expected,
        shared: overlap(query, expected).length,
        rank: rank === -1 ? null : rank + 1,
        top: order.length === 0 ? null : order[0],
        pool: order.length,
        topScore: order.length === 0 ? null : result.candidates[0].total,
        targetScore: rank === -1 ? 0 : result.candidates[rank].total,
      };
    });
    return { dim, rows };
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function summarise(rows) {
  const scored = rows.filter((row) => row.shared > 0);
  const zero = rows.filter((row) => row.shared === 0);
  const hit1 = scored.filter((row) => row.rank === 1).length;
  const hit3 = scored.filter((row) => row.rank !== null && row.rank <= 3).length;
  const miss = scored.filter((row) => row.rank === null).length;
  const mrr = scored.reduce((sum, row) => sum + (row.rank === null ? 0 : 1 / row.rank), 0) / (scored.length || 1);
  return {
    scored: scored.length,
    hit1,
    hit3,
    miss,
    mrr,
    zero: zero.length,
    zeroHit1: zero.filter((row) => row.rank === 1).length,
    zeroMiss: zero.filter((row) => row.rank === null).length,
    zeroSpurious: zero.filter((row) => row.rank !== null && row.rank !== 1).length,
  };
}

function printDetail(rows) {
  console.log('| 问题 | 目标 | 共同词 | 目标排名 | 第 1 名 | 候选数 | 目标分 | 第 1 名分 |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const row of rows) {
    console.log('| ' + row.query + ' | ' + row.expected + ' | ' + row.shared + ' | ' + (row.rank === null ? '未召回' : row.rank) + ' | ' + (row.top ?? '—') + ' | ' + row.pool + ' | ' + round(row.targetScore, 4) + ' | ' + (row.topScore === null ? '—' : round(row.topScore, 4)) + ' |');
  }
}

function runWeights() {
  const cases = [
    ['默认最小', { importance: 1, activation: -4, relevance: 0, association: 0, openLoop: 0, inhibition: 0 }],
    ['默认中等', { importance: 3, activation: 0, relevance: 0.5, association: 0.33, openLoop: 0, inhibition: 0 }],
    ['默认最大', { importance: 5, activation: 0, relevance: 1, association: 1, openLoop: 1, inhibition: 0 }],
    ['刚看过（抑制）', { importance: 5, activation: 0, relevance: 1, association: 1, openLoop: 1, inhibition: 1 }],
  ];
  console.log('| 场景 | importance | activation | relevance | association | openLoop | inhibition | 合计 |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const [label, factors] of cases) {
    const { total, parts } = fiveFactorScore(factors);
    console.log('| ' + label + ' | ' + round(parts.importance) + ' | ' + round(parts.activation) + ' | ' + round(parts.relevance) + ' | ' + round(parts.association) + ' | ' + round(parts.openLoop) + ' | ' + round(parts.inhibition) + ' | ' + round(total) + ' |');
  }
  const score = (factors) => fiveFactorScore(factors).total;
  console.log('');
  console.log('| 标定读数 | 值 |');
  console.log('|---|---|');
  console.log('| importance 1 → 5 的增量 | ' + round(score({ importance: 5 }) - score({ importance: 1 })) + ' |');
  console.log('| relevance 0 → 1 的增量 | ' + round(score({ importance: 3, relevance: 1 }) - score({ importance: 3, relevance: 0 })) + ' |');
  console.log('| importance 上限 / relevance 上限 | ' + round(score({ importance: 5 }) / score({ importance: 3, relevance: 1 }) * 100, 1) + '% |');
  console.log('| openLoop 的贡献 | ' + round(DEFAULT_WEIGHTS.openLoop) + ' |');
  console.log('| 压过 openLoop 所需最低 relevance | ' + round(DEFAULT_WEIGHTS.openLoop / DEFAULT_WEIGHTS.relevance) + ' |');
  console.log('| inhibition 抵消 openLoop 的比例 | ' + round((DEFAULT_WEIGHTS.inhibition / DEFAULT_WEIGHTS.openLoop) * 100, 1) + '% |');
  console.log('| activation 触底（-4）的贡献 | ' + round(DEFAULT_WEIGHTS.activation * -4) + ' |');
  const sorted = [0.9, 0.6, 0.3, 0.1].map((relevance) => score({ importance: 3, relevance })).sort((a, b) => b - a);
  const monotone = sorted.every((value, index) => index === 0 || value <= sorted[index - 1]);
  console.log('| relevance 单调性 | ' + (monotone ? '通过（4 个候选严格递减）' : '不通过') + ' |');
}

function runScoring() {
  const candidates = [
    { packageId: 'a', total: 0.9, importance: 3 },
    { packageId: 'b', total: 0.6, importance: 3 },
    { packageId: 'c', total: 0.3, importance: 3 },
    { packageId: 'd', total: 0.1, importance: 5 },
  ];
  const run = (seed) => selectMemories({ candidates, sampling: { seed, count: 3, temperature: DEFAULT_SAMPLING.temperature }, now: 1_700_000_000_000 }).selected.map((item) => item.packageId).join(',');
  const first = run(1);
  const again = run(1);
  console.log('| 检查 | 结果 |');
  console.log('|---|---|');
  console.log('| 同种子两次抽样 | ' + first + ' / ' + again + ' → ' + (first === again ? '相同' : '不同') + ' |');
  console.log('| 换种子 7 | ' + run(7) + ' |');
  console.log('| 不放回 | ' + (new Set(first.split(',')).size === 3 ? '是' : '否') + ' |');
  const equal = sampleCandidates([{ score: 1 }, { score: 1 }, { score: 1 }], { count: 2, seed: 1 });
  console.log('| 分数全等时的概率 | ' + equal.probabilities.map((value) => round(value)).join(' / ') + ' |');
  const scored = selectMemories({ candidates, sampling: { seed: 1, count: 3 }, now: 1_700_000_000_000 }).scored;
  console.log('| 排序是否随分数递减 | ' + (scored[0].score >= scored[scored.length - 1].score ? '是' : '否') + '（' + round(scored[0].score) + ' → ' + round(scored[scored.length - 1].score) + '） |');
}

function runUsage() {
  const raw = {
    prompt_tokens: 1200,
    completion_tokens: 300,
    total_tokens: 1500,
    prompt_cache_hit_tokens: 900,
    prompt_cache_miss_tokens: 300,
    unknown_key: 'not projected',
    nested: { any: 'thing' },
  };
  const projected = projectProviderUsage(raw);
  console.log('| 输入字段 | 投影后 |');
  console.log('|---|---|');
  for (const key of Object.keys(raw)) console.log('| ' + key + ' | ' + (Object.prototype.hasOwnProperty.call(projected, key) ? '保留' : '丢弃') + ' |');
  const hit = projected.prompt_cache_hit_tokens;
  const miss = projected.prompt_cache_miss_tokens;
  console.log('');
  console.log('| 指标 | 值 |');
  console.log('|---|---|');
  console.log('| 命中 / 未命中 | ' + hit + ' / ' + miss + ' |');
  console.log('| 命中率 hit/(hit+miss) | ' + round(hit / (hit + miss), 4) + ' |');
  console.log('| 命中占 prompt_tokens | ' + round(hit / projected.prompt_tokens, 4) + ' |');
  console.log('| 传 null | ' + (projectProviderUsage(null) === null ? '返回 null' : '返回对象') + ' |');
  console.log('| 传数组 | ' + (projectProviderUsage([{ prompt_tokens: 1 }]) === null ? '返回 null' : '返回对象') + ' |');
}

function runTokens() {
  const samples = [
    '路灯坏了，物业说下周二来修。',
    '把阳台那盆薄荷挪到窗边，晒到太阳了，叶子有点蔫。',
    '搬家那天纸箱堆到门口，电梯还坏了，只好一层层搬上去。',
    '夜里下暴雨，窗户没关，地板湿了一片，第二天开窗吹了一上午。',
  ];
  console.log('| 样本 | 字符 | 估算 tokens | tokens/字符 |');
  console.log('|---|---|---|---|');
  let chars = 0;
  let tokens = 0;
  for (const text of samples) {
    const count = [...text].length;
    const estimate = estimateTokens(text);
    chars += count;
    tokens += estimate;
    console.log('| ' + text.slice(0, 12) + '… | ' + count + ' | ' + estimate + ' | ' + round(estimate / count) + ' |');
  }
  console.log('| 合计 | ' + chars + ' | ' + tokens + ' | ' + round(tokens / chars) + ' |');
}


/**
 * 真实向量那一段：用远程 embedding 服务跑同一套语料与问题。
 * 只有传 --remote 且给了 key 才跑；key 从环境变量读，不落盘、不打印。
 */
async function evaluateRemote(encoder) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-life-report-remote-'));
  const store = openStore(join(dir, 'life.sqlite'), { identityId: 'report-remote' });
  try {
    const vectors = await encoder.encodeMany(CORPUS.map(([, text]) => text));
    CORPUS.forEach(([id, text], index) => {
      writePackage(store, {
        id,
        text,
        startSeq: index * 10 + 1,
        endSeq: index * 10 + 10,
        createdAt: new Date(1_700_000_000_000 + index * 86_400_000).toISOString(),
      });
      indexTerms(store, { packageId: id, text });
      writeVector(store, { packageId: id, encoderName: encoder.name, vector: vectors[index] });
    });
    const cueVectors = await encoder.encodeMany(QUERIES.map(([query]) => query));
    const rows = QUERIES.map(([query, expected], index) => {
      const result = recallPackages({
        store,
        encoderName: encoder.name,
        cue: { text: query },
        cueVector: cueVectors[index],
        options: { mode: 'semantic', perRoute: 20, limit: 20 },
      });
      const order = result.candidates.map((candidate) => candidate.packageId);
      const rank = order.indexOf(expected);
      return {
        query,
        expected,
        shared: overlap(query, expected).length,
        rank: rank === -1 ? null : rank + 1,
        top: order.length === 0 ? null : order[0],
        pool: order.length,
        topScore: order.length === 0 ? null : result.candidates[0].total,
        targetScore: rank === -1 ? 0 : result.candidates[rank].total,
      };
    });
    return { rows, dim: encoder.dim };
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function mainRemote() {
  const apiKey = process.env.LIFE_REPORT_EMBED_API_KEY;
  if (typeof apiKey !== 'string' || apiKey === '') {
    console.log('\n## 8. 真实向量（跳过）\n');
    console.log('没给 LIFE_REPORT_EMBED_API_KEY，这一段不跑。用法：');
    console.log('');
    console.log('    LIFE_REPORT_EMBED_API_KEY=… node tests/report.mjs --remote');
    console.log('');
    console.log('可选：LIFE_REPORT_EMBED_ENDPOINT（默认 ' + DEFAULT_EMBEDDING_ENDPOINT + '）、');
    console.log('      LIFE_REPORT_EMBED_MODEL、LIFE_REPORT_EMBED_NAME。key 只从环境变量读，不落盘、不打印。');
    return;
  }
  const endpoint = process.env.LIFE_REPORT_EMBED_ENDPOINT || 'https://api.siliconflow.cn/v1/embeddings';
  const model = process.env.LIFE_REPORT_EMBED_MODEL || 'Qwen/Qwen3-Embedding-8B';
  const name = process.env.LIFE_REPORT_EMBED_NAME || 'life-report-remote';
  const calls = [];
  const recordingFetch = async (...args) => {
    const response = await fetch(...args);
    const copy = response.clone();
    copy.json().then((body) => calls.push(body?.usage ?? null)).catch(() => calls.push(null));
    return response;
  };
  const encoder = createRemoteEncoder({ model, apiKey, endpoint, name, fetchImpl: recordingFetch });
  const { rows, dim } = await evaluateRemote(encoder);
  const m = summarise(rows);

  section('8. 真实向量：' + model + '（' + dim + ' 维，' + endpoint.replace(/^https?:\/\//, '').replace(/\/v1\/.*$/, '') + '）');
  console.log('| 指标 | 值 |');
  console.log('|---|---|');
  console.log('| 向量维度 | ' + dim + ' |');
  console.log('| 有共同词问题 | ' + m.scored + ' |');
  console.log('| 命中@1 | ' + m.hit1 + ' |');
  console.log('| 命中@3 | ' + m.hit3 + ' |');
  console.log('| MRR | ' + round(m.mrr) + ' |');
  console.log('| 未召回 | ' + m.miss + ' |');
  console.log('| 零共同词问题 | ' + m.zero + ' |');
  console.log('| 零共同词命中@1 | ' + m.zeroHit1 + ' |');
  console.log('| 零共同词误召 | ' + m.zeroSpurious + ' |');
  const used = calls.filter((entry) => entry !== null);
  const promptTokens = used.reduce((sum, entry) => sum + (Number(entry.prompt_tokens) || 0), 0);
  console.log('| embedding 调用数 | ' + calls.length + ' |');
  console.log('| 上报 prompt_tokens 合计 | ' + promptTokens + ' |');
  console.log('');
  printDetail(rows);
}

const DIMS = [64, 256, 1024, 4096];
const runs = DIMS.map((dim) => evaluate(dim));

section('1. 记忆召回：维度扫描（本地 hash-bigram-v1，语义路，14 包 28 问）');
console.log('| dim | 有共同词问题 | 命中@1 | 命中@3 | MRR | 未召回 | 零共同词问题 | 零组命中@1 | 零组未召回 | 零组误召 |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const { dim, rows } of runs) {
  const m = summarise(rows);
  console.log('| ' + dim + ' | ' + m.scored + ' | ' + m.hit1 + ' | ' + m.hit3 + ' | ' + round(m.mrr) + ' | ' + m.miss + ' | ' + m.zero + ' | ' + m.zeroHit1 + ' | ' + m.zeroMiss + ' | ' + m.zeroSpurious + ' |');
}

section('2. 召回明细（dim = 64）');
printDetail(runs[0].rows);

section('3. 召回明细（dim = 1024，本仓默认仍是 64）');
printDetail(runs[2].rows);

section('4. 五因子打分与权重标定（DEFAULT_WEIGHTS）');
runWeights();

section('5. 抽样与确定性');
runScoring();

section('6. usage 投影与缓存命中（夹具数字）');
runUsage();

section('7. token 估算比例（tokens.mjs 的估算，不是账单）');
runTokens();

await mainRemote();
