export const DEFAULT_SITE_CONFIG = {
  siteName: "家教招募大厅",
  subtitle: "",
  announcement: "选中感兴趣的家教单加入清单，复制后微信联系小木同学。",
  theme: "indigo", // indigo | emerald | amber | rose
  contactWechat: "tutor_admin_01"
};

export const SUBJECTS = [
  "数学", "英语", "物理", "化学", "语文", "生物", "地理", "历史", "政治", "全科", "编程/竞赛"
];

export const GRADES = [
  "小学", "初一", "初二", "初三", "高一", "高二", "高三", "大学/考研"
];

export const SAMPLE_ORDERS = [
  {
    id: "JJ-2026-101",
    title: "高二数学提分冲刺（女学员·基础中等）",
    subject: "数学",
    grade: "高二",
    mode: "上门",
    district: "南开区",
    address: "南开区时代奥城小区",
    lat: 39.0762,
    lng: 117.1785,
    hourlyRate: 160,
    hoursPerSession: 2,
    sessionsPerWeek: 2,
    schedule: "周六上午 9:00-11:00，周三晚 19:00-21:00",
    genderPref: "不限",
    studentInfo: "女学员，目前数学 95/150 左右，解析几何和导数薄弱，性格乖巧配合度高。",
    requirements: "985/211 理工科在读或有高中数学带教经验，有耐心、擅长总结题型方法。",
    tags: ["急招", "交通便利", "长期稳定"],
    status: "招募中",
    urgent: true,
    createdAt: "2026-11-20T10:30:00Z"
  },
  {
    id: "JJ-2026-102",
    title: "初三物理+化学考前梳理（男学员）",
    subject: "物理",
    grade: "初三",
    mode: "上门",
    district: "和平区",
    address: "和平区五大道民园附近",
    lat: 39.1128,
    lng: 117.2044,
    hourlyRate: 140,
    hoursPerSession: 2,
    sessionsPerWeek: 2,
    schedule: "周五晚 18:30-20:30，周日下午 14:00-16:00",
    genderPref: "男老师优先",
    studentInfo: "男学员，力学与电学实验题失分较多，目标冲刺市五所高中。",
    requirements: "理化功底扎实，熟悉天津中考考点，善于引导解题思路。",
    tags: ["中考冲刺", "家长好沟通"],
    status: "招募中",
    urgent: true,
    createdAt: "2026-11-20T08:15:00Z"
  },
  {
    id: "JJ-2026-103",
    title: "小学五年级英语口语+阅读启蒙",
    subject: "英语",
    grade: "小学",
    mode: "线上",
    district: "线上授课",
    address: "腾讯会议线上授课",
    lat: null,
    lng: null,
    hourlyRate: 110,
    hoursPerSession: 1.5,
    sessionsPerWeek: 3,
    schedule: "周一/三/五晚 19:30-21:00（可微调）",
    genderPref: "女老师优先",
    studentInfo: "女学员，校内成绩优秀，希望拓展新概念英语二与自然拼读、口语表达。",
    requirements: "英语专业或雅思 7.0+ / 六级 580+，发音标准，课堂生动有互动。",
    tags: ["线上免通勤", "高频稳定"],
    status: "招募中",
    urgent: false,
    createdAt: "2026-11-19T16:40:00Z"
  },
  {
    id: "JJ-2026-104",
    title: "高一全科作业辅导与学习习惯培养",
    subject: "全科",
    grade: "高一",
    mode: "上门",
    district: "河西区",
    address: "河西区梅江生态居住区",
    lat: 39.0485,
    lng: 117.2116,
    hourlyRate: 150,
    hoursPerSession: 2,
    sessionsPerWeek: 3,
    schedule: "周二、周四晚 19:00-21:00，周日上午",
    genderPref: "不限",
    studentInfo: "刚升入高中不太适应数理化节奏，需要老师帮忙梳理错题本与周计划。",
    requirements: "名校本科或研究生，高考总分优异，有责任心。",
    tags: ["高薪", "长期"],
    status: "招募中",
    urgent: false,
    createdAt: "2026-11-19T09:20:00Z"
  },
  {
    id: "JJ-2026-105",
    title: "高三化学一轮复习专项拔高",
    subject: "化学",
    grade: "高三",
    mode: "均可",
    district: "津南区",
    address: "津南区海河教育园区附近",
    lat: 39.0122,
    lng: 117.3265,
    hourlyRate: 180,
    hoursPerSession: 2,
    sessionsPerWeek: 1,
    schedule: "周六下午 15:00-17:00",
    genderPref: "不限",
    studentInfo: "目前化学 78/100，想在有机推断与工艺流程大题上冲刺 90+。",
    requirements: "化学相关专业或有高三带教经验，北洋园校区老师非常方便。",
    tags: ["急招", "高薪", "近北洋园"],
    status: "招募中",
    urgent: true,
    createdAt: "2026-11-21T01:10:00Z"
  }
];
