import { beforeEach, describe, expect, it } from 'vitest';
import { setLocale } from '../frontend/src/i18n';
import {
  barStyle,
  formatBytes,
  formatRate,
  formatRateCompact,
  formatUptime,
  formatUptimeCompact,
  metricRow,
  percentCompact,
  percentText,
  renderStatusError,
  renderStatusMetrics,
  usageColor,
  usageLevel,
  type ServerStatusPayload,
} from '../frontend/src/status-view';

const PAYLOAD: ServerStatusPayload = {
  hostname: 'dm.us.933999.xyz',
  uptime_seconds: 2824574,
  cpu: { cores: 1, model: 'AMD EPYC 9654 96-Core Processor', usage_percent: 10.2, loadavg: [0.04, 0.03, 0.04] },
  memory: { total_bytes: 1011819008, used_bytes: 539860992, usage_percent: 53.4 },
  swap: { total_bytes: 1073741824, used_bytes: 214748365, usage_percent: 20 },
  disk: { total_bytes: 21003583488, used_bytes: 13730463744, available_bytes: 6226698240, usage_percent: 73 },
  network: { rx_bytes_per_sec: 46198, tx_bytes_per_sec: 52429 },
  os: 'Debian GNU/Linux 11 (bullseye) x86_64',
  latency_ms: 203,
};

describe('状态指标格式化', () => {
  beforeEach(() => setLocale('zh-CN', { persist: false }));

  it('字节按量级选择单位，缺失值统一为破折号', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
    expect(formatBytes(1073741824)).toBe('1.0 GB');
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });

  it('速率区分 B/s、KB/s 与 MB/s', () => {
    expect(formatRate(800)).toBe('800 B/s');
    expect(formatRate(46198)).toBe('45.1 KB/s');
    expect(formatRate(3 * 1024 * 1024)).toBe('3.00 MB/s');
    expect(formatRate(null)).toBe('—');
  });

  it('紧凑速率省掉小数与空格（状态栏胶囊宽度敏感）', () => {
    expect(formatRateCompact(800)).toBe('800B/s');
    expect(formatRateCompact(46198)).toBe('45KB/s');
    expect(formatRateCompact(3 * 1024 * 1024)).toBe('3.0MB/s');
    expect(formatRateCompact(null)).toBe('—');
  });

  it('运行时长按语言格式化，紧凑版只保留最大的两个单位', () => {
    expect(formatUptime(2824574)).toBe('32天16时36分');
    expect(formatUptimeCompact(2824574)).toBe('32d16h');
    expect(formatUptimeCompact(3 * 3600 + 25 * 60)).toBe('3h25m');
    expect(formatUptimeCompact(125)).toBe('2m');
    expect(formatUptimeCompact(-1)).toBe('—');
    expect(formatUptime(null)).toBe('—');

    setLocale('en-US', { persist: false });
    expect(formatUptime(2824574)).toBe('32d 16h 36m');
    expect(formatUptimeCompact(2824574)).toBe('32d16h');
  });

  it('用量分档在 70% / 90% 处切换，配色与文案一致', () => {
    expect(usageLevel(69.9)).toBe('ok');
    expect(usageLevel(70)).toBe('warn');
    expect(usageLevel(89.9)).toBe('warn');
    expect(usageLevel(90)).toBe('danger');
    expect(usageLevel(null)).toBe('ok');
    expect(usageColor(95)).toBe('var(--error)');
    expect(usageColor(75)).toBe('var(--warning, #e6a23c)');
    expect(usageColor(10)).toBe('var(--accent-secondary)');
  });

  it('进度条宽度被夹在 0–100 且缺失值不抛错', () => {
    expect(barStyle(73)).toContain('width:73.0%');
    expect(barStyle(150)).toContain('width:100.0%');
    expect(barStyle(-5)).toContain('width:0.0%');
    expect(barStyle(null)).toContain('width:0.0%');
  });

  it('百分比文本区分一位小数与取整两种呈现', () => {
    expect(percentText(53.44)).toBe('53.4%');
    expect(percentText(null)).toBe('—');
    expect(percentCompact(53.4)).toBe('53%');
    expect(percentCompact(null)).toBe('—');
  });
});

describe('状态指标渲染', () => {
  beforeEach(() => setLocale('zh-CN', { persist: false }));

  it('渲染完整指标，转义服务器名与主机名', () => {
    const html = renderStatusMetrics({ ...PAYLOAD, hostname: '<img src=x onerror=alert(1)>' }, 'vps');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
    expect(html).toContain('AMD EPYC 9654 96-Core Processor');
    expect(html).toContain('32天16时36分');
    expect(html).toContain('203ms');
    expect(html).toContain('45.1 KB/s');
    expect(html).toContain('51.2 KB/s');
  });

  it('缺失字段退化为破折号而不是 NaN 或空串', () => {
    const html = renderStatusMetrics(
      {
        hostname: null,
        uptime_seconds: null,
        cpu: { cores: null, model: null, usage_percent: null, loadavg: null },
        memory: null,
        swap: null,
        disk: null,
        network: null,
        os: null,
        latency_ms: 0,
      },
      'vps'
    );
    expect(html).toContain('vps');
    expect(html).not.toContain('NaN');
    expect(html).toContain('—');
  });

  it('错误视图带重试按钮与转义后的原始消息', () => {
    const html = renderStatusError('<b>boom</b>');
    expect(html).toContain('status-retry-btn');
    expect(html).toContain('&lt;b&gt;boom&lt;/b&gt;');
    expect(html).not.toContain('<b>boom</b>');
  });

  it('指标行可按需隐藏进度条', () => {
    expect(metricRow('load', null, '0.04, 0.03', false)).not.toContain('rounded-full bg-[var(--border)]');
    expect(metricRow('cpu', 50, '50.0%')).toContain('rounded-full bg-[var(--border)]');
    expect(metricRow('<x>', null, '<y>', false)).toContain('&lt;x&gt;');
  });
});
