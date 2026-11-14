-- ============================================================
-- 种子数据
--
-- 这是**演示数据**，不是真实患者数据。
-- 刻意做成一眼能看出是假的：姓名/手机号都不出现（schema 里也没这些字段），
-- 只有年份和科室，因为服务端本来就不需要知道更多。
--
-- 时间基准：2026-11-14（省赛提交期）。所有相对日期都围绕它写死，
-- 这样"距就诊 24 小时""复查已过期"这类提醒规则演示时一定能触发。
-- 若在别的日期演示，改下面这 5 个时间点即可。
-- ============================================================

-- 演示账号：demo / demo1234
--
-- 哈希是**真实算出来**的 BCrypt("demo1234")，cost=10。
-- 注意：这里曾经放过网上流传的那串
--   $2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy
-- 它出现在无数 Spring Security 教程里，但它对应的明文**不是** demo1234
-- （实测 matches("demo1234") == false），照抄进去的症状是"登录永远 401，
-- 而密码明明没写错"。改用下面这串之前，先用 BCryptPasswordEncoder 验一次。
INSERT INTO sys_user (username, password_hash, role) VALUES
  ('demo', '$2a$10$A8hrJ98MEdtngRppd5VVTOnxcg6SSOrhtjYUo9l3o3qQEY7.AYcwG', 'PATIENT');

-- 两个 Mock 院区。名字带"演示"二字，防止被误认成真实医院。
INSERT INTO hospital (hospital_code, name, level, city, adapter_type) VALUES
  ('MOCK-A', '演示市第一人民医院（示例）', '三甲', '演示市', 'MOCK'),
  ('MOCK-B', '演示市中心医院（示例）',   '三甲', '演示市', 'MOCK');

-- 患者档案：男，1965 年生（所以 2026 年是 61 岁 —— 这是"跨院老年患者"的主场景）
--
-- 用药清单是刻意造的：阿司匹林与氨氯地平分别来自两家医院的处方，
-- 患者自己汇总在这里。用它演示「不同医院都开了药，请让医生确认能否同服」。
-- 注意：这是我们**只提示不判断**的边界，不是相互作用分析。
INSERT INTO patient_profile (user_id, birth_year, gender, allergy_json, chronic_json, medication_json) VALUES
  (1, 1965, 'MALE', '["青霉素"]', '["高血压","2型糖尿病"]', '["阿司匹林肠溶片","二甲双胍","氨氯地平"]');

-- 跨院就诊记录：故意让两家医院的数据时间交错，
-- 用来演示"同一件事在不同医院被重复做"
INSERT INTO medical_record (user_id, hospital_code, visit_date, department, diagnosis_brief, ocr_text, file_name, file_size, source) VALUES
  (1, 'MOCK-A', '2026-09-12', '内分泌科', '2型糖尿病，血糖控制欠佳',
   '空腹血糖 8.4 mmol/L，糖化血红蛋白 7.8%。建议调整饮食结构，三个月后复查糖化血红蛋白。',
   '化验单-20260912.pdf', 184320, 'UPLOAD'),
  (1, 'MOCK-B', '2026-10-20', '内分泌科', '2型糖尿病复诊',
   '空腹血糖 7.9 mmol/L。患者自述近期在外院已查过血糖，本次未重复开具糖化血红蛋白。',
   '门诊病历-20261020.pdf', 102400, 'UPLOAD'),
  (1, 'MOCK-A', '2026-11-02', '心血管内科', '原发性高血压 2 级',
   '血压 158/96 mmHg。建议低盐饮食，继续监测，两周后复查。',
   '门诊病历-20261102.pdf', 88064, 'MANUAL');

-- 预约单：一条已确认（明天早上，触发"今晚禁食"提醒），一条待确认
INSERT INTO booking_order (user_id, hospital_code, department, visit_time, status, external_order_no, remark) VALUES
  (1, 'MOCK-A', '内分泌科', '2026-11-15 08:30:00', 'CONFIRMED', 'MOCK-A-1001', '空腹抽血，需禁食'),
  (1, 'MOCK-B', '心血管内科', '2026-11-22 14:00:00', 'CREATED', NULL, NULL);

-- 提醒任务：只种一条**已经过期但仍在补发窗口内**的，用来验证引擎的扫描与补发。
-- 其余两类（复查到期、预约待确认）故意不种 —— 让引擎自己算出来，
-- 否则"引擎跑起来了"和"种子数据本来就是那样"分不清。
INSERT INTO reminder_task (user_id, ref_type, ref_id, title, detail, reason, due_at, status) VALUES
  (1, 'BOOKING', 1, '明天早上空腹抽血，今晚 22 点后禁食',
   '内分泌科复诊需要空腹血糖，请从今晚 22 点后停止进食，可少量饮水。',
   '距就诊还有 24 小时，且该科室开具了空腹抽血项目', '2026-11-14 00:30:00', 'PENDING');
