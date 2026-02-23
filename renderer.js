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
  interimWordsProcessed: 0,  // words already matched in the current interim phrase

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

  // Prefix match — guard against short-word false positives.
  // "in" must NOT score 0.88 against "information", "into", etc.
  // Both words must be >= 4 chars so tiny function words don't hijack.
  if (a.length >= 4 && b.length >= 4) {
    if (a.startsWith(b) || b.startsWith(a)) return 0.88;
    if (a.length > 5 && b.length > 5 && (a.includes(b) || b.includes(a))) return 0.75;
  }

  // Edit-distance — raised minimum similarity from 0.6 → 0.72 to
  // reduce false positives from Windows SR mishears.
  if (Math.abs(a.length - b.length) <= 3) {
    const dist = levenshtein(a, b);
    const maxLen = Math.max(a.length, b.length);
    const sim = 1 - dist / maxLen;
    if (sim >= 0.72) return sim;
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

  // Hard cap per call: with incremental processing each call has 1-3 new
  // words, so capping at currentWordIndex+6 is plenty and prevents runaway jumps.
  const absoluteMax = Math.min(state.currentWordIndex + 6, state.scriptWords.length);

  for (const rWord of recognized) {
    // Window of 4: can skip at most 3 words to handle one misrecognised word.
    const windowEnd = Math.min(searchFrom + 4, absoluteMax);
    if (windowEnd <= searchFrom) break;

    let bestScore = 0.55;
    let bestIdx   = -1;

    for (let i = searchFrom; i < windowEnd; i++) {
      let score = wordSimilarity(rWord, state.scriptWords[i]);
      if (score > 0) {
        // Prefer the closest match: penalise positions further from searchFrom.
        // This stops a strong-but-distant match beating a weaker nearby one.
        score -= 0.04 * (i - searchFrom);
      }
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

  // Scroll the current word to roughly 1/3 from the top of the viewport.
  // Use teleContent.scrollTo() directly instead of scrollIntoView() to avoid
  // Electron quirks where body { overflow: hidden } can intercept the scroll.
  const currentEl = state.wordElements[index];
  if (currentEl && teleContent) {
    const containerRect = teleContent.getBoundingClientRect();
    const elRect        = currentEl.getBoundingClientRect();
    const relativeTop   = elRect.top - containerRect.top;
    const target        = teleContent.scrollTop + relativeTop - teleContent.clientHeight / 3;
    teleContent.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
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
   Voice recognition — Web Speech API
   Works in Chrome/Edge when the page is served over HTTPS.
   GitHub Pages provides HTTPS automatically.
   ================================================================ */

function buildRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;

  const r = new SpeechRecognition();
  r.continuous      = true;
  r.interimResults  = true;
  r.maxAlternatives = 1;
  r.lang            = state.language;

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

    // Show what the mic is hearing in the status bar
    const heard = (finalText || interimText).trim();
    if (heard) {
      const preview = heard.length > 38 ? '\u2026' + heard.slice(-35) : heard;
      setStatus('listening', `Hearing: \u201c${preview}\u201d`);
    }

    if (finalText.trim()) {
      // A final result arrived. The interim for this utterance was already
      // processed word-by-word, so just reset the counter for the next utterance.
      state.interimWordsProcessed = 0;
    }

    // Handle interim separately (NOT else-if): Chrome sometimes fires one event
    // with both a completed final AND the start of the next interim.  If we used
    // else-if we would skip those new interim words entirely.
    if (interimText.trim()) {
      // Interim results grow: "hello" → "hello world" → "hello world how are".
      // Only process the NEW words added since the last event.
      const allWords = interimText.trim().split(/\s+/).filter(Boolean);
      const newWords = allWords.slice(state.interimWordsProcessed);
      if (newWords.length > 0) {
        processTranscript(newWords.join(' '));
        state.interimWordsProcessed = allWords.length;
      }
    }
  };

  r.onerror = (e) => {
    state.recognitionRunning = false;
    state.interimWordsProcessed = 0;
    const messages = {
      'not-allowed':         'Microphone access denied — allow mic in browser',
      'network':             'Network error — check your connection',
      'audio-capture':       'No microphone found — check your mic',
      'service-not-allowed': 'Speech service unavailable',
    };
    if (messages[e.error]) setStatus('idle', messages[e.error]);
    if (state.isPlaying && state.mode === 'voice') {
      setTimeout(() => startRecognition(), 800);
    }
  };

  r.onend = () => {
    state.recognitionRunning = false;
    state.interimWordsProcessed = 0;  // reset so the new session starts clean
    // Chrome times out every ~60 s — restart seamlessly
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
        'Speech recognition is not supported in this browser.\n\n' +
        'Please use Google Chrome or Microsoft Edge, and make sure\n' +
        'microphone permission is allowed for this site.'
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
