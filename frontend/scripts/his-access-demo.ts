/**
 * 院方调阅示例 —— 模拟 HIS 在医生看诊时拉取患者报告。
 *
 * 用法：
 *   npx tsx scripts/his-access-demo.ts
 *   BASE=http://host:8080 MATCH_CODE=XXXXXXXX npx tsx scripts/his-access-demo.ts
 *
 * 演示完整链路：
 *   1. HIS 用匹配码调阅患者报告（就诊即授权，无需患者操作）
 *   2. 查看返回的报告内容与访问窗口
 *   3. 回执归档 —— 告知我方「已存入病案」
 *   4. 界面上患者能看到这次调阅记录
 *
 * 签名算法与 his-push-demo.ts 完全一致，对院方来说只有一套集成。
 */

import { createHash, createHmac } from 'node:crypto';

const BASE = process.env.BASE ?? 'http://localhost:8080';
const APP_KEY = process.env.APP_KEY ?? 'z2jfl-demo-key';
const APP_SECRET = process.env.APP_SECRET ?? 'z2jfl-demo-secret-please-rotate-in-production';
const MATCH_CODE = process.env.MATCH_CODE ?? 'DEMO2026';

function sign(
  secret: string, method: string, path: string,
  timestamp: string, nonce: string, body: string,
): string {
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  const toSign = [method.toUpperCase(), path, timestamp, nonce, bodyHash].join('\n');
  return createHmac('sha256', secret).update(toSign, 'utf8').digest('hex');
}

async function signedPost(path: string, payload: unknown) {
  // 签名用这段字符串，发送也必须是同一段 —— 这一点与推送示例相同
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 16);
  const signature = sign(APP_SECRET, 'POST', path, timestamp, nonce, body);

  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-App-Key': APP_KEY,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Signature': signature,
    },
    body,
  });
  const text = await res.text();
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* 保留原文 */ }
  return { status: res.status, body: json as Record<string, unknown> };
}

const today = new Date().toLocaleDateString('sv-SE');

async function main() {
  console.log('='.repeat(64));
  console.log('院方调阅演示 —— 就诊即授权');
  console.log('='.repeat(64));
  console.log(`服务地址  : ${BASE}`);
  console.log(`匹配码    : ${MATCH_CODE}`);
  console.log(`就诊日期  : ${today}`);
  console.log('');

  /* ---------- 1. 调阅 ---------- */
  console.log('[1] HIS 调阅患者报告（患者无需任何操作）');
  const r1 = await signedPost('/api/his/patient-report', {
    matchCode: MATCH_CODE,
    visitDate: today,
  });
  console.log(`    → HTTP ${r1.status}`);

  if (r1.status !== 200) {
    console.log(`    → ${JSON.stringify(r1.body)}`);
    console.log('');
    console.log('提示：匹配码无效 / 未授权给本院区 / 患者关闭了自动授权，都会在这里被拒绝。');
    return;
  }

  const data = r1.body.data as {
    windowStart: string; windowEnd: string; count: number;
    records: Array<Record<string, unknown>>; auditNotice: string;
  };
  console.log(`    → 访问窗口：${data.windowStart} ~ ${data.windowEnd}`);
  console.log(`    → 命中记录：${data.count} 条`);
  console.log('');

  /* ---------- 2. 报告内容 ---------- */
  if (data.records.length > 0) {
    console.log('[2] 调阅到的内容（医生在 HIS 里看到的）');
    for (const rec of data.records) {
      const head = `${rec.visitDate} ${rec.department ?? ''} ${rec.diagnosis ?? ''}`.trim();
      const content = String(rec.content ?? '').replace(/\s+/g, ' ');
      console.log(`    · ${head}`);
      console.log(`      ${content.slice(0, 72)}${content.length > 72 ? '…' : ''}`);
    }
    console.log('');
  }

  /* ---------- 3. 回执归档 ---------- */
  console.log('[3] 回执：告知我方已归档到本次病案');
  const r2 = await signedPost('/api/his/patient-report/archived', {
    matchCode: MATCH_CODE,
    visitDate: today,
    recordIds: data.records.map((x) => x.recordId),
  });
  console.log(`    → HTTP ${r2.status} ${JSON.stringify(r2.body)}`);
  console.log('');

  /* ---------- 4. 越权测试 ---------- */
  console.log('[4] 用另一个院区的凭据试调（应被拒绝）');
  const wrong = await fetch(`${BASE}/api/his/patient-report`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-App-Key': 'z2jfl-demo-key',
      'X-Timestamp': String(Date.now() / 1000),
      'X-Nonce': 'n',
      'X-Signature': '0'.repeat(64),
    },
    body: JSON.stringify({ matchCode: MATCH_CODE }),
  });
  console.log(`    → HTTP ${wrong.status} ${wrong.status === 401 ? '✔ 正确拒绝（签名无效）' : ''}`);
  console.log('');

  console.log('='.repeat(64));
  console.log('调阅与归档都已完成。');
  console.log('打开 http://localhost:5173/records 的「隐私与授权」区块，');
  console.log('可以看到刚才这两次访问的记录 —— 这是患者视角。');
  console.log('='.repeat(64));
}

main().catch((e) => {
  console.error('演示脚本异常：', e);
  process.exitCode = 1;
});
