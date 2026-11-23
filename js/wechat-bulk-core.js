// Pure structural utilities for administrator-only historical imports.
// These routines find message boundaries; they DO NOT parse tutoring fields.
const clean = value => String(value == null ? '' : value).replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').trim();
const idHeader = line => /^\s*(?:[#＃]\d{3,7}(?:-\d+)?\s*(?:[\/／、\s]|$)|(?:家教单|订单|单号)\s*[：:]\s*#?\d{3,7})/.test(line);
const timeHeader = line => /^\s*(?:\[?\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?[\sT]+\d{1,2}:\d{2}(?:\:\d{2})?\]?|(?:周[一二三四五六日天])?\s*\d{1,2}:\d{2}\s+\S{1,36}\s*[:：])/.test(line);
const standardStart = line => /^\s*【(?:年级性别|学生年级|年级)】/.test(line);
export function splitWechatMessages(input, source = '粘贴内容') {
  const text = clean(input);
  if (!text) return [];
  const lines = text.split('\n');
  const result = [];
  let current = [], blanks = 0;
  function flush() {
    const item = current.join('\n').trim();
    if (item) result.push({ source, text: item });
    current = []; blanks = 0;
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (/^(?:={5,}|[-—]{6,})\s*$/.test(trimmed)) { flush(); continue; }
    if (!trimmed) { current.push(''); blanks++; continue; }
    const priorText = current.some(s => s.trim());
    const header = idHeader(trimmed) || timeHeader(trimmed) ||
      (standardStart(trimmed) && current.some(s => /【(?:年级性别|补习科目|薪资)】/.test(s)));
    if (priorText && (header || blanks >= 2)) flush();
    current.push(line); blanks = 0;
  }
  flush();
  return result;
}
export function redactWechatText(input) {
  return clean(input)
    .replace(/1[3-9]\d{9}/g, '[手机号已隐藏]')
    .replace(/[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[邮箱已隐藏]')
    .replace(/(?:微信(?:号|ID|账号)?|vx|WeChat)\s*[：:=\s]*[A-Za-z][A-Za-z0-9_-]{4,32}/gi, '[微信号已隐藏]')
    .replace(/\d{1,4}\s*(?:号楼|栋|幢)\s*(?:\d{1,4}\s*单元)?\s*\d{1,4}\s*(?:室|户)/g, '[详细门牌已隐藏]')
    .replace(/\d{1,3}\s*单元\s*\d{1,4}\s*(?:室|户)/g, '[详细门牌已隐藏]');
}
export function groupWechatMessages(messages, maxCharacters = 9000, maxCount = 10) {
  const result = []; let bucket = [], length = 0;
  for (const message of messages) {
    const text = redactWechatText(message.text);
    if (text.length > maxCharacters) {
      if (bucket.length) result.push({ messages:bucket, status:'pending', error:'' });
      bucket = []; length = 0;
      result.push({ messages:[message], status:'failed', error:'单条消息超过安全长度，请拆分后重新导入' });
      continue;
    }
    if (bucket.length && (bucket.length >= maxCount || length + text.length + 110 > maxCharacters)) {
      result.push({ messages:bucket, status:'pending', error:'' });
      bucket = []; length = 0;
    }
    bucket.push(message); length += text.length + 110;
  }
  if (bucket.length) result.push({ messages:bucket, status:'pending', error:'' });
  return result;
}
export function normalizeImportDocuments(documents, limit = 1200) {
  const result = [], fingerprint = new Set();
  for (const document of documents) {
    for (const item of document.messages || []) {
      const text = clean(item.text);
      if (!text) continue;
      const key = text.replace(/\s+/g, '').slice(0, 15000);
      if (fingerprint.has(key)) continue;
      fingerprint.add(key);
      result.push({ source: String(item.source || document.name || '未知文件').slice(0, 140),
        text, index: result.length + 1 });
      if (result.length > limit) throw new Error('超过一次最多 ' + limit + ' 条消息的限制，请拆成多个批次导入');
    }
  }
  return result;
}
export function findBulkDuplicate(order, existing) {
  const number = String(order.orderNumber || order.id || '');
  const simplify = s => String(s || '').toLowerCase().replace(/天津市|[^\p{L}\p{N}]/gu, '');
  for (const candidate of existing || []) {
    const old = String(candidate.orderNumber || candidate.id || '');
    if (number && old === number) return { id: old, reason: '单号已存在', hard: true };
    const a = [order.grade, order.subject, order.publicAddress || order.address, order.weeklyFrequency].map(simplify);
    const b = [candidate.grade, candidate.subject, candidate.publicAddress || candidate.address, candidate.weeklyFrequency].map(simplify);
    if (a[0] && a[0] === b[0] && a[1] && a[1] === b[1] &&
        a[2].length >= 7 && a[2] === b[2] && a[3] && a[3] === b[3])
      return { id: old, reason: '年级、科目、地点和上课安排高度相似', hard:false };
  }
  return null;
}
export function safeBulkUpdates(updates, messages, existing) {
  const pool = Array.isArray(existing) ? existing : [];
  return (Array.isArray(updates) ? updates : []).slice(0, 30).map(update => {
    const id = String(update?.id || '').trim();
    const status = String(update?.status || '').trim();
    const sourceIndex = Number(update?.sourceMessageIndex);
    const origin = messages.find(m => m.index === sourceIndex);
    const match = pool.find(o => String(o.orderNumber || o.id) === id);
    const verified = !!match && !!origin && origin.text.includes(id) &&
      ['招募中','已匹配','已结束'].includes(status);
    return { id, status, sourceIndex, note: String(update?.reason || '').slice(0, 120),
      verified, internalId: match?.id || '', source: origin?.text || '', selected:false, done:false };
  });
}
