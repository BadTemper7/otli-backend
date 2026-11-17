"use strict";

// Dashboard reporting dates are calendar days in the Philippines (UTC+08:00).
// Never parse YYYY-MM-DD using the server machine's local timezone.
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const VALID_PERIODS = new Set(["daily", "weekly", "monthly", "yearly", "custom"]);

const toUtcFromManilaParts = (year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0) =>
  new Date(Date.UTC(year, month, day, hour, minute, second, millisecond) - MANILA_OFFSET_MS);

const getManilaParts = (date) => {
  const local = new Date(date.getTime() + MANILA_OFFSET_MS);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth(),
    day: local.getUTCDate(),
    hour: local.getUTCHours(),
  };
};

const parseManilaCalendarDate = (value, label) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError(`${label} must use YYYY-MM-DD.`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1970 || year > 9999 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new RangeError(`${label} must be a valid calendar date.`);
  }
  return { year, month: month - 1, day };
};

const getDashboardRange = (periodValue = "daily", now = new Date(), startDate, endDate) => {
  const period = VALID_PERIODS.has(periodValue) ? periodValue : "daily";
  const today = getManilaParts(now);
  if (period === "custom") {
    const from = parseManilaCalendarDate(startDate, "startDate");
    const to = parseManilaCalendarDate(endDate, "endDate");
    const start = toUtcFromManilaParts(from.year, from.month, from.day);
    const endExclusive = toUtcFromManilaParts(to.year, to.month, to.day + 1);
    const endOfDay = new Date(endExclusive.getTime() - 1);
    if (start > endOfDay) throw new RangeError("startDate cannot be later than endDate.");
    const todayStart = toUtcFromManilaParts(today.year, today.month, today.day);
    if (endOfDay < todayStart) return { period, start, end: endOfDay };
    if (start > now || endExclusive > todayStart.getTime() + DAY_MS) {
      throw new RangeError("Custom date range cannot include future calendar dates.");
    }
    // The current day's data is only available through the request's current time.
    return { period, start, end: now };
  }

  const { year, month, day } = today;
  let start;
  if (period === "yearly") start = toUtcFromManilaParts(year, 0, 1);
  else if (period === "monthly") start = toUtcFromManilaParts(year, month, 1);
  else if (period === "weekly") {
    const weekday = new Date(now.getTime() + MANILA_OFFSET_MS).getUTCDay();
    start = toUtcFromManilaParts(year, month, day - (weekday === 0 ? 6 : weekday - 1));
  } else start = toUtcFromManilaParts(year, month, day);
  return { period, start, end: now };
};

const formatBucketLabel = (date, options) => new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Manila",
  ...options,
}).format(date);

const getDashboardBuckets = (range) => {
  const buckets = [];
  const first = getManilaParts(range.start);
  const last = getManilaParts(range.end);
  const dayCount = Math.floor((toUtcFromManilaParts(last.year, last.month, last.day) -
    toUtcFromManilaParts(first.year, first.month, first.day)) / DAY_MS) + 1;
  const sameDay = dayCount === 1;
  const granularity = range.period === "daily" || (range.period === "custom" && sameDay)
    ? "hour"
    : range.period === "yearly" || (range.period === "custom" && dayCount > 92 && dayCount <= 1827)
      ? "month"
      : range.period === "custom" && dayCount > 1827
        ? "year"
        : "day";

  const addBucket = (key, label, calendarStart, calendarEnd) => {
    const start = new Date(Math.max(calendarStart.getTime(), range.start.getTime()));
    const end = new Date(Math.min(calendarEnd.getTime(), range.end.getTime()));
    if (start <= end) buckets.push({ key, label, start, end });
  };

  if (granularity === "hour") {
    for (let hour = first.hour; hour <= last.hour; hour += 1) {
      const start = toUtcFromManilaParts(first.year, first.month, first.day, hour);
      const end = toUtcFromManilaParts(first.year, first.month, first.day, hour, 59, 59, 999);
      addBucket(`${first.year}-${first.month + 1}-${first.day}-${hour}`,
        formatBucketLabel(start, { hour: "numeric" }), start, end);
    }
  } else if (granularity === "year") {
    for (let year = first.year; year <= last.year; year += 1) {
      const start = toUtcFromManilaParts(year, 0, 1);
      const end = new Date(toUtcFromManilaParts(year + 1, 0, 1).getTime() - 1);
      addBucket(`${year}`, `${year}`, start, end);
    }
  } else if (granularity === "month") {
    for (let year = first.year, month = first.month; year < last.year || (year === last.year && month <= last.month);) {
      const start = toUtcFromManilaParts(year, month, 1);
      const end = new Date(toUtcFromManilaParts(year, month + 1, 1).getTime() - 1);
      addBucket(`${year}-${month + 1}`,
        formatBucketLabel(start, range.period === "custom" ? { month: "short", year: "2-digit" } : { month: "short" }),
        start, end);
      month += 1;
      if (month === 12) { year += 1; month = 0; }
    }
  } else {
    let cursor = toUtcFromManilaParts(first.year, first.month, first.day);
    while (cursor <= range.end) {
      const day = getManilaParts(cursor);
      const nextDay = toUtcFromManilaParts(day.year, day.month, day.day + 1);
      addBucket(`${day.year}-${day.month + 1}-${day.day}`,
        formatBucketLabel(cursor, range.period === "weekly" ? { weekday: "short", day: "numeric" } : { month: "short", day: "numeric" }),
        cursor, new Date(nextDay.getTime() - 1));
      cursor = nextDay;
    }
  }
  return { granularity, buckets };
};

module.exports = { getDashboardRange, getDashboardBuckets, parseManilaCalendarDate, toUtcFromManilaParts, getManilaParts };
