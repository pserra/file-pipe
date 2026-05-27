(() => {
  const XR = window.FilePipeXr = window.FilePipeXr || {};
  const INSTANCE_BY_VIDEO = new WeakMap();
  const AUDIO_GRAPH_BY_VIDEO = new WeakMap();
  const DEFAULT_SETTINGS = {
    layout: "mono",
    eye: "left",
    headsetMode: "vr",
    panelWidth: 3.2,
    panelHeight: 1.8,
    panelX: 0,
    panelY: 0,
    panelYaw: 0,
    panelPitch: 0,
    screenCurve: 0,
    viewportWarp: 0,
    distance: 3,
    roomViewX: 0,
    roomViewY: 1.45,
    roomViewZ: 0,
    roomViewYaw: 0,
    roomViewPitch: -16,
    roomViewPresetVersion: 2,
    seating: "manual",
    freeRoam: false,
    roomDim: 80,
    sidePanelVisible: false,
    aspectLocked: true,
    backlightMode: "off",
    backlightIntensity: 100,
    spatialAudio: false,
    avatarEnabled: false,
    avatarViewpoint: false,
    avatarMirror: false,
    avatarPinned: false,
    theme: "default",
    themeDefaultRevisions: {},
  };
  const THEATER_SETTING_LIMITS = {
    panelWidth: [1.4, 6],
    panelHeight: [0.8, 3.6],
    panelX: [-3, 3],
    panelY: [-1.4, 1.4],
    panelYaw: [-35, 35],
    panelPitch: [-20, 20],
    screenCurve: [0, 100],
    viewportWarp: [0, 100],
    distance: [1.4, 6],
    roomViewX: [-4, 4],
    roomViewY: [-0.8, 2.2],
    roomViewZ: [-4.5, 3.2],
    roomViewYaw: [-180, 180],
    roomViewPitch: [-35, 35],
    roomDim: [0, 100],
    backlightIntensity: [0, 150],
  };
  const DEFAULT_AUDIO_CHANNEL_LABELS = ["L", "R", "C", "LFE", "SL", "SR", "BL", "BR"];
  const LAYOUT_LABELS = {
    mono: "Full frame",
    "half-sbs": "Half SBS 3D",
    "full-sbs": "Full SBS 3D",
  };
  const BACKLIGHT_SEGMENT_COUNTS = {
    top: 22,
    bottom: 22,
    left: 9,
    right: 9,
    "top-left": 2,
    "top-right": 2,
    "bottom-left": 2,
    "bottom-right": 2,
  };
  const XR_SIDE_PANEL_LOGICAL_SIZE = 1024;
  const XR_SIDE_PANEL_TEXTURE_SIZE = 2048;
  const XR_SIDE_PANEL_ANGLE = -0.34;
  const XR_THUMBSTICK_SEEK_SECONDS = 30;
  const XR_THUMBSTICK_SEEK_DEADZONE = 0.72;
  const XR_THUMBSTICK_SEEK_RESET_ZONE = 0.32;
  const XR_THUMBSTICK_SEEK_REPEAT_MS = 650;
  const MR_DIM_RENDER_ORDER = -10000;
  const BACKLIGHT_MASK_RENDER_ORDER = -30;
  const BACKLIGHT_RENDER_ORDER = -20;
  const AVATAR_POSE_SEND_INTERVAL_MS = 50;
  const AVATAR_REMOTE_TIMEOUT_MS = 3500;


  Object.assign(XR, {
    INSTANCE_BY_VIDEO,
    AUDIO_GRAPH_BY_VIDEO,
    DEFAULT_SETTINGS,
    THEATER_SETTING_LIMITS,
    DEFAULT_AUDIO_CHANNEL_LABELS,
    LAYOUT_LABELS,
    BACKLIGHT_SEGMENT_COUNTS,
    XR_SIDE_PANEL_LOGICAL_SIZE,
    XR_SIDE_PANEL_TEXTURE_SIZE,
    XR_SIDE_PANEL_ANGLE,
    XR_THUMBSTICK_SEEK_SECONDS,
    XR_THUMBSTICK_SEEK_DEADZONE,
    XR_THUMBSTICK_SEEK_RESET_ZONE,
    XR_THUMBSTICK_SEEK_REPEAT_MS,
    MR_DIM_RENDER_ORDER,
    BACKLIGHT_MASK_RENDER_ORDER,
    BACKLIGHT_RENDER_ORDER,
    AVATAR_POSE_SEND_INTERVAL_MS,
    AVATAR_REMOTE_TIMEOUT_MS,
  });
})();
