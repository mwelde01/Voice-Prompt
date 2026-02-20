'use strict';

/* ================================================================
   VoicePrompt Desktop — Renderer
   ================================================================ */

// ── State ─────────────────────────────────────────────────────────
const state = {
  mode: 'voice',           // 'voice' | 'autoscroll'
  isPlaying: false,
  scriptWords: [],         // flat array of word strings
  wordElements: [],        // matching array of <span> DOM elements
  currentWordIndex: 0,
  fontSize: 36,            // px
  speed: 4,                // 1–10
  language: 'en-US',

  // Voice recognition
  recognition: null,
  recognitionRunning: false,
  lastInterimTranscript: '',

  // Auto-scroll
  autoScrollTimer: null,
};

// ── DOM references ────────────────────────────────────────────────
const editorView      = document.getElementById('editor-view');
const teleView        = document.getElementById('teleprompter-view');
const scriptInput     = document.getElementById('script-input');
const charCount       = document.getElementById('char-count');
const startBtn        = document.getElementById('start-btn');
const fontSizeSlider  = document.getElementById('font-size-slider');
const fontSizeDisplay = document.getElementById('font-size-display');
const speedSlider     = document.getElementById('speed-slider');
const speedDisplay    = document.getElementById('speed-display');
const languageSelect  = document.getElementById('language-select');
const speedControlWrap = document.getElementById('speed-control-wrap');

const wordsContainer   = document.getElementById('words-container');
const teleContent      = document.getElementById('tele-content');
const progressBar      = document.getElementById('progress-bar');
const progressLabel    = document.getElementById('progress-label');
const statusDot        = document.getElementById('status-dot');
const statusText       = document.getElementById('status-text');
const playPauseBtn     = document.getElementById('play-pause-btn');
const backBtn          = document.getElementById('back-btn');
const modeBadge        = document.getElementById('mode-badge');
const teleSpeedSlider  = document.getElementById('tele-speed-slider');
const teleSpeedDisplay = document.getElementById('tele-speed-display');
const teleFontSlider   = document.getElementById('tele-font-slider');

const modeBtns = document.querySelectorAll('.mode-btn');


/* ================================================================
   Utility — fuzzy word matching
   ================================================================ */

function normalizeWord(word) {
  return word.toLowerCase().replace(/[^a-z0-9']/g, '');
}

function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const dp = [];
  for (let i = 0; i <= b.length; i++) dp[i] = [i];
  for (let j = 0; j <= a.length; j++) dp[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b[i - 1] === a[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j - 1], dp[i][j - 1], dp[i - 1][j]);
      }
    }
  }
  return dp[b.length][a.length];
}

/**
 * Returns a similarity score 0–1 between a recognized word and a script word.
 */
function wordSimilarity(recognized, scriptWord) {
  const a = normalizeWord(recognized);
  const b = normalizeWord(scriptWord);
  if (!a || !b) return 0;
  if (a === b) return 1.0;

  // Prefix / suffix match (handles plurals, contractions, partial recognition)
  if (a.startsWith(b) || b.startsWith(a)) return 0.88;
  if (a.length > 4 && b.length > 4 && (a.includes(b) || b.includes(a))) return 0.75;

  // Edit-distance similarity for reasonable length words
  if (Math.abs(a.length - b.length) <= 3) {
    const dist = levenshtein(a, b);
    const maxLen = Math.max(a.length, b.length);
    const sim = 1 - dist / maxLen;
    if (sim >= 0.6) return sim;
  }

  return 0;
}

/**
 * Given a transcript string, advance state.currentWordIndex to the
 * last word that was matched.  Returns the new index (or the same).
 */
function processTranscript(transcript) {
  if (!transcript.trim()) return;

  const recognized = transcript.trim().split(/\s+/).filter(Boolean);
  let searchFrom = state.currentWordIndex;
  let lastMatch  = state.currentWordIndex - 1;

  for (const rWord of recognized) {
    const windowEnd = Math.min(searchFrom + 25, state.scriptWords.length);
    let bestScore = 0.42;   // minimum threshold
    let bestIdx   = -1;

    for (let i = searchFrom; i < windowEnd; i++) {
      const score = wordSimilarity(rWord, state.scriptWords[i]);
      if (score > bestScore) {
        bestScore = score;
        bestIdx   = i;
      }
    }

    if (bestIdx !== -1) {
      lastMatch  = bestIdx;
      searchFrom = bestIdx + 1;
    }
  }

  if (lastMatch >= state.currentWordIndex) {
    setCurrentWordIndex(lastMatch + 1);
  }
}


/* ================================================================
   Script parsing & rendering
   ================================================================ */

/**
 * Tokenise the raw script text into an array of { type, value } objects.
 * type: 'word' | 'break'
 */
function tokenise(text) {
  const tokens = [];
  const lines = text.split('\n');

  lines.forEach((line, lineIdx) => {
    if (lineIdx > 0) {
      tokens.push({ type: 'break' });
    }
    const words = line.trim().split(/\s+/).filter(Boolean);
    words.forEach(w => tokens.push({ type: 'word', value: w }));
  });

  return tokens;
}

function renderScript(text) {
  wordsContainer.innerHTML = '';
  state.scriptWords  = [];
  state.wordElements = [];

  const tokens = tokenise(text);

  tokens.forEach(token => {
    if (token.type === 'break') {
      const br = document.createElement('span');
      br.className = 'script-break';
      wordsContainer.appendChild(br);
      return;
    }

    const wordIdx = state.scriptWords.length;
    state.scriptWords.push(token.value);

    const span = document.createElement('span');
    span.className    = 'word upcoming';
    span.textContent  = token.value;
    span.dataset.index = wordIdx;

    span.addEventListener('click', () => {
      setCurrentWordIndex(wordIdx);
      if (!state.isPlaying) play();
    });

    wordsContainer.appendChild(span);
    wordsContainer.appendChild(document.createTextNode(' '));
    state.wordElements.push(span);
  });
}


/* ================================================================
   Word highlighting & scroll
   ================================================================ */

function setCurrentWordIndex(rawIndex) {
  const index = Math.max(0, Math.min(rawIndex, state.scriptWords.length - 1));
  state.currentWordIndex = index;

  state.wordElements.forEach((el, i) => {
    if (i < index)       el.className = 'word past';
    else if (i === index) el.className = 'word current';
    else                  el.className = 'word upcoming';
  });

  // Scroll the current word to roughly 1/3 from the top of the viewport
  const currentEl = state.wordElements[index];
  if (currentEl) {
    currentEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  updateProgress();

  if (index >= state.scriptWords.length - 1) {
    onScriptComplete();
  }
}

function updateProgress() {
  const total = state.scriptWords.length;
  const pct   = total > 1 ? Math.round((state.currentWordIndex / (total - 1)) * 100) : 0;
  progressBar.style.width   = `${pct}%`;
  progressLabel.textContent = `${pct}%`;
}


/* ================================================================
   Voice recognition
   ================================================================ */

function buildRecognition() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) return null;

  const r = new SpeechRecognition();
  r.continuous       = true;
  r.interimResults   = true;
  r.maxAlternatives  = 1;
  r.lang             = state.language;

  r.onstart = () => {
    state.recognitionRunning = true;
    setStatus('listening', 'Listening…');
  };

  r.onresult = (event) => {
    if (!state.isPlaying) return;

    let finalText   = '';
    let interimText = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (res.isFinal) {
        finalText += res[0].transcript + ' ';
      } else {
        interimText += res[0].transcript;
      }
    }

    // Use whichever is available — final has higher confidence
    const transcript = finalText || interimText;
    if (transcript.trim() && transcript !== state.lastInterimTranscript) {
      state.lastInterimTranscript = interimText;
      processTranscript(transcript);
    }
  };

  r.onerror = (e) => {
    state.recognitionRunning = false;
    // 'no-speech' and 'audio-capture' are harmless; restart automatically
    if (state.isPlaying && state.mode === 'voice') {
      setTimeout(() => startRecognition(), 800);
    }
  };

  r.onend = () => {
    state.recognitionRunning = false;
    // Chrome's API times out every ~60 s — restart seamlessly
    if (state.isPlaying && state.mode === 'voice') {
      setTimeout(() => startRecognition(), 300);
    }
  };

  return r;
}

function startRecognition() {
  if (!state.recognition || state.recognitionRunning) return;
  try {
    state.recognition.lang = state.language;
    state.recognition.start();
  } catch (_) {
    // Ignore "already started" errors
  }
}

function stopRecognition() {
  state.recognitionRunning = false;
  if (!state.recognition) return;
  try { state.recognition.stop(); } catch (_) {}
}


/* ================================================================
   Auto-scroll
   ================================================================ */

/** Returns ms/word for the current speed setting. */
function scrollIntervalMs() {
  // speed 1 → ~1000 ms/word (60 wpm)
  // speed 5 → ~380 ms/word (~158 wpm)
  // speed 10 → ~175 ms/word (343 wpm)
  const wpm = 60 + (state.speed - 1) * 31.5;
  return Math.round(60000 / wpm);
}

function startAutoScroll() {
  stopAutoScroll();
  state.autoScrollTimer = setInterval(() => {
    if (!state.isPlaying) return;
    if (state.currentWordIndex < state.scriptWords.length - 1) {
      setCurrentWordIndex(state.currentWordIndex + 1);
    } else {
      stopAutoScroll();
    }
  }, scrollIntervalMs());
}

function stopAutoScroll() {
  if (state.autoScrollTimer) {
    clearInterval(state.autoScrollTimer);
    state.autoScrollTimer = null;
  }
}


/* ================================================================
   Playback control
   ================================================================ */

function play() {
  if (state.scriptWords.length === 0) return;
  state.isPlaying = true;
  playPauseBtn.innerHTML = '⏸ Pause';

  if (state.mode === 'voice') {
    startRecognition();
  } else {
    startAutoScroll();
    setStatus('scrolling', 'Auto-scrolling…');
  }
}

function pause() {
  state.isPlaying = false;
  playPauseBtn.innerHTML = '▶ Play';

  stopRecognition();
  stopAutoScroll();
  setStatus('idle', 'Paused');
}

function togglePlayPause() {
  if (state.isPlaying) pause();
  else                  play();
}

function onScriptComplete() {
  pause();
  setStatus('complete', 'Script complete');
}


/* ================================================================
   Status display
   ================================================================ */

function setStatus(type, text) {
  statusText.textContent = text;
  statusDot.className    = 'status-dot';
  if (type !== 'idle') statusDot.classList.add(type);
}


/* ================================================================
   View navigation
   ================================================================ */

function showTeleprompter() {
  const script = scriptInput.value.trim();
  if (!script) {
    scriptInput.focus();
    return;
  }

  // Parse & render
  renderScript(script);
  state.currentWordIndex = 0;

  // Sync sliders
  teleFontSlider.value   = fontSizeSlider.value;
  teleSpeedSlider.value  = speedSlider.value;
  teleSpeedDisplay.textContent = state.speed;
  wordsContainer.style.fontSize = `${state.fontSize}px`;

  // Mode badge
  modeBadge.textContent  = state.mode === 'voice' ? '🎤 Voice' : '⏩ Auto-Scroll';
  modeBadge.className    = `mode-badge ${state.mode}`;

  // Hide speed controls in voice mode (speed has no effect)
  teleSpeedSlider.closest('.tele-control-group').style.display =
    state.mode === 'autoscroll' ? 'flex' : 'none';

  // Switch view
  editorView.style.display = 'none';
  teleView.classList.add('active');

  // Initialise speech recognition
  if (state.mode === 'voice') {
    const r = buildRecognition();
    if (!r) {
      alert(
        'Speech recognition is not supported in this window.\n\n' +
        'Try switching to Auto-Scroll mode, or make sure the app\n' +
        'has microphone permission.'
      );
      showEditor();
      return;
    }
    state.recognition = r;
  }

  // Jump to word 0 and begin
  setCurrentWordIndex(0);
  setStatus('idle', 'Ready');
  play();
}

function showEditor() {
  pause();
  stopRecognition();
  stopAutoScroll();
  state.recognition = null;
  state.recognitionRunning = false;

  teleView.classList.remove('active');
  editorView.style.display = 'flex';
}


/* ================================================================
   Event listeners — Editor
   ================================================================ */

// Mode buttons
modeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    modeBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.mode = btn.dataset.mode;
    // Show/hide speed slider (only relevant for auto-scroll)
    speedControlWrap.style.display =
      state.mode === 'autoscroll' ? 'flex' : 'none';
  });
});

// Font size
fontSizeSlider.addEventListener('input', () => {
  state.fontSize = parseInt(fontSizeSlider.value, 10);
  fontSizeDisplay.textContent = `${state.fontSize}px`;
});

// Speed
speedSlider.addEventListener('input', () => {
  state.speed = parseInt(speedSlider.value, 10);
  speedDisplay.textContent = state.speed;
});

// Language
languageSelect.addEventListener('change', () => {
  state.language = languageSelect.value;
});

// Word count live update
scriptInput.addEventListener('input', () => {
  const words = scriptInput.value.trim().split(/\s+/).filter(Boolean).length;
  charCount.textContent = `${words} word${words !== 1 ? 's' : ''}`;
  startBtn.disabled = words === 0;
});

// Start button
startBtn.addEventListener('click', showTeleprompter);


/* ================================================================
   Event listeners — Teleprompter
   ================================================================ */

// Back button
backBtn.addEventListener('click', showEditor);

// Play / Pause
playPauseBtn.addEventListener('click', togglePlayPause);

// Live speed (auto-scroll)
teleSpeedSlider.addEventListener('input', () => {
  state.speed = parseInt(teleSpeedSlider.value, 10);
  teleSpeedDisplay.textContent = state.speed;
  speedSlider.value = state.speed;
  speedDisplay.textContent = state.speed;
  if (state.isPlaying && state.mode === 'autoscroll') {
    startAutoScroll();   // restart with new interval
  }
});

// Live font size
teleFontSlider.addEventListener('input', () => {
  state.fontSize = parseInt(teleFontSlider.value, 10);
  fontSizeSlider.value = state.fontSize;
  fontSizeDisplay.textContent = `${state.fontSize}px`;
  if (wordsContainer) {
    wordsContainer.style.fontSize = `${state.fontSize}px`;
  }
});


/* ================================================================
   Keyboard shortcuts
   ================================================================ */

document.addEventListener('keydown', (e) => {
  const inTele = teleView.classList.contains('active');
  if (!inTele) return;

  switch (e.code) {
    case 'Space':
      e.preventDefault();
      togglePlayPause();
      break;

    case 'Escape':
      showEditor();
      break;

    case 'ArrowRight':
    case 'ArrowDown':
      e.preventDefault();
      setCurrentWordIndex(state.currentWordIndex + 1);
      break;

    case 'ArrowLeft':
    case 'ArrowUp':
      e.preventDefault();
      setCurrentWordIndex(state.currentWordIndex - 1);
      break;

    case 'Home':
      e.preventDefault();
      setCurrentWordIndex(0);
      break;

    case 'End':
      e.preventDefault();
      setCurrentWordIndex(state.scriptWords.length - 1);
      break;
  }
});


/* ================================================================
   Initialise UI state
   ================================================================ */

// Speed control hidden initially in voice mode (default)
speedControlWrap.style.display = 'none';
startBtn.disabled = true;
charCount.textContent = '0 words';
