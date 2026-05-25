(() => {
  const STORAGE_KEY = "filePipePlaybackProgressByMd5";
  const DEFAULT_TTL_MS = 12 * 24 * 60 * 60 * 1000;
  const MIN_RESUME_SECONDS = 5;
  const END_CLEAR_SECONDS = 8;

  function now() {
    return Date.now();
  }

  function normalizedMd5(md5) {
    const value = String(md5 || "").trim().toLowerCase();
    return /^[a-f0-9]{32}$/.test(value) ? value : "";
  }

  function readStore(ttlMs = DEFAULT_TTL_MS) {
    const cutoff = now() - ttlMs;
    let store = {};
    try {
      store = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    } catch (error) {
      store = {};
    }
    let changed = false;
    for (const [key, entry] of Object.entries(store)) {
      if (!entry || Number(entry.updatedAt || 0) < cutoff) {
        delete store[key];
        changed = true;
      }
    }
    if (changed) writeStore(store);
    return store;
  }

  function writeStore(store) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (error) {
      // Storage can be unavailable in private or restricted browsing contexts.
    }
  }

  function shouldClearAt(time, duration) {
    return Number.isFinite(duration)
      && duration > 0
      && time >= Math.max(MIN_RESUME_SECONDS, duration - END_CLEAR_SECONDS);
  }

  function get(md5, options = {}) {
    const key = normalizedMd5(md5);
    if (!key) return null;
    const entry = readStore(options.ttlMs || DEFAULT_TTL_MS)[key];
    if (!entry) return null;
    const time = Number(entry.currentTime || 0);
    return time >= MIN_RESUME_SECONDS ? { ...entry, currentTime: time } : null;
  }

  function save(md5, video, options = {}) {
    const key = normalizedMd5(md5);
    if (!key || !video) return;
    const currentTime = Number(video.currentTime || 0);
    const duration = Number(video.duration || 0);
    const store = readStore(options.ttlMs || DEFAULT_TTL_MS);
    if (shouldClearAt(currentTime, duration)) {
      delete store[key];
      writeStore(store);
      return;
    }
    if (currentTime < MIN_RESUME_SECONDS) return;
    store[key] = {
      currentTime,
      duration: Number.isFinite(duration) ? duration : 0,
      updatedAt: now(),
      name: options.name || "",
    };
    writeStore(store);
  }

  function clear(md5) {
    const key = normalizedMd5(md5);
    if (!key) return;
    const store = readStore();
    delete store[key];
    writeStore(store);
  }

  function apply(video, md5, options = {}) {
    const entry = get(md5, options);
    if (!entry || !video) return false;
    if (video.readyState === HTMLMediaElement.HAVE_NOTHING) return false;
    const duration = Number(video.duration || 0);
    if (shouldClearAt(entry.currentTime, duration)) {
      clear(md5);
      return false;
    }
    const target = Number.isFinite(duration) && duration > 0
      ? Math.min(entry.currentTime, Math.max(0, duration - END_CLEAR_SECONDS))
      : entry.currentTime;
    if (target < MIN_RESUME_SECONDS || Math.abs((video.currentTime || 0) - target) < 1) return false;
    try {
      video.currentTime = target;
      return true;
    } catch (error) {
      return false;
    }
  }

  function attach(video, options = {}) {
    if (!video) return { detach() {}, refresh() {}, save() {} };
    let md5 = normalizedMd5(typeof options.md5 === "function" ? options.md5() : options.md5);
    const ttlMs = options.ttlMs || DEFAULT_TTL_MS;
    const name = options.name || "";
    let resumeApplied = false;
    let lastSaveAt = 0;

    const currentMd5 = () => {
      md5 = normalizedMd5(typeof options.md5 === "function" ? options.md5() : md5 || options.md5);
      return md5;
    };
    const tryApply = () => {
      if (resumeApplied || !currentMd5()) return;
      resumeApplied = apply(video, md5, { ttlMs });
    };
    const saveNow = () => {
      if (!currentMd5()) return;
      save(md5, video, { ttlMs, name: typeof name === "function" ? name() : name });
    };
    const saveThrottled = () => {
      const timestamp = now();
      if (timestamp - lastSaveAt < 5000) return;
      lastSaveAt = timestamp;
      saveNow();
    };
    const handleEnded = () => {
      if (currentMd5()) clear(md5);
    };

    video.addEventListener("loadedmetadata", tryApply);
    video.addEventListener("durationchange", tryApply);
    video.addEventListener("timeupdate", saveThrottled);
    video.addEventListener("pause", saveNow);
    video.addEventListener("seeked", saveNow);
    video.addEventListener("ended", handleEnded);
    tryApply();

    return {
      detach() {
        video.removeEventListener("loadedmetadata", tryApply);
        video.removeEventListener("durationchange", tryApply);
        video.removeEventListener("timeupdate", saveThrottled);
        video.removeEventListener("pause", saveNow);
        video.removeEventListener("seeked", saveNow);
        video.removeEventListener("ended", handleEnded);
      },
      refresh(nextMd5 = null) {
        if (nextMd5) md5 = normalizedMd5(nextMd5);
        resumeApplied = false;
        tryApply();
      },
      save: saveNow,
    };
  }

  window.FilePipePlaybackProgress = {
    attach,
    get,
    save,
    clear,
    ttlMs: DEFAULT_TTL_MS,
  };
})();
