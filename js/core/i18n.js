/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 화면 글자의 한국어·영어 전환. t(key, vars)로 표의 글자를, loc(obj, 'name')으로 데이터의 짝 칸(name/nameEn)을 읽는다.
 *          three.js에 의존하지 않아 node 시험에서도 불러올 수 있다.
 */
/**
 * 사용법
 *   import { t, loc, getLang } from '../core/i18n.js';
 *   t('menu.deploy')                    // '출격' | 'Deploy'
 *   t('hud.killedBy', { name: 'Kim' })  // 표의 '{name}' 자리를 채운다
 *   loc(weapon, 'name')                 // 영어면 weapon.nameEn, 없거나 한국어면 weapon.name
 *
 * 표: js/core/lang/<영역>.js 가 `export default { 'key': ['한국어', 'English'], ... }`를 내보낸다.
 *   글자를 더할 때는 해당 영역 표에 한 줄을 넣는다. 새 영역 파일을 만들면 아래 TABLES에 한 줄 더한다.
 *   키는 '영역.이름' 모양이고, 두 말의 {자리} 이름이 같아야 한다(tests/i18n.test.mjs가 확인).
 *
 * 언어: 설정 'lang'('ko' | 'en' | '' = 자동). 자동이면 브라우저 첫 언어가 한국어일 때만 한국어, 나머지는 영어.
 *   CrazyGames 안에서도 같은 규칙이다(브라우저가 한국어가 아니면 영어).
 *   모듈을 불러오는 순간 저장된 설정을 읽어 언어를 정하므로, 다른 모듈이 불러올 때 만든 글자도 맞는 언어다.
 *   언어를 바꾸면 페이지를 다시 연다(ui/settings.js). 이미 그린 화면을 모두 다시 그리지 않기 위해서다.
 */
import { SETTINGS_KEY } from './settings.js';
import { BRAND } from './brand.js';
import common from './lang/common.js';
import menu from './lang/menu.js';
import room from './lang/room.js';
import results from './lang/results.js';
import shop from './lang/shop.js';
import account from './lang/account.js';
import settings from './lang/settings.js';
import hud from './lang/hud.js';
import game from './lang/game.js';
import horde from './lang/horde.js';
import net from './lang/net.js';
import engine from './lang/engine.js';
import portal from './lang/portal.js';
import weapons from './lang/weapons.js';
import maps from './lang/maps.js';

export const LANGS = Object.freeze(['ko', 'en']);

/** 영역별 표. 같은 키가 두 영역에 있으면 뒤의 것이 이긴다(시험이 중복을 막는다) */
export const TABLES = Object.freeze({ common, menu, room, results, shop, account, settings, hud, game, horde, net, engine, portal, weapons, maps });

const STRINGS = Object.assign({}, ...Object.values(TABLES));

/**
 * 저장된 값과 브라우저 언어로 쓸 언어를 고른다.
 * @param {{saved?:string, languages?:string[]}} o saved = 설정 'lang', languages = navigator.languages
 * @returns {'ko'|'en'}
 */
export function detectLang({ saved, languages } = {}) {
  if (saved === 'ko' || saved === 'en') return saved;
  const first = (Array.isArray(languages) ? languages : []).find((l) => typeof l === 'string' && l) || '';
  return /^ko\b/i.test(first) ? 'ko' : 'en';
}

function savedLang() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    return raw && typeof raw.lang === 'string' ? raw.lang : '';
  } catch (e) { return ''; }
}

function browserLanguages() {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages && navigator.languages.length ? [...navigator.languages] : [navigator.language];
}

let lang = typeof localStorage === 'undefined' ? 'ko' : detectLang({ saved: savedLang(), languages: browserLanguages() });

/** 지금 언어 */
export const getLang = () => lang;
export const isEnglish = () => lang === 'en';

/** 언어를 바꾼다(시험·페이지 시작용). 이미 그린 화면은 바뀌지 않는다 */
export function setLang(next) {
  lang = next === 'en' ? 'en' : 'ko';
  applyDocumentLang();
  return lang;
}

const warned = new Set();
const fill = (text, vars) => (vars ? text.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k]))) : text);

/**
 * 표의 글자. 없는 키는 키 그대로 돌려주고 콘솔에 한 번 알린다.
 * @param {string} key
 * @param {Object<string,*>} [vars] {자리} 값
 */
export function t(key, vars) {
  const pair = STRINGS[key];
  if (!pair) {
    if (!warned.has(key)) { warned.add(key); console.warn('[i18n] missing key', key); }
    return key;
  }
  return fill(pair[lang === 'en' ? 1 : 0], vars);
}

/** 키가 표에 있는가 */
export const hasKey = (key) => Object.prototype.hasOwnProperty.call(STRINGS, key);

/**
 * 데이터의 짝 칸을 읽는다. 영어면 obj[field + 'En'], 없으면 obj[field].
 * @param {object} obj 무기·맵·이모트 같은 데이터
 * @param {string} field 한국어 칸 이름('name', 'desc' …)
 */
export function loc(obj, field) {
  if (!obj) return '';
  if (lang === 'en') {
    const en = obj[field + 'En'];
    if (en !== undefined && en !== null && en !== '') return en;
  }
  return obj[field];
}

/** 숫자를 언어에 맞게 묶는다(1,234) */
export const fmtNum = (n) => Number(n || 0).toLocaleString(lang === 'en' ? 'en-US' : 'ko-KR');

/** <html lang>과 문서 제목(브랜드 이름)을 지금 언어로 맞춘다 */
export function applyDocumentLang() {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang;
  document.title = loc(BRAND, 'name');
}
