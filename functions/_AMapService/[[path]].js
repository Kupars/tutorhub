import {handleAmapProxy} from "../../shared/amap-proxy.js";
export const onRequest=({request,env})=>handleAmapProxy(request,env);
