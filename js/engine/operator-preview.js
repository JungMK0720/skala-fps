/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 작전 지휘소(메뉴) 가운데 무대에 장착한 대원을 3D로 보여 준다. 작은 전용 렌더러로 받침대 위에서 천천히 돌고, 끌면 돌려 볼 수 있다.
 *          무대가 안 보이거나 탭이 숨으면 그리기를 멈추고, 끝낼 때 WebGL 자원을 모두 놓는다. 게임 렌더러는 건드리지 않는다.
 */
/*
 *   const preview = createOperatorPreview({ container: ui.operatorStage(), settings, team: 'owner' })
 *   preview.setAvatar(id)   // 대원 바꾸기(모르는 id는 기본 대원). container.dataset.avatar가 바뀌어도 따라간다(메뉴 캡션과 같은 값)
 *   preview.setTeam(team)
 *   preview.dispose()
 *
 * 대원 모델은 engine/operator-model.js의 loadOperators()로 한 번만 받는다(게임 아바타·상점 초상과 같은 템플릿).
 * 받지 못하면 캔버스를 붙이지 않는다 → 메뉴의 빈 격자 무대가 그대로 보인다(모델 오류는 맵 불러오기가 화면에 알린다).
 * 품질 설정 'low'면 픽셀 비율 1·안티에일리어싱 없이, 그 밖에는 기기 비율을 1.5까지 쓴다.
 */
import * as THREE from 'three';
import { loadOperators, OperatorBody } from './operator-model.js';
import { avatarIdOf } from '../core/avatar-defs.js';
import { t } from '../core/i18n.js';

const TURN_SPEED = 0.35;    // 저절로 도는 빠르기(rad/s)
const DRAG_TURN = 0.012;    // 끈 픽셀당 회전(rad)
const RESUME_AFTER = 2.5;   // 끌기를 멈추고 이만큼 지나면 다시 저절로 돈다(초)

export function createOperatorPreview({ container, settings = null, team = 'owner' } = {}) {
  if (!container || typeof document === 'undefined') return null;
  let disposed = false;
  let renderer = null, body = null, raf = 0, last = 0;
  let visible = false;
  let avatarId = avatarIdOf(container.dataset.avatar);
  let teamId = team;
  let yaw = -0.45, dragX = null, idleFor = RESUME_AFTER;

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xd6e6ff, 0x3a3328, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(-1.6, 3.2, -3.0);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xe8a33d, 1.1);   // 받침대 쪽 호박색 테두리 빛(무대 강조색)
  rim.position.set(2.2, 1.6, 2.4);
  scene.add(rim);
  // 받침대: 호박색 고리 + 안쪽 점선 느낌의 어두운 원판
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xe8a33d, transparent: true, opacity: 0.75 });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.66, 64), ringMat);
  ring.rotation.x = -Math.PI / 2;
  const discMat = new THREE.MeshBasicMaterial({ color: 0x0d141c, transparent: true, opacity: 0.6 });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.62, 48), discMat);
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = -0.002;
  scene.add(ring, disc);
  const turn = new THREE.Group();
  scene.add(turn);
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 30);

  function lowQuality() { return !!(settings && typeof settings.get === 'function' && settings.get('quality') === 'low'); }

  /** 무대 크기에 맞춰 캔버스·카메라를 맞춘다. 대원(약 1.85 m)과 받침대가 세로로 다 들어가게 거리를 정한다 */
  function fit() {
    if (!renderer) return;
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    renderer.setPixelRatio(lowQuality() ? 1 : Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const half = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const needH = 2.25 / 2, needW = 1.5 / 2;   // 세로 2.25 m(발 아래 고리 ~ 모자 위), 가로 1.5 m(총 끝까지)
    const dist = Math.max(needH / half, needW / (half * camera.aspect));
    camera.position.set(0, 1.1, -dist);
    camera.lookAt(0, 0.92, 0);
    camera.updateProjectionMatrix();
  }

  function frame(now) {
    raf = 0;
    if (disposed || !visible) return;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0);
    last = now;
    if (dragX === null) {
      idleFor += dt;
      if (idleFor >= RESUME_AFTER) yaw += TURN_SPEED * dt;
    }
    turn.rotation.y = yaw;
    body.update(dt, {});
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  function start() {
    if (disposed || !renderer || !visible || raf) return;
    last = 0;
    raf = requestAnimationFrame(frame);
  }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

  /** 무대가 화면에 보이고 탭도 보일 때만 그린다 */
  function updateVisible(onScreen) {
    visible = !!onScreen && !document.hidden;
    if (visible) { fit(); start(); } else stop();
  }
  let onScreen = false;
  const io = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => { onScreen = entries.some((e) => e.isIntersecting); updateVisible(onScreen); })
    : null;
  const onTab = () => updateVisible(onScreen);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (visible) fit(); }) : null;
  // 메뉴 캡션(UNIT·이름)과 같은 값: menu.js가 container.dataset.avatar를 바꾸면 따라간다
  const mo = new MutationObserver(() => api.setAvatar(container.dataset.avatar));

  // 끌어서 돌리기
  const onDown = (e) => { dragX = e.clientX; idleFor = 0; if (renderer) renderer.domElement.setPointerCapture(e.pointerId); };
  const onMove = (e) => { if (dragX === null) return; yaw += (e.clientX - dragX) * DRAG_TURN; dragX = e.clientX; };
  const onUp = () => { dragX = null; idleFor = 0; };

  function mount(tpl) {
    if (disposed) return;
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: !lowQuality(), powerPreference: 'low-power' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.setClearColor(0x000000, 0);
    const canvas = renderer.domElement;
    canvas.className = 'sk-operator-canvas';
    canvas.style.touchAction = 'pan-y';   // 휴대폰에서 세로 스크롤은 그대로, 가로로 끌면 돌린다
    canvas.style.pointerEvents = 'auto';
    canvas.style.cursor = 'grab';
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    body = new OperatorBody(tpl, avatarId, teamId);
    body.update(0, {});
    turn.add(body.root);
    container.appendChild(canvas);
    container.removeAttribute('aria-hidden');
    container.setAttribute('role', 'img');
    if (io) io.observe(container); else updateVisible(true);
    if (ro) ro.observe(container);
    mo.observe(container, { attributes: true, attributeFilter: ['data-avatar'] });
    document.addEventListener('visibilitychange', onTab);
    syncLabel();
  }
  function syncLabel() {
    container.setAttribute('aria-label', t('shop.operatorPreview', { name: container.dataset.avatar || avatarId }));
  }

  const api = {
    /** 장착 대원 바꾸기 */
    setAvatar(id) {
      const v = avatarIdOf(id);
      if (v === avatarId) return;
      avatarId = v;
      if (body) { body.setLook(avatarId, teamId); syncLabel(); }
    },
    setTeam(t) {
      if (!t || t === teamId) return;
      teamId = t;
      if (body) body.setLook(avatarId, teamId);
    },
    get avatarId() { return avatarId; },
    get rendering() { return !!raf; },
    get canvas() { return renderer ? renderer.domElement : null; },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      if (io) io.disconnect();
      if (ro) ro.disconnect();
      mo.disconnect();
      document.removeEventListener('visibilitychange', onTab);
      if (body) { body.dispose(); body = null; }
      ring.geometry.dispose(); ringMat.dispose(); disc.geometry.dispose(); discMat.dispose();
      if (renderer) {
        const canvas = renderer.domElement;
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onUp);
        renderer.dispose();
        renderer.forceContextLoss();
        canvas.remove();
        renderer = null;
      }
      container.setAttribute('aria-hidden', 'true');
      container.removeAttribute('role');
      container.removeAttribute('aria-label');
    }
  };

  loadOperators().then(mount, (err) => console.warn('[operator-preview] 대원 모델이 없어 빈 무대를 그대로 둔다', err && err.message));
  return api;
}
