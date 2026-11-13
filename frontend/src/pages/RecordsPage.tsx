/* ------------------------------------------------------------------
 * 病历页 —— 隐私边界的可视化
 *
 * 这一页在当前阶段是**说明性的**：它把「原文只存本地」这件事
 * 用界面语言讲清楚，而不是等实现完再说。
 * 真正的 IndexedDB 上传链路在 M4 接入（见 docs/09 §6）。
 * ------------------------------------------------------------------ */

import { Link } from 'react-router-dom';

const STORAGE_FACTS = [
  {
    title: '病历原文',
    where: '只在你这台设备的浏览器里',
    detail: '存放在 IndexedDB，不会上传到任何服务器；我们的数据库里连存原文的字段都没有。',
    tone: 'local' as const,
  },
  {
    title: '脱敏后的文本',
    where: '会进入 AI 处理流程',
    detail: '姓名、身份证、手机号、住址会被替换成占位符。进入模型的是「患者，男，45 岁」而不是你的名字。',
    tone: 'cloud' as const,
  },
  {
    title: '账号信息',
    where: '用户名 + 恢复码',
    detail: '不收集手机号和身份证。密码经 bcrypt 存储，跨设备同步的聊天内容用恢复码派生的密钥加密。',
    tone: 'cloud' as const,
  },
] as const;

export default function RecordsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-gray-900">我的病历</h1>
        <p className="mt-2 text-sm leading-relaxed text-gray-500">
          把散在各家医院的记录放在一起，换医院时不用再凭记忆复述。
          文件只留在你的设备上，需要给医生看时由你主动出示。
        </p>
      </div>

      {/* 上传入口：先占位，说明将来支持什么 */}
      <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-8 text-center">
        <div className="text-sm font-medium text-gray-700">上传病历</div>
        <p className="mx-auto mt-1.5 max-w-sm text-xs leading-relaxed text-gray-400">
          支持拍照、PDF 与文字。上传后先在本地脱敏，只把脱敏文本交给 AI 整理。
          <br />
          此功能正在接入，当前版本尚未开放。
        </p>
      </div>

      {/* 数据去向：三行说清边界 */}
      <section>
        <h2 className="mb-2 text-sm font-medium text-gray-700">这些数据会去哪儿</h2>
        <div className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white">
          {STORAGE_FACTS.map((f) => (
            <div key={f.title} className="p-4">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-800">{f.title}</span>
                <span
                  className={
                    'rounded px-1.5 py-0.5 text-xs ' +
                    (f.tone === 'local'
                      ? 'bg-green-50 text-green-700'
                      : 'bg-amber-50 text-amber-700')
                  }
                >
                  {f.where}
                </span>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-gray-500">{f.detail}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="rounded-xl bg-gray-100 p-4">
        <p className="text-xs leading-relaxed text-gray-600">
          <strong className="font-medium text-gray-800">为什么这样做：</strong>
          医院之间数据不互通是现实，短期不会变。与其等各家医院接入，不如把数据交回患者手里——
          这样跨院的时间轴、重复检查提示、用药冲突提醒才做得成，而且不需要任何一家医院授权。
        </p>
      </div>

      <Link
        to="/"
        className="inline-flex h-10 items-center rounded-lg border border-gray-200 bg-white px-4 text-sm text-gray-700 hover:border-brand-300"
      >
        返回问诊
      </Link>
    </div>
  );
}
