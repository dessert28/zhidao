/* ------------------------------------------------------------------
 * 语义色字典
 *
 * ============ 为什么要有这一层 ============
 *
 * 改版前 amber 一个颜色同时表示「缺数据 / 免责 / 安全警告 / 化验异常 /
 * 待确认」五件事。颜色用多了不等于重点突出 —— 当所有东西都是黄的，
 * 患者就全都不看了。所以先把"一件事一个颜色"钉死在这里：
 *
 *   brand     品牌与主行动（青绿，恒定）
 *   appt      预约 —— 时间与地点。全站唯一的时间强调色
 *   alert     该做点什么 —— 复查到期、空腹禁食、用药冲突、待确认
 *   clinical  临床异常 —— 化验值超参考范围。异常是事实，提醒是行动，分开
 *   critical  急症红线。唯一允许高饱和红的地方
 *   done      完成 —— 已服用、已签到、在有效期内
 *   neutral   说明与未知 —— 免责、缺数据、后端不可达。是"不知道"，不是"危险"
 *
 * ============ 老人可读的三条硬规则 ============
 *
 * 1. 正文永不用彩色字。颜色只给标签、标题、数字、侧边条。
 * 2. 彩色块面积不超过卡片的 30% —— 浅底 + 3px 侧边条，而不是整块深色。
 * 3. 关键信息（时间、药名、剂量）靠字号和加粗，不靠颜色区分（色弱也读得懂）。
 * ------------------------------------------------------------------ */

export type Tone = 'neutral' | 'muted' | 'brand' | 'appt' | 'alert' | 'clinical' | 'critical' | 'done';

/** 卡片底色 + 描边 */
export const TONE_SURFACE: Record<Tone, string> = {
  neutral: 'border-gray-200 bg-surface',
  muted: 'border-gray-200 bg-gray-50',
  brand: 'border-brand-200 bg-brand-50',
  appt: 'border-appt-line bg-appt-soft',
  alert: 'border-alert-line bg-alert-soft',
  clinical: 'border-clinical-line bg-clinical-soft',
  critical: 'border-critical-line bg-critical-soft',
  done: 'border-done-line bg-done-soft',
};

/** 标题/标签文字色。对浅底均 ≥ 4.5:1，深色下自动反色 */
export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-gray-900',
  muted: 'text-gray-600',
  brand: 'text-brand-700',
  appt: 'text-appt',
  alert: 'text-alert',
  clinical: 'text-clinical',
  critical: 'text-critical',
  done: 'text-done',
};

/** 左侧强调条（重点事项用这个，比整块上色安静得多） */
export const TONE_BAR: Record<Tone, string> = {
  neutral: 'border-l-gray-300',
  muted: 'border-l-gray-300',
  brand: 'border-l-brand-500',
  appt: 'border-l-appt-solid',
  alert: 'border-l-alert-solid',
  clinical: 'border-l-clinical-solid',
  critical: 'border-l-critical-solid',
  done: 'border-l-done-solid',
};

/** 小圆点 */
export const TONE_DOT: Record<Tone, string> = {
  neutral: 'bg-gray-400',
  muted: 'bg-gray-300',
  brand: 'bg-brand-600',
  appt: 'bg-appt-solid',
  alert: 'bg-alert-solid',
  clinical: 'bg-clinical-solid',
  critical: 'bg-critical-solid',
  done: 'bg-done-solid',
};

/** 实心小徽标（时间、条数这类短标签） */
export const TONE_BADGE: Record<Tone, string> = {
  neutral: 'bg-gray-200 text-gray-700',
  muted: 'bg-gray-100 text-gray-500',
  brand: 'bg-action text-white',
  appt: 'bg-appt-solid text-white',
  alert: 'bg-alert-solid text-white',
  clinical: 'bg-clinical-solid text-white',
  critical: 'bg-critical-solid text-white',
  done: 'bg-done-solid text-white',
};

/** 实线强调卡（"现在去这里"这种全站只有一张的卡才用） */
export const TONE_STRONG: Record<Tone, string> = {
  neutral: 'border-2 border-gray-300 bg-surface',
  muted: 'border-2 border-gray-200 bg-gray-50',
  brand: 'border-2 border-brand-500 bg-brand-50',
  appt: 'border-2 border-appt-solid bg-appt-soft',
  alert: 'border-2 border-alert-solid bg-alert-soft',
  clinical: 'border-2 border-clinical-solid bg-clinical-soft',
  critical: 'border-2 border-critical-solid bg-critical-soft',
  done: 'border-2 border-done-solid bg-done-soft',
};
