-- ============================================================
-- 院方调阅 —— 就诊即授权，窗口期内自动生效
--
-- ============ 这套设计要解决的核心矛盾 ============
--
-- 患者去医院就诊，本身就代表授权医生查看相关病历；
-- 再让他掏手机点一次「同意」，是把系统责任推给用户，
-- 老年患者根本操作不了。
--
-- 所以授权门槛不设在患者端，而设在**院方请求**这一侧：
--   · 必须来自已认证的院区 appKey
--   · 必须能对上一位真实存在的患者
--   · 必须落在一个合法的就诊时间窗内
--   · 每次访问都留痕，患者事后可查
--
-- ============ 为什么不用 visitId ============
--
-- 最严谨的做法是让 HIS 传真实就诊流水号，我方反查确认。
-- 但那要求 HIS 额外改造，而多数医院的挂号号与病案号并不互通，
-- 落地成本高。改用的方案是：HIS 传「患者在我方的标识 + 就诊日期」，
-- 我方按 30 天窗口自行判定。
--
-- 代价必须说清：这等于把「这是不是一次真实就诊」的判定，
-- 部分让渡给了院方的诚信。缓解手段是院区 appKey 隔离 + 全量审计 ——
-- 某个院区若出现异常调阅量，日志上一眼能看出来。
-- ============================================================

-- 患者与院方的绑定关系。
-- 医院系统里没有我们这儿的用户ID，必须有一个双方都认的标识。
-- 这里用「患者授权时由我方生成的一次性匹配码」：
--   患者在App里生成匹配码 → 挂号/就诊时报给窗口 → 院方录入 HIS →
--   HIS 后续调阅时带上这个码。
-- 不用医保号/身份证：那需要额外资质，且一旦泄露无法更换；
-- 匹配码可随时作废重发。
CREATE TABLE IF NOT EXISTS patient_binding (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id       BIGINT       NOT NULL COMMENT '我方患者ID',
  hospital_code VARCHAR(32)  NOT NULL COMMENT '绑定到哪个院区',
  match_code    VARCHAR(32)  NOT NULL COMMENT '院方调阅时携带的匹配码',
  enabled       TINYINT      NOT NULL DEFAULT 1,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted       TINYINT      NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_binding_code ON patient_binding (match_code);
CREATE INDEX IF NOT EXISTS idx_binding_hospital ON patient_binding (hospital_code, user_id);

-- 调阅授权设置：患者可关闭自动授权
CREATE TABLE IF NOT EXISTS access_preference (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id       BIGINT       NOT NULL,
  /**
   * 是否允许就诊期间自动授权院方调阅。
   * 默认 TRUE —— 诊疗必需，且是行业惯例；
   * 患者可以关掉，关掉后 HIS 调阅会收到 403 并提示需要患者确认。
   */
  auto_grant    TINYINT      NOT NULL DEFAULT 1,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_access_pref_user ON access_preference (user_id);

-- ============================================================
-- 调阅审计 —— 这套设计里最重要的一张表
--
-- 没有它，「就诊即授权」就退化成「院方随便看」。
-- 有了它，每一次访问都是可追溯、可向患者展示的具体事件。
--
-- 记录的信息刻意包含「看了哪几条」而不只是「来查过」：
-- 患者有权知道具体哪些资料被谁看了。
-- ============================================================
CREATE TABLE IF NOT EXISTS access_audit (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id       BIGINT       NOT NULL COMMENT '被查阅的患者',
  hospital_code VARCHAR(32)  NOT NULL COMMENT '哪个院区来查的',
  app_key       VARCHAR(64)  NOT NULL COMMENT '哪套凭据（可区分测试/生产）',
  /** VIEW_REPORT_LIST / VIEW_REPORT_DETAIL / ARCHIVED */
  action        VARCHAR(32)  NOT NULL,
  /** 本次调阅关联的就诊日期，用于窗口判定留痕 */
  visit_date    DATE,
  /** 调阅到的记录ID列表（逗号分隔）。空表示只查了列表没看明细 */
  record_ids    VARCHAR(1000),
  /** 条数，便于快速统计 */
  item_count    INT          NOT NULL DEFAULT 0,
  /** 是否已由院方回执归档 */
  archived      TINYINT      NOT NULL DEFAULT 0,
  client_ip     VARCHAR(64),
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_user_time ON access_audit (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_hospital_time ON access_audit (hospital_code, created_at DESC);
