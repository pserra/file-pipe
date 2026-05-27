(() => {
  const XR = window.FilePipeXr = window.FilePipeXr || {};
  const { INSTANCE_BY_VIDEO, FilePipeThreeXrPlayer } = XR;

  window.FilePipeXrPlayer = {
    attach(video, options = {}) {
      if (!video) return null;
      const existing = INSTANCE_BY_VIDEO.get(video);
      if (existing) return existing.updateOptions(options);
      const instance = new FilePipeThreeXrPlayer(video, options);
      INSTANCE_BY_VIDEO.set(video, instance);
      return instance;
    },
  };
})();
