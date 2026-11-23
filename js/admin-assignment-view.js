import { ageOfOpenOrder, recommendPastTeachers } from "./assignment-utils.js";
import { isPubliclyOpenOrder } from "./board-utils.js?v=4";

let activeOrderId = "";
let editingAssignmentId = "";
const h = (v) => String(v ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
const short = (v, n = 90) => String(v || "").slice(0, n);

export function renderAssignmentAdmin(orders, assignments, cloudReady) {
  const overdue = orders.filter(isPubliclyOpenOrder).map((order) => ({ order, age: ageOfOpenOrder(order) }))
    .filter(({ age }) => age?.kind === "overdue").sort((a,b) => b.age.days - a.age.days);
  const uncertain = orders.filter(isPubliclyOpenOrder).filter((order) => ageOfOpenOrder(order)?.kind === "unknown");
  const active = orders.find((order) => String(order.id) === activeOrderId);
  const previous = assignments.filter((item) => item.orderId === activeOrderId);
  const current = assignments.find((item) => item.id === editingAssignmentId && item.orderId === activeOrderId);
  const suggestions = active ? recommendPastTeachers(active, assignments, orders, 5) : [];
  const reminders = overdue.slice(0, 8).map(({order, age}) => {
    const matches = recommendPastTeachers(order, assignments, orders, 3);
    return `<div class="assignment-reminder-row">
      <div><strong>${h(order.orderNumber || order.id)}</strong> ${h(order.grade)}${h(order.subject)} <span class="assignment-age">${age.days}天未匹配</span>
      <small>${h(short(order.publicAddress || order.address || order.district,65))}</small>
      <small>${matches.length ? `可参考：${matches.map((p)=>h(p.teacherName)).join("、")}（需再次联系确认）` : "暂无相似历史接单老师"}</small></div>
      <button class="btn btn-sm" type="button" data-open-assignment="${h(order.id)}">跟进 / 登记</button>
    </div>`;
  }).join("");
  return `<div class="panel assignment-admin-panel" id="assignmentPanel">
    <h2>📒 老师接单登记与待匹配提醒</h2>
    <p class="admin-helper">仅管理员可见。老师由管理员手工登记，按历史接单的公开地区、科目推荐；不能据此判断老师实时位置或是否有空。</p>
    ${!cloudReady ? '<p class="admin-helper">请先连接 Cloudflare KV 云端存储，才能保存私人老师记录。</p>' : ""}
    <div class="assignment-stats">
      <span><strong>${assignments.length}</strong> 条历史匹配记录</span>
      <span><strong>${overdue.length}</strong> 条超过10天未匹配的新单</span>
      <span><strong>${uncertain.length}</strong> 条历史导入单发布日期未知</span>
    </div>
    <p class="admin-helper">提醒会在管理员打开后台时自动计算。历史导入日期不是实际发布日期，不会误报为“超时”；需要定时微信/邮件推送则需另外配置通知渠道。</p>
    ${reminders ? `<div class="assignment-reminders"><h3>需要跟进的家教单</h3>${reminders}</div>` : ""}
    <div class="assignment-editor">
      <h3>${active ? `登记老师 · ${h(active.orderNumber || active.id)} ${h(active.title)}` : "从下方订单管理中选择「登记老师」"}</h3>
      ${active ? `
        <form id="assignmentForm" class="assignment-form">
          <div class="field"><label for="assignmentName">老师姓名 / 称呼</label><input id="assignmentName" value="${h(current?.teacherName || "")}" maxlength="80" required placeholder="仅管理员使用" /></div>
          <div class="field"><label for="assignmentContact">微信号或联系方式（可选）</label><input id="assignmentContact" value="${h(current?.teacherContact || "")}" maxlength="120" placeholder="不用让老师注册，直接记录已知信息" /></div>
          <div class="field full"><label for="assignmentNote">备注（可选）</label><input id="assignmentNote" value="${h(current?.note || "")}" maxlength="500" placeholder="例如：已沟通试课，待家长反馈" /></div>
          <label class="assignment-check full"><input type="checkbox" id="assignmentCloseOrder" ${!isPubliclyOpenOrder(active) ? "" : "checked"} /> 同时将此单标记为已匹配，并从公开看板下架</label>
          <div class="full assignment-actions"><button class="btn btn-primary" type="submit" ${!cloudReady ? "disabled" : ""}>${current ? "保存老师信息" : "登记老师"}</button>
          ${current ? '<button class="btn btn-sm" type="button" id="assignmentCancelEdit">取消编辑</button>' : ""}</div>
        </form>
        <div class="assignment-history"><h4>本单已登记老师（${previous.length}）</h4>
        ${previous.length ? previous.map((entry)=>`<div class="assignment-history-entry"><span><strong>${h(entry.teacherName)}</strong> ${entry.teacherContact ? ` · ${h(entry.teacherContact)}` : ""} <small>${h(entry.note)}</small></span><div><button class="btn btn-sm" type="button" data-edit-assignment="${h(entry.id)}">编辑</button><button class="btn btn-sm" type="button" data-remove-assignment="${h(entry.id)}">移除</button></div></div>`).join("") : '<p class="admin-helper">暂无登记记录</p>'}</div>
        <div class="assignment-recommendations"><h4>相似历史接单老师</h4>
        ${suggestions.length ? suggestions.map((p)=>`<div class="assignment-suggestion"><strong>${h(p.teacherName)}</strong><span>${h(p.reason)} · 历史${p.totalOrders}单</span><small>${h(p.teacherContact || "未登记联系方式")}；请管理员自行核实是否愿意接单</small></div>`).join("") : '<p class="admin-helper">暂无匹配的历史接单记录，不能凭空推荐老师。</p>'}</div>
      ` : ""}
    </div>
  </div>`;
}

export function bindAssignmentAdmin(container, store, rerender, showToast) {
  const reveal = (orderId) => {
    activeOrderId = orderId;
    editingAssignmentId = "";
    rerender();
    document.getElementById("assignmentPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    document.getElementById("assignmentName")?.focus({ preventScroll: true });
  };
  container.querySelectorAll("[data-open-assignment]").forEach((button) => {
    button.onclick = () => reveal(button.dataset.openAssignment);
  });
  container.querySelectorAll("[data-edit-assignment]").forEach((button) => {
    button.onclick = () => {
      editingAssignmentId = button.dataset.editAssignment;
      rerender();
      document.getElementById("assignmentName")?.focus();
    };
  });
  document.getElementById("assignmentCancelEdit")?.addEventListener("click", () => { editingAssignmentId = ""; rerender(); });
  container.querySelectorAll("[data-remove-assignment]").forEach((button) => {
    button.onclick = async () => {
      if (!confirm("确定移除这条老师接单记录吗？该操作不会自动重新上架订单。")) return;
      try { await store.deleteAssignment(button.dataset.removeAssignment); editingAssignmentId = ""; rerender(); showToast("记录已移除"); }
      catch(err) { showToast(err.message); }
    };
  });
  const form = document.getElementById("assignmentForm");
  if (!form) return;
  form.onsubmit = async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await store.saveAssignment({
        orderId: activeOrderId,
        assignmentId: editingAssignmentId || undefined,
        teacherName: document.getElementById("assignmentName").value.trim(),
        teacherContact: document.getElementById("assignmentContact").value.trim(),
        note: document.getElementById("assignmentNote").value.trim(),
        markMatched: document.getElementById("assignmentCloseOrder").checked
      });
      editingAssignmentId = "";
      rerender();
      showToast("老师接单记录已保存" + (document.getElementById("assignmentCloseOrder")?.checked ? "，订单已下架" : ""));
    } catch (error) { showToast("保存失败：" + error.message); }
    finally { submit.disabled = false; }
  };
}
