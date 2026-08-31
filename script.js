// script.js
// うーこポイント交換所: 14_GenshinOmikujiで貯まったukoPointsを消費して、
// 他サイトのちょっとした特典(sitePerks)と交換する。

import { db } from './firebaseConfig.js';
import {
  doc, onSnapshot, runTransaction, increment,
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

// ===== 交換アイテム一覧(データ駆動。サイトごとにグループ化して表示する。
// 増やす時はSITE_GROUPSに新しいグループ/アイテムを足すだけでよい想定) =====
// siteKey/perkField: 対象サイトのomikujiUsers/{userId}.sitePerks.{siteKey}.{perkField}に
// 永続的に加算していく値。各サイト側はこのフィールドをそのまま自分の基礎値に
// 上乗せして使う(日付リセットは無い、ずっと効き続ける特典)。
// maxRedemptions: 1人が生涯に交換できる回数の上限。nullなら無制限。
const SITE_GROUPS = [
  {
    siteKey: 'friendBoard',
    siteNameKey: 'siteFriendBoard',
    headerBg: '#fff8e1', // FriendBoardのテーマカラー(#ffcc00)のうっすら版
    items: [
      {
        id: 'friendboard_chat_plus5',
        perkField: 'permanentExtraChat',
        amount: 5,
        cost: 50,
        maxRedemptions: null,
        titleKey: 'itemFriendBoardChatTitle',
        descKey: 'itemFriendBoardChatDesc',
      },
    ],
  },
];

// サイト枠の開閉状態(再描画のたびに<details>を作り直すため、ここで覚えておく)
const openGroups = new Set(SITE_GROUPS.map((g) => g.siteKey));

// ===== i18n =====
const i18n = {
  ja: {
    pageTitle: 'うーこポイント交換所',
    headerSub: '貯まったうーこポイント(UP)で、色々なサイトのちょっとした特典と交換できます',
    balanceLabel: '現在の所持UP',
    balanceHint: 'UPは様々なサイトのミッションをクリアすると貯まります',
    itemsTitle: '交換できる特典',
    costLabel: (n) => `${n}UP`,
    redeemBtn: '交換する',
    redeemConfirm: (title, cost) => `「${title}」と${cost}UPを交換しますか？`,
    redeemSuccess: (title) => `「${title}」と交換しました！`,
    redeemInsufficientPoints: 'UPが足りません。',
    redeemNoUserDoc: 'まだUPがありません。原神おみくじでいいねをしてUPを貯めてから来てください。',
    redeemFail: '交換に失敗しました。時間をおいて再度お試しください。',
    redeemLimitReached: 'この特典はもう交換できません（交換上限に達しています）。',
    limitNone: '交換上限：なし',
    limitRemaining: (max, remaining) => `交換上限：${max}回（あと${remaining}回）`,
    limitReached: '交換上限に達しました',
    siteFriendBoard: '＃原神フレンド承認板',
    itemFriendBoardChatTitle: 'チャット送信可能数 ＋5',
    itemFriendBoardChatDesc: '友達募集サイトのチャット送信可能数を永続的に+5します(何回でも交換できます)。',
  },
  en: {
    pageTitle: 'Uko Point Exchange',
    headerSub: 'Spend your saved-up Uko Points (UP) on small perks across various sites',
    balanceLabel: 'Your current UP',
    balanceHint: 'Earn UP by completing missions across various sites',
    itemsTitle: 'Available Perks',
    costLabel: (n) => `${n}UP`,
    redeemBtn: 'Redeem',
    redeemConfirm: (title, cost) => `Redeem "${title}" for ${cost}UP?`,
    redeemSuccess: (title) => `Redeemed "${title}"!`,
    redeemInsufficientPoints: 'Not enough UP.',
    redeemNoUserDoc: "You don't have any UP yet. Like some results on Genshin Omikuji first to earn UP.",
    redeemFail: 'Redemption failed. Please try again later.',
    redeemLimitReached: "You've already reached the redemption limit for this perk.",
    limitNone: 'Redemption limit: none',
    limitRemaining: (max, remaining) => `Redemption limit: ${max} (${remaining} left)`,
    limitReached: 'Redemption limit reached',
    siteFriendBoard: '#Genshin Friend Approval Board',
    itemFriendBoardChatTitle: 'Chat message limit +5',
    itemFriendBoardChatDesc: "Permanently adds +5 to the friend board's chat message limit (can be redeemed any number of times).",
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
  renderSiteGroups();
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
let latestRedemptionCounts = {};
function startBalanceListener() {
  const el = document.getElementById('balance-count');
  onSnapshot(doc(db, 'omikujiUsers', getUserId()), (snap) => {
    const data = snap.exists() ? snap.data() : {};
    latestUkoPoints = data.ukoPoints || 0;
    latestRedemptionCounts = data.redemptionCounts || {};
    if (el) el.textContent = latestUkoPoints;
    renderSiteGroups();
  }, (e) => console.error('[upoint] balance listen failed', e));
}

// ===== サイト別グループ+交換アイテムの描画 =====
function buildItemCard(item, siteKey) {
  const t = s();
  const card = document.createElement('div');
  card.className = 'item-card';

  const redeemedCount = latestRedemptionCounts[item.id] || 0;
  const limitReached = item.maxRedemptions != null && redeemedCount >= item.maxRedemptions;

  const cost = document.createElement('span');
  cost.className = 'item-cost';
  const costNum = document.createElement('span');
  costNum.textContent = item.cost;
  const costUnit = document.createElement('span');
  costUnit.className = 'item-cost-unit';
  costUnit.textContent = 'UP';
  cost.appendChild(costNum);
  cost.appendChild(costUnit);
  card.appendChild(cost);

  const info = document.createElement('div');
  info.className = 'item-info';
  const title = document.createElement('p');
  title.className = 'item-title';
  title.textContent = t[item.titleKey];
  info.appendChild(title);
  const desc = document.createElement('p');
  desc.className = 'item-desc';
  desc.textContent = t[item.descKey];
  info.appendChild(desc);
  card.appendChild(info);

  const action = document.createElement('div');
  action.className = 'item-action';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'item-redeem-btn';
  btn.textContent = t.redeemBtn;
  btn.disabled = latestUkoPoints < item.cost || limitReached;
  btn.addEventListener('click', () => handleRedeem(item, siteKey));
  action.appendChild(btn);

  const limit = document.createElement('p');
  limit.className = 'item-limit';
  if (item.maxRedemptions == null) {
    limit.textContent = t.limitNone;
  } else if (limitReached) {
    limit.textContent = t.limitReached;
  } else {
    limit.textContent = t.limitRemaining(item.maxRedemptions, item.maxRedemptions - redeemedCount);
  }
  action.appendChild(limit);

  card.appendChild(action);

  return card;
}

function renderSiteGroups() {
  const list = document.getElementById('site-group-list');
  if (!list) return;
  const t = s();
  list.innerHTML = '';

  SITE_GROUPS.forEach((group) => {
    const details = document.createElement('details');
    details.className = 'site-group';
    details.open = openGroups.has(group.siteKey);
    details.addEventListener('toggle', () => {
      if (details.open) openGroups.add(group.siteKey);
      else openGroups.delete(group.siteKey);
    });

    const summary = document.createElement('summary');
    summary.className = 'site-group-header';
    summary.textContent = t[group.siteNameKey];
    if (group.headerBg) summary.style.background = group.headerBg;
    details.appendChild(summary);

    const itemsDiv = document.createElement('div');
    itemsDiv.className = 'site-group-items';
    group.items.forEach((item) => itemsDiv.appendChild(buildItemCard(item, group.siteKey)));
    details.appendChild(itemsDiv);

    list.appendChild(details);
  });
}

async function handleRedeem(item, siteKey) {
  const t = s();
  const title = t[item.titleKey];
  if (!confirm(t.redeemConfirm(title, item.cost))) return;

  const userId = getUserId();
  const ref = doc(db, 'omikujiUsers', userId);

  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('NO_USER_DOC');
      const data = snap.data();
      const points = data.ukoPoints || 0;
      if (points < item.cost) throw new Error('INSUFFICIENT_POINTS');

      const redeemedCount = data.redemptionCounts?.[item.id] || 0;
      if (item.maxRedemptions != null && redeemedCount >= item.maxRedemptions) {
        throw new Error('REDEMPTION_LIMIT_REACHED');
      }

      // 永続的に効く特典なので、対象サイト側のフィールドへそのまま加算していく
      // (日付での期限切れは無い)。
      tx.update(ref, {
        ukoPoints: increment(-item.cost),
        [`sitePerks.${siteKey}.${item.perkField}`]: increment(item.amount),
        [`redemptionCounts.${item.id}`]: increment(1),
      });
    });
    showToast(t.redeemSuccess(title), false);
  } catch (e) {
    if (e.message === 'NO_USER_DOC') {
      showToast(t.redeemNoUserDoc, true);
    } else if (e.message === 'INSUFFICIENT_POINTS') {
      showToast(t.redeemInsufficientPoints, true);
    } else if (e.message === 'REDEMPTION_LIMIT_REACHED') {
      showToast(t.redeemLimitReached, true);
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
