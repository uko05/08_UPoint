// script.js
// うーこポイント交換所: 14_GenshinOmikujiで貯まったukoPointsを消費して、
// 他サイトのちょっとした特典(sitePerks)と交換する。

import { db } from './firebaseConfig.js';
import {
  doc, onSnapshot, runTransaction,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// ===== ユーザーID(uko05.github.io配下の全サイト共通のlocalStorageキー) =====
const LS_USER_ID = 'genshinOmikuji_userId';
function getUserId() {
  let id = localStorage.getItem(LS_USER_ID);
  if (!id) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    id = 'u_' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(LS_USER_ID, id);
  }
  return id;
}

function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ===== 交換アイテム一覧(データ駆動。増やす時はここに追加するだけでよい想定) =====
// siteKey/perkField: 対象サイトのomikujiUsers/{userId}.sitePerks.{siteKey}.{perkField}に
// 書き込む値。各サイト側はこのフィールドを見て、今日限定の上乗せとして扱う。
const REDEMPTION_ITEMS = [
  {
    id: 'friendboard_chat_plus1',
    siteKey: 'friendBoard',
    perkField: 'extraChatToday',
    amount: 1,
    cost: 50,
    titleKey: 'itemFriendBoardChatTitle',
    descKey: 'itemFriendBoardChatDesc',
  },
];

// ===== i18n =====
const i18n = {
  ja: {
    pageTitle: 'うーこポイント交換所',
    headerSub: '貯まったうーこポイント(UP)で、色々なサイトのちょっとした特典と交換できます',
    balanceLabel: '現在の所持UP',
    balanceHint: 'UPは原神おみくじの「アゲいいね！」「モラいいね！」で貯まります',
    itemsTitle: '交換できる特典',
    costLabel: (n) => `${n}UP`,
    redeemBtn: '交換する',
    redeemConfirm: (title, cost) => `「${title}」と${cost}UPを交換しますか？`,
    redeemSuccess: (title) => `「${title}」と交換しました！`,
    redeemInsufficientPoints: 'UPが足りません。',
    redeemNoUserDoc: 'まだUPがありません。原神おみくじでいいねをしてUPを貯めてから来てください。',
    redeemFail: '交換に失敗しました。時間をおいて再度お試しください。',
    itemFriendBoardChatTitle: '＃原神フレンド承認板：今日のチャット送信可能数 +1',
    itemFriendBoardChatDesc: '友達募集サイトで、今日1日だけチャットの送信可能数を+1します(0時にリセット)。',
  },
  en: {
    pageTitle: 'Uko Point Exchange',
    headerSub: 'Spend your saved-up Uko Points (UP) on small perks across various sites',
    balanceLabel: 'Your current UP',
    balanceHint: 'Earn UP from "Given" and "Received" likes on Genshin Omikuji',
    itemsTitle: 'Available Perks',
    costLabel: (n) => `${n}UP`,
    redeemBtn: 'Redeem',
    redeemConfirm: (title, cost) => `Redeem "${title}" for ${cost}UP?`,
    redeemSuccess: (title) => `Redeemed "${title}"!`,
    redeemInsufficientPoints: 'Not enough UP.',
    redeemNoUserDoc: "You don't have any UP yet. Like some results on Genshin Omikuji first to earn UP.",
    redeemFail: 'Redemption failed. Please try again later.',
    itemFriendBoardChatTitle: '#Genshin Friend Approval Board: +1 chat message today',
    itemFriendBoardChatDesc: "Adds +1 to today's chat message limit on the friend board (resets at midnight).",
  },
};
function currentLang() {
  return document.documentElement.lang === 'en' ? 'en' : 'ja';
}
function s() { return i18n[currentLang()]; }

function applyLang(lang) {
  document.documentElement.lang = lang;
  const dict = i18n[lang] || i18n.ja;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const val = dict[el.dataset.i18n];
    if (typeof val === 'string') el.textContent = val;
  });
  localStorage.setItem('lang', lang);
  renderItems();
}

function initLangSwitch() {
  const saved = localStorage.getItem('lang') || 'ja';
  const radio = document.querySelector(`input[name="lang"][value="${saved}"]`);
  if (radio) radio.checked = true;
  applyLang(saved);
  document.querySelectorAll('input[name="lang"]').forEach((r) => {
    r.addEventListener('change', (e) => applyLang(e.target.value));
  });
}

// ===== 所持UPのリアルタイム表示 =====
let latestUkoPoints = 0;
function startBalanceListener() {
  const el = document.getElementById('balance-count');
  onSnapshot(doc(db, 'omikujiUsers', getUserId()), (snap) => {
    latestUkoPoints = snap.exists() ? (snap.data().ukoPoints || 0) : 0;
    if (el) el.textContent = latestUkoPoints;
    renderItems();
  }, (e) => console.error('[upoint] balance listen failed', e));
}

// ===== 交換アイテム一覧の描画 =====
function renderItems() {
  const list = document.getElementById('item-list');
  if (!list) return;
  list.innerHTML = '';
  REDEMPTION_ITEMS.forEach((item) => {
    const t = s();
    const card = document.createElement('div');
    card.className = 'item-card';

    const title = document.createElement('p');
    title.className = 'item-title';
    title.textContent = t[item.titleKey];
    card.appendChild(title);

    const desc = document.createElement('p');
    desc.className = 'item-desc';
    desc.textContent = t[item.descKey];
    card.appendChild(desc);

    const foot = document.createElement('div');
    foot.className = 'item-foot';

    const cost = document.createElement('span');
    cost.className = 'item-cost';
    cost.textContent = t.costLabel(item.cost);
    foot.appendChild(cost);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'item-redeem-btn';
    btn.textContent = t.redeemBtn;
    btn.disabled = latestUkoPoints < item.cost;
    btn.addEventListener('click', () => handleRedeem(item));
    foot.appendChild(btn);

    card.appendChild(foot);
    list.appendChild(card);
  });
}

async function handleRedeem(item) {
  const t = s();
  const title = t[item.titleKey];
  if (!confirm(t.redeemConfirm(title, item.cost))) return;

  const userId = getUserId();
  const ref = doc(db, 'omikujiUsers', userId);
  const todayStr = todayDateStr();

  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('NO_USER_DOC');
      const data = snap.data();
      const points = data.ukoPoints || 0;
      if (points < item.cost) throw new Error('INSUFFICIENT_POINTS');

      const currentPerk = data.sitePerks?.[item.siteKey];
      const currentAmount = (currentPerk && currentPerk.forDate === todayStr) ? (currentPerk[item.perkField] || 0) : 0;

      tx.update(ref, {
        ukoPoints: points - item.cost,
        [`sitePerks.${item.siteKey}`]: {
          [item.perkField]: currentAmount + item.amount,
          forDate: todayStr,
        },
      });
    });
    showToast(t.redeemSuccess(title), false);
  } catch (e) {
    if (e.message === 'NO_USER_DOC') {
      showToast(t.redeemNoUserDoc, true);
    } else if (e.message === 'INSUFFICIENT_POINTS') {
      showToast(t.redeemInsufficientPoints, true);
    } else {
      console.error('[upoint] redeem failed', e);
      showToast(t.redeemFail, true);
    }
  }
}

// ===== トースト通知 =====
let toastTimer = null;
function showToast(text, isError) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('toast-error', !!isError);
  el.style.display = 'block';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3200);
}

// ===== 初期化 =====
initLangSwitch();
startBalanceListener();
