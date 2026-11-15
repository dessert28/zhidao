-- ============================================================
-- 智诊通 · 业务库 schema（MySQL 8 专用）
-- 依据：docs/09-数据模型.md
--
-- 为什么不能直接用 schema.sql：
--   schema.sql 是 H2 语法（虽然标注"兼容 MySQL"），但几处细节在 MySQL 下会失败：
--     · reminder_task.detail 等字段的 TEXT/DEFAULT 组合
--     · MySQL 8 里 TIMESTAMP 的自动更新语义与 H2 不同
--     · H2 允许 CREATE INDEX IF NOT EXISTS，MySQL 不接受这个写法
--       （MySQL 要用 ALTER TABLE ... ADD INDEX，或者先判断存在性）
--   所以单独一份，宁可多一个文件，也不要"看起来兼容"的隐式失败。
--
-- 三条硬约束与 schema.sql 完全一致（这是产品级约束，与数据库无关）：
--   ① 原文不进库：medical_record.ocr_text 存的是脱敏后文本
--   ② 逻辑删除统一用 deleted
--   ③ 跨院一律用 hospital_code，不建外键
-- ============================================================

SET NAMES utf8mb4;

DROP TABLE IF EXISTS reminder_task;
DROP TABLE IF EXISTS booking_order;
DROP TABLE IF EXISTS medical_record;
DROP TABLE IF EXISTS patient_profile;
DROP TABLE IF EXISTS hospital;
DROP TABLE IF EXISTS sys_user;

-- ---------------- 用户 ----------------
CREATE TABLE sys_user (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(64)  NOT NULL COMMENT '登录名',
  password_hash VARCHAR(100) NOT NULL COMMENT 'bcrypt，绝不明文',
  recovery_hash VARCHAR(100)          COMMENT '恢复码，也是 bcrypt',
  role          VARCHAR(20)  NOT NULL DEFAULT 'PATIENT',
  enabled       TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted       TINYINT(1)   NOT NULL DEFAULT 0,
  UNIQUE KEY uk_user_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='认证主体。刻意不存手机号与身份证（docs/09 硬约束）';

-- ---------------- 院区 ----------------
CREATE TABLE hospital (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  hospital_code VARCHAR(32)  NOT NULL COMMENT '对外标识，跨表引用只用它',
  name          VARCHAR(128) NOT NULL,
  level         VARCHAR(32)           COMMENT '三甲 / 二甲',
  city          VARCHAR(64),
  adapter_type  VARCHAR(32)  NOT NULL DEFAULT 'MOCK' COMMENT 'MOCK / HL7 / FHIR',
  enabled       TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted       TINYINT(1)   NOT NULL DEFAULT 0,
  UNIQUE KEY uk_hospital_code (hospital_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='院区。外部系统，不建外键';

-- ---------------- 患者档案 ----------------
-- 刻意不存：真名 / 身份证 / 手机号 / 住址
CREATE TABLE patient_profile (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id       BIGINT       NOT NULL,
  birth_year    INT                   COMMENT '只存年份',
  gender        VARCHAR(10),
  allergy_json  VARCHAR(2000) NOT NULL DEFAULT '[]',
  chronic_json  VARCHAR(2000) NOT NULL DEFAULT '[]',
  -- 在用的药（跨院处方汇总）。为什么单独一列而不是并进 chronic_json：
  -- 用药冲突检测要按药名精确匹配，和慢病混在一起还得先拆
  medication_json VARCHAR(2000) NOT NULL DEFAULT '[]',
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted       TINYINT(1)   NOT NULL DEFAULT 0,
  UNIQUE KEY uk_profile_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='患者档案。过敏与慢病用 JSON，永远整份读写';

-- ---------------- 就诊记录 ----------------
CREATE TABLE medical_record (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         BIGINT       NOT NULL,
  hospital_code   VARCHAR(32)  NOT NULL COMMENT '跨院标识，非外键',
  visit_date      DATE         NOT NULL,
  department      VARCHAR(64),
  diagnosis_brief VARCHAR(500)          COMMENT '脱敏后的诊断摘要',
  ocr_text        TEXT                  COMMENT '脱敏后文本；原文不落库',
  file_name       VARCHAR(255),
  file_size       BIGINT,
  source          VARCHAR(20)  NOT NULL DEFAULT 'UPLOAD' COMMENT 'UPLOAD / MANUAL',
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted         TINYINT(1)   NOT NULL DEFAULT 0,
  KEY idx_record_user_date (user_id, visit_date),
  KEY idx_record_user_hospital (user_id, hospital_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='就诊记录。ocr_text 是脱敏后的，不是原文';

-- ---------------- 预约单 ----------------
CREATE TABLE booking_order (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id           BIGINT       NOT NULL,
  hospital_code     VARCHAR(32)  NOT NULL,
  department        VARCHAR(64)  NOT NULL,
  visit_time        DATETIME     NOT NULL,
  status            VARCHAR(20)  NOT NULL DEFAULT 'CREATED'
                    COMMENT 'CREATED -> CONFIRMED -> COMPLETED，任一状态可 -> CANCELLED',
  external_order_no VARCHAR(64)           COMMENT '对方系统单号，Mock 阶段为空',
  remark            VARCHAR(500),
  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted           TINYINT(1)   NOT NULL DEFAULT 0,
  KEY idx_booking_user (user_id, visit_time),
  KEY idx_booking_status (status, visit_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='预约单。状态迁移由 Service 校验，不依赖数据库约束';

-- ---------------- 提醒任务 ----------------
CREATE TABLE reminder_task (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT       NOT NULL,
  ref_type    VARCHAR(20)  NOT NULL COMMENT 'BOOKING / RECORD / PLAN',
  ref_id      BIGINT                COMMENT '可能为空，表示不挂具体单据',
  title       VARCHAR(200) NOT NULL,
  detail      VARCHAR(1000),
  reason      VARCHAR(500)          COMMENT '为什么提醒（可解释性）',
  -- 幂等键：规则名|关联类型|关联id|判别串
  -- 引擎每 5 分钟扫一次，同一份数据跑一万次也只能落一条，靠的就是这列
  dedupe_key  VARCHAR(200),
  due_at      DATETIME     NOT NULL,
  status      VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
  sent_at     TIMESTAMP    NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted     TINYINT(1)   NOT NULL DEFAULT 0,
  KEY idx_reminder_due (status, due_at),
  KEY idx_reminder_user (user_id, due_at),
  -- 唯一的是「用户 + 幂等键」，不是全局唯一：两个患者各有一条"明天禁食"很正常。
  -- NULL 不参与唯一约束，所以手工录入的提醒（dedupe_key 为空）不受影响。
  UNIQUE KEY uk_reminder_dedupe (user_id, dedupe_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='提醒任务。reason 字段是这张表的灵魂';

-- ============================================================
-- 院内地点与服务点（与 schema.sql 的 hospital_place 一一对应）
-- ============================================================
CREATE TABLE IF NOT EXISTS hospital_place (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  hospital_code VARCHAR(32)  NOT NULL COMMENT '院区标识',
  place_type    VARCHAR(20)  NOT NULL COMMENT 'REGISTER/LAB/CLINIC/EXAM/PHARMACY/CASHIER/REPORT/OTHER',
  department    VARCHAR(64)           COMMENT '为 NULL 表示与科室无关',
  name          VARCHAR(128) NOT NULL,
  building      VARCHAR(64),
  floor         VARCHAR(20),
  directions    VARCHAR(500)          COMMENT '口语化指引，不是坐标',
  open_hours    VARCHAR(200),
  est_minutes   INT                   COMMENT '处理时长（分钟）',
  sort_order    INT          NOT NULL DEFAULT 100,
  data_quality  VARCHAR(20)  NOT NULL DEFAULT 'SAMPLE' COMMENT 'REAL 院方提供 / SAMPLE 示意',
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted       TINYINT(1)   NOT NULL DEFAULT 0,
  KEY idx_place_lookup (hospital_code, place_type, department)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='院内地点。data_quality 区分院方真实数据与演示示意数据';
