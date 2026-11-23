import { splitWechatMessages } from './wechat-bulk-core.js';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_UNZIPPED = 35 * 1024 * 1024;
const supported = /\.(txt|csv|tsv|json|docx|xlsx)$/i;
function decode(bytes) {
  try { return new TextDecoder('utf-8', {fatal:true}).decode(bytes); }
  catch { return new TextDecoder('gb18030').decode(bytes); }
}
function rowsFromText(text, separator) {
  const result = []; let row = [], field = '', quoted = false;
  const value = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '"') {
      if (quoted && value[i+1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && c === separator) { row.push(field); field = ''; }
    else if (!quoted && (c === '\n' || c === '\r')) {
      if (c === '\r' && value[i+1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(x => x.trim())) result.push(row);
      row = [];
    } else field += c;
  }
  row.push(field); if (row.some(x => x.trim())) result.push(row);
  return result;
}
function fromRows(rows, name) {
  if (!rows.length) return [];
  const header = rows[0].map(x => String(x || '').trim());
  const heading = header.some(x => /年级|科目|地址|薪资|编号|单号|学生|聊天内容|消息/i.test(x));
  const messages = [];
  for (let i = heading ? 1 : 0; i < rows.length; i++) {
    const record = rows[i];
    if (!record?.some(x => String(x).trim())) continue;
    const fields = heading
      ? record.map((value,j) => header[j] ? header[j] + '：' + String(value || '').trim() : '').filter(Boolean).join('\n')
      : record.map(x=>String(x || '').trim()).filter(Boolean).join(' | ');
    messages.push({ source: name + ' 第' + (i+1) + '行', text: fields });
  }
  return messages;
}
function xmlParse(source) {
  const doc = new DOMParser().parseFromString(source, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Office 文档 XML 损坏，无法读取');
  return doc;
}
function zipEntries(buffer) {
  const data = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0,data.length-65557); i--) {
    if (view.getUint32(i,true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP 结构不完整，建议先解压再上传 TXT 文件');
  const entriesCount = view.getUint16(eocd+10,true);
  let offset = view.getUint32(eocd+16,true);
  if (entriesCount > 900 || entriesCount === 0xffff) throw new Error('ZIP 文件条目过多或采用 ZIP64，请先解压后分批上传');
  const result = []; let total = 0;
  for (let i = 0; i < entriesCount; i++) {
    if (offset + 46 > data.length || view.getUint32(offset,true) !== 0x02014b50)
      throw new Error('ZIP 目录异常');
    const flags = view.getUint16(offset+8,true);
    const method = view.getUint16(offset+10,true);
    const compressed = view.getUint32(offset+20,true);
    const uncompressed = view.getUint32(offset+24,true);
    const nameLength = view.getUint16(offset+28,true);
    const extraLength = view.getUint16(offset+30,true);
    const commentLength = view.getUint16(offset+32,true);
    const local = view.getUint32(offset+42,true);
    const name = decode(data.subarray(offset+46,offset+46+nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || name.split('/').some(p=>p==='..')) continue;
    if (flags & 1) throw new Error('加密 ZIP 暂不支持，请先解密');
    if (method !== 0 && method !== 8) continue;
    if (local+30 > data.length || view.getUint32(local,true) !== 0x04034b50) throw new Error('ZIP 条目损坏');
    const payloadStart = local+30+view.getUint16(local+26,true)+view.getUint16(local+28,true);
    if (payloadStart+compressed > data.length) throw new Error('ZIP 条目长度异常');
    if (uncompressed > MAX_FILE_BYTES || (total += uncompressed) > MAX_TOTAL_UNZIPPED)
      throw new Error('ZIP 解压后内容过大，请分批导出');
    result.push({ name, method, compressed:data.slice(payloadStart,payloadStart+compressed), size:uncompressed });
  }
  return result;
}
async function unzipOne(entry) {
  if (entry.method === 0) return entry.compressed;
  if (typeof DecompressionStream === 'undefined') throw new Error('当前浏览器不支持解压 ZIP，请先在系统中解压后上传 TXT');
  try {
    const stream = new Blob([entry.compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    if (bytes.length !== entry.size) throw new Error('解压尺寸不符');
    return bytes;
  } catch (error) {
    throw new Error('浏览器无法解压此 ZIP（' + error.message + '），请先用 Mac 访达解压');
  }
}
async function decodeDocx(buffer, name) {
  const entries = zipEntries(buffer);
  const file = entries.find(x=>x.name === 'word/document.xml');
  if (!file) throw new Error('不是有效的 DOCX 文件');
  const doc = xmlParse(decode(await unzipOne(file)));
  const paragraphs = [...doc.getElementsByTagName('w:p')];
  const text = paragraphs.map(p=>[...p.getElementsByTagName('w:t')].map(x=>x.textContent).join('')).join('\n');
  return splitWechatMessages(text,name);
}
function colIndex(label) {
  return [...label.toUpperCase()].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;
}
async function decodeXlsx(buffer, name) {
  const entries = zipEntries(buffer);
  const shared = entries.find(x=>x.name==='xl/sharedStrings.xml');
  const strings = [];
  if (shared) {
    const doc = xmlParse(decode(await unzipOne(shared)));
    [...doc.getElementsByTagName('si')].forEach(si=>{
      strings.push([...si.getElementsByTagName('t')].map(t=>t.textContent).join(''));
    });
  }
  const sheet = entries.find(x=>/^xl\/worksheets\/sheet\d+\.xml$/.test(x.name));
  if (!sheet) throw new Error('未找到 Excel 工作表');
  const doc = xmlParse(decode(await unzipOne(sheet)));
  const rows = [...doc.getElementsByTagName('row')].slice(0,1500).map(row=>{
    const cells = [];
    for (const cell of row.getElementsByTagName('c')) {
      const ref = cell.getAttribute('r') || '';
      const match = /^[A-Z]+/i.exec(ref);
      const idx = match ? colIndex(match[0]) : cells.length;
      if (idx < 0 || idx > 80) continue;
      const t = cell.getAttribute('t');
      const v = cell.getElementsByTagName('v')[0]?.textContent || '';
      cells[idx] = t === 's' ? (strings[Number(v)] || '') :
        t === 'inlineStr' ? [...cell.getElementsByTagName('t')].map(x=>x.textContent).join('') : v;
    }
    return Array.from({length:Math.min(cells.length,81)},(_,i)=>cells[i] || '');
  });
  return fromRows(rows,name);
}
function fromJson(text, name) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('JSON 内容无法解析'); }
  const array = Array.isArray(data) ? data :
    Array.isArray(data?.messages) ? data.messages :
    Array.isArray(data?.data) ? data.data :
    Array.isArray(data?.records) ? data.records : [data];
  return array.slice(0,1500).flatMap((item,i)=>{
    const source = name + ' 第' + (i+1) + '条';
    if (typeof item === 'string') return splitWechatMessages(item,source);
    if (!item || typeof item !== 'object') return [];
    const content = item.content || item.text || item.message || item.body || item.msg;
    return content && typeof content === 'string'
      ? splitWechatMessages(content,source) : [{source, text:JSON.stringify(item)}];
  });
}
async function decodeEntry(name, buffer) {
  const suffix = name.toLowerCase().split('.').pop();
  if (suffix === 'docx') return decodeDocx(buffer,name);
  if (suffix === 'xlsx') return decodeXlsx(buffer,name);
  const text = decode(new Uint8Array(buffer));
  if (suffix === 'json') return fromJson(text,name);
  if (suffix === 'csv' || suffix === 'tsv') return fromRows(rowsFromText(text,suffix==='tsv' ? '\t' : ','),name);
  return splitWechatMessages(text,name);
}
export async function readWechatFiles(files) {
  const documents = [], warnings = []; let total = 0;
  for (const file of Array.from(files || [])) {
    if (file.size > MAX_FILE_BYTES || (total += file.size) > MAX_TOTAL_UNZIPPED)
      throw new Error('文件累计超过 35 MB，请拆成几批导入');
    const buffer = await file.arrayBuffer();
    if (/\.zip$/i.test(file.name)) {
      const entries = zipEntries(buffer); let count = 0;
      for (const entry of entries) {
        if (!supported.test(entry.name)) continue;
        const data = await unzipOne(entry);
        const source = file.name + ' / ' + entry.name;
        try { documents.push({name:source,messages:await decodeEntry(source,data.buffer)}); count++; }
        catch(error) { warnings.push(source + '：' + error.message); }
      }
      if (!count) warnings.push(file.name + '：未发现可读取的 TXT/CSV/TSV/JSON/DOCX/XLSX 文件');
    } else if (supported.test(file.name)) {
      documents.push({name:file.name,messages:await decodeEntry(file.name,buffer)});
    } else {
      warnings.push(file.name + '：暂不支持此格式（旧 .doc 请先另存为 .docx）');
    }
  }
  return {documents,warnings};
}
