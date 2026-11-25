import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sortAdminOrders } from "../js/admin-order-table.js";
const items=[{id:"fs-1",orderNumber:"#9"},{id:"fs-2",orderNumber:"#100"},{id:"fs-3",orderNumber:"#100-2"},{id:"fs-4",orderNumber:"#100-10"},{id:"fs-5"},{id:"fs-6",orderNumber:"#100-1"}];
test("sort by business number and numeric suffix, retaining stable internal IDs",()=>{
  assert.deepEqual(sortAdminOrders(items,"asc").map(o=>o.id),["fs-1","fs-2","fs-6","fs-3","fs-4","fs-5"]);
  assert.deepEqual(sortAdminOrders(items,"desc").map(o=>o.id),["fs-4","fs-3","fs-6","fs-2","fs-1","fs-5"]);
  assert.equal(items[0].id,"fs-1");
});
test("admin table keeps bulk and per-row controls with business number display",()=>{
  const app=readFileSync(new URL("../js/app.js",import.meta.url),"utf8");
  for(const marker of ["admin-order-table","btnAdminSortNumber","adminPageCheckbox","data-toggle-status","data-del-order","data-edit-order","adminCheckedOrders.delete(order.id)","sortAdminOrders(adminFilteredOrders,state.adminOrderSort).slice"])assert.ok(app.includes(marker),marker);
});
