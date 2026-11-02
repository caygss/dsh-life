#!/usr/bin/env node
/**
 * 本地检查：和 CI 跑同样两步（语法 + 示例冒烟）。
 *
 * 为什么是一个 Node 脚本而不是 sh 一行行写：仓库在 Windows 上开发，find/xargs/grep
 * 在 PowerShell 里没有；逻辑放这里，pre-push 只负责转调，两边都能跑。
 *
 *   node .githooks/check.mjs
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'data', '.runtime']);

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith('.mjs')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const files = walk(root, []);
let bad = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    bad += 1;
    console.error('[check] syntax failed: ' + path.relative(root, file));
    console.error((result.stderr || '').trim());
  }
}
console.log('[check] syntax: ' + files.length + ' files, ' + bad + ' failed');
if (bad > 0) process.exit(1);

const run = spawnSync(process.execPath, ['examples/minimal-host/start.mjs'], {
  cwd: root,
  encoding: 'utf8',
  timeout: 120_000,
});
const output = (run.stdout || '') + (run.stderr || '');
const expected = ['ws push message', 'set_online_status', '心声（不发送）：其实有点紧张', '发出 2 条'];
const missing = expected.filter((line) => !output.includes(line));
if (run.status !== 0 || missing.length > 0) {
  console.error(output.trim());
  console.error('[check] example smoke failed: exit=' + run.status + (run.error ? ', ' + run.error.message : '') + (missing.length ? ', missing: ' + missing.join(' | ') : ''));
  process.exit(1);
}
console.log('[check] example smoke: ok');
