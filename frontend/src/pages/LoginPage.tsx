/* ------------------------------------------------------------------
 * 登录页
 *
 * 登录名可能是手机号（患者）或用户名（院方管理员 / 医生）。
 * 提交走 POST /api/auth/login（见 lib/api.ts）。
 * 登录成功后 token 由 api.ts 存进 sessionStorage，后续业务接口自动带上；
 * 失败信息（含"后端未启动"）直接显示在表单里，不静默失败。
 * ------------------------------------------------------------------ */

import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import AuthLayout, {
  AgreementCheckbox,
  AuthSubmitButton,
  DemoHint,
  TextField,
} from '../components/auth/AuthLayout';
import {
  CheckIcon,
  EyeIcon,
  EyeOffIcon,
  LockIcon,
  PhoneIcon,
} from '../components/ui/icons';
import { useAgreementLinks } from '../hooks/useAgreements';
import { clearSignedOut, failureMessage, login } from '../lib/api';

type Status = 'idle' | 'submitting' | 'done';
type LoginState = {
  from?: string;
  registeredPhone?: string;
};

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state ?? null) as LoginState | null;
  const agreements = useAgreementLinks();

  const [phone, setPhone] = useState(state?.registeredPhone ?? '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [errors, setErrors] = useState<{
    phone?: string;
    password?: string;
    agreed?: string;
    form?: string;
  }>({});
  const [status, setStatus] = useState<Status>('idle');

  // 登录成功后要回到的位置：被别的页面拦过来时记在 state.from 里
  const target = state?.from ?? '/';

  // demo 的"成功"状态只停留片刻，随后进首页。清理定时器避免卸载后仍跳转。
  useEffect(() => {
    if (status !== 'done') return;
    const timer = window.setTimeout(() => navigate(target, { replace: true }), 650);
    return () => window.clearTimeout(timer);
  }, [status, navigate, target]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    /*
     * 登录名有两种：手机号，或用户名。
     *
     * 账号体系里院方管理员与医生用的是用户名（admin / doctor），
     * 只有患者走手机号注册 —— 所以这里必须同时接受两种写法。
     *
     * 放宽的**只是前端的格式提示**，不是安全校验：后端照旧按 username
     * 查库、用 BCrypt 比对密码，前端这一行挡不住任何人，也放不过任何人。
     * 别因为"登录名不像手机号"就把这段改回去。
     */
    const id = phone.trim();
    const isPhone = /^1\d{10}$/.test(id);
    const isUsername = /^[A-Za-z0-9_]{3,32}$/.test(id);
    if (!isPhone && !isUsername) next.phone = '请输入 11 位手机号或用户名（3-32 位字母数字）';
    if (password.length < 6) next.password = '密码至少 6 位';
    if (!agreed) next.agreed = '请先阅读并同意用户协议与隐私政策';
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setStatus('submitting');
    const r = await login(phone.trim(), password);
    if (!r.ok) {
      setErrors({ form: failureMessage(r.failure) });
      setStatus('idle');
      return;
    }
    setStatus('done');
  }

  const busy = status !== 'idle';

  return (
    <AuthLayout
      title="登录"
      subtitle="登录后即可查看今日用药、复诊提醒与就诊记录"
      footer={
        <>
          还没有账号？{' '}
          <Link to="/register" className="font-medium text-brand-700 hover:underline">
            立即注册
          </Link>
          <span className="mx-2 text-gray-300">·</span>
          {/*
            「先逛逛」= 以演示身份继续，所以要先解除退出标记，
            否则会被 App 的守卫弹回登录页，形成死循环。
          */}
          <button
            type="button"
            onClick={() => {
              clearSignedOut();
              navigate('/', { replace: true });
            }}
            className="text-gray-500 hover:text-gray-800"
          >
            先逛逛
          </button>
        </>
      }
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        {state?.registeredPhone ? (
          <DemoHint>注册成功，已为你填好手机号，输入密码即可登录。</DemoHint>
        ) : (
          <DemoHint>先用演示账号体验，或注册自己的账号。</DemoHint>
        )}

        {errors.form ? (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700"
          >
            {errors.form}
          </div>
        ) : null}

        <TextField
          id="phone"
          label="手机号 / 用户名"
          type="text"
          autoComplete="username"
          maxLength={32}
          placeholder="请输入手机号或用户名"
          value={phone}
          onChange={(v) => {
            setPhone(v);
            if (errors.phone) setErrors((e) => ({ ...e, phone: undefined }));
          }}
          error={errors.phone}
          disabled={busy}
          icon={<PhoneIcon size={17} />}
        />

        <TextField
          id="password"
          label="密码"
          type={showPassword ? 'text' : 'password'}
          autoComplete="current-password"
          placeholder="请输入密码"
          value={password}
          onChange={(v) => {
            setPassword(v);
            if (errors.password) setErrors((e) => ({ ...e, password: undefined }));
          }}
          error={errors.password}
          disabled={busy}
          icon={<LockIcon size={17} />}
          trailing={
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              className="rounded p-1 text-gray-400 transition-colors hover:text-gray-700"
              aria-label={showPassword ? '隐藏密码' : '显示密码'}
            >
              {showPassword ? <EyeOffIcon size={17} /> : <EyeIcon size={17} />}
            </button>
          }
        />

        <AgreementCheckbox
          checked={agreed}
          onChange={(v) => {
            setAgreed(v);
            if (errors.agreed) setErrors((e) => ({ ...e, agreed: undefined }));
          }}
          agreements={agreements}
          error={errors.agreed}
        />

        {status === 'done' ? (
          <div className="flex items-center justify-center gap-2 rounded-lg bg-brand-50 py-2.5 text-sm text-brand-800">
            <CheckIcon size={16} /> 登录成功，正在进入…
          </div>
        ) : (
          <AuthSubmitButton disabled={busy}>
            {status === 'submitting' ? '登录中…' : '登录'}
          </AuthSubmitButton>
        )}
      </form>
    </AuthLayout>
  );
}
