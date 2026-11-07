/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 플레이 테스트 시나리오 목록. 순서대로 돈다. 시나리오는 { name, title, timeoutMs, run(t) } 모양이다.
 */
import firstRun from './first-run.mjs';
import menus from './menus.mjs';
import practice from './practice.mjs';
import weapons from './weapons.mjs';
import damage from './damage.mjs';
import movement from './movement.mjs';
import props from './props.mjs';
import debug from './debug.mjs';
import multi from './multi.mjs';
import controls from './controls.mjs';
import multiPlay from './multi-play.mjs';
import robust from './robust.mjs';
import monkey from './monkey.mjs';
import gallery from './gallery.mjs';
import maps from './maps.mjs';
import drops from './drops.mjs';
import mobile from './mobile.mjs';
import mobileMenus from './mobile-menus.mjs';

export const SCENARIOS = [firstRun, menus, practice, weapons, damage, drops, mobile, mobileMenus, movement, props, debug, multi, controls, multiPlay, robust, monkey, gallery, maps];
