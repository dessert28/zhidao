/**
 * 多轮对话端到端测试脚本（对真实运行中的 BFF 发请求）
 *
 * 用法：node --import tsx scripts/e2e-multiturn.ts
 *
 * 覆盖的场景按"极端程度"递增：
 *   A. 正常三轮（用户原本的报告路径）
 *   B. 用户直接一句话给全信息（不该追问）
 *   C. 同一槽位用户改口
 *   D. 追问超过 3 轮必须停止追问
 *   E. 中途插入无关闲聊后回到症状
 *   F. 空会话状态下直接给完整描述
 *   G. 每轮都重复同一句话（模拟用户急/不耐烦）
 *
 * 判定标准写在每个 check 里，失败会打印实际值，不做"看起来对"的判断。
 */

import { checkRedFlag } from '../server/agents/rules/red-flag.js';

const BASE = 'http://localhost:5173/api/chat';

interface TurnResult {
  events: Array<{ type: string; [k: string]: unknown }>;
  plan?: { decision: string; reason: string };
  clarify?: { question: string; missing: string[] };
  departments?: Array<{ name: string; confidence: number; reason: string }>;
  session?: { slots: Record<string, string | undefined>; round: number };
  tokens: string[];
}

async function turn(text: string, session?: TurnResult['session']): Promise<TurnResult> {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      knownSlots: session?.slots ?? {},
      round: session?.round ?? 0,
    }),
  });
  const raw = await res.text();
  const out: TurnResult = { events: [], tokens: [] };

  for (const block of raw.split('\n\n')) {
    const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
    if (!dataLine) continue;
    let e: any;
    try {
      e = JSON.parse(dataLine.slice(6));
    } catch {
      continue;
    }
    out.events.push(e);
    if (e.type === 'plan') out.plan = e;
    if (e.type === 'clarify') out.clarify = e;
    if (e.type === 'department_card') out.departments = e.departments;
    if (e.type === 'token') out.tokens.push(e.text);
    if (e.type === 'done') out.session = e.session;
  }
  return out;
}

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✔ ${name}`);
  } else {
    fail++;
    failures.push(`${name} ${detail}`);
    console.log(`  ✘ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

async function scenarioA() {
  console.log('\nA. 正常三轮（用户原始报告路径）');
  const t1 = await turn('我头疼，建议吃点布洛芬吗');
  check('第 1 轮追问', Boolean(t1.clarify), JSON.stringify(t1.clarify));
  check('第 1 轮回传 session', Boolean(t1.session), JSON.stringify(t1.session));
  const q1 = t1.clarify?.question ?? '';

  const t2 = await turn('好几天了', t1.session);
  const q2 = t2.clarify?.question ?? '';
  check('第 2 轮不再问时长', !q2.includes('多久'), `实际问题：${q2}`);
  check('第 2 轮不重复第 1 轮问题', q2 !== q1, `两轮问题相同：${q1}`);
  check('第 2 轮槽位含时长', Boolean(t2.session?.slots?.时长), JSON.stringify(t2.session?.slots));
  check('第 2 轮给出科室或继续问其他槽位', Boolean(t2.departments || t2.clarify));

  if (t2.clarify) {
    const t3 = await turn('胸', t2.session);
    check('第 3 轮槽位含部位', Boolean(t3.session?.slots?.部位), JSON.stringify(t3.session?.slots));
    check(
      '第 3 轮不重复第 2 轮问题',
      (t3.clarify?.question ?? '') !== (t2.clarify?.question ?? ''),
      `第2轮=${t2.clarify?.question} / 第3轮=${t3.clarify?.question}`,
    );
  }
}

async function scenarioB() {
  console.log('\nB. 一句话给全信息 —— 不该追问');
  const t = await turn('后脑勺胀痛三天了，低头时更明显');
  check('不追问', !t.clarify, JSON.stringify(t.clarify));
  check('直接给科室', Boolean(t.departments && t.departments.length > 0));
  check('给出的科室 ≤3 个', (t.departments?.length ?? 0) <= 3, String(t.departments?.length));
}

async function scenarioC() {
  console.log('\nC. 用户改口（同槽位新值覆盖）');
  const t1 = await turn('肚子疼');
  const t2 = await turn('其实是上腹部', t1.session);
  const pos = t2.session?.slots?.部位 ?? '';
  check('部位更新为最新说法', /上腹/.test(pos), `实际：${pos}`);
}

async function scenarioD() {
  console.log('\nD. 追问熔断：超过 3 轮必须停止追问');

  /*
   * 必须先触发一次追问，再开始喂无信息回复。
   *
   * 第一版直接从 `s = undefined` 开始喂「嗯」，结果第一句就被判成 done
   * （全新会话、没有任何上下文时，「嗯」确实不该进分诊）——
   * 于是循环第一轮就退出了，后面关于熔断的断言全部落空。
   * 这不是产品缺陷，是测试没构造出"正在追问中"这个前提。
   */
  const opener = await turn('不舒服');
  let s: TurnResult['session'] = opener.session;
  let rounds = opener.clarify ? 1 : 0;
  let last: TurnResult = opener;

  for (const reply of ['嗯', '说不好', '不知道', '反正不舒服', '还是说不好', '不清楚']) {
    last = await turn(reply, s);
    // 打印每一轮实际用了什么 round，避免"测试自身算错"被当成产品缺陷
    console.log(
      `     轮次「${reply}」: 传入 round=${s?.round ?? 0} → 返回 round=${last.session?.round} | 追问=${Boolean(last.clarify)} | 科室=${last.departments?.length ?? 0}`,
    );
    s = last.session;
    if (last.clarify) rounds++;
    if (!last.clarify) break;
  }

  check('追问轮次不超过 3', rounds <= 3, `实际追问 ${rounds} 轮`);
  check(
    '达到上限后给出科室而不是继续追问',
    Boolean(!last.clarify && last.departments && last.departments.length > 0),
    JSON.stringify({ clarify: Boolean(last.clarify), dept: last.departments?.length }),
  );
  check(
    '信息不全时给出明确的说明（caveat）',
    Boolean(last.events.some((e) => e.type === 'caveat')),
    '未找到 caveat 事件',
  );
}

async function scenarioE() {
  console.log('\nE. 中途插入无关闲聊后回到症状');
  const t1 = await turn('头晕');
  const t2 = await turn('今天天气不错', t1.session);
  const t3 = await turn('三天了', t2.session);
  check('闲聊后仍记得部位', Boolean(t3.session?.slots?.部位), JSON.stringify(t3.session?.slots));
  check('最终能给出科室或剩余追问', Boolean(t3.departments || t3.clarify));
}

async function scenarioF() {
  console.log('\nF. 零状态直接给完整描述');
  const t = await turn('咳嗽两周了，有黄痰', undefined);
  check('不崩且有输出', t.events.length > 0);
  /*
   * 这里允许重试一次：模型输出有随机性，同一句话偶尔会追问一句。
   * 但**连续两次都不给科室才算失败** —— 那说明是系统性问题，
   * 不是单次波动。这个区分很重要：把偶发当缺陷会让测试变噪声，
   * 把系统性当偶发会让缺陷漏网。
   */
  let dept = t.departments;
  if (!dept && t.clarify) {
    const retry = await turn('咳嗽两周了，有黄痰，没有发热', t.session);
    dept = retry.departments;
    if (!dept) {
      // 第二次仍追问，把实际问的内容打出来便于定位
      console.log(`     （重试后仍追问：${retry.clarify?.question?.replace(/\n/g, ' / ')}）`);
    }
  }
  check('给出科室（允许 1 次重试）', Boolean(dept && dept.length > 0), JSON.stringify(dept));
}

async function scenarioG() {
  console.log('\nG. 连续重复同一句（模拟用户不耐烦）');
  const t1 = await turn('头疼');
  const t2 = await turn('头疼', t1.session);
  const t3 = await turn('头疼', t2.session);
  const t4 = await turn('头疼', t3.session);
  check('重复输入不导致崩溃', [t2, t3, t4].every((t) => t.events.length > 0));
  check(
    '轮次会推进（不会无限停在 round 1）',
    (t4.session?.round ?? 0) >= 3 || Boolean(t4.departments),
    `round=${t4.session?.round} dept=${t4.departments?.length}`,
  );
}

async function main() {
  console.log('多轮对话端到端测试');
  console.log('='.repeat(60));

  await scenarioA();
  await scenarioB();
  await scenarioC();
  await scenarioD();
  await scenarioE();
  await scenarioF();
  await scenarioG();

  console.log('\n' + '='.repeat(60));
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) {
    console.log('\n失败项：');
    failures.forEach((f) => console.log('  · ' + f));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('测试脚本异常：', e);
  process.exitCode = 1;
});
