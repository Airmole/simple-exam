// EdgeOne Edge Function 统一入口
// 路由：/api/* 全部走这里（避免大量小文件带来的部署成本）
import { handleApi } from './_lib/router.js';

export default async function onRequest(context) {
  return handleApi(context);
}

export const onRequestGet = onRequest;
export const onRequestPost = onRequest;
export const onRequestPut = onRequest;
export const onRequestDelete = onRequest;
export const onRequestOptions = onRequest;
