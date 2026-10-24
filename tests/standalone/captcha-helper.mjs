/**
 * 图片验证码测试辅助：在 CAPTCHA_MODE=test 下求解挑战（答案固定 TESTS）。
 * 面板需以 CAPTCHA_MODE=test 启动（见各测试 startPanel env）。
 */
export async function solveCaptcha(base) {
  const response = await fetch(`${base}/api/captcha/challenge`);
  if (!response.ok) throw new Error(`captcha challenge failed: ${response.status}`);
  const { challenge } = await response.json();
  return { challenge, answer: 'TESTS' };
}
