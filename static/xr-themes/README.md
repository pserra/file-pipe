# XR Theme Configuration

Themes are defined with a `theme.yaml` file in a folder under `static/xr-themes`.
The Flask theme endpoint resolves local files and returns the theme as JSON for
`static/xr-player.js`.

## Top-Level Fields

- `id`, `name`, `background`: theme identity and scene background.
- `floor`: optional grid helper configuration.
- `settings`: controls exposed in the XR Theater side panel.
- `lights`: scene light sources.
- `assets`: renderable scene objects.

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
- `glow: true` for additive image rendering.
- `movable: true`, `moveAxis`, `moveBounds` for desktop object movement.
- `interaction` for click/controller actions.
- `animation` for simple frame animation.

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
