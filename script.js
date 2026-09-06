// script.js
// うーこポイント交換所: 14_GenshinOmikujiで貯まったukoPointsを消費して、
// 他サイトのちょっとした特典(sitePerks)と交換する。

import { db } from './firebaseConfig.js';
import {
  doc, onSnapshot, runTransaction, increment,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { ALL_ACHIEVEMENTS as OMIKUJI_ACHIEVEMENTS } from 'https://uko05.github.io/14_GenshinOmikuji/achievements.js';

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
    headerBg: '#fff8e1', // うっすら黄色
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
  {
    siteKey: 'accountCenter',
    siteNameKey: 'siteAccountCenter',
    headerBg: '#e8f0fe', // うっすら青
    items: [
      {
        id: 'accountcenter_achievement_setting',
        perkField: 'achievementSettingUnlocked',
        perkType: 'flag',
        cost: 50,
        maxRedemptions: 1,
        titleKey: 'itemAccountAchSettingTitle',
        descKey: 'itemAccountAchSettingDesc',
      },
      {
        id: 'accountcenter_title_regular',
        perkField: 'titleRegularUnlocked',
        perkType: 'flag',
        cost: 150,
        maxRedemptions: 1,
        titleKey: 'itemAccountTitleRegularTitle',
        descKey: 'itemAccountTitleRegularDesc',
      },
      {
        id: 'accountcenter_title_up_champion',
        perkField: 'titleUpChampionUnlocked',
        perkType: 'flag',
        cost: 500,
        maxRedemptions: 1,
        titleKey: 'itemAccountTitleUpChampionTitle',
        descKey: 'itemAccountTitleUpChampionDesc',
      },
    ],
  },
  {
    siteKey: 'omikuji',
    siteNameKey: 'siteOmikuji',
    headerBg: '#fff3e0', // うっすら橙
    items: [
      {
        id: 'omikuji_achievement_display',
        perkField: 'achievementDisplayUnlocked',
        perkType: 'flag',
        cost: 50,
        maxRedemptions: 1,
        titleKey: 'itemOmikujiAchDisplayTitle',
        descKey: 'itemOmikujiAchDisplayDesc',
      },
      {
        id: 'omikuji_title_fate_observer',
        perkField: 'titleFateObserverUnlocked',
        perkType: 'flag',
        cost: 100,
        maxRedemptions: 1,
        // 原神おみくじの実績を全部達成していないと交換できない特別枠
        requiresAllOmikujiAchievements: true,
        titleKey: 'itemOmikujiTitleFateObserverTitle',
        descKey: 'itemOmikujiTitleFateObserverDesc',
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
    redeemedBtn: '交換済み',
    redeemConfirm: (title, cost) => `「${title}」と${cost}UPを交換しますか？`,
    redeemSuccess: (title) => `「${title}」と交換しました！`,
    redeemInsufficientPoints: 'UPが足りません。',
    redeemNoUserDoc: 'まだUPがありません。原神おみくじでいいねをしてUPを貯めてから来てください。',
    redeemFail: '交換に失敗しました。時間をおいて再度お試しください。',
    redeemLimitReached: 'この特典はもう交換できません（交換上限に達しています）。',
    redeemRequirementNotMet: 'まだ交換条件を満たしていません。',
    limitNone: '交換上限：なし',
    limitRemaining: (max, remaining) => `交換上限：${max}回（あと${remaining}回）`,
    limitReached: '交換上限に達しました',
    conditionOmikujiAllAch: (have, total) => `条件：原神おみくじの実績を全部達成する（現在${have}/${total}）`,
    siteFriendBoard: '＃原神フレンド承認板',
    itemFriendBoardChatTitle: 'チャット送信可能数 ＋5',
    itemFriendBoardChatDesc: '友達募集サイトのチャット送信可能数を永続的に+5します(何回でも交換できます)。',
    siteAccountCenter: 'アカウント管理',
    itemAccountAchSettingTitle: 'アチーブメント設定を解放',
    itemAccountAchSettingDesc: 'アカウント管理画面で、持っている実績の中から1つ選んで称号として設定できるようになります。',
    itemAccountTitleRegularTitle: 'ゴールド称号「うーこの部屋常連」',
    itemAccountTitleRegularDesc: 'ゴールドレアリティの称号「うーこの部屋常連」を購入します。アカウント管理でいつでも設定できます。',
    itemAccountTitleUpChampionTitle: 'レジェンド称号「UP覇者」',
    itemAccountTitleUpChampionDesc: 'レジェンドレアリティの称号「UP覇者」を購入します。アカウント管理でいつでも設定できます。',
    siteOmikuji: '原神おみくじ',
    itemOmikujiAchDisplayTitle: 'アチーブメント表示を解放',
    itemOmikujiAchDisplayDesc: 'アカウント管理で設定した称号が、おみくじの「みんなの結果」であなたの名前の横に表示されるようになります。',
    itemOmikujiTitleFateObserverTitle: 'レジェンド称号「運命の観測者」',
    itemOmikujiTitleFateObserverDesc: '原神おみくじの実績を全部達成すると購入できる、レジェンドレアリティの称号「運命の観測者」です。アカウント管理でいつでも設定できます。',
  },
  en: {
    pageTitle: 'Uko Point Exchange',
    headerSub: 'Spend your saved-up Uko Points (UP) on small perks across various sites',
    balanceLabel: 'Your current UP',
    balanceHint: 'Earn UP by completing missions across various sites',
    itemsTitle: 'Available Perks',
    costLabel: (n) => `${n}UP`,
    redeemBtn: 'Redeem',
    redeemedBtn: 'Redeemed',
    redeemConfirm: (title, cost) => `Redeem "${title}" for ${cost}UP?`,
    redeemSuccess: (title) => `Redeemed "${title}"!`,
    redeemInsufficientPoints: 'Not enough UP.',
    redeemNoUserDoc: "You don't have any UP yet. Like some results on Genshin Omikuji first to earn UP.",
    redeemFail: 'Redemption failed. Please try again later.',
    redeemLimitReached: "You've already reached the redemption limit for this perk.",
    redeemRequirementNotMet: "You don't meet the requirements for this yet.",
    limitNone: 'Redemption limit: none',
    limitRemaining: (max, remaining) => `Redemption limit: ${max} (${remaining} left)`,
    limitReached: 'Redemption limit reached',
    conditionOmikujiAllAch: (have, total) => `Requirement: complete all Genshin Omikuji achievements (currently ${have}/${total})`,
    siteFriendBoard: '#Genshin Friend Approval Board',
    itemFriendBoardChatTitle: 'Chat message limit +5',
    itemFriendBoardChatDesc: "Permanently adds +5 to the friend board's chat message limit (can be redeemed any number of times).",
    siteAccountCenter: 'Account Center',
    itemAccountAchSettingTitle: 'Unlock Achievement Setting',
    itemAccountAchSettingDesc: 'Lets you pick one of your earned achievements as a title on the Account Center page.',
    itemAccountTitleRegularTitle: 'Gold Title: "Room Regular"',
    itemAccountTitleRegularDesc: 'Purchase the gold-rarity title "Room Regular" (うーこの部屋常連). Equip it anytime from Account Center.',
    itemAccountTitleUpChampionTitle: 'Legend Title: "UP Champion"',
    itemAccountTitleUpChampionDesc: 'Purchase the legend-rarity title "UP Champion" (UP覇者). Equip it anytime from Account Center.',
    siteOmikuji: 'Genshin Omikuji',
    itemOmikujiAchDisplayTitle: 'Unlock Achievement Display',
    itemOmikujiAchDisplayDesc: "Shows the title you set on Account Center next to your name on Omikuji's \"Everyone's Results\" feed.",
    itemOmikujiTitleFateObserverTitle: 'Legend Title: "Fate Observer"',
    itemOmikujiTitleFateObserverDesc: 'A legend-rarity title, "Fate Observer" (運命の観測者), purchasable once you\'ve completed every Genshin Omikuji achievement. Equip it anytime from Account Center.',
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
let latestOmikujiAchievements = [];

function hasAllOmikujiAchievements() {
  return OMIKUJI_ACHIEVEMENTS.every((a) => latestOmikujiAchievements.includes(a.id));
}

function startBalanceListener() {
  const el = document.getElementById('balance-count');
  onSnapshot(doc(db, 'omikujiUsers', getUserId()), (snap) => {
    const data = snap.exists() ? snap.data() : {};
    latestUkoPoints = data.ukoPoints || 0;
    latestRedemptionCounts = data.redemptionCounts || {};
    latestOmikujiAchievements = data.achievements || [];
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
  const requirementMet = !item.requiresAllOmikujiAchievements || hasAllOmikujiAchievements();

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
  if (item.requiresAllOmikujiAchievements) {
    const have = OMIKUJI_ACHIEVEMENTS.filter((a) => latestOmikujiAchievements.includes(a.id)).length;
    const condition = document.createElement('p');
    condition.className = 'item-desc item-condition';
    condition.textContent = t.conditionOmikujiAllAch(have, OMIKUJI_ACHIEVEMENTS.length);
    info.appendChild(condition);
  }
  card.appendChild(info);

  const action = document.createElement('div');
  action.className = 'item-action';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'item-redeem-btn';
  btn.classList.toggle('item-redeem-btn-done', limitReached);
  btn.classList.toggle('item-redeem-btn-insufficient', !limitReached && (!requirementMet || latestUkoPoints < item.cost));
  btn.textContent = limitReached ? t.redeemedBtn : t.redeemBtn;
  btn.disabled = latestUkoPoints < item.cost || limitReached || !requirementMet;
  btn.addEventListener('click', () => handleRedeem(item, siteKey));
  action.appendChild(btn);

  const limit = document.createElement('p');
  limit.className = 'item-limit';
  if (limitReached) {
    limit.textContent = t.limitReached;
  } else if (item.maxRedemptions == null) {
    limit.textContent = t.limitNone;
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

      if (item.requiresAllOmikujiAchievements) {
        const myAchievements = data.achievements || [];
        const allDone = OMIKUJI_ACHIEVEMENTS.every((a) => myAchievements.includes(a.id));
        if (!allDone) throw new Error('REQUIREMENT_NOT_MET');
      }

      // 永続的に効く特典なので、対象サイト側のフィールドへそのまま加算していく
      // (日付での期限切れは無い)。perkType:'flag'の項目は数値加算ではなく
      // true を直接立てるだけの一度きりの解放フラグとして扱う。
      const perkValue = item.perkType === 'flag' ? true : increment(item.amount);
      tx.update(ref, {
        ukoPoints: increment(-item.cost),
        [`sitePerks.${siteKey}.${item.perkField}`]: perkValue,
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
    } else if (e.message === 'REQUIREMENT_NOT_MET') {
      showToast(t.redeemRequirementNotMet, true);
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
