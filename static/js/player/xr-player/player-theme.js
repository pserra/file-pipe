(() => {
  const XR = window.FilePipeXr = window.FilePipeXr || {};
  const { FilePipeThreeXrPlayer } = XR;
  const {
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
    isKnownLayout,
    isKnownBacklightMode,
    isLocalDepthProcessor,
    normalizeLocalDepthSettings,
    normalizeSpeakerChannel,
    defaultSpeakerDefinition,
    speakerVectorFromDefinition,
    safeDisconnect,
    setAudioParamValue,
    setPannerPosition,
    setListenerPosition,
    setListenerOrientation,
    clampNumber,
    isPlainObject,
    mediaInfoVideoAspectRatio,
    glbMaterialTextureConfig,
    glbMaterialOverrideConfig,
    normalizeTextureConfig,
    normalizeGlbMaterialName,
    normalizeGlbNodeName,
    resolveRelativeAssetUrl,
    disposeThemeTexture,
    disposeThemeMaterial,
    gltfWrapMode,
    gltfMagFilter,
    gltfMinFilter,
    parseThemeGlb,
    shouldExcludeThemeGlbNode,
    buildThemeGlbTexture,
    applyGltfTextureTransform,
    buildThemeGlbNode,
    applyGltfNodeTransform,
    buildThemeGlbPrimitive,
    readGltfAccessor,
    readGltfComponent,
    coerceThemeSettingValue,
    formatThemeSettingValue,
    cssEscape,
    setObjectOpacity,
    normalizeDegrees,
    isEditableTarget,
    normalizedNavigationKey,
    isBacklightCornerSide,
    backlightOpacityScale,
    emptyBacklightColorMap,
    cornerVideoSampleRegion,
    lerp,
    createBacklightGlowTexture,
    createBacklightStaticMaterial,
    createBacklightSegmentMaterial,
    flipRgbaRows,
    hasVisibleSamplePixels,
    samplePixelDebug,
    objectMaterials,
    normalizeSeatingPosition,
    slugifySeatId,
    themeVideoSampleColor,
    averageBacklightColorMap,
    averageVisibleColors,
    averageSampleRegion,
    sampleExpandedSegmentRegion,
    isVisibleBacklightColor,
    hasVisibleBacklightColors,
    sampleExpandedBacklightColors,
    fallbackBacklightColors,
    offBacklightColors,
    offBacklightColor,
    colorToRgb,
    fallbackBacklightColor,
    lockedPanelSize,
    formatTime,
    cleanPanelText,
    wrapCanvasText,
    roundRect,
    drawXrPanelButton,
    colorFromTheme,
    shouldRestoreDesktopRoomView,
    parseObjGeometry,
  } = XR;

  Object.assign(FilePipeThreeXrPlayer.prototype, {
    applyTheme() {
      if (!this.scene || !this.themeGroup || !window.THREE) return;
      if (this.theaterMode === "lite") {
        this.clearThemeObjects();
        this.updateSceneLighting();
        return;
      }
      const revision = this.themeRevision + 1;
      this.themeRevision = revision;
      this.clearThemeObjects();
      const theme = this.currentTheme();
      const floor = typeof theme.floor === "object" && theme.floor ? theme.floor : {};
      if (floor.grid !== false) {
        const grid = new THREE.GridHelper(
          Number(floor.size || 8),
          Number(floor.divisions || 16),
          colorFromTheme(floor.accent || "#2f80ff", new THREE.Color("#2f80ff")),
          colorFromTheme(floor.color || "#1f2937", new THREE.Color("#1f2937")),
        );
        grid.position.y = Number(floor.y ?? -1.65);
        this.themeGroup.add(grid);
        this.gridMesh = grid;
        this.themeObjects.push(grid);
      } else {
        this.gridMesh = null;
      }
      for (const asset of Array.isArray(theme.assets) ? theme.assets : []) {
        this.addThemeAsset(asset, revision);
      }
      for (const light of Array.isArray(theme.lights) ? theme.lights : []) {
        this.addThemeLight(light, revision);
      }
      this.updateSceneLighting();
    },

    themeRoomScale(theme = this.currentTheme()) {
      const calibration = isPlainObject(theme?.calibration) ? theme.calibration : null;
      if (!calibration || calibration.enabled === false) return 1;
      if (Number.isFinite(Number(calibration.roomScale)) && Number(calibration.roomScale) > 0) {
        return Number(calibration.roomScale);
      }
      const reference = isPlainObject(calibration.reference) ? calibration.reference : calibration;
      const actualMeters = Number(reference?.actualMeters ?? reference?.actual);
      const assetMeters = Number(reference?.assetMeters ?? reference?.asset);
      if (Number.isFinite(actualMeters) && actualMeters > 0 && Number.isFinite(assetMeters) && assetMeters > 0) {
        return actualMeters / assetMeters;
      }
      return 1;
    },

    scaleThemeRoomNumber(value, fallback = 0, theme = this.currentTheme()) {
      return this.resolveThemeNumber(value, fallback);
    },

    scaleThemeRoomVector(values, fallback = [0, 0, 0], theme = this.currentTheme()) {
      const source = Array.isArray(values) ? values : fallback;
      return [
        this.resolveThemeNumber(source[0], fallback[0] ?? 0),
        this.resolveThemeNumber(source[1], fallback[1] ?? 0),
        this.resolveThemeNumber(source[2], fallback[2] ?? 0),
      ];
    },

    clearThemeObjects() {
      for (const object of this.themeObjects || []) {
        object.parent?.remove(object);
        object.traverse?.((child) => {
          child.geometry?.dispose?.();
          if (Array.isArray(child.material)) {
            child.material.forEach((material) => disposeThemeMaterial(material));
          } else {
            disposeThemeMaterial(child.material);
          }
        });
        object.geometry?.dispose?.();
        disposeThemeMaterial(object.material);
      }
      this.themeObjects = [];
      this.themeObjectById = new Map();
      this.themeInteractiveObjects = [];
      this.themeAnimatedObjects = [];
      this.themeSampledObjects = [];
      this.themeVideoSampleColors = null;
      this.themeMovableDrag = null;
      if (this.themeGroup) this.themeGroup.clear();
    },

    addThemeAsset(asset, revision = this.themeRevision) {
      if (!asset) return;
      if (asset.type === "image") {
        if (!asset.url) return;
        const texture = new THREE.TextureLoader().load(asset.url);
        texture.colorSpace = THREE.SRGBColorSpace;
        const additive = asset.blending === "additive" || asset.glow === true;
        const opacity = this.resolveThemeOpacity(asset, 1);
        const material = asset.lit === true && THREE.MeshStandardMaterial
          ? new THREE.MeshStandardMaterial({
              map: texture,
              color: this.resolveThemeColor(asset.color, "#ffffff"),
              roughness: clampNumber(this.resolveThemeNumber(asset.roughness, 0.65), 0, 1, 0.65),
              metalness: clampNumber(this.resolveThemeNumber(asset.metalness, 0.08), 0, 1, 0.08),
              transparent: opacity < 1,
              opacity: clampNumber(opacity, 0, 1, 1),
              side: THREE.DoubleSide,
              depthWrite: asset.depthWrite === false ? false : opacity >= 1,
              depthTest: asset.depthTest === false ? false : true,
            })
          : new THREE.MeshBasicMaterial({
              map: texture,
              transparent: additive || opacity < 1,
              opacity: clampNumber(opacity, 0, additive ? 3 : 1, 1),
              side: THREE.DoubleSide,
              depthWrite: additive ? false : asset.depthWrite !== false,
              depthTest: asset.depthTest === false ? false : true,
              blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
            });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
        mesh.renderOrder = Number(asset.renderOrder || 0);
        this.configureThemeObject(mesh, asset, revision);
        if (revision === this.themeRevision) {
          this.themeGroup.add(mesh);
          this.themeObjects.push(mesh);
        }
      } else if (asset.type === "obj") {
        if (!asset.url) return;
        fetch(asset.url)
          .then((response) => response.ok ? response.text() : "")
          .then((text) => {
            if (!text || !this.themeGroup || revision !== this.themeRevision) return;
            const geometry = parseObjGeometry(text);
            if (!geometry) return;
            const material = this.createThemeSurfaceMaterial(asset, "#94a3b8");
            const mesh = new THREE.Mesh(geometry, material);
            this.configureThemeObject(mesh, asset, revision);
            if (revision === this.themeRevision) {
              this.themeGroup.add(mesh);
              this.themeObjects.push(mesh);
            }
          })
          .catch(() => {});
      } else if (asset.type === "glb" || asset.type === "gltf") {
        this.loadThemeGlbAsset(asset, revision);
      } else if (asset.type === "light") {
        this.addThemeLight(asset, revision);
      } else if (asset.type === "empty") {
        const group = new THREE.Group();
        this.configureThemeObject(group, asset, revision);
        if (revision === this.themeRevision) {
          this.themeGroup.add(group);
          this.themeObjects.push(group);
        }
      } else if (asset.type === "circle" || asset.type === "disc" || asset.type === "disk" || asset.type === "ring") {
        const segments = Math.max(12, Math.min(128, Math.floor(this.resolveThemeNumber(asset.segments, 72))));
        const geometry = asset.type === "ring"
          ? new THREE.RingGeometry(
              Math.max(0, this.resolveThemeNumber(asset.innerRadius, 0.45)),
              Math.max(0.01, this.resolveThemeNumber(asset.outerRadius, this.resolveThemeNumber(asset.radius, 1))),
              segments,
            )
          : new THREE.CircleGeometry(this.resolveThemeNumber(asset.radius, 1), segments);
        const materialType = String(asset.material || "").toLowerCase();
        const useSurfaceMaterial = materialType === "glass" || (asset.material !== "basic" && (asset.lit === true || asset.roughness !== undefined || asset.metalness !== undefined || asset.emissive !== undefined));
        const material = useSurfaceMaterial && THREE.MeshStandardMaterial
          ? this.createThemeSurfaceMaterial(asset, "#334155")
          : new THREE.MeshBasicMaterial({
              color: this.resolveThemeColor(asset.color, "#334155"),
              transparent: this.resolveThemeOpacity(asset, 1) < 1,
              opacity: clampNumber(this.resolveThemeOpacity(asset, 1), 0, 1, 1),
              depthWrite: asset.depthWrite === false ? false : this.resolveThemeOpacity(asset, 1) >= 1,
              depthTest: asset.depthTest === false ? false : true,
              side: THREE.DoubleSide,
            });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = Number(asset.renderOrder || 0);
        this.configureThemeObject(mesh, asset, revision);
        if (revision === this.themeRevision) {
          this.themeGroup.add(mesh);
          this.themeObjects.push(mesh);
        }
      } else if (asset.type === "box") {
        const size = Array.isArray(asset.size) ? asset.size : [1, 1, 1];
        const geometry = new THREE.BoxGeometry(
          Number(size[0] ?? 1),
          Number(size[1] ?? 1),
          Number(size[2] ?? 1),
        );
        const materialType = String(asset.material || "").toLowerCase();
        const useSurfaceMaterial = materialType === "glass" || (asset.material !== "basic" && (asset.lit === true || asset.roughness !== undefined || asset.metalness !== undefined || asset.emissive !== undefined));
        const material = useSurfaceMaterial && THREE.MeshStandardMaterial
          ? this.createThemeSurfaceMaterial(asset, "#334155")
          : new THREE.MeshBasicMaterial({
              color: this.resolveThemeColor(asset.color, "#334155"),
              transparent: this.resolveThemeOpacity(asset, 1) < 1,
              opacity: clampNumber(this.resolveThemeOpacity(asset, 1), 0, 1, 1),
              depthWrite: asset.depthWrite === false ? false : this.resolveThemeOpacity(asset, 1) >= 1,
              depthTest: asset.depthTest === false ? false : true,
            });
        const mesh = new THREE.Mesh(geometry, material);
        this.configureThemeObject(mesh, asset, revision);
        if (revision === this.themeRevision) {
          this.themeGroup.add(mesh);
          this.themeObjects.push(mesh);
        }
      }
    },

    loadThemeGlbAsset(asset, revision = this.themeRevision) {
      if (!asset.url) return;
      fetch(asset.url)
        .then((response) => response.ok ? response.arrayBuffer() : null)
        .then((buffer) => {
          if (!buffer || !this.themeGroup || revision !== this.themeRevision) return;
          const embeddedTextureUrls = [];
          const object = parseThemeGlb(buffer, {
            createMaterial: (materialDef, context) => this.createThemeGlbMaterial(materialDef, asset, context),
            createTexture: (blob, textureDef, imageDef, samplerDef, srgb) => {
              const url = URL.createObjectURL(blob);
              embeddedTextureUrls.push(url);
              const texture = new THREE.TextureLoader().load(url);
              texture.flipY = false;
              texture.wrapS = gltfWrapMode(samplerDef?.wrapS);
              texture.wrapT = gltfWrapMode(samplerDef?.wrapT);
              texture.magFilter = gltfMagFilter(samplerDef?.magFilter);
              texture.minFilter = gltfMinFilter(samplerDef?.minFilter);
              if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
              if (this.renderer?.capabilities?.getMaxAnisotropy) {
                texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
              }
              texture.userData.themeObjectUrl = url;
              texture.userData.themeImageName = imageDef?.name || textureDef?.name || "";
              return texture;
            },
            excludeNodes: asset.excludeNodes,
            excludeNodePrefixes: asset.excludeNodePrefixes,
          });
          if (!object) return;
          object.userData.themeEmbeddedTextureUrls = embeddedTextureUrls;
          this.configureThemeObject(object, asset, revision);
          this.applyThemeGlbNodeAdjustments(object, asset);
          if (asset.renderOrder !== undefined) {
            object.traverse((child) => {
              child.renderOrder = Number(asset.renderOrder) || 0;
            });
          }
          if (revision === this.themeRevision) {
            this.themeGroup.add(object);
            this.themeObjects.push(object);
          }
        })
        .catch(() => {});
    },

    applyThemeGlbNodeAdjustments(object, asset = {}) {
      const adjustments = Array.isArray(asset.nodeAdjustments) ? asset.nodeAdjustments : [];
      if (!object || !adjustments.length) return;
      object.updateMatrixWorld(true);
      const allObjects = [];
      object.traverse((child) => allObjects.push(child));
      for (const adjustment of adjustments) {
        if (!isPlainObject(adjustment)) continue;
        const names = [
          adjustment.name,
          adjustment.node,
          ...(Array.isArray(adjustment.names) ? adjustment.names : []),
          ...(Array.isArray(adjustment.nodes) ? adjustment.nodes : []),
        ].map((name) => normalizeGlbNodeName(name)).filter(Boolean);
        if (!names.length) continue;
        const nameSet = new Set(names);
        const targets = allObjects.filter((child) => {
          if (!nameSet.has(normalizeGlbNodeName(child.name))) return false;
          let parent = child.parent;
          while (parent && parent !== object) {
            if (nameSet.has(normalizeGlbNodeName(parent.name))) return false;
            parent = parent.parent;
          }
          return true;
        });
        for (const target of targets) {
          if (Array.isArray(adjustment.positionOffset)) {
            const offset = new THREE.Vector3(...this.scaleThemeRoomVector(adjustment.positionOffset, [0, 0, 0]));
            const worldPosition = target.getWorldPosition(new THREE.Vector3()).add(offset);
            target.parent?.worldToLocal(worldPosition);
            target.position.copy(worldPosition);
          }
        }
      }
      object.updateMatrixWorld(true);
    },

    createThemeSurfaceMaterial(asset, fallbackColor) {
      const opacity = clampNumber(this.resolveThemeOpacity(asset, 1), 0, 1, 1);
      const color = this.resolveThemeColor(asset.color, fallbackColor);
      const materialType = String(asset.material || "").toLowerCase();
      if (asset.material === "basic" || !THREE.MeshStandardMaterial) {
        return new THREE.MeshBasicMaterial({
          color,
          wireframe: Boolean(asset.wireframe),
          transparent: opacity < 1,
          opacity,
        });
      }
      if (materialType === "glass") {
        const glassOpacity = clampNumber(this.resolveThemeOpacity(asset, 0.32), 0, 1, 0.32);
        const glassConfig = {
          color,
          roughness: clampNumber(this.resolveThemeNumber(asset.roughness, 0.04), 0, 1, 0.04),
          metalness: clampNumber(this.resolveThemeNumber(asset.metalness, 0), 0, 1, 0),
          emissive: this.resolveThemeColor(asset.emissive, "#000000"),
          emissiveIntensity: clampNumber(this.resolveThemeNumber(asset.emissiveIntensity, 0), 0, 8, 0),
          wireframe: Boolean(asset.wireframe),
          transparent: true,
          opacity: glassOpacity,
          depthWrite: asset.depthWrite === true,
          depthTest: asset.depthTest === false ? false : true,
          side: THREE.DoubleSide,
        };
        if (THREE.MeshPhysicalMaterial) {
          return new THREE.MeshPhysicalMaterial({
            ...glassConfig,
            transmission: clampNumber(this.resolveThemeNumber(asset.transmission, 0.62), 0, 1, 0.62),
            thickness: clampNumber(this.resolveThemeNumber(asset.thickness, 0.08), 0, 5, 0.08),
            ior: clampNumber(this.resolveThemeNumber(asset.ior, 1.45), 1, 2.333, 1.45),
            clearcoat: clampNumber(this.resolveThemeNumber(asset.clearcoat, 0.85), 0, 1, 0.85),
            clearcoatRoughness: clampNumber(this.resolveThemeNumber(asset.clearcoatRoughness, 0.08), 0, 1, 0.08),
            attenuationColor: this.resolveThemeColor(asset.attenuationColor, asset.color || fallbackColor),
            attenuationDistance: clampNumber(this.resolveThemeNumber(asset.attenuationDistance, 2.6), 0.01, 1000, 2.6),
          });
        }
        return new THREE.MeshStandardMaterial(glassConfig);
      }
      return new THREE.MeshStandardMaterial({
        color,
        roughness: clampNumber(this.resolveThemeNumber(asset.roughness, 0.82), 0, 1, 0.82),
        metalness: clampNumber(this.resolveThemeNumber(asset.metalness, 0.18), 0, 1, 0.18),
        emissive: this.resolveThemeColor(asset.emissive, "#000000"),
        emissiveIntensity: clampNumber(this.resolveThemeNumber(asset.emissiveIntensity, 0), 0, 8, 0),
        wireframe: Boolean(asset.wireframe),
        transparent: opacity < 1,
        opacity,
      });
    },

    createThemeGlbMaterial(materialDef = {}, asset = {}, context = {}) {
      const pbr = isPlainObject(materialDef.pbrMetallicRoughness) ? materialDef.pbrMetallicRoughness : {};
      const baseColor = Array.isArray(pbr.baseColorFactor) ? pbr.baseColorFactor : [0.8, 0.8, 0.8, 1];
      const materialName = String(materialDef.name || "");
      const textureConfig = glbMaterialTextureConfig(asset, materialName);
      const materialOverride = glbMaterialOverrideConfig(asset, materialName);
      const preferEmbeddedTextures = asset.preferEmbeddedTextures === true;
      const metallicRoughnessMap = pbr.metallicRoughnessTexture?.index !== undefined
        ? context.textureForInfo?.(pbr.metallicRoughnessTexture, false)
        : null;
      const embeddedMap = context.textureForInfo?.(pbr.baseColorTexture, true) || null;
      const embeddedNormalMap = context.textureForInfo?.(materialDef.normalTexture, false) || null;
      const mappedMap = textureConfig?.map ? this.loadThemeTexture(asset, textureConfig.map, true) : null;
      const mappedNormalMap = textureConfig?.normalMap ? this.loadThemeTexture(asset, textureConfig.normalMap, false) : null;
      const mappedRoughnessMap = textureConfig?.roughnessMap ? this.loadThemeTexture(asset, textureConfig.roughnessMap, false) : null;
      const mappedMetalnessMap = textureConfig?.metalnessMap ? this.loadThemeTexture(asset, textureConfig.metalnessMap, false) : null;
      const map = preferEmbeddedTextures ? (embeddedMap || mappedMap) : (mappedMap || embeddedMap);
      const normalMap = preferEmbeddedTextures ? (embeddedNormalMap || mappedNormalMap) : (mappedNormalMap || embeddedNormalMap);
      const roughnessMap = preferEmbeddedTextures ? (metallicRoughnessMap || mappedRoughnessMap) : (mappedRoughnessMap || metallicRoughnessMap);
      const metalnessMap = preferEmbeddedTextures ? (metallicRoughnessMap || mappedMetalnessMap) : (mappedMetalnessMap || metallicRoughnessMap);
      const emissiveMap = context.textureForInfo?.(materialDef.emissiveTexture, true) || null;
      const alpha = clampNumber(Number(baseColor[3] ?? 1), 0, 1, 1);
      const glass = /glass/i.test(materialName);
      const display = /498006|deridex|directional|entlcar|lcars|lf|longcars|ops|plaque|tac|tomalok|untitled|yel/i.test(materialName);
      const color = materialOverride?.color
        ? this.resolveThemeColor(materialOverride.color, "#cccccc")
        : new THREE.Color(
        clampNumber(Number(baseColor[0] ?? 0.8), 0, 1, 0.8),
        clampNumber(Number(baseColor[1] ?? 0.8), 0, 1, 0.8),
        clampNumber(Number(baseColor[2] ?? 0.8), 0, 1, 0.8),
      );
      const emissiveFactor = Array.isArray(materialDef.emissiveFactor) ? materialDef.emissiveFactor : [0, 0, 0];
      const emissiveColor = display
        ? color
        : new THREE.Color(
            clampNumber(Number(emissiveFactor[0] || 0), 0, 1, 0),
            clampNumber(Number(emissiveFactor[1] || 0), 0, 1, 0),
            clampNumber(Number(emissiveFactor[2] || 0), 0, 1, 0),
          );
      const materialEmissiveColor = materialOverride?.emissive
        ? this.resolveThemeColor(materialOverride.emissive, "#000000")
        : emissiveColor;
      const opacity = glass
        ? clampNumber(this.resolveThemeNumber(materialOverride?.opacity, this.resolveThemeNumber(asset.glassOpacity, 0.3)), 0, 1, 0.3)
        : clampNumber(this.resolveThemeNumber(materialOverride?.opacity, alpha), 0, 1, alpha);
      const common = {
        color,
        map,
        normalMap,
        roughnessMap,
        metalnessMap,
        transparent: opacity < 1 || materialDef.alphaMode === "BLEND",
        opacity,
        depthWrite: opacity >= 1 && materialDef.alphaMode !== "BLEND",
        side: THREE.DoubleSide,
      };
      if (glass && THREE.MeshPhysicalMaterial) {
        return new THREE.MeshPhysicalMaterial({
          ...common,
          roughness: clampNumber(this.resolveThemeNumber(materialOverride?.roughness, 0.08), 0, 1, 0.08),
          metalness: clampNumber(this.resolveThemeNumber(materialOverride?.metalness, 0), 0, 1, 0),
          emissive: this.resolveThemeColor(materialOverride?.emissive, "#000000"),
          emissiveIntensity: clampNumber(
            this.resolveThemeNumber(materialOverride?.emissiveIntensity, 0)
              * this.resolveThemeNumber(materialOverride?.emissiveIntensityMultiplier, 1),
            0,
            2.5,
            0,
          ),
          transmission: clampNumber(this.resolveThemeNumber(materialOverride?.transmission, 0.48), 0, 1, 0.48),
          thickness: clampNumber(this.resolveThemeNumber(materialOverride?.thickness, 0.08), 0, 5, 0.08),
          clearcoat: clampNumber(this.resolveThemeNumber(materialOverride?.clearcoat, 0.8), 0, 1, 0.8),
          clearcoatRoughness: clampNumber(this.resolveThemeNumber(materialOverride?.clearcoatRoughness, 0.1), 0, 1, 0.1),
        });
      }
      return new THREE.MeshStandardMaterial({
        ...common,
        roughness: clampNumber(this.resolveThemeNumber(materialOverride?.roughness, Number(pbr.roughnessFactor ?? (display ? 0.42 : 0.78))), 0, 1, display ? 0.42 : 0.78),
        metalness: clampNumber(this.resolveThemeNumber(materialOverride?.metalness, Number(pbr.metallicFactor ?? 0)), 0, 1, 0),
        emissive: materialEmissiveColor,
        emissiveMap: display ? (emissiveMap || map) : emissiveMap,
        emissiveIntensity: display || emissiveMap || materialOverride?.emissiveIntensity !== undefined
          ? clampNumber(
              this.resolveThemeNumber(materialOverride?.emissiveIntensity, this.resolveThemeNumber(asset.displayEmissiveIntensity, 0.32))
                * this.resolveThemeNumber(materialOverride?.emissiveIntensityMultiplier, 1),
              0,
              2.5,
              0.32,
            )
          : 0,
      });
    },

    loadThemeTexture(asset, texturePath, srgb = true) {
      const texture = new THREE.TextureLoader().load(resolveRelativeAssetUrl(asset.url, texturePath));
      texture.flipY = false;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
      if (this.renderer?.capabilities?.getMaxAnisotropy) {
        texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      }
      return texture;
    },

    addThemeLight(light, revision = this.themeRevision) {
      if (!isPlainObject(light)) return;
      const type = String(light.type || "point").toLowerCase();
      const color = this.resolveThemeColor(light.color, "#ffffff");
      const intensity = this.resolveThemeNumber(light.intensitySetting ? `$${light.intensitySetting}` : light.intensity, 1)
        * this.resolveThemeNumber(light.intensityMultiplier, 1);
      let object = null;
      if (type === "ambient") {
        object = new THREE.AmbientLight(color, intensity);
      } else if (type === "directional") {
        object = new THREE.DirectionalLight(color, intensity);
      } else if (type === "spot") {
        object = new THREE.SpotLight(
          color,
          intensity,
          this.scaleThemeRoomNumber(light.distance, 0),
          THREE.MathUtils.degToRad(this.resolveThemeNumber(light.angle, 35)),
          clampNumber(this.resolveThemeNumber(light.penumbra, 0.35), 0, 1, 0.35),
        );
      } else if (type === "hemisphere") {
        object = new THREE.HemisphereLight(
          color,
          this.resolveThemeColor(light.groundColor, "#0f172a"),
          intensity,
        );
      } else {
        object = new THREE.PointLight(
          color,
          intensity,
          this.scaleThemeRoomNumber(light.distance, 0),
          this.resolveThemeNumber(light.decay, 2),
        );
      }
      if (light.castShadow === true && object.castShadow !== undefined) {
        object.castShadow = true;
        if (object.shadow) {
          const mapSize = clampNumber(this.resolveThemeNumber(light.shadowMapSize, 1024), 256, 4096, 1024);
          object.shadow.mapSize.set(mapSize, mapSize);
          object.shadow.bias = this.resolveThemeNumber(light.shadowBias, -0.0002);
          object.shadow.normalBias = this.resolveThemeNumber(light.shadowNormalBias, 0.02);
          if (object.shadow.camera) {
            object.shadow.camera.near = this.resolveThemeNumber(light.shadowNear, 0.1);
            object.shadow.camera.far = this.scaleThemeRoomNumber(light.shadowFar, 12);
            if (object.isDirectionalLight) {
              const size = this.scaleThemeRoomNumber(light.shadowCameraSize, 5);
              object.shadow.camera.left = -size;
              object.shadow.camera.right = size;
              object.shadow.camera.top = size;
              object.shadow.camera.bottom = -size;
            }
            object.shadow.camera.updateProjectionMatrix?.();
          }
        }
      }
      this.configureThemeObject(object, light, revision);
      if (Array.isArray(light.target) && object.target) {
        object.target.position.set(...this.scaleThemeRoomVector(light.target, [0, 0, -1]));
        this.themeGroup.add(object.target);
        this.themeObjects.push(object.target);
      }
      if (revision === this.themeRevision) {
        this.themeGroup.add(object);
        this.themeObjects.push(object);
      }
    },

    configureThemeObject(object, config, revision) {
      this.applyThemeTransform(object, config);
      if (config.renderOrder !== undefined) object.renderOrder = Number(config.renderOrder) || 0;
      object.visible = this.resolveThemeBoolean(config.visibleSetting ? `$${config.visibleSetting}` : config.visible, true);
      object.userData.themeConfig = config;
      object.userData.themeRevision = revision;
      object.userData.themeBasePosition = object.position.clone();
      object.userData.themeBaseRotation = object.rotation.clone();
      object.userData.themeBaseScale = object.scale.clone();
      object.userData.themeBaseIntensity = Number(object.intensity ?? 0);
      if (object.color?.clone) object.userData.themeBaseColor = object.color.clone();
      object.userData.themeBaseOpacity = Array.isArray(object.material)
        ? Number(object.material[0]?.opacity ?? 1)
        : Number(object.material?.opacity ?? 1);
      const castShadow = config.castShadow === true;
      const receiveShadow = config.receiveShadow === true;
      if (castShadow || receiveShadow) {
        object.traverse?.((child) => {
          if (child.isMesh) {
            if (castShadow) child.castShadow = true;
            if (receiveShadow) child.receiveShadow = true;
          }
        });
        if (object.isMesh) {
          if (castShadow) object.castShadow = true;
          if (receiveShadow) object.receiveShadow = true;
        }
      }
      if (config.id) {
        this.themeObjectById.set(String(config.id), object);
      }
      if (config.interaction || config.movable) {
        object.userData.themeInteractive = true;
        this.themeInteractiveObjects.push(object);
      }
      if (config.animation) {
        this.themeAnimatedObjects.push(object);
      }
      if (config.videoSample) {
        this.themeSampledObjects.push(object);
      }
    },

    applyThemeTransform(object, asset) {
      const position = Array.isArray(asset.position) ? asset.position : [0, 0, -4];
      const scale = Array.isArray(asset.scale) ? asset.scale : [1, 1, 1];
      const rotation = Array.isArray(asset.rotation) ? asset.rotation : [0, 0, 0];
      const state = asset.id ? this.themeObjectState(asset.id) : null;
      const finalPosition = Array.isArray(state?.position) ? state.position : position;
      object.position.set(...this.scaleThemeRoomVector(finalPosition, [0, 0, -4]));
      object.scale.set(
        this.resolveThemeNumber(scale[0], 1),
        this.resolveThemeNumber(scale[1], scale[0] ?? 1),
        this.resolveThemeNumber(scale[2], 1),
      );
      object.rotation.set(
        THREE.MathUtils.degToRad(this.resolveThemeNumber(rotation[0], 0)),
        THREE.MathUtils.degToRad(this.resolveThemeNumber(rotation[1], 0)),
        THREE.MathUtils.degToRad(this.resolveThemeNumber(rotation[2], 0)),
      );
    },

    resolveThemeValue(value, fallback = null) {
      if (typeof value === "string" && value.startsWith("$")) {
        return this.themeSettingValue(value.slice(1), fallback);
      }
      if (value === undefined || value === null || value === "") return fallback;
      return value;
    },

    resolveThemeNumber(value, fallback = 0) {
      const resolved = this.resolveThemeValue(value, fallback);
      return clampNumber(Number(resolved), -100000, 100000, fallback);
    },

    resolveThemeBoolean(value, fallback = true) {
      const resolved = this.resolveThemeValue(value, fallback);
      if (typeof resolved === "boolean") return resolved;
      if (typeof resolved === "string") return !["false", "0", "off", "no"].includes(resolved.toLowerCase());
      return Boolean(resolved);
    },

    resolveThemeOpacity(config, fallback = 1) {
      const base = config.opacitySetting ? this.themeSettingValue(config.opacitySetting, fallback) : this.resolveThemeValue(config.opacity, fallback);
      return this.resolveThemeNumber(Number(base) * this.resolveThemeNumber(config.opacityMultiplier, 1), fallback);
    },

    resolveThemeColor(value, fallback) {
      return colorFromTheme(this.resolveThemeValue(value, fallback), new THREE.Color(fallback));
    },

    themeObjectState(id) {
      const themeId = this.currentTheme().id;
      const allStates = isPlainObject(this.settings.themeObjectStates) ? this.settings.themeObjectStates : {};
      const themeStates = isPlainObject(allStates[themeId]) ? allStates[themeId] : {};
      return isPlainObject(themeStates[id]) ? themeStates[id] : null;
    },

    setThemeObjectState(id, state) {
      const themeId = this.currentTheme().id;
      if (!isPlainObject(this.settings.themeObjectStates)) this.settings.themeObjectStates = {};
      if (!isPlainObject(this.settings.themeObjectStates[themeId])) this.settings.themeObjectStates[themeId] = {};
      this.settings.themeObjectStates[themeId][id] = state;
      this.saveSettings();
    },

    updateThemeAnimations(elapsedSeconds) {
      for (const object of this.themeAnimatedObjects) {
        const config = object.userData.themeConfig || {};
        const animation = isPlainObject(config.animation) ? config.animation : { type: config.animation };
        const type = String(animation.type || "pulse");
        const speed = this.resolveThemeNumber(animation.speed, 1);
        const phase = this.resolveThemeNumber(animation.phase, 0);
        const wave = Math.sin(elapsedSeconds * speed * Math.PI * 2 + phase);
        if (type === "rotate") {
          const axis = String(animation.axis || "y").toLowerCase();
          const amount = THREE.MathUtils.degToRad(this.resolveThemeNumber(animation.amount, 35) * elapsedSeconds * speed);
          object.rotation.copy(object.userData.themeBaseRotation);
          if (axis.includes("x")) object.rotation.x += amount;
          if (axis.includes("y")) object.rotation.y += amount;
          if (axis.includes("z")) object.rotation.z += amount;
        } else if (type === "bob" || type === "sway") {
          const amplitude = this.resolveThemeNumber(animation.amplitude, 0.05);
          const axis = String(animation.axis || "y").toLowerCase();
          object.position.copy(object.userData.themeBasePosition);
          if (axis.includes("x")) object.position.x += wave * amplitude;
          if (axis.includes("y")) object.position.y += wave * amplitude;
          if (axis.includes("z")) object.position.z += wave * amplitude;
        } else {
          const amplitude = this.resolveThemeNumber(animation.amplitude, 0.25);
          const factor = 1 + wave * amplitude;
          if (typeof object.intensity === "number") {
            object.intensity = Math.max(0, object.userData.themeBaseIntensity * factor);
          }
          const opacity = clampNumber(object.userData.themeBaseOpacity * factor, 0, config.glow ? 3 : 1, object.userData.themeBaseOpacity);
          setObjectOpacity(object, opacity);
        }
      }
    },

    themeWantsVideoSampling() {
      const theme = this.currentTheme();
      return Boolean(theme.videoSampling || this.themeSampledObjects.length);
    },

    updateThemeVideoSampling() {
      if (!this.themeWantsVideoSampling() || !this.backlightSegments?.length) return;
      const now = performance.now();
      const interval = this.xrSession ? 250 : 100;
      if (this.themeVideoSampleColors && now - Number(this.lastThemeVideoSamplingAt || 0) < interval) return;
      this.lastThemeVideoSamplingAt = now;
      const colors = this.sampleVideoEdgeColors();
      this.themeVideoSampleColors = colors;
      for (const object of this.themeSampledObjects) {
        this.applyThemeVideoSample(object, colors);
      }
    },

    applyThemeVideoSample(object, colors) {
      const config = object?.userData?.themeConfig || {};
      const sample = themeVideoSampleColor(colors, config.videoSample) || offBacklightColor();
      const sampleVisible = isVisibleBacklightColor(sample);
      const color = sampleVisible ? new THREE.Color(sample.r, sample.g, sample.b) : null;
      const multiplier = clampNumber(this.resolveThemeNumber(config.videoSampleMultiplier, 1), 0, 20, 1);
      const sampleLevel = sampleVisible ? clampNumber(Number(sample.opacity || 0) * multiplier, 0, 4, 0) : 0;
      if (object.isLight && object.color) {
        object.color.copy(color || object.userData.themeBaseColor || object.color);
        const minIntensity = clampNumber(this.resolveThemeNumber(config.videoSampleMinIntensity, 0), 0, 20, 0);
        const maxIntensity = clampNumber(this.resolveThemeNumber(config.videoSampleMaxIntensity, object.userData.themeBaseIntensity * 2.2 || 2), 0, 50, 2);
        object.intensity = clampNumber(object.userData.themeBaseIntensity * sampleLevel, minIntensity, maxIntensity, object.userData.themeBaseIntensity);
        return;
      }
      const target = String(config.videoSampleTarget || "emissive").toLowerCase();
      for (const material of objectMaterials(object)) {
        if (!material) continue;
        if (!material.userData.themeBaseColor && material.color) material.userData.themeBaseColor = material.color.clone();
        if (!material.userData.themeBaseEmissive && material.emissive) material.userData.themeBaseEmissive = material.emissive.clone();
        if (material.userData.themeBaseEmissiveIntensity === undefined) {
          material.userData.themeBaseEmissiveIntensity = Number(material.emissiveIntensity || 0);
        }
        if (target === "color" || target === "both") {
          material.color?.copy(color || material.userData.themeBaseColor || material.color);
        }
        if ((target === "emissive" || target === "both") && material.emissive) {
          material.emissive.copy(color || material.userData.themeBaseEmissive || material.emissive);
          const base = Number(material.userData.themeBaseEmissiveIntensity || 0);
          const min = clampNumber(this.resolveThemeNumber(config.videoSampleMinIntensity, base), 0, 20, base);
          const max = clampNumber(this.resolveThemeNumber(config.videoSampleMaxIntensity, base + 2.5), 0, 50, base + 2.5);
          material.emissiveIntensity = clampNumber(base + sampleLevel, min, max, base);
        }
        if (config.videoSampleOpacity) {
          if (material.userData.themeBaseOpacity === undefined) material.userData.themeBaseOpacity = Number(material.opacity ?? 1);
          material.opacity = clampNumber(material.userData.themeBaseOpacity * sampleLevel, 0, 1, material.userData.themeBaseOpacity);
          material.transparent = material.transparent || material.opacity < 1;
        }
      }
    }
  });
})();
