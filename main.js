// ============================================================
//  Duck Hunt – Hand-Gesture Edition
//  main.js  –  Game Logic, MediaPipe Hands, Canvas Rendering
// ============================================================

'use strict';

/* ── Constants ─────────────────────────────────────────────── */
const GAME_DURATION   = 60;      // seconds per round
const DUCK_SPAWN_BASE = 2200;    // ms between spawns (decreases over time)
const CANVAS_BG_ALPHA = 0.68;    // sky/overlay transparency (lets webcam show)
const GRASS_HEIGHT    = 0.14;    // fraction of canvas height
const MISSED_DUCK_WAIT = 4500;   // ms a duck stays on screen before flying away

// Duck type definitions  ── points | speed multiplier | colour hint
const DUCK_TYPES = {
  normal: { label: 'DUCK',   points: 10, speedMult: 1.0,  color: '#884400', wingColor: '#228B22', belly: '#F0C060' },
  fast:   { label: 'FAST!',  points: 20, speedMult: 1.85, color: '#C04000', wingColor: '#FF6030', belly: '#FFD080' },
  golden: { label: 'GOLDEN', points: 50, speedMult: 1.35, color: '#DAA520', wingColor: '#FFD700', belly: '#FFF8DC' },
};

const SCORE_COLORS = { normal: '#FFFFFF', fast: '#FC7460', golden: '#F8D800' };

/* ── State ─────────────────────────────────────────────────── */
let canvas, ctx;
let gameState     = 'start';   // 'start' | 'countdown' | 'playing' | 'gameover'
let score         = 0;
let ducks         = [];
let clouds        = [];
let particles     = [];
let scorePopups   = [];
let spawnTimer    = null;
let gameTimer     = null;
let timeLeft      = GAME_DURATION;
let totalHits     = 0;
let countdownVal  = 3;

// Hand-tracking / crosshair state
let fingerPos     = null;  // { x, y } in canvas space, or null
let handVisible   = false;

// Audio context (created on first user gesture to satisfy autoplay policy)
let audioCtx      = null;

/* ── DOM refs ──────────────────────────────────────────────── */
const $  = id => document.getElementById(id);
const webcamEl       = $('webcam');
const crosshairEl    = $('crosshair');
const hudEl          = $('hud');
const scoreDisplay   = $('score-display');
const timerDisplay   = $('timer-display');
const startScreen    = $('start-screen');
const countdownScreen= $('countdown-screen');
const countdownNum   = $('countdown-number');
const gameoverScreen = $('gameover-screen');
const finalScore     = $('final-score');
const finalHits      = $('final-hits');
const hitFlash       = $('hit-flash');
const trackingStatus = $('tracking-status');
const cameraPrompt   = $('camera-prompt');
const endBtn         = $('end-btn');

/* ──────────────────────────────────────────────────────────────
   AUDIO – Procedurally generated via Web Audio API
   (no external files needed)
────────────────────────────────────────────────────────────── */
function initAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

// Synthesise a short gunshot / hit sound
function playShot() {
  if (!audioCtx) return;
  const buf  = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.12, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    const t = i / audioCtx.sampleRate;
    // Noise burst that decays quickly
    data[i] = (Math.random() * 2 - 1) * Math.exp(-t * 35) * 0.9;
  }
  const src  = audioCtx.createBufferSource();
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(1, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.12);
  src.buffer = buf;
  src.connect(gain);
  gain.connect(audioCtx.destination);
  src.start();
}

// Comical falling squawk
function playHit(type) {
  if (!audioCtx) return;
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  const now  = audioCtx.currentTime;
  const freq = type === 'golden' ? 900 : type === 'fast' ? 600 : 440;

  osc.type = 'square';
  osc.frequency.setValueAtTime(freq, now);
  osc.frequency.exponentialRampToValueAtTime(80, now + 0.35);

  gain.gain.setValueAtTime(0.25, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.38);

  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + 0.4);
}

// Brief countdown beep
function playBeep(freq = 660) {
  if (!audioCtx) return;
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  const now  = audioCtx.currentTime;
  osc.type = 'square';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.2, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + 0.15);
}

/* ──────────────────────────────────────────────────────────────
   CANVAS DRAWING HELPERS
────────────────────────────────────────────────────────────── */

// Draw a pixelated sky gradient + clouds
function drawBackground() {
  const W = canvas.width, H = canvas.height;

  // Transparent overlay so webcam is visible – sky tint only
  ctx.fillStyle = 'rgba(60, 188, 252, ' + CANVAS_BG_ALPHA + ')';
  ctx.fillRect(0, 0, W, H * (1 - GRASS_HEIGHT));

  // Clouds
  clouds.forEach(c => drawCloud(c));

  // Grass band
  const grassTop = H * (1 - GRASS_HEIGHT);
  ctx.fillStyle = '#58D854';
  ctx.fillRect(0, grassTop, W, H);

  // Dark grass shadow row
  ctx.fillStyle = '#008800';
  ctx.fillRect(0, grassTop, W, 8);

  // Pixel-art style grass blades (decorative row)
  ctx.fillStyle = '#44BB44';
  for (let x = 0; x < W; x += 8) {
    ctx.fillRect(x, grassTop - 6, 4, 6);
  }
}

// Simple boxy cloud drawn with rectangles (NES style)
function drawCloud(c) {
  ctx.fillStyle = 'rgba(252,252,252,0.85)';
  const x = c.x, y = c.y, s = c.size;
  // Main body
  ctx.fillRect(x,       y + s*0.5, s * 2.2, s);
  ctx.fillRect(x + s*0.4, y,       s * 1.4, s * 1.5);
  ctx.fillRect(x + s,   y + s*0.25,s * 0.8, s * 1.25);
}

/* ──────────────────────────────────────────────────────────────
   DUCK DRAWING (pixel-art sprite via Canvas 2D)
────────────────────────────────────────────────────────────── */
function drawDuck(duck) {
  const { x, y, type, facing, wingUp, hit, fallY, alpha } = duck;
  const def = DUCK_TYPES[type];

  ctx.save();
  ctx.globalAlpha = alpha ?? 1;

  // Flip sprite based on direction
  const scaleX = facing === 'left' ? -1 : 1;
  ctx.translate(x, y + (fallY || 0));
  ctx.scale(scaleX, 1);

  const S = duck.size;  // base size unit

  if (hit) {
    // Dead duck – spin and fall, feathers scatter
    ctx.rotate(duck.deathAngle || 0);
    drawDuckBody(0, 0, S, def, true);
  } else {
    drawDuckBody(0, 0, S, def, false, wingUp);
  }

  ctx.restore();

  // Type label above duck (only while alive, not golden spam)
  if (!hit && type !== 'normal') {
    ctx.save();
    ctx.fillStyle = type === 'golden' ? '#F8D800' : '#FC7460';
    ctx.font = '7px "Press Start 2P"';
    ctx.textAlign = 'center';
    ctx.fillText(def.label, x, y - S * 1.5);
    ctx.restore();
  }
}

// Draw individual duck body parts
function drawDuckBody(cx, cy, S, def, dead = false, wingUp = false) {
  // Body
  ctx.fillStyle = def.color;
  ctx.fillRect(cx - S,     cy - S*0.4, S * 2,   S * 1.2);

  // Belly
  ctx.fillStyle = def.belly;
  ctx.fillRect(cx - S*0.5, cy,         S * 1.2,  S * 0.7);

  // Head
  ctx.fillStyle = def.color;
  ctx.fillRect(cx + S*0.6, cy - S*1.1, S * 1.1,  S * 1.0);

  // Beak
  ctx.fillStyle = '#F8A800';
  ctx.fillRect(cx + S*1.7, cy - S*0.75, S*0.7, S*0.35);

  // Eye
  ctx.fillStyle = dead ? '#888' : '#000';
  ctx.fillRect(cx + S*1.25, cy - S*0.9, S*0.3, S*0.3);

  // Wing (animated)
  ctx.fillStyle = def.wingColor;
  if (wingUp) {
    ctx.fillRect(cx - S*0.8, cy - S*1.1, S*1.6, S*0.5);
  } else {
    ctx.fillRect(cx - S*0.8, cy + S*0.3, S*1.6, S*0.5);
  }

  // Tail feathers
  ctx.fillStyle = def.wingColor;
  ctx.fillRect(cx - S*1.6, cy - S*0.5, S*0.8, S*0.8);

  if (dead) {
    // X eyes
    ctx.fillStyle = '#FF0000';
    ctx.fillRect(cx + S*1.1,  cy - S,     S*0.3, S*0.3);
    ctx.fillRect(cx + S*1.4,  cy - S*0.7, S*0.3, S*0.3);
  }
}

/* ──────────────────────────────────────────────────────────────
   PARTICLE SYSTEM  (feathers on hit)
────────────────────────────────────────────────────────────── */
function spawnParticles(x, y, color) {
  for (let i = 0; i < 10; i++) {
    particles.push({
      x, y,
      vx: (Math.random() - 0.5) * 6,
      vy: -(Math.random() * 5 + 1),
      life: 1,
      color,
      size: Math.random() * 5 + 3
    });
  }
}

function updateParticles(dt) {
  particles = particles.filter(p => p.life > 0);
  particles.forEach(p => {
    p.x  += p.vx * dt * 60;
    p.vy += 0.18 * dt * 60;  // gravity
    p.y  += p.vy * dt * 60;
    p.life -= 0.025 * dt * 60;
  });
}

function drawParticles() {
  particles.forEach(p => {
    ctx.globalAlpha = p.life;
    ctx.fillStyle   = p.color;
    // Feather-like rectangle
    ctx.fillRect(p.x, p.y, p.size, p.size * 0.4);
    ctx.globalAlpha = 1;
  });
}

/* ──────────────────────────────────────────────────────────────
   SCORE POPUPS
────────────────────────────────────────────────────────────── */
function spawnScorePopup(x, y, points, type) {
  const el = document.createElement('div');
  el.className = 'score-popup';
  el.textContent = '+' + points;
  el.style.left  = x + 'px';
  el.style.top   = y + 'px';
  el.style.color = SCORE_COLORS[type] || '#FFF';
  document.getElementById('game-container').appendChild(el);
  scorePopups.push(el);
  setTimeout(() => {
    el.remove();
    scorePopups = scorePopups.filter(p => p !== el);
  }, 900);
}

/* ──────────────────────────────────────────────────────────────
   DUCK SPAWNING
────────────────────────────────────────────────────────────── */
function randomDuckType() {
  const r = Math.random();
  if (r < 0.55)  return 'normal';
  if (r < 0.82)  return 'fast';
  return 'golden';
}

function spawnDuck() {
  if (gameState !== 'playing') return;

  const W = canvas.width, H = canvas.height;
  const type = randomDuckType();
  const def  = DUCK_TYPES[type];

  // Spawn on the left or right edge of the sky area
  const fromLeft = Math.random() < 0.5;
  const startX   = fromLeft ? -40 : W + 40;
  const startY   = 80 + Math.random() * (H * (1 - GRASS_HEIGHT) - 160);

  const baseSpeed = (W * 0.0018) + Math.random() * (W * 0.001);
  const speed     = baseSpeed * def.speedMult;
  const angle     = (Math.random() - 0.5) * 0.6;  // slight vertical drift

  ducks.push({
    id:        Math.random(),
    type,
    x:         startX,
    y:         startY,
    vx:        fromLeft ? speed : -speed,
    vy:        Math.sin(angle) * speed * 0.5,
    size:      18 + Math.random() * 8,
    facing:    fromLeft ? 'right' : 'left',
    wingUp:    false,
    wingTimer: 0,
    hit:       false,
    fallY:     0,
    fallVY:    0,
    deathAngle:0,
    deathSpin: (Math.random() - 0.5) * 0.15,
    alpha:     1,
    age:       0,
    missedFly: false,   // true when time's up and duck escapes
  });
}

function scheduleDuckSpawn() {
  const delay = Math.max(800, DUCK_SPAWN_BASE - (GAME_DURATION - timeLeft) * 28);
  spawnTimer = setTimeout(() => {
    spawnDuck();
    if (gameState === 'playing') scheduleDuckSpawn();
  }, delay);
}

/* ──────────────────────────────────────────────────────────────
   COLLISION DETECTION
────────────────────────────────────────────────────────────── */
function checkCollisions() {
  if (!fingerPos || !handVisible) return;

  const fx = fingerPos.x, fy = fingerPos.y;

  ducks.forEach(duck => {
    if (duck.hit || duck.missedFly) return;

    const S = duck.size;
    const dx = fx - duck.x;
    const dy = fy - duck.y;
    const hitRadius = S * 2.2;

    if (Math.abs(dx) < hitRadius && Math.abs(dy) < hitRadius) {
      hitDuck(duck);
    }
  });
}

function hitDuck(duck) {
  duck.hit      = true;
  duck.fallVY   = -1;           // initial upward pop then gravity
  duck.deathAngle = 0;

  const def = DUCK_TYPES[duck.type];
  score += def.points;
  totalHits++;

  updateHUD();

  // FX
  playShot();
  setTimeout(() => playHit(duck.type), 60);
  spawnParticles(duck.x, duck.y, def.wingColor);
  spawnScorePopup(duck.x, duck.y - duck.size * 2, def.points, duck.type);

  // Screen flash
  hitFlash.style.opacity = '1';
  setTimeout(() => { hitFlash.style.opacity = '0'; }, 80);
}

/* ──────────────────────────────────────────────────────────────
   GAME LOOP
────────────────────────────────────────────────────────────── */
let lastTime = 0;

function gameLoop(timestamp) {
  const dt = Math.min((timestamp - lastTime) / 1000, 0.05); // cap dt
  lastTime  = timestamp;

  if (gameState !== 'playing') return;

  const W = canvas.width, H = canvas.height;
  const grassTop = H * (1 - GRASS_HEIGHT);

  // Clear
  ctx.clearRect(0, 0, W, H);

  // Background
  drawBackground();

  // Update + draw ducks
  ducks = ducks.filter(duck => {
    duck.age += dt;

    if (duck.hit) {
      // Death animation: bounce once then fall
      duck.fallVY += 0.38 * dt * 60;      // gravity
      duck.fallY  += duck.fallVY * dt * 60;
      duck.deathAngle += duck.deathSpin * dt * 60;
      duck.alpha  -= 0.008 * dt * 60;

      if (duck.fallY > grassTop - duck.y + 20) {
        // Land on grass briefly then fade
        duck.fallVY = 0;
        duck.alpha -= 0.025 * dt * 60;
      }
      if (duck.alpha <= 0) return false;  // remove from array

    } else if (duck.missedFly) {
      // Escape animation: fly off-screen quickly
      duck.vy  -= 0.04 * dt * 60;  // fly upward
      duck.x   += duck.vx * dt * 60 * 1.5;
      duck.y   += duck.vy * dt * 60;
      duck.alpha -= 0.01 * dt * 60;
      if (duck.alpha <= 0 || duck.x < -100 || duck.x > W + 100) return false;

    } else {
      // Normal flight
      duck.x += duck.vx * dt * 60;
      duck.y += duck.vy * dt * 60;

      // Bounce off top/bottom of sky
      if (duck.y < 70 || duck.y > grassTop - 40) duck.vy *= -1;

      // Wing flap
      duck.wingTimer += dt;
      if (duck.wingTimer > 0.18) {
        duck.wingUp    = !duck.wingUp;
        duck.wingTimer = 0;
      }

      // Mark as missed after timeout if still alive
      if (duck.age > MISSED_DUCK_WAIT / 1000 && !duck.hit) {
        duck.missedFly = true;
      }

      // Out of bounds (left/right) before timeout
      if (duck.x < -100 || duck.x > W + 100) return false;
    }

    drawDuck(duck);
    return true;
  });

  // Particles
  updateParticles(dt);
  drawParticles();

  // Crosshair collision check each frame
  checkCollisions();

  // Move clouds slowly
  clouds.forEach(c => {
    c.x += c.speed * dt * 60;
    if (c.x > W + 100) c.x = -200;
  });

  requestAnimationFrame(gameLoop);
}

/* ──────────────────────────────────────────────────────────────
   HUD UPDATE
────────────────────────────────────────────────────────────── */
function updateHUD() {
  scoreDisplay.textContent = 'SCORE: ' + String(score).padStart(6, '0');
  timerDisplay.textContent = 'TIME: ' + String(Math.max(0, timeLeft)).padStart(2, '0');
}

/* ──────────────────────────────────────────────────────────────
   GAME STATE MACHINE
────────────────────────────────────────────────────────────── */
function showStart() {
  gameState = 'start';
  startScreen.style.display    = 'flex';
  countdownScreen.style.display = 'none';
  gameoverScreen.style.display  = 'none';
  hudEl.style.display           = 'none';
  crosshairEl.style.display     = 'none';
  trackingStatus.style.display  = 'none';
}

function startCountdown() {
  initAudio();
  gameState = 'countdown';
  startScreen.style.display    = 'none';
  countdownScreen.style.display = 'flex';
  countdownVal = 3;
  countdownNum.textContent = countdownVal;
  playBeep(660);

  const interval = setInterval(() => {
    countdownVal--;
    if (countdownVal <= 0) {
      clearInterval(interval);
      countdownScreen.style.display = 'none';
      startGame();
    } else {
      countdownNum.textContent = countdownVal;
      playBeep(countdownVal === 1 ? 880 : 660);
    }
  }, 1000);
}

function startGame() {
  gameState   = 'playing';
  score       = 0;
  totalHits   = 0;
  timeLeft    = GAME_DURATION;
  ducks       = [];
  particles   = [];
  scorePopups.forEach(p => p.remove());
  scorePopups = [];

  hudEl.style.display          = 'flex';
  crosshairEl.style.display    = 'block';
  trackingStatus.style.display = 'block';
  gameoverScreen.style.display  = 'none';

  updateHUD();
  initClouds();
  scheduleDuckSpawn();

  lastTime = performance.now();
  requestAnimationFrame(gameLoop);

  // Countdown timer (every second)
  gameTimer = setInterval(() => {
    timeLeft--;
    updateHUD();
    if (timeLeft <= 0) endGame();
  }, 1000);
}

function endGame() {
  gameState = 'gameover';
  clearTimeout(spawnTimer);
  clearInterval(gameTimer);

  hudEl.style.display          = 'none';
  crosshairEl.style.display    = 'none';
  trackingStatus.style.display = 'none';
  gameoverScreen.style.display = 'flex';

  finalScore.textContent  = String(score).padStart(6, '0');
  finalHits.textContent   = totalHits + ' DUCK' + (totalHits !== 1 ? 'S' : '') + ' HIT';
}

/* ──────────────────────────────────────────────────────────────
   CLOUD INITIALISATION
────────────────────────────────────────────────────────────── */
function initClouds() {
  clouds = [];
  const W = canvas.width, H = canvas.height;
  for (let i = 0; i < 5; i++) {
    clouds.push({
      x:     Math.random() * W,
      y:     40 + Math.random() * (H * 0.3),
      size:  30 + Math.random() * 40,
      speed: 0.3 + Math.random() * 0.4,
    });
  }
}

/* ──────────────────────────────────────────────────────────────
   MEDIAPIPE HANDS SETUP
────────────────────────────────────────────────────────────── */
async function initHandTracking() {
  // Request webcam access
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    });
    webcamEl.srcObject = stream;
    await webcamEl.play();
  } catch (err) {
    console.warn('Camera access denied or unavailable:', err);
    cameraPrompt.textContent =
      '⚠ Camera not available. Allow camera access and reload the page.\n' +
      'You can still play – the crosshair will be mouse-controlled.';
    cameraPrompt.style.display = 'block';
    enableMouseFallback();
    return;
  }

  // Load MediaPipe Hands via CDN
  // The library exposes window.Hands after the script loads
  const hands = new window.Hands({
    locateFile: file =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/${file}`
  });

  hands.setOptions({
    maxNumHands:      1,
    modelComplexity:  0,   // 0 = lite, faster
    minDetectionConfidence: 0.72,
    minTrackingConfidence:  0.60,
  });

  hands.onResults(onHandResults);

  // Camera helper – sends frames to MediaPipe
  const camera = new window.Camera(webcamEl, {
    onFrame: async () => { await hands.send({ image: webcamEl }); },
    width: 640,
    height: 480,
  });
  camera.start();
}

/* Called every frame by MediaPipe with hand landmark data */
function onHandResults(results) {
  if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
    handVisible = true;
    trackingStatus.textContent = '● HAND DETECTED';
    trackingStatus.className = 'active';

    // Landmark 8 = index finger tip
    const lm = results.multiHandLandmarks[0][8];

    // MediaPipe gives normalised (0-1) coords
    // Webcam is mirrored, so flip X back
    const rawX = (1 - lm.x) * canvas.width;
    const rawY = lm.y * canvas.height;

    fingerPos = { x: rawX, y: rawY };

    // Move DOM crosshair overlay
    crosshairEl.style.left = rawX + 'px';
    crosshairEl.style.top  = rawY + 'px';

  } else {
    handVisible = false;
    fingerPos   = null;
    trackingStatus.textContent = '○ NO HAND';
    trackingStatus.className = 'inactive';
  }
}

/* ── Mouse fallback when no camera ─────────────────────────── */
function enableMouseFallback() {
  document.addEventListener('mousemove', e => {
    if (gameState !== 'playing') return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    fingerPos = {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top)  * scaleY,
    };
    handVisible = true;
    crosshairEl.style.left = e.clientX + 'px';
    crosshairEl.style.top  = e.clientY + 'px';
  });
  // Click to fire in mouse mode (game normally fires continuously by proximity)
  document.addEventListener('click', e => {
    if (gameState === 'playing') {
      playShot();
    }
  });
}

/* ──────────────────────────────────────────────────────────────
   CANVAS RESIZE HANDLER
────────────────────────────────────────────────────────────── */
function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}

/* ──────────────────────────────────────────────────────────────
   INIT
────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  canvas = $('game-canvas');
  ctx    = canvas.getContext('2d');

  resizeCanvas();
  window.addEventListener('resize', () => {
    resizeCanvas();
    if (gameState === 'start') {
      // Redraw idle background on start screen
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  });

  // Render a static idle background on the start screen
  initClouds();
  drawBackground();

  // Button events
  $('play-btn').addEventListener('click', startCountdown);
  $('restart-btn').addEventListener('click', startCountdown);
  $('end-btn').addEventListener('click', () => {
    if (gameState === 'playing') endGame();
  });

  // Start hand tracking immediately so camera is ready
  initHandTracking();

  // Show start screen
  showStart();

  // Idle cloud drift on start screen
  (function idleLoop(ts) {
    if (gameState === 'start') {
      const dt = 0.016;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawBackground();
      clouds.forEach(c => { c.x += c.speed * dt * 60; if (c.x > canvas.width + 100) c.x = -200; });
      requestAnimationFrame(idleLoop);
    }
  })(0);
});
