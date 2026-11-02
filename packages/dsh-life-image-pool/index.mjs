/**
 * 号池那两只手。
 *
 * 为什么单独一个插件、而不是塞进 life-draw：这套链路由外部服务提供（生图服务、
 * 本部署自带的 import key）。分发出去以后，别人装的副本里不该出现「传号池」
 * 「查号池」这样的动作——所以 manifest 里写了 requires：
 *
 * requires.plugins = ["life-draw"] ← 装了原生生图插件，才配谈号池
 * requires.services = ["imagePool"] ← 宿主真的交出了号池服务（本机有 import key）
 *
 * 两条有一条不满足，这个插件就不加载（loader 记进 skipped，不是报错）。助手的工具表里
 * 也就没有这两个工具，别人拿去分发时看不到这条链路。
 *
 * 助手看不见的东西：文件内容、import key、每个账号的 token。插件拿到的只是
 * context.imagePool 这个动作；分批、验号、去重、删原件全在宿主那一侧。
 */

/** 宿主的错误码 → 一句助手能懂的话。认不出的就照原样说，不编。 */
const MESSAGES = Object.freeze({
 // 号池这边
  missing_key: '这条线没接：本机没有导入钥。',
  empty_file: '这份文件里没有一行能读的。',
  import_day_cap: '今天导入的次数用完了，明天再来。',
  too_many_batches: '这份太多了，一次导不完；分成几份再给我。',
  timeout: '对面超时了，号池那边没回话。',
  network: '连不上生图那边。',
  bad_json: '对面回的东西看不懂。',
  status_failed: '号池那边没回状态。',
 // 屋子这边（room.mjs 的码）
  not_found: '屋里没有这个文件。',
  not_a_file: '那是个目录，不是文件。',
  outside_room: '那个路径不在你能看的地方里面。',
  symlink_refused: '那是个链接，不是真文件；链接我不跟。',
  sealed: '这份不是我搬得动的。',
  invalid_path: '这个位置不对（要写成屋里相对路径，例如 inbox/xxx.txt）。',
  invalid_input: '参数不对。',
});

function translate(error) {
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
  if (code !== '' && Object.hasOwn(MESSAGES, code)) return new Error(MESSAGES[code]);
 // http 错误带着对面那句话，直接给助手（那句话里永远没有 token）。
  const message = String((error && error.message) || error);
  if (code === 'http_error' || code === 'status_failed') return new Error('对面报错：' + message);
  return new Error(code === '' ? message : code + '：' + message);
}

function lineList(numbers) {
  if (Array.isArray(numbers) === false || numbers.length === 0) return '';
  const head = numbers.slice(0, 10).join('、');
  return '（第 ' + head + (numbers.length > 10 ? ' 等 ' + numbers.length + ' 行' : ' 行') + '）';
}

export function create(context) {
  const pool = context.imagePool;
  if (pool === null || typeof pool !== 'object') {
    throw new Error('life-image-pool needs context.imagePool from the host');
  }

  context.tool('image_pool_import', {
    description: '把一份账号文件交给生图那条线导入号池。我不看里面的内容，只回给你导进去几条、'
      + '几条跳过、几条无效。from 是它在屋里的位置（例如 inbox/FF261031131431.txt）。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '屋里那份文件的位置，例如 inbox/FF261031131431.txt' },
        keep: { type: 'boolean', description: '要不要留下原件；默认不留（导完就删）' },
      },
      required: ['from'],
      additionalProperties: false,
    },
    async execute(args) {
      const from = args !== null && typeof args === 'object' && typeof args.from === 'string' ? args.from : '';
      if (from === '') throw new Error(MESSAGES.invalid_path);
      let result;
      try {
        result = await pool.importFile({ from, discard: args.keep === true ? false : true });
      } catch (error) {
        throw translate(error);
      }
      if (result.ok !== true) {
        const partial = result.batches > 0
          ? '（前 ' + result.batches + ' 批里已经加进去 ' + result.created + ' 个）'
          : '';
        throw new Error('没导完：' + (result.error ?? '对面出错') + partial + '；原件我留着了。');
      }
      const bits = ['这份 ' + result.lines + ' 行，新增 ' + result.created + ' 个'];
      if (result.skipped > 0) bits.push('重复跳过 ' + result.skipped + ' 个');
      if (result.invalid > 0) bits.push('无效 ' + result.invalid + ' 个' + lineList(result.invalidLines));
      if (result.failed > 0) bits.push('失败 ' + result.failed + ' 个' + lineList(result.failedLines));
      if (result.accountsTotal !== null) bits.push('号池现在 ' + result.accountsTotal + ' 个号');
      const tail = result.removed === true ? '原件已经删掉了。' : '原件还在：' + result.from + '。';
      return '导好了：' + bits.join('，') + '。' + tail;
    },
  });

  context.tool('image_pool_status', {
    description: '看号池现在什么情况：一共多少号、能用的有几个、额度合计多少。我没问就不查。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      let status;
      try {
        status = await pool.status();
      } catch (error) {
        throw translate(error);
      }
      const byStatus = Object.entries(status.byStatus ?? {})
        .filter(([, count]) => count > 0)
        .map(([name, count]) => name + ' ' + count)
        .join('，');
      return '号池：' + status.total + ' 个号，可用 ' + status.usable + '，额度合计 ' + status.quota
        + (byStatus === '' ? '。' : '（' + byStatus + '）。');
    },
  });

  context.log('life-image-pool ready: 号池那只手接上了（导入 / 状态）');
}
