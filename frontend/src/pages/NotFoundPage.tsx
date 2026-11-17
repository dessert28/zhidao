import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <div className="py-20 text-center">
      <div className="text-sm font-medium text-gray-700">页面不存在</div>
      <p className="mt-1.5 text-xs text-gray-400">链接可能已失效。</p>
      <Link
        to="/"
        className="mt-5 inline-flex h-10 items-center rounded-lg bg-action px-4 text-sm text-white"
      >
        回到问诊
      </Link>
    </div>
  );
}
