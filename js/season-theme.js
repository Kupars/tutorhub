// 按北京时间与中国传统“立春、立夏、立秋、立冬”自动选取主题。
// 21 世纪四个节气的日期近似公式，交节时刻附近可能有一天误差；
// 网站主题以当地日历日切换，不用于历法或其他需要精确时刻的场景。
const TERMS = {
  spring: { month: 2, constant: 3.87 },
  summer: { month: 5, constant: 5.52 },
  autumn: { month: 8, constant: 7.5 },
  winter: { month: 11, constant: 7.438 }
};

export const SEASON_DETAILS = Object.freeze({
  spring: { label: "春季", icon: "🌸", lightThemeColor: "#f2faf5" },
  summer: { label: "夏季", icon: "☀️", lightThemeColor: "#effbfc" },
  autumn: { label: "秋季", icon: "🍁", lightThemeColor: "#fbf7ef" },
  winter: { label: "冬季", icon: "❄️", lightThemeColor: "#f0f8ff" }
});

export function termDay(year, season) {
  const term = TERMS[season];
  if (!term) throw new Error(`Unknown season: ${season}`);
  const y = year % 100;
  return Math.floor(y * 0.2422 + term.constant) - Math.floor((y - 1) / 4);
}

export function getSeasonForDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = (type) => Number(parts.find((part) => part.type === type)?.value);
  const year = value("year");
  const monthDay = value("month") * 100 + value("day");
  if (monthDay < 200 + termDay(year, "spring")) return "winter";
  if (monthDay < 500 + termDay(year, "summer")) return "spring";
  if (monthDay < 800 + termDay(year, "autumn")) return "summer";
  if (monthDay < 1100 + termDay(year, "winter")) return "autumn";
  return "winter";
}
