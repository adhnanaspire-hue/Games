// ============================================================
//  Duck Hunt – Hand-Gesture Edition
//  main.js  –  Game Logic, MediaPipe Hands, Canvas Rendering
//
//  Core mechanic:
//    The player raises their index finger toward the webcam.
//    MediaPipe Hands tracks the fingertip and places the
//    Reticle at that position on screen.
//    When the Reticle overlaps a duck, the duck is shot and
//    falls down with a death animation.
// ============================================================

'use strict';

/* ── Constants ─────────────────────────────────────────────── */
const GAME_DURATION    = 60;     // seconds per round
const DUCK_SPAWN_BASE  = 2200;   // base ms between spawns (shrinks over time)
const CANVAS_BG_ALPHA  = 0.68;   // sky overlay alpha (lets webcam show through)
const GRASS_HEIGHT     = 0.14;   // fraction of canvas height used for grass
const MISSED_DUCK_WAIT = 4500;   // ms before an unhit duck escapes off-screen

// Duck type table – points | speed multiplier | render colours
const DUCK_TYPES = {
  normal: {
    label: 'DUCK',   points: 10, speedMult: 1.0,
    color: '#884400', wingColor: '#228B22', belly: '#F0C060'
  },
  fast: {
    label: 'FAST!',  points: 20, speedMult: 1.85,
    color: '#C04000', wingColor: '#FF6030', belly: '#FFD080'
  },
  golden: {
    label: 'GOLDEN', points: 50, speedMult: 1.35,
    color: '#DAA520', wingColor: '#FFD700', belly: '#FFF8DC'
  },
};

// Colours used for the floating score popup per duck type
const SCORE_COLORS = { normal: '#FFFFFF', fast: '#FC7460', golden: '#F8D800' };

/* ── Game state ─────────────────────────────────────────────── */
let canvas, ctx;
let gameState    = 'start';  // 'start' | 'countdown' | 'playing' | 'gameover'
let score        = 0;
let totalHits    = 0;
let timeLeft     = GAME_DURATION;
let countdownVal = 3;

let ducks        = [];   // active duck objects
let clouds       = [];   // background cloud objects
let particles    = [];   // feather particle objects
let scorePopups  = [];   // DOM elements for floating score text

let spawnTimer   = null; // setTimeout handle for next duck spawn
let gameTimer    = null; // setInterval handle for the game clock

// Reticle / hand-tracking state
// fingerPos is the canvas-space {x, y} of the player's index-finger tip.
// When fingerPos overlaps a duck's bounding box the duck is shot.
let fingerPos    = null;
let handVisible  = false;

// Web Audio context – created on first user gesture (browser autoplay policy)
let audioCtx     = null;

/* ── DOM references ─────────────────────────────────────────── */
const $  = id => document.getElementById(id);

const webcamEl        = $('webcam');
const reticleEl       = $('reticle');       // the Reticle overlay
const hudEl           = $('hud');
const scoreDisplay    = $('score-display');
const timerDisplay    = $('timer-display');
const startScreen     = $('start-screen');
const countdownScreen = $('countdown-screen');
const countdownNum    = $('countdown-number');
const gameoverScreen  = $('gameover-screen');
const finalScoreEl    = $('final-score');
const finalHitsEl     = $('final-hits');
const hitFlash        = $('hit-flash');
const trackingStatus  = $('tracking-status');
const cameraPrompt    = $('camera-prompt');
const endBtn          = $('end-btn');       // End Game button in the HUD

/* ══════════════════════════════════════════════════════════════
   AUDIO  – fully synthesised via Web Audio API
   No external audio files required.
══════════════════════════════════════════════════════════════ */

// Initialise AudioContext on the first user interaction
function initAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

// Short percussive gunshot (noise burst with fast decay)
function playShot() {
  if (!audioCtx) return;
  const buf  = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.12, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    const t = i / audioCtx.sampleRate;
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

// Comical descending squawk on duck hit
function playHit(type) {
  if (!audioCtx) return;
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  const now  = audioCtx.currentTime;
  // Each duck type has a different starting pitch
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

// Short blip for countdown ticks
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

/* ══════════════════════════════════════════════════════════════
   CANVAS DRAWING HELPERS
══════════════════════════════════════════════════════════════ */

// Sky tint + clouds + grass strip
function drawBackground() {
  const W = canvas.width, H = canvas.height;

  // Semi-transparent sky so the webcam feed shows through
  ctx.fillStyle = `rgba(60, 188, 252, ${CANVAS_BG_ALPHA})`;
  ctx.fillRect(0, 0, W, H * (1 - GRASS_HEIGHT));

  clouds.forEach(c => drawCloud(c));

  // Grass
  const grassTop = H * (1 - GRASS_HEIGHT);
  ctx.fillStyle = '#58D854';
  ctx.fillRect(0, grassTop, W, H);

  // Shadow row at top of grass
  ctx.fillStyle = '#008800';
  ctx.fillRect(0, grassTop, W, 8);

  // Decorative pixel grass blades
  ctx.fillStyle = '#44BB44';
  for (let x = 0; x < W; x += 8) {
    ctx.fillRect(x, grassTop - 6, 4, 6);
  }
}

// NES-style blocky cloud (built from rectangles)
function drawCloud(c) {
  ctx.fillStyle = 'rgba(252,252,252,0.85)';
  const { x, y, size: s } = c;
  ctx.fillRect(x,           y + s * 0.5,  s * 2.2, s);
  ctx.fillRect(x + s * 0.4, y,            s * 1.4, s * 1.5);
  ctx.fillRect(x + s,       y + s * 0.25, s * 0.8, s * 1.25);
}

/* ══════════════════════════════════════════════════════════════
   DUCK SPRITE  (pixel-art via Canvas 2D rectangles)
══════════════════════════════════════════════════════════════ */

// Top-level duck draw dispatcher
function drawDuck(duck) {
  const { x, y, type, facing, wingUp, hit, fallY, alpha } = duck;
  const def = DUCK_TYPES[type];

  ctx.save();
  ctx.globalAlpha = alpha ?? 1;

  // Mirror the sprite when flying left
  ctx.translate(x, y + (fallY || 0));
  ctx.scale(facing === 'left' ? -1 : 1, 1);

  const S = duck.size; // sizing unit for the duck

  if (hit) {
    // Spin during death fall
    ctx.rotate(duck.deathAngle || 0);
    drawDuckBody(0, 0, S, def, true);
  } else {
    drawDuckBody(0, 0, S, def, false, wingUp);
  }

  ctx.restore();

  // Type label above duck (not shown for normal ducks)
  if (!hit && type !== 'normal') {
    ctx.save();
    ctx.fillStyle  = type === 'golden' ? '#F8D800' : '#FC7460';
    ctx.font       = '7px "Press Start 2P"';
    ctx.textAlign  = 'center';
    ctx.fillText(def.label, x, y - duck.size * 1.5);
    ctx.restore();
  }
}

// Draw individual body parts using filled rectangles
function drawDuckBody(cx, cy, S, def, dead = false, wingUp = false) {
  // Main body
  ctx.fillStyle = def.color;
  ctx.fillRect(cx - S,      cy - S * 0.4,  S * 2,   S * 1.2);

  // Belly highlight
  ctx.fillStyle = def.belly;
  ctx.fillRect(cx - S * 0.5, cy,           S * 1.2,  S * 0.7);

  // Head
  ctx.fillStyle = def.color;
  ctx.fillRect(cx + S * 0.6, cy - S * 1.1, S * 1.1,  S * 1.0);

  // Beak
  ctx.fillStyle = '#F8A800';
  ctx.fillRect(cx + S * 1.7, cy - S * 0.75, S * 0.7, S * 0.35);

  // Eye – grey when dead
  ctx.fillStyle = dead ? '#888' : '#000';
  ctx.fillRect(cx + S * 1.25, cy - S * 0.9, S * 0.3, S * 0.3);

  // Wing – flaps up/down during flight
  ctx.fillStyle = def.wingColor;
  if (wingUp) {
    ctx.fillRect(cx - S * 0.8, cy - S * 1.1, S * 1.6, S * 0.5);
  } else {
    ctx.fillRect(cx - S * 0.8, cy + S * 0.3, S * 1.6, S * 0.5);
  }

  // Tail feathers
  ctx.fillStyle = def.wingColor;
  ctx.fillRect(cx - S * 1.6, cy - S * 0.5, S * 0.8, S * 0.8);

  // X-eyes when dead
  if (dead) {
    ctx.fillStyle = '#FF0000';
    ctx.fillRect(cx + S * 1.1,  cy - S,       S * 0.3, S * 0.3);
    ctx.fillRect(cx + S * 1.4,  cy - S * 0.7, S * 0.3, S * 0.3);
  }
}

/* ══════════════════════════════════════════════════════════════
   PARTICLE SYSTEM  – feather burst on duck hit
══════════════════════════════════════════════════════════════ */
function spawnParticles(x, y, color) {
  for (let i = 0; i < 10; i++) {
    particles.push({
      x, y,
      vx:    (Math.random() - 0.5) * 6,
      vy:    -(Math.random() * 5 + 1),
      life:  1,
      color,
      size:  Math.random() * 5 + 3,
    });
  }
}

function updateParticles(dt) {
  particles = particles.filter(p => p.life > 0);
  particles.forEach(p => {
    p.x    += p.vx * dt * 60;
    p.vy   += 0.18 * dt * 60;   // gravity
    p.y    += p.vy * dt * 60;
    p.life -= 0.025 * dt * 60;
  });
}

function drawParticles() {
  particles.forEach(p => {
    ctx.globalAlpha = p.life;
    ctx.fillStyle   = p.color;
    ctx.fillRect(p.x, p.y, p.size, p.size * 0.4); // flat feather shape
    ctx.globalAlpha = 1;
  });
}

/* ══════════════════════════════════════════════════════════════
   SCORE POPUPS  – float-up DOM elements on duck kill
══════════════════════════════════════════════════════════════ */
function spawnScorePopup(x, y, points, type) {
  const el = document.createElement('div');
  el.className   = 'score-popup';
  el.textContent = '+' + points;
  el.style.left  = x + 'px';
  el.style.top   = y + 'px';
  el.style.color = SCORE_COLORS[type] || '#FFF';
  document.getElementById('game-container').appendChild(el);
  scorePopups.push(el);
  // Remove after animation completes
  setTimeout(() => {
    el.remove();
    scorePopups = scorePopups.filter(p => p !== el);
  }, 900);
}

/* ══════════════════════════════════════════════════════════════
   DUCK SPAWNING
══════════════════════════════════════════════════════════════ */

// Pick a random duck type weighted toward normal ducks
function randomDuckType() {
  const r = Math.random();
  if (r < 0.55) return 'normal';
  if (r < 0.82) return 'fast';
  return 'golden';
}

// Spawn a single duck entering from either side of the screen
function spawnDuck() {
  if (gameState !== 'playing') return;

  const W = canvas.width, H = canvas.height;
  const type = randomDuckType();
  const def  = DUCK_TYPES[type];

  const fromLeft = Math.random() < 0.5;
  const startX   = fromLeft ? -40 : W + 40;
  const startY   = 80 + Math.random() * (H * (1 - GRASS_HEIGHT) - 160);

  const baseSpeed = (W * 0.0018) + Math.random() * (W * 0.001);
  const speed     = baseSpeed * def.speedMult;
  const angle     = (Math.random() - 0.5) * 0.6; // slight upward/downward drift

  ducks.push({
    id:         Math.random(),
    type,
    x:          startX,
    y:          startY,
    vx:         fromLeft ? speed : -speed,
    vy:         Math.sin(angle) * speed * 0.5,
    size:       18 + Math.random() * 8,
    facing:     fromLeft ? 'right' : 'left',
    wingUp:     false,
    wingTimer:  0,
    hit:        false,   // true once shot
    fallY:      0,       // vertical offset during death fall
    fallVY:     0,       // vertical velocity during death fall
    deathAngle: 0,       // rotation during death spin
    deathSpin:  (Math.random() - 0.5) * 0.15,
    alpha:      1,
    age:        0,
    missedFly:  false,   // true when duck escapes without being shot
  });
}

// Schedule the next duck spawn; spawn interval decreases as time runs out
function scheduleDuckSpawn() {
  const elapsed = GAME_DURATION - timeLeft;
  const delay   = Math.max(800, DUCK_SPAWN_BASE - elapsed * 28);
  spawnTimer    = setTimeout(() => {
    spawnDuck();
    if (gameState === 'playing') scheduleDuckSpawn();
  }, delay);
}

/* ══════════════════════════════════════════════════════════════
   COLLISION DETECTION
   Every frame we check whether the Reticle (fingerPos)
   overlaps any live duck's bounding box.
   If so, the duck is shot and its death animation begins.
══════════════════════════════════════════════════════════════ */
function checkCollisions() {
  if (!fingerPos || !handVisible) return;

  const fx = fingerPos.x, fy = fingerPos.y;

  ducks.forEach(duck => {
    if (duck.hit || duck.missedFly) return; // already dealt with

    const hitRadius = duck.size * 2.2;
    const dx = fx - duck.x;
    const dy = fy - duck.y;

    // Simple AABB (axis-aligned bounding box) check
    if (Math.abs(dx) < hitRadius && Math.abs(dy) < hitRadius) {
      shootDuck(duck);
    }
  });
}

// Called when the Reticle touches a duck
function shootDuck(duck) {
  duck.hit    = true;
  duck.fallVY = -1;       // brief upward pop before gravity pulls it down

  const def = DUCK_TYPES[duck.type];
  score     += def.points;
  totalHits++;

  updateHUD();

  // Audio feedback
  playShot();
  setTimeout(() => playHit(duck.type), 60);

  // Visual feedback
  spawnParticles(duck.x, duck.y, def.wingColor);
  spawnScorePopup(duck.x, duck.y - duck.size * 2, def.points, duck.type);

  // Brief white screen flash
  hitFlash.style.opacity = '1';
  setTimeout(() => { hitFlash.style.opacity = '0'; }, 80);
}

/* ══════════════════════════════════════════════════════════════
   MAIN GAME LOOP
══════════════════════════════════════════════════════════════ */
let lastTime = 0;

function gameLoop(timestamp) {
  const dt = Math.min((timestamp - lastTime) / 1000, 0.05); // cap at 50 ms
  lastTime  = timestamp;

  if (gameState !== 'playing') return;

  const W        = canvas.width, H = canvas.height;
  const grassTop = H * (1 - GRASS_HEIGHT);

  ctx.clearRect(0, 0, W, H);
  drawBackground();

  // Update and draw every duck
  ducks = ducks.filter(duck => {
    duck.age += dt;

    if (duck.hit) {
      // ── Death animation: spin + fall + fade ──────────────
      duck.fallVY     += 0.38 * dt * 60;       // gravity
      duck.fallY      += duck.fallVY * dt * 60;
      duck.deathAngle += duck.deathSpin * dt * 60;
      duck.alpha      -= 0.008 * dt * 60;

      // Slow fade once it hits the grass
      if (duck.fallY > grassTop - duck.y + 20) {
        duck.fallVY  = 0;
        duck.alpha  -= 0.025 * dt * 60;
      }
      if (duck.alpha <= 0) return false; // remove from array

    } else if (duck.missedFly) {
      // ── Escape animation: fly off-screen quickly ─────────
      duck.vy    -= 0.04 * dt * 60;
      duck.x     += duck.vx * dt * 60 * 1.5;
      duck.y     += duck.vy * dt * 60;
      duck.alpha -= 0.01 * dt * 60;
      if (duck.alpha <= 0 || duck.x < -100 || duck.x > W + 100) return false;

    } else {
      // ── Normal flight ────────────────────────────────────
      duck.x += duck.vx * dt * 60;
      duck.y += duck.vy * dt * 60;

      // Bounce off sky ceiling and grass line
      if (duck.y < 70 || duck.y > grassTop - 40) duck.vy *= -1;

      // Animate wings
      duck.wingTimer += dt;
      if (duck.wingTimer > 0.18) {
        duck.wingUp    = !duck.wingUp;
        duck.wingTimer = 0;
      }

      // If duck hasn't been shot within the time limit, let it escape
      if (duck.age > MISSED_DUCK_WAIT / 1000) {
        duck.missedFly = true;
      }

      // Fell off screen horizontally before timeout
      if (duck.x < -100 || duck.x > W + 100) return false;
    }

    drawDuck(duck);
    return true;
  });

  // Feather particles
  updateParticles(dt);
  drawParticles();

  // Reticle collision check – runs every frame
  checkCollisions();

  // Drift clouds
  clouds.forEach(c => {
    c.x += c.speed * dt * 60;
    if (c.x > W + 100) c.x = -200;
  });

  requestAnimationFrame(gameLoop);
}

/* ══════════════════════════════════════════════════════════════
   HUD UPDATE
══════════════════════════════════════════════════════════════ */
function updateHUD() {
  scoreDisplay.textContent = 'SCORE: ' + String(score).padStart(6, '0');
  timerDisplay.textContent = 'TIME: '  + String(Math.max(0, timeLeft)).padStart(2, '0');
}

/* ══════════════════════════════════════════════════════════════
   GAME STATE MACHINE
══════════════════════════════════════════════════════════════ */

function showStart() {
  gameState                     = 'start';
  startScreen.style.display     = 'flex';
  countdownScreen.style.display = 'none';
  gameoverScreen.style.display  = 'none';
  hudEl.style.display           = 'none';
  reticleEl.style.display       = 'none';
  trackingStatus.style.display  = 'none';
}

function startCountdown() {
  initAudio();
  gameState                     = 'countdown';
  startScreen.style.display     = 'none';
  countdownScreen.style.display = 'flex';
  countdownVal                  = 3;
  countdownNum.textContent      = countdownVal;
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
  gameState    = 'playing';
  score        = 0;
  totalHits    = 0;
  timeLeft     = GAME_DURATION;
  ducks        = [];
  particles    = [];
  scorePopups.forEach(p => p.remove());
  scorePopups  = [];

  hudEl.style.display           = 'flex';
  reticleEl.style.display       = 'block';  // show the Reticle
  trackingStatus.style.display  = 'block';
  gameoverScreen.style.display  = 'none';

  updateHUD();
  initClouds();
  scheduleDuckSpawn();

  lastTime = performance.now();
  requestAnimationFrame(gameLoop);

  // Game countdown clock
  gameTimer = setInterval(() => {
    timeLeft--;
    updateHUD();
    if (timeLeft <= 0) endGame();
  }, 1000);
}

// endGame is called either by the timer expiring OR by the END button
function endGame() {
  gameState = 'gameover';
  clearTimeout(spawnTimer);
  clearInterval(gameTimer);

  hudEl.style.display           = 'none';
  reticleEl.style.display       = 'none';  // hide the Reticle
  trackingStatus.style.display  = 'none';
  gameoverScreen.style.display  = 'flex';

  finalScoreEl.textContent = String(score).padStart(6, '0');
  finalHitsEl.textContent  = totalHits + ' DUCK' + (totalHits !== 1 ? 'S' : '') + ' HIT';
}

/* ══════════════════════════════════════════════════════════════
   CLOUD SETUP
══════════════════════════════════════════════════════════════ */
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

/* ══════════════════════════════════════════════════════════════
   MEDIAPIPE HANDS – hand tracking setup
   Tracks the player's index-finger tip and places the
   Reticle at that canvas coordinate each frame.
   When the Reticle touches a duck, the duck is shot.
══════════════════════════════════════════════════════════════ */
async function initHandTracking() {
  // Request webcam
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    webcamEl.srcObject = stream;
    await webcamEl.play();
  } catch (err) {
    console.warn('Camera access denied or unavailable:', err);
    cameraPrompt.textContent =
      '⚠ Camera not available. Allow camera access and reload.\n' +
      'Fallback: move your mouse to control the Reticle.';
    cameraPrompt.style.display = 'block';
    enableMouseFallback();
    return;
  }

  // Initialise MediaPipe Hands (lite model for speed)
  const hands = new window.Hands({
    locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/${file}`,
  });

  hands.setOptions({
    maxNumHands:             1,
    modelComplexity:         0,    // 0 = lite model, faster on low-end devices
    minDetectionConfidence:  0.72,
    minTrackingConfidence:   0.60,
  });

  hands.onResults(onHandResults);

  // Camera helper feeds frames from the webcam into MediaPipe each tick
  const camera = new window.Camera(webcamEl, {
    onFrame: async () => { await hands.send({ image: webcamEl }); },
    width: 640,
    height: 480,
  });
  camera.start();
}

// Called by MediaPipe every processed frame with landmark data
function onHandResults(results) {
  if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
    handVisible = true;
    trackingStatus.textContent = '● HAND DETECTED';
    trackingStatus.className   = 'active';

    // Landmark index 8 = index finger tip
    const lm = results.multiHandLandmarks[0][8];

    // MediaPipe gives normalised coords (0–1).
    // Flip X because the webcam is mirrored in CSS.
    const rx = (1 - lm.x) * canvas.width;
    const ry = lm.y * canvas.height;

    fingerPos = { x: rx, y: ry };

    // Move the DOM Reticle element to follow the fingertip
    reticleEl.style.left = rx + 'px';
    reticleEl.style.top  = ry + 'px';

  } else {
    handVisible = false;
    fingerPos   = null;
    trackingStatus.textContent = '○ NO HAND';
    trackingStatus.className   = 'inactive';
  }
}

/* ── Mouse/touch fallback (activates if camera is unavailable) ── */
function enableMouseFallback() {
  document.addEventListener('mousemove', e => {
    if (gameState !== 'playing') return;
    const rect   = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    fingerPos = {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top)  * scaleY,
    };
    handVisible = true;
    reticleEl.style.left = e.clientX + 'px';
    reticleEl.style.top  = e.clientY + 'px';
  });

  // In mouse mode a click also triggers the shot sound
  document.addEventListener('click', () => {
    if (gameState === 'playing') playShot();
  });
}

/* ══════════════════════════════════════════════════════════════
   CANVAS RESIZE
══════════════════════════════════════════════════════════════ */
function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}

/* ══════════════════════════════════════════════════════════════
   ENTRY POINT
══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  canvas = $('game-canvas');
  ctx    = canvas.getContext('2d');

  resizeCanvas();
  window.addEventListener('resize', () => {
    resizeCanvas();
    if (gameState === 'start') ctx.clearRect(0, 0, canvas.width, canvas.height);
  });

  // Draw idle background before the player starts
  initClouds();
  drawBackground();

  // ── Button wiring ──────────────────────────────────────
  // Play button on start screen
  $('play-btn').addEventListener('click', startCountdown);

  // Restart button on game-over screen
  $('restart-btn').addEventListener('click', startCountdown);

  // END button in HUD – lets the player quit the current round early.
  // Calls the same endGame() used when the timer reaches zero,
  // showing the Game Over screen with the score earned so far.
  endBtn.addEventListener('click', () => {
    if (gameState === 'playing') endGame();
  });

  // Begin hand tracking immediately so the camera warms up
  initHandTracking();

  // Show start screen
  showStart();

  // Idle cloud drift animation while on the start screen
  (function idleLoop() {
    if (gameState === 'start') {
      const dt = 0.016;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawBackground();
      clouds.forEach(c => {
        c.x += c.speed * dt * 60;
        if (c.x > canvas.width + 100) c.x = -200;
      });
      requestAnimationFrame(idleLoop);
    }
  })();
});
