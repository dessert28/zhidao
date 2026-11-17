-- ============================================================
-- 问诊对话留痕 —— 让「刷新页面」不再把上下文清空
--
-- ============ 这张表为什么必须存在 ============
--
-- 问诊对话原先完全活在浏览器内存里：turns 是 React state，
-- 槽位（slot）与轮次（round）放在 useRef。一次刷新、一次误触返回，
-- 患者刚说过的「咳嗽三天了、有黄痰」全部消失，AI 于是又从头问一遍。
-- 从患者的角度，这不像"没记住"，更像"这个系统根本没在听"。
-- 分诊的全部价值建立在多轮追问上，上下文一丢，价值归零。
--
-- ============ 为什么按 user_id + session_id 两级归属 ============
--
-- 只存 session_id 不行：sessionId 由前端生成（crypto.randomUUID），
-- 前端能改。若查询只按 session_id 过滤，任何人拿到 / 猜到一个 id
-- 就能读到别人的问诊内容 —— 这是最典型的 IDOR（参 CurrentUser 的注释）。
-- 所以 user_id 是**强制过滤条件**，session_id 只负责在用户自己的
-- 若干次会话之间做区分。两个字段合起来才是查询的键。
--
-- 为什么还要允许一个用户有多个 session：患者可能「换成新的对话」，
-- 旧的对话不该被覆盖 —— 回看上次问诊过程是有意义的，
-- 而 latestSessionId 让刷新后回到的是**最近那次**。
--
-- ============ 关于内容与隐私 ============
--
-- content 存的是**已经过前端脱敏链路（lib/privacy/context.ts）的文本**：
-- 手机号、身份证在这一层之前就已经被遮蔽。
-- 原文只在患者浏览器 IndexedDB 里 —— 与 medical_record 同一条纪律，
-- 见 schema.sql 顶部的硬约束①。
-- 因此这里不存：原始附件、IP、设备指纹、任何能反查到本人的字段。
--
-- 状态字段只有 deleted：问诊对话没有"进行中/已完成"的业务含义，
-- 唯一需要的生命周期就是"用户把它清了"，而项目统一用逻辑删除表达这个。
-- ============================================================

-- 用 IF NOT EXISTS 的理由同 hospital_place：测试会创建多个 Spring 上下文，
-- 它们共用同一个 H2 内存库，重复执行建表语句不能让第二个上下文启动失败。
CREATE TABLE IF NOT EXISTS chat_message (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT      NOT NULL COMMENT '归属患者；查询必须带，防越权',
  session_id  VARCHAR(64) NOT NULL COMMENT '前端生成的会话标识，同一用户内区分多次对话',
  -- turn_id 是"一问一答"的配对键：同一次提问产生的 user 与 assistant
  -- 两条消息共用一个 turnId，回放时才能把回答对回到它的问题上。
  -- 允许为空：将来若有系统主动插入的提示语，它不属于任何一轮。
  turn_id     VARCHAR(64),
  role        VARCHAR(16) NOT NULL COMMENT 'user / assistant',
  content     TEXT        NOT NULL COMMENT '脱敏后的文本；原文不落库',
  -- 只有 created_at，没有 updated_at：消息一经写出就不再修改，
  -- 编辑历史消息属于伪造医疗记录，不提供这个能力。
  created_at  DATETIME             COMMENT 'MyBatis-Plus 自动填充（MetaTimeHandler）',
  deleted     TINYINT     NOT NULL DEFAULT 0
);

-- 主查询「某用户某会话按时间正序取最近 N 条」走这个索引。
-- 把 created_at 也放进索引，排序可以在索引上完成，不必额外 filesort。
CREATE INDEX IF NOT EXISTS idx_chat_user_session ON chat_message (user_id, session_id, created_at);

-- latestSessionId 只按 user_id 扫，用单独的索引避免退化成全表扫。
-- 为什么不做成 (user_id, created_at) 的覆盖索引去取 MAX：
-- 该查询每打开一次对话才跑一次，量级是"一个人一个会话"，
-- 索引足够，不必为它引入额外的维护成本。
CREATE INDEX IF NOT EXISTS idx_chat_user_time ON chat_message (user_id, created_at);
