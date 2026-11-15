/**
 * HIS 接入示例脚本 —— 院方对接人可以直接参考这份代码。
 *
 * 用法：
 *   npx tsx scripts/his-push-demo.ts                        # 推送到本地 8080
 *   BASE=http://host:8080 APP_KEY=xxx APP_SECRET=yyy npx tsx scripts/his-push-demo.ts
 *
 * 这个脚本存在的意义：院方接进来时最常见的卡点是"签名算不对但不告诉哪里不对"。
 * 与其让每家医院重写一遍实现，不如给一份可运行的参考。
 *
 * 签名算法（与服务端 HisSignature.java 必须一致）：
 *   stringToSign = METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + SHA256(body)
 *   signature    = HMAC-SHA256(secret, stringToSign) 的小写十六进制
 */

import { createHash, createHmac } from 'node:crypto';

const BASE = process.env.BASE ?? 'http://localhost:8080';
const APP_KEY = process.env.APP_KEY ?? 'z2jfl-demo-key';
const APP_SECRET = process.env.APP_SECRET ?? 'z2jfl-demo-secret-please-rotate-in-production';

/** 计算签名。这是院方需要照抄的核心逻辑 */
export function sign(
  secret: string,
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: string,
): string {
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  const toSign = [method.toUpperCase(), path, timestamp, nonce, bodyHash].join('\n');
  return createHmac('sha256', secret).update(toSign, 'utf8').digest('hex');
}

/** 带签名的 POST */
async function signedPost(path: string, payload: unknown) {
  // body 必须先序列化成字符串：签名算的是这段字符串，发出去的也必须是同一段。
  // 若签名时用 JSON.stringify(x)、发送时又 stringify 一次，两次结果可能不同
  // （空格、key 顺序），签名就会对不上 —— 这是最常见的坑。
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = createHash('sha256')
    .update(`${Date.now()}-${Math.random()}`)
    .digest('hex')
    .slice(0, 16);

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
  try {
    json = JSON.parse(text);
  } catch {
    /* 保留原文 */
  }
  return { status: res.status, body: json };
}

/**
 * 演示数据：假装我们是浙大二院 HIS，把官方楼层推给智诊通。
 *
 * 这批数据比之前从公开来源整理的更完整 —— 真实接入时院方本来就是
 * 从自己系统里导出，不存在"查不到具体楼层"的问题。
 */
const PLACES = {
  batchId: `demo-${Date.now()}`,
  hospitalCode: 'Z2-JFL',
  places: [
    {
      placeType: 'REGISTER',
      name: '门诊一站式综合服务中心',
      building: '10号楼（名医馆）',
      floor: '1F',
      directions: '10号楼1楼，任一窗口可办理挂号收费、医保审核、检查预约、医疗证明盖章。',
      openHours: '周一至周日 7:00-17:00',
      estMinutes: 15,
      sortOrder: 10,
    },
    {
      placeType: 'LAB',
      name: '检验抽血 / 超声 / 心电图',
      building: '10号楼（名医馆）',
      floor: '4F',
      directions: '10号楼4楼，出电梯后按指示牌分流：抽血在左侧取号，超声与心电图在右侧。',
      openHours: '周一至周六 7:30-16:00',
      estMinutes: 30,
      sortOrder: 20,
    },
    {
      placeType: 'CLINIC',
      department: '内分泌科',
      name: '内分泌科门诊',
      building: '9号楼',
      floor: '3F',
      directions: '9号楼3楼东区，到达后在诊区门口二次报到。',
      openHours: '周一至周日 8:00-17:00',
      estMinutes: 60,
      sortOrder: 50,
    },
    {
      placeType: 'CLINIC',
      department: '内分泌科',
      name: '糖尿病中心',
      building: '7号楼',
      floor: '2F',
      directions: '7号楼2楼（解放路78号院区一侧）。',
      openHours: '周一至周五 8:00-17:00',
      estMinutes: 60,
      sortOrder: 51,
    },
    {
      placeType: 'EXAM',
      name: 'CT / 核磁共振',
      building: '10号楼（名医馆）',
      floor: '2F',
      directions: '10号楼2楼，需先在1楼综合服务中心完成检查预约。',
      openHours: '周一至周日 8:00-17:00',
      estMinutes: 40,
      sortOrder: 40,
    },
    {
      placeType: 'CASHIER',
      name: '门诊收费窗口',
      building: '10号楼（名医馆）',
      floor: '1F',
      directions: '与综合服务中心同层，检查、取药前先完成缴费。',
      openHours: '周一至周日 7:00-17:00',
      estMinutes: 10,
      sortOrder: 60,
    },
    {
      placeType: 'REPORT',
      name: '自助报告打印',
      building: '10号楼（名医馆）',
      floor: '1F',
      directions: '1楼大厅自助机可打印检验报告，扫码或刷就诊卡。',
      openHours: '周一至周日 7:00-20:00',
      estMinutes: 5,
      sortOrder: 70,
    },
    {
      placeType: 'PHARMACY',
      name: '门诊药房',
      building: '9号楼',
      floor: '1F',
      directions: '9号楼1楼，先缴费再取药，按取药条上的窗口号排队。',
      openHours: '周一至周日 8:00-17:30',
      estMinutes: 20,
      sortOrder: 80,
    },
  ],
};

async function main() {
  console.log('='.repeat(60));
  console.log('HIS 对接演示 —— 院方推送院内地点');
  console.log('='.repeat(60));
  console.log(`服务地址: ${BASE}`);
  console.log(`appKey  : ${APP_KEY}`);
  console.log(`地点条数: ${PLACES.places.length}`);
  console.log('');

  /* ---- 1. 故意用错签名，确认服务端会拒绝 ---- */
  console.log('[1] 用错误密钥签名（应被拒绝）');
  const wrongSig = sign('wrong-secret', 'POST', '/api/his/places',
    String(Math.floor(Date.now() / 1000)), 'nonce1', '{}');
  const bad = await fetch(`${BASE}/api/his/places`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-App-Key': APP_KEY,
      'X-Timestamp': String(Math.floor(Date.now() / 1000)),
      'X-Nonce': 'nonce1',
      'X-Signature': wrongSig,
    },
    body: '{}',
  });
  console.log(`    → HTTP ${bad.status} ${bad.status === 401 ? '✔ 正确拒绝' : '✘ 不该通过'}`);
  console.log('');

  /* ---- 2. 正确签名推送 ---- */
  console.log('[2] 用正确签名推送');
  const r1 = await signedPost('/api/his/places', PLACES);
  console.log(`    → HTTP ${r1.status}`);
  console.log(`    → ${JSON.stringify(r1.body)}`);
  console.log('');

  /* ---- 3. 同一批次重推，验证幂等 ---- */
  console.log('[3] 同一 batchId 重推（应识别为已处理，不重复写入）');
  const r2 = await signedPost('/api/his/places', PLACES);
  console.log(`    → HTTP ${r2.status}`);
  console.log(`    → ${JSON.stringify(r2.body)}`);

  const r2n = r2.body as { data?: { duplicated?: boolean } };
  console.log(`    → ${r2n.data?.duplicated ? '✔ 幂等生效' : '✘ 未识别为重复批次'}`);
}

/*
 * 直接执行，不做 "是不是主模块" 的判断。
 *
 * 之前用 import.meta.url === file://argv[1] 判断，在 Windows 上
 * 因为路径分隔符与盘符大小写经常匹配不上，脚本会静默什么都不做 ——
 * 这种"没报错也没输出"最难排查。这个文件本身就是脚本，
 * 被 import 的概率为零，直接调即可。
 */
main().catch((e) => {
  console.error('演示脚本异常：', e);
  process.exitCode = 1;
});
