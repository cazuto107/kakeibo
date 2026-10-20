// 家計簿アプリから呼ばれる「メール係」。
// 三井住友カードの利用通知メールから、日付・金額・お店・取引の種類だけを返す。

const SENDER = 'statement@vpass.ne.jp';
const SUBJECT_USE = 'ご利用のお知らせ【三井住友カード】';
const SUBJECT_STATEMENT = 'ご利用明細のお知らせ【三井住友カード】';

// 最初に1回だけ実行する。合言葉を作って保存し、実行ログに表示する。
// (実行するとGmailを読む許可を求める画面が出る)
function makeKey() {
  const key = Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('KEY', key);
  Logger.log('合言葉: ' + key);
}

// ブラウザで住所を開いたときの動作確認用。利用内容は返さない。
function doGet() {
  return json_({ ok: true, message: 'メール係は動いています' });
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
  let unreadable = 0;

  for (let start = 0; ; start += 100) {
    const threads = GmailApp.search(`from:${SENDER} after:${after}`, start, 100);
    threads.forEach(thread => thread.getMessages().forEach(msg => {
      if (msg.getDate() < afterDate) return;
      if (msg.getFrom().indexOf(SENDER) < 0) return;
      const subject = msg.getSubject();
      if (subject !== SUBJECT_USE && subject !== SUBJECT_STATEMENT) return;

      const blocks = parseBody_(msg.getPlainBody());
      if (subject === SUBJECT_USE && blocks.length === 0) unreadable++;
      blocks.forEach((b, i) => {
        if (b.amount === null) { unreadable++; return; }
        // 明細通知の買物は利用通知と重複するので、返品だけ使う
        if (subject === SUBJECT_STATEMENT && b.kind !== '返品') return;
        items.push({ id: msg.getId() + '#' + i, date: b.date, time: b.time, shop: b.shop, kind: b.kind, amount: b.amount });
      });
    }));
    if (threads.length < 100) break;
  }
  return { items: items, unreadable: unreadable };
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

function parseAmount_(s) {
  const t = s.normalize('NFKC').replace(/[−‐]/g, '-').replace(/[,\s]/g, '');
  const m = t.match(/^(-?\d+(?:\.\d+)?)(円|JPY)$/);
  return m ? Math.round(Number(m[1])) : null;
}

function pad_(n) {
  return String(n).padStart(2, '0');
}

function firstOfMonth_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/01');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
