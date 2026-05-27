(() => {
  const XR = window.FilePipeXr = window.FilePipeXr || {};
  const { FilePipeThreeXrPlayer } = XR;
  const {
    AVATAR_POSE_SEND_INTERVAL_MS,
    AVATAR_REMOTE_TIMEOUT_MS,
    clampNumber,
    isPlainObject,
  } = XR;

  const UP = new THREE.Vector3(0, 1, 0);
  const DOWN = new THREE.Vector3(0, -1, 0);
  const FORWARD = new THREE.Vector3(0, 0, -1);
  const RIGHT = new THREE.Vector3(1, 0, 0);
  const AVATAR_STANDING_TOP_Y = 2.0;
  const AVATAR_SEATED_CUSHION_TO_TOP = 0.66;
  const AVATAR_SEATED_BACK_OFFSET = 0.025;
  const AVATAR_HEAD_TOP_OFFSET = 0.105;
  const AVATAR_SEAT_MATCH_DISTANCE = 1.25;
  const AVATAR_SEAT_MATCH_YAW_DEGREES = 35;
  const AVATAR_PROPORTIONS = {
    headRadius: 0.1,
    chestDrop: 0.31,
    pelvisDrop: 0.58,
    neckDrop: 0.12,
    shoulderHalfWidth: 0.16,
    shoulderLift: 0.03,
    hipHalfWidth: 0.08,
    elbowDrop: 0.08,
    elbowOut: 0.04,
    maxArmReach: 0.38,
    seatedMaxArmReach: 0.33,
    kneeDrop: 0.36,
    footDrop: 0.62,
    kneeForward: 0.035,
    footForward: 0.135,
    seatedPelvisDrop: 0.34,
    seatedKneeDrop: 0.16,
    seatedKneeForward: 0.34,
    seatedFootDrop: 0.58,
    seatedFootForward: 0.45,
    fallbackHandSide: 0.22,
    fallbackHandForward: 0.22,
    fallbackHandDrop: 0.32,
  };

  function rounded(value, digits = 3) {
    const scale = 10 ** digits;
    return Math.round(Number(value || 0) * scale) / scale;
  }

  function packVector(vector) {
    return [rounded(vector.x), rounded(vector.y), rounded(vector.z)];
  }

  function packQuaternion(quaternion) {
    return [
      rounded(quaternion.x, 4),
      rounded(quaternion.y, 4),
      rounded(quaternion.z, 4),
      rounded(quaternion.w, 4),
    ];
  }

  function vectorFrom(value, fallback = new THREE.Vector3()) {
    if (value instanceof THREE.Vector3) return value.clone();
    if (Array.isArray(value)) {
      return new THREE.Vector3(
        Number(value[0] || 0),
        Number(value[1] || 0),
        Number(value[2] || 0),
      );
    }
    if (isPlainObject(value)) {
      return new THREE.Vector3(
        Number(value.x || 0),
        Number(value.y || 0),
        Number(value.z || 0),
      );
    }
    return fallback.clone();
  }

  function quaternionFrom(value, fallback = new THREE.Quaternion()) {
    if (value instanceof THREE.Quaternion) return value.clone();
    if (Array.isArray(value)) {
      return new THREE.Quaternion(
        Number(value[0] || 0),
        Number(value[1] || 0),
        Number(value[2] || 0),
        Number(value[3] ?? 1),
      ).normalize();
    }
    if (isPlainObject(value)) {
      return new THREE.Quaternion(
        Number(value.x || 0),
        Number(value.y || 0),
        Number(value.z || 0),
        Number(value.w ?? 1),
      ).normalize();
    }
    return fallback.clone();
  }

  function yawFromQuaternion(quaternion) {
    const forward = FORWARD.clone().applyQuaternion(quaternion);
    forward.y = 0;
    if (forward.lengthSq() < 0.000001) return 0;
    forward.normalize();
    return Math.atan2(-forward.x, -forward.z);
  }

  function avatarColorForId(id) {
    let hash = 0;
    const text = String(id || "avatar");
    for (let index = 0; index < text.length; index += 1) {
      hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
    }
    const hue = ((Math.abs(hash) % 360) / 360);
    return new THREE.Color().setHSL(hue, 0.62, 0.58);
  }

  function angleDeltaDegrees(a, b) {
    return Math.abs((((Number(a || 0) - Number(b || 0)) + 540) % 360) - 180);
  }

  function normalizeTrackedPart(part, fallbackPosition = new THREE.Vector3(), fallbackQuaternion = new THREE.Quaternion()) {
    const source = isPlainObject(part) ? part : {};
    return {
      position: vectorFrom(source.position || source.p, fallbackPosition || new THREE.Vector3()),
      quaternion: quaternionFrom(source.quaternion || source.q, fallbackQuaternion || new THREE.Quaternion()),
      tracked: Boolean(source.tracked),
    };
  }

  function normalizeAvatarPose(pose) {
    if (!isPlainObject(pose)) return null;
    const head = normalizeTrackedPart(pose.head, new THREE.Vector3(0, 1.65, 0), new THREE.Quaternion());
    const bodyYaw = Number.isFinite(Number(pose.body?.yaw)) ? Number(pose.body.yaw) : yawFromQuaternion(head.quaternion);
    const renderSeated = Boolean(pose.renderSeated || pose.body?.seated);
    return {
      version: 1,
      enabled: pose.enabled !== false,
      avatarViewpoint: Boolean(pose.avatarViewpoint),
      renderSeated,
      sentAt: Number(pose.sentAt || Date.now()),
      sequence: Math.max(0, Number(pose.sequence || 0)),
      body: { yaw: bodyYaw, seated: renderSeated },
      head,
      leftHand: normalizeTrackedPart(pose.leftHand, null, head.quaternion),
      rightHand: normalizeTrackedPart(pose.rightHand, null, head.quaternion),
    };
  }

  function cloneAvatarPose(pose) {
    const normalized = normalizeAvatarPose(pose);
    if (!normalized) return null;
    return {
      ...normalized,
      body: { ...normalized.body },
      head: {
        ...normalized.head,
        position: normalized.head.position.clone(),
        quaternion: normalized.head.quaternion.clone(),
      },
      leftHand: {
        ...normalized.leftHand,
        position: normalized.leftHand.position.clone(),
        quaternion: normalized.leftHand.quaternion.clone(),
      },
      rightHand: {
        ...normalized.rightHand,
        position: normalized.rightHand.position.clone(),
        quaternion: normalized.rightHand.quaternion.clone(),
      },
    };
  }

  function interpolateTrackedPart(current, target, alpha) {
    current.position.lerp(target.position, alpha);
    current.quaternion.slerp(target.quaternion, alpha);
    current.tracked = target.tracked;
  }

  function smoothAvatarPose(current, target, deltaSeconds) {
    if (!current) return cloneAvatarPose(target);
    const alpha = clampNumber((deltaSeconds || 0.016) * 14, 0, 1, 0.25);
    current.enabled = target.enabled;
    current.avatarViewpoint = target.avatarViewpoint;
    current.renderSeated = target.renderSeated;
    current.sentAt = target.sentAt;
    current.sequence = target.sequence;
    current.body.yaw += (target.body.yaw - current.body.yaw) * alpha;
    current.body.seated = Boolean(target.renderSeated);
    interpolateTrackedPart(current.head, target.head, alpha);
    interpolateTrackedPart(current.leftHand, target.leftHand, alpha);
    interpolateTrackedPart(current.rightHand, target.rightHand, alpha);
    return current;
  }

  function packAvatarPose(pose) {
    return {
      version: 1,
      enabled: pose.enabled !== false,
      avatarViewpoint: Boolean(pose.avatarViewpoint),
      sentAt: Date.now(),
      sequence: pose.sequence,
      body: { yaw: rounded(pose.body.yaw, 4), seated: Boolean(pose.renderSeated) },
      head: {
        p: packVector(pose.head.position),
        q: packQuaternion(pose.head.quaternion),
        tracked: true,
      },
      leftHand: {
        p: packVector(pose.leftHand.position),
        q: packQuaternion(pose.leftHand.quaternion),
        tracked: Boolean(pose.leftHand.tracked),
      },
      rightHand: {
        p: packVector(pose.rightHand.position),
        q: packQuaternion(pose.rightHand.quaternion),
        tracked: Boolean(pose.rightHand.tracked),
      },
    };
  }

  function makeMaterial(color, options = {}) {
    return new THREE.MeshStandardMaterial({
      color,
      roughness: 0.78,
      metalness: 0.08,
      transparent: Boolean(options.transparent),
      opacity: options.opacity ?? 1,
    });
  }

  function makeGlowMaterial(color = 0x67e8f9, options = {}) {
    return new THREE.MeshStandardMaterial({
      color,
      emissive: new THREE.Color(color),
      emissiveIntensity: options.intensity ?? 1.7,
      roughness: 0.26,
      metalness: 0.12,
      transparent: Boolean(options.transparent),
      opacity: options.opacity ?? 1,
    });
  }

  function makeSegment(material) {
    return new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 6), material);
  }

  function makeCapsuleGeometry(radius, length, radialSegments = 12) {
    if (THREE.CapsuleGeometry) return new THREE.CapsuleGeometry(radius, length, 5, radialSegments);
    return new THREE.CylinderGeometry(radius, radius, length + radius * 2, radialSegments);
  }

  function makeArmorPlate(width, height, depth, material) {
    const geometry = new THREE.BoxGeometry(width, height, depth);
    const position = geometry.attributes.position;
    for (let index = 0; index < position.count; index += 1) {
      const x = position.getX(index);
      const y = position.getY(index);
      const bevel = 0.82 + 0.18 * Math.min(Math.abs(y) / Math.max(height / 2, 0.001), 1);
      position.setX(index, x * bevel);
    }
    position.needsUpdate = true;
    geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, material);
  }

  function setSegment(mesh, start, end, radius = 0.035) {
    const delta = end.clone().sub(start);
    const length = delta.length();
    if (length < 0.001) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;
    mesh.position.copy(start).add(end).multiplyScalar(0.5);
    mesh.scale.set(radius, length, radius);
    mesh.quaternion.setFromUnitVectors(UP, delta.normalize());
  }

  function disposeObjectTree(object) {
    const materials = new Set();
    object?.traverse?.((child) => {
      child.geometry?.dispose?.();
      if (Array.isArray(child.material)) child.material.forEach((material) => materials.add(material));
      else if (child.material) materials.add(child.material);
    });
    materials.forEach((material) => material.dispose?.());
    object?.parent?.remove?.(object);
  }

  function inferredHand(head, bodyYaw, side) {
    const yaw = new THREE.Quaternion().setFromAxisAngle(UP, bodyYaw);
    const right = RIGHT.clone().applyQuaternion(yaw).multiplyScalar(side);
    const forward = FORWARD.clone().applyQuaternion(yaw);
    return head.clone()
      .add(right.multiplyScalar(AVATAR_PROPORTIONS.fallbackHandSide))
      .add(forward.multiplyScalar(AVATAR_PROPORTIONS.fallbackHandForward))
      .add(DOWN.clone().multiplyScalar(AVATAR_PROPORTIONS.fallbackHandDrop));
  }

  function clampedHandPosition(shoulder, rawHand, seated = false) {
    const maxReach = seated ? AVATAR_PROPORTIONS.seatedMaxArmReach : AVATAR_PROPORTIONS.maxArmReach;
    const delta = rawHand.clone().sub(shoulder);
    const distance = delta.length();
    if (distance <= maxReach || distance < 0.001) return rawHand.clone();
    return shoulder.clone().add(delta.multiplyScalar(maxReach / distance));
  }

  function inferAvatarJoints(pose) {
    const head = pose.head.position.clone();
    const bodyYaw = Number.isFinite(pose.body?.yaw) ? pose.body.yaw : yawFromQuaternion(pose.head.quaternion);
    const bodyRotation = new THREE.Quaternion().setFromAxisAngle(UP, bodyYaw);
    const right = RIGHT.clone().applyQuaternion(bodyRotation);
    const forward = FORWARD.clone().applyQuaternion(bodyRotation);
    const seated = Boolean(pose.renderSeated);
    const chest = head.clone().add(DOWN.clone().multiplyScalar(AVATAR_PROPORTIONS.chestDrop)).add(forward.clone().multiplyScalar(0.025));
    const pelvis = head.clone().add(DOWN.clone().multiplyScalar(seated ? AVATAR_PROPORTIONS.seatedPelvisDrop : AVATAR_PROPORTIONS.pelvisDrop));
    const neck = head.clone().add(DOWN.clone().multiplyScalar(AVATAR_PROPORTIONS.neckDrop));
    const leftShoulder = chest.clone().add(right.clone().multiplyScalar(-AVATAR_PROPORTIONS.shoulderHalfWidth)).add(UP.clone().multiplyScalar(AVATAR_PROPORTIONS.shoulderLift));
    const rightShoulder = chest.clone().add(right.clone().multiplyScalar(AVATAR_PROPORTIONS.shoulderHalfWidth)).add(UP.clone().multiplyScalar(AVATAR_PROPORTIONS.shoulderLift));
    const rawLeftHand = pose.leftHand.tracked ? pose.leftHand.position.clone() : inferredHand(head, bodyYaw, -1);
    const rawRightHand = pose.rightHand.tracked ? pose.rightHand.position.clone() : inferredHand(head, bodyYaw, 1);
    const leftHand = clampedHandPosition(leftShoulder, rawLeftHand, seated);
    const rightHand = clampedHandPosition(rightShoulder, rawRightHand, seated);
    const leftElbow = leftShoulder.clone().lerp(leftHand, 0.52).add(DOWN.clone().multiplyScalar(AVATAR_PROPORTIONS.elbowDrop)).add(right.clone().multiplyScalar(-AVATAR_PROPORTIONS.elbowOut));
    const rightElbow = rightShoulder.clone().lerp(rightHand, 0.52).add(DOWN.clone().multiplyScalar(AVATAR_PROPORTIONS.elbowDrop)).add(right.clone().multiplyScalar(AVATAR_PROPORTIONS.elbowOut));
    const leftHip = pelvis.clone().add(right.clone().multiplyScalar(-AVATAR_PROPORTIONS.hipHalfWidth));
    const rightHip = pelvis.clone().add(right.clone().multiplyScalar(AVATAR_PROPORTIONS.hipHalfWidth));
    const kneeDrop = seated ? AVATAR_PROPORTIONS.seatedKneeDrop : AVATAR_PROPORTIONS.kneeDrop;
    const kneeForward = seated ? AVATAR_PROPORTIONS.seatedKneeForward : AVATAR_PROPORTIONS.kneeForward;
    const footDrop = seated ? AVATAR_PROPORTIONS.seatedFootDrop : AVATAR_PROPORTIONS.footDrop;
    const footForward = seated ? AVATAR_PROPORTIONS.seatedFootForward : AVATAR_PROPORTIONS.footForward;
    const leftKnee = leftHip.clone().add(DOWN.clone().multiplyScalar(kneeDrop)).add(forward.clone().multiplyScalar(kneeForward));
    const rightKnee = rightHip.clone().add(DOWN.clone().multiplyScalar(kneeDrop)).add(forward.clone().multiplyScalar(kneeForward));
    const leftFoot = leftHip.clone().add(DOWN.clone().multiplyScalar(footDrop)).add(forward.clone().multiplyScalar(footForward));
    const rightFoot = rightHip.clone().add(DOWN.clone().multiplyScalar(footDrop)).add(forward.clone().multiplyScalar(footForward));
    return {
      bodyRotation,
      head,
      neck,
      chest,
      pelvis,
      leftShoulder,
      rightShoulder,
      leftElbow,
      rightElbow,
      leftHand,
      rightHand,
      leftHip,
      rightHip,
      leftKnee,
      rightKnee,
      leftFoot,
      rightFoot,
    };
  }

  Object.assign(FilePipeThreeXrPlayer.prototype, {
    ensureAvatarGroup() {
      if (this.avatarGroup || !this.worldGroup || !window.THREE) return;
      this.avatarGroup = new THREE.Group();
      this.avatarGroup.name = "xr-theater-avatars";
      this.worldGroup.add(this.avatarGroup);
    },

    createRobotHand(side = 1, jointMaterial, glowMaterial) {
      const hand = new THREE.Group();
      const palm = makeArmorPlate(0.058, 0.072, 0.026, jointMaterial);
      palm.rotation.z = side * 0.18;
      hand.add(palm);
      const fingerGeometry = new THREE.BoxGeometry(0.011, 0.038, 0.012);
      [-0.018, 0, 0.018].forEach((offset, index) => {
        const finger = new THREE.Mesh(fingerGeometry.clone(), jointMaterial);
        finger.position.set(offset, 0.05 + index * 0.002, -0.004);
        finger.rotation.z = side * (0.16 - index * 0.04);
        hand.add(finger);
      });
      const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.036, 0.012), jointMaterial);
      thumb.position.set(side * 0.036, 0.012, -0.004);
      thumb.rotation.z = side * -0.78;
      hand.add(thumb);
      const wristGlow = new THREE.Mesh(new THREE.TorusGeometry(0.026, 0.003, 6, 14), glowMaterial);
      wristGlow.rotation.x = Math.PI / 2;
      wristGlow.position.y = -0.044;
      hand.add(wristGlow);
      return hand;
    },

    createAvatarRig(options = {}) {
      const armor = new THREE.Color(0xe5edf5);
      const armorShade = new THREE.Color(0xb7c3cc);
      const dark = new THREE.Color(0x111820);
      const joint = new THREE.Color(0x05080c);
      const materialOptions = options.local ? { transparent: true, opacity: 0.92 } : {};
      const material = makeMaterial(armor, materialOptions);
      const accentMaterial = makeMaterial(armorShade, materialOptions);
      const darkMaterial = makeMaterial(dark, materialOptions);
      const jointMaterial = makeMaterial(joint, materialOptions);
      const glowMaterial = makeGlowMaterial(0x67e8f9, materialOptions);
      const visorMaterial = new THREE.MeshStandardMaterial({
        color: 0x102b38,
        emissive: new THREE.Color(0x67e8f9),
        emissiveIntensity: 1.45,
        roughness: 0.32,
        metalness: 0.15,
        transparent: true,
        opacity: options.local ? 0.72 : 0.94,
      });
      const group = new THREE.Group();
      group.name = options.name || options.id || "avatar";

      const head = new THREE.Group();
      const skull = new THREE.Mesh(new THREE.DodecahedronGeometry(AVATAR_PROPORTIONS.headRadius, 0), material);
      skull.scale.set(0.84, 1.14, 0.78);
      const jaw = makeArmorPlate(0.078, 0.055, 0.055, accentMaterial);
      jaw.position.set(0, -0.077, -0.028);
      const brow = makeArmorPlate(0.096, 0.032, 0.045, material);
      brow.position.set(0, 0.045, -0.058);
      const facePanel = makeArmorPlate(0.074, 0.118, 0.014, accentMaterial);
      facePanel.position.set(0, -0.006, -0.076);
      facePanel.scale.set(0.62, 1, 1);
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.062, 0.016), visorMaterial);
      eye.position.set(-0.024, 0.006, -0.086);
      const rightEar = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.028, 8), jointMaterial);
      const leftEar = rightEar.clone();
      rightEar.rotation.z = Math.PI / 2;
      leftEar.rotation.z = Math.PI / 2;
      rightEar.position.set(0.084, 0.002, -0.004);
      leftEar.position.set(-0.084, 0.002, -0.004);
      const rightEarGlow = new THREE.Mesh(new THREE.TorusGeometry(0.023, 0.0035, 6, 16), glowMaterial);
      const leftEarGlow = rightEarGlow.clone();
      rightEarGlow.rotation.y = Math.PI / 2;
      leftEarGlow.rotation.y = Math.PI / 2;
      rightEarGlow.position.set(0.1, 0.002, -0.004);
      leftEarGlow.position.set(-0.1, 0.002, -0.004);
      head.add(skull, jaw, brow, facePanel, eye, rightEar, leftEar, rightEarGlow, leftEarGlow);

      const neckCore = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.044, 0.16, 6), jointMaterial);
      const torso = new THREE.Group();
      const chestShell = makeArmorPlate(0.25, 0.22, 0.105, material);
      chestShell.position.set(0, 0.045, -0.005);
      const abdomen = new THREE.Mesh(new THREE.CylinderGeometry(0.088, 0.105, 0.14, 6), darkMaterial);
      abdomen.position.set(0, -0.12, 0);
      const chestGlow = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.044, 3), glowMaterial);
      chestGlow.rotation.z = Math.PI;
      chestGlow.position.set(0, 0.064, -0.061);
      torso.add(neckCore, chestShell, abdomen, chestGlow);

      const pelvis = new THREE.Group();
      const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.12, 0.048, 8), jointMaterial);
      const lowerPod = new THREE.Mesh(new THREE.ConeGeometry(0.095, 0.12, 6), darkMaterial);
      lowerPod.position.set(0, -0.082, 0);
      lowerPod.rotation.x = Math.PI;
      const thruster = new THREE.Mesh(new THREE.ConeGeometry(0.042, 0.05, 6), glowMaterial);
      thruster.position.set(0, -0.165, 0);
      thruster.rotation.x = Math.PI;
      pelvis.add(belt, lowerPod, thruster);

      const shoulderGeometry = new THREE.DodecahedronGeometry(0.048, 0);
      const leftShoulder = new THREE.Mesh(shoulderGeometry, material);
      const rightShoulder = new THREE.Mesh(shoulderGeometry.clone(), material);
      leftShoulder.scale.set(1.28, 0.86, 0.92);
      rightShoulder.scale.copy(leftShoulder.scale);
      const leftHand = this.createRobotHand(-1, jointMaterial, glowMaterial);
      const rightHand = this.createRobotHand(1, jointMaterial, glowMaterial);
      const footGeometry = new THREE.BoxGeometry(0.085, 0.045, 0.155);
      const leftFoot = new THREE.Mesh(footGeometry, darkMaterial);
      const rightFoot = new THREE.Mesh(footGeometry.clone(), darkMaterial);

      const limbs = {
        neck: makeSegment(jointMaterial),
        spine: makeSegment(jointMaterial),
        leftUpperArm: makeSegment(darkMaterial),
        leftLowerArm: makeSegment(accentMaterial),
        rightUpperArm: makeSegment(darkMaterial),
        rightLowerArm: makeSegment(accentMaterial),
        leftUpperLeg: makeSegment(jointMaterial),
        leftLowerLeg: makeSegment(jointMaterial),
        rightUpperLeg: makeSegment(jointMaterial),
        rightLowerLeg: makeSegment(jointMaterial),
      };

      group.add(head, torso, pelvis, leftShoulder, rightShoulder, leftHand, rightHand, leftFoot, rightFoot, ...Object.values(limbs));
      return {
        id: options.id || "",
        local: Boolean(options.local),
        group,
        nodes: { head, torso, pelvis, leftShoulder, rightShoulder, leftHand, rightHand, leftFoot, rightFoot },
        limbs,
        targetPose: null,
        currentPose: null,
        lastSeenAt: performance.now(),
      };
    },

    ensureLocalAvatar() {
      if (!this.settings.avatarEnabled || this.theaterMode === "lite") return null;
      this.ensureAvatarGroup();
      if (this.localAvatar || !this.avatarGroup) return this.localAvatar;
      this.localAvatar = this.createAvatarRig({
        id: this.options.avatarId || "local",
        name: this.options.avatarName || "You",
        local: true,
        color: new THREE.Color(0x93c5fd),
      });
      this.avatarGroup.add(this.localAvatar.group);
      return this.localAvatar;
    },

    ensureMirrorAvatar() {
      if (!this.settings.avatarEnabled || !this.settings.avatarMirror || this.theaterMode === "lite") return null;
      this.ensureAvatarGroup();
      if (!this.avatarGroup) return null;
      if (!this.mirrorAvatar) {
        this.mirrorAvatar = this.createAvatarRig({
          id: `${this.options.avatarId || "local"}:mirror`,
          name: "Mirror preview",
          color: new THREE.Color(0x86efac),
        });
        this.avatarGroup.add(this.mirrorAvatar.group);
      }
      if (!this.avatarMirrorFrame) {
        const frame = new THREE.Group();
        frame.name = "avatar-mirror-frame";
        const glassMaterial = new THREE.MeshBasicMaterial({
          color: 0x93c5fd,
          transparent: true,
          opacity: 0.12,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const edgeMaterial = new THREE.MeshBasicMaterial({
          color: 0x93c5fd,
          transparent: true,
          opacity: 0.72,
        });
        const glass = new THREE.Mesh(new THREE.PlaneGeometry(1.25, 2.05), glassMaterial);
        const top = new THREE.Mesh(new THREE.BoxGeometry(1.34, 0.035, 0.035), edgeMaterial);
        const bottom = top.clone();
        const left = new THREE.Mesh(new THREE.BoxGeometry(0.035, 2.12, 0.035), edgeMaterial);
        const right = left.clone();
        top.position.y = 1.06;
        bottom.position.y = -1.06;
        left.position.x = -0.67;
        right.position.x = 0.67;
        frame.add(glass, top, bottom, left, right);
        this.avatarMirrorFrame = frame;
        this.avatarGroup.add(frame);
      }
      this.mirrorAvatar.group.visible = true;
      this.avatarMirrorFrame.visible = true;
      return this.mirrorAvatar;
    },

    clearAvatarObjects() {
      if (this.localAvatar) disposeObjectTree(this.localAvatar.group);
      if (this.mirrorAvatar) disposeObjectTree(this.mirrorAvatar.group);
      if (this.avatarMirrorFrame) disposeObjectTree(this.avatarMirrorFrame);
      for (const avatar of this.remoteAvatars?.values?.() || []) {
        disposeObjectTree(avatar.group);
      }
      this.localAvatar = null;
      this.mirrorAvatar = null;
      this.avatarMirrorFrame = null;
      this.localAvatarPose = null;
      this.localAvatarNetworkPose = null;
      this.localAvatarPoseKey = "";
      this.avatarPinnedAnchor = null;
      this.remoteAvatars = new Map();
      this.avatarGroup?.clear?.();
    },

    setAvatarEnabled(enabled) {
      const next = Boolean(enabled);
      if (this.settings.avatarEnabled === next) return;
      this.settings.avatarEnabled = next;
      if (!next) {
        if (this.localAvatar) {
          disposeObjectTree(this.localAvatar.group);
          this.localAvatar = null;
        }
        this.localAvatarPose = null;
        this.localAvatarNetworkPose = null;
        this.avatarPinnedAnchor = null;
        if (this.mirrorAvatar) {
          disposeObjectTree(this.mirrorAvatar.group);
          this.mirrorAvatar = null;
        }
        if (this.avatarMirrorFrame) {
          disposeObjectTree(this.avatarMirrorFrame);
          this.avatarMirrorFrame = null;
        }
        this.emitAvatarLeave();
        this.avatarStatus = "Avatar body off.";
      } else {
        this.ensureLocalAvatar();
        this.avatarStatus = "Avatar body active.";
      }
      this.saveSettings();
      this.updateWorldOffset();
      this.updateDesktopCamera();
      this.syncOverlayControls();
      this.updateXrSidePanelTexture(true);
    },

    setAvatarViewpoint(enabled) {
      this.settings.avatarViewpoint = Boolean(enabled);
      this.saveSettings();
      this.updateWorldOffset();
      this.updateDesktopCamera();
      this.syncOverlayControls();
      this.updateXrSidePanelTexture(true);
    },

    setAvatarMirrorEnabled(enabled) {
      this.settings.avatarMirror = Boolean(enabled);
      if (!this.settings.avatarMirror) {
        if (this.mirrorAvatar) {
          disposeObjectTree(this.mirrorAvatar.group);
          this.mirrorAvatar = null;
        }
        if (this.avatarMirrorFrame) {
          disposeObjectTree(this.avatarMirrorFrame);
          this.avatarMirrorFrame = null;
        }
      } else if (this.settings.avatarEnabled) {
        this.ensureMirrorAvatar();
      }
      this.saveSettings();
      this.syncOverlayControls();
      this.updateXrSidePanelTexture(true);
    },

    setAvatarPinned(enabled) {
      this.settings.avatarPinned = Boolean(enabled);
      this.avatarPinnedAnchor = this.settings.avatarPinned && this.localAvatarPose
        ? this.avatarAnchorFromPose(this.localAvatarPose)
        : null;
      this.saveSettings();
      this.syncOverlayControls();
      this.updateXrSidePanelTexture(true);
    },

    updateAvatarFrame(deltaSeconds = 0.016, now = performance.now()) {
      if (!this.avatarGroup || this.theaterMode === "lite") return;
      if (this.settings.avatarEnabled) {
        const pose = this.collectLocalAvatarPose();
        if (pose) {
          this.localAvatarPose = pose;
          const avatar = this.ensureLocalAvatar();
          if (avatar) this.renderAvatarPose(avatar, pose);
          if (this.settings.avatarMirror) {
            const mirrorAvatar = this.ensureMirrorAvatar();
            const mirrorPose = this.buildMirrorAvatarPose(pose);
            if (mirrorAvatar && mirrorPose) {
              this.renderAvatarPose(mirrorAvatar, mirrorPose);
              this.updateAvatarMirrorFrame(mirrorPose);
            }
          } else {
            if (this.mirrorAvatar) this.mirrorAvatar.group.visible = false;
            if (this.avatarMirrorFrame) this.avatarMirrorFrame.visible = false;
          }
          this.publishLocalAvatarPose(now);
        }
      }
      for (const [id, avatar] of this.remoteAvatars.entries()) {
        if (now - Number(avatar.lastSeenAt || 0) > AVATAR_REMOTE_TIMEOUT_MS) {
          this.removeRemoteAvatar(id);
          continue;
        }
        if (!avatar.targetPose) continue;
        avatar.currentPose = smoothAvatarPose(avatar.currentPose, avatar.targetPose, deltaSeconds);
        this.renderAvatarPose(avatar, avatar.currentPose);
      }
    },

    collectLocalAvatarPose() {
      if (!this.scene || !this.camera) return null;
      this.scene.updateMatrixWorld(true);
      this.worldGroup?.updateMatrixWorld(true);
      const headPose = this.objectRoomPose(this.xrSession ? this.renderer?.xr?.getCamera?.(this.camera) : this.camera);
      if (!headPose) return null;
      const leftTracked = this.trackedHandPose("left") || this.trackedControllerPose("left");
      const rightTracked = this.trackedHandPose("right") || this.trackedControllerPose("right");
      const bodyYaw = yawFromQuaternion(headPose.quaternion);
      const pose = normalizeAvatarPose({
        enabled: true,
        avatarViewpoint: Boolean(this.settings.avatarViewpoint),
        sequence: this.avatarPoseSequence + 1,
        body: { yaw: bodyYaw },
        head: { position: headPose.position, quaternion: headPose.quaternion, tracked: true },
        leftHand: leftTracked || {
          position: inferredHand(headPose.position, bodyYaw, -1),
          quaternion: headPose.quaternion,
          tracked: false,
        },
        rightHand: rightTracked || {
          position: inferredHand(headPose.position, bodyYaw, 1),
          quaternion: headPose.quaternion,
          tracked: false,
        },
      });
      if (!pose) return null;
      let renderedPose = pose;
      let mode = this.settings.avatarMirror ? "Mirror" : "Avatar";
      const seatAnchor = this.avatarSeatAnchor();
      if (seatAnchor) {
        renderedPose = this.applyAvatarAnchor(pose, seatAnchor);
        mode = "Seated";
      } else if (this.settings.avatarPinned) {
        renderedPose = this.applyAvatarPin(pose);
        mode = "Pinned";
      } else {
        renderedPose = this.applyAvatarAnchor(pose, this.avatarStandingAnchor(pose));
        mode = this.settings.avatarMirror ? "Mirror" : "Standing";
      }
      this.avatarPoseSequence = pose.sequence;
      this.localAvatarNetworkPose = renderedPose;
      const trackedHands = [renderedPose.leftHand.tracked, renderedPose.rightHand.tracked].filter(Boolean).length;
      this.avatarStatus = trackedHands
        ? `${mode} body active. ${trackedHands} hand${trackedHands === 1 ? "" : "s"} tracked.`
        : `${mode} body active. Hands simulated.`;
      return renderedPose;
    },

    avatarStandingAnchor(pose) {
      return {
        headPosition: new THREE.Vector3(
          Number(pose.head.position.x || 0),
          AVATAR_STANDING_TOP_Y - AVATAR_HEAD_TOP_OFFSET,
          Number(pose.head.position.z || 0),
        ),
        bodyYaw: Number(pose.body?.yaw || 0),
        seated: false,
      };
    },

    avatarSeatForCurrentView() {
      if (typeof this.themeSeatingPositions !== "function") return null;
      const selected = typeof this.currentSeat === "function" ? this.currentSeat() : null;
      if (selected) return selected;
      if (this.settings.freeRoam) return null;
      const viewX = Number(this.settings.roomViewX || 0);
      const viewZ = Number(this.settings.roomViewZ || 0);
      const viewYaw = Number(this.settings.roomViewYaw || 0);
      let best = null;
      let bestDistanceSq = Infinity;
      for (const seat of this.themeSeatingPositions()) {
        const dx = viewX - Number(seat.x || 0);
        const dz = viewZ - Number(seat.z || 0);
        const distanceSq = dx * dx + dz * dz;
        if (distanceSq > AVATAR_SEAT_MATCH_DISTANCE * AVATAR_SEAT_MATCH_DISTANCE) continue;
        if (angleDeltaDegrees(viewYaw, seat.yaw) > AVATAR_SEAT_MATCH_YAW_DEGREES) continue;
        if (distanceSq < bestDistanceSq) {
          best = seat;
          bestDistanceSq = distanceSq;
        }
      }
      return best;
    },

    avatarSeatAnchor() {
      const seat = this.avatarSeatForCurrentView();
      if (!seat) return null;
      const bodyYaw = THREE.MathUtils.degToRad(Number(seat.yaw ?? this.settings.roomViewYaw ?? 0));
      const bodyRotation = new THREE.Quaternion().setFromAxisAngle(UP, bodyYaw);
      const right = RIGHT.clone().applyQuaternion(bodyRotation);
      const forward = FORWARD.clone().applyQuaternion(bodyRotation);
      const avatarOffset = vectorFrom(seat.avatarOffset, new THREE.Vector3());
      const backOffset = seat.avatarBackOffset != null && Number.isFinite(Number(seat.avatarBackOffset))
        ? Number(seat.avatarBackOffset)
        : AVATAR_SEATED_BACK_OFFSET;
      const cushionToTop = seat.avatarCushionToTop != null && Number.isFinite(Number(seat.avatarCushionToTop))
        ? Number(seat.avatarCushionToTop)
        : AVATAR_SEATED_CUSHION_TO_TOP;
      const anchorPosition = vectorFrom(seat.avatarPosition, new THREE.Vector3(
        Number(seat.x ?? this.settings.roomViewX ?? 0),
        Number(seat.y ?? this.settings.roomViewY ?? 0),
        Number(seat.z ?? this.settings.roomViewZ ?? 0),
      ));
      const cushionPosition = anchorPosition
        .add(right.multiplyScalar(avatarOffset.x))
        .add(UP.clone().multiplyScalar(avatarOffset.y))
        .add(forward.clone().multiplyScalar(avatarOffset.z));
      const backward = forward.multiplyScalar(-backOffset);
      return {
        headPosition: new THREE.Vector3(
          cushionPosition.x + backward.x,
          cushionPosition.y + cushionToTop - AVATAR_HEAD_TOP_OFFSET,
          cushionPosition.z + backward.z,
        ),
        bodyYaw,
        seated: true,
      };
    },

    avatarViewpointAnchor() {
      if (!this.settings.avatarEnabled || !this.settings.avatarViewpoint || this.theaterMode === "lite") return null;
      const seatAnchor = this.avatarSeatAnchor();
      if (seatAnchor) return seatAnchor;
      if (this.settings.avatarPinned && this.avatarPinnedAnchor?.headPosition) return this.avatarPinnedAnchor;
      return {
        headPosition: new THREE.Vector3(
          Number(this.settings.roomViewX || 0),
          AVATAR_STANDING_TOP_Y - AVATAR_HEAD_TOP_OFFSET,
          Number(this.settings.roomViewZ || 0),
        ),
        bodyYaw: THREE.MathUtils.degToRad(Number(this.settings.roomViewYaw || 0)),
        seated: false,
      };
    },

    avatarAnchorFromPose(pose) {
      return {
        headPosition: pose.head.position.clone(),
        bodyYaw: Number(pose.body?.yaw || 0),
        seated: Boolean(pose.renderSeated),
      };
    },

    applyAvatarAnchor(pose, anchor) {
      if (!pose || !anchor?.headPosition) return pose;
      const yawDelta = Number(anchor.bodyYaw || 0) - Number(pose.body?.yaw || 0);
      const yawQuaternion = new THREE.Quaternion().setFromAxisAngle(UP, yawDelta);
      const transformPart = (part) => {
        const relative = part.position.clone().sub(pose.head.position).applyAxisAngle(UP, yawDelta);
        return {
          position: anchor.headPosition.clone().add(relative),
          quaternion: yawQuaternion.clone().multiply(part.quaternion).normalize(),
          tracked: part.tracked,
        };
      };
      return {
        ...pose,
        renderSeated: Boolean(anchor.seated || pose.renderSeated),
        body: {
          yaw: anchor.bodyYaw,
          seated: Boolean(anchor.seated || pose.renderSeated),
        },
        head: transformPart(pose.head),
        leftHand: transformPart(pose.leftHand),
        rightHand: transformPart(pose.rightHand),
      };
    },

    applyAvatarPin(pose) {
      if (!this.avatarPinnedAnchor) {
        this.avatarPinnedAnchor = this.avatarAnchorFromPose(pose);
      }
      return this.applyAvatarAnchor(pose, this.avatarPinnedAnchor);
    },

    buildMirrorAvatarPose(pose) {
      const liveHead = pose.renderSeated
        ? pose.head
        : this.objectRoomPose(this.xrSession ? this.renderer?.xr?.getCamera?.(this.camera) : this.camera) || pose.head;
      const forward = FORWARD.clone().applyQuaternion(liveHead.quaternion);
      forward.y = 0;
      if (forward.lengthSq() < 0.000001) {
        forward.set(-Math.sin(pose.body.yaw), 0, -Math.cos(pose.body.yaw));
      } else {
        forward.normalize();
      }
      const mirrorDistance = pose.renderSeated ? 0.72 : 1.55;
      const mirrorHeadPosition = liveHead.position.clone().add(forward.clone().multiplyScalar(mirrorDistance));
      mirrorHeadPosition.y = liveHead.position.y - (pose.renderSeated ? 0.01 : 0.04);
      const toViewer = liveHead.position.clone().sub(mirrorHeadPosition);
      toViewer.y = 0;
      if (toViewer.lengthSq() < 0.000001) toViewer.copy(forward).multiplyScalar(-1);
      toViewer.normalize();
      const mirrorYaw = Math.atan2(-toViewer.x, -toViewer.z);
      const yawDelta = mirrorYaw - Number(pose.body?.yaw || 0);
      const yawQuaternion = new THREE.Quaternion().setFromAxisAngle(UP, yawDelta);
      const transformPart = (part) => {
        const relative = part.position.clone().sub(pose.head.position).applyAxisAngle(UP, yawDelta);
        return {
          position: mirrorHeadPosition.clone().add(relative),
          quaternion: yawQuaternion.clone().multiply(part.quaternion).normalize(),
          tracked: part.tracked,
        };
      };
      return {
        ...pose,
        body: { yaw: mirrorYaw, seated: Boolean(pose.renderSeated) },
        head: transformPart(pose.head),
        leftHand: transformPart(pose.leftHand),
        rightHand: transformPart(pose.rightHand),
      };
    },

    updateAvatarMirrorFrame(mirrorPose) {
      if (!this.avatarMirrorFrame || !mirrorPose?.head) return;
      const liveHead = mirrorPose.renderSeated
        ? this.localAvatarPose?.head || mirrorPose.head
        : this.objectRoomPose(this.xrSession ? this.renderer?.xr?.getCamera?.(this.camera) : this.camera) || mirrorPose.head;
      const framePosition = mirrorPose.head.position.clone();
      const toViewer = liveHead.position.clone().sub(framePosition);
      toViewer.y = 0;
      if (toViewer.lengthSq() < 0.000001) {
        toViewer.set(Math.sin(mirrorPose.body.yaw), 0, Math.cos(mirrorPose.body.yaw));
      } else {
        toViewer.normalize();
      }
      framePosition.y -= 0.48;
      framePosition.add(toViewer.clone().multiplyScalar(-0.16));
      this.avatarMirrorFrame.position.copy(framePosition);
      this.avatarMirrorFrame.lookAt(liveHead.position.x, framePosition.y, liveHead.position.z);
    },

    objectRoomPose(object) {
      if (!object || !this.worldGroup) return null;
      object.updateMatrixWorld?.(true);
      const position = new THREE.Vector3().setFromMatrixPosition(object.matrixWorld);
      const quaternion = object.getWorldQuaternion
        ? object.getWorldQuaternion(new THREE.Quaternion())
        : new THREE.Quaternion().setFromRotationMatrix(object.matrixWorld);
      return this.scenePoseToRoomPose(position, quaternion);
    },

    scenePoseToRoomPose(position, quaternion) {
      if (!this.worldGroup) return { position: position.clone(), quaternion: quaternion.clone() };
      this.worldGroup.updateMatrixWorld(true);
      const roomPosition = position.clone();
      this.worldGroup.worldToLocal(roomPosition);
      const worldQuaternion = this.worldGroup.getWorldQuaternion(new THREE.Quaternion()).invert();
      const roomQuaternion = worldQuaternion.multiply(quaternion.clone()).normalize();
      return { position: roomPosition, quaternion: roomQuaternion };
    },

    trackedControllerPose(handedness) {
      const controller = this.controllers.find((item) => item.userData.inputSource?.handedness === handedness);
      if (!controller?.userData?.inputSource || controller.visible === false) return null;
      const pose = this.objectRoomPose(controller);
      if (!pose) return null;
      return { ...pose, tracked: true };
    },

    trackedHandPose(handedness) {
      const hand = this.hands.find((item) => item.userData.inputSource?.handedness === handedness);
      const joints = hand?.joints || {};
      const joint = joints.wrist || joints["index-finger-metacarpal"] || joints["middle-finger-metacarpal"];
      if (!joint?.visible) return null;
      const pose = this.objectRoomPose(joint);
      if (!pose) return null;
      return { ...pose, tracked: true };
    },

    publishLocalAvatarPose(now = performance.now()) {
      if (!this.localAvatarPose || typeof this.options.onAvatarPose !== "function") return;
      if (now - this.lastAvatarPoseSentAt < AVATAR_POSE_SEND_INTERVAL_MS) return;
      this.lastAvatarPoseSentAt = now;
      this.options.onAvatarPose(packAvatarPose(this.localAvatarNetworkPose || this.localAvatarPose));
    },

    emitAvatarLeave() {
      if (typeof this.options.onAvatarLeave === "function") {
        this.options.onAvatarLeave({
          id: this.options.avatarId || "local",
          sentAt: Date.now(),
        });
      } else if (typeof this.options.onAvatarPose === "function") {
        this.options.onAvatarPose({
          version: 1,
          enabled: false,
          sentAt: Date.now(),
          sequence: this.avatarPoseSequence,
        });
      }
    },

    applyRemoteAvatarPose(id, pose, meta = {}) {
      const avatarId = String(id || "");
      if (!avatarId || avatarId === String(this.options.avatarId || "")) return;
      const normalized = normalizeAvatarPose(pose);
      if (!normalized || normalized.enabled === false) {
        this.removeRemoteAvatar(avatarId);
        return;
      }
      this.ensureAvatarGroup();
      if (!this.avatarGroup) return;
      let avatar = this.remoteAvatars.get(avatarId);
      if (!avatar) {
        avatar = this.createAvatarRig({
          id: avatarId,
          name: meta.name || avatarId,
          color: avatarColorForId(avatarId),
        });
        this.remoteAvatars.set(avatarId, avatar);
        this.avatarGroup.add(avatar.group);
      }
      avatar.targetPose = normalized;
      avatar.lastSeenAt = performance.now();
      if (!avatar.currentPose) avatar.currentPose = cloneAvatarPose(normalized);
      this.renderAvatarPose(avatar, avatar.currentPose);
    },

    removeRemoteAvatar(id) {
      const avatarId = String(id || "");
      const avatar = this.remoteAvatars.get(avatarId);
      if (!avatar) return;
      disposeObjectTree(avatar.group);
      this.remoteAvatars.delete(avatarId);
    },

    renderAvatarPose(avatar, pose) {
      if (!avatar?.group || !pose?.enabled) {
        if (avatar?.group) avatar.group.visible = false;
        return;
      }
      const joints = inferAvatarJoints(pose);
      avatar.group.visible = true;
      avatar.nodes.head.position.copy(joints.head);
      avatar.nodes.head.quaternion.copy(pose.head.quaternion);
      avatar.nodes.head.visible = !(avatar.local && this.settings.avatarViewpoint);
      avatar.nodes.torso.position.copy(joints.chest.clone().lerp(joints.pelvis, 0.46));
      avatar.nodes.torso.quaternion.copy(joints.bodyRotation);
      avatar.nodes.pelvis.position.copy(joints.pelvis);
      avatar.nodes.pelvis.quaternion.copy(joints.bodyRotation);
      avatar.nodes.leftShoulder.position.copy(joints.leftShoulder);
      avatar.nodes.leftShoulder.quaternion.copy(joints.bodyRotation);
      avatar.nodes.rightShoulder.position.copy(joints.rightShoulder);
      avatar.nodes.rightShoulder.quaternion.copy(joints.bodyRotation);
      avatar.nodes.leftHand.position.copy(joints.leftHand);
      avatar.nodes.leftHand.quaternion.copy(pose.leftHand.quaternion);
      avatar.nodes.rightHand.position.copy(joints.rightHand);
      avatar.nodes.rightHand.quaternion.copy(pose.rightHand.quaternion);
      avatar.nodes.leftFoot.position.copy(joints.leftFoot);
      avatar.nodes.leftFoot.quaternion.copy(joints.bodyRotation);
      avatar.nodes.rightFoot.position.copy(joints.rightFoot);
      avatar.nodes.rightFoot.quaternion.copy(joints.bodyRotation);
      avatar.nodes.leftFoot.visible = false;
      avatar.nodes.rightFoot.visible = false;

      setSegment(avatar.limbs.neck, joints.neck, joints.head, 0.022);
      setSegment(avatar.limbs.spine, joints.chest, joints.pelvis, 0.034);
      setSegment(avatar.limbs.leftUpperArm, joints.leftShoulder, joints.leftElbow, 0.018);
      setSegment(avatar.limbs.leftLowerArm, joints.leftElbow, joints.leftHand, 0.016);
      setSegment(avatar.limbs.rightUpperArm, joints.rightShoulder, joints.rightElbow, 0.018);
      setSegment(avatar.limbs.rightLowerArm, joints.rightElbow, joints.rightHand, 0.016);
      avatar.limbs.leftUpperLeg.visible = false;
      avatar.limbs.leftLowerLeg.visible = false;
      avatar.limbs.rightUpperLeg.visible = false;
      avatar.limbs.rightLowerLeg.visible = false;
    },
  });
})();
