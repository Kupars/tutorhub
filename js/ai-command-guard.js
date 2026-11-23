// 白名单式执行自然语言后台指令。模型只能提议，不能直接运行任意代码或批量删除数据。
const text = (v) => String(v ?? "").trim();
const THEME = new Set(["indigo","emerald","amber","rose"]);
const STATUS = new Set(["招募中","已匹配","已结束"]);
export function guardSiteActions(response, command, orders) {
  const words = text(command);
  const allowed = Array.isArray(response?.actions) ? response.actions.slice(0, 10) : [];
  const actions = [];
  const discarded = [];
  const orderList = Array.isArray(orders) ? orders : [];
  for (const action of allowed) {
    if (!action || typeof action !== "object") continue;
    const patch = action.patch && typeof action.patch === "object" ? action.patch : {};
    if (action.type === "update_site") {
      const clean = {};
      if (/公告|通知/.test(words) && typeof patch.announcement === "string" && patch.announcement.trim().length <= 500) {
        clean.announcement = patch.announcement.trim();
      }
      if (/主题|颜色|配色|换成.*色|改成.*色/.test(words) && THEME.has(patch.theme)) clean.theme = patch.theme;
      if (Object.keys(clean).length) actions.push({ type:"update_site", patch:clean });
      else discarded.push("网站配置操作超出允许范围");
      continue;
    }
    if (action.type === "update_order") {
      const key = text(action.id);
      const order = orderList.find((o) => key && (text(o.id) === key || text(o.orderNumber) === key));
      // 目标单号必须在原始管理员指令里出现；模型不得“顺便”修改其他单。
      if (!order || ![text(order.id),text(order.orderNumber)].some((id)=>id && words.includes(id))) {
        discarded.push("订单编号不匹配");
        continue;
      }
      const clean = {};
      if (STATUS.has(patch.status) && /上架|招募|下架|关闭|结束|匹配|招满|恢复/.test(words)) {
        clean.status = patch.status;
      }
      const rate = Number(patch.hourlyRate);
      if (/薪资|时薪|课时费|价格|报价/.test(words) && Number.isFinite(rate) && rate >= 30 && rate <= 1000 &&
        new RegExp(`(?:^|[^\\d])${rate}(?:元|块|\\s*(?:每小时|一小时|\\/小时))`).test(words)) {
        clean.hourlyRate = rate;
        clean.salaryText = `${rate}元/小时（可报价）`;
      }
      if (Object.keys(clean).length) actions.push({type:"update_order",id:order.id,patch:clean});
      else discarded.push("订单修改缺少可核对的条件");
      continue;
    }
    discarded.push("不支持的修改类型");
  }
  return {actions, discarded};
}
