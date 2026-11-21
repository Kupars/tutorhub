// 站点运行时环境配置（自动适配当前访问域名，也可按需追加备用节点）
export const APP_CONFIG = {
  cloudBaseUrl: "",
  cloudPublicAnon: "",
  apiBase: "/api",
  nodes: [],
  presetLocations: [
    { name: "天津大学·卫津路校区", lat: 39.1095, lng: 117.1731 },
    { name: "天津大学·北洋园校区", lat: 38.9998, lng: 117.3137 },
    { name: "南开大学·八里台校区", lat: 39.1032, lng: 117.1695 },
    { name: "天津站（市中心枢纽）", lat: 39.1353, lng: 117.2102 },
    { name: "北京海淀·中关村", lat: 39.9834, lng: 116.3184 },
    { name: "上海徐汇·徐家汇", lat: 31.1951, lng: 121.4381 }
  ]
};
