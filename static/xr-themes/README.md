# XR Theme Configuration

Themes are defined with a `theme.yaml` file in a folder under `static/xr-themes`.
The Flask theme endpoint resolves local files and returns the theme as JSON for
`static/xr-player.js`.

## Top-Level Fields

- `id`, `name`, `background`: theme identity and scene background.
- `floor`: optional grid helper configuration.
- `desktop`: optional desktop-preview camera hints such as `fov`.
- `settings`: controls exposed in the XR Theater side panel.
- `lights`: scene light sources.
- `assets`: renderable scene objects.
- `speakers` or `audio.speakers`: optional spatial-audio speaker placements.
- `videoSampling: true`: lets the theme sample the playing video edges even
  when the user-facing backlight effect is off.

## Settings

Settings are persisted per theme in local storage and can be referenced by other
fields with either `visibleSetting`, `opacitySetting`, `intensitySetting`, or a
string value such as `"$glyph_brightness"`.

```yaml
settings:
  - id: glyphs_on
    label: Glyph lights
    type: boolean
    default: true
  - id: glyph_brightness
    label: Glyph brightness
    type: number
    min: 0
    max: 1.6
    step: 0.05
    default: 0.9
```

Supported setting types are `boolean`, `number`, and `select`.

## Assets

Supported asset types are `image`, `obj`, `box`, `light`, and `empty`.

Common fields:

- `id`: stable identifier for interactions and saved object positions.
- `position`, `rotation`, `scale`: transform arrays.
- `color`, `opacity`, `visibleSetting`, `opacitySetting`.
- `lit`, `roughness`, `metalness`, `emissive`, `emissiveIntensity` for lit box
  and OBJ materials.
- `material: glass` for transparent physical glass on `box` and `obj` assets.
  Glass supports `opacity`, `roughness`, `transmission`, `thickness`, `ior`,
  `clearcoat`, `clearcoatRoughness`, `attenuationColor`, and
  `attenuationDistance`.
- `glow: true` for additive image rendering.
- `movable: true`, `moveAxis`, `moveBounds` for desktop object movement.
- `interaction` for click/controller actions.
- `animation` for simple frame animation.
- `videoSample` to tint or illuminate an object from the same edge sampler used
  by video backlights.

## Video Sampling

Themes can opt into video color sampling without requiring the Backlight control
to be enabled. Add `videoSampling: true` at the top level, then set
`videoSample` on any light or material-backed asset that should react to video
color.

```yaml
videoSampling: true

lights:
  - id: video-edge-wash
    type: point
    position: [0, 0.58, -3.08]
    intensity: 1.35
    videoSample: average
    videoSampleMultiplier: "$video_reactive_light"
    videoSampleMinIntensity: 0
    videoSampleMaxIntensity: 2.2
```

Supported sample regions are `average`, `top`, `bottom`, `left`, `right`,
`vertical`, `horizontal`, and the corner regions `top-left`, `top-right`,
`bottom-left`, and `bottom-right`.

For lights, `videoSample` drives light color and intensity. For assets,
`videoSampleTarget` can be `emissive`, `color`, or `both`; `videoSampleOpacity`
also lets the sampled level scale opacity.

## Lights

Lights can be declared top-level under `lights` or as `assets` with
`type: light`.

Supported light types are `ambient`, `point`, `directional`, `spot`, and
`hemisphere`.

```yaml
lights:
  - id: display-wash
    type: point
    position: [0, 0.9, -3.25]
    color: "#9ecfff"
    intensitySetting: lounge_key_light
    distance: 5.8
    decay: 2
```

## Spatial Audio

When Spatial audio is enabled, multichannel audio is split into virtual speaker
channels. In the normal player this acts as headphone spatial audio with a fixed
listener facing the screen; in XR Theater the listener follows the headset pose.
If a theme does not define speakers, File Pipe uses an idealized
screen-relative layout for common mono, stereo, 5.1, and 7.1 channel labels.

Themes can override placements with top-level `speakers` or nested
`audio.speakers` entries. `position` is `[x, y, z]` in meters. By default
positions are relative to the video screen; use `relativeTo: room` for world
space or `relativeTo: listener` for head-relative polar placement.

```yaml
speakers:
  - channel: L
    position: [-1.7, 0.05, 0.08]
  - channel: R
    position: [1.7, 0.05, 0.08]
  - channel: SL
    angle: -105
    distance: 2.4
    height: 0
    relativeTo: listener
  - channel: SR
    angle: 105
    distance: 2.4
    height: 0
    relativeTo: listener
  - channel: LFE
    position: [0, -0.85, 0.55]
    gain: 0.8
```

Supported channel labels include `L`, `R`, `C`, `LFE`, `SL`, `SR`, `BL`, `BR`,
`BC`, `FLC`, and `FRC`. Common aliases such as `left`, `right`, `center`,
`subwoofer`, `leftSurround`, and `rightBack` are normalized automatically.

## Interactions

Interactive objects can change settings or toggle another object.

```yaml
interaction:
  action: toggleSetting
  setting: glyphs_on
```

Supported actions:

- `toggleSetting`
- `incrementSetting`
- `toggleVisible`

Desktop users click interactive meshes. XR users aim a controller and press
select.

## Animations

Animations are intentionally simple and deterministic.

```yaml
animation:
  type: pulse
  speed: 0.2
  amplitude: 0.06
```

Supported types are `pulse`, `rotate`, `bob`, and `sway`.
