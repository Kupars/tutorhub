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
 assert(html.includes('styles.css?v=44')&&html.includes('boot.js?v=2'));
 for(const id of ["qSearch","qSort","btnToggleFilters","tutorMap","autoRouteToggle","ordersGrid","adminContainer","btnQuickCopy","btnOpenWechatQr"])assert(html.includes('id="'+id+'"'),id);
});
