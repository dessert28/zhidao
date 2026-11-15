-- ============================================================
-- 院方接入凭据 —— HIS 一方如何证明"我是这家医院"
--
-- 为什么单独一张表而不是在 hospital 上加两列：
--   · 一家医院可能有多套凭据（测试环境 / 生产环境、不同院区、轮换期）
--   · 凭据要能单独吊销而不影响院区本身
--   · 凭据是安全敏感数据，单独一张表更容易做权限隔离（未来只给运维看）
--
-- 安全设计（写在这里是为了让后续维护的人不要改坏）：
--   · secret 存的是 **HMAC 签名后的值**吗？—— 不是。HMAC 需要原文才能验签，
--     所以 secret 必须可还原。因此它只能靠**数据库访问控制**保护，
--     而不是靠哈希。这一点必须在任何"加密存储"的讨论里说清楚：
--     哈希无法用于对称签名场景。
--   · 真正要防的是"库被读走后还能不能用"：所以 secret 应当用应用层密钥
--     加密（当前省赛版本为简化直接存明文，并在文档里明示风险）。
--   · secret 永不出现在接口返回里，只在创建时返回一次。
-- ============================================================
CREATE TABLE IF NOT EXISTS hospital_credential (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  -- 凭据归属的院区；一个院区可以有多条（测试/生产/轮换）
  hospital_code VARCHAR(32)  NOT NULL,
  -- 对外的应用标识，可公开，用于定位是哪一套凭据
  app_key       VARCHAR(64)  NOT NULL,
  -- 签名密钥。绝不返回给任何接口；创建时只展示一次
  app_secret    VARCHAR(128) NOT NULL,
  -- 用途标签，方便运维区分：PROD / TEST / ROTATING
  label         VARCHAR(64),
  -- 联系方式：出问题时知道找谁（院方对接人）
  contact       VARCHAR(128),
  enabled       TINYINT      NOT NULL DEFAULT 1,
  -- 最后成功调用时间。长期不调的凭据可以考虑吊销
  last_used_at  TIMESTAMP,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted       TINYINT      NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_credential_appkey ON hospital_credential (app_key);
CREATE INDEX IF NOT EXISTS idx_credential_hospital ON hospital_credential (hospital_code);

-- ============================================================
-- 院方推送的幂等记录
--
-- 为什么要这张表：HIS 一方推送失败会重试，同一个批次可能到达多次。
-- 没有幂等记录时，重试会变成"同一份地点数据被写入两遍"，
-- 患者会看到重复的路线步骤。
--
-- 幂等键由院方提供（batchId），我们只负责"这个 batchId 处理过了就不再处理"。
-- 不用内容哈希：院方的内容每次可能带不同的时间戳，
-- 哈希每次都不同，起不到去重作用。
-- ============================================================
CREATE TABLE IF NOT EXISTS his_push_batch (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  hospital_code VARCHAR(32)  NOT NULL,
  -- 院方给的批次号，在其院区内唯一
  batch_id      VARCHAR(128) NOT NULL,
  -- 推送类型：PLACES 院内地点 / SLOTS 号源（当前只实现 PLACES）
  push_type     VARCHAR(20)  NOT NULL DEFAULT 'PLACES',
  -- 这一批里有多少条、实际写入多少（用于排查"推到哪一步断的"）
  item_count    INT          NOT NULL DEFAULT 0,
  applied_count INT          NOT NULL DEFAULT 0,
  -- 处理结果：APPLIED / FAILED 以及原因
  result        VARCHAR(20)  NOT NULL DEFAULT 'APPLIED',
  message       VARCHAR(500),
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_push_batch ON his_push_batch (hospital_code, batch_id);
