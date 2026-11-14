# 交接文档 · 换机器继续开发

> 更新：2026-11-14 11:50 ｜ 适用：任何一台干净的电脑
>
> **省赛提交截止 2026-11-18**，现在离截止约 4 天。
> 这份文档的目标是：在新机器上 **30 分钟内**跑起来，并且知道下一步做什么。

---

## 一、先跑起来（按顺序做，别跳）

### 1. 必要软件

| 软件 | 版本 | 装法 |
| --- | --- | --- |
| Node.js | **20 LTS 或 22** | <https://nodejs.org> |
| pnpm | **9.x** | `npm i -g pnpm@9.15.0` |
| JDK | **17 或 21** | 见下方说明 |
| Maven | **3.9.x** | 见下方说明 |
| Git | 任意较新版 | <https://git-scm.com> |

**JDK 和 Maven 的坑**：Spring Boot 3.2 要求 JDK 17+，本机原来只有 JDK 15，编译会直接失败。
本次开发是在 `D:\tools\jdk17` + `D:\tools\maven` 下临时装的，**这两个目录不在仓库里**，新机器要自己装一次。

下载源（国内快）：

```powershell
# JDK 17（华为云镜像，约 178MB）
curl.exe -L -o "$env:TEMP\jdk17.zip" `
  'https://mirrors.huaweicloud.com/openjdk/17.0.2/openjdk-17.0.2_windows-x64_bin.zip'
Expand-Archive "$env:TEMP\jdk17.zip" -DestinationPath "D:\tools\jdk17" -Force

# Maven 3.9.9
curl.exe -L -o "$env:TEMP\mvn.zip" `
  'https://mirrors.huaweicloud.com/apache/maven/maven-3/3.9.9/binaries/apache-maven-3.9.9-bin.zip'
Expand-Archive "$env:TEMP\mvn.zip" -DestinationPath "D:\tools\maven" -Force
```

装完解压后**目录会多一层**（如 `D:\tools\maven\apache-maven-3.9.9`），需要把里面的 `bin` 提到 `D:\tools\maven\bin`，否则下面的命令路径对不上。

### 2. 前端（这是比赛的主战场）

```powershell
cd frontend
pnpm install
pnpm dev          # http://localhost:5173
```

`pnpm dev` 会同时起 Vite 和 Node BFF（通过 `configureServer` 挂在同一个端口，没有跨域问题）。
打开页面后能看到问诊界面、4 张起始卡片、右上角「我的病历」，就说明对了。

**没有 `LLM_API_KEY` 也能跑**：`planViaLlm` 检测不到 key 会自动退回规则路由，
所以红线拦截、追问、分诊、检索这四条路径全都能演示。评委现场没网也不影响。

要接真模型，复制 `frontend/.env.example` 为 `frontend/.env`，填 `LLM_API_KEY`。

### 3. 后端（课设交付物）

```powershell
cd backend
$env:JAVA_HOME = "D:\tools\jdk17"          # 换成你的 JDK 路径
D:\tools\maven\bin\mvn.cmd spring-boot:run
```

启动后 <http://localhost:8080> 有 H2 控制台（`/h2-console`，JDBC URL 见 `application.yml`）。
**不需要装 MySQL**——省赛用 H2 内存库，建表和种子数据在启动时自动执行。

> 注意：后端接口层已于 2026-11-14 补齐，`/api/**` 不再是 404。
> 演示账号 **demo / demo1234**，完整接口见 §三。

---

## 二、当前进度（真实状态，别被文档里的叙述骗）

### 已完成并有测试

```text
frontend/
  server/
    agents/
      supervisor.ts      路由决策（LLM + 规则双路径）
      triage.ts          分诊：槽位采集、追问上限 3 轮、置信度分级
      reviewer.ts        四维自评 + 安全规则表 + 熔断
      retrieval.ts       RAG：检索 → 充分性判定 → 改写重试 → 接地检查
      rules/red-flag.ts  五条红线规则（绕过 LLM，确定性短路）
      safe-run.ts        超时/异常兜底，永不抛出
    rag/
      kb.ts              10 条示例知识库
      search.ts          BM25 + bigram 中文切分
    render/registry.tsx  6 类卡片的服务端渲染
    routes/chat.ts       SSE 主入口，串起整条链路
    routes/health.ts     健康检查（含 llmConfigured 标志）
  src/
    lib/privacy/redact.ts   端侧脱敏（7 类 PII）
    lib/utils.ts            cn()：shadcn 组件依赖，2026-11-14 补齐
    hooks/useEventStream.ts 手写 SSE 消费
backend/
  entity/ 6 个实体  mapper/ 6 个 Mapper
  adapter/ HospitalAdapter 接口 + Mock 实现 + Registry（按 hospitalCode 分发）
  service/  Auth / Patient / Booking / Reminder / ReminderEngine / Hospital
  controller/ Auth / Patient / Booking / Reminder / Health 五组接口
  security/ JWT 签发校验 + 过滤器 + CurrentUser
  common/ 统一响应体 + 全局异常处理（按 code 段位映射 HTTP 状态）
```

**测试**：
- 前端 `cd frontend; pnpm exec vitest run` → **243 用例**
- 后端 `cd backend; mvn test` → **28 用例**（17 接口集成 + 11 提醒引擎）

### 实测通过的链路

**前端**（`POST /api/chat`，SSE，四条都已经在浏览器里点过）：

```text
「我爸突然胸口疼得厉害，还出冷汗」
  → emergency（红卡）→ speech → done      ← 关键：没有 plan 事件

「最近老是头晕」
  → plan → clarify（追问时长）→ done

「肚子疼三天了，是胀痛」
  → plan → department_card(消化内科) → token → review_trace(通过) → caveat → done

「我头疼，建议吃点布洛芬吗」
  → plan → clarify → done
```

**后端**（`curl` 实测，演示账号 demo/demo1234）：

```text
POST /api/auth/login            → 200 + token
GET  /api/patient/records       → 200，3 条跨院记录，byHospital 分 MOCK-A / MOCK-B
GET  /api/bookings/slots?hospitalCode=MOCK-B&department=内分泌科&date=...
                                → 200，4 个号源（MOCK-A 只有 2 个 —— 换院区有号）
POST /api/bookings              → 200，院方成功才落库
POST /api/bookings/1/complete   → 409（CREATED 不能直接变 COMPLETED）
POST /api/reminders/scan        → {"created":1}，再点一次 {"created":0}（幂等）
```

**提醒引擎**（`@Scheduled` 每 5 分钟，实测日志）：

```text
[提醒引擎] userId=1 生成提醒「明天在演示市第一人民医院（示例）空腹抽血，今晚 22 点后禁食」，
           原因：距「内分泌科」就诊还有 20 小时，且该科室的检查需要空腹
```

---

## 二·五、能力边界（2026-11-14 按代码核对，不是按文档）

> 这一节回答一个评委必问、也最容易被自己骗的问题：**到底哪些是真的能用？**
> 判据只有一条：**能在浏览器里点出来 / 能 curl 出来**。设计文档里写了但代码没有的，一律算"没做"。

### 已实现（可当场演示）

| 能力 | 实际证据 | 完整度 |
| --- | --- | --- |
| 红线急症拦截 | 5 类急症正则，命中即短路、不经 LLM；25 条用例 | ✅ 完整 |
| AI 分诊 | 真实模型；槽位采集、追问≤3 轮、科室+理由+置信度 | ✅ 完整 |
| 多轮记忆 | 会话状态闭环（done 回传 → 前端 ref → 下轮带回），7 场景 19 断言全过 | ✅ 完整 |
| 循证检索 | BM25 + bigram + 接地检查 + 引用卡 | ✅ 可用（语料仅 10 条） |
| 四维自审 | 安全/准确/完整/依据；低分 retry；连续 3 次熔断 | ✅ 完整 |
| 端侧脱敏 | 7 类 PII 规则 + ONNX NER（129MB，浏览器内跑） | ✅ 完整 |
| 语音输入 | Web Speech；识别结果进输入框，**不自动发送** | ✅ 完整 |
| 语音播报 | speechSynthesis，可点朗读 | ✅ 完整 |
| 生成式 UI | 6 类服务端 renderToString 卡片 | ✅ 完整 |
| 后端接口 | 5 组 REST + JWT + 适配器注册表；17 集成用例 | ✅ 完整 |
| 提醒引擎 | 3 条可解释规则 + dedupe 幂等 + `@Scheduled` | ✅ 完整 |

**测试总量**：前端 274 + 后端 28 = **302 用例**。
**端到端验证**：`pnpm verify:llm`（模型四关）+ `pnpm e2e:multiturn`（七场景）。

### 未实现 —— 第一类：有占位，用户会看到"未开放"

| 功能 | 代码里的实际状态 | 用户看到什么 |
| --- | --- | --- |
| ~~号源查询与预约~~ | ✅ **2026-11-15 已实现**（`agents/scheduler.ts`） | 预览卡 + 确认按钮，下单写库 |
| ~~就诊时间轴~~ | ✅ **2026-11-15 已实现** | 挂号后自动给四步时间线 |
| ~~预约预览卡~~ | ✅ **2026-11-15 已实现** | 首个有真实副作用的客户端卡片 |
| ~~病历上传~~ | ✅ **2026-11-15 已实现**（纯文本） | 原文存 IndexedDB + 本地脱敏 + 只发摘要。PDF/图片仍不支持 |

### 未实现 —— 第二类：连占位都没有

| 缺失 | 影响 | 说明 |
| --- | --- | --- |
| ~~前端不调后端~~ | ✅ **2026-11-15 已打通** | `server/routes/backend-proxy.ts` + `src/lib/api.ts`；病历页真读跨院记录与提醒，标记完成写回数据库 |
| ~~用药冲突提示~~ | ✅ **2026-11-15 已打通** | 根因不是"函数没接"，是 `currentMedications` 永远为空：`patient_profile` 没有用药字段、前端从不传 facts。补了 `medication_json` 列 + `usePatientFacts` 后实测触发 |
| ~~跨院重复检查提示~~ | ✅ **2026-11-15 已打通** | `src/lib/exam/duplicate.ts`：7 项检查词典 + 时效窗口（糖化 90 天/血糖 30 天…）+ 必须跨院。17 用例，实测种子数据触发 |
| ~~MCP 工具层~~ | ✅ **2026-11-15 已实现封装层** | `agents/tools/mcp-hospital.ts`：`list_slots` / `hold_slot` / `list_hospitals`，签名对齐 MCP schema。**按 docs/10 D3 不做真握手** |
| 向量检索 | RAG 6% 只到 BM25 | 无 pgvector，无 RRF 融合 |
| 图像 / OCR 输入 | 多模态少一个模态 | 无入口 |

### ✅ 前后端已打通（2026-11-15）

后端有完整的预约、提醒、病历接口，但**前端一行都没调用**。这意味着：

- 5173 上看到的提醒、病历、预约，全部来自 AI 对话，**不是来自数据库**
- README §2 承诺的三个差异化里，「跨院统一时间轴」与「跨院用药冲突」都依赖后端数据，**在演示里看不到**

不接后端，项目在评委眼里就是一个"AI 聊天机器人"；接上之后才看得出"跨院健康管理"这个定位。

### 三段式 vs 实际交付

README §1.3 说「去之前 / 在院内 / 回家后」三段都做：

| 段落 | README 承诺 | 实际状态 |
| --- | --- | --- |
| 去之前 | 预问诊 + 科室推荐 + 就诊准备清单 | ✅ 有，但"准备清单"是文本不是结构化卡片 |
| 在院内 | 号源查询、队列、检查顺序 | ❌ 只有一句"正在接入中" |
| 回家后 | 复查提醒、指标解释、跨院冲突 | ⚠️ 后端提醒引擎有，**前端没接** |

答辩时如果被问"三段都做了吗"，**如实说前两段做完了、第三段只做了后端**，比被追问出来强。

### 按投入产出排的补齐顺序

| 优先 | 事项 | 成本 | 收益 |
| --- | --- | --- | --- |
| ~~1~~ | ~~前端接后端~~ | ✅ 2026-11-15 完成 | 跨院时间轴与提醒已可见 |
| ~~2~~ | ~~用药冲突接进主链路~~ | ✅ 2026-11-15 完成 | 第二个差异化已可见 |
| 3 | 排程最小闭环：`schedule` 分支调后端 `/api/bookings` | 半天 | 补齐"在院内"（**最后一个补齐项**） |
| ~~4~~ | ~~跨院重复检查提示~~ | ✅ 2026-11-15 完成 | 第三个差异化已可见 |

---

## 三、下一步做什么（按优先级，不是按顺序）

> **2026-11-14 状态更新**：原 P0 两项（后端接口层、提醒引擎）已经做完并推送。
> 下面换成现在真正剩下的活。
>
> **先看 §二·五「能力边界」** —— 那一节按代码逐项核对了"什么能用、什么不能用"。
> 本节的 P1/P2 已全部关闭，**真正剩下的都在 §二·五 的补齐顺序表里**
> （第一条是"前端接后端"，半天，收益最大）。

### ✅ 已完成（本轮，2026-11-14）

| 节点 | 内容 | 提交 |
| --- | --- | --- |
| 后端接口层 | 五组接口 + JWT + 适配器注册表 + 17 条集成测试 | `0a7ba72` |
| 提醒引擎 | 三条可解释规则 + dedupe 幂等 + 11 条测试 | `72e6d35` |
| 集成修复 | BFF 挂载 404、卡片样式全丢、输入区压页脚、shadcn 配置 | `7c42bef` |
| 文档校订 | 按代码现状改写 README/HANDOFF/docs 04·12，清掉"已规划"冒充"已完成" | `b591f36` |
| 真实 LLM | `server/llm/client.ts` + 三个 Agent 注入点 + 12 条降级测试 | `eb88258` |
| 语音输入 | Web Speech + 15 条降级测试，输入三模态第一模态落地 | `63c409e` |
| .env 修复 | Vite 不给 Node 注入变量 → server/env.ts + health 加 envSource | `4a70a09` |
| LLM 自检 | pnpm verify:llm 四关，区分未配置/网络/鉴权/schema | `4a70a09` |
| TTS 输出 | speechSynthesis + 文本清理 + 16 条测试 | `cb56fba` |

### ✅ P0 · 真实 Key 已跑通（2026-11-14 关闭）

**实测记录**（用一个 OpenAI 兼容网关 + `deepseek-v4.1-flash` 完成；具体地址与 Key 不入库）：

```
$ pnpm verify:llm
✔ 第 1 关 配置：openai / deepseek-v4.1-flash
✔ 第 2 关 连通性：2595ms，模型回「收到」
✔ 第 3 关 结构化输出：decision=triage，agents=[triage]
   reason（模型原话）：用户在描述症状并给出部位和时长，属于症状叙述而非知识提问，交给分诊继续问清。
✔ 第 4 关 红线短路：命中 chest_pain（不经过模型，确定性规则）
全部通过。当前模式：真实大模型。
```

三个 Agent 都确认走了模型，不是规则兜底：

| Agent | 证据 |
| --- | --- |
| Supervisor | `plan.reason` 是自然语言「这是症状描述，有部位和时长，属于分诊范围…」，不是固定文案「识别到症状描述，交由分诊采集槽位」 |
| Triage | 科室理由带推理：`神经内科 62% · 后脑勺胀痛三天，属于头痛，先查神经系统常见原因`、`骨科 40% · 低头时更明显，提示可能与颈椎姿势有关` |
| Reviewer | 全链路 `review_trace` 正常产出四维分数 |

**端到端耗时**：8545ms（分诊链路，含 Supervisor + Triage + Reviewer 三次模型调用）。

**遗留的性能注意**：一次对话要串 3 次模型调用，8.5s 对答辩演示偏慢。
如果现场网络更差，可能到 15s+。压缩办法（按性价比）：
1. Reviewer 的 judge 在证据充分时可以跳过（当前主要就它在拖时间）
2. Triage 与 Supervisor 合并成一次调用（Supervisor 顺带抽槽位）
3. 用流式输出让用户先看到 `plan`，感知延迟降一半

**配置注意**：这个网关是 OpenAI 兼容协议，所以要设
`LLM_PROVIDER=openai` + `LLM_BASE_URL=<你的网关>/v1`，
provider 填 `deepseek` 会拼成官方地址从而失败。

### P1 · 端侧 ONNX 脱敏（唯一剩下的"空壳"）

> TTS 已于 `cb56fba` 完成（speechSynthesis，二十行核心代码）——原建议"先做 TTS"已兑现。

| 位置 | 现状 | 要做 |
| --- | --- | --- |
| ~~`redact.ts` 的 `detectWithModel()`~~ | ✅ **已完成并在浏览器实测通过**。`ner.ts`（模型层）+ `merge.ts`（合并层，13 条测试）+ `server/routes/models.ts`（模型代理）。实测：`Mr. Zhang San went to the hospital.` → `Mr.［患者姓名］went to the hospital.`，标签「姓名」，模型状态「已就绪」 |
| ~~`speech` 事件的播放~~ | ~~只显示文字~~ | ✅ `cb56fba` 已完成 |

**取舍建议**：如果只剩半天，做 **TTS**。`window.speechSynthesis` 是浏览器内置，
二十行代码就能让"AI 念给你听"这件事成真，演示效果好过几 MB 的 ONNX 权重。

### P2 · 文档收尾

- ~~`docs/02` 缺 OpenMed 说明和小模型对比表~~ ⬜→✅ 实查发现 L93-114 已有完整内容（50 类 PII / WebGPU / 小模型三方案对比表），此条是过期记录
- ~~`.archify/zhidao-v2.html` 旧版~~ ✅ 2026-11-14 重绘为 v3（`.archify/architecture-zhidao-v3-20261114-122500/`），finalize 四关全过
- ~~`docs/12` §3.5「视觉基调未定」过时~~ ✅ 2026-11-14 已在 §3.5 标注已解决

### 明确不做（不要临时加回来）

- 管理后台、权限矩阵、菜单树
- 报表导出 / Excel 打印
- Redis、消息队列（docs/10 D6 已决定省赛不用）
- 真实医院对接（只有 Mock，答辩时如实说）
- 视频模态（`docs/08` 已写明理由）

---

## 四、绝对不要碰的地方

这几条踩了会推翻已有工作，改动前先读对应文档：

| 不能改 | 为什么 | 看哪 |
| --- | --- | --- |
| 把脱敏挪到服务端 | 挪过去就意味着原文已经离开设备，整个隐私架构垮掉 | `docs/08` §1 |
| 让 Spring Boot 调 LLM | AI 编排两份实现必然分叉 | `docs/04` §1、`docs/10` D1 |
| 给 `patient_profile` 加真名/身份证/手机号 | 泄露面从"设备丢失"扩大到"数据库被拖" | `docs/09` 三条硬约束 |
| 用 `interface extends AgentEvent` | `AgentEvent` 是可辨识联合，只能 `type X = A & B` | `src/types/events.ts` |
| 把 `RedactionPreview` 简化成渲染 `safeText` | 它必须按 `hits` 的 start/end 重新切原文，否则位置错位 | `src/components/RedactionPreview.tsx` |

---

## 五、环境相关的坑（都是实际踩过的）

**PowerShell**

```powershell
# 中文乱码：每个新会话先执行
[Console]::OutputEncoding=[Text.Encoding]::UTF8

# 变量后面跟冒号会被当成盘符，要加花括号
Write-Host "${label}: ${text}"     # 不能写 "$label: $text"
```

**写文件不能带 BOM**
`Out-File -Encoding utf8` 会写 BOM，Java 编译器会报「非法字符 '\ufeff'」，
git commit message 里带 BOM 会让提交记录显示异常。用：

```powershell
$enc = New-Object System.Text.UTF8Encoding $false
[IO.File]::WriteAllText($path, $content, $enc)
```

**起后端**

```powershell
# 不能直接把 -D 参数传给 mvn.cmd，PowerShell 会拆开
$env:MAVEN_OPTS = "-Dfile.encoding=UTF-8"
Start-Process -FilePath "D:\tools\maven\bin\mvn.cmd" -ArgumentList "-B","spring-boot:run" `
  -WorkingDirectory $PWD -RedirectStandardOutput boot.log -RedirectStandardError boot.err -NoNewWindow
```

**中文 Windows 的编码地狱（2026-11-14 新踩，代价两小时）**

`Charset.defaultCharset()` 在中文 Windows 上是 **GBK**。这会咬三处：

| 环节 | 症状 | 修法 |
| --- | --- | --- |
| `maven-resources-plugin` 拷 `data.sql` | 中文全变乱码，**编译不报错** | `pom.xml` 设 `<project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>` |
| `maven-compiler-plugin` 编译源码 | 中文字面量变 `?`，**同样不报错** | 同上，同一条属性 |
| fork 出的 JVM（test / spring-boot:run） | 读 UTF-8 文件二次损坏 | surefire `<argLine>-Dfile.encoding=UTF-8</argLine>` + spring-boot 插件 `<jvmArguments>-Dfile.encoding=UTF-8</jvmArguments>` |

**四处都要设，缺一处就有一处中文是坏的**，而且没有任何报错。
诊断方法：写一段小 Java 程序打印 `Charset.defaultCharset()` 和读出来的字符串内容。

**Vite 插件里给 BFF 注册中间件必须同步**

`configureServer` 里用 `void import(...).then(m => server.middlewares.use(...))` 会
把中间件排到 Vite 自己的 SPA fallback 之后，**所有 `/api/*` 都返回 index.html**，
HTTP 状态还是 200，前端 `JSON.parse` 失败却看不到任何错误。
用 `async configureServer` + `await import(...)` 然后在同一函数体内同步 `use()`。

**验证命令**

```powershell
cd frontend
pnpm exec tsc -b --noEmit                                  # 类型
pnpm exec vitest run                                       # 243 用例
pnpm exec vite build                                       # 生产构建

cd ../backend
$env:JAVA_HOME = "D:\tools\jdk17"
D:\tools\maven\bin\mvn.cmd -q -B compile -DskipTests       # 编译
D:\tools\maven\bin\mvn.cmd -B test                          # 28 用例
```

---

## 六、提交规矩

**每完成一个节点就推一次 GitHub**，不要攒成大提交 —— 比赛有「Git 历史必须真实」的硬要求，
一次性堆几百个文件反而像最后一天赶出来的。

```powershell
git add -A
git commit -m "feat(xxx): 一句话说清做了什么"
git push origin master
```

提交信息要**如实**：做了一半就说做了一半，占了位就说明是占位。
历史里现在有 19 个提交，每个都能对应到一件具体的事，保持这个粒度。

**远程仓库**：`git@github.com:dessert28/zhidao.git`（SSH），分支 `master`。
新机器要先把 SSH key 配好，或者改成 HTTPS + token。

**不要提交**：`node_modules/`、`target/`、`.env`、`*.log`、临时调试脚本（`check*.ts`）。
`.gitignore` 已经覆盖，但用 `git add -A` 前还是扫一眼 `git status`。

---

## 七、时间线

| 日期 | 事项 |
| --- | --- |
| **2026-11-18** | 省赛提交截止（还剩 4 天） |
| 2027-01 上旬 | 评审反馈 |
| 2026-12-10 ~ 12-21 | 国赛报名 |
| 2026-12-27 | 国赛提交 |

省赛这 4 天的取舍：**用真 Key 验证一遍 > TTS > 端侧 ONNX > 文档收尾**。
第一项决定「大模型集成质量 8%」这一档拿不拿得到，
第二项决定演示视频有没有一个让人记住的镜头，第三项只影响印象分。

---

## 八、判断"我做的对不对"的三个问题

改完一段代码，问自己：

1. **删掉这段，用户能感觉到吗？** 感觉不到就是过度设计。
2. **这段代码失败的时候，用户看到的是什么？** 如果答案是「白屏」或者「500」，
   说明降级没做。整条链路上每个 Agent 都有 `safeRun` 兜底，新写的也要有。
3. **这段能不能被截图放进答辩 PPT？** 能，就值得做；不能，就先放着。

---

## 附：快速定位

```text
docs/README.md          文档索引 + 里程碑进度
docs/05-Agent契约表.md  所有 Agent 的输入输出契约（改 Agent 前必读）
docs/09-数据模型.md     三张核心表 + 三条硬约束
docs/10-技术决策.md     D1-D8 八个决策及理由（答辩会被问）
docs/12-赛题符合性审计.md 自评 82-85 分，以及已知的薄弱点
README.md               给评委看的 10 分钟阅读路径
```
