// 家計簿アプリから呼ばれる「メール係」。
// カードの利用通知、銀行の振込・出金・入金のお知らせ、PayPayの送金受取りから、
// 日付・金額・お店(内容)・種類の札だけを返す。

const VERSION = 2;

const SENDER = 'statement@vpass.ne.jp';
const SUBJECT_USE = 'ご利用のお知らせ【三井住友カード】';
const SUBJECT_STATEMENT = 'ご利用明細のお知らせ【三井住友カード】';

const SMBC = 'SMBC_service@dn.smbc.co.jp';
const YCB = 'ycb@yamanashibank.co.jp';
const PAYPAY = 'info@paypay-corp.co.jp';
// 口座出金のうち、カードの引き落としは家計簿側で別に数えているので返さない
const CARD_WITHDRAWAL = /ミツイスミトモカード|三井住友カード/;

// 最初に1回だけ実行する。合言葉を作って保存し、実行ログに表示する。
// (実行するとGmailを読む許可を求める画面が出る)
function makeKey() {
  const key = Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('KEY', key);
  Logger.log('合言葉: ' + key);
}

// ブラウザで住所を開いたときの動作確認用。利用内容は返さない。
function doGet() {
  return json_({ ok: true, message: 'メール係は動いています', version: VERSION });
}

function doPost(e) {
  let req = {};
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {}
  return json_(handle_(req));
}

function handle_(req) {
  const key = PropertiesService.getScriptProperties().getProperty('KEY');
  if (!key || req.key !== key) return { error: '合言葉が違います' };

  const after = /^\d{4}\/\d{2}\/\d{2}$/.test(req.after || '') ? req.after : firstOfMonth_();
  const afterDate = new Date(after.replace(/\//g, '-') + 'T00:00:00+09:00');
  const items = [];
  const count = { unreadable: 0 };

  eachMessage_(`from:${SENDER}`, after, afterDate, SENDER, msg => readCard_(msg, items, count));
  eachMessage_(`from:${SMBC}`, after, afterDate, SMBC, msg => readSmbc_(msg, items, count));
  eachMessage_(`from:${YCB} subject:振込受付のご案内`, after, afterDate, YCB, msg => readYcb_(msg, items, count));
  eachMessage_(`from:${PAYPAY} subject:送金受取りが完了しました`, after, afterDate, PAYPAY, msg => readPaypay_(msg, items, count));

  return { version: VERSION, items: items, unreadable: count.unreadable };
}

function eachMessage_(query, after, afterDate, sender, fn) {
  for (let start = 0; ; start += 100) {
    const threads = GmailApp.search(`${query} after:${after}`, start, 100);
    threads.forEach(thread => thread.getMessages().forEach(msg => {
      if (msg.getDate() < afterDate) return;
      if (msg.getFrom().toLowerCase().indexOf(sender.toLowerCase()) < 0) return;
      fn(msg);
    }));
    if (threads.length < 100) break;
  }
}

// ---- カード ----
function readCard_(msg, items, count) {
  const subject = msg.getSubject();
  if (subject !== SUBJECT_USE && subject !== SUBJECT_STATEMENT) return;

  const blocks = parseBody_(msg.getPlainBody());
  if (subject === SUBJECT_USE && blocks.length === 0) count.unreadable++;
  blocks.forEach((b, i) => {
    if (b.amount === null) { count.unreadable++; return; }
    // 明細通知の買物は利用通知と重複するので、返品だけ使う
    if (subject === SUBJECT_STATEMENT && b.kind !== '返品') return;
    items.push({ src: 'card', id: msg.getId() + '#' + i, date: b.date, time: b.time, shop: b.shop, kind: b.kind, amount: b.amount });
  });
}

function parseBody_(text) {
  const out = [];
  const re = /◇利用日：(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[ 　]+(\d{1,2}:\d{2}))?[ 　]*\r?\n◇利用先：(.*)\r?\n◇利用取引：(.*)\r?\n◇利用金額：(.*)/g;
  let m;
  while ((m = re.exec(text))) {
    out.push({
      date: `${m[1]}-${pad_(m[2])}-${pad_(m[3])}`,
      time: m[4] || '',
      shop: m[5].trim(),
      kind: m[6].trim(),
      amount: parseAmount_(m[7]),
    });
  }
  return out;
}

// ---- 三井住友銀行 ----
function readSmbc_(msg, items, count) {
  const subject = msg.getSubject();
  const id = msg.getId();

  // 口座出金: 出金日・出金額・内容がある(複数あれば繰り返し読む)
  if (subject.indexOf('口座出金のお知らせ') >= 0) {
    const re = /出金日[\s　]*[：:][\s　]*(\d{4})年(\d{1,2})月(\d{1,2})日[\s\S]*?出金額[\s　]*[：:][\s　]*([^\r\n]+)[\s\S]*?内容[\s　]*[：:][\s　]*([^\r\n]+)/g;
    const text = msg.getPlainBody();
    let m, i = 0, found = false;
    while ((m = re.exec(text))) {
      found = true;
      const amount = parseAmount_(m[4]);
      const shop = m[5].trim();
      if (amount === null) { count.unreadable++; i++; continue; }
      if (!CARD_WITHDRAWAL.test(shop.normalize('NFKC')) && !CARD_WITHDRAWAL.test(shop)) {
        items.push({ src: 'smbc-out', id: id + '#' + i, date: `${m[1]}-${pad_(m[2])}-${pad_(m[3])}`, shop: shop, amount: amount });
      }
      i++;
    }
    if (!found) count.unreadable++;
    return;
  }

  // 振込・ことら送金・振込入金: 金額が書かれていないので、種類と日付だけ返す
  let kind = null;
  if (subject.indexOf('ことら送金受付完了') >= 0) kind = 'ことら送金';
  else if (subject.indexOf('振込受付完了') >= 0) kind = '振込';
  else if (subject.indexOf('振込入金のお知らせ') >= 0) kind = '振込入金';
  if (!kind) return;

  let date = jstDate_(msg.getDate());
  const m = msg.getPlainBody().match(/受付日時[\s　]*[：:][\s　]*(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (m) date = `${m[1]}-${pad_(m[2])}-${pad_(m[3])}`;
  items.push({ src: 'smbc-pending', id: id + '#0', date: date, kind: kind });
}

// ---- 山梨中央銀行 ----
function readYcb_(msg, items, count) {
  const m = msg.getPlainBody().match(/振込日時[\s　]*[：:][\s　]*(\d{4})年(\d{1,2})月(\d{1,2})日[\s\S]*?振込金額[\s　]*[：:][\s　]*([^\r\n]+)/);
  const amount = m ? parseAmount_(m[4]) : null;
  if (!m || amount === null) { count.unreadable++; return; }
  items.push({ src: 'ycb', id: msg.getId() + '#0', date: `${m[1]}-${pad_(m[2])}-${pad_(m[3])}`, amount: amount });
}

// ---- PayPay(送金受取り) ----
// 文字だけの本文が無いことがあるので、HTMLからタグを取り除いて読む
function readPaypay_(msg, items, count) {
  const html = msg.getBody()
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
  const m = html.match(/送金者\s*(.+?)\s*(\d{4})年(\d{1,2})月(\d{1,2})日\d{1,2}時\d{1,2}分\s*([\d,]+)\s*円/);
  if (!m) { count.unreadable++; return; }
  items.push({ src: 'paypay', id: msg.getId() + '#0', date: `${m[2]}-${pad_(m[3])}-${pad_(m[4])}`, shop: m[1].trim(), amount: parseAmount_(m[5] + '円') });
}

function parseAmount_(s) {
  const t = s.normalize('NFKC').replace(/[−‐]/g, '-').replace(/[,\s]/g, '');
  const m = t.match(/^(-?\d+(?:\.\d+)?)(円|JPY)$/);
  return m ? Math.round(Number(m[1])) : null;
}

function pad_(n) {
  return String(n).padStart(2, '0');
}

function jstDate_(d) {
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');
}

function firstOfMonth_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/01');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
