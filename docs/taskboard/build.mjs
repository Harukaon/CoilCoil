#!/usr/bin/env node
/**
 * 把 tasks.json 注入 board.template.html，生成可直接双击打开的 index.html。
 * 用法: node docs/taskboard/build.mjs
 *
 * 之所以要这一步：双击打开的页面走 file:// 协议，fetch() 读同目录 JSON 会被
 * CORS 拦掉，看板会是空的。内联数据可以绕开这个限制。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// 1) 先把各 agent 独立写的 results/task-<id>.json 合并回 tasks.json。
// 每个 agent 写自己那一个文件，避免并发写同一个 JSON 打架；userComments 是
// 用户那一侧的数据，这里永远不碰。
const data = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8'));
const byId = new Map(data.tasks.map((t) => [t.id, t]));
const resultsDir = join(here, 'results');
let merged = 0;

// 用户最后一次从看板导出的时间。晚于它的 agent 结果才是「这一轮新交的东西」。
const exportedAt = data.meta?.exportedAt ? Date.parse(data.meta.exportedAt) : 0;
const resultTime = (r) =>
  Math.max(0, ...[...(r.agentNotes ?? []), ...(r.commits ?? [])].map((x) => Date.parse(x.at) || 0));

if (existsSync(resultsDir)) {
  for (const file of readdirSync(resultsDir).filter((f) => f.endsWith('.json')).sort()) {
    const r = JSON.parse(readFileSync(join(resultsDir, file), 'utf8'));
    const task = byId.get(r.id);
    if (!task) {
      console.warn(`! ${file} 的 id ${r.id} 在 tasks.json 里不存在，跳过`);
      continue;
    }
    // agent 的产出按 ref/text 去重后追加，重复 build 不会堆出一堆一样的记录
    const seenNotes = new Set((task.agentNotes ?? []).map((n) => n.text));
    for (const n of r.agentNotes ?? []) {
      if (!seenNotes.has(n.text)) { (task.agentNotes ??= []).push(n); seenNotes.add(n.text); }
    }
    const seenCommits = new Set((task.commits ?? []).map((c) => c.ref));
    for (const c of r.commits ?? []) {
      if (!seenCommits.has(c.ref)) { (task.commits ??= []).push(c); seenCommits.add(c.ref); }
    }
    // 状态归属：用户导出那一刻的判断是准的，比它旧的 agent 结果不许把它改回去。
    // 不然用户在看板上点了「已完成」或「打回重做」，下一次 build 又被上一轮的
    // results 文件刷成「待验收」，用户的验收结果就白点了。
    if (r.status && (!exportedAt || resultTime(r) > exportedAt)) task.status = r.status;
    merged++;
  }
}

const tasks = JSON.stringify(data, null, 2) + '\n';
writeFileSync(join(here, 'tasks.json'), tasks);

// 2) 注入模板生成 index.html
const template = readFileSync(join(here, 'board.template.html'), 'utf8');

const marker = '/*__TASKS_JSON__*/null';
if (!template.includes(marker)) {
  console.error(`模板里找不到注入标记 ${marker}`);
  process.exit(1);
}

// </script> 出现在 JSON 字符串里会提前闭合 script 标签
const safe = tasks.replace(/<\//g, '<\\/');
const stamp = new Date().toISOString();

const html = template
  .replace(marker, safe)
  .replace('/*__BUILT_AT__*/""', JSON.stringify(stamp));

writeFileSync(join(here, 'index.html'), html);

const count = data.tasks.length;
const done = data.tasks.filter((t) => t.status === 'done').length;
const review = data.tasks.filter((t) => t.status === 'review').length;
console.log(
  `✓ 已生成 index.html — ${count} 个任务（待验收 ${review} / 已完成 ${done}）` +
    `，合并了 ${merged} 份 agent 结果，构建于 ${stamp}`,
);
