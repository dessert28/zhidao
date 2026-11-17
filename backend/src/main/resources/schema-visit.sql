-- ==================================================================
-- 就诊流程进度 —— 「患者自己说这一步做完了」
--
-- ============ 为什么需要这张表 ============
--
-- 路线上的每一步原来是**纯按时间算**的：以预约时间为锚点倒推，
-- 建议时间过了就标 DONE。这在理想情况下没问题，但真实的门诊里：
--
--   · 抽血排队长，比建议时间晚半小时才做完 —— 系统却已经把他
--     推进到下一步，他看着「现在去这里：诊区」但其实人还在抽血窗口
--   · 有人跳过某一步（比如医生说不用先抽血）—— 系统仍然把
--     那一步当成待办，患者永远看到它挂着
--   · 患者想回头看某一步具体在哪 —— DONE 之后那条信息就没那么显眼了
--
-- 也就是说：**时间推算只能给一个默认值，真正的进度只有患者自己知道。**
-- 这张表存的就是那份"患者说了算"的进度。
--
-- ============ 为什么存 nav_key 而不是 place_id ============
--
-- 路线顺序会变（空腹与非空腹的检验位置不同、科室不同诊区不同），
-- place_id 对应的是"某个楼层的某个地点"，而患者说的是
-- "我做完了检验"这个**阶段**。用 stage + place_id 组合一个稳定的
-- nav_key，即使院方后面调整了地点数据，已记录的进度也不会错位。
--
-- ============ 幂等 ============
--
-- 同一单同一步只会有一行（唯一索引）。重复点击"完成"只是重写
-- done_at，不会累积垃圾行。
-- ==================================================================

CREATE TABLE IF NOT EXISTS visit_step_progress (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id       BIGINT       NOT NULL COMMENT '归属患者；查询必须带，防越权',
  booking_id    BIGINT       NOT NULL COMMENT '哪一张预约单的进度',
  -- 稳定的步骤标识，形如 "REGISTER" 或 "CLINIC:内分泌科"
  nav_key       VARCHAR(96)  NOT NULL COMMENT '阶段编码或 阶段:科室',
  -- DONE 患者标记已完成 / SKIPPED 患者标记跳过了这一步
  state         VARCHAR(16)  NOT NULL COMMENT 'DONE / SKIPPED',
  done_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted       TINYINT      NOT NULL DEFAULT 0
);

-- 唯一索引而不是普通索引：同一单同一步只能有一条记录。
-- 用 nav_key 而不是 place_id，理由见文件头。
CREATE UNIQUE INDEX IF NOT EXISTS uk_visit_step ON visit_step_progress (user_id, booking_id, nav_key);
CREATE INDEX IF NOT EXISTS idx_visit_step_booking ON visit_step_progress (booking_id);
