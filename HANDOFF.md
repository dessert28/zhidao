# 交接文档 · 换机器继续开发

> 更新：2026-11-13 21:55 ｜ 适用：任何一台干净的电脑
>
> **省赛提交截止 2026-11-18**，现在离截止约 5 天。
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

> 注意：后端目前只有骨架（实体 + Mapper + 异常处理 + 适配器），
> **接口层还没写**，所以现在访问任何 `/api/**` 都是 404。这不影响前端演示。

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
  src/
    lib/privacy/redact.ts   端侧脱敏（7 类 PII）
    hooks/useEventStream.ts 手写 SSE 消费
backend/
  entity/ 6 个实体  mapper/ 6 个 Mapper
  adapter/ HospitalAdapter 接口 + Mock 实现
  common/ 统一响应体 + 全局异常处理
```

**测试：195 用例全绿**（`cd frontend; pnpm exec vitest run`）。

### 实测通过的链路

```text
「空腹血糖偏高要注意什么」
  → plan → tool_result(3 篇资料) → token(答案) → review_trace → caveat → done
  引用卡 2092 字节，答案不含无关科室内容
```

```text
「我叫张三，手机13812345678，最近老是头晕」
  → 浏览器内遮蔽为 「我叫［患者姓名］，手机138****5678，最近老是头晕」
  → 服务端只收到遮蔽后的文本 → clarify(追问时长)
```

---

## 三、下一步做什么（按优先级，不是按顺序）

### P0 · 后端接口层（课设必须，比赛加分）

现在 `backend` 有骨架没接口，等于课设交不了。要补：

1. `service/` 三个 Service：`PatientService`、`BookingService`、`ReminderService`
2. `controller/` 对应三个 Controller，返回 `ApiResult<T>`
3. `config/SecurityConfig` + `JwtUtil`：演示账号 `demo / demo1234` 能登录
4. 至少一个 `HospitalAdapter` 的注册表（`Map<String, HospitalAdapter>` 按 `hospitalCode` 分发）

**验收标准**：`curl localhost:8080/api/records` 能返回种子数据里的 3 条跨院记录。

### P0 · 提醒引擎（比赛差异化，README 里已经承诺）

`adapter/` 已经写好，但**没有任何地方调用它**。要补 `ReminderEngine`：

```java
@Scheduled(cron = "${zhidao.reminder.scan-cron}")
public void scan() { ... }
```

规则要可解释 —— `reminder_task.reason` 字段已经在 schema 里留好了：

- 距就诊 24 小时 + 科室有空腹项目 → 「今晚 22 点后禁食」
- 距上次检查满 N 个月 → 「该复查了」
- 预约单 `CREATED` 且距就诊不足 7 天 → 「还没确认」

**验收标准**：启动后日志里出现至少一条带 `reason` 的提醒。

### P1 · 视觉打磨（UI/UX 占 10%，且省赛在即）

`docs/12` §3.5 指出这块没有任何设计输入。要做：

- 定主色和中文正文字体栈，写进 `docs/04` 新增的「视觉基调」一节
- 问诊页、病历页、引用卡三个关键页面画一张布局草稿
- 现在 `components.json` 还缺（shadcn/ui 手动配置没做）

### P2 · 文档收尾

- `docs/07` §5 还写着旧的 `src/lib/agents` 路径，实际已搬到 `server/`
- `docs/02` 缺 OpenMed 说明和小模型对比表
- `.archify/zhidao-v2.html` 仍是旧版（还画着 Next.js），要重跑 finalize

### 明确不做（不要临时加回来）

- 管理后台、权限矩阵、菜单树
- 报表导出 / Excel 打印
- Redis、消息队列（docs/10 D6 已决定省赛不用）
- 真实医院对接（只有 Mock，答辩时如实说）

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

**验证命令**

```powershell
cd frontend
pnpm exec tsc -b --noEmit                                  # 类型
pnpm exec vitest run                                       # 195 用例
pnpm exec vite build                                       # 生产构建

cd ../backend
$env:JAVA_HOME = "D:\tools\jdk17"
D:\tools\maven\bin\mvn.cmd -q -B compile -DskipTests       # 编译
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
历史里现在有 10 个提交，每个都能对应到一件具体的事，保持这个粒度。

**远程仓库**：`git@github.com:dessert28/zhidao.git`（SSH），分支 `master`。
新机器要先把 SSH key 配好，或者改成 HTTPS + token。

**不要提交**：`node_modules/`、`target/`、`.env`、`*.log`、临时调试脚本（`check*.ts`）。
`.gitignore` 已经覆盖，但用 `git add -A` 前还是扫一眼 `git status`。

---

## 七、时间线

| 日期 | 事项 |
| --- | --- |
| **2026-11-18** | 省赛提交截止（还剩 5 天） |
| 2027-01 上旬 | 评审反馈 |
| 2026-12-10 ~ 12-21 | 国赛报名 |
| 2026-12-27 | 国赛提交 |

省赛这 5 天的取舍：**后端接口能跑通 > 提醒引擎有输出 > 视觉打磨 > 文档收尾**。
前两项不做课设交不了，后两项影响的是评委印象分。

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
