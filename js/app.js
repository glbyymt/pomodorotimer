/**
 * ポモドーロタイマー メインスクリプト
 *
 * 時刻ベース（endTime）のカウントダウン、localStorage による状態永続化、
 * バックグラウンド動作（Keep-Alive 音声・Service Worker 通知）を提供する。
 * タイマー実行中は Screen Wake Lock API で画面をオンに保つ。
 */
(function () {
  "use strict";

  /** localStorage に保存するキー名の定義 */
  const STORAGE_KEYS = {
    workTime: "pomodoro_workTime",
    shortBreak: "pomodoro_shortBreak",
    longBreak: "pomodoro_longBreak",
    longBreakCycle: "pomodoro_longBreakCycle",
    sessionCount: "pomodoro_sessionCount",
    sessionDate: "pomodoro_sessionDate",
    endTime: "pomodoro_endTime",
    isRunning: "pomodoro_isRunning",
    mode: "pomodoro_mode",
    remainingSeconds: "pomodoro_remainingSeconds",
  };

  /** タイマーの動作モード */
  const MODE = {
    WORK: "work",
    SHORT_BREAK: "shortBreak",
    LONG_BREAK: "longBreak",
  };

  /** 各設定項目の初期値（分・回） */
  const DEFAULTS = {
    workTime: 25,
    shortBreak: 5,
    longBreak: 15,
    longBreakCycle: 4,
  };

  /** 設定画面の入力バリデーションルール */
  const VALIDATION = {
    workTime: { min: 1, max: 120, label: "作業時間は1～120分で入力してください" },
    shortBreak: { min: 1, max: 60, label: "短休憩時間は1～60分で入力してください" },
    longBreak: { min: 1, max: 120, label: "長休憩時間は1～120分で入力してください" },
    longBreakCycle: { min: 1, max: 10, label: "長休憩回数は1～10回で入力してください" },
  };

  /** 画面上に表示するモード名 */
  const MODE_LABELS = {
    [MODE.WORK]: "作業中",
    [MODE.SHORT_BREAK]: "休憩中",
    [MODE.LONG_BREAK]: "長休憩中",
  };

  /** 画面更新のポーリング間隔（ミリ秒） */
  const TICK_INTERVAL_MS = 250;

  /** アプリケーションの実行時状態 */
  const state = {
    mode: MODE.WORK,
    remainingSeconds: 0,
    endTime: null,
    isRunning: false,
    intervalId: null,
    completedSessions: 0,
    settings: { ...DEFAULTS },
  };

  /** DOM 要素への参照を保持するオブジェクト */
  const elements = {};

  /** Web Audio API のコンテキスト（アラーム再生用） */
  let audioContext = null;

  /** バックグラウンド実行維持用の無音オーディオ要素 */
  let keepAliveAudio = null;

  /** 画面スリープ防止用の Wake Lock オブジェクト */
  let wakeLock = null;

  /** タイマー完了処理の二重実行を防ぐフラグ */
  let isCompleting = false;

  /**
   * 指定 ID の DOM 要素を取得する。
   * @param {string} id - 要素 ID
   * @returns {HTMLElement|null}
   */
  function $(id) {
    return document.getElementById(id);
  }

  /**
   * localStorage から各種時間設定を読み込み、state.settings に反映する。
   */
  function loadSettings() {
    state.settings = {
      workTime: readNumber(STORAGE_KEYS.workTime, DEFAULTS.workTime),
      shortBreak: readNumber(STORAGE_KEYS.shortBreak, DEFAULTS.shortBreak),
      longBreak: readNumber(STORAGE_KEYS.longBreak, DEFAULTS.longBreak),
      longBreakCycle: readNumber(STORAGE_KEYS.longBreakCycle, DEFAULTS.longBreakCycle),
    };
  }

  /**
   * 日付が変わっていた場合、セッションカウントを当日分にリセットする。
   * アプリを開きっぱなしで日付をまたいだ場合にも対応する。
   */
  function ensureSessionDateIsToday() {
    const today = getTodayString();
    const savedDate = localStorage.getItem(STORAGE_KEYS.sessionDate);

    if (savedDate === today) {
      state.completedSessions = readNumber(STORAGE_KEYS.sessionCount, 0);
      return;
    }

    state.completedSessions = 0;
    localStorage.setItem(STORAGE_KEYS.sessionDate, today);
    localStorage.setItem(STORAGE_KEYS.sessionCount, "0");
  }

  /**
   * 現在の作業完了回数を localStorage に保存する。
   */
  function saveSessionCount() {
    localStorage.setItem(STORAGE_KEYS.sessionDate, getTodayString());
    localStorage.setItem(STORAGE_KEYS.sessionCount, String(state.completedSessions));
  }

  /**
   * localStorage から数値を読み込む。不正な値の場合は fallback を返す。
   * @param {string} key - localStorage のキー
   * @param {number} fallback - 読み込み失敗時の既定値
   * @returns {number}
   */
  function readNumber(key, fallback) {
    const value = localStorage.getItem(key);
    if (value === null || value === "") return fallback;
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  /**
   * 本日の日付を YYYY-MM-DD 形式の文字列で返す。
   * @returns {string}
   */
  function getTodayString() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  /**
   * 指定モードのタイマー時間（秒）を返す。
   * @param {string} mode - MODE 定数のいずれか
   * @returns {number}
   */
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

  /**
   * 秒数を MM:SS 形式の文字列に変換する。
   * @param {number} totalSeconds - 残り秒数
   * @returns {string}
   */
  function formatTime(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  /**
   * endTime（終了予定時刻）から残り秒数を算出する。
   * endTime が未設定の場合は state.remainingSeconds をそのまま返す。
   * @returns {number}
   */
  function getRemainingSecondsFromEndTime() {
    if (!state.endTime) {
      return state.remainingSeconds;
    }
    return Math.max(0, Math.ceil((state.endTime - Date.now()) / 1000));
  }

  /**
   * タイマーの現在状態を localStorage に保存する。
   */
  function saveTimerState() {
    localStorage.setItem(STORAGE_KEYS.endTime, state.endTime ? String(state.endTime) : "");
    localStorage.setItem(STORAGE_KEYS.isRunning, state.isRunning ? "1" : "0");
    localStorage.setItem(STORAGE_KEYS.mode, state.mode);
    localStorage.setItem(STORAGE_KEYS.remainingSeconds, String(state.remainingSeconds));
  }

  /**
   * 実行中タイマー情報をクリアし、一時停止状態として localStorage に保存する。
   */
  function clearRunningTimerState() {
    state.endTime = null;
    localStorage.setItem(STORAGE_KEYS.endTime, "");
    localStorage.setItem(STORAGE_KEYS.isRunning, "0");
    localStorage.setItem(STORAGE_KEYS.remainingSeconds, String(state.remainingSeconds));
  }

  /**
   * 現在のモードに応じて body 要素の CSS クラスを切り替える。
   */
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

  /**
   * タイマーの実行状態に応じたステータスラベルを返す。
   * @returns {string} 「停止中」「一時停止」「作業中」など
   */
  function getStatusLabel() {
    if (state.isRunning) {
      return MODE_LABELS[state.mode];
    }
    if (state.remainingSeconds > 0 && state.remainingSeconds < getDurationForMode(state.mode)) {
      return "一時停止";
    }
    return "停止中";
  }

  /**
   * タイマー実行中は設定ボタンを無効化する。
   */
  function updateSettingsButtonState() {
    elements.btnSetting.disabled = state.isRunning;
    elements.btnSetting.title = state.isRunning
      ? "タイマー実行中は設定を変更できません"
      : "";
  }

  /**
   * モード表示・残り時間・セッション数・背景色を画面に反映する。
   */
  function updateDisplay() {
    ensureSessionDateIsToday();
    elements.lblMode.textContent = getStatusLabel();
    elements.lblTimer.textContent = formatTime(state.remainingSeconds);
    elements.lblSession.textContent = `今日の完了回数：${state.completedSessions}回`;
    applyBodyMode();
    updateSettingsButtonState();
  }

  /**
   * メッセージエリアにテキストを表示する。
   * @param {string} text - 表示するメッセージ
   * @param {string} [type] - CSS クラス（"error" / "success" など）
   */
  function showMessage(text, type) {
    elements.messageArea.textContent = text;
    elements.messageArea.className = type ? `visible ${type}` : "visible";
  }

  /**
   * メッセージエリアの表示をクリアする。
   */
  function clearMessage() {
    elements.messageArea.textContent = "";
    elements.messageArea.className = "";
  }

  /**
   * バックグラウンド実行維持用の無音 WAV ファイルの Object URL を生成する。
   * @returns {string}
   */
  function createSilentWavUrl() {
    const sampleRate = 44100;
    const numSamples = sampleRate;
    const arrayBuffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(arrayBuffer);

    function writeString(offset, str) {
      for (let i = 0; i < str.length; i += 1) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    }

    writeString(0, "RIFF");
    view.setUint32(4, 36 + numSamples * 2, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, numSamples * 2, true);

    return URL.createObjectURL(new Blob([arrayBuffer], { type: "audio/wav" }));
  }

  /**
   * Keep-Alive 用の無音 audio 要素を初期化する（初回のみ）。
   */
  function initKeepAliveAudio() {
    if (keepAliveAudio) return;

    keepAliveAudio = document.createElement("audio");
    keepAliveAudio.id = "keepAliveAudio";
    keepAliveAudio.loop = true;
    keepAliveAudio.preload = "auto";
    keepAliveAudio.src = createSilentWavUrl();
    keepAliveAudio.setAttribute("playsinline", "");
    document.body.appendChild(keepAliveAudio);
  }

  /**
   * 無音ループ再生を開始し、バックグラウンドでのタイマー停止を防ぐ。
   */
  function startKeepAlive() {
    initKeepAliveAudio();
    const playPromise = keepAliveAudio.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => {});
    }
  }

  /**
   * 無音ループ再生を停止する。
   */
  function stopKeepAlive() {
    if (!keepAliveAudio) return;
    keepAliveAudio.pause();
    keepAliveAudio.currentTime = 0;
  }

  /**
   * Screen Wake Lock API で画面のスリープを防ぐ。
   * 非対応ブラウザや取得失敗時は何もしない。
   */
  async function requestWakeLock() {
    if (!("wakeLock" in navigator) || wakeLock !== null) {
      return;
    }

    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    } catch (_e) {
      wakeLock = null;
    }
  }

  /**
   * 取得済みの Wake Lock を解放する。
   */
  async function releaseWakeLock() {
    if (wakeLock === null) {
      return;
    }

    try {
      await wakeLock.release();
    } catch (_e) {
      /* 解放失敗時は無視 */
    }

    wakeLock = null;
  }

  /**
   * タイマー実行中のバックグラウンド維持処理を開始する（無音再生・画面オン）。
   */
  function startRunningSupport() {
    startKeepAlive();
    requestWakeLock();
  }

  /**
   * タイマー実行中のバックグラウンド維持処理を停止する（無音再生・画面オン）。
   */
  function stopRunningSupport() {
    stopKeepAlive();
    releaseWakeLock();
  }

  /**
   * Web Audio API の AudioContext を初期化・再開する。
   * @returns {Promise<void>}
   */
  function ensureAudioContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      return Promise.resolve();
    }

    if (!audioContext) {
      audioContext = new AudioContextClass();
    }

    if (audioContext.state === "suspended") {
      return audioContext.resume();
    }

    return Promise.resolve();
  }

  /**
   * アラーム音（3 回のビープ）を再生する。
   */
  function playAlarm() {
    ensureAudioContext()
      .then(() => {
        if (!audioContext) return;

        const playBeep = (startTime, frequency) => {
          const oscillator = audioContext.createOscillator();
          const gain = audioContext.createGain();
          oscillator.connect(gain);
          gain.connect(audioContext.destination);
          oscillator.frequency.value = frequency;
          oscillator.type = "sine";
          gain.gain.setValueAtTime(0.3, startTime);
          gain.gain.exponentialRampToValueAtTime(0.01, startTime + 0.4);
          oscillator.start(startTime);
          oscillator.stop(startTime + 0.4);
        };

        const now = audioContext.currentTime;
        playBeep(now, 880);
        playBeep(now + 0.5, 880);
        playBeep(now + 1.0, 1100);
      })
      .catch(() => {});
  }

  /**
   * 現在のモードに対応する通知本文を返す（Service Worker 用）。
   * @returns {string}
   */
  function getNotificationBody() {
    if (state.mode === MODE.WORK) {
      return "作業時間が終了しました。休憩を開始します。";
    }
    return "休憩が終了しました。次の作業を開始しましょう。";
  }

  /**
   * ブラウザ通知を表示する。画面が非表示の場合は Service Worker に任せる。
   * @param {string} title - 通知タイトル
   * @param {string} body - 通知本文
   */
  function showNotification(title, body) {
    if (!("Notification" in window) || Notification.permission !== "granted") {
      return;
    }

    if (document.visibilityState === "hidden") {
      return;
    }

    try {
      new Notification(title, {
        body,
        tag: "pomodoro-timer-alarm",
        requireInteraction: true,
        silent: false,
      });
    } catch (_e) {
      /* 通知不可環境では無視 */
    }
  }

  /**
   * ブラウザ通知の表示許可をリクエストする。
   * @returns {Promise<void>}
   */
  function requestNotificationPermission() {
    if (!("Notification" in window)) {
      return Promise.resolve();
    }

    if (Notification.permission === "granted" || Notification.permission === "denied") {
      return Promise.resolve();
    }

    return Notification.requestPermission().then(() => {});
  }

  /**
   * Service Worker にメッセージを送信する。
   * @param {object} message - 送信するメッセージオブジェクト
   */
  function postToServiceWorker(message) {
    if (!("serviceWorker" in navigator)) {
      return;
    }

    navigator.serviceWorker.ready
      .then((registration) => {
        if (registration.active) {
          registration.active.postMessage(message);
        }
      })
      .catch(() => {});
  }

  /**
   * Service Worker にタイマー終了時刻を登録し、バックグラウンド通知を予約する。
   */
  function scheduleBackgroundAlarm() {
    if (!state.isRunning || !state.endTime) {
      return;
    }

    postToServiceWorker({
      type: "SCHEDULE_ALARM",
      endTime: state.endTime,
      title: "ポモドーロタイマー",
      body: getNotificationBody(),
    });
  }

  /**
   * Service Worker に登録済みのバックグラウンド通知をキャンセルする。
   */
  function cancelBackgroundAlarm() {
    postToServiceWorker({ type: "CANCEL_ALARM" });
  }

  /**
   * Service Worker（sw.js）を登録する。file:// プロトコルでは登録しない。
   * @returns {Promise<void>}
   */
  function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || location.protocol === "file:") {
      return Promise.resolve();
    }

    return navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  /**
   * 画面更新用の setInterval を停止する。
   */
  function stopTicking() {
    if (state.intervalId !== null) {
      clearInterval(state.intervalId);
      state.intervalId = null;
    }
  }

  /**
   * タイマーの残り時間を更新し、0 になったら完了処理を呼ぶ。
   */
  function tick() {
    if (!state.isRunning) return;

    const remaining = getRemainingSecondsFromEndTime();
    state.remainingSeconds = remaining;

    if (remaining <= 0) {
      onTimerComplete();
      return;
    }

    ensureSessionDateIsToday();
    elements.lblTimer.textContent = formatTime(remaining);
    elements.lblSession.textContent = `今日の完了回数：${state.completedSessions}回`;
  }

  /**
   * 画面更新用のポーリングを開始する。
   */
  function startTicking() {
    stopTicking();
    state.intervalId = setInterval(tick, TICK_INTERVAL_MS);
    tick();
  }

  /**
   * 画面復帰時などに endTime から残り時間を再計算し、必要なら完了処理を行う。
   */
  function syncTimer() {
    if (!state.isRunning || !state.endTime) {
      return;
    }

    const remaining = getRemainingSecondsFromEndTime();
    state.remainingSeconds = remaining;
    updateDisplay();

    if (remaining <= 0) {
      onTimerComplete();
    }
  }

  /**
   * タイマーを開始する。終了予定時刻を設定し、ポーリング・Keep-Alive・通知を有効化する。
   */
  function startTimer() {
    if (state.isRunning) return;

    requestNotificationPermission();
    ensureAudioContext();

    state.isRunning = true;
    state.endTime = Date.now() + state.remainingSeconds * 1000;
    clearMessage();
    saveTimerState();
    updateDisplay();
    startTicking();
    startRunningSupport();
    scheduleBackgroundAlarm();
  }

  /**
   * タイマーを一時停止する。残り時間を保持し、バックグラウンド処理を停止する。
   */
  function pauseTimer() {
    if (!state.isRunning) return;

    state.remainingSeconds = getRemainingSecondsFromEndTime();
    state.isRunning = false;
    state.endTime = null;
    stopTicking();
    stopRunningSupport();
    cancelBackgroundAlarm();
    clearRunningTimerState();
    updateDisplay();
  }

  /**
   * タイマー完了時の処理。通知・アラームを鳴らし、次のモードへ自動切替する。
   */
  function onTimerComplete() {
    if (!state.isRunning || isCompleting) {
      return;
    }

    isCompleting = true;

    try {
      stopTicking();
      cancelBackgroundAlarm();

      const completedMode = state.mode;
      const notificationBody =
        completedMode === MODE.WORK
          ? "作業時間が終了しました。休憩を開始します。"
          : "休憩が終了しました。次の作業を開始しましょう。";
      const message =
        completedMode === MODE.WORK
          ? "作業終了です。\n休憩を開始します。"
          : "休憩終了です。\n次の作業を開始しましょう。";

      showNotification("ポモドーロタイマー", notificationBody);
      playAlarm();
      showMessage(message);

      if (completedMode === MODE.WORK) {
        state.completedSessions += 1;
        saveSessionCount();

        const isLongBreak =
          state.completedSessions > 0 &&
          state.completedSessions % state.settings.longBreakCycle === 0;

        state.mode = isLongBreak ? MODE.LONG_BREAK : MODE.SHORT_BREAK;
      } else {
        state.mode = MODE.WORK;
      }

      state.remainingSeconds = getDurationForMode(state.mode);
      state.isRunning = true;
      state.endTime = Date.now() + state.remainingSeconds * 1000;
      saveTimerState();
      updateDisplay();
      startTicking();
      startRunningSupport();
      scheduleBackgroundAlarm();
    } finally {
      isCompleting = false;
    }
  }

  /**
   * 指定モードに切り替え、残り時間をそのモードの初期値に設定する。
   * @param {string} mode - MODE 定数のいずれか
   */
  function switchMode(mode) {
    state.mode = mode;
    state.remainingSeconds = getDurationForMode(mode);
    updateDisplay();
    localStorage.setItem(STORAGE_KEYS.mode, state.mode);
    localStorage.setItem(STORAGE_KEYS.remainingSeconds, String(state.remainingSeconds));
  }

  /**
   * タイマーをリセットする。作業モードの初期時間に戻し、セッション数も 0 にする。
   */
  function resetTimer() {
    stopTicking();
    stopRunningSupport();
    cancelBackgroundAlarm();

    state.isRunning = false;
    state.endTime = null;
    state.completedSessions = 0;
    saveSessionCount();
    switchMode(MODE.WORK);
    clearRunningTimerState();
    clearMessage();
    updateDisplay();
  }

  /**
   * ページ読み込み時に localStorage からタイマー状態を復元する。
   * スリープ中に時間切れしていた場合は完了処理を実行する。
   */
  function restoreTimerState() {
    const savedMode = localStorage.getItem(STORAGE_KEYS.mode);
    if (savedMode && Object.values(MODE).includes(savedMode)) {
      state.mode = savedMode;
    }

    const wasRunning = localStorage.getItem(STORAGE_KEYS.isRunning) === "1";
    const savedEndTime = readNumber(STORAGE_KEYS.endTime, 0);

    if (wasRunning && savedEndTime > Date.now()) {
      state.endTime = savedEndTime;
      state.isRunning = true;
      state.remainingSeconds = getRemainingSecondsFromEndTime();
      updateDisplay();
      startTicking();
      startRunningSupport();
      scheduleBackgroundAlarm();
      return;
    }

    if (wasRunning && savedEndTime > 0 && savedEndTime <= Date.now()) {
      state.endTime = savedEndTime;
      state.isRunning = true;
      state.remainingSeconds = 0;
      onTimerComplete();
      return;
    }

    const savedRemaining = readNumber(STORAGE_KEYS.remainingSeconds, getDurationForMode(state.mode));
    const duration = getDurationForMode(state.mode);

    if (savedRemaining > 0 && savedRemaining <= duration) {
      state.remainingSeconds = savedRemaining;
    } else {
      state.remainingSeconds = duration;
    }

    clearRunningTimerState();
    updateDisplay();
  }

  /**
   * 設定画面を表示し、現在の設定値を入力欄に反映する。
   * タイマー実行中は開けない。
   */
  function showSettings() {
    if (state.isRunning) {
      return;
    }

    elements.txtWorkTime.value = state.settings.workTime;
    elements.txtShortBreak.value = state.settings.shortBreak;
    elements.txtLongBreak.value = state.settings.longBreak;
    elements.txtLongBreakCycle.value = state.settings.longBreakCycle;
    clearMessage();
    elements.mainScreen.classList.add("hidden");
    elements.settingsScreen.classList.add("active");
  }

  /**
   * 設定画面を閉じ、メイン画面に戻る（変更は破棄）。
   */
  function hideSettings() {
    elements.settingsScreen.classList.remove("active");
    elements.mainScreen.classList.remove("hidden");
  }

  /**
   * 設定項目の入力値をバリデーションする。
   * @param {string} value - 入力値
   * @param {string} fieldKey - VALIDATION のキー名
   * @returns {string|null} エラーメッセージ（正常時は null）
   */
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

  /**
   * 設定画面の入力値を検証し、問題なければ localStorage に保存する。
   * タイマー実行中は保存できない。
   */
  function saveSettings() {
    if (state.isRunning) {
      return;
    }

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
      const duration = getDurationForMode(state.mode);
      const isPaused =
        state.remainingSeconds > 0 && state.remainingSeconds < duration;

      if (isPaused) {
        // 一時停止中は残り時間を維持し、新しい設定時間を超えないよう調整する
        state.remainingSeconds = Math.min(state.remainingSeconds, duration);
      } else {
        state.remainingSeconds = duration;
      }

      saveTimerState();
      updateDisplay();
    }

    hideSettings();
    showMessage("設定を保存しました。", "success");
    setTimeout(clearMessage, 3000);
  }

  /**
   * ボタン操作・画面復帰イベントのリスナーを登録する。
   */
  function bindEvents() {
    elements.btnStart.addEventListener("click", startTimer);
    elements.btnPause.addEventListener("click", pauseTimer);
    elements.btnReset.addEventListener("click", resetTimer);
    elements.btnSetting.addEventListener("click", showSettings);
    elements.btnSave.addEventListener("click", saveSettings);
    elements.btnCancel.addEventListener("click", hideSettings);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        syncTimer();
        if (state.isRunning) {
          requestWakeLock();
        }
      }
    });

    window.addEventListener("focus", syncTimer);
    window.addEventListener("pageshow", syncTimer);
  }

  /**
   * アプリケーションの初期化処理。DOM 取得・設定読み込み・状態復元を行う。
   */
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
    ensureSessionDateIsToday();
    bindEvents();

    registerServiceWorker().finally(() => {
      restoreTimerState();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
