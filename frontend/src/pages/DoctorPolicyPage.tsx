/* ------------------------------------------------------------------
 * 工作边界 —— 医生工作台的规则说明页
 *
 * ============ 这一页不是凑数 ============
 *
 * 医生看的是别人的健康数据。"只读"和"全院检索"这两条边界如果只写在
 * 侧栏底部一行小字里，评审问起来没人能指着自己的界面讲清楚。
 * 这里把散落在 DoctorShell 身份块、DoctorPage 页尾、后端 Service
 * 注释里的规则收敛成一页，能直接截图、直接讲。
 *
 * 内容全部对应代码事实：后端 DoctorPatientService 明确写了"按全部
 * PATIENT 检索，因为没有医生-患者归属表，硬造字段会让数据变成假的"。
 * 页面照实说，不粉饰成"我的患者"。
 *
 * 留痕要分两条链路讲：只有 /api/his/access/** 会写 AccessAudit；
 * 医生工作台走的 /api/doctor/patients/** 目前一行审计都没有。
 * 把前者的事实套到后者头上，是在给一套没有保障的系统背书。
 * ------------------------------------------------------------------ */

import { DoctorShell } from '../components/doctor/DoctorShell';
import { Callout } from '../components/ui/Callout';
import { Card } from '../components/ui/Card';
import { SectionTitle } from '../components/ui/SectionTitle';

const RULES = [
  {
    title: '只读',
    body: '这个工作台只能检索与查看，不提供修改档案、下医嘱或开处方的入口。系统不输出诊断或用药建议，界面上也不会把任何内容包装成"建议"。',
  },
  {
    title: '检索范围：全院患者',
    body: '当前按全部 PATIENT 角色检索。课设阶段没有医生—患者归属表（没有排班、没有接诊记录），硬造一个归属字段只会让数据变成假的。真实上线必须补接诊关系，否则违反最小必要原则。',
  },
  {
    title: '空值照实说"未记录"',
    body: '过敏、慢病、用药为空时一律显示"未记录"，不让空白被读成"没有"。姓名缺失显示"患者 #id"，院区只显示编码不猜中文名，未知预约状态原样显示不猜"已完成"。',
  },
  {
    title: '调阅留痕：只有院方调阅那条路有',
    body: '院方凭匹配码走 /api/his/access/** 调阅时，每次都写审计，患者端「谁看过你的数据」能查到。但医生工作台走的是 /api/doctor/patients/**，目前不写审计 —— 这是尚未补齐的欠账，不能当成已有的保障。',
  },
] as const;

export default function DoctorPolicyPage() {
  return (
    <DoctorShell title="工作边界" subtitle="这份工作台能看什么、不能做什么，以及为什么">
      <Callout tone="clinical" dense title="临床语气是硬约束" className="mb-3">
        这里展示的是患者授权范围内的资料整理结果，不是诊断依据。急症请立即拨打 120。
      </Callout>

      <Card className="mb-3">
        <SectionTitle>四条规则</SectionTitle>
        <ul className="space-y-3">
          {RULES.map((rule, i) => (
            <li key={rule.title} className="flex gap-3">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-50 text-2xs font-medium tabular-nums text-brand-700">
                {i + 1}
              </span>
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-900">{rule.title}</div>
                <p className="mt-0.5 text-xs leading-relaxed text-gray-600">{rule.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <SectionTitle>权限怎么落地的</SectionTitle>
        <ul className="space-y-1.5 text-xs leading-relaxed text-gray-600">
          <li>· 后端 <code className="text-gray-800">/api/doctor/patients/**</code> 要求 DOCTOR 或 ADMIN 角色；患者访问会被拒绝。</li>
          <li>· 前端的角色判断只决定"看不看得见入口"，任何人都能改，不是安全边界。</li>
          <li>· 患者详情接口接受 userId 参数，是因为医生查患者本身是业务允许的；患者侧接口一律用当前登录用户 ID，不接受 id 参数。</li>
          <li>· 非患者账号按 404 处理而不是 403 —— 不告诉调用方"这个 id 存在，只是角色不对"，避免枚举管理员账号。</li>
          <li>· <code className="text-gray-800">/api/his/access/**</code> 会写 <code className="text-gray-800">AccessAudit</code>；医生工作台的 <code className="text-gray-800">/api/doctor/patients/**</code> 不写。两条链路不要混为一谈。</li>
        </ul>
      </Card>
    </DoctorShell>
  );
}
