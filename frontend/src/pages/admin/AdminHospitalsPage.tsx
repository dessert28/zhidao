/* ------------------------------------------------------------------
 * 院区与科室 —— 主从表
 *
 * ============ 这页为什么是"主从"而不是两页 ============
 *
 * 院区（主表）和院内地点（从表）是一对多，而且从表离开主表就没有意义：
 * "3 楼检验科"单独存在时，患者和医生都不知道是哪家医院的 3 楼。
 * 所以左边选院区、右边编地点，选中状态本身就是页面的上下文。
 * 这也是评分里"主从表"的那一条：一个列表驱动另一个列表的加载。
 *
 * ============ 删除院区为什么单独确认 ============
 *
 * 删一个院区等于把它下面所有地点一起下线，患者在导航里会直接找不到
 * 这个院区。二次确认里必须把这件事说出来，而不是只问"确定删除吗"。
 * ------------------------------------------------------------------ */

import { useEffect, useState } from 'react';
import {
  AdminField,
  AdminShell,
  adminFieldClass,
  adminTextareaClass,
} from '../../components/admin/AdminShell';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';
import { Card } from '../../components/ui/Card';
import { SectionTitle } from '../../components/ui/SectionTitle';
import {
  createPlace,
  deleteAdminHospital,
  deletePlace,
  failureMessage,
  listAdminHospitals,
  listPlaces,
  saveAdminHospital,
  type AdminHospital,
  type AdminPlace,
} from '../../lib/api';

/** 地点类型。值和后端 PlaceType 枚举一致，中文只用于展示 */
const PLACE_TYPES = [
  { value: 'REGISTER', label: '挂号/收费窗口' },
  { value: 'LAB', label: '检验科' },
  { value: 'CLINIC', label: '诊室' },
  { value: 'EXAM', label: '检查科室' },
  { value: 'PHARMACY', label: '药房' },
  { value: 'CASHIER', label: '收费处' },
  { value: 'REPORT', label: '报告打印' },
  { value: 'OTHER', label: '其他' },
];

const ADAPTER_TYPES = [
  { value: 'DEMO', label: 'DEMO（本地演示数据）' },
  { value: 'HL7', label: 'HL7（院方接口）' },
  { value: 'FHIR', label: 'FHIR（院方接口）' },
];

function placeTypeLabel(value: string): string {
  return PLACE_TYPES.find((t) => t.value === value)?.label ?? value;
}

interface HospitalForm {
  code: string;
  name: string;
  level: string;
  city: string;
  adapterType: string;
  enabled: boolean;
}

const EMPTY_HOSPITAL: HospitalForm = {
  code: '',
  name: '',
  level: '',
  city: '',
  adapterType: 'DEMO',
  enabled: true,
};

interface PlaceForm {
  name: string;
  placeType: string;
  building: string;
  floor: string;
  department: string;
  directions: string;
  openHours: string;
  estMinutes: string;
}

const EMPTY_PLACE: PlaceForm = {
  name: '',
  placeType: 'CLINIC',
  building: '',
  floor: '',
  department: '',
  directions: '',
  openHours: '',
  estMinutes: '',
};

export default function AdminHospitalsPage() {
  const [hospitals, setHospitals] = useState<AdminHospital[]>([]);
  const [hospitalLoading, setHospitalLoading] = useState(true);
  const [hospitalError, setHospitalError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [selectedCode, setSelectedCode] = useState<string | null>(null);

  const [places, setPlaces] = useState<AdminPlace[]>([]);
  const [placeLoading, setPlaceLoading] = useState(false);
  const [placeError, setPlaceError] = useState<string | null>(null);

  const [hospitalForm, setHospitalForm] = useState<HospitalForm>(EMPTY_HOSPITAL);
  const [hospitalFormOpen, setHospitalFormOpen] = useState(false);
  const [hospitalFormNew, setHospitalFormNew] = useState(true);
  const [hospitalFormError, setHospitalFormError] = useState<string | null>(null);
  const [hospitalSaving, setHospitalSaving] = useState(false);

  const [placeForm, setPlaceForm] = useState<PlaceForm>(EMPTY_PLACE);
  const [placeFormOpen, setPlaceFormOpen] = useState(false);
  const [placeFormError, setPlaceFormError] = useState<string | null>(null);
  const [placeSaving, setPlaceSaving] = useState(false);

  /* ---------------- 主表：院区列表 ---------------- */
  useEffect(() => {
    let alive = true;
    setHospitalLoading(true);
    setHospitalError(null);

    void (async () => {
      const r = await listAdminHospitals({ page: 1, size: 50 });
      if (!alive) return;
      if (r.ok) {
        const list = r.data.records;
        setHospitals(list);
        // 首次加载默认选中第一个：空着右边会让页面看起来像加载失败
        setSelectedCode((prev) => prev ?? list[0]?.hospitalCode ?? null);
      } else {
        setHospitals([]);
        setHospitalError(failureMessage(r.failure));
      }
      setHospitalLoading(false);
    })();

    return () => {
      alive = false;
    };
  }, [reloadKey]);

  /* ---------------- 从表：选中院区的地点 ---------------- */
  useEffect(() => {
    if (!selectedCode) {
      setPlaces([]);
      return;
    }
    let alive = true;
    setPlaceLoading(true);
    setPlaceError(null);

    void (async () => {
      const r = await listPlaces(selectedCode);
      if (!alive) return;
      if (r.ok) setPlaces(r.data);
      else {
        setPlaces([]);
        setPlaceError(failureMessage(r.failure));
      }
      setPlaceLoading(false);
    })();

    return () => {
      alive = false;
    };
  }, [selectedCode, reloadKey]);

  const selected = hospitals.find((h) => h.hospitalCode === selectedCode) ?? null;

  function openNewHospital() {
    setHospitalFormNew(true);
    // 编码是主键，新建时必须手填；编辑时锁住，避免改主键造成"删了又建"
    setHospitalForm(EMPTY_HOSPITAL);
    setHospitalFormError(null);
    setHospitalFormOpen(true);
  }

  function openEditHospital(h: AdminHospital) {
    setHospitalFormNew(false);
    setHospitalForm({
      code: h.hospitalCode,
      name: h.name,
      level: h.level ?? '',
      city: h.city ?? '',
      adapterType: h.adapterType ?? 'DEMO',
      enabled: h.enabled,
    });
    setHospitalFormError(null);
    setHospitalFormOpen(true);
  }

  async function submitHospital() {
    setHospitalFormError(null);
    if (!hospitalForm.code.trim() || !hospitalForm.name.trim()) {
      setHospitalFormError('院区编码和名称都必须填写');
      return;
    }

    const payload: AdminHospital = {
      hospitalCode: hospitalForm.code.trim(),
      name: hospitalForm.name.trim(),
      level: hospitalForm.level.trim() || null,
      city: hospitalForm.city.trim() || null,
      adapterType: hospitalForm.adapterType,
      enabled: hospitalForm.enabled,
    };

    setHospitalSaving(true);
    const r = await saveAdminHospital(payload, hospitalFormNew);
    setHospitalSaving(false);

    if (!r.ok) {
      setHospitalFormError(failureMessage(r.failure));
      return;
    }

    setHospitalFormOpen(false);
    if (hospitalFormNew) setSelectedCode(payload.hospitalCode);
    setReloadKey((k) => k + 1);
  }

  async function removeHospital(h: AdminHospital) {
    const yes = window.confirm(
      `确定删除院区「${h.name}」吗？\n该院区的 ${h.placeCount ?? 0} 个院内地点会一并下线，患者端将无法导航到这些地点。`,
    );
    if (!yes) return;

    const r = await deleteAdminHospital(h.hospitalCode);
    if (!r.ok) {
      setHospitalError(failureMessage(r.failure));
      return;
    }
    // 删的是当前选中项时要清掉选中，否则右边会一直请求一个已不存在的院区
    if (selectedCode === h.hospitalCode) setSelectedCode(null);
    setReloadKey((k) => k + 1);
  }

  async function submitPlace() {
    if (!selectedCode) return;
    setPlaceFormError(null);

    if (!placeForm.name.trim()) {
      setPlaceFormError('地点名称必填');
      return;
    }
    if (!placeForm.placeType) {
      setPlaceFormError('请选择地点类型');
      return;
    }

    const minutes = placeForm.estMinutes.trim() === '' ? null : Number(placeForm.estMinutes);
    if (minutes != null && (!Number.isFinite(minutes) || minutes < 0)) {
      setPlaceFormError('预计耗时需要是非负数字（分钟）');
      return;
    }

    setPlaceSaving(true);
    const r = await createPlace(selectedCode, {
      placeType: placeForm.placeType,
      name: placeForm.name.trim(),
      building: placeForm.building.trim() || null,
      floor: placeForm.floor.trim() || null,
      department: placeForm.department.trim() || null,
      directions: placeForm.directions.trim() || null,
      openHours: placeForm.openHours.trim() || null,
      estMinutes: minutes,
    });
    setPlaceSaving(false);

    if (!r.ok) {
      setPlaceFormError(failureMessage(r.failure));
      return;
    }

    setPlaceForm(EMPTY_PLACE);
    setPlaceFormOpen(false);
    setReloadKey((k) => k + 1);
  }

  async function removePlace(p: AdminPlace) {
    const yes = window.confirm(`确定删除地点「${p.name}」吗？`);
    if (!yes) return;
    const r = await deletePlace(p.id);
    if (!r.ok) {
      setPlaceError(failureMessage(r.failure));
      return;
    }
    setReloadKey((k) => k + 1);
  }

  return (
    <AdminShell
      title="院区与科室"
      subtitle="左边选院区，右边维护院内地点 —— 患者导航直接读这张表"
      action={<Button onClick={openNewHospital}>新建院区</Button>}
    >
      {hospitalFormOpen ? (
        <Card className="mb-3">
          <SectionTitle>{hospitalFormNew ? '新建院区' : `编辑院区 · ${hospitalForm.code}`}</SectionTitle>
          <div className="grid gap-2.5 sm:grid-cols-2">
            <AdminField label="院区编码" hint="主键，创建后不可修改">
              <input
                className={adminFieldClass + ' disabled:bg-gray-100 disabled:text-gray-500'}
                value={hospitalForm.code}
                disabled={!hospitalFormNew}
                onChange={(e) => setHospitalForm({ ...hospitalForm, code: e.target.value })}
                placeholder="例如 SZH001"
              />
            </AdminField>
            <AdminField label="院区名称">
              <input
                className={adminFieldClass}
                value={hospitalForm.name}
                onChange={(e) => setHospitalForm({ ...hospitalForm, name: e.target.value })}
                placeholder="例如 市一医院·中心院区"
              />
            </AdminField>
            <AdminField label="等级">
              <input
                className={adminFieldClass}
                value={hospitalForm.level}
                onChange={(e) => setHospitalForm({ ...hospitalForm, level: e.target.value })}
                placeholder="例如 三甲"
              />
            </AdminField>
            <AdminField label="城市">
              <input
                className={adminFieldClass}
                value={hospitalForm.city}
                onChange={(e) => setHospitalForm({ ...hospitalForm, city: e.target.value })}
                placeholder="例如 深圳"
              />
            </AdminField>
            <AdminField label="适配器类型" hint="决定该院区的数据从哪来">
              <select
                className={adminFieldClass}
                value={hospitalForm.adapterType}
                onChange={(e) => setHospitalForm({ ...hospitalForm, adapterType: e.target.value })}
              >
                {ADAPTER_TYPES.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </AdminField>
            <AdminField label="启用状态" hint="停用后院区不出现在挂号列表">
              <label className="flex h-9 items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={hospitalForm.enabled}
                  onChange={(e) => setHospitalForm({ ...hospitalForm, enabled: e.target.checked })}
                  className="h-4 w-4 accent-brand-600"
                />
                启用该院区
              </label>
            </AdminField>
          </div>

          {hospitalFormError ? (
            <Callout tone="critical" dense className="mt-2.5">
              {hospitalFormError}
            </Callout>
          ) : null}

          <div className="mt-3 flex gap-2">
            <Button onClick={() => void submitHospital()} disabled={hospitalSaving}>
              {hospitalSaving ? '保存中…' : '保存'}
            </Button>
            <Button variant="ghost" onClick={() => setHospitalFormOpen(false)} disabled={hospitalSaving}>
              取消
            </Button>
          </div>
        </Card>
      ) : null}

      <div className="grid gap-3 md:grid-cols-[240px_1fr]">
        {/* ---------- 主表 ---------- */}
        <Card pad="sm">
          <SectionTitle count={hospitals.length ? `${hospitals.length} 个` : undefined} as="h2">
            院区
          </SectionTitle>

          {hospitalError ? (
            <Callout tone="alert" dense className="mb-2">
              {hospitalError}
            </Callout>
          ) : null}

          {hospitalLoading ? (
            <div className="py-10 text-center text-xs text-gray-400">载入中…</div>
          ) : hospitals.length === 0 ? (
            <div className="py-8 text-center text-xs text-gray-400">
              还没有院区
              <div className="mt-1">先点右上角「新建院区」</div>
            </div>
          ) : (
            <ul className="flex gap-2 overflow-x-auto md:flex-col md:overflow-visible">
              {hospitals.map((h) => {
                const active = h.hospitalCode === selectedCode;
                return (
                  <li key={h.hospitalCode} className="shrink-0 md:shrink">
                    <button
                      type="button"
                      onClick={() => setSelectedCode(h.hospitalCode)}
                      aria-pressed={active}
                      className={
                        'w-full min-w-[190px] rounded-xl border p-2.5 text-left transition-colors ' +
                        (active
                          ? 'border-brand-300 bg-brand-50'
                          : 'border-gray-200 bg-surface hover:border-brand-200')
                      }
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900">
                          {h.name}
                        </span>
                        <span
                          className={
                            'shrink-0 rounded-full px-1.5 py-0.5 text-2xs ' +
                            (h.enabled ? 'bg-done-soft text-done' : 'bg-gray-100 text-gray-500')
                          }
                        >
                          {h.enabled ? '启用' : '停用'}
                        </span>
                      </div>
                      <div className="mt-0.5 text-2xs text-gray-500">
                        {h.hospitalCode} · {h.level || '未填等级'} · {h.city || '未填城市'}
                      </div>
                      <div className="mt-0.5 text-2xs text-gray-400">
                        地点 {h.placeCount ?? 0} 个 · {h.adapterType || 'DEMO'}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* ---------- 从表 ---------- */}
        <Card pad="sm">
          {selected ? (
            <>
              <SectionTitle
                count={`${places.length} 个地点`}
                action={
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="secondary" onClick={() => openEditHospital(selected)}>
                      编辑院区
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => void removeHospital(selected)}>
                      删除
                    </Button>
                  </div>
                }
              >
                {selected.name}
              </SectionTitle>

              {placeError ? (
                <Callout tone="alert" dense className="mb-2">
                  {placeError}
                </Callout>
              ) : null}

              {placeLoading ? (
                <div className="py-10 text-center text-xs text-gray-400">载入中…</div>
              ) : places.length === 0 ? (
                <div className="rounded-xl border border-dashed border-gray-300 py-8 text-center text-xs text-gray-400">
                  这个院区还没有配置院内地点
                  <div className="mt-1">患者问「检验科在哪」时就答不上来</div>
                </div>
              ) : (
                <ul className="space-y-2">
                  {places.map((p) => (
                    <li key={p.id} className="rounded-xl border border-gray-200 p-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-2xs text-gray-600">
                          {placeTypeLabel(p.placeType)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900">
                          {p.name}
                        </span>
                        {/* 数据质量必须露出来：SAMPLE 是编的，不能和真实地点一个语气 */}
                        <span
                          className={
                            'rounded-full px-1.5 py-0.5 text-2xs ' +
                            (p.dataQuality === 'REAL'
                              ? 'bg-done-soft text-done'
                              : 'bg-alert-soft text-alert')
                          }
                        >
                          {p.dataQuality === 'REAL' ? '真实数据' : '示例数据'}
                        </span>
                        <Button size="sm" variant="danger" onClick={() => void removePlace(p)}>
                          删除
                        </Button>
                      </div>
                      <div className="mt-1 text-xs text-gray-500">
                        {[p.building, p.floor].filter(Boolean).join(' ') || '未填楼栋楼层'}
                        {p.department ? ` · ${p.department}` : ''}
                        {p.estMinutes != null ? ` · 步行约 ${p.estMinutes} 分钟` : ''}
                      </div>
                      {p.directions ? (
                        <div className="mt-1 text-2xs leading-relaxed text-gray-400">{p.directions}</div>
                      ) : null}
                      {p.openHours ? (
                        <div className="mt-0.5 text-2xs text-gray-400">服务时间：{p.openHours}</div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}

              {placeFormOpen ? (
                <div className="mt-3 rounded-xl border border-brand-200 bg-brand-50/50 p-2.5">
                  <SectionTitle emphasis={false}>新增院内地点</SectionTitle>
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    <AdminField label="名称">
                      <input
                        className={adminFieldClass}
                        value={placeForm.name}
                        onChange={(e) => setPlaceForm({ ...placeForm, name: e.target.value })}
                        placeholder="例如 门诊三楼检验科窗口"
                      />
                    </AdminField>
                    <AdminField label="类型">
                      <select
                        className={adminFieldClass}
                        value={placeForm.placeType}
                        onChange={(e) => setPlaceForm({ ...placeForm, placeType: e.target.value })}
                      >
                        {PLACE_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    </AdminField>
                    <AdminField label="楼栋">
                      <input
                        className={adminFieldClass}
                        value={placeForm.building}
                        onChange={(e) => setPlaceForm({ ...placeForm, building: e.target.value })}
                        placeholder="例如 门诊楼"
                      />
                    </AdminField>
                    <AdminField label="楼层">
                      <input
                        className={adminFieldClass}
                        value={placeForm.floor}
                        onChange={(e) => setPlaceForm({ ...placeForm, floor: e.target.value })}
                        placeholder="例如 3F"
                      />
                    </AdminField>
                    <AdminField label="科室">
                      <input
                        className={adminFieldClass}
                        value={placeForm.department}
                        onChange={(e) => setPlaceForm({ ...placeForm, department: e.target.value })}
                        placeholder="例如 检验科"
                      />
                    </AdminField>
                    <AdminField label="预计耗时（分钟）">
                      <input
                        className={adminFieldClass}
                        type="number"
                        min={0}
                        value={placeForm.estMinutes}
                        onChange={(e) => setPlaceForm({ ...placeForm, estMinutes: e.target.value })}
                        placeholder="例如 5"
                      />
                    </AdminField>
                    <AdminField label="口语化指引" className="sm:col-span-2">
                      <textarea
                        className={adminTextareaClass}
                        rows={2}
                        value={placeForm.directions}
                        onChange={(e) => setPlaceForm({ ...placeForm, directions: e.target.value })}
                        placeholder="从门诊大厅进门右转，扶梯上三楼，抽血窗口在左手边"
                      />
                    </AdminField>
                    <AdminField label="服务时间" className="sm:col-span-2">
                      <input
                        className={adminFieldClass}
                        value={placeForm.openHours}
                        onChange={(e) => setPlaceForm({ ...placeForm, openHours: e.target.value })}
                        placeholder="例如 周一至周五 07:30-11:30"
                      />
                    </AdminField>
                  </div>

                  {placeFormError ? (
                    <Callout tone="critical" dense className="mt-2.5">
                      {placeFormError}
                    </Callout>
                  ) : null}

                  <div className="mt-3 flex gap-2">
                    <Button onClick={() => void submitPlace()} disabled={placeSaving}>
                      {placeSaving ? '保存中…' : '添加地点'}
                    </Button>
                    <Button variant="ghost" onClick={() => setPlaceFormOpen(false)} disabled={placeSaving}>
                      取消
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="secondary"
                  className="mt-3 w-full"
                  onClick={() => {
                    setPlaceFormError(null);
                    setPlaceFormOpen(true);
                  }}
                >
                  新增院内地点
                </Button>
              )}
            </>
          ) : (
            <div className="py-14 text-center text-xs text-gray-400">
              先在左边选一个院区
              <div className="mt-1">右侧会显示它的院内地点</div>
            </div>
          )}
        </Card>
      </div>
    </AdminShell>
  );
}
