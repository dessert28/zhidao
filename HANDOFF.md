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
- 前端 `cd frontend; pnpm exec vitest run` → **222 用例**
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

## 三、下一步做什么（按优先级，不是按顺序）

> **2026-11-14 状态更新**：原 P0 两项（后端接口层、提醒引擎）已经做完并推送。
> 下面换成现在真正剩下的活。

### ✅ 已完成（本轮，2026-11-14）

| 节点 | 内容 | 提交 |
| --- | --- | --- |
| 后端接口层 | 五组接口 + JWT + 适配器注册表 + 17 条集成测试 | `0a7ba72` |
| 提醒引擎 | 三条可解释规则 + dedupe 幂等 + 11 条测试 | `72e6d35` |
| 集成修复 | BFF 挂载 404、卡片样式全丢、输入区压页脚、shadcn 配置 | `7c42bef` |
| 文档校订 | 按代码现状改写 README/HANDOFF/docs 04·12，清掉"已规划"冒充"已完成" | `b591f36` |
| 真实 LLM | `server/llm/client.ts` + 三个 Agent 注入点 + 12 条降级测试 | `eb88258` |
| 语音输入 | Web Speech + 15 条降级测试，输入三模态第一模态落地 | `63c409e` |

### P0 · 用真实 Key 跑通一次（唯一没验证的事）

代码路径已经通了，但**没有用真实 API Key 端到端验证过** —— 开发机在沙箱里，
没有外网 Key。所以现在只能保证"降级路径正确"，不能保证"模型输出被正确解析"。

要做：

1. `cd frontend && cp .env.example .env`，填 `LLM_API_KEY`
2. `pnpm dev`，打开 `http://localhost:5173/api/health` 确认 `"mode":"llm"`
3. 发一句「肚子疼三天了，是胀痛」，看 `plan.reason` 是不是模型写的
   （规则路由的文案是固定的「识别到症状描述，交由分诊采集槽位」）
4. **重点看 triage 的科室名**：模型可能返回"消化内科"以外的写法，
   现有 `summarizeTriage` 只是拼接，不做校验。如果出现奇怪科室名，
   在 `llm-impl.ts` 的 TriageSchema 里收紧约束，而不是改 UI

**已知风险**：`generateObject` 依赖模型支持 JSON schema。
DeepSeek / Qwen / Moonshot 的 OpenAI 兼容层都支持，但**小参数模型可能返回不合 schema 的 JSON**，
届时会走 `askObject` 的 catch → 返回 null → 规则兜底（这是正确行为，不会崩）。

### P1 · 端侧 ONNX 脱敏（唯一剩下的"空壳"）

| 位置 | 现状 | 要做 |
| --- | --- | --- |
| `redact.ts` 的 `detectWithModel()` | 直接 `return null` | 接 Transformers.js + WebGPU，补自由叙述里的姓名与罕见地名 |
| `speech` 事件的播放 | 只显示「已生成语音播报」 | 真 TTS（`speechSynthesis` 即可，成本很低） |

**取舍建议**：如果只剩半天，做 **TTS**。`window.speechSynthesis` 是浏览器内置，
二十行代码就能让"AI 念给你听"这件事成真，演示效果好过几 MB 的 ONNX 权重。

### P2 · 文档收尾

- `docs/02` 缺 OpenMed 说明和小模型对比表 ⬜
- `.archify/zhidao-v2.html` 仍是旧版（还画着 Next.js），要重跑 finalize ⬜
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
pnpm exec vitest run                                       # 222 用例
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
