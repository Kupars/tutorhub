import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
test("white theme is default, retains explicit dark mode, and removes seasonal decoration",()=>{
 const css=read("css/styles.css"),boot=read("js/boot.js"),app=read("js/app.js"),html=read("index.html");
 assert.match(css,/--surface:#fff;/);
 assert.match(css,/--bg:#f8f9fa;/);
 assert(!css.includes('data-season='));
 assert(!boot.includes('dataset.season'));
 assert.match(app,/applyColorMode\(savedColorMode\(\) \|\| "light"\)/);
 assert.match(css,/:root\[data-color-mode="dark"\]/);
 assert(html.includes('styles.css?v=45')&&html.includes('boot.js?v=2'));
 for(const id of ["qSearch","qSort","btnToggleFilters","tutorMap","autoRouteToggle","ordersGrid","adminContainer","btnQuickCopy","btnOpenWechatQr"])assert(html.includes('id="'+id+'"'),id);
});

test("white surfaces retain distinct accent colors and only successful route results get teal",()=>{
 const css=read("css/styles.css"),app=read("js/app.js");
 for(const token of ["--location-soft","--subject-soft","--price-soft","--route-soft","--ai-soft"])assert(css.includes(token));
 assert(css.includes('[data-route-status="amap"]'));
 assert(app.includes('data-route-status=')&&app.includes('node.dataset.routeStatus='));
 assert.match(css,/--primary-button:#3263b0/);
});
