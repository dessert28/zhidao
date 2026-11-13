-- ============================================================
-- 种子数据
--
-- 这是**演示数据**，不是真实患者数据。
-- 刻意做成一眼能看出是假的：姓名/手机号都不出现（schema 里也没这些字段），
-- 只有年份和科室，因为服务端本来就不需要知道更多。
-- ============================================================

-- 演示账号：demo / demo1234
-- 密码哈希是 BCrypt("demo1234")，cost=10。
-- 明文写在注释里是因为这是公开的演示账号，不是密钥。
INSERT INTO sys_user (username, password_hash, role) VALUES
  ('demo', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', 'PATIENT');

-- 两个 Mock 院区。名字带"演示"二字，防止被误认成真实医院。
INSERT INTO hospital (hospital_code, name, level, city, adapter_type) VALUES
  ('MOCK-A', '演示市第一人民医院（示例）', '三甲', '演示市', 'MOCK'),
  ('MOCK-B', '演示市中心医院（示例）',   '三甲', '演示市', 'MOCK');

-- 患者档案：男，1965 年生（所以 2026 年是 61 岁 —— 这是"跨院老年患者"的主场景）
INSERT INTO patient_profile (user_id, birth_year, gender, allergy_json, chronic_json) VALUES
  (1, 1965, 'MALE', '["青霉素"]', '["高血压","2型糖尿病"]');

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

-- 预约单：一条已确认，一条待确认
INSERT INTO booking_order (user_id, hospital_code, department, visit_time, status, remark) VALUES
  (1, 'MOCK-A', '内分泌科', '2026-11-15 08:30:00', 'CONFIRMED', '空腹抽血，需禁食'),
  (1, 'MOCK-B', '心血管内科', '2026-11-22 14:00:00', 'CREATED', NULL);

-- 提醒任务：覆盖三种状态，让引擎一启动就有活干
INSERT INTO reminder_task (user_id, ref_type, ref_id, title, detail, reason, due_at, status) VALUES
  (1, 'BOOKING', 1, '明天早上空腹抽血，今晚 22 点后禁食',
   '内分泌科复诊需要空腹血糖，请从今晚 22 点后停止进食，可少量饮水。',
   '距就诊还有 24 小时，且该科室开具了空腹抽血项目', '2026-11-14 22:00:00', 'PENDING'),
  (1, 'RECORD', 2, '距离上次查糖化血红蛋白已满 3 个月',
   '上一次糖化血红蛋白是 9 月 12 日，建议复查。',
   '检查项目时效性规则：糖化血红蛋白建议每 3 个月复查', '2026-12-12 09:00:00', 'PENDING'),
  (1, 'BOOKING', 2, '下周的心血管内科预约还未确认',
   '11 月 22 日下午的号还没有确认，请及时确认或取消。',
   '预约单状态为 CREATED 且距就诊不足 7 天', '2026-11-20 10:00:00', 'PENDING');
