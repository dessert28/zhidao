import { describe, expect, it } from 'vitest';
import {
  KIND_META,
  detectKind,
  isConclusionType,
  needsFollowUp,
  parseReport,
  summarizeReport,
} from './reports';

/* 这些文本按真实报告格式写，不是拼凑的片段 —— 抽取规则必须能处理它们 */

const CHEST_XRAY = `检查名称：胸部正位片
X线所见：两肺纹理清晰，未见明显实质性病变。心影大小形态在正常范围。
双侧肺门不大。双侧膈面光滑，肋膈角锐利。
X线诊断：心肺未见明显异常。`;

const CHEST_CT = `检查名称：胸部 CT 平扫
检查所见：双侧胸廓对称。双肺见散在少许条索影，边界清。右肺上叶见一磨玻璃结节，
直径约 4mm。纵隔居中，未见肿大淋巴结。心影不大。双侧胸腔未见积液。
检查结论：1. 右肺上叶磨玻璃结节（约 4mm），建议 6-12 个月复查；2. 双肺少许陈旧性条索影。`;

const ABDOMEN_US = `检查名称：腹部彩超
超声所见：肝脏大小形态正常，实质回声均匀。胆囊大小正常，壁光滑，腔内未见明显异常回声。
胰腺显示清晰。脾脏不大。双肾大小形态正常。
超声提示：肝、胆、胰、脾、双肾未见明显异常。`;

const CAROTID_US = `检查名称：颈动脉彩超
超声所见：双侧颈总动脉内中膜略增厚，右侧厚约 1.1mm。右侧颈动脉分叉处见强回声斑块，
大小约 3.2×1.8mm，管腔未见明显狭窄。
超声提示：双侧颈动脉内中膜增厚伴右侧斑块形成。`;

const ECG = `检查名称：十二导联心电图
心电图特征：窦性心律，心率 72 次/分。PR 间期 160ms，QRS 时限 96ms，QT/QTc 400/420ms。
ST 段无明显偏移。T 波直立。
心电图诊断：窦性心律，大致正常心电图。`;

const GASTROSCOPY = `检查名称：胃镜
内镜所见：食管黏膜光滑。贲门开闭好。胃底胃体黏膜光滑，未见溃疡。胃窦黏膜充血水肿，
散在糜烂。幽门圆，开闭好。十二指肠球部及降段未见异常。
内镜诊断：慢性非萎缩性胃炎伴糜烂。`;

const LAB = `空腹血糖 8.4 mmol/L，糖化血红蛋白 7.8%。参考范围 3.9-6.1 mmol/L。`;

describe('类型识别', () => {
  it('识别 X 线', () => {
    expect(detectKind(CHEST_XRAY, '胸片.pdf')).toBe('XRAY');
  });

  it('识别 CT', () => {
    expect(detectKind(CHEST_CT, '胸部CT.pdf')).toBe('CT');
  });

  it('识别超声', () => {
    expect(detectKind(ABDOMEN_US, '腹部彩超.pdf')).toBe('ULTRASOUND');
  });

  it('识别心电图', () => {
    expect(detectKind(ECG, '心电图.pdf')).toBe('ECG');
  });

  it('识别内镜', () => {
    expect(detectKind(GASTROSCOPY, '胃镜.pdf')).toBe('ENDOSCOPY');
  });

  it('识别化验单', () => {
    expect(detectKind(LAB, '化验单.pdf')).toBe('LAB');
  });

  it('「心脏彩超」不会被 X 线规则误吃', () => {
    // 超声要比 X 线优先判断，否则「心脏」两字可能命中放射类规则
    expect(detectKind('心脏彩超所见：各房室大小正常。', '心脏彩超.pdf')).toBe('ULTRASOUND');
  });

  it('认不出时返回 OTHER，不猜', () => {
    expect(detectKind('今天天气不错', null)).toBe('OTHER');
    expect(detectKind('', null)).toBe('OTHER');
  });

  it('门诊记录不会被当成化验单', () => {
    // 这段含 mmol/L，但它是门诊记录：标题挂「化验单」会让患者以为是用药清单
    const note =
      '血压 152/94 mmHg，空腹血糖 7.6 mmol/L。\n处方：\n二甲双胍缓释片 0.5g 每日2次\n建议继续监测血压血糖。';
    expect(detectKind(note, null)).toBe('OTHER');
  });

  it('文件名也能帮助识别', () => {
    expect(detectKind('所见：未见异常。', '胸部CT报告.pdf')).toBe('CT');
  });
});

describe('所见与结论抽取', () => {
  it('X 线：所见与诊断分开', () => {
    const r = parseReport(CHEST_XRAY);
    expect(r.findings).toContain('两肺纹理清晰');
    expect(r.conclusion).toContain('心肺未见明显异常');
    // 所见里不该混入诊断
    expect(r.findings).not.toContain('心肺未见明显异常');
  });

  it('CT：结论抽取完整（含两条编号）', () => {
    const r = parseReport(CHEST_CT);
    expect(r.conclusion).toContain('磨玻璃结节');
    expect(r.conclusion).toContain('陈旧性条索影');
    expect(r.findings).toContain('双侧胸廓对称');
  });

  it('超声：「超声提示」也能作为结论标题', () => {
    const r = parseReport(ABDOMEN_US);
    expect(r.conclusion).toContain('未见明显异常');
    expect(r.findings).toContain('肝脏大小形态正常');
  });

  it('内镜：「内镜诊断」能抽到', () => {
    const r = parseReport(GASTROSCOPY);
    expect(r.conclusion).toContain('慢性非萎缩性胃炎');
  });

  it('心电图：「诊断」能抽到，且特征段归入所见', () => {
    const r = parseReport(ECG);
    expect(r.conclusion).toContain('窦性心律');
    expect(r.findings).toContain('PR 间期');
  });

  it('没有「所见」「结论」标记时不硬凑', () => {
    const r = parseReport('这是一份普通的门诊记录，建议多休息。');
    expect(r.findings).toBeNull();
    expect(r.conclusion).toBeNull();
  });
});

describe('是否需要跟进', () => {
  it('「未见明显异常」判为不需要 —— 不能被「异常」二字带偏', () => {
    /*
     * 这是本模块最容易出错的地方：「未见明显异常」包含「异常」，
     * 简单匹配异常词会把所有正常报告都标成需要关注，
     * 那等于给每个患者制造焦虑。
     */
    expect(needsFollowUp('心肺未见明显异常。')).toBe(false);
    expect(needsFollowUp('肝、胆、胰、脾、双肾未见明显异常。')).toBe(false);
    expect(needsFollowUp('窦性心律，大致正常心电图。')).toBe(false);
  });

  it('出现结节 / 增厚 / 斑块 / 糜烂 → 需要跟进', () => {
    expect(needsFollowUp('右肺上叶磨玻璃结节，建议 6-12 个月复查')).toBe(true);
    expect(needsFollowUp('双侧颈动脉内中膜增厚伴右侧斑块形成')).toBe(true);
    expect(needsFollowUp('慢性非萎缩性胃炎伴糜烂')).toBe(true);
  });

  it('含「建议复查」也要标出来', () => {
    expect(needsFollowUp('建议 3 个月后复查')).toBe(true);
  });

  it('结论为空时不标', () => {
    expect(needsFollowUp(null)).toBe(false);
  });
});

describe('结构化参数', () => {
  it('心电图抽出心率与间期', () => {
    const r = parseReport(ECG);
    const names = r.params.map((p) => p.name);
    expect(names).toContain('心率');
    expect(names).toContain('PR 间期');
    expect(r.params.find((p) => p.name === '心率')!.value).toContain('72');
  });

  it('CT 抽出测量值（直径 4mm）', () => {
    const r = parseReport(CHEST_CT);
    expect(r.params.some((p) => p.value.includes('4mm'))).toBe(true);
  });

  it('参数最多 3 个，不把报告里所有数字都抓出来', () => {
    const r = parseReport(CAROTID_US);
    expect(r.params.length).toBeLessThanOrEqual(3);
  });

  it('化验单不产生影像参数', () => {
    const r = parseReport(LAB);
    expect(r.params).toHaveLength(0);
  });
});

describe('部位与摘要', () => {
  it('抽出检查部位', () => {
    expect(parseReport(CHEST_CT).bodyPart).toBe('胸部');
    expect(parseReport(CAROTID_US).bodyPart).toBe('颈动脉');
  });

  it('摘要优先用结论', () => {
    const s = summarizeReport(parseReport(CHEST_CT));
    expect(s).toContain('结节');
  });

  it('摘要过长时截断', () => {
    const long = '结论：' + '很长的结论'.repeat(30);
    expect(summarizeReport(parseReport(long), 40).length).toBeLessThanOrEqual(41);
  });

  it('空报告给中性文案，不产出 undefined', () => {
    const s = summarizeReport(parseReport(''));
    expect(s).toContain('未能识别');
    expect(s).not.toContain('undefined');
  });
});

describe('类型元数据', () => {
  it('每个类型都有中文名', () => {
    for (const [k, v] of Object.entries(KIND_META)) {
      expect(v.label, k).toBeTruthy();
      expect(v.short, k).toBeTruthy();
    }
  });

  it('化验与 OTHER 不算结论型', () => {
    expect(isConclusionType('LAB')).toBe(false);
    expect(isConclusionType('OTHER')).toBe(false);
    expect(isConclusionType('CT')).toBe(true);
    expect(isConclusionType('ECG')).toBe(true);
  });
});
