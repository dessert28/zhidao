/* ------------------------------------------------------------------
 * 注册页
 *
 * 手机号即登录名，提交走 POST /api/auth/register。后端注册成功即签发
 * token（见 lib/api.ts register()），因此注册完直接进首页，不再回登录页。
 * ------------------------------------------------------------------ */

import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import AuthLayout, {
  AgreementCheckbox,
  AuthSubmitButton,
  DemoHint,
  TextField,
} from '../components/auth/AuthLayout';
import {
  EyeIcon,
  EyeOffIcon,
  LockIcon,
  PhoneIcon,
  UserIcon,
} from '../components/ui/icons';
import { useAgreementLinks } from '../hooks/useAgreements';
import { failureMessage, register } from '../lib/api';

type Errors = {
  name?: string;
  phone?: string;
  password?: string;
  confirm?: string;
  agreed?: string;
  form?: string;
};

export default function RegisterPage() {
  const navigate = useNavigate();
  const agreements = useAgreementLinks();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [submitting, setSubmitting] = useState(false);

  function clearError(key: keyof Errors) {
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const next: Errors = {};
    if (!name.trim()) next.name = '请填写姓名';
    if (!/^1\d{10}$/.test(phone.trim())) next.phone = '请输入 11 位手机号';
    if (password.length < 6) next.password = '密码至少 6 位';
    if (confirm !== password || !confirm) next.confirm = '两次输入的密码不一致';
    if (!agreed) next.agreed = '请先阅读并同意用户协议与隐私政策';
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setSubmitting(true);
    const r = await register(name.trim(), phone.trim(), password);
    if (!r.ok) {
      setErrors({ form: failureMessage(r.failure) });
      setSubmitting(false);
      return;
    }
    // 后端已签发 token 并存入 sessionStorage，直接进首页
    navigate('/', { replace: true });
  }

  const passwordTrailing = (
    <button
      type="button"
      onClick={() => setShowPassword((s) => !s)}
      className="rounded p-1 text-gray-400 transition-colors hover:text-gray-700"
      aria-label={showPassword ? '隐藏密码' : '显示密码'}
    >
      {showPassword ? <EyeOffIcon size={17} /> : <EyeIcon size={17} />}
    </button>
  );

  return (
    <AuthLayout
      title="注册账号"
      subtitle="填写基本信息，为自己和家人建立一份连续的就诊档案"
      footer={
        <>
          已有账号？{' '}
          <Link to="/login" className="font-medium text-brand-700 hover:underline">
            返回登录
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <DemoHint>手机号即登录名，注册成功后直接进入系统。</DemoHint>

        {errors.form ? (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700"
          >
            {errors.form}
          </div>
        ) : null}

        <TextField
          id="name"
          label="姓名"
          autoComplete="name"
          placeholder="请输入姓名"
          value={name}
          onChange={(v) => {
            setName(v);
            clearError('name');
          }}
          error={errors.name}
          disabled={submitting}
          icon={<UserIcon size={17} />}
        />

        <TextField
          id="phone"
          label="手机号"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          maxLength={11}
          placeholder="请输入 11 位手机号"
          value={phone}
          onChange={(v) => {
            setPhone(v);
            clearError('phone');
          }}
          error={errors.phone}
          disabled={submitting}
          icon={<PhoneIcon size={17} />}
        />

        <TextField
          id="password"
          label="密码"
          type={showPassword ? 'text' : 'password'}
          autoComplete="new-password"
          placeholder="至少 6 位"
          value={password}
          onChange={(v) => {
            setPassword(v);
            clearError('password');
          }}
          error={errors.password}
          disabled={submitting}
          icon={<LockIcon size={17} />}
          trailing={passwordTrailing}
        />

        <TextField
          id="confirm"
          label="确认密码"
          type={showPassword ? 'text' : 'password'}
          autoComplete="new-password"
          placeholder="再输入一次密码"
          value={confirm}
          onChange={(v) => {
            setConfirm(v);
            clearError('confirm');
          }}
          error={errors.confirm}
          disabled={submitting}
          icon={<LockIcon size={17} />}
          trailing={passwordTrailing}
        />

        <AgreementCheckbox
          checked={agreed}
          onChange={(v) => {
            setAgreed(v);
            clearError('agreed');
          }}
          agreements={agreements}
          error={errors.agreed}
        />

        <AuthSubmitButton disabled={submitting}>
          {submitting ? '注册中…' : '注册并登录'}
        </AuthSubmitButton>
      </form>
    </AuthLayout>
  );
}
