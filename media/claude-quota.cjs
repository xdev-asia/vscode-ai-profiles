const { randomUUID } = require('node:crypto');
const { renameSync, unlinkSync, writeFileSync } = require('node:fs');
const { isAbsolute, join } = require('node:path');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (input.length > 256 * 1024) process.exit(0);
});
process.stdin.on('end', () => {
  const directory = process.env.CLAUDE_CONFIG_DIR;
  if (!directory || !isAbsolute(directory)) return;
  const temporary = join(directory, `.xdev-quota-${randomUUID()}.tmp`);
  try {
    const limits = JSON.parse(input).rate_limits;
    const windows = {};
    for (const id of ['five_hour', 'seven_day', 'spend_limit']) {
      const limit = limits?.[id];
      const used = limit?.used_percentage;
      if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 1000) continue;
      const reset = limit.resets_at;
      windows[id] = { used_percentage: used };
      if (typeof reset === 'number' && reset > 0 && reset < 253402300800) windows[id].resets_at = reset;
    }
    if (!Object.keys(windows).length) return;
    writeFileSync(temporary, JSON.stringify({ observedAt: Date.now(), rate_limits: windows }), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, join(directory, '.xdev-quota.json'));
    process.stdout.write(Object.entries(windows).map(([id, window]) => {
      const label = { five_hour: '5h', seven_day: '7d', spend_limit: 'Spend' }[id];
      return `${label} ${Math.round(window.used_percentage)}%`;
    }).join(' · '));
  } catch {
    try { unlinkSync(temporary); } catch { /* The snapshot may not have been written. */ }
  }
});
