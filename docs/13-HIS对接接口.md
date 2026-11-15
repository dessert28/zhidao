# HIS 对接接口

> 给医院信息科的接入说明。读完这份文档，院方应当能在**半天内**完成对接。
>
> 服务地址与凭据由我方单独提供，不在本文件里。

---

## 1. 这个接口做什么

智诊通把患者端的"院内导航"建立在院方数据之上。接入后：

| 数据 | 谁提供 | 患者看到什么 |
| --- | --- | --- |
| 院内地点（科室楼层、窗口、药房） | **院方推送** | 「到院怎么走」的分步路线 |
| 号源 | 院方适配器（另一套契约） | 可预约时段 |

**关键区别**：在此之前，院内导航是我们从公开信息整理的（标 `REAL` 但只是"公开可查"）。
院方推送后，`dataQuality` 才是真正意义上的"官方数据"。

---

## 2. 认证：appKey + HMAC-SHA256 签名

### 2.1 我方提供什么

| 项 | 说明 |
| --- | --- |
| `appKey` | 公开的应用标识，放在请求头里 |
| `appSecret` | 签名密钥。**只交付一次**，请存进院方的密钥管理，不要写进代码库 |

### 2.2 签名算法

```
stringToSign = METHOD        + "\n"
             + PATH          + "\n"
             + TIMESTAMP     + "\n"
             + NONCE         + "\n"
             + SHA256(body)

signature = HMAC-SHA256(appSecret, stringToSign)  → 小写十六进制
```

各要素说明：

| 要素 | 取值 |
| --- | --- |
| `METHOD` | 大写，如 `POST` |
| `PATH` | 不含 host 与 query，如 `/api/his/places` |
| `TIMESTAMP` | 秒级 Unix 时间戳 |
| `NONCE` | 一次性随机串，建议 16 位以上 |
| `body` | 请求体**原文**。GET 传空串 |

### 2.3 请求头

```
X-App-Key:   <appKey>
X-Timestamp: <秒级时间戳>
X-Nonce:     <随机串>
X-Signature: <签名>
Content-Type: application/json
```

### 2.4 三个最常见的对接错误

1. **签名用的 body 和发出去的 body 不是同一段字节**
   先 `JSON.stringify(obj)` 得到字符串，对这个字符串签名，然后**原样发送这个字符串**。
   不要在发送时再序列化一次 —— 空格、key 顺序变了，签名就对不上。

2. **nonce 对不上**
   签名时用的 nonce 必须和 `X-Nonce` 头里的完全一致。

3. **时间戳偏差过大**
   允许 ±5 分钟。服务器时间不准时先对 NTP。

### 2.5 签名自检接口（推荐先用它验证实现）

`POST /api/his/sign`

把你们准备好的参数发过来，我们返回算出的签名，你们和自己的实现对比：

```json
// 请求体
{ "method": "POST", "path": "/api/his/places",
  "timestamp": "1763200000", "nonce": "abc123", "body": "{\"batchId\":\"b1\"}" }

// 响应
{ "code": 0, "data": {
    "algorithm": "HMAC-SHA256",
    "yourSignature": "<我们算出的签名>",
    "hint": "用同样的参数重算，结果应完全一致（小写十六进制）" } }
```

> 这个接口本身也需要验签 —— 它不是公开服务。

---

## 3. 推送院内地点

`POST /api/his/places`

### 3.1 请求体

```json
{
  "batchId": "20261116-001",
  "hospitalCode": "Z2-JFL",
  "places": [
    {
      "placeType": "REGISTER",
      "name": "门诊一站式综合服务中心",
      "building": "10号楼（名医馆）",
      "floor": "1F",
      "directions": "10号楼1楼，任一窗口可办理挂号收费、医保审核、检查预约。",
      "openHours": "周一至周日 7:00-17:00",
      "estMinutes": 15,
      "sortOrder": 10
    }
  ]
}
```

### 3.2 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `batchId` | ✅ | 批次号，用于**幂等**。同一 batchId 重复推送只处理一次 |
| `hospitalCode` | ⬜ | 仅用于核对。**实际写入的院区取自你们的凭据** |
| `places[].placeType` | ✅ | 见下方枚举 |
| `places[].name` | ✅ | 展示名 |
| `places[].department` | ⬜ | 科室。为空表示与科室无关（如药房） |
| `places[].building` / `floor` | ⬜ | 楼栋、楼层 |
| `places[].directions` | ⬜ | **口语化指引**，不是坐标。如「进门直走 30 米，左手边」 |
| `places[].openHours` | ⬜ | 如「周一至周六 7:30-16:00」 |
| `places[].estMinutes` | ⬜ | 处理时长（分钟），用于估算排队与建议出发时间 |
| `places[].sortOrder` | ⬜ | 同阶段内排序，小的先做。默认 100 |

`placeType` 枚举：

| 值 | 阶段 | 说明 |
| --- | --- | --- |
| `REGISTER` | 挂号报到 | 一站式服务中心、挂号窗口 |
| `LAB` | 检验抽血 | 抽血、超声、心电图 |
| `CLINIC` | 看诊 | **必须带 `department`**，否则不会被采用 |
| `EXAM` | 检查 | CT、核磁、X 线、内镜 |
| `CASHIER` | 缴费 | 收费窗口 |
| `REPORT` | 取报告 | 自助报告机 |
| `PHARMACY` | 取药 | 药房 |
| `OTHER` | 其他 | 兜底 |

### 3.3 两条重要语义

**① 整批替换**

每次推送必须是该院区的**完整清单**。我们会清掉旧地点再写入新的。
分批推送会导致前一批被下一批覆盖 —— 如果你们的系统只能分批导出，
请先合并再一次性推送。

**② 空清单会被拒绝**

整批替换语义下，空清单等于「清空该院区所有导航」。
这通常是推送出错而不是本意，所以直接拒绝（400），已有数据不受影响。

### 3.4 响应

```json
{ "code": 0, "message": "ok", "data": {
    "hospitalCode": "Z2-JFL",
    "batchId": "20261116-001",
    "duplicated": false,
    "applied": 8,
    "message": "已替换该院区全部导航地点，共 8 条" } }
```

`duplicated: true` 表示这一批之前已经处理过，本次未重复写入。

---

## 4. 错误码

| HTTP | 含义 | 排查方向 |
| --- | --- | --- |
| 401 | appKey 无效 / 签名错误 / 时间戳超窗 | 用 `/api/his/sign` 自检 |
| 400 | 参数问题（缺 batchId、placeType 非法、空清单） | 看 `message` 的具体说明 |
| 500 | 我方异常 | 联系我方，带上 `batchId` |

错误响应里的 `message` 都写成可执行的说明，例如：

```
地点清单为空。整批替换语义下空清单会清空该院区所有导航，已拒绝。
如确需清空请使用专门的下线接口。
```

---

## 5. 安全边界

| 项 | 说明 |
| --- | --- |
| 凭据隔离 | 一个 appKey 绑定一个院区。**A 医院的凭据无法写入 B 医院的数据**，即使请求体里传了 B 的编码 |
| 防重放 | 时间戳 ±5 分钟 + nonce |
| 防篡改 | body 的 SHA256 参与签名，改一个字节签名即失效 |
| secret 存储 | 我方存的是可还原值（HMAC 必须用原文），靠库访问控制保护。**建议院方定期轮换** |
| 日志 | 我方的日志里不记录 secret，也不记录正确签名 |

---

## 6. 对接检查清单

- [ ] 拿到 appKey / appSecret
- [ ] 用 `/api/his/sign` 验证签名实现是否正确
- [ ] 推送一条测试数据，确认返回 `applied: 1`
- [ ] 打开患者端「我的病历 → 我的预约」，确认能看到「到院怎么走」
- [ ] 确认界面上的 `dataQuality` 已是 `REAL`（官方数据）
- [ ] 用同一 batchId 重推一次，确认返回 `duplicated: true`
- [ ] 约定数据更新频率（建议：地点有变动时推送，无需定时）

---

## 7. 参考实现

`frontend/scripts/his-push-demo.ts` 是一份**可运行的** TypeScript 参考实现，
包含签名计算、推送、幂等验证三步。

```bash
BASE=http://your-host:8080 \
APP_KEY=xxx APP_SECRET=yyy \
npx tsx scripts/his-push-demo.ts
```

直接照抄其中的 `sign()` 函数即可，它与服务端的 `HisSignature.java` 逐字节等价。
