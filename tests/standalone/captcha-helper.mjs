/**
 * 滑块验证码测试辅助：在 CAPTCHA_MODE=test 下求解挑战（目标固定 x=120）。
 * 面板需以 CAPTCHA_MODE=test 启动（见各测试 startPanel env）。
 */
export async function solveCaptcha(base) {
  const response = await fetch(`${base}/api/captcha/challenge`);
  if (!response.ok) throw new Error(`captcha challenge failed: ${response.status}`);
  const { challenge } = await response.json();
  const now = Date.now();
  return {
    challenge,
    x: 120,
    samples: [
      { x: 10, t: now },
      { x: 45, t: now + 150 },
      { x: 85, t: now + 300 },
      { x: 120, t: now + 450 },
    ],
  };
}
