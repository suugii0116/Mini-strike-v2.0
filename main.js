import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { io } from 'socket.io-client';

const socketUrl = window.location.port === '5173' ? `http://${window.location.hostname}:3001` : '/';
const socket = io(socketUrl);
let isHost = false;
const remotePlayers = {}; 

socket.on('set_host', (status) => { isHost = status; });

// Setup
const scene = new THREE.Scene();
scene.background = new THREE.Color('#87CEEB'); 
scene.fog = new THREE.Fog('#87CEEB', 30, 200);

const camera = new THREE.PerspectiveCamera(80, window.innerWidth/window.innerHeight, 0.1, 800);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NoToneMapping;
document.body.appendChild(renderer.domElement);

// Constants
const COLOR_CYAN = new THREE.Color('#00e5ff');
const COLOR_MAGENTA = new THREE.Color('#ff0055');

let playerTeam = -1; // 0 = Cyan, 1 = Magenta
let health = 100;
const maxHealth = 100;
let isGameOver = false;
let isGameStarted = false;
let roundEnded = false;

let cyanKills = 0;
let magentaKills = 0;

// UI
const uiCrosshair = document.getElementById('crosshair');
const uiHealthBar = document.getElementById('health-bar');
const uiHealthText = document.getElementById('health-text');
const uiHealthContainer = document.getElementById('health-bar-container');
const uiScoreCyan = document.getElementById('score-cyan');
const uiScoreMagenta = document.getElementById('score-magenta');
const flashOverlay = document.getElementById('flash-overlay');
const instructionsPanel = document.getElementById('instructions');
const gameOverPanel = document.getElementById('game-over');
const teamSelectionPanel = document.getElementById('team-selection');

// Bomb UI & State
const uiBombStatus = document.getElementById('bomb-status');
const uiActionProgress = document.getElementById('action-progress');
const uiActionBar = document.getElementById('action-bar');
const uiActionText = document.getElementById('action-text');
const uiWeaponName = document.getElementById('weapon-name');

const WEAPONS = [
    { name: 'PISTOL', damage: 20, fireRate: 350, speed: 300, recoil: 0.03, color: '#aaaaaa' },
    { name: 'RIFLE', damage: 30, fireRate: 120, speed: 450, recoil: 0.05, color: '#ffffff' },
    { name: 'SNIPER', damage: 100, fireRate: 1500, speed: 800, recoil: 0.15, color: '#333333' }
];
let currentWeaponIndex = 1;

let bombPlanted = false;
let bombPos = null;
let bombMesh = null;
let isActionActive = false;
let actionProgress = 0; // 0 to 1
let isHoldingE = false;
let actionType = null; // 'plant' or 'defuse'

const bombSites = [
    { pos: new THREE.Vector3(40, 0, -40), radius: 12, name: 'A' },
    { pos: new THREE.Vector3(-40, 0, -40), radius: 12, name: 'B' }
];

socket.on('bot_shot', (data) => {
    if(isHost && bots[data.id]) {
        bots[data.id].health -= data.damage;
        if(bots[data.id].health <= 0) {
            addOrUpdateBotLocally({ id: data.id, dead: true, team: bots[data.id].team });
        }
    }
});

socket.on('score_update', (data) => {
    cyanKills = data.ct;
    magentaKills = data.t;
    updateUI();
});

socket.on('bomb_planted', (pos) => {
    bombPlanted = true;
    bombPos = pos;
    uiBombStatus.style.display = 'block';
    uiBombStatus.innerText = 'C4 PLANTED';
    
    if(!bombMesh) {
        bombMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({color: 'red', emissive: 'red', emissiveIntensity: 0.5}));
        bombMesh.castShadow = true;
        scene.add(bombMesh);
    }
    bombMesh.position.copy(pos);
});

socket.on('bomb_defused', () => {
    bombPlanted = false;
    uiBombStatus.style.display = 'block';
    uiBombStatus.innerText = 'C4 DEFUSED - CT WIN';
    uiBombStatus.style.color = '#00e5ff';
    if(bombMesh) { scene.remove(bombMesh); bombMesh = null; }
});

socket.on('bomb_exploded', () => {
    bombPlanted = false;
    uiBombStatus.style.display = 'block';
    uiBombStatus.innerText = 'C4 EXPLODED - T WIN';
    uiBombStatus.style.color = '#ff0055';
    if(bombMesh) {
        spawnExplosion(bombMesh.position, '#ff5500', 100);
        scene.remove(bombMesh); bombMesh = null;
    }
});

socket.on('new_round', () => {
    isGameOver = false;
    roundEnded = false;
    health = 100;
    bombPlanted = false;
    bombPos = null;
    if(bombMesh) { scene.remove(bombMesh); bombMesh = null; }
    uiBombStatus.style.display = 'none';
    uiBombStatus.style.color = 'yellow';
    
    // Clear all bots for new round
    for (let id in bots) {
        scene.remove(bots[id].group);
        delete bots[id];
    }
    if (isHost) lastSpawnTime = 0;
    
    // Reset position
    if (typeof getSpawnPoint === 'function') {
        camera.position.copy(getSpawnPoint(playerTeam));
    } else {
        camera.position.set(0, 2, 0);
    }
    velocity.set(0,0,0);
    updateUI();
    
    gameOverPanel.style.display = 'none';
    if (isGameStarted) controls.lock();
});

socket.on('current_players', (players) => {
    for (let id in players) {
        if (id !== socket.id) addRemotePlayer(players[id]);
    }
});

socket.on('player_joined', (p) => {
    if (p.id !== socket.id) addRemotePlayer(p);
});

socket.on('player_left', (id) => {
    if(remotePlayers[id]) {
        scene.remove(remotePlayers[id].group);
        delete remotePlayers[id];
    }
});

socket.on('player_moved', (data) => {
    if(remotePlayers[data.id]) {
        remotePlayers[data.id].group.position.copy(data.pos);
        remotePlayers[data.id].group.rotation.y = data.rot;
        
        // simple walking animation based on movement
        const dt = 0.1;
        remotePlayers[data.id].walkTime = (remotePlayers[data.id].walkTime || 0) + dt * 12;
        remotePlayers[data.id].leftArm.rotation.x = Math.sin(remotePlayers[data.id].walkTime) * 0.8;
        remotePlayers[data.id].rightArm.rotation.x = -Math.sin(remotePlayers[data.id].walkTime) * 0.8;
        remotePlayers[data.id].leftLeg.rotation.x = -Math.sin(remotePlayers[data.id].walkTime) * 0.8;
        remotePlayers[data.id].rightLeg.rotation.x = Math.sin(remotePlayers[data.id].walkTime) * 0.8;
    }
});

socket.on('player_shoot', (data) => {
    if(remotePlayers[data.id]) {
        const bMat = new THREE.MeshBasicMaterial({
            color: remotePlayers[data.id].team === 0 ? COLOR_CYAN : COLOR_MAGENTA,
            transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending
        });
        const lGeo = new THREE.BoxGeometry(0.05, 0.05, 12.0);
        lGeo.translate(0, 0, -6.0);
        const lMesh = new THREE.Mesh(lGeo, bMat);
        lMesh.position.copy(data.pos);
        
        const dir = new THREE.Vector3().copy(data.dir);
        lMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1), dir);
        scene.add(lMesh);
        enemyProjectiles.push({ mesh: lMesh, vel: dir.multiplyScalar(450), life: 1.5, team: remotePlayers[data.id].team });
        
        remotePlayers[data.id].rightArm.rotation.x = -Math.PI / 2 + 0.2; 
        setTimeout(() => { if(remotePlayers[data.id] && remotePlayers[data.id].rightArm) remotePlayers[data.id].rightArm.rotation.x = 0; }, 150);
    }
});

socket.on('update_health', (data) => {
    if(data.id === socket.id) {
        health = data.health;
        updateUI();
        if(health <= 0 && !isGameOver) {
            isGameOver = true;
            controls.unlock();
            gameOverPanel.style.display = 'block';
        }
    } else if(remotePlayers[data.id]) {
        remotePlayers[data.id].health = data.health;
        if(data.isDead) {
            const colStr = remotePlayers[data.id].team === 0 ? '#00e5ff' : '#ff0055';
            spawnExplosion(remotePlayers[data.id].group.position, colStr, 25);
            scene.remove(remotePlayers[data.id].group);
            delete remotePlayers[data.id];
            updateUI();
        }
    }
});

function addRemotePlayer(p) {
    if(remotePlayers[p.id]) return;
    const team = p.team;
    const colObj = team === 0 ? COLOR_CYAN : COLOR_MAGENTA;
    const group = new THREE.Group();
    
    const headMat = new THREE.MeshStandardMaterial({color: '#f0c0a0'});
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), headMat);
    head.position.y = 1.625;
    group.add(head);
    
    const shirtMat = new THREE.MeshStandardMaterial({color: colObj, roughness: 0.8});
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.75, 0.25), shirtMat);
    torso.position.y = 1.0;
    group.add(torso);
    
    const armGeo = new THREE.BoxGeometry(0.25, 0.75, 0.25);
    armGeo.translate(0, -0.375, 0); 
    const leftArm = new THREE.Mesh(armGeo, headMat);
    leftArm.position.set(-0.375, 1.375, 0);
    group.add(leftArm);
    
    const rightArm = new THREE.Mesh(armGeo, headMat);
    rightArm.position.set(0.375, 1.375, 0);
    group.add(rightArm);
    
    const legGeo = new THREE.BoxGeometry(0.25, 0.75, 0.25);
    legGeo.translate(0, -0.375, 0); 
    const legMat = new THREE.MeshStandardMaterial({color: '#4444aa', roughness: 0.9}); 
    const leftLeg = new THREE.Mesh(legGeo, legMat);
    leftLeg.position.set(-0.125, 0.75, 0);
    group.add(leftLeg);
    
    const rightLeg = new THREE.Mesh(legGeo, legMat);
    rightLeg.position.set(0.125, 0.75, 0);
    group.add(rightLeg);
    
    group.children.forEach(c => { c.castShadow = true; c.receiveShadow = true; });
    group.position.copy(p.pos);
    group.rotation.y = p.rot;
    scene.add(group);
    
    remotePlayers[p.id] = { id: p.id, group, team, leftArm, rightArm, leftLeg, rightLeg, health: p.health, walkTime: 0 };
}


// Dust 2 Aesthetics
const floorGeo = new THREE.PlaneGeometry(500, 500);
const floorMat = new THREE.MeshStandardMaterial({color: '#d4c3a3', roughness: 1.0}); 
const floor = new THREE.Mesh(floorGeo, floorMat);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

function createTextSprite(message, color) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.width = 256;
    canvas.height = 128;
    context.font = "Bold 60px Arial";
    context.fillStyle = color;
    context.textAlign = "center";
    context.fillText(message, 128, 90);
    const texture = new THREE.CanvasTexture(canvas);
    const spriteMaterial = new THREE.SpriteMaterial({ map: texture, depthTest: false });
    const sprite = new THREE.Sprite(spriteMaterial);
    sprite.scale.set(8, 4, 1);
    return sprite;
}

// Bomb Sites visuals
bombSites.forEach((site, index) => {
    const siteGeo = new THREE.CylinderGeometry(site.radius, site.radius, 0.1, 32);
    const siteMat = new THREE.MeshBasicMaterial({color: 0x00ff00, transparent: true, opacity: 0.2});
    const siteMesh = new THREE.Mesh(siteGeo, siteMat);
    siteMesh.position.copy(site.pos);
    siteMesh.position.y = 0.05;
    scene.add(siteMesh);
    
    // Add text/marker for A/B
    const markerBox = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 2), new THREE.MeshStandardMaterial({color: '#00aa00'}));
    markerBox.position.set(site.pos.x, 2, site.pos.z);
    markerBox.castShadow = true;
    scene.add(markerBox);

    const sprite = createTextSprite("SITE " + site.name, "#00ff00");
    sprite.position.set(site.pos.x, 7, site.pos.z);
    scene.add(sprite);
});

const collidables = [];
const wallGeo = new THREE.BoxGeometry(10, 8, 2);
const wallMat = new THREE.MeshStandardMaterial({color: '#bda889', roughness: 0.9}); // CS Dust colors
const crateGeo = new THREE.BoxGeometry(4, 4, 4);
const crateMat = new THREE.MeshStandardMaterial({color: '#8b7355', roughness: 0.9}); 

// Build structured grid arena
const mapGrid = [
    "WWWWWWWWWWWWWWW",
    "W.C.......C...W",
    "W.WWW.WWW.WWW.W",
    "W.............W",
    "W.WW..C...WW..W",
    "W.W...WWW...W.W",
    "W.....W.W.....W",
    "WWWW..C.C..WWWW",
    "W.....W.W.....W",
    "W.W...WWW...W.W",
    "W.WW...C..WW..W",
    "W.............W",
    "W.WWW.WWW.WWW.W",
    "W...C.......C.W",
    "WWWWWWWWWWWWWWW"
];

for(let z=0; z<mapGrid.length; z++) {
    for(let x=0; x<mapGrid[z].length; x++) {
        const type = mapGrid[z][x];
        if(type === 'W' || type === 'C') {
            const isW = type === 'W';
            const mesh = new THREE.Mesh(isW ? wallGeo : crateGeo, isW ? wallMat : crateMat);
            mesh.position.set((x - 7) * 10, isW ? 4 : 2, (z - 7) * 10);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            scene.add(mesh);
            
            mesh.updateMatrixWorld();
            mesh.userData.box = new THREE.Box3().setFromObject(mesh);
            collidables.push(mesh);
        }
    }
}

// Lighting
const ambient = new THREE.AmbientLight(0xffffff, 0.4);
scene.add(ambient);

const sunLight = new THREE.DirectionalLight(0xfff5e6, 1.5);
sunLight.position.set(100, 200, 50);
sunLight.castShadow = true;
sunLight.shadow.camera.left = -100;
sunLight.shadow.camera.right = 100;
sunLight.shadow.camera.top = 100;
sunLight.shadow.camera.bottom = -100;
sunLight.shadow.mapSize.width = 2048;
sunLight.shadow.mapSize.height = 2048;
scene.add(sunLight);

// Controls
const controls = new PointerLockControls(camera, document.body);
scene.add(controls.getObject());

// Spawn points based on team
function getSpawnPoint(team) {
    if (team === 0) return new THREE.Vector3(0, 2, -60); // CT spawn (closer to sites)
    if (team === 1) return new THREE.Vector3(0, 2, 60);  // T spawn
    return new THREE.Vector3(0, 2, 0); // Center is open
}
camera.position.copy(getSpawnPoint(-1));

// Pre-game setup
document.getElementById('btn-cyan').addEventListener('click', () => { startGame(0); });
document.getElementById('btn-magenta').addEventListener('click', () => { startGame(1); });

instructionsPanel.addEventListener('click', () => { if(isGameStarted && !isGameOver) controls.lock(); });
gameOverPanel.addEventListener('click', () => { /* wait for new round instead of reload */ });
controls.addEventListener('lock', () => { if(isGameStarted) instructionsPanel.style.display = 'none'; });
controls.addEventListener('unlock', () => { if (isGameStarted && !isGameOver) instructionsPanel.style.display = 'block'; });

function startGame(teamIndex) {
    playerTeam = teamIndex;
    isGameStarted = true;
    teamSelectionPanel.style.display = 'none';
    
    socket.emit('join_game', teamIndex);
    
    const colStr = playerTeam === 0 ? '#00e5ff' : '#ff0055';
    uiHealthContainer.style.borderColor = colStr;
    uiHealthContainer.style.boxShadow = `0 0 10px ${colStr}`;
    uiHealthBar.style.backgroundColor = colStr;
    uiCrosshair.style.borderColor = colStr;
    
    barrelMats.color = new THREE.Color(colStr);
    
    camera.position.copy(getSpawnPoint(playerTeam));
    velocity.set(0,0,0);
    
    controls.lock();
}

// Input State
let moveForward = false; let moveBackward = false;
let moveLeft = false; let moveRight = false;
let canJump = false;
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();

// Player Weapon Mesh
const gunGroup = new THREE.Group();
const bodyMats = new THREE.MeshStandardMaterial({color: '#222'});
let barrelMats = new THREE.MeshBasicMaterial({color: '#ffffff'}); // Overwritten on start
let gunBarrel; // Needed for shooting

function updateWeaponModel() {
    while(gunGroup.children.length > 0){ 
        gunGroup.remove(gunGroup.children[0]); 
    }
    
    const wName = WEAPONS[currentWeaponIndex].name;
    
    if (wName === 'PISTOL') {
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.2), bodyMats);
        const handle = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.15, 0.08), bodyMats);
        handle.position.set(0, -0.1, 0.05);
        gunBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.15), barrelMats);
        gunBarrel.rotation.x = Math.PI / 2;
        gunBarrel.position.set(0, 0.03, -0.1);
        
        gunGroup.add(body, handle, gunBarrel);
        gunGroup.position.set(0.3, -0.3, -0.5);
    } else if (wName === 'RIFLE') {
        const mainBody = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.15, 0.6), bodyMats);
        const stock = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.4), bodyMats);
        stock.position.set(0, -0.1, 0.4);
        gunBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.5), barrelMats);
        gunBarrel.rotation.x = Math.PI / 2;
        gunBarrel.position.set(0, 0.05, -0.5);
        const mag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.3, 0.15), bodyMats);
        mag.position.set(0, -0.2, -0.1);
        
        gunGroup.add(mainBody, stock, gunBarrel, mag);
        gunGroup.position.set(0.4, -0.4, -0.6); 
    } else if (wName === 'SNIPER') {
        const mainBody = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.15, 0.8), bodyMats);
        const stock = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.3), bodyMats);
        stock.position.set(0, -0.1, 0.5);
        gunBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.2), barrelMats);
        gunBarrel.rotation.x = Math.PI / 2;
        gunBarrel.position.set(0, 0.05, -0.8);
        const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.3), bodyMats);
        scope.rotation.x = Math.PI / 2;
        scope.position.set(0, 0.15, -0.1);
        
        gunGroup.add(mainBody, stock, gunBarrel, scope);
        gunGroup.position.set(0.4, -0.4, -0.6); 
    }
}
updateWeaponModel();

camera.add(gunGroup);

// Entities
const bots = {}; 
const bullets = [];
const enemyProjectiles = []; 
const particles = [];
let lastShootTime = 0;
let lastSpawnTime = performance.now();
const spawnRate = 2500; 
let botIdCounter = 0;

document.addEventListener('keydown', (e) => {
    if(!isGameStarted) return;
    if (e.code === 'KeyW') moveForward = true;
    if (e.code === 'KeyA') moveLeft = true;
    if (e.code === 'KeyS') moveBackward = true;
    if (e.code === 'KeyD') moveRight = true;
    if (e.code === 'KeyE' || e.key === 'e' || e.key === 'E' || e.key === 'у' || e.key === 'У') isHoldingE = true;
    
    if (e.code === 'Digit1') { currentWeaponIndex = 0; uiWeaponName.innerText = WEAPONS[0].name; updateWeaponModel(); }
    if (e.code === 'Digit2') { currentWeaponIndex = 1; uiWeaponName.innerText = WEAPONS[1].name; updateWeaponModel(); }
    if (e.code === 'Digit3') { currentWeaponIndex = 2; uiWeaponName.innerText = WEAPONS[2].name; updateWeaponModel(); }
    
    if (e.code === 'Space') { 
        if (canJump) { velocity.y += 15; canJump = false; }
    }
});

document.addEventListener('keyup', (e) => {
    if(!isGameStarted) return;
    if (e.code === 'KeyW') moveForward = false;
    if (e.code === 'KeyA') moveLeft = false;
    if (e.code === 'KeyS') moveBackward = false;
    if (e.code === 'KeyD') moveRight = false;
    if (e.code === 'KeyE' || e.key === 'e' || e.key === 'E' || e.key === 'у' || e.key === 'У') isHoldingE = false;
});

document.addEventListener('mousedown', (e) => {
    if(isGameOver || !isGameStarted) return;
    if (controls.isLocked && e.button === 0) {
        tryShoot();
    }
});

function flashScreen(colorStr) {
    flashOverlay.style.background = colorStr;
    flashOverlay.style.opacity = '0.5';
    setTimeout(() => { flashOverlay.style.opacity = '0'; }, 100);
}

function updateUI() {
    const hp = Math.max(0, Math.floor(health));
    uiHealthBar.style.width = (hp / maxHealth * 100) + '%';
    uiHealthText.innerText = hp + '%';
    uiScoreCyan.innerText = cyanKills;
    uiScoreMagenta.innerText = magentaKills;
}

function tryShoot() {
    const now = performance.now();
    const weapon = WEAPONS[currentWeaponIndex];
    if(now - lastShootTime < weapon.fireRate) return; 
    lastShootTime = now;
    
    const bulletSize = 0.05;
    const bulletMat = new THREE.MeshBasicMaterial({
        color: playerTeam === 0 ? COLOR_CYAN : COLOR_MAGENTA,
        transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending
    });
    const laserGeo = new THREE.BoxGeometry(bulletSize, bulletSize, 12.0);
    laserGeo.translate(0, 0, -6.0); 
    const laser = new THREE.Mesh(laserGeo, bulletMat);
    
    gunBarrel.updateMatrixWorld();
    const gunTip = new THREE.Vector3(0, 0, -0.4).applyMatrix4(gunBarrel.matrixWorld);
    laser.position.copy(gunTip);
    
    const dir = new THREE.Vector3(0,0,-1).applyQuaternion(camera.quaternion).normalize();
    laser.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1), dir);
    
    scene.add(laser);
    bullets.push({ mesh: laser, vel: dir.clone().multiplyScalar(weapon.speed), life: 1.5, team: playerTeam, damage: weapon.damage });
    
    socket.emit('shoot', { pos: gunTip, dir: { x: dir.x, y: dir.y, z: dir.z } });

    // Recoil
    gunGroup.position.z += weapon.recoil * 4;
    gunGroup.rotation.x += weapon.recoil;
    setTimeout(() => { 
        gunGroup.position.z -= weapon.recoil * 4; 
        gunGroup.rotation.x -= weapon.recoil;
    }, weapon.fireRate * 0.6);
}

function spawnExplosion(pos, colorStr, amount=15) {
    for(let i=0; i<amount; i++) {
        const pMat = new THREE.MeshBasicMaterial({color: colorStr});
        const pMesh = new THREE.Mesh(new THREE.BoxGeometry(0.3,0.3,0.3), pMat);
        pMesh.position.copy(pos);
        const vel = new THREE.Vector3((Math.random()-0.5)*30, (Math.random()*20), (Math.random()-0.5)*30);
        scene.add(pMesh);
        particles.push({mesh: pMesh, vel: vel, life: 0.6});
    }
}

// Minimal bot sync logic: only host updates bots
function addOrUpdateBotLocally(bData) {
    if(!bots[bData.id]) {
        const team = bData.team;
        const colObj = team === 0 ? COLOR_CYAN : COLOR_MAGENTA;
        const group = new THREE.Group();
        
        const headMat = new THREE.MeshStandardMaterial({color: '#f0c0a0'});
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), headMat);
        head.position.y = 1.625;
        group.add(head);
        
        const shirtMat = new THREE.MeshStandardMaterial({color: colObj, roughness: 0.8});
        const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.75, 0.25), shirtMat);
        torso.position.y = 1.0;
        group.add(torso);
        
        const armGeo = new THREE.BoxGeometry(0.25, 0.75, 0.25);
        armGeo.translate(0, -0.375, 0); 
        const leftArm = new THREE.Mesh(armGeo, headMat);
        leftArm.position.set(-0.375, 1.375, 0);
        group.add(leftArm);
        
        const rightArm = new THREE.Mesh(armGeo, headMat);
        rightArm.position.set(0.375, 1.375, 0);
        group.add(rightArm);
        
        const legGeo = new THREE.BoxGeometry(0.25, 0.75, 0.25);
        legGeo.translate(0, -0.375, 0); 
        const legMat = new THREE.MeshStandardMaterial({color: '#4444aa', roughness: 0.9}); 
        const leftLeg = new THREE.Mesh(legGeo, legMat);
        leftLeg.position.set(-0.125, 0.75, 0);
        group.add(leftLeg);
        
        const rightLeg = new THREE.Mesh(legGeo, legMat);
        rightLeg.position.set(0.125, 0.75, 0);
        group.add(rightLeg);
        
        group.children.forEach(c => { c.castShadow = true; c.receiveShadow = true; });
        scene.add(group);
        bots[bData.id] = { id: bData.id, group, team, leftArm, rightArm, leftLeg, rightLeg };
    }
    
    bots[bData.id].group.position.copy(bData.pos);
    bots[bData.id].group.rotation.y = bData.rot;
    
    if(bData.dead) {
        const colStr = bData.team === 0 ? '#00e5ff' : '#ff0055';
        spawnExplosion(bots[bData.id].group.position, colStr, 25);
        scene.remove(bots[bData.id].group);
        delete bots[bData.id];
    }
}

socket.on('bot_sync', (botsData) => {
    if(isHost) return;
    const receivedIds = new Set();
    for(let i=0; i<botsData.length; i++) {
        addOrUpdateBotLocally(botsData[i]);
        receivedIds.add(botsData[i].id);
    }
    for(let id in bots) {
        if(!receivedIds.has(id)) {
            scene.remove(bots[id].group);
            delete bots[id];
        }
    }
});

function spawnBotHost(team) {
    if(!isHost) return;
    const bId = 'bot_' + (botIdCounter++);
    const angle = Math.random() * Math.PI * 2;
    const dist = 30 + Math.random() * 80;
    
    addOrUpdateBotLocally({
        id: bId, team: team, 
        pos: new THREE.Vector3(Math.cos(angle)*dist, 0, Math.sin(angle)*dist),
        rot: 0, dead: false
    });
    
    bots[bId].health = 3.0;
    bots[bId].lastShoot = performance.now() + Math.random()*2000;
    bots[bId].walkTime = Math.random()*10;
}

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

let prevTime = performance.now();
let lastSyncTime = 0;

function animate() {
    requestAnimationFrame(animate);
    
    if(!isGameStarted) {
        renderer.render(scene, camera);
        return;
    }

    if(isGameOver) {
        renderer.render(scene, camera);
        return;
    }

    const time = performance.now();
    const delta = Math.min((time - prevTime) / 1000, 0.1);
    prevTime = time;

    if (controls.isLocked) {
        velocity.x -= velocity.x * 8.0 * delta;
        velocity.z -= velocity.z * 8.0 * delta;
        velocity.y -= 40.0 * delta; 

        direction.z = Number(moveForward) - Number(moveBackward);
        direction.x = Number(moveRight) - Number(moveLeft);
        direction.normalize();

        const speed = 120.0;
        if (moveForward || moveBackward) velocity.z -= direction.z * speed * delta;
        if (moveLeft || moveRight) velocity.x -= direction.x * speed * delta;

        const prevX = camera.position.x;
        const prevZ = camera.position.z;
        controls.moveRight(-velocity.x * delta);
        controls.moveForward(-velocity.z * delta);
        
        const diffX = camera.position.x - prevX;
        const diffZ = camera.position.z - prevZ;
        
        camera.position.x = prevX + diffX;
        camera.position.z = prevZ;
        let hitX = false;
        for(const obj of collidables) {
            const box = obj.userData.box;
            const px = camera.position.x; const pz = camera.position.z;
            if (px+0.4 > box.min.x && px-0.4 < box.max.x && pz+0.4 > box.min.z && pz-0.4 < box.max.z) hitX = true;
        }
        if(hitX) camera.position.x = prevX;

        camera.position.z = prevZ + diffZ;
        let hitZ = false;
        for(const obj of collidables) {
            const box = obj.userData.box;
            const px = camera.position.x; const pz = camera.position.z;
            if (px+0.4 > box.min.x && px-0.4 < box.max.x && pz+0.4 > box.min.z && pz-0.4 < box.max.z) hitZ = true;
        }
        if(hitZ) camera.position.z = prevZ;
        
        camera.position.y += (velocity.y * delta);
        if (camera.position.y < 2) {
            velocity.y = 0;
            camera.position.y = 2; 
            canJump = true;
        }
        
        if(camera.position.x > 80) camera.position.x = 80;
        if(camera.position.x < -80) camera.position.x = -80;
        if(camera.position.z > 80) camera.position.z = 80;
        if(camera.position.z < -80) camera.position.z = -80;
        
        const isMoving = (Math.abs(velocity.x) > 1 || Math.abs(velocity.z) > 1);
        if(isMoving && canJump) {
            gunGroup.position.y = -0.4 + Math.abs(Math.sin(time*0.012))*0.03;
        }
        
        if (time - lastSyncTime > 50) {
            const rotY = camera.rotation.y;
            // The PointerLockControls rotation is handled by pitch/yaw, we just take the y rotation from camera quaternion or controls
            const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
            socket.emit('update_transform', {
                pos: { x: camera.position.x, y: camera.position.y - 1.0, z: camera.position.z },
                rot: euler.y
            });
            lastSyncTime = time;
        }

        // Bomb interaction logic
        let canAction = false;
        let currentAction = null;
        
        if (playerTeam === 1 && !bombPlanted) { // T planting
            for(let site of bombSites) {
                const dist = new THREE.Vector2(camera.position.x - site.pos.x, camera.position.z - site.pos.z).length();
                if (dist < site.radius) {
                    canAction = true;
                    currentAction = 'plant';
                    break;
                }
            }
        } else if (playerTeam === 0 && bombPlanted && bombMesh) { // CT defusing
            const dist = camera.position.distanceTo(bombMesh.position);
            if (dist < 4.0) {
                canAction = true;
                currentAction = 'defuse';
            }
        }
        
        if (isHoldingE && canAction && !isGameOver) {
            if (!isActionActive) {
                isActionActive = true;
                actionProgress = 0;
            }
            uiActionProgress.style.display = 'block';
            uiActionText.innerText = currentAction === 'plant' ? 'PLANTING C4...' : 'DEFUSING C4...';
            
            const timeRequired = currentAction === 'plant' ? 3.0 : 5.0;
            actionProgress += delta / timeRequired;
            uiActionBar.style.width = (actionProgress * 100) + '%';
            
            if (actionProgress >= 1.0) {
                isActionActive = false;
                actionProgress = 0;
                uiActionProgress.style.display = 'none';
                
                if (currentAction === 'plant') {
                    socket.emit('plant_bomb', { x: camera.position.x, y: 0.5, z: camera.position.z });
                } else if (currentAction === 'defuse') {
                    socket.emit('defuse_bomb');
                }
            }
        } else {
            isActionActive = false;
            actionProgress = 0;
            uiActionProgress.style.display = 'none';
        }
    }

    if (isHost) {
        let tCount = 0; let ctCount = 0;
        let tAlive = 0; let ctAlive = 0;

        if (isGameStarted) {
            if (playerTeam === 0) { ctCount++; if (health > 0) ctAlive++; }
            else if (playerTeam === 1) { tCount++; if (health > 0) tAlive++; }
        }
        for (let id in remotePlayers) {
            if (remotePlayers[id].team === 0) { ctCount++; if (remotePlayers[id].health > 0) ctAlive++; }
            else if (remotePlayers[id].team === 1) { tCount++; if (remotePlayers[id].health > 0) tAlive++; }
        }
        for (let id in bots) {
            if (bots[id].team === 0) { ctCount++; if (bots[id].health > 0) ctAlive++; }
            else if (bots[id].team === 1) { tCount++; if (bots[id].health > 0) tAlive++; }
        }

        if (time - lastSpawnTime > 1000) { // check every second
            // spawn missing bots for 5v5
            if (ctCount < 5 && isGameStarted && !roundEnded) spawnBotHost(0);
            if (tCount < 5 && isGameStarted && !roundEnded) spawnBotHost(1);
            lastSpawnTime = time;
        }

        if (isGameStarted && !roundEnded) {
            if (ctAlive === 0 && tAlive > 0) {
                socket.emit('team_win', 1); // T wins
                roundEnded = true; 
            } else if (tAlive === 0 && ctAlive > 0 && !bombPlanted) {
                socket.emit('team_win', 0); // CT wins
                roundEnded = true;
            }
        }
    }

    // Process Player Bullets
    for(let i=bullets.length-1; i>=0; i--) {
        const b = bullets[i];
        b.life -= delta;
        if(b.life <= 0) {
            scene.remove(b.mesh);
            bullets.splice(i, 1);
            continue;
        }
        
        const step = b.vel.clone().multiplyScalar(delta);
        const dist = step.length();
        const bRay = new THREE.Raycaster(b.mesh.position, step.clone().normalize(), 0, dist);
        const wallHits = bRay.intersectObjects(collidables, false);
        
        if (wallHits.length > 0) {
            spawnExplosion(wallHits[0].point, '#ffffff', 3);
            scene.remove(b.mesh);
            bullets.splice(i, 1);
            continue;
        }
        
        b.mesh.position.add(step);
        
        let hitSomeone = false;
        
        // Hit real players?
        for(let id in remotePlayers) {
            const rp = remotePlayers[id];
            if(rp.team === b.team) continue;
            const rpCenter = new THREE.Vector3(rp.group.position.x, rp.group.position.y + 1.0, rp.group.position.z);
            if(b.mesh.position.distanceTo(rpCenter) < 1.2) {
                hitSomeone = true;
                spawnExplosion(b.mesh.position, '#ffffff', 5);
                socket.emit('player_hit', { id: rp.id, damage: b.damage });
                break;
            }
        }

        // Hit bots? (only host does damage to bots to prevent double damage, wait everyone can damage bots locally and it's fine if they don't sync perfectly, actually let's just let everyone destroy bots locally to be responsive, but host manages true health? No, simpler: just let anyone kill any bot locally. It might desync but it's fun and lag-free)
        // For pure multiplayer fun, let's keep it simple: we just hit bots locally. 
        if(!hitSomeone) {
            for(let id in bots) {
                const bot = bots[id];
                if(bot.team === b.team) continue; 
                
                const bCenter = new THREE.Vector3(bot.group.position.x, 1.0, bot.group.position.z);
                if(b.mesh.position.distanceTo(bCenter) < 1.0) {
                    hitSomeone = true;
                    spawnExplosion(b.mesh.position, '#ffffff', 5);
                    
                    if (isHost) {
                        bot.health -= b.damage / 10;
                        if(bot.health <= 0) {
                            if(bot.team === 0) magentaKills++; else cyanKills++;
                            addOrUpdateBotLocally({ id: id, dead: true, team: bot.team });
                        }
                    } else {
                        socket.emit('bot_shot', { id: id, damage: b.damage / 10 });
                    }
                    break;
                }
            }
        }

        if(hitSomeone) {
            scene.remove(b.mesh);
            bullets.splice(i,1);
        }
    }

    // Process Projectiles (Bots + Other Players)
    for(let i=enemyProjectiles.length-1; i>=0; i--) {
        const ep = enemyProjectiles[i];
        ep.life -= delta;
        
        const step = ep.vel.clone().multiplyScalar(delta);
        const epRay = new THREE.Raycaster(ep.mesh.position, step.clone().normalize(), 0, step.length());
        const wallHits = epRay.intersectObjects(collidables, false);
        
        let hitPlayer = false;
        if (ep.team !== playerTeam) {
            const pBox = new THREE.Box3(
                new THREE.Vector3(camera.position.x - 0.4, camera.position.y - 1.8, camera.position.z - 0.4),
                new THREE.Vector3(camera.position.x + 0.4, camera.position.y + 0.2, camera.position.z + 0.4)
            );
            if (epRay.ray.intersectBox(pBox, new THREE.Vector3())) hitPlayer = true;
        }
        
        if(ep.life <= 0 || wallHits.length > 0 || hitPlayer) {
            if (wallHits.length > 0) spawnExplosion(wallHits[0].point, '#ffcc00', 3);
            scene.remove(ep.mesh);
            enemyProjectiles.splice(i, 1);
            
            if (hitPlayer && ep.isPlayer !== true) { // if it was from another player, we let the OTHER player handle hitting us (or server). Actually, if a remote player's bullet hits us on our screen, we could take damage. But we rely on the attacker telling the server they hit us. So if ep is from bot, we take damage.
                health -= 15;
                flashScreen('#ff0000');
                updateUI();
                if(health <= 0) {
                    socket.emit('player_hit', { id: socket.id, damage: 15 }); // suicide/bot kill
                }
            }
            continue;
        }
        ep.mesh.position.add(step);
    }

    // Bot AI (Host only)
    if(isHost) {
        const syncData = [];
        for(let id in bots) {
            const b = bots[id];
            let targetPos = null;
            let nearestDist = Infinity;
            
            // Target all players
            if (b.team !== playerTeam && !isGameOver) {
                const dist = b.group.position.distanceTo(camera.position);
                if (dist < nearestDist) {
                    nearestDist = dist;
                    targetPos = new THREE.Vector3(camera.position.x, camera.position.y - 0.5, camera.position.z);
                }
            }
            for(let pId in remotePlayers) {
                const rp = remotePlayers[pId];
                if(rp.team !== b.team && rp.health > 0) {
                    const dist = b.group.position.distanceTo(rp.group.position);
                    if(dist < nearestDist) {
                        nearestDist = dist;
                        targetPos = new THREE.Vector3(rp.group.position.x, rp.group.position.y + 1.0, rp.group.position.z);
                    }
                }
            }
            
            // Target bots
            for(let oId in bots) {
                const other = bots[oId];
                if (other.team !== b.team) {
                    const dist = b.group.position.distanceTo(other.group.position);
                    if (dist < nearestDist) {
                        nearestDist = dist;
                        targetPos = new THREE.Vector3(other.group.position.x, 1.0, other.group.position.z);
                    }
                }
            }
            
            if(targetPos) {
                const center = new THREE.Vector3(b.group.position.x, 1.0, b.group.position.z);
                const dirVec = new THREE.Vector3(targetPos.x - center.x, 0, targetPos.z - center.z);
                dirVec.normalize();
                
                b.group.rotation.y = Math.atan2(dirVec.x, dirVec.z);
                
                let moving = false;
                if(nearestDist > 18) {
                    b.group.position.addScaledVector(dirVec, delta * 6.5); 
                    moving = true;
                } else if (nearestDist < 5) {
                    b.group.position.addScaledVector(dirVec, -delta * 4); 
                    moving = true;
                }
                
                if (moving) {
                    b.walkTime += delta * 12;
                    b.leftArm.rotation.x = Math.sin(b.walkTime) * 0.8;
                    b.rightArm.rotation.x = -Math.sin(b.walkTime) * 0.8;
                    b.leftLeg.rotation.x = -Math.sin(b.walkTime) * 0.8;
                    b.rightLeg.rotation.x = Math.sin(b.walkTime) * 0.8;
                    b.group.position.y = Math.abs(Math.sin(b.walkTime))*0.1;
                }
                
                if (time > b.lastShoot) {
                    b.lastShoot = time + 600 + Math.random()*800; 
                    
                    const pAim = new THREE.Vector3(b.group.position.x, 1.4, b.group.position.z);
                    const aimDir = new THREE.Vector3().subVectors(targetPos, pAim);
                    const trueDistToTarget = aimDir.length();
                    aimDir.normalize();
                    
                    const losRay = new THREE.Raycaster(pAim, aimDir, 0, trueDistToTarget);
                    const wallHits = losRay.intersectObjects(collidables, false);
                    
                    if (wallHits.length === 0) {
                        b.rightArm.rotation.x = -Math.PI / 2 + 0.2; 
                        setTimeout(() => { if(b.rightArm) b.rightArm.rotation.x = 0; }, 150);

                        const projGeo = new THREE.BoxGeometry(0.06, 0.06, 12.0);
                        projGeo.translate(0, 0, -6.0);
                        const pcStr = b.team === 0 ? '#00eeee' : '#ee0055'; 
                        const projMat = new THREE.MeshBasicMaterial({color: pcStr, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending});
                        const proj = new THREE.Mesh(projGeo, projMat);
                        proj.position.copy(pAim);
                        
                        aimDir.x += (Math.random() - 0.5) * 0.04;
                        aimDir.y += (Math.random() - 0.5) * 0.04;
                        aimDir.z += (Math.random() - 0.5) * 0.04;
                        aimDir.normalize();
                        
                        proj.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1), aimDir);
                        scene.add(proj);
                        
                        enemyProjectiles.push({ mesh: proj, vel: aimDir.multiplyScalar(400), life: 1.5, team: b.team });
                    }
                }
            }
            
            syncData.push({
                id: b.id,
                team: b.team,
                pos: { x: b.group.position.x, y: b.group.position.y, z: b.group.position.z },
                rot: b.group.rotation.y,
                dead: false
            });
        }
        
        if (time - lastSyncTime > 50) {
            socket.emit('bot_sync', syncData);
        }
    }

    for(let i=particles.length-1; i>=0; i--) {
        const p = particles[i];
        p.life -= delta;
        if(p.life <= 0) {
            scene.remove(p.mesh);
            particles.splice(i, 1);
            continue;
        }
        p.mesh.position.add(p.vel.clone().multiplyScalar(delta));
        p.mesh.scale.setScalar(p.life / 0.6); 
    }

    renderer.render(scene, camera);
}

animate();
