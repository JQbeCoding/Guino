import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const MENU_ITEMS = [
    { label: 'Dashboard', href: '/dashboard', id: 'dashboard' },
    { label: 'Courses', href: '/courses', id: 'courses' },
    { label: 'GPA', href: '/gpa', id: 'gpa' },
    { label: 'Study', href: '/study', id: 'study' },
    { label: 'Settings', href: '/settings', id: 'settings' },
];

const SCREEN_W = 1024;
const SCREEN_H = 768;
const MENU_START_Y = 260;
const MENU_ROW_H = 72;
const MENU_X = 100;
const MENU_W = 824;
const TRANSITION_MS = 1400;
const SCREEN_LAYOUT = { x: 0, y: 1.65, z: -3.8, w: 5.8, h: 3.3, frame: 0.18 };

const isDark = localStorage.getItem('guino_theme') === 'dark';

const canvas = document.getElementById('scene');
const fallback = document.getElementById('webgl-fallback');
const loadingEl = document.getElementById('loading');

let renderer;
try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
} catch {
    fallback.style.display = 'flex';
    loadingEl?.classList.add('hidden');
    throw new Error('WebGL unavailable');
}

renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = isDark ? 0.95 : 1.1;

const scene = new THREE.Scene();
scene.background = new THREE.Color(isDark ? 0x0a1628 : 0xb8d4e8);
scene.fog = new THREE.FogExp2(isDark ? 0x0a1628 : 0xb8d4e8, isDark ? 0.045 : 0.035);

const workspace = new THREE.Group();
scene.add(workspace);

const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 80);
camera.position.set(0, 1.35, 3.6);

const controls = new OrbitControls(camera, canvas);
controls.enablePan = false;
controls.minDistance = 2.2;
controls.maxDistance = 6;
controls.maxPolarAngle = Math.PI / 2.05;
controls.minAzimuthAngle = -0.4;
controls.maxAzimuthAngle = 0.4;

scene.add(new THREE.AmbientLight(isDark ? 0x6688aa : 0xc8dce8, isDark ? 0.55 : 0.65));
const moonLight = new THREE.DirectionalLight(isDark ? 0xaabbff : 0xfff8f0, isDark ? 0.75 : 1.0);
moonLight.position.set(-3, 6, 4);
scene.add(moonLight);
const rimLight = new THREE.DirectionalLight(0x88ccff, 0.35);
rimLight.position.set(3, 2, -2);
scene.add(rimLight);

const loader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();
const loadGLTF = (url) => new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject);
});
const loadTex = (url) => new Promise((resolve, reject) => {
    texLoader.load(url, resolve, undefined, reject);
});

function centerOnFloor(object) {
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    const center = box.getCenter(new THREE.Vector3());
    object.position.x -= center.x;
    object.position.y -= box.min.y;
    object.position.z -= center.z;
    object.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(object);
}

function setupPenguin(root) {
    root.visible = true;
    root.traverse((child) => {
        child.visible = true;
        if (!child.isMesh || !child.material) return;
        child.frustumCulled = false;
        const src = Array.isArray(child.material) ? child.material[0] : child.material;
        const mat = src.clone();
        mat.side = THREE.DoubleSide;
        mat.transparent = false;
        mat.alphaTest = 0.5;
        mat.depthWrite = true;
        if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace;
        child.material = mat;
    });
}

function placePenguin(penguinGltf) {
    const wrap = new THREE.Group();
    const s = SCREEN_LAYOUT;
    // Bottom-right corner of the screen, feet on the snow
    wrap.position.set(
        s.x + s.w / 2 + s.frame * 0.4 - 0.25,
        0,
        s.z + 0.5
    );
    workspace.add(wrap);

    const model = penguinGltf.scene;
    model.scale.setScalar(0.46);
    model.rotation.y = Math.PI;
    model.position.set(0.28, 0, 0);
    wrap.add(model);
    setupPenguin(model);

    model.updateMatrixWorld(true);
    const feetBox = new THREE.Box3().setFromObject(model);
    model.position.y -= feetBox.min.y;

    wrap.userData.baseY = wrap.position.y;
    return wrap;
}

// --- Canvas UI ---

const screenCanvas = document.createElement('canvas');
screenCanvas.width = SCREEN_W;
screenCanvas.height = SCREEN_H;
const screenCtx = screenCanvas.getContext('2d');
const screenTexture = new THREE.CanvasTexture(screenCanvas);
screenTexture.colorSpace = THREE.SRGBColorSpace;

let screenMesh = null;
let defaultCameraPos = camera.position.clone();
let defaultTarget = new THREE.Vector3(0, 1.55, -2.5);

function getMenuRects() {
    return MENU_ITEMS.map((item, i) => ({
        ...item,
        x: MENU_X,
        y: MENU_START_Y + i * MENU_ROW_H,
        w: MENU_W,
        h: MENU_ROW_H - 10,
    }));
}

function drawScreenBackground(ctx) {
    ctx.fillStyle = '#0D1117';
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    ctx.fillStyle = '#1C1C1C';
    ctx.fillRect(0, 0, SCREEN_W, 56);
    ctx.fillStyle = '#F4A227';
    ctx.font = 'bold 22px monospace';
    ctx.fillText('Guino OS v1.0', 24, 36);
    ctx.strokeStyle = '#5C6B73';
    ctx.lineWidth = 2;
    ctx.strokeRect(8, 8, SCREEN_W - 16, SCREEN_H - 16);
}

function drawMenu(ctx, hoverIndex) {
    drawScreenBackground(ctx);
    ctx.font = 'bold 28px monospace';
    ctx.fillStyle = '#5C6B73';
    ctx.fillText('Select a destination:', MENU_X, 200);
    getMenuRects().forEach((item, i) => {
        const hovered = i === hoverIndex;
        if (hovered) {
            ctx.fillStyle = '#F4A22733';
            ctx.fillRect(item.x - 8, item.y - 4, item.w + 16, item.h + 8);
            ctx.strokeStyle = '#F4A227';
            ctx.lineWidth = 2;
            ctx.strokeRect(item.x - 8, item.y - 4, item.w + 16, item.h + 8);
        }
        ctx.fillStyle = hovered ? '#F4A227' : '#F5F5F0';
        ctx.font = `${hovered ? 'bold ' : ''}32px monospace`;
        ctx.fillText(hovered ? '> ' + item.label : '  ' + item.label, item.x, item.y + 40);
    });
    ctx.fillStyle = '#5C6B73';
    ctx.font = '18px monospace';
    ctx.fillText('Click to launch', MENU_X, SCREEN_H - 48);
}

function drawDashboardTransition(ctx, t) {
    drawScreenBackground(ctx);
    ctx.fillStyle = '#F5F5F0';
    ctx.font = 'bold 26px monospace';
    ctx.fillText('Loading feed...', 80, 120);
    ['● Cloud Computing Lab — Due Fri', '● Data Structures HW — Due Mon', '● Systems Project — Due Wed'].forEach((line, i) => {
        ctx.fillStyle = i === 0 ? '#F4A227' : '#F5F5F0';
        ctx.font = '22px monospace';
        ctx.fillText(line, 80, 200 + i * 56 - (t * 180 % 200));
    });
    ctx.fillStyle = '#F4A227';
    ctx.fillRect(80, 560, Math.min(1, t * 1.4) * 600, 12);
}

function drawCoursesTransition(ctx, t) {
    drawScreenBackground(ctx);
    ctx.fillStyle = '#F5F5F0';
    ctx.font = 'bold 26px monospace';
    ctx.fillText('Opening courses...', 80, 100);
    [180, 340, 500].forEach((x, i) => {
        const slide = Math.min(1, Math.max(0, (t - i * 0.15) * 2));
        ctx.fillStyle = ['#F4A227', '#5C6B73', '#F5F5F0'][i];
        ctx.fillRect(x, 400 - slide * 220, 100, 140);
    });
}

function drawGpaTransition(ctx, t) {
    drawScreenBackground(ctx);
    ctx.fillStyle = '#F5F5F0';
    ctx.font = 'bold 26px monospace';
    ctx.fillText('Calculating grades...', 80, 100);
    [0.88, 0.92, 0.78].forEach((h, i) => {
        const x = 160 + i * 200;
        const grow = Math.min(1, Math.max(0, (t - i * 0.12) * 1.8));
        ctx.fillStyle = '#F4A227';
        ctx.fillRect(x, 420 - 280 * h * grow, 80, 280 * h * grow);
    });
}

function drawStudyTransition(ctx, t) {
    drawScreenBackground(ctx);
    ctx.fillStyle = '#F5F5F0';
    ctx.font = 'bold 26px monospace';
    ctx.fillText('Preparing flashcards...', 80, 100);
    const angle = Math.min(Math.PI, t * Math.PI * 1.2);
    ctx.save();
    ctx.translate(SCREEN_W / 2, 340);
    ctx.scale(Math.cos(angle), 1);
    ctx.fillStyle = '#F5F5F0';
    ctx.fillRect(-160, -100, 320, 200);
    ctx.strokeStyle = '#F4A227';
    ctx.lineWidth = 3;
    ctx.strokeRect(-160, -100, 320, 200);
    ctx.fillStyle = '#1C1C1C';
    ctx.font = '22px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(angle < Math.PI / 2 ? 'What is cloud elasticity?' : 'Auto-scaling resources', 0, 10);
    ctx.restore();
}

function drawSettingsTransition(ctx, t) {
    drawScreenBackground(ctx);
    ctx.fillStyle = '#F5F5F0';
    ctx.font = 'bold 26px monospace';
    ctx.fillText('Applying preferences...', 80, 100);
    ctx.save();
    ctx.translate(SCREEN_W / 2, 340);
    ctx.rotate(t * Math.PI * 3);
    ctx.fillStyle = '#F4A227';
    ctx.beginPath();
    for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const r = i % 2 === 0 ? 80 : 60;
        if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

const TRANSITION_DRAWERS = {
    dashboard: drawDashboardTransition,
    courses: drawCoursesTransition,
    gpa: drawGpaTransition,
    study: drawStudyTransition,
    settings: drawSettingsTransition,
};

function buildProjectorScreen() {
    const group = new THREE.Group();
    group.position.set(SCREEN_LAYOUT.x, SCREEN_LAYOUT.y, SCREEN_LAYOUT.z);

    const screenW = SCREEN_LAYOUT.w;
    const screenH = SCREEN_LAYOUT.h;
    const frameMat = new THREE.MeshStandardMaterial({
        color: 0xd8eef8,
        roughness: 0.25,
        metalness: 0.05,
        emissive: 0x224466,
        emissiveIntensity: isDark ? 0.15 : 0.05,
    });

    const frameDepth = 0.12;
    const frameThick = SCREEN_LAYOUT.frame;
    const frames = [
        [screenW + frameThick * 2, frameThick, frameDepth, 0, screenH / 2 + frameThick / 2, 0],
        [screenW + frameThick * 2, frameThick, frameDepth, 0, -screenH / 2 - frameThick / 2, 0],
        [frameThick, screenH, frameDepth, -screenW / 2 - frameThick / 2, 0, 0],
        [frameThick, screenH, frameDepth, screenW / 2 + frameThick / 2, 0, 0],
    ];
    frames.forEach(([w, h, d, x, y, z]) => {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), frameMat);
        bar.position.set(x, y, z);
        group.add(bar);
    });

    const screen = new THREE.Mesh(
        new THREE.PlaneGeometry(screenW, screenH),
        new THREE.MeshBasicMaterial({ map: screenTexture, toneMapped: false })
    );
    screen.name = 'monitorScreen';
    screen.position.z = 0.02;
    group.add(screen);

    const glow = new THREE.Mesh(
        new THREE.PlaneGeometry(screenW + 0.6, screenH + 0.6),
        new THREE.MeshBasicMaterial({
            color: 0x88ccff,
            transparent: true,
            opacity: isDark ? 0.12 : 0.08,
            depthWrite: false,
        })
    );
    glow.position.z = -0.05;
    group.add(glow);

    return { group, screen };
}

function buildProjectorBeam(origin, target) {
    const group = new THREE.Group();
    group.position.copy(origin);
    group.lookAt(target);

    const body = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 0.1, 0.16),
        new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.6 })
    );
    body.position.set(0, 0.05, -0.04);
    group.add(body);

    const lens = new THREE.Mesh(
        new THREE.CylinderGeometry(0.04, 0.05, 0.06, 12),
        new THREE.MeshStandardMaterial({ color: 0x88ccff, emissive: 0x4488cc, emissiveIntensity: 0.6 })
    );
    lens.rotation.x = Math.PI / 2;
    lens.position.set(0, 0.08, 0.06);
    group.add(lens);

    const len = origin.distanceTo(target);
    const beam = new THREE.Mesh(
        new THREE.ConeGeometry(0.85, len, 32, 1, true),
        new THREE.MeshBasicMaterial({
            color: 0xaad4ff,
            transparent: true,
            opacity: 0.07,
            side: THREE.DoubleSide,
            depthWrite: false,
        })
    );
    beam.rotation.x = -Math.PI / 2;
    beam.position.z = -len / 2;
    group.add(beam);

    return group;
}

async function buildScene() {
    const [snowTex, iglooGltf, penguinGltf] = await Promise.all([
        loadTex('/assets/snow_mountain/textures/snow_baseColor.png'),
        loadGLTF('/assets/igloo/scene.gltf'),
        loadGLTF('/assets/penguin/model.gltf'),
    ]);

    snowTex.wrapS = snowTex.wrapT = THREE.RepeatWrapping;
    snowTex.repeat.set(6, 6);
    snowTex.colorSpace = THREE.SRGBColorSpace;

    const ground = new THREE.Mesh(
        new THREE.CircleGeometry(18, 64),
        new THREE.MeshStandardMaterial({ map: snowTex, roughness: 0.95, metalness: 0.0 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const igloo = iglooGltf.scene;
    igloo.scale.setScalar(1.15);
    workspace.add(igloo);
    centerOnFloor(igloo);
    const iglooGround = igloo.getObjectByName('ground_1');
    if (iglooGround) iglooGround.visible = false;
    igloo.position.set(-3.2, 0, -1.2);
    igloo.rotation.y = Math.PI * 0.35;

    const { group: screenGroup, screen } = buildProjectorScreen();
    workspace.add(screenGroup);
    screenMesh = screen;

    const screenWorld = new THREE.Vector3(SCREEN_LAYOUT.x, SCREEN_LAYOUT.y, SCREEN_LAYOUT.z);
    const projectorOrigin = new THREE.Vector3(-1.35, 0.1, 0.45);
    workspace.add(buildProjectorBeam(projectorOrigin, screenWorld));

    const projectorLight = new THREE.SpotLight(0xaaccff, isDark ? 1.2 : 0.8, 12, Math.PI / 5, 0.4);
    projectorLight.position.copy(projectorOrigin);
    projectorLight.target.position.copy(screenWorld);
    workspace.add(projectorLight);
    workspace.add(projectorLight.target);

    const penguinWrap = placePenguin(penguinGltf);

    defaultTarget.set(0, 1.1, -2.4);
    controls.target.copy(defaultTarget);
    camera.position.set(0.2, 1.1, 3.0);
    defaultCameraPos = camera.position.clone();
    controls.update();

    return { penguinWrap };
}

// --- Interaction ---

let hoverIndex = -1;
let transition = null;
let returnEntrance = null;
let penguinWrap = null;
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function hitTestMenu(u, v) {
    const x = u * SCREEN_W;
    const y = (1 - v) * SCREEN_H;
    for (let i = 0; i < getMenuRects().length; i++) {
        const r = getMenuRects()[i];
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return i;
    }
    return -1;
}

function onPointerMove(event) {
    if (transition || !screenMesh) return;
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(screenMesh);
    if (hits.length) {
        hoverIndex = hitTestMenu(hits[0].uv.x, hits[0].uv.y);
        canvas.style.cursor = hoverIndex >= 0 ? 'pointer' : 'default';
    } else {
        hoverIndex = -1;
        canvas.style.cursor = 'default';
    }
}

function onPointerDown(event) {
    if (transition || !screenMesh) return;
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(screenMesh);
    if (!hits.length) return;
    const idx = hitTestMenu(hits[0].uv.x, hits[0].uv.y);
    if (idx >= 0) {
        transition = { id: MENU_ITEMS[idx].id, href: MENU_ITEMS[idx].href, start: performance.now() };
        hoverIndex = -1;
        canvas.style.cursor = 'default';
    }
}

canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointerdown', onPointerDown);

const clock = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);
    const t = clock.elapsedTime;

    if (penguinWrap) {
        penguinWrap.position.y = penguinWrap.userData.baseY + Math.sin(t * 2) * 0.015;
        penguinWrap.rotation.z = Math.sin(t * 1.4) * 0.02;
    }

    if (screenMesh) {
        if (returnEntrance) {
            const elapsed = performance.now() - returnEntrance.start;
            const progress = Math.min(1, elapsed / TRANSITION_MS);
            const ease = 1 - Math.pow(1 - progress, 3);
            camera.position.lerpVectors(returnEntrance.fromPos, defaultCameraPos, ease);
            controls.target.lerpVectors(returnEntrance.fromTarget, defaultTarget, ease);
            if (progress >= 1) returnEntrance = null;
        } else if (transition) {
            const elapsed = performance.now() - transition.start;
            const progress = Math.min(1, elapsed / TRANSITION_MS);
            TRANSITION_DRAWERS[transition.id](screenCtx, progress);
            screenTexture.needsUpdate = true;

            camera.position.lerpVectors(
                defaultCameraPos,
                new THREE.Vector3(defaultCameraPos.x, 1.2, defaultCameraPos.z - 0.8),
                progress * 0.4
            );
            controls.target.lerpVectors(defaultTarget, defaultTarget.clone().add(new THREE.Vector3(0, -0.1, -0.3)), progress * 0.5);
            if (elapsed >= TRANSITION_MS) window.location.href = transition.href;
        } else {
            drawMenu(screenCtx, hoverIndex);
            screenTexture.needsUpdate = true;
        }
    }

    controls.update();
    renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

buildScene()
    .then(({ penguinWrap: wrap }) => {
        penguinWrap = wrap;
        loadingEl?.classList.add('hidden');

        if (sessionStorage.getItem('guino_scene_return')) {
            sessionStorage.removeItem('guino_scene_return');
            const fromPos = new THREE.Vector3(defaultCameraPos.x, 1.2, defaultCameraPos.z - 0.8);
            const fromTarget = defaultTarget.clone().add(new THREE.Vector3(0, -0.1, -0.3));
            camera.position.copy(fromPos);
            controls.target.copy(fromTarget);
            controls.update();
            returnEntrance = { start: performance.now(), fromPos, fromTarget };
        }
    })
    .catch((err) => {
        console.error('Scene load failed:', err);
        loadingEl?.classList.add('hidden');
        fallback.style.display = 'flex';
    });

animate();
