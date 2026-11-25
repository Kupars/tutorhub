import test from "node:test";
import assert from "node:assert/strict";
import {parseOrderDuration,reconcileOrderDuration} from "../js/order-duration.js";
import {normalizeOrder,formatOrderText,parseFormattedOrder} from "../js/order-format.js";
import {cardSchedule} from "../js/card-presentation.js";
import {importOrderTable} from "../js/order-import.js";
test("fixed and ranged durations remain faithful",()=>{
  assert.equal(parseOrderDuration("1～2小时"),"1～2");
  assert.equal(parseOrderDuration("1.5-2小时"),"1.5～2");
  assert.equal(parseOrderDuration(2),2);
  assert.equal(parseOrderDuration("20:00—22:30"),null);
  assert.equal(parseOrderDuration("2～1小时"),null);
  assert.equal(normalizeOrder({}).hoursPerSession,"待协商");
});
test("recover the screenshot pattern without dropping unrelated notes",()=>{
  const order=normalizeOrder({id:"#3087",grade:"初三",subject:"数学",hoursPerSession:2,notes:"每次1～2小时。仅周中可约"});
  assert.equal(order.hoursPerSession,"1～2");
  assert.equal(order.notes,"仅周中可约");
  const text=formatOrderText(order);
  assert.ok(text.includes("【每次几小时】1～2小时"));
  assert.equal(parseFormattedOrder(text).hoursPerSession,"1～2");
  assert.equal(cardSchedule(order).duration,"1～2小时");
  assert.equal(reconcileOrderDuration(3,"每次1～2小时。").conflict,true);
  assert.equal(reconcileOrderDuration(2,"试课每次1小时。").notes,"试课每次1小时。");
});
test("table import preserves a range",()=>{
  const [order]=importOrderTable("年级,科目,每次几小时\n初三,数学,1～2小时");
  assert.equal(order.hoursPerSession,"1～2");
});
