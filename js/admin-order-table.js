export function sortAdminOrders(orders, direction="desc") {
  const collator=new Intl.Collator("zh-CN",{numeric:true,sensitivity:"base"});
  const parse=o=>String(o.orderNumber||o.id||"").trim().match(/^#?(\d+)(?:-(\d+))?$/);
  return [...orders].sort((a,b)=>{
    const x=parse(a),y=parse(b);
    if(!x&&!y)return collator.compare(String(a.orderNumber||a.id||""),String(b.orderNumber||b.id||""))||collator.compare(String(a.id),String(b.id));
    if(!x)return 1;
    if(!y)return -1;
    const cmp=Number(x[1])-Number(y[1])||Number(x[2]||0)-Number(y[2]||0);
    return (direction==="asc"?cmp:-cmp)||collator.compare(String(a.id),String(b.id));
  });
}
