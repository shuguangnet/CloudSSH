/**
 * 与主路由一致的 CSRF 放行规则:Origin 匹配 BASE_URL、Host 或
 * X-Forwarded-Host 任一即视为同源。
 *
 * BASE_URL 是部署时登记的对外地址,但用户可能经 SSH 隧道用 localhost、
 * 或经反代用域名访问面板——这些场景下浏览器 Origin 与 BASE_URL 不同,
 * 却与实际请求目标一致。主 HTTP 路由(originAllowed)早已按此放行,
 * automation/docker 等子路由必须复用同一规则,否则隧道/反代访问时
 * POST 全部 403(如「加载日志失败: Invalid origin」)。
 */
export function originAllowed(originHeader, hostHeader, forwardedHostHeader, baseUrl) {
  if (!originHeader) return false;
  if (originHeader === baseUrl) return true;
  let originHost;
  try { originHost = new URL(originHeader).host.toLowerCase(); } catch { return false; }
  if (originHost === String(hostHeader || '').toLowerCase()) return true;
  const first = String(forwardedHostHeader || '').split(',')[0].trim().toLowerCase();
  return !!first && originHost === first;
}
