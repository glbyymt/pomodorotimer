(function () {
  "use strict";

  const STORAGE_KEYS = {
    workTime: "pomodoro_workTime",
    shortBreak: "pomodoro_shortBreak",
    longBreak: "pomodoro_longBreak",
    longBreakCycle: "pomodoro_longBreakCycle",
    sessionCount: "pomodoro_sessionCount",
    sessionDate: "pomodoro_sessionDate",
  };

  const MODE = {
    WORK: "work",
    SHORT_BREAK: "shortBreak",
    LONG_BREAK: "longBreak",
  };

  const DEFAULTS = {
    workTime: 25,
    shortBreak: 5,
    longBreak: 15,
    longBreakCycle: 4,
  };

  const VALIDATION = {
    workTime: { min: 1, max: 120, label: "作業時間は1～120分で入力してください" },
    shortBreak: { min: 1, max: 60, label: "短休憩時間は1～60分で入力してください" },
    longBreak: { min: 1, max: 120, label: "長休憩時間は1～120分で入力してください" },
    longBreakCycle: { min: 1, max: 10, label: "長休憩回数は1～10回で入力してください" },
  };

  const MODE_LABELS = {
    [MODE.WORK]: "作業中",
    [MODE.SHORT_BREAK]: "休憩中",
    [MODE.LONG_BREAK]: "長休憩中",
  };

  const state = {
    mode: MODE.WORK,
    remainingSeconds: 0,
    isRunning: false,
    intervalId: null,
    completedSessions: 0,
    settings: { ...DEFAULTS },
  };

  const elements = {};

  function $(id) {
    return document.getElementById(id);
  }

  function loadSettings() {
    state.settings = {
      workTime: readNumber(STORAGE_KEYS.workTime, DEFAULTS.workTime),
      shortBreak: readNumber(STORAGE_KEYS.shortBreak, DEFAULTS.shortBreak),
      longBreak: readNumber(STORAGE_KEYS.longBreak, DEFAULTS.longBreak),
      longBreakCycle: readNumber(STORAGE_KEYS.longBreakCycle, DEFAULTS.longBreakCycle),
    };
  }

  function loadSessionCount() {
    const today = getTodayString();
    const savedDate = localStorage.getItem(STORAGE_KEYS.sessionDate);

    if (savedDate === today) {
      state.completedSessions = readNumber(STORAGE_KEYS.sessionCount, 0);
    } else {
      state.completedSessions = 0;
      localStorage.setItem(STORAGE_KEYS.sessionDate, today);
      localStorage.setItem(STORAGE_KEYS.sessionCount, "0");
    }
  }

  function saveSessionCount() {
    localStorage.setItem(STORAGE_KEYS.sessionDate, getTodayString());
    localStorage.setItem(STORAGE_KEYS.sessionCount, String(state.completedSessions));
  }

  function readNumber(key, fallback) {
    const value = localStorage.getItem(key);
    if (value === null) return fallback;
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  function getTodayString() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  function getDurationForMode(mode) {
    switch (mode) {
      case MODE.WORK:
        return state.settings.workTime * 60;
      case MODE.SHORT_BREAK:
        return state.settings.shortBreak * 60;
      case MODE.LONG_BREAK:
        return state.settings.longBreak * 60;
      default:
        return state.settings.workTime * 60;
    }
  }

  function formatTime(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function applyBodyMode() {
    document.body.classList.remove("mode-work", "mode-short-break", "mode-long-break");
    if (state.mode === MODE.WORK) {
      document.body.classList.add("mode-work");
    } else if (state.mode === MODE.SHORT_BREAK) {
      document.body.classList.add("mode-short-break");
    } else {
      document.body.classList.add("mode-long-break");
    }
  }

  function getStatusLabel() {
    if (state.isRunning) {
      return MODE_LABELS[state.mode];
    }
    if (state.remainingSeconds > 0 && state.remainingSeconds < getDurationForMode(state.mode)) {
      return "一時停止";
    }
    return "停止中";
  }

  function updateDisplay() {
    elements.lblMode.textContent = getStatusLabel();
    elements.lblTimer.textContent = formatTime(state.remainingSeconds);
    elements.lblSession.textContent = `今日の完了回数：${state.completedSessions}回`;
    applyBodyMode();
  }

  function showMessage(text, type) {
    elements.messageArea.textContent = text;
    elements.messageArea.className = type ? `visible ${type}` : "visible";
  }

  function clearMessage() {
    elements.messageArea.textContent = "";
    elements.messageArea.className = "";
  }

  function playAlarm() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;

      const ctx = new AudioContext();
      const playBeep = (startTime, frequency) => {
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.frequency.value = frequency;
        oscillator.type = "sine";
        gain.gain.setValueAtTime(0.3, startTime);
        gain.gain.exponentialRampToValueAtTime(0.01, startTime + 0.4);
        oscillator.start(startTime);
        oscillator.stop(startTime + 0.4);
      };

      const now = ctx.currentTime;
      playBeep(now, 880);
      playBeep(now + 0.5, 880);
      playBeep(now + 1.0, 1100);
    } catch (_e) {
      /* 音声再生不可環境では無視 */
    }
  }

  function startTimer() {
    if (state.isRunning) return;

    state.isRunning = true;
    clearMessage();
    updateDisplay();

    state.intervalId = setInterval(() => {
      if (state.remainingSeconds <= 0) {
        onTimerComplete();
        return;
      }
      state.remainingSeconds -= 1;
      elements.lblTimer.textContent = formatTime(state.remainingSeconds);
    }, 1000);
  }

  function pauseTimer() {
    if (!state.isRunning) return;

    state.isRunning = false;
    if (state.intervalId !== null) {
      clearInterval(state.intervalId);
      state.intervalId = null;
    }
    updateDisplay();
  }

  function stopTimer() {
    pauseTimer();
  }

  function onTimerComplete() {
    stopTimer();

    if (state.mode === MODE.WORK) {
      state.completedSessions += 1;
      saveSessionCount();
      updateDisplay();

      const isLongBreak =
        state.completedSessions > 0 &&
        state.completedSessions % state.settings.longBreakCycle === 0;

      if (isLongBreak) {
        switchMode(MODE.LONG_BREAK);
        showMessage("作業終了です。\n休憩を開始します。");
      } else {
        switchMode(MODE.SHORT_BREAK);
        showMessage("作業終了です。\n休憩を開始します。");
      }
    } else {
      switchMode(MODE.WORK);
      showMessage("休憩終了です。\n次の作業を開始しましょう。");
    }

    playAlarm();
    startTimer();
  }

  function switchMode(mode) {
    state.mode = mode;
    state.remainingSeconds = getDurationForMode(mode);
    updateDisplay();
  }

  function resetTimer() {
    stopTimer();
    state.completedSessions = 0;
    saveSessionCount();
    switchMode(MODE.WORK);
    clearMessage();
  }

  function showSettings() {
    elements.txtWorkTime.value = state.settings.workTime;
    elements.txtShortBreak.value = state.settings.shortBreak;
    elements.txtLongBreak.value = state.settings.longBreak;
    elements.txtLongBreakCycle.value = state.settings.longBreakCycle;
    clearMessage();
    elements.mainScreen.classList.add("hidden");
    elements.settingsScreen.classList.add("active");
  }

  function hideSettings() {
    elements.settingsScreen.classList.remove("active");
    elements.mainScreen.classList.remove("hidden");
  }

  function validateField(value, fieldKey) {
    const rule = VALIDATION[fieldKey];
    if (value === "" || !/^\d+$/.test(String(value).trim())) {
      return rule.label;
    }
    const num = Number(value);
    if (num < rule.min || num > rule.max) {
      return rule.label;
    }
    return null;
  }

  function saveSettings() {
    const fields = [
      { key: "workTime", element: elements.txtWorkTime },
      { key: "shortBreak", element: elements.txtShortBreak },
      { key: "longBreak", element: elements.txtLongBreak },
      { key: "longBreakCycle", element: elements.txtLongBreakCycle },
    ];

    const errors = [];
    const newSettings = {};

    for (const field of fields) {
      const error = validateField(field.element.value, field.key);
      if (error) {
        errors.push(error);
      } else {
        newSettings[field.key] = Number(field.element.value);
      }
    }

    if (errors.length > 0) {
      showMessage("入力内容を確認してください。\n" + errors.join("\n"), "error");
      return;
    }

    state.settings = newSettings;
    localStorage.setItem(STORAGE_KEYS.workTime, String(newSettings.workTime));
    localStorage.setItem(STORAGE_KEYS.shortBreak, String(newSettings.shortBreak));
    localStorage.setItem(STORAGE_KEYS.longBreak, String(newSettings.longBreak));
    localStorage.setItem(STORAGE_KEYS.longBreakCycle, String(newSettings.longBreakCycle));

    if (!state.isRunning) {
      state.remainingSeconds = getDurationForMode(state.mode);
      updateDisplay();
    }

    hideSettings();
    showMessage("設定を保存しました。", "success");
    setTimeout(clearMessage, 3000);
  }

  function bindEvents() {
    elements.btnStart.addEventListener("click", startTimer);
    elements.btnPause.addEventListener("click", pauseTimer);
    elements.btnReset.addEventListener("click", resetTimer);
    elements.btnSetting.addEventListener("click", showSettings);
    elements.btnSave.addEventListener("click", saveSettings);
    elements.btnCancel.addEventListener("click", hideSettings);
  }

  function init() {
    elements.lblMode = $("lblMode");
    elements.lblTimer = $("lblTimer");
    elements.lblSession = $("lblSession");
    elements.btnStart = $("btnStart");
    elements.btnPause = $("btnPause");
    elements.btnReset = $("btnReset");
    elements.btnSetting = $("btnSetting");
    elements.btnSave = $("btnSave");
    elements.btnCancel = $("btnCancel");
    elements.mainScreen = $("mainScreen");
    elements.settingsScreen = $("settingsScreen");
    elements.messageArea = $("messageArea");
    elements.txtWorkTime = $("txtWorkTime");
    elements.txtShortBreak = $("txtShortBreak");
    elements.txtLongBreak = $("txtLongBreak");
    elements.txtLongBreakCycle = $("txtLongBreakCycle");

    loadSettings();
    loadSessionCount();
    switchMode(MODE.WORK);
    bindEvents();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
