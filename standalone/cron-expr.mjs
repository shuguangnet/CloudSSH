// Five-field cron expression parser (minute hour day-of-month month day-of-week),
// evaluated in the panel's local time with Vixie-cron day semantics.
const MONTH_NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DAY_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const FIELDS = [
  { key: 'minutes', label: 'minute', min: 0, max: 59 },
  { key: 'hours', label: 'hour', min: 0, max: 23 },
  { key: 'daysOfMonth', label: 'day of month', min: 1, max: 31 },
  { key: 'months', label: 'month', min: 1, max: 12, names: MONTH_NAMES },
  { key: 'daysOfWeek', label: 'day of week', min: 0, max: 7, names: DAY_NAMES },
];

function parseNumber(token, field) {
  const lowered = token.toLowerCase();
  if (field.names && field.names[lowered] !== undefined) {
    const value = field.names[lowered];
    if (field.key === 'daysOfWeek' && value === 7) return 0;
    return value;
  }
  if (!/^\d+$/.test(token)) return null;
  const value = Number(token);
  if (value < field.min || value > field.max) return null;
  return value;
}

function parsePart(part, field) {
  const [rangePart, stepPart] = part.split('/');
  if (part.includes('/') && (stepPart === undefined || !/^\d+$/.test(stepPart))) {
    throw new Error(`Invalid step in ${field.label} field: ${part}`);
  }
  const step = stepPart === undefined ? 1 : Number(stepPart);
  if (step < 1) throw new Error(`Invalid step in ${field.label} field: ${part}`);
  let low;
  let high;
  if (rangePart === '*') {
    low = field.min;
    high = field.max;
  } else if (rangePart.includes('-')) {
    const [startToken, endToken] = rangePart.split('-');
    const start = parseNumber(startToken, field);
    const end = parseNumber(endToken, field);
    if (start === null || end === null || start > end) {
      throw new Error(`Invalid range in ${field.label} field: ${part}`);
    }
    low = start;
    high = end;
  } else {
    const value = parseNumber(rangePart, field);
    if (value === null) throw new Error(`Invalid value in ${field.label} field: ${part}`);
    if (stepPart !== undefined) {
      low = value;
      high = field.max;
    } else {
      low = value;
      high = value;
    }
  }
  const values = new Set();
  for (let value = low; value <= high; value += step) {
    if (field.key === 'daysOfWeek' && value === 7) values.add(0);
    else values.add(value);
  }
  return values;
}

function parseField(field, raw) {
  const values = new Set();
  for (const part of raw.split(',')) {
    if (!part) throw new Error(`Empty item in ${field.label} field`);
    for (const value of parsePart(part, field)) values.add(value);
  }
  if (!values.size) throw new Error(`Empty ${field.label} field`);
  return values;
}

export function parseCron(expression) {
  if (typeof expression !== 'string' || expression.length > 100) throw new Error('Cron expression must be a short string');
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('Cron expression must have exactly 5 fields: minute hour day-of-month month day-of-week');
  const parsed = {};
  FIELDS.forEach((field, index) => {
    parsed[field.key] = parseField(field, parts[index]);
  });
  parsed.domAny = parts[2] === '*';
  parsed.dowAny = parts[4] === '*';
  return parsed;
}

export function isValidCron(expression) {
  try { parseCron(expression); return true; } catch { return false; }
}

/** Earliest strictly-after `from` matching time (local clock), or null beyond ~4 years. */
export function nextRun(expression, from = new Date()) {
  const parsed = typeof expression === 'string' ? parseCron(expression) : expression;
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  for (let guard = 0; guard < 300000; guard++) {
    if (!parsed.months.has(cursor.getMonth() + 1)) {
      cursor.setDate(1);
      cursor.setMonth(cursor.getMonth() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    const domMatch = parsed.daysOfMonth.has(cursor.getDate());
    const dowMatch = parsed.daysOfWeek.has(cursor.getDay());
    const dayMatch = parsed.domAny && parsed.dowAny ? true : parsed.domAny ? dowMatch : parsed.dowAny ? domMatch : domMatch || dowMatch;
    if (!dayMatch) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!parsed.hours.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!parsed.minutes.has(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
      continue;
    }
    return new Date(cursor);
  }
  return null;
}
