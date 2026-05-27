(() => {
  const XR = window.FilePipeXr = window.FilePipeXr || {};
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
  } = XR;
  function isKnownLayout(value) {
    return ["mono", "half-sbs", "full-sbs"].includes(value);
  }

  function isKnownBacklightMode(value) {
    return ["off", "soft", "dynamic", "video"].includes(value);
  }

  function isLocalDepthProcessor(value) {
    const processor = String(value || "").trim().toLowerCase();
    if (!processor) return false;
    if (window.FilePipeLocalDepth3dAdapter?.isLocalProcessor) {
      return window.FilePipeLocalDepth3dAdapter.isLocalProcessor(processor);
    }
    return [
      "midas-small-onnx",
      "fastdepth-mobilenet-onnx",
      "depth-anything-v2-tiny-onnx",
      "depth-anything-v2-small-onnx",
      "depth-pro-onnx",
      "webgpu-depth-anything-v2-small",
    ].includes(processor);
  }

  function normalizeLocalDepthSettings(settings = {}) {
    return {
      depthStrength: clampNumber(Number(settings.depthStrength), 0, 2, 0.72),
      temporalSmoothing: clampNumber(Number(settings.temporalSmoothing), 0, 0.92, 0.55),
      inferenceIntervalMs: clampNumber(Number(settings.inferenceIntervalMs), 80, 1000, 180),
      inferenceScale: clampNumber(Number(settings.inferenceScale), 0.1, 1, 0.33),
      minInferenceWidth: clampNumber(Number(settings.minInferenceWidth), 64, 2048, 384),
      minInferenceHeight: clampNumber(Number(settings.minInferenceHeight), 64, 2048, 216),
      inputSize: clampNumber(Number(settings.inputSize), 128, 512, 256),
    };
  }

  function normalizeSpeakerChannel(value) {
    const channel = String(value || "").trim().toUpperCase().replace(/[\s_-]+/g, "");
    const aliases = {
      LEFT: "L",
      RIGHT: "R",
      CENTER: "C",
      CENTRE: "C",
      SUB: "LFE",
      SUBWOOFER: "LFE",
      LOWFREQUENCY: "LFE",
      LS: "SL",
      RS: "SR",
      LEFTSURROUND: "SL",
      RIGHTSURROUND: "SR",
      SURROUNDLEFT: "SL",
      SURROUNDRIGHT: "SR",
      LEFTSIDE: "SL",
      RIGHTSIDE: "SR",
      LEFTBACK: "BL",
      RIGHTBACK: "BR",
      BACKLEFT: "BL",
      BACKRIGHT: "BR",
      BACKCENTER: "BC",
      CENTERSURROUND: "BC",
    };
    return aliases[channel] || channel || "";
  }

  function defaultSpeakerDefinition(channel, index, settings) {
    const panelWidth = clampNumber(Number(settings.panelWidth), 1.4, 6, DEFAULT_SETTINGS.panelWidth);
    const distance = clampNumber(Number(settings.distance), 1.4, 6, DEFAULT_SETTINGS.distance);
    const sideX = Math.max(1.15, panelWidth * 0.48);
    const rearX = Math.max(1.45, panelWidth * 0.58);
    const rearZ = distance + 0.7;
    const backZ = distance + 1.45;
    const definitions = {
      L: { position: [-sideX, 0.02, 0.08] },
      R: { position: [sideX, 0.02, 0.08] },
      C: { position: [0, 0.02, 0.04] },
      LFE: { position: [0, -0.85, 0.55], lfe: true, gain: 0.8 },
      SL: { position: [-rearX, 0.02, rearZ] },
      SR: { position: [rearX, 0.02, rearZ] },
      BL: { position: [-rearX, 0.02, backZ] },
      BR: { position: [rearX, 0.02, backZ] },
      BC: { position: [0, 0.02, backZ] },
      FLC: { position: [-sideX * 0.55, 0.18, 0.02] },
      FRC: { position: [sideX * 0.55, 0.18, 0.02] },
    };
    const fallbackAngle = index === 0 ? -30 : index === 1 ? 30 : 0;
    return {
      channel,
      relativeTo: "screen",
      gain: 1,
      refDistance: 1.2,
      rolloffFactor: 0.6,
      ...(definitions[channel] || {
        relativeTo: "listener",
        angle: fallbackAngle,
        distance: 2.2,
        height: 0,
      }),
    };
  }

  function speakerVectorFromDefinition(speaker) {
    if (Array.isArray(speaker.position)) {
      return new THREE.Vector3(
        Number(speaker.position[0] || 0),
        Number(speaker.position[1] || 0),
        Number(speaker.position[2] || 0),
      );
    }
    const angle = Number(speaker.angle ?? speaker.azimuth);
    const radius = clampNumber(Number(speaker.distance ?? speaker.radius), 0.1, 20, 2.2);
    const height = clampNumber(Number(speaker.height ?? speaker.y), -5, 5, 0);
    if (Number.isFinite(angle)) {
      const radians = THREE.MathUtils.degToRad(angle);
      return new THREE.Vector3(Math.sin(radians) * radius, height, -Math.cos(radians) * radius);
    }
    return new THREE.Vector3(0, height, -radius);
  }

  function safeDisconnect(node) {
    try {
      node?.disconnect?.();
    } catch (error) {
      // Already disconnected.
    }
  }

  function setAudioParamValue(param, value, context) {
    if (!param) return;
    const now = context?.currentTime || 0;
    const when = now + 0.015;
    if (typeof param.linearRampToValueAtTime === "function") {
      param.cancelScheduledValues?.(now);
      param.linearRampToValueAtTime(value, when);
    } else {
      param.value = value;
    }
  }

  function setPannerPosition(panner, position, context) {
    setAudioParamValue(panner.positionX, position.x, context);
    setAudioParamValue(panner.positionY, position.y, context);
    setAudioParamValue(panner.positionZ, position.z, context);
    if (!panner.positionX && typeof panner.setPosition === "function") {
      panner.setPosition(position.x, position.y, position.z);
    }
  }

  function setListenerPosition(listener, position, context) {
    setAudioParamValue(listener.positionX, position.x, context);
    setAudioParamValue(listener.positionY, position.y, context);
    setAudioParamValue(listener.positionZ, position.z, context);
    if (!listener.positionX && typeof listener.setPosition === "function") {
      listener.setPosition(position.x, position.y, position.z);
    }
  }

  function setListenerOrientation(listener, forward, up, context) {
    setAudioParamValue(listener.forwardX, forward.x, context);
    setAudioParamValue(listener.forwardY, forward.y, context);
    setAudioParamValue(listener.forwardZ, forward.z, context);
    setAudioParamValue(listener.upX, up.x, context);
    setAudioParamValue(listener.upY, up.y, context);
    setAudioParamValue(listener.upZ, up.z, context);
    if (!listener.forwardX && typeof listener.setOrientation === "function") {
      listener.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  function clampNumber(value, min, max, fallback) {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  }

  function isPlainObject(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  function mediaInfoVideoAspectRatio(mediaInfo) {
    const streams = Array.isArray(mediaInfo?.videoStreams) ? mediaInfo.videoStreams : [];
    const candidates = [mediaInfo?.defaultVideo, ...streams];
    for (const candidate of candidates) {
      const width = Number(candidate?.width || 0);
      const height = Number(candidate?.height || 0);
      if (width > 0 && height > 0) return Math.max(0.1, width / height);
    }
    return 0;
  }

  function glbMaterialTextureConfig(asset, materialName) {
    const textureMap = isPlainObject(asset?.textureMap) ? asset.textureMap : {};
    if (!materialName) return null;
    if (textureMap[materialName]) return normalizeTextureConfig(textureMap[materialName]);
    const normalized = normalizeGlbMaterialName(materialName);
    if (textureMap[normalized]) return normalizeTextureConfig(textureMap[normalized]);
    for (const [key, value] of Object.entries(textureMap)) {
      if (normalizeGlbMaterialName(key) === normalized) return normalizeTextureConfig(value);
    }
    const withoutNumericSuffix = normalized.replace(/\.\d+$/, "");
    if (withoutNumericSuffix !== normalized) {
      for (const [key, value] of Object.entries(textureMap)) {
        if (normalizeGlbMaterialName(key).replace(/\.\d+$/, "") === withoutNumericSuffix) {
          return normalizeTextureConfig(value);
        }
      }
    }
    return null;
  }

  function glbMaterialOverrideConfig(asset, materialName) {
    const materialMap = isPlainObject(asset?.materialMap) ? asset.materialMap : {};
    if (!materialName) return null;
    if (materialMap[materialName]) return materialMap[materialName];
    const normalized = normalizeGlbMaterialName(materialName);
    if (materialMap[normalized]) return materialMap[normalized];
    for (const [key, value] of Object.entries(materialMap)) {
      if (normalizeGlbMaterialName(key) === normalized) return value;
    }
    const withoutNumericSuffix = normalized.replace(/\.\d+$/, "");
    if (withoutNumericSuffix !== normalized) {
      for (const [key, value] of Object.entries(materialMap)) {
        if (normalizeGlbMaterialName(key).replace(/\.\d+$/, "") === withoutNumericSuffix) return value;
      }
    }
    return null;
  }

  function normalizeTextureConfig(value) {
    if (typeof value === "string") return { map: value };
    return isPlainObject(value) ? value : null;
  }

  function normalizeGlbMaterialName(value) {
    return String(value || "").trim().toLowerCase().replace(/[_\s-]+/g, " ");
  }

  function normalizeGlbNodeName(value) {
    return String(value || "").trim().toLowerCase();
  }

  function resolveRelativeAssetUrl(baseUrl, path) {
    try {
      return new URL(String(path || ""), new URL(baseUrl || "", window.location.href)).href;
    } catch (error) {
      return String(path || "");
    }
  }

  function disposeThemeTexture(texture) {
    if (!texture) return;
    const objectUrl = texture.userData?.themeObjectUrl;
    texture.dispose?.();
    if (objectUrl && typeof URL !== "undefined" && URL.revokeObjectURL) URL.revokeObjectURL(objectUrl);
  }

  function disposeThemeMaterial(material) {
    if (!material) return;
    const materials = Array.isArray(material) ? material : [material];
    const textureKeys = ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap", "alphaMap", "bumpMap"];
    for (const item of materials) {
      for (const key of textureKeys) disposeThemeTexture(item?.[key]);
      item?.dispose?.();
    }
  }

  function gltfWrapMode(value) {
    if (value === 33071) return THREE.ClampToEdgeWrapping;
    if (value === 33648) return THREE.MirroredRepeatWrapping;
    return THREE.RepeatWrapping;
  }

  function gltfMagFilter(value) {
    if (value === 9728) return THREE.NearestFilter;
    return THREE.LinearFilter;
  }

  function gltfMinFilter(value) {
    if (value === 9728) return THREE.NearestFilter;
    if (value === 9729) return THREE.LinearFilter;
    if (value === 9984) return THREE.NearestMipmapNearestFilter;
    if (value === 9985) return THREE.LinearMipmapNearestFilter;
    if (value === 9986) return THREE.NearestMipmapLinearFilter;
    return THREE.LinearMipmapLinearFilter;
  }

  function parseThemeGlb(buffer, options = {}) {
    if (!window.THREE || !(buffer instanceof ArrayBuffer)) return null;
    const view = new DataView(buffer);
    if (view.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) return null;
    const length = view.getUint32(8, true);
    let offset = 12;
    let json = null;
    let binaryChunk = null;
    while (offset + 8 <= length) {
      const chunkLength = view.getUint32(offset, true);
      const chunkType = view.getUint32(offset + 4, true);
      offset += 8;
      if (offset + chunkLength > view.byteLength) break;
      if (chunkType === 0x4e4f534a) {
        json = JSON.parse(new TextDecoder("utf-8").decode(new Uint8Array(buffer, offset, chunkLength)));
      } else if (chunkType === 0x004e4942) {
        binaryChunk = buffer.slice(offset, offset + chunkLength);
      }
      offset += chunkLength;
    }
    if (!json || !binaryChunk) return null;
    const buffers = [binaryChunk];
    const textureCache = new Map();
    const textureForInfo = (textureInfo, srgb = true) => {
      const index = textureInfo?.index;
      if (index === undefined || index === null) return null;
      const transformKey = JSON.stringify(textureInfo.extensions?.KHR_texture_transform || null);
      const cacheKey = `${index}:${srgb ? "srgb" : "linear"}:${transformKey}`;
      if (textureCache.has(cacheKey)) return textureCache.get(cacheKey);
      const texture = buildThemeGlbTexture(json, buffers, Number(index), options, srgb);
      applyGltfTextureTransform(texture, textureInfo);
      textureCache.set(cacheKey, texture);
      return texture;
    };
    const excludeNodeNames = new Set(
      (Array.isArray(options.excludeNodes) ? options.excludeNodes : [])
        .map((name) => normalizeGlbNodeName(name))
        .filter(Boolean),
    );
    const excludeNodePrefixes = (Array.isArray(options.excludeNodePrefixes) ? options.excludeNodePrefixes : [])
      .map((name) => normalizeGlbNodeName(name))
      .filter(Boolean);
    const materialCache = new Map();
    const materialForIndex = (index) => {
      const hasMaterial = index !== undefined && index !== null;
      const materialIndex = hasMaterial ? Number(index) : "__default";
      if (materialCache.has(materialIndex)) return materialCache.get(materialIndex);
      const materialDef = hasMaterial ? (json.materials?.[materialIndex] || {}) : {};
      const material = options.createMaterial?.(materialDef, { textureForInfo })
        || new THREE.MeshStandardMaterial({ color: "#94a3b8", side: THREE.DoubleSide });
      materialCache.set(materialIndex, material);
      return material;
    };
    const root = new THREE.Group();
    root.name = json.scenes?.[json.scene || 0]?.name || "glb-theme";
    for (const nodeIndex of json.scenes?.[json.scene || 0]?.nodes || []) {
      const node = buildThemeGlbNode(json, buffers, nodeIndex, materialForIndex, { excludeNodeNames, excludeNodePrefixes });
      if (node) root.add(node);
    }
    return root;
  }

  function shouldExcludeThemeGlbNode(nodeDef, options = {}) {
    const name = normalizeGlbNodeName(nodeDef?.name);
    return Boolean(name && (
      options.excludeNodeNames?.has(name)
        || options.excludeNodePrefixes?.some((prefix) => name === prefix || name.startsWith(prefix))
    ));
  }

  function buildThemeGlbTexture(gltf, buffers, textureIndex, options = {}, srgb = true) {
    const textureDef = gltf.textures?.[textureIndex];
    const imageDef = gltf.images?.[textureDef?.source];
    const samplerDef = gltf.samplers?.[textureDef?.sampler] || {};
    if (!textureDef || !imageDef) return null;
    if (imageDef.bufferView !== undefined) {
      const bufferView = gltf.bufferViews?.[imageDef.bufferView];
      const source = buffers[bufferView?.buffer || 0];
      if (!bufferView || !source) return null;
      const byteOffset = Number(bufferView.byteOffset || 0);
      const byteLength = Number(bufferView.byteLength || 0);
      if (!byteLength) return null;
      const blob = new Blob([source.slice(byteOffset, byteOffset + byteLength)], {
        type: imageDef.mimeType || "image/png",
      });
      return options.createTexture?.(blob, textureDef, imageDef, samplerDef, srgb) || null;
    }
    if (imageDef.uri && !/^data:/i.test(imageDef.uri)) return null;
    if (imageDef.uri && /^data:/i.test(imageDef.uri)) {
      const [header, payload] = String(imageDef.uri).split(",", 2);
      const mimeType = /data:([^;,]+)/i.exec(header || "")?.[1] || "image/png";
      const binary = atob(payload || "");
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const blob = new Blob([bytes], { type: mimeType });
      return options.createTexture?.(blob, textureDef, imageDef, samplerDef, srgb) || null;
    }
    return null;
  }

  function applyGltfTextureTransform(texture, textureInfo) {
    if (!texture || !isPlainObject(textureInfo)) return;
    const transform = textureInfo.extensions?.KHR_texture_transform;
    if (!isPlainObject(transform)) return;
    const offset = Array.isArray(transform.offset) ? transform.offset : [0, 0];
    const scale = Array.isArray(transform.scale) ? transform.scale : [1, 1];
    texture.offset.set(
      Number(offset[0] || 0),
      Number(offset[1] || 0),
    );
    texture.repeat.set(
      Number(scale[0] ?? 1),
      Number(scale[1] ?? 1),
    );
    texture.rotation = Number(transform.rotation || 0);
    texture.center.set(0, 0);
    texture.needsUpdate = true;
  }

  function buildThemeGlbNode(gltf, buffers, nodeIndex, materialForIndex, options = {}) {
    const nodeDef = gltf.nodes?.[nodeIndex];
    if (!nodeDef) return null;
    if (shouldExcludeThemeGlbNode(nodeDef, options)) return null;
    const group = new THREE.Group();
    group.name = nodeDef.name || `node-${nodeIndex}`;
    applyGltfNodeTransform(group, nodeDef);
    if (nodeDef.mesh !== undefined) {
      const meshDef = gltf.meshes?.[nodeDef.mesh];
      for (const primitive of meshDef?.primitives || []) {
        const object = buildThemeGlbPrimitive(gltf, buffers, primitive, materialForIndex);
        if (object) {
          object.name = meshDef.name || group.name;
          group.add(object);
        }
      }
    }
    for (const childIndex of nodeDef.children || []) {
      const child = buildThemeGlbNode(gltf, buffers, childIndex, materialForIndex, options);
      if (child) group.add(child);
    }
    return group;
  }

  function applyGltfNodeTransform(object, nodeDef) {
    if (Array.isArray(nodeDef.matrix) && nodeDef.matrix.length === 16) {
      const matrix = new THREE.Matrix4().fromArray(nodeDef.matrix);
      matrix.decompose(object.position, object.quaternion, object.scale);
      return;
    }
    if (Array.isArray(nodeDef.translation)) {
      object.position.set(
        Number(nodeDef.translation[0] || 0),
        Number(nodeDef.translation[1] || 0),
        Number(nodeDef.translation[2] || 0),
      );
    }
    if (Array.isArray(nodeDef.rotation)) {
      object.quaternion.set(
        Number(nodeDef.rotation[0] || 0),
        Number(nodeDef.rotation[1] || 0),
        Number(nodeDef.rotation[2] || 0),
        Number(nodeDef.rotation[3] ?? 1),
      );
    }
    if (Array.isArray(nodeDef.scale)) {
      object.scale.set(
        Number(nodeDef.scale[0] ?? 1),
        Number(nodeDef.scale[1] ?? 1),
        Number(nodeDef.scale[2] ?? 1),
      );
    }
  }

  function buildThemeGlbPrimitive(gltf, buffers, primitive, materialForIndex) {
    const attributes = primitive.attributes || {};
    const position = readGltfAccessor(gltf, buffers, attributes.POSITION);
    if (!position?.array) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(position.array, position.itemSize, position.normalized));
    const normal = readGltfAccessor(gltf, buffers, attributes.NORMAL);
    if (normal?.array) geometry.setAttribute("normal", new THREE.BufferAttribute(normal.array, normal.itemSize, normal.normalized));
    const uv = readGltfAccessor(gltf, buffers, attributes.TEXCOORD_0);
    if (uv?.array) geometry.setAttribute("uv", new THREE.BufferAttribute(uv.array, uv.itemSize, uv.normalized));
    const color = readGltfAccessor(gltf, buffers, attributes.COLOR_0);
    if (color?.array) geometry.setAttribute("color", new THREE.BufferAttribute(color.array, color.itemSize, color.normalized));
    const indices = readGltfAccessor(gltf, buffers, primitive.indices);
    if (indices?.array) geometry.setIndex(new THREE.BufferAttribute(indices.array, 1, false));
    if (!normal?.array && primitive.mode !== 1) geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    if (primitive.mode === 1) {
      const meshMaterial = materialForIndex(primitive.material);
      const lineMaterial = new THREE.LineBasicMaterial({
        color: meshMaterial.color?.clone?.() || new THREE.Color("#d8c08a"),
        transparent: Boolean(meshMaterial.transparent),
        opacity: Number(meshMaterial.opacity ?? 1),
      });
      return new THREE.LineSegments(geometry, lineMaterial);
    }
    return new THREE.Mesh(geometry, materialForIndex(primitive.material));
  }

  function readGltfAccessor(gltf, buffers, accessorIndex) {
    if (accessorIndex === undefined || accessorIndex === null) return null;
    const accessor = gltf.accessors?.[accessorIndex];
    const bufferView = gltf.bufferViews?.[accessor?.bufferView];
    const source = buffers[bufferView?.buffer || 0];
    if (!accessor || !bufferView || !source) return null;
    const itemSize = GLTF_ACCESSOR_TYPE_SIZE[accessor.type] || 1;
    const ArrayType = GLTF_COMPONENT_ARRAYS[accessor.componentType];
    const componentSize = GLTF_COMPONENT_BYTE_SIZE[accessor.componentType] || 1;
    if (!ArrayType) return null;
    const byteOffset = Number(bufferView.byteOffset || 0) + Number(accessor.byteOffset || 0);
    const byteStride = Number(bufferView.byteStride || itemSize * componentSize);
    const length = Number(accessor.count || 0) * itemSize;
    if (!length) return null;
    if (byteStride === itemSize * componentSize) {
      return {
        array: new ArrayType(source, byteOffset, length),
        itemSize,
        normalized: Boolean(accessor.normalized),
      };
    }
    const output = new ArrayType(length);
    const dataView = new DataView(source);
    for (let index = 0; index < Number(accessor.count || 0); index += 1) {
      for (let component = 0; component < itemSize; component += 1) {
        const sourceOffset = byteOffset + index * byteStride + component * componentSize;
        output[index * itemSize + component] = readGltfComponent(dataView, sourceOffset, accessor.componentType);
      }
    }
    return { array: output, itemSize, normalized: Boolean(accessor.normalized) };
  }

  function readGltfComponent(view, offset, componentType) {
    if (componentType === 5120) return view.getInt8(offset);
    if (componentType === 5121) return view.getUint8(offset);
    if (componentType === 5122) return view.getInt16(offset, true);
    if (componentType === 5123) return view.getUint16(offset, true);
    if (componentType === 5125) return view.getUint32(offset, true);
    return view.getFloat32(offset, true);
  }

  const GLTF_ACCESSOR_TYPE_SIZE = {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
    MAT2: 4,
    MAT3: 9,
    MAT4: 16,
  };

  const GLTF_COMPONENT_ARRAYS = {
    5120: Int8Array,
    5121: Uint8Array,
    5122: Int16Array,
    5123: Uint16Array,
    5125: Uint32Array,
    5126: Float32Array,
  };

  const GLTF_COMPONENT_BYTE_SIZE = {
    5120: 1,
    5121: 1,
    5122: 2,
    5123: 2,
    5125: 4,
    5126: 4,
  };

  function coerceThemeSettingValue(value, definition = null) {
    const type = String(definition?.type || "number").toLowerCase();
    if (type === "boolean") return Boolean(value);
    if (type === "select" || type === "enum") return String(value);
    const min = Number(definition?.min ?? -100000);
    const max = Number(definition?.max ?? 100000);
    return clampNumber(Number(value), min, max, Number(definition?.default ?? 0));
  }

  function formatThemeSettingValue(value, definition = null) {
    const type = String(definition?.type || "number").toLowerCase();
    if (type === "boolean") return Boolean(value) ? "On" : "Off";
    if (type === "select" || type === "enum") return String(value);
    const number = Number(value);
    if (!Number.isFinite(number)) return "";
    const suffix = definition?.suffix ? String(definition.suffix) : "";
    return `${Number.isInteger(number) ? number : number.toFixed(2).replace(/\.?0+$/, "")}${suffix}`;
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function setObjectOpacity(object, opacity) {
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material) continue;
      material.opacity = opacity;
      material.transparent = opacity < 1 || material.blending === THREE.AdditiveBlending;
    }
  }

  function normalizeDegrees(value) {
    if (!Number.isFinite(value)) return 0;
    return ((value + 180) % 360 + 360) % 360 - 180;
  }

  function isEditableTarget(target) {
    if (!(target instanceof Element)) return false;
    const tagName = target.tagName.toLowerCase();
    return target.isContentEditable || ["input", "select", "textarea", "button"].includes(tagName);
  }

  function normalizedNavigationKey(event) {
    const key = String(event.key || "").toLowerCase();
    const navigationKeys = ["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d", "q", "e", "shift"];
    return navigationKeys.includes(key) ? key : "";
  }

  function isBacklightCornerSide(side) {
    return ["top-left", "top-right", "bottom-left", "bottom-right"].includes(side);
  }

  function backlightOpacityScale(segment) {
    return Number(segment?.opacityScale ?? 1);
  }

  function emptyBacklightColorMap() {
    return Object.fromEntries(Object.keys(BACKLIGHT_SEGMENT_COUNTS).map((side) => [side, []]));
  }

  function cornerVideoSampleRegion(window, segment, edgeDepth) {
    const amount = (Number(segment.index || 0) + 0.5) / Math.max(1, Number(segment.count || 1));
    const broad = edgeDepth * lerp(1.24, 0.72, amount);
    const narrow = edgeDepth * lerp(0.72, 1.24, amount);
    const left = segment.side.includes("left");
    const top = segment.side.includes("top");
    const width = window.x1 - window.x0;
    const height = window.y1 - window.y0;
    const xSize = width * (top ? broad : narrow);
    const ySize = height * (top ? narrow : broad);
    return {
      x0: left ? window.x0 : window.x1 - xSize,
      x1: left ? window.x0 + xSize : window.x1,
      y0: top ? window.y0 : window.y1 - ySize,
      y1: top ? window.y0 + ySize : window.y1,
    };
  }

  function lerp(start, end, amount) {
    return start + (end - start) * amount;
  }

  function createBacklightGlowTexture() {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 320;
    const context = canvas.getContext("2d");
    const gradient = context.createRadialGradient(160, 160, 0, 160, 160, 160);
    gradient.addColorStop(0, "rgba(255, 255, 255, 0.46)");
    gradient.addColorStop(0.14, "rgba(255, 255, 255, 0.32)");
    gradient.addColorStop(0.38, "rgba(255, 255, 255, 0.16)");
    gradient.addColorStop(0.66, "rgba(255, 255, 255, 0.055)");
    gradient.addColorStop(0.88, "rgba(255, 255, 255, 0.014)");
    gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  function createBacklightStaticMaterial(glowTexture) {
    return new THREE.MeshBasicMaterial({
      color: 0x3b82f6,
      map: glowTexture,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
  }

  function createBacklightSegmentMaterial(glowTexture, videoTexture) {
    return new THREE.ShaderMaterial({
      uniforms: {
        glowMap: { value: glowTexture },
        videoMap: { value: videoTexture },
        opacity: { value: 0.24 },
        sampleRegion: { value: new THREE.Vector4(0, 0, 1, 1) },
      },
      vertexShader: `
        varying vec2 vUv;

        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D glowMap;
        uniform sampler2D videoMap;
        uniform float opacity;
        uniform vec4 sampleRegion;
        varying vec2 vUv;

        vec3 videoAt(vec2 point) {
          vec2 topOriginUv = mix(sampleRegion.xy, sampleRegion.zw, point);
          return texture2D(videoMap, vec2(topOriginUv.x, 1.0 - topOriginUv.y)).rgb;
        }

        void main() {
          vec4 glow = texture2D(glowMap, vUv);
          vec3 videoColor = (
            videoAt(vec2(0.18, 0.18)) +
            videoAt(vec2(0.50, 0.18)) +
            videoAt(vec2(0.82, 0.18)) +
            videoAt(vec2(0.24, 0.50)) +
            videoAt(vec2(0.50, 0.50)) +
            videoAt(vec2(0.76, 0.50)) +
            videoAt(vec2(0.18, 0.82)) +
            videoAt(vec2(0.50, 0.82)) +
            videoAt(vec2(0.82, 0.82))
          ) / 9.0;
          float glowStrength = glow.a;
          float videoMax = max(max(videoColor.r, videoColor.g), videoColor.b);
          float videoLuminance = dot(videoColor, vec3(0.2126, 0.7152, 0.0722));
          float videoAlpha = smoothstep(0.018, 0.09, max(videoMax, videoLuminance));
          float boost = mix(1.25, 1.0, smoothstep(0.18, 0.62, videoMax));
          vec3 color = clamp(videoColor * boost, vec3(0.0), vec3(1.0));
          float alpha = glowStrength * opacity * videoAlpha;
          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
  }

  function flipRgbaRows(source, target, width, height) {
    const rowBytes = width * 4;
    for (let y = 0; y < height; y += 1) {
      const sourceStart = (height - 1 - y) * rowBytes;
      const targetStart = y * rowBytes;
      target.set(source.subarray(sourceStart, sourceStart + rowBytes), targetStart);
    }
    return target;
  }

  function hasVisibleSamplePixels(data) {
    if (!data?.length) return false;
    let visible = 0;
    for (let index = 0; index < data.length; index += 16) {
      const pixelR = data[index];
      const pixelG = data[index + 1];
      const pixelB = data[index + 2];
      const pixelMax = Math.max(pixelR, pixelG, pixelB) / 255;
      const pixelLuminance = (0.2126 * pixelR + 0.7152 * pixelG + 0.0722 * pixelB) / 255;
      if (pixelLuminance > 0.018 || pixelMax > 0.045) {
        visible += 1;
        if (visible >= 6) return true;
      }
    }
    return false;
  }

  function samplePixelDebug(data) {
    if (!data?.length) return "empty";
    let max = 0;
    let luminance = 0;
    let samples = 0;
    for (let index = 0; index < data.length; index += 16) {
      const pixelR = data[index];
      const pixelG = data[index + 1];
      const pixelB = data[index + 2];
      max = Math.max(max, pixelR, pixelG, pixelB);
      luminance += 0.2126 * pixelR + 0.7152 * pixelG + 0.0722 * pixelB;
      samples += 1;
    }
    const avg = samples ? Math.round(luminance / samples) : 0;
    return `avg ${avg} max ${Math.round(max)}`;
  }

  function objectMaterials(object) {
    const materials = [];
    object?.traverse?.((child) => {
      if (Array.isArray(child.material)) {
        materials.push(...child.material.filter(Boolean));
      } else if (child.material) {
        materials.push(child.material);
      }
    });
    if (!materials.length && object?.material) {
      if (Array.isArray(object.material)) materials.push(...object.material.filter(Boolean));
      else materials.push(object.material);
    }
    return materials;
  }

  function normalizeSeatingPosition(seat, index = 0) {
    if (!isPlainObject(seat)) return null;
    const id = slugifySeatId(seat.id || seat.key || seat.label || `seat-${index + 1}`);
    if (!id || id === "manual") return null;
    const position = Array.isArray(seat.position)
      ? seat.position
      : [seat.x, seat.y, seat.z];
    const x = clampNumber(Number(position[0]), THEATER_SETTING_LIMITS.roomViewX[0], THEATER_SETTING_LIMITS.roomViewX[1], DEFAULT_SETTINGS.roomViewX);
    const y = clampNumber(Number(position[1]), THEATER_SETTING_LIMITS.roomViewY[0], THEATER_SETTING_LIMITS.roomViewY[1], DEFAULT_SETTINGS.roomViewY);
    const z = clampNumber(Number(position[2]), THEATER_SETTING_LIMITS.roomViewZ[0], THEATER_SETTING_LIMITS.roomViewZ[1], DEFAULT_SETTINGS.roomViewZ);
    const avatarOffset = Array.isArray(seat.avatarOffset)
      ? [
          Number(seat.avatarOffset[0] || 0),
          Number(seat.avatarOffset[1] || 0),
          Number(seat.avatarOffset[2] || 0),
        ]
      : null;
    const avatarPosition = Array.isArray(seat.avatarPosition)
      ? [
          Number(seat.avatarPosition[0] || 0),
          Number(seat.avatarPosition[1] || 0),
          Number(seat.avatarPosition[2] || 0),
        ]
      : null;
    const avatarCushionToTop = seat.avatarCushionToTop != null && Number.isFinite(Number(seat.avatarCushionToTop))
      ? Number(seat.avatarCushionToTop)
      : null;
    const avatarBackOffset = seat.avatarBackOffset != null && Number.isFinite(Number(seat.avatarBackOffset))
      ? Number(seat.avatarBackOffset)
      : null;
    return {
      id,
      label: String(seat.label || seat.name || seat.id || `Seat ${index + 1}`),
      x,
      y,
      z,
      yaw: normalizeDegrees(clampNumber(Number(seat.yaw), THEATER_SETTING_LIMITS.roomViewYaw[0], THEATER_SETTING_LIMITS.roomViewYaw[1], DEFAULT_SETTINGS.roomViewYaw)),
      pitch: clampNumber(Number(seat.pitch), THEATER_SETTING_LIMITS.roomViewPitch[0], THEATER_SETTING_LIMITS.roomViewPitch[1], DEFAULT_SETTINGS.roomViewPitch),
      avatarPosition,
      avatarOffset,
      avatarCushionToTop,
      avatarBackOffset,
    };
  }

  function slugifySeatId(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function themeVideoSampleColor(colors, region = "average") {
    const key = String(region || "average").toLowerCase();
    if (key === "average" || key === "center" || key === "all") return averageBacklightColorMap(colors);
    if (key.includes("-")) {
      const sideColors = colors?.[key];
      if (Array.isArray(sideColors)) return averageVisibleColors(sideColors);
    }
    if (["top", "bottom", "left", "right"].includes(key)) {
      return averageVisibleColors(colors?.[key] || []);
    }
    if (key === "vertical") return averageVisibleColors([...(colors?.left || []), ...(colors?.right || [])]);
    if (key === "horizontal") return averageVisibleColors([...(colors?.top || []), ...(colors?.bottom || [])]);
    return averageBacklightColorMap(colors);
  }

  function averageBacklightColorMap(colors) {
    return averageVisibleColors(Object.values(colors || {}).flatMap((sideColors) => Array.isArray(sideColors) ? sideColors : []));
  }

  function averageVisibleColors(colors) {
    let r = 0;
    let g = 0;
    let b = 0;
    let weight = 0;
    let opacity = 0;
    for (const color of colors || []) {
      if (!isVisibleBacklightColor(color)) continue;
      const colorWeight = Math.max(0.01, Number(color.opacity || 0));
      r += Number(color.r || 0) * colorWeight;
      g += Number(color.g || 0) * colorWeight;
      b += Number(color.b || 0) * colorWeight;
      opacity += Number(color.opacity || 0);
      weight += colorWeight;
    }
    if (!weight) return offBacklightColor();
    return {
      r: clampNumber(r / weight, 0, 1, 0),
      g: clampNumber(g / weight, 0, 1, 0),
      b: clampNumber(b / weight, 0, 1, 0),
      opacity: clampNumber(opacity / Math.max(1, colors.length), 0, 1, 0),
    };
  }

  function averageSampleRegion(data, width, height, region) {
    const x0 = Math.max(0, Math.min(width - 1, Math.floor(region.x0 * width)));
    const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil(region.x1 * width)));
    const y0 = Math.max(0, Math.min(height - 1, Math.floor(region.y0 * height)));
    const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil(region.y1 * height)));
    let r = 0;
    let g = 0;
    let b = 0;
    let weightedR = 0;
    let weightedG = 0;
    let weightedB = 0;
    let activeWeight = 0;
    let activePixels = 0;
    let pixels = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const index = (y * width + x) * 4;
        const pixelR = data[index];
        const pixelG = data[index + 1];
        const pixelB = data[index + 2];
        r += pixelR;
        g += pixelG;
        b += pixelB;
        const pixelMax = Math.max(pixelR, pixelG, pixelB) / 255;
        const pixelLuminance = (0.2126 * pixelR + 0.7152 * pixelG + 0.0722 * pixelB) / 255;
        if (pixelLuminance > 0.025 || pixelMax > 0.055) {
          const weight = 0.35 + Math.min(1.6, pixelLuminance * 5 + pixelMax * 1.4);
          weightedR += pixelR * weight;
          weightedG += pixelG * weight;
          weightedB += pixelB * weight;
          activeWeight += weight;
          activePixels += 1;
        }
        pixels += 1;
      }
    }
    if (!pixels) return { r: 0.23, g: 0.51, b: 0.96, opacity: 0.42 };
    const maxChannel = Math.max(r, g, b) / pixels / 255;
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / pixels / 255;
    const activeRatio = activePixels / pixels;
    if (luminance < 0.012 && maxChannel < 0.028 && activeRatio < 0.004) {
      return { r: 0, g: 0, b: 0, opacity: 0 };
    }
    const sampleR = activeWeight ? weightedR / activeWeight : r / pixels;
    const sampleG = activeWeight ? weightedG / activeWeight : g / pixels;
    const sampleB = activeWeight ? weightedB / activeWeight : b / pixels;
    const sampleMax = Math.max(sampleR, sampleG, sampleB) / 255;
    const boost = sampleMax < 0.24 ? 1.45 : 1.12;
    const opacityFloor = activePixels ? 0.16 : 0.08;
    const opacity = opacityFloor + Math.sqrt(Math.max(luminance, sampleMax * Math.max(activeRatio, 0.02))) * 0.36 + Math.sqrt(activeRatio) * 0.12;
    return {
      r: clampNumber(sampleR / 255 * boost, 0.02, 1, 0.2),
      g: clampNumber(sampleG / 255 * boost, 0.02, 1, 0.45),
      b: clampNumber(sampleB / 255 * boost, 0.02, 1, 0.95),
      opacity: clampNumber(opacity, 0.08, 0.5, 0.26),
    };
  }

  function sampleExpandedSegmentRegion(data, width, height, window, segment) {
    if (isBacklightCornerSide(segment.side)) {
      return averageSampleRegion(data, width, height, cornerVideoSampleRegion(window, segment, 0.58));
    }
    const start = segment.index / segment.count;
    const end = (segment.index + 1) / segment.count;
    if (segment.side === "top" || segment.side === "bottom") {
      return averageSampleRegion(data, width, height, {
        x0: lerp(window.x0, window.x1, start),
        x1: lerp(window.x0, window.x1, end),
        y0: window.y0,
        y1: window.y1,
      });
    }
    const yStart = 1 - end;
    const yEnd = 1 - start;
    return averageSampleRegion(data, width, height, {
      x0: window.x0,
      x1: window.x1,
      y0: lerp(window.y0, window.y1, yStart),
      y1: lerp(window.y0, window.y1, yEnd),
    });
  }

  function isVisibleBacklightColor(color) {
    return Number(color?.opacity || 0) > 0.01;
  }

  function hasVisibleBacklightColors(colors) {
    return Object.values(colors || {}).some((sideColors) => (
      Array.isArray(sideColors)
      && sideColors.some((color) => isVisibleBacklightColor(color))
    ));
  }

  function sampleExpandedBacklightColors(data, width, height, window, segments) {
    const output = emptyBacklightColorMap();
    for (const item of segments || []) {
      const segment = item?.userData?.backlightSegment || item;
      if (!output[segment.side]) continue;
      output[segment.side][segment.index] = sampleExpandedSegmentRegion(data, width, height, window, segment);
    }
    return output;
  }

  function fallbackBacklightColors(color = null, opacity = null) {
    const output = emptyBacklightColorMap();
    for (const side of Object.keys(output)) {
      const count = BACKLIGHT_SEGMENT_COUNTS[side] || 1;
      for (let index = 0; index < count; index += 1) {
        output[side][index] = color
          ? { ...colorToRgb(color), opacity: opacity ?? 0.34 }
          : fallbackBacklightColor({ side, index, count });
      }
    }
    return output;
  }

  function offBacklightColors() {
    const output = emptyBacklightColorMap();
    for (const side of Object.keys(output)) {
      const count = BACKLIGHT_SEGMENT_COUNTS[side] || 1;
      for (let index = 0; index < count; index += 1) {
        output[side][index] = offBacklightColor();
      }
    }
    return output;
  }

  function offBacklightColor() {
    return { r: 0, g: 0, b: 0, opacity: 0 };
  }

  function colorToRgb(value) {
    const color = colorFromTheme(value, new THREE.Color("#3b82f6"));
    return { r: color.r, g: color.g, b: color.b };
  }

  function fallbackBacklightColor(segment) {
    const position = segment.count ? segment.index / Math.max(1, segment.count - 1) : 0;
    const palette = [
      { r: 0.05, g: 0.35, b: 1, opacity: 0.3 },
      { r: 0.1, g: 0.9, b: 0.95, opacity: 0.31 },
      { r: 0.9, g: 0.12, b: 1, opacity: 0.36 },
      { r: 1, g: 0.86, b: 0.22, opacity: 0.32 },
    ];
    const offset = segment.side === "bottom" ? 0.16 : segment.side === "right" ? 0.32 : segment.side === "left" ? -0.12 : 0;
    const scaled = ((position + offset) % 1 + 1) % 1 * (palette.length - 1);
    const index = Math.floor(scaled);
    const next = Math.min(palette.length - 1, index + 1);
    const amount = scaled - index;
    return {
      r: lerp(palette[index].r, palette[next].r, amount),
      g: lerp(palette[index].g, palette[next].g, amount),
      b: lerp(palette[index].b, palette[next].b, amount),
      opacity: lerp(palette[index].opacity, palette[next].opacity, amount),
    };
  }

  function lockedPanelSize(axis, value, aspect, current) {
    const minWidth = 1.4;
    const maxWidth = 6;
    const minHeight = 0.8;
    const maxHeight = 3.6;
    let width = clampNumber(Number(current.panelWidth), minWidth, maxWidth, DEFAULT_SETTINGS.panelWidth);
    let height = clampNumber(Number(current.panelHeight), minHeight, maxHeight, DEFAULT_SETTINGS.panelHeight);
    const ratio = clampNumber(Number(aspect), 0.1, 10, 16 / 9);
    if (axis === "height") {
      height = clampNumber(Number(value), minHeight, maxHeight, height);
      width = height * ratio;
      if (width > maxWidth) {
        width = maxWidth;
        height = width / ratio;
      }
      if (width < minWidth) {
        width = minWidth;
        height = width / ratio;
      }
    } else {
      width = clampNumber(Number(value), minWidth, maxWidth, width);
      height = width / ratio;
      if (height > maxHeight) {
        height = maxHeight;
        width = height * ratio;
      }
      if (height < minHeight) {
        height = minHeight;
        width = height * ratio;
      }
    }
    return {
      width: clampNumber(width, minWidth, maxWidth, DEFAULT_SETTINGS.panelWidth),
      height: clampNumber(height, minHeight, maxHeight, DEFAULT_SETTINGS.panelHeight),
    };
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const total = Math.floor(seconds);
    const minutes = Math.floor(total / 60);
    const remaining = total % 60;
    return `${minutes}:${String(remaining).padStart(2, "0")}`;
  }

  function cleanPanelText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function wrapCanvasText(context, text, maxWidth) {
    const words = cleanPanelText(text).split(" ");
    const lines = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (context.measureText(candidate).width <= maxWidth || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function roundRect(context, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.lineTo(x + width - r, y);
    context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r);
    context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - r);
    context.lineTo(x, y + r);
    context.quadraticCurveTo(x, y, x + r, y);
    context.closePath();
  }

  function drawXrPanelButton(context, rect, label) {
    context.fillStyle = "rgba(20, 33, 55, 0.94)";
    roundRect(context, rect.x, rect.y, rect.width, rect.height, 14);
    context.fill();
    context.strokeStyle = "rgba(147, 197, 253, 0.52)";
    context.lineWidth = 3;
    context.stroke();
    context.fillStyle = "#f8fafc";
    context.font = "800 25px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label, rect.x + rect.width / 2, rect.y + rect.height / 2);
    context.textAlign = "start";
    context.textBaseline = "alphabetic";
  }

  function colorFromTheme(value, fallback) {
    try {
      return new THREE.Color(String(value || "") || fallback);
    } catch (error) {
      return fallback instanceof THREE.Color ? fallback : new THREE.Color(fallback || "#000000");
    }
  }

  function shouldRestoreDesktopRoomView(stored) {
    const viewKeys = ["roomViewX", "roomViewY", "roomViewZ", "roomViewYaw", "roomViewPitch"];
    if (!viewKeys.some((key) => Object.prototype.hasOwnProperty.call(stored, key))) return false;
    const allZero = viewKeys.every((key) => Math.abs(Number(stored[key] || 0)) < 0.001);
    const flatFloorView = Math.abs(Number(stored.roomViewY || 0)) < 0.05
      && Math.abs(Number(stored.roomViewPitch || 0)) < 1;
    return allZero || flatFloorView;
  }

  function parseObjGeometry(text) {
    const vertices = [];
    const positions = [];
    const lines = text.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const parts = line.split(/\s+/);
      if (parts[0] === "v" && parts.length >= 4) {
        vertices.push([
          Number(parts[1] || 0),
          Number(parts[2] || 0),
          Number(parts[3] || 0),
        ]);
      }
      if (parts[0] === "f" && parts.length >= 4) {
        const indexes = parts.slice(1).map((part) => Number(part.split("/")[0]) - 1).filter((index) => index >= 0);
        for (let i = 1; i < indexes.length - 1; i += 1) {
          for (const index of [indexes[0], indexes[i], indexes[i + 1]]) {
            const vertex = vertices[index];
            if (vertex) positions.push(vertex[0], vertex[1], vertex[2]);
          }
        }
      }
    }
    if (!positions.length) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }


  Object.assign(XR, {
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
  });
})();
