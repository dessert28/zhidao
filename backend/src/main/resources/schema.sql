-- ============================================================
-- 智诊通 · 业务库 schema（H2 语法，兼容 MySQL）
-- 依据：docs/09-数据模型.md
--
-- 三条硬约束（必须守住，答辩会被问）：
--   ① **原文不进 MySQL**。患者上传的病历原文只存在浏览器 IndexedDB。
--      这里的 medical_record 存的是"脱敏后的摘要 + 文件元信息"，
--      没有任何可以直接还原原图的字段。
--   ② 逻辑删除统一用 deleted 字段（MyBatis-Plus global-config 配好）。
--   ③ 跨院数据一律用 hospital_code 而不是外键 —— 院区是外部系统，
--      它的主键不归我们管，用外键会在对方换系统时把我们的库锁死。
-- ============================================================

DROP TABLE IF EXISTS reminder_task;
DROP TABLE IF EXISTS booking_order;
DROP TABLE IF EXISTS medical_record;
DROP TABLE IF EXISTS patient_profile;
DROP TABLE IF EXISTS hospital;
DROP TABLE IF EXISTS sys_user;

-- ---------------- 用户 ----------------
-- 为什么单独一张 sys_user 而不是塞进 patient_profile：
--   认证与业务档案是两件事。密码要能改、能被禁用，
--   业务档案不会因为这个人的密码泄露而需要重建。
CREATE TABLE sys_user (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(64)  NOT NULL,
  password_hash VARCHAR(100) NOT NULL COMMENT 'bcrypt，绝不明文',
  recovery_hash VARCHAR(100)          COMMENT '恢复码，也是 bcrypt',
  role          VARCHAR(20)  NOT NULL DEFAULT 'PATIENT',
  enabled       TINYINT      NOT NULL DEFAULT 1,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted       TINYINT      NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX uk_user_username ON sys_user (username);

-- ---------------- 院区 ----------------
-- hospital_code 是对外唯一标识（如 "MOCK-A"），跨表引用只用它。
CREATE TABLE hospital (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  hospital_code VARCHAR(32)  NOT NULL COMMENT '对外标识，跨表引用用这个',
  name          VARCHAR(128) NOT NULL,
  level         VARCHAR(32)           COMMENT '三甲 / 二甲',
  city          VARCHAR(64),
  -- 适配器类型：MOCK / HL7 / FHIR。省赛只有 MOCK
  adapter_type  VARCHAR(32)  NOT NULL DEFAULT 'MOCK',
  enabled       TINYINT      NOT NULL DEFAULT 1,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted       TINYINT      NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX uk_hospital_code ON hospital (hospital_code);

-- ---------------- 患者档案 ----------------
-- 刻意不存：真名 / 身份证 / 手机号 / 住址。
-- 这些留在浏览器；服务端只需要能区分"这是同一个人"。
CREATE TABLE patient_profile (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id       BIGINT       NOT NULL,
  birth_year    INT                   COMMENT '只存年份，精确到日没有业务价值',
  gender        VARCHAR(10),
  -- 过敏史与慢病用 JSON 存。为什么不用关联表：
  --   这两份数据永远是"整份读取、整份覆盖"，没有按项查询的需求，
  --   拆表只会带来 join 成本。docs/09 已论证过。
  allergy_json  VARCHAR(2000) NOT NULL DEFAULT '[]',
  chronic_json  VARCHAR(2000) NOT NULL DEFAULT '[]',
  -- 在用的药（跨院处方汇总）。为什么单独一列而不是并进 chronic_json：
  -- 用药冲突检测要按药名精确匹配，和慢病混在一起还得先拆
  medication_json VARCHAR(2000) NOT NULL DEFAULT '[]',
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted       TINYINT      NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX uk_profile_user ON patient_profile (user_id);

-- ---------------- 就诊记录 ----------------
-- 注意 ocr_text 字段：存的是**脱敏后**的文本。
-- 原文（扫描件、照片）只在患者设备上，这里连存储字段都没有。
CREATE TABLE medical_record (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         BIGINT       NOT NULL,
  hospital_code   VARCHAR(32)  NOT NULL COMMENT '跨院标识，非外键',
  visit_date      DATE         NOT NULL,
  department      VARCHAR(64),
  diagnosis_brief VARCHAR(500)          COMMENT '脱敏后的诊断摘要',
  ocr_text        TEXT                  COMMENT '脱敏后文本；原文不落库',
  file_name       VARCHAR(255)          COMMENT '文件名保留，用于展示"我上传过什么"',
  file_size       BIGINT,
  source          VARCHAR(20)  NOT NULL DEFAULT 'UPLOAD' COMMENT 'UPLOAD / MANUAL',
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted         TINYINT      NOT NULL DEFAULT 0
);
CREATE INDEX idx_record_user_date ON medical_record (user_id, visit_date);
CREATE INDEX idx_record_user_hospital ON medical_record (user_id, hospital_code);

-- ---------------- 预约单 ----------------
CREATE TABLE booking_order (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         BIGINT       NOT NULL,
  hospital_code   VARCHAR(32)  NOT NULL,
  department      VARCHAR(64)  NOT NULL,
  visit_time      TIMESTAMP    NOT NULL,
  -- 状态机：CREATED -> CONFIRMED -> COMPLETED，任一状态可 -> CANCELLED
  status          VARCHAR(20)  NOT NULL DEFAULT 'CREATED',
  external_order_no VARCHAR(64)         COMMENT '对方系统的单号，Mock 阶段为空',
  remark          VARCHAR(500),
  -- 患者自助签到的时间。NULL 表示还没签到。
  -- 刻意不放进状态机：签到不改变"能不能取消"，只多一个时间点。
  checkin_at      TIMESTAMP             COMMENT '本地签到时间；不代表院方侧已报到',
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted         TINYINT      NOT NULL DEFAULT 0
);
CREATE INDEX idx_booking_user ON booking_order (user_id, visit_time);
CREATE INDEX idx_booking_status ON booking_order (status, visit_time);

-- ---------------- 提醒任务 ----------------
-- 这张表是"提醒引擎"的落点。可解释性体现在 reason 字段：
-- 每条提醒都要能说清楚"为什么提醒你"。
CREATE TABLE reminder_task (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         BIGINT       NOT NULL,
  -- 关联对象：可以是 booking 也可以是 record，用类型区分
  ref_type        VARCHAR(20)  NOT NULL COMMENT 'BOOKING / RECORD / PLAN',
  ref_id          BIGINT                COMMENT '可能为空，表示不挂具体单据',
  title           VARCHAR(200) NOT NULL,
  detail          VARCHAR(1000),
  -- 为什么提醒（可解释性）：如"距就诊还有 24 小时，需空腹"
  reason          VARCHAR(500),
  -- 幂等键：由「规则名 | 关联类型 | 关联 id | 判别串」拼成，唯一索引兜底。
  -- 引擎每 5 分钟扫一次，同一份数据跑一万次也只能落一条，靠的就是这列。
  -- 不为空的旧数据/手工录入的提醒可以留空（NULL 不参与唯一约束）。
  dedupe_key      VARCHAR(200),
  due_at          TIMESTAMP    NOT NULL,
  -- 状态：PENDING -> SENT -> DONE / SKIPPED
  status          VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
  sent_at         TIMESTAMP,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted         TINYINT      NOT NULL DEFAULT 0
);
CREATE INDEX idx_reminder_due ON reminder_task (status, due_at);
CREATE INDEX idx_reminder_user ON reminder_task (user_id, due_at);
-- 唯一定的是「同一个用户 + 同一个幂等键」，不是全局唯一：
-- 两个患者各自有一条"明天禁食"是完全正常的
CREATE UNIQUE INDEX uk_reminder_dedupe ON reminder_task (user_id, dedupe_key);

-- ============================================================
-- 院内地点与服务点 —— 「在院内」那一段的导航数据
--
-- 为什么单独一张表而不是写死在代码里：
--   院内的楼层分布是**每家医院自己的事实**，换一家医院就得重录一遍。
--   写死在代码里意味着每接一家医院都要改代码、发版；
--   做成数据表，医院运营人员自己就能维护。
--
-- 用 IF NOT EXISTS：测试会创建多个 Spring 上下文
-- （MockMvc 与非 MockMvc 的配置不同），它们共用同一个 H2 内存库。
-- 不加这一句，第二个上下文执行建表语句时会因表已存在而启动失败 ——
-- 这是实测踩到的：单独跑测试类通过，一起跑就 26 个错误。
-- ============================================================
CREATE TABLE IF NOT EXISTS hospital_place (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  hospital_code VARCHAR(32)  NOT NULL COMMENT '院区标识，与 hospital.hospital_code 对应',
  place_type    VARCHAR(20)  NOT NULL COMMENT 'REGISTER/LAB/CLINIC/EXAM/PHARMACY/CASHIER/REPORT/OTHER',
  department    VARCHAR(64)           COMMENT '为 NULL 表示与科室无关',
  name          VARCHAR(128) NOT NULL COMMENT '展示名，如"门诊三楼检验科抽血窗口"',
  building      VARCHAR(64)           COMMENT '楼栋，如"门诊楼"',
  floor         VARCHAR(20)           COMMENT '楼层，如"3F"',
  directions    VARCHAR(500)          COMMENT '口语化指引，不是坐标',
  open_hours    VARCHAR(200)          COMMENT '如"周一至周六 7:30-17:00"',
  est_minutes   INT                   COMMENT '处理时长（分钟）',
  sort_order    INT          NOT NULL DEFAULT 100,
  data_quality  VARCHAR(20)  NOT NULL DEFAULT 'SAMPLE' COMMENT 'REAL 院方提供 / SAMPLE 示意',
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted       TINYINT      NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_place_lookup ON hospital_place (hospital_code, place_type, department);
