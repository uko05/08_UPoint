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
        cost: 250,
        maxRedemptions: 1,
        titleKey: 'itemAccountTitleRegularTitle',
        descKey: 'itemAccountTitleRegularDesc',
      },
      {
        id: 'accountcenter_title_up_champion',
        perkField: 'titleUpChampionUnlocked',
        perkType: 'flag',
        cost: 1000,
        maxRedemptions: 1,
        titleKey: 'itemAccountTitleUpChampionTitle',
        descKey: 'itemAccountTitleUpChampionDesc',
      },
    ],
  },
  {
    siteKey: 'storage17',
    siteNameKey: 'siteStorage',
    headerBg: '#e8f5e9', // うっすら緑
    items: [
      {
        id: 'storage17_original_upload',
        perkField: 'originalUpload',
        perkType: 'flag',
        cost: 100,
        maxRedemptions: 1,
        titleKey: 'itemStorageOriginalUploadTitle',
        descKey: 'itemStorageOriginalUploadDesc',
      },
      {
        id: 'storage17_extra_daily_upload',
        perkField: 'extraDailyUploads',
        amount: 1,
        cost: 50,
        // 費用管理のため無制限にはせず、+10枚(合計40枚/日)を上限にする
        maxRedemptions: 10,
        titleKey: 'itemStorageExtraUploadTitle',
        descKey: 'itemStorageExtraUploadDesc',
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
        id: 'omikuji_gacha_ticket',
        perkField: 'gachaTickets',
        amount: 1,
        cost: 50,
        maxRedemptions: null,
        titleKey: 'itemOmikujiGachaTicketTitle',
        descKey: 'itemOmikujiGachaTicketDesc',
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

// ===== UPを貯める方法一覧(データ駆動。SITE_GROUPSと同じくサイトごとにグループ化) =====
// statKey: unlimited(無制限)ミッションの「これまでの達成回数」をomikujiUsersの
//          該当フィールドからそのまま表示する(UPointが直接付与するわけではなく、
//          各サイト側で既に加算されている値を表示するだけ)。
// claimKey: 1回限りミッションの達成判定に使う。omikujiUsers.missionsClaimed.{claimKey}
//           が各サイト側から立てられる想定。
const MISSION_GROUPS = [
  {
    siteKey: 'omikuji',
    siteNameKey: 'siteOmikuji',
    headerBg: '#fff3e0',
    siteUrl: 'https://uko05.github.io/14_GenshinOmikuji/',
    missions: [
      {
        id: 'omikuji_like_given',
        reward: 1,
        unlimited: true,
        statKey: 'totalLikesGiven',
        titleKey: 'missionOmikujiLikeGivenTitle',
        descKey: 'missionOmikujiLikeGivenDesc',
      },
      {
        id: 'omikuji_like_received',
        reward: 2,
        unlimited: true,
        statKey: 'totalLikesReceived',
        titleKey: 'missionOmikujiLikeReceivedTitle',
        descKey: 'missionOmikujiLikeReceivedDesc',
      },
    ],
  },
  {
    siteKey: 'genshinRanking',
    siteNameKey: 'siteGenshinRanking',
    headerBg: '#e3f2fd',
    siteUrl: 'https://uko05.github.io/TiersList01/',
    missions: [
      {
        id: 'genshinRankingImage',
        reward: 20,
        unlimited: false,
        claimKey: 'genshinRankingImage',
        titleKey: 'missionGenshinRankingImageTitle',
        descKey: 'missionGenshinRankingImageDesc',
      },
    ],
  },
  {
    siteKey: 'starrailRankingPath',
    siteNameKey: 'siteStarrailRankingPath',
    headerBg: '#fce4ec',
    siteUrl: 'https://uko05.github.io/TiersList02/',
    missions: [
      {
        id: 'starrailRankingPathImage',
        reward: 20,
        unlimited: false,
        claimKey: 'starrailRankingPathImage',
        titleKey: 'missionStarrailRankingPathImageTitle',
        descKey: 'missionStarrailRankingPathImageDesc',
      },
    ],
  },
  {
    siteKey: 'starrailRankingElement',
    siteNameKey: 'siteStarrailRankingElement',
    headerBg: '#f3e5f5',
    siteUrl: 'https://uko05.github.io/TiersList03/',
    missions: [
      {
        id: 'starrailRankingElementImage',
        reward: 20,
        unlimited: false,
        claimKey: 'starrailRankingElementImage',
        titleKey: 'missionStarrailRankingElementImageTitle',
        descKey: 'missionStarrailRankingElementImageDesc',
      },
    ],
  },
  {
    siteKey: 'genshinFreeFormat',
    siteNameKey: 'siteGenshinFreeFormat',
    headerBg: '#e0f7fa',
    siteUrl: 'https://uko05.github.io/genshinFormat04/',
    missions: [
      {
        id: 'genshinFreeFormatImage',
        reward: 20,
        unlimited: false,
        claimKey: 'genshinFreeFormatImage',
        titleKey: 'missionGenshinFreeFormatImageTitle',
        descKey: 'missionGenshinFreeFormatImageDesc',
      },
    ],
  },
  {
    siteKey: 'starrailFreeFormat',
    siteNameKey: 'siteStarrailFreeFormat',
    headerBg: '#ffe0b2',
    siteUrl: 'https://uko05.github.io/starrailFormat05/',
    missions: [
      {
        id: 'starrailFreeFormatImage',
        reward: 20,
        unlimited: false,
        claimKey: 'starrailFreeFormatImage',
        titleKey: 'missionStarrailFreeFormatImageTitle',
        descKey: 'missionStarrailFreeFormatImageDesc',
      },
    ],
  },
  {
    siteKey: 'genshinCheck',
    siteNameKey: 'siteGenshinCheck',
    headerBg: '#e8f5e9',
    siteUrl: 'https://uko05.github.io/genshinCheck06/',
    missions: [
      {
        id: 'genshinCheckImage',
        reward: 20,
        unlimited: false,
        claimKey: 'genshinCheckImage',
        titleKey: 'missionGenshinCheckImageTitle',
        descKey: 'missionGenshinCheckImageDesc',
      },
    ],
  },
  {
    siteKey: 'starrailCheck',
    siteNameKey: 'siteStarrailCheck',
    headerBg: '#fff8e1',
    siteUrl: 'https://uko05.github.io/starrailCheck07/',
    missions: [
      {
        id: 'starrailCheckImage',
        reward: 20,
        unlimited: false,
        claimKey: 'starrailCheckImage',
        titleKey: 'missionStarrailCheckImageTitle',
        descKey: 'missionStarrailCheckImageDesc',
      },
    ],
  },
  {
    siteKey: 'playMaker',
    siteNameKey: 'sitePlayMaker',
    headerBg: '#ede7f6',
    siteUrl: 'https://uko05.github.io/22_PlayMaker/',
    missions: [
      {
        id: 'playMakerImage',
        reward: 20,
        unlimited: false,
        claimKey: 'playMakerImage',
        titleKey: 'missionPlayMakerImageTitle',
        descKey: 'missionPlayMakerImageDesc',
      },
    ],
  },
];
const missionOpenGroups = new Set(MISSION_GROUPS.map((g) => g.siteKey));

// ===== i18n =====
const i18n = {
  ja: {
    pageTitle: 'うーこポイント交換所',
    headerSub: '貯まったうーこポイント(UP)で、色々なサイトのちょっとした特典と交換できます',
    balanceLabel: '現在の所持UP',
    balanceHint: 'UPは様々なサイトのミッションをクリアすると貯まります',
    itemsTitle: '交換できる特典',
    tabExchange: '交換',
    tabMissions: 'ミッション',
    missionsTitle: 'UPを貯める方法',
    missionRewardLabel: (n) => `+${n}UP`,
    missionUnlimitedLabel: '無制限',
    missionAchievedCount: (n) => `達成回数：${n}回`,
    missionDoneLabel: '達成済み',
    missionNotDoneLabel: '未達成',
    missionGoToSiteBtn: '移動する',
    missionClaimBtn: '受け取る',
    missionClaimSuccess: (n) => `+${n}UPを受け取りました！`,
    missionNotAchievedYet: 'まだミッションの条件を達成していません。',
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
    limitRemaining: (max, remaining) => `交換上限：\n${max}回（あと${remaining}回）`,
    limitReached: '交換上限に\n達しました',
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
    siteStorage: '画像保管庫',
    itemStorageOriginalUploadTitle: '元の画像のまま保存',
    itemStorageOriginalUploadDesc: '画像保管庫で、圧縮せず元の画質のまま画像を保存できるようになります(一度交換すればずっと使えます。ただし1日5枚までの上限があります)。',
    itemStorageExtraUploadTitle: '1日のアップロード上限 ＋1枚',
    itemStorageExtraUploadDesc: '画像保管庫の1日のアップロード上限を永続的に+1枚します(最大10回まで交換可能、合計で+10枚まで)。',
    siteOmikuji: '原神おみくじ',
    itemOmikujiAchDisplayTitle: 'アチーブメント表示を解放',
    itemOmikujiAchDisplayDesc: 'アカウント管理で設定した称号が、おみくじの「みんなの結果」であなたの名前の横に表示されるようになります。',
    itemOmikujiGachaTicketTitle: 'ガチャ券 ×1',
    itemOmikujiGachaTicketDesc: '原神おみくじの裏面デザインガチャを1回引けるガチャ券と交換します(何回でも交換できます)。',
    itemOmikujiTitleFateObserverTitle: 'レジェンド称号「運命の観測者」',
    itemOmikujiTitleFateObserverDesc: '原神おみくじの実績を全部達成すると購入できる、レジェンドレアリティの称号「運命の観測者」です。アカウント管理でいつでも設定できます。',
    missionOmikujiLikeGivenTitle: '他人の結果にいいねをする',
    missionOmikujiLikeGivenDesc: '原神おみくじの「みんなの結果」で、他の人の占い結果に「いいね」を押します。',
    missionOmikujiLikeReceivedTitle: '自分の結果にいいねをされる',
    missionOmikujiLikeReceivedDesc: '自分が占った結果に、他の人から「いいね」をもらいます。',
    siteGenshinRanking: '原神推しキャラランキング',
    missionGenshinRankingImageTitle: '画像を1回生成する（アカウント登録者限定）',
    missionGenshinRankingImageDesc: '原神推しキャラランキングでランキング画像を1回作成すると、初回だけもらえます。アカウント登録（無料）が必要です。',
    siteStarrailRankingPath: 'スタレ推しキャラランキング【運命】',
    missionStarrailRankingPathImageTitle: '画像を1回生成する（アカウント登録者限定）',
    missionStarrailRankingPathImageDesc: 'スタレ推しキャラランキング【運命】でランキング画像を1回作成すると、初回だけもらえます。アカウント登録（無料）が必要です。',
    siteStarrailRankingElement: 'スタレ推しキャラランキング【属性】',
    missionStarrailRankingElementImageTitle: '画像を1回生成する（アカウント登録者限定）',
    missionStarrailRankingElementImageDesc: 'スタレ推しキャラランキング【属性】でランキング画像を1回作成すると、初回だけもらえます。アカウント登録（無料）が必要です。',
    siteGenshinFreeFormat: '原神フリーフォーマット',
    missionGenshinFreeFormatImageTitle: '画像を1回生成する（アカウント登録者限定）',
    missionGenshinFreeFormatImageDesc: '原神フリーフォーマットで画像を1回作成すると、初回だけもらえます。アカウント登録（無料）が必要です。',
    siteStarrailFreeFormat: 'スタレフリーフォーマット',
    missionStarrailFreeFormatImageTitle: '画像を1回生成する（アカウント登録者限定）',
    missionStarrailFreeFormatImageDesc: 'スタレフリーフォーマットで画像を1回作成すると、初回だけもらえます。アカウント登録（無料）が必要です。',
    siteGenshinCheck: '原神チェックシート',
    missionGenshinCheckImageTitle: '画像を1回生成する（アカウント登録者限定）',
    missionGenshinCheckImageDesc: '原神チェックシートで画像を1回作成すると、初回だけもらえます。アカウント登録（無料）が必要です。',
    siteStarrailCheck: 'スタレチェックシート',
    missionStarrailCheckImageTitle: '画像を1回生成する（アカウント登録者限定）',
    missionStarrailCheckImageDesc: 'スタレチェックシートで画像を1回作成すると、初回だけもらえます。アカウント登録（無料）が必要です。',
    sitePlayMaker: '原神・スタレ画面メーカー',
    missionPlayMakerImageTitle: '画像を1回生成する（アカウント登録者限定）',
    missionPlayMakerImageDesc: '原神・スタレ画面メーカーで(原神/スタレ/魔女会いずれかの)画像を1回作成すると、初回だけもらえます。アカウント登録（無料）が必要です。',
  },
  en: {
    pageTitle: 'Uko Point Exchange',
    headerSub: 'Spend your saved-up Uko Points (UP) on small perks across various sites',
    balanceLabel: 'Your current UP',
    balanceHint: 'Earn UP by completing missions across various sites',
    itemsTitle: 'Available Perks',
    tabExchange: 'Exchange',
    tabMissions: 'Missions',
    missionsTitle: 'Ways to Earn UP',
    missionRewardLabel: (n) => `+${n}UP`,
    missionUnlimitedLabel: 'Unlimited',
    missionAchievedCount: (n) => `Completed ${n} times`,
    missionDoneLabel: 'Done',
    missionNotDoneLabel: 'Not done yet',
    missionGoToSiteBtn: 'Go',
    missionClaimBtn: 'Claim',
    missionClaimSuccess: (n) => `Claimed +${n}UP!`,
    missionNotAchievedYet: "You haven't completed this mission's condition yet.",
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
    siteStorage: 'Image Storage',
    itemStorageOriginalUploadTitle: 'Save originals uncompressed',
    itemStorageOriginalUploadDesc: "Lets you save images to Image Storage at full original quality instead of compressed (a one-time purchase that lasts forever, but capped at 5 originals per day).",
    itemStorageExtraUploadTitle: 'Daily upload limit +1',
    itemStorageExtraUploadDesc: 'Permanently adds +1 to Image Storage\'s daily upload limit (redeemable up to 10 times, for up to +10 total).',
    siteOmikuji: 'Genshin Omikuji',
    itemOmikujiAchDisplayTitle: 'Unlock Achievement Display',
    itemOmikujiAchDisplayDesc: "Shows the title you set on Account Center next to your name on Omikuji's \"Everyone's Results\" feed.",
    itemOmikujiGachaTicketTitle: 'Gacha Ticket ×1',
    itemOmikujiGachaTicketDesc: 'Exchange for one gacha ticket to draw the Genshin Omikuji card-back gacha once (redeemable any number of times).',
    itemOmikujiTitleFateObserverTitle: 'Legend Title: "Fate Observer"',
    itemOmikujiTitleFateObserverDesc: 'A legend-rarity title, "Fate Observer" (運命の観測者), purchasable once you\'ve completed every Genshin Omikuji achievement. Equip it anytime from Account Center.',
    missionOmikujiLikeGivenTitle: 'Like someone else\'s result',
    missionOmikujiLikeGivenDesc: 'On Genshin Omikuji\'s "Everyone\'s Results", tap "like" on another person\'s fortune.',
    missionOmikujiLikeReceivedTitle: 'Get your result liked',
    missionOmikujiLikeReceivedDesc: 'Have someone else "like" your own fortune result.',
    siteGenshinRanking: 'Genshin Oshi Character Ranking',
    missionGenshinRankingImageTitle: 'Generate an image once (registered accounts only)',
    missionGenshinRankingImageDesc: 'Create a ranking image once on Genshin Oshi Character Ranking. One-time reward. Requires a free account.',
    siteStarrailRankingPath: 'Honkai: Star Rail Oshi Character Ranking【Path】',
    missionStarrailRankingPathImageTitle: 'Generate an image once (registered accounts only)',
    missionStarrailRankingPathImageDesc: 'Create a ranking image once on Star Rail Oshi Character Ranking【Path】. One-time reward. Requires a free account.',
    siteStarrailRankingElement: 'Honkai: Star Rail Oshi Character Ranking【Element】',
    missionStarrailRankingElementImageTitle: 'Generate an image once (registered accounts only)',
    missionStarrailRankingElementImageDesc: 'Create a ranking image once on Star Rail Oshi Character Ranking【Element】. One-time reward. Requires a free account.',
    siteGenshinFreeFormat: 'Genshin Free Format',
    missionGenshinFreeFormatImageTitle: 'Generate an image once (registered accounts only)',
    missionGenshinFreeFormatImageDesc: 'Create an image once on Genshin Free Format. One-time reward. Requires a free account.',
    siteStarrailFreeFormat: 'Star Rail Free Format',
    missionStarrailFreeFormatImageTitle: 'Generate an image once (registered accounts only)',
    missionStarrailFreeFormatImageDesc: 'Create an image once on Star Rail Free Format. One-time reward. Requires a free account.',
    siteGenshinCheck: 'Genshin Check Sheet',
    missionGenshinCheckImageTitle: 'Generate an image once (registered accounts only)',
    missionGenshinCheckImageDesc: 'Create an image once on Genshin Check Sheet. One-time reward. Requires a free account.',
    siteStarrailCheck: 'Star Rail Check Sheet',
    missionStarrailCheckImageTitle: 'Generate an image once (registered accounts only)',
    missionStarrailCheckImageDesc: 'Create an image once on Star Rail Check Sheet. One-time reward. Requires a free account.',
    sitePlayMaker: 'Genshin/Star Rail Screen Maker',
    missionPlayMakerImageTitle: 'Generate an image once (registered accounts only)',
    missionPlayMakerImageDesc: 'Create an image once (Genshin, Star Rail, or Majokai) on the Screen Maker. One-time reward. Requires a free account.',
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
  renderMissionGroups();
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
let latestMissionStats = {};
let latestMissionsClaimed = {};
let latestMissionsAchieved = {};

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
    latestMissionStats = {
      totalLikesGiven: data.totalLikesGiven || 0,
      totalLikesReceived: data.totalLikesReceived || 0,
    };
    latestMissionsClaimed = data.missionsClaimed || {};
    latestMissionsAchieved = data.missionsAchieved || {};
    if (el) el.textContent = latestUkoPoints;
    renderSiteGroups();
    renderMissionGroups();
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

// ===== ミッション一覧の描画(交換所グループと同じ見た目)
// 一度きりミッション(claimKeyあり)はソシャゲ方式の3段階:
//   ①未達成 → 「移動する」ボタンでサイトへ移動
//   ②条件達成済み(missionsAchieved) → 「受け取る」ボタンでUP受け取り(この時初めてukoPoints加算)
//   ③受け取り済み(missionsClaimed) → 「達成済み」表示のみ
// 無制限ミッション(おみくじのいいね等)はその場でUPが付与される既存仕様のため、
// 受け取るボタンは無く常に「移動する」+達成回数を表示する。 =====
function buildMissionCard(mission, siteUrl) {
  const t = s();
  const card = document.createElement('div');
  card.className = 'item-card';

  const reward = document.createElement('span');
  reward.className = 'item-reward';
  const rewardNum = document.createElement('span');
  rewardNum.textContent = t.missionRewardLabel(mission.reward);
  reward.appendChild(rewardNum);
  card.appendChild(reward);

  const info = document.createElement('div');
  info.className = 'item-info';
  const title = document.createElement('p');
  title.className = 'item-title';
  title.textContent = t[mission.titleKey];
  info.appendChild(title);
  const desc = document.createElement('p');
  desc.className = 'item-desc';
  desc.textContent = t[mission.descKey];
  info.appendChild(desc);
  card.appendChild(info);

  const action = document.createElement('div');
  action.className = 'item-action';

  const gotoBtn = () => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'item-mission-goto-btn';
    btn.textContent = t.missionGoToSiteBtn;
    btn.addEventListener('click', () => window.open(siteUrl, '_blank', 'noopener'));
    return btn;
  };

  if (mission.unlimited) {
    action.appendChild(gotoBtn());
    const status = document.createElement('p');
    status.className = 'item-mission-status';
    status.textContent = `${t.missionUnlimitedLabel}\n${t.missionAchievedCount(latestMissionStats[mission.statKey] || 0)}`;
    action.appendChild(status);
  } else {
    const claimed = !!latestMissionsClaimed[mission.claimKey];
    const achieved = !!latestMissionsAchieved[mission.claimKey];
    if (claimed) {
      const status = document.createElement('p');
      status.className = 'item-mission-status item-mission-status-done';
      status.textContent = t.missionDoneLabel;
      action.appendChild(status);
    } else if (achieved) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'item-mission-claim-btn';
      btn.textContent = t.missionClaimBtn;
      btn.addEventListener('click', () => handleMissionClaim(mission));
      action.appendChild(btn);
    } else {
      action.appendChild(gotoBtn());
      const status = document.createElement('p');
      status.className = 'item-mission-status';
      status.textContent = t.missionNotDoneLabel;
      action.appendChild(status);
    }
  }

  card.appendChild(action);

  return card;
}

function renderMissionGroups() {
  const list = document.getElementById('mission-group-list');
  if (!list) return;
  const t = s();
  list.innerHTML = '';

  MISSION_GROUPS.forEach((group) => {
    const details = document.createElement('details');
    details.className = 'site-group';
    details.open = missionOpenGroups.has(group.siteKey);
    details.addEventListener('toggle', () => {
      if (details.open) missionOpenGroups.add(group.siteKey);
      else missionOpenGroups.delete(group.siteKey);
    });

    const summary = document.createElement('summary');
    summary.className = 'site-group-header';
    summary.textContent = t[group.siteNameKey];
    if (group.headerBg) summary.style.background = group.headerBg;
    details.appendChild(summary);

    const itemsDiv = document.createElement('div');
    itemsDiv.className = 'site-group-items';
    group.missions.forEach((mission) => itemsDiv.appendChild(buildMissionCard(mission, group.siteUrl)));
    details.appendChild(itemsDiv);

    list.appendChild(details);
  });
}

// ===== ミッション報酬の受け取り(条件達成済み → 受け取り済みへ、この時にukoPointsを加算) =====
async function handleMissionClaim(mission) {
  const t = s();
  const userId = getUserId();
  const ref = doc(db, 'omikujiUsers', userId);

  try {
    const claimed = await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('NO_USER_DOC');
      const data = snap.data();
      if (data.missionsClaimed?.[mission.claimKey]) return false; // 二重クリック対策
      if (!data.missionsAchieved?.[mission.claimKey]) throw new Error('NOT_ACHIEVED');

      tx.update(ref, {
        ukoPoints: increment(mission.reward),
        [`missionsClaimed.${mission.claimKey}`]: true,
      });
      return true;
    });
    if (claimed) showToast(t.missionClaimSuccess(mission.reward), false);
  } catch (e) {
    if (e.message === 'NO_USER_DOC') {
      showToast(t.redeemNoUserDoc, true);
    } else if (e.message === 'NOT_ACHIEVED') {
      showToast(t.missionNotAchievedYet, true);
    } else {
      console.error('[upoint] mission claim failed', e);
      showToast(t.redeemFail, true);
    }
  }
}

// ===== タブ切り替え =====
function initTabs() {
  const buttons = document.querySelectorAll('.tab-btn');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      buttons.forEach((b) => b.classList.toggle('active', b === btn));
      document.getElementById('tab-panel-exchange').hidden = tab !== 'exchange';
      document.getElementById('tab-panel-missions').hidden = tab !== 'missions';
    });
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
initTabs();
startBalanceListener();
