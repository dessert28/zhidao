# Agent 契约表

> **这是开发前最关键的一份交接文档。**
> 五个 Agent 的输入输出、工具清单、失败降级策略。定死这些，前后端才能并行开工。

---

## 0. 总体设计

### 0.1 五个角色

| Agent | 定位 | 有无副作用 |
| --- | --- | --- |
| **Supervisor** | 总调度，决定这一轮交给谁 | 无 |
| **Triage** | 分诊，多轮追问 + 科室建议 | 无 |
| **Retrieval** | 循证检索，证据反思循环 | 无 |
| **Scheduler** | 排程办事，查号源 / 排时间线 / 准备预约 | 有（但必须人确认） |
| **Reviewer** | 审查，四维打分 + 拦截 | 无 |

### 0.2 编排拓扑

```
                    ┌──────────────┐
       用户输入 ───▶ │  Supervisor  │ ◀─── 会话事实 / 记忆
                    └──────┬───────┘
                           │ 分发（可并行）
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
     ┌─────────┐     ┌───────────┐    ┌───────────┐
     │ Triage  │     │ Retrieval │    │ Scheduler │
     └────┬────┘     └─────┬─────┘    └─────┬─────┘
          │                │  ▲             │
          │                │  └─自纠循环────┘
          └────────────────┼────────────────┘
                           ▼
                    ┌──────────────┐
                    │   Reviewer   │ ──低分──▶ 回退 / 降级
                    └──────┬───────┘
                           ▼
                    最终答案 + 事件流
```

### 0.3 统一契约

所有 Agent 的输入输出都遵循同一套信封：

```typescript
// 输入信封
interface AgentInput<T> {
  turnId: string;              // 本轮唯一 id
  sessionId: string;           // 会话 id
  userId: string;              // 用户 id（脱敏后）
  payload: T;                  // 各 Agent 专属载荷
  facts: SessionFacts;         // 会话事实：过敏、用药、既往史、当前挂号状态
  memory: MemorySnapshot;      // 三层记忆快照
}

// 输出信封
interface AgentOutput<T> {
  status: 'ok' | 'need_clarify' | 'blocked' | 'failed';
  payload: T;
  confidence: number;          // 0-1
  evidence: EvidenceRef[];     // 溯源引用
  events: AgentEvent[];        // 给前端的事件
  degraded?: DegradeInfo;      // 若降级过，说明原因
}
```

> **设计要点**：`status` 四态是硬约束。任何 Agent 失败都必须走 `failed` 或 `blocked`，**不允许抛异常穿透**——这是"失败降级"能成立的前提。

---

## 1. Supervisor · 总调度

### 1.1 输入

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `userMessage` | string | 用户本轮原始输入（已脱敏） |
| `sessionState` | object | 当前挂起任务（如"预约待确认"） |
| `facts` | SessionFacts | 过敏、用药、既往史、当前挂号状态 |
| `recentTurns` | Turn[] | 最近 6 轮对话 |

### 1.2 输出

```json
{
  "decision": "triage | retrieve | schedule | multi | done",
  "agents": ["triage", "scheduler"],
  "reason": "用户描述胃痛并问能否下午挂号，需先分诊再查号源",
  "requiresClarify": false,
  "missing": []
}
```

| 字段 | 说明 |
| --- | --- |
| `decision` | 单路 / 多路并行 / 直接收尾 |
| `agents` | 要调用的 Agent 列表 |
| `reason` | **必填**，给前端展示"AI 在想什么" |
| `requiresClarify` | 信息不足需追问时为 true |
| `missing` | 缺哪些关键信息 |

### 1.3 工具清单

| 工具 | 用途 | 归属 |
| --- | --- | --- |
| `get_session_state` | 读当前挂起任务 | 本地 |
| `get_user_profile` | 读用户画像与记忆 | 本地 |
| `resume_pending_task` | 恢复被中断的流程 | 本地 |

> Supervisor **不直接调业务工具**，只做调度。业务工具由下游 Agent 调。

### 1.4 失败降级

| 失败场景 | 降级策略 |
| --- | --- |
| LLM 超时（>8s） | 走**规则路由**：含"挂号/预约"→ Scheduler；含症状词 → Triage；含"是什么/为什么"→ Retrieval；兜底 → Triage |
| 输出 JSON 不合法 | 重试 1 次（带错误提示）；再失败直接走规则路由 |
| 多路并行冲突 | 按优先级串行：Triage → Retrieval → Scheduler |
| 完全不可用 | 返回固定话术 + 「转人工/拨打 120」入口，状态标 `blocked` |

---

## 2. Triage Agent · 分诊

### 2.1 输入

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `chiefComplaint` | string | 主诉，可能不完整 |
| `dialogHistory` | Turn[] | 已追问的轮次 |
| `facts` | SessionFacts | **既往史、过敏史、当前用药**（决定分诊，不是可有可无的背景） |

### 2.2 输出

```json
{
  "status": "ok",
  "payload": {
    "departments": [
      { "name": "消化内科", "confidence": 0.86, "reason": "上腹痛+餐后加重，无呕血黑便" }
    ],
    "redFlag": null,
    "collectedSymptoms": {
      "部位": "上腹", "时长": "3天", "诱因": "餐后", "性质": "隐痛", "伴随": "反酸"
    },
    "nextQuestion": null
  },
  "confidence": 0.86,
  "evidence": [],
  "events": [{ "type": "department_card", "data": {...} }]
}
```

| 字段 | 说明 |
| --- | --- |
| `departments` | 推荐科室（1-3 个），每个带理由 |
| `redFlag` | 红线症状，非 null 时**直接短路** |
| `collectedSymptoms` | 已采集的症状槽位 |
| `nextQuestion` | 非 null 表示还需追问（`status: need_clarify`） |

### 2.3 工具清单

| 工具 | 用途 | 归属 |
| --- | --- | --- |
| `symptom_slot_tracker` | 症状槽位进度（缺什么问什么） | 本地 |
| `red_flag_checker` | 红线症状确定性检查 | 本地（规则，非 LLM） |
| `department_matcher` | 症状→科室映射检索 | 本地 RAG |
| `history_crosscheck` | 结合既往史调整（如糖尿病+伤口不愈→内分泌） | 本地 |

### 2.4 特别约束

**红线检查不走 LLM。** 胸痛、卒中（口角歪斜/单侧无力/言语不清）、呼吸困难、意识改变、大出血——用确定性规则表匹配，命中即短路，输出紧急指引。理由：不能赌模型是否配合。

### 2.5 失败降级

| 失败场景 | 降级策略 |
| --- | --- |
| 槽位不足 | 最多追问 **3 轮**；3 轮后按已收集信息给"建议就诊科室"并标注"信息不全" |
| 科室匹配低置信（<0.5） | 给 Top3 候选 + "可先挂全科/导诊台咨询" |
| 患者描述矛盾 | 显式指出矛盾点追问，不强行下结论 |
| LLM 失败 | 走关键词规则表兜底；再失败给"建议咨询分诊台" |
| 红线规则命中 | **不降级**，直接输出紧急指引并终止本轮对话 |

---

## 3. Retrieval Agent · 循证检索

### 3.1 输入

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `query` | string | 待检索问题（可能来自 Supervisor 或子任务拆解） |
| `context` | object | 用户症状上下文（用于改写给检索） |
| `maxRounds` | number | 反思循环上限，默认 2 |

### 3.2 输出

```json
{
  "status": "ok",
  "payload": {
    "answer": "…",
    "sources": [
      { "docId": "guide-001", "title": "居民膳食指南", "snippet": "…", "score": 0.91 }
    ],
    "roundsUsed": 1,
    "refinedQueries": ["…"]
  },
  "confidence": 0.83,
  "evidence": [
    { "type": "doc", "id": "guide-001", "span": [120, 180] }
  ],
  "events": [{ "type": "retrieval_trace", "data": { "roundsUsed": 1 } }]
}
```

### 3.3 工具清单

| 工具 | 用途 | 归属 |
| --- | --- | --- |
| `hybrid_search` | 向量 + BM25 混合检索，RRF 融合 | 本地（pgvector） |
| `rerank` | bge-reranker 重排 Top-20 → Top-5 | 本地 |
| `expand_query` | 同义词/医学别称扩展 | 本地 |
| `grounding_check` | 答案接地检查（每句能否在证据里找到） | 本地 |
| `fetch_doc_detail` | 拉取父块全文（父子分块） | 本地 |
| `search_hospital_kb` | 查某院就诊须知 | **MCP · 院方** |

### 3.4 自纠循环（核心机制）

```
1. 检索（混合 + rerank）
2. 证据充分性评估：
   - 相关文档数 ≥ 2 且最高分 ≥ 0.75 → 充分，进 3
   - 否则 → 改写 query（expand_query）→ 回到 1（roundsUsed + 1）
   - 达到 maxRounds 仍不充分 → 进 3 但标记 low_evidence
3. 生成答案（约束：只能用证据里的内容）
4. 接地检查：
   - 每句话必须能在证据里定位
   - 不通过的句子删掉或改写
   - 仍不通过 → 追加"本回答证据不足，建议咨询医生"
```

### 3.5 失败降级

| 失败场景 | 降级策略 |
| --- | --- |
| 证据不足（达到轮次上限） | 输出通用健康信息 + **显式标注"知识库证据不足"**，不要装作确定 |
| 接地检查失败 | 删掉无依据句子，只保留有证据的部分 |
| 向量库不可用 | 降级纯 BM25 关键词检索 |
| 全部检索失败 | 返回"暂时无法查询，请咨询医生"+ 可点击人工入口 |
| 检索到矛盾证据 | 并列呈现两个说法，标注出处，不下结论 |

---

## 4. Scheduler Agent · 排程办事

### 4.1 输入

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `intent` | string | 预约 / 改约 / 取消 / 查排队 / 排时间线 |
| `params` | object | 科室、医生、日期、检查项等 |
| `facts` | SessionFacts | 当前挂号状态、已做检查、过敏 |

### 4.2 输出

```json
{
  "status": "ok",
  "payload": {
    "action": "preview_booking",
    "preview": {
      "preorderId": "po_20261113_001",
      "hospital": "市一院",
      "department": "消化内科",
      "doctor": "张医生",
      "slot": "2026-11-15 14:00-14:30",
      "holdExpiresAt": "2026-11-13T09:10:00Z"
    },
    "timeline": [
      { "order": 1, "task": "空腹抽血", "dependsOn": [], "note": "前一晚 22 点后禁食" },
      { "order": 2, "task": "腹部CT", "dependsOn": ["空腹抽血"], "note": "需空腹" },
      { "order": 3, "task": "心电", "dependsOn": [], "note": "可与 CT 并行" }
    ]
  },
  "confidence": 0.9,
  "evidence": [{ "type": "order", "id": "ord_123", "span": [0, 40] }],
  "events": [{ "type": "booking_preview_card", "data": {...} }]
}
```

### 4.3 工具清单

| 工具 | 用途 | 归属 |
| --- | --- | --- |
| `list_departments` | 查科室 | **MCP · 院方** |
| `list_doctors` | 查医生与排班 | **MCP · 院方** |
| `list_slots` | 查号源 | **MCP · 院方** |
| `hold_slot` | 锁号（TTL 10 分钟） | **MCP · 院方** |
| `release_hold` | 释放锁号 | **MCP · 院方** |
| `create_preorder` | 生成 PENDING 预订单 | 本地 |
| `confirm_booking` | 用户确认后落库（幂等） | 本地 |
| `get_queue_status` | 查排队状态 | **MCP · 院方** |
| `build_timeline` | 医嘱拆任务 + 依赖排序 | 本地 |
| `check_duplicate_exam` | 跨院重复检查检测 | 本地 |
| `check_drug_conflict` | 跨院用药冲突提示 | 本地 |

### 4.4 副作用铁律

**Agent 绝不自己执行不可逆操作。**

```
查询类（list_* / get_* / check_*）→ 直接调
写入类（hold_slot / confirm_booking）→ 先生成预览，等用户点按钮
```

用户点确认时发的是**结构化动作**（带 `preorderId`），不是自然语言。后端按 `preorderId` 相等校验，DB 唯一索引保证幂等——重复点不会产生两条记录。

### 4.5 失败降级

| 失败场景 | 降级策略 |
| --- | --- |
| 号源查询超时（>5s） | 重试 1 次；再失败提示"号源查询超时，请稍后重试"，**不猜号源** |
| 锁号失败 | 明确告知"该号已被抢先锁定"，刷新列表让用户重选 |
| 某院 MCP 熔断 | 该院置为不可用，提示"该院服务暂时不可用"，其他院正常 |
| 时间线冲突（如两个检查要求同一天） | 显式指出冲突并建议拆分日期，不擅自合并 |
| 跨院数据缺失 | 跳过该项检测，标注"未获取到该院数据" |
| LLM 规划失败 | 退回预设模板：按"空腹 → 影像 → 抽血 → 心电"固定顺序生成 |

---

## 5. Reviewer Agent · 审查

### 5.1 输入

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `candidateAnswer` | object | 上游 Agent 的产出 |
| `evidence` | EvidenceRef[] | 候选答案引用的证据 |
| `facts` | SessionFacts | 过敏、用药（用于交叉检查） |
| `thresholds` | object | 各维阈值，默认 0.6 |

### 5.2 输出

```json
{
  "status": "ok" | "blocked",
  "payload": {
    "scores": { "safety": 0.9, "accuracy": 0.8, "completeness": 0.7, "groundedness": 0.85 },
    "overall": 0.81,
    "issues": [
      { "type": "ungrounded", "detail": "第三句无证据支撑", "action": "removed" }
    ],
    "caveat": null
  },
  "confidence": 1.0,
  "evidence": [],
  "events": [{ "type": "review_trace", "data": {...} }]
}
```

### 5.3 四个维度

| 维度 | 检查什么 | 不通过的处置 |
| --- | --- | --- |
| **safety** | 有无诊断结论、有无推荐处方、有无停药建议 | **硬拦截**，删改或直接拒绝回答 |
| **accuracy** | 与证据是否一致 | 标注存疑或删除 |
| **completeness** | 用户问题是否都被回答 | 追加"还需补充"提示 |
| **groundedness** | 每句能否溯源 | 删掉无依据句 |

### 5.4 交叉检查（本项目的特色）

| 检查 | 触发 | 输出 |
| --- | --- | --- |
| 过敏冲突 | 答案中提到用户过敏物 | 警示条 + 加粗原过敏记录 |
| 用药冲突 | 多院处方成分重复 | "两院处方含相同成分，请向医生确认" |
| 重复检查 | 近期已做同类检查 | "该检查 3 个月内已做过（XX 医院）" |
| 红线复检 | 答案涉及急症 | 强制追加急诊提示 |

### 5.5 工具清单

| 工具 | 用途 | 归属 |
| --- | --- | --- |
| `judge_answer` | LLM-as-judge 四维打分 | 本地 |
| `allergy_crosscheck` | 过敏交叉检查 | 本地 |
| `drug_conflict_check` | 用药冲突检查 | 本地 |
| `duplicate_exam_check` | 重复检查检测 | 本地 |
| `red_flag_recheck` | 红线复检 | 本地（规则） |

### 5.6 失败降级

| 失败场景 | 降级策略 |
| --- | --- |
| Judge 调用失败 | **跳过自评，但强制追加通用免责声明**（失败要保守，不是放过） |
| 分数与规则冲突 | 规则优先（如 answers 说"建议吃药"→ 无论多高分都拦截） |
| 打分超时 | 用上一次同类型问题的缓存分数，标注"评估可能滞后" |
| 连续 3 次低分 | 系统主动建议"该问题建议咨询医生"，停止自动回答 |

---

## 6. 事件流契约（前端消费）

所有 Agent 的事件统一走 SSE，前端按 `type` 渲染：

| 事件 | 载荷 | 前端表现 |
| --- | --- | --- |
| `plan` | `{decision, reason, agents}` | 显示"AI 正在…"并列出计划 |
| `token` | `string` | 流式打字机 |
| `tool_call` | `{name, args}` | 显示工具调用标签 |
| `tool_result` | `{name, result}` | 折叠展示结果摘要 |
| `clarify` | `{question, missing[]}` | 追问气泡 + 快捷选项 |
| `department_card` | `{departments[]}` | 科室推荐卡片 |
| `booking_preview_card` | `{preorder}` | 预约预览卡片 + 确认/取消按钮 |
| `timeline_card` | `{tasks[]}` | 就诊时间线卡片 |
| `review_trace` | `{scores}` | 可折叠的"质量评估"面板 |
| `caveat` | `string` | 黄色警示条 |
| `emergency` | `{type, guidance}` | 全屏红色紧急提示 |
| `done` | `{answer, sources[]}` | 收尾 |

> 这张表就是前端组件的开发清单，也是"AI 交互体验 3%"的验收标准：**流式、思考可见、错误有兜底**。

---

## 7. 开发分工建议（3 人）

| 角色 | 负责 | 交付物 |
| --- | --- | --- |
| 前端 A | 页面骨架、生成式 UI 组件、事件流消费 | `app/` + `components/chat/` |
| 前端 B | 端侧脱敏、IndexedDB、语音、PWA 提醒 | `lib/privacy/` + `lib/audio/` |
| 后端 | Spring Boot 业务层、提醒引擎、MCP 适配器 | `backend/` |

Agent 编排（LangGraph）由前端 A 主导，后端配合提供工具接口。
