import * as THREE from './node_modules/three/build/three.module.js';

const WIDTH = 240;
const HEIGHT = 224;
const SCALE = 18;
const RED_START = new THREE.Color('#ff4d4d');
const RED_END = new THREE.Color('#991b1b');
const DARK = new THREE.MeshBasicMaterial({color: '#050810'});
const TEAL = new THREE.MeshBasicMaterial({color: '#00e5cc'});
const ANTENNA = new THREE.MeshBasicMaterial({color: '#ff4d4d'});

const sx = value => (value - 60) / SCALE;
const sy = value => (60 - value) / SCALE;

function shellMaterial() {
  const material = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      startColor: {value: RED_START},
      endColor: {value: RED_END},
      keyDirection: {value: new THREE.Vector3(-0.4, 0.55, 1).normalize()},
    },
    vertexShader: `
      varying vec3 vNormalView;
      varying vec3 vPosition;
      void main() {
        vPosition = position;
        vNormalView = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 startColor;
      uniform vec3 endColor;
      uniform vec3 keyDirection;
      varying vec3 vNormalView;
      varying vec3 vPosition;
      void main() {
        float gradient = clamp((vPosition.x + 3.4) / 6.8 * .5
          + (3.4 - vPosition.y) / 6.8 * .5, 0.0, 1.0);
        vec3 base = mix(startColor, endColor, gradient);
        float diffuse = .95 + .05 * max(dot(normalize(vNormalView), keyDirection), 0.0);
        float rim = pow(1.0 - max(vNormalView.z, 0.0), 2.5) * .04;
        gl_FragColor = vec4(base * diffuse + startColor * rim, 1.0);
      }
    `,
  });
  material.toneMapped = false;
  return material;
}

function bodyShape() {
  const shape = new THREE.Shape();
  shape.moveTo(sx(60), sy(10));
  shape.bezierCurveTo(sx(30), sy(10), sx(15), sy(35), sx(15), sy(55));
  shape.bezierCurveTo(sx(15), sy(75), sx(30), sy(95), sx(45), sy(100));
  shape.bezierCurveTo(sx(50), sy(101), sx(55), sy(102), sx(60), sy(102));
  shape.bezierCurveTo(sx(65), sy(102), sx(70), sy(101), sx(75), sy(100));
  shape.bezierCurveTo(sx(90), sy(95), sx(105), sy(75), sx(105), sy(55));
  shape.bezierCurveTo(sx(105), sy(35), sx(90), sy(10), sx(60), sy(10));
  return shape;
}

function footShape(side) {
  const center = side < 0 ? 50 : 70;
  const shape = new THREE.Shape();
  shape.moveTo(sx(center - 5), sy(98));
  shape.lineTo(sx(center + 5), sy(98));
  shape.lineTo(sx(center + 5), sy(110));
  shape.lineTo(sx(center - 5), sy(110));
  shape.closePath();
  return shape;
}

function clawShape(side) {
  const shape = new THREE.Shape();
  if (side < 0) {
    shape.moveTo(sx(20), sy(45));
    shape.bezierCurveTo(sx(5), sy(40), sx(0), sy(50), sx(5), sy(60));
    shape.bezierCurveTo(sx(10), sy(70), sx(20), sy(65), sx(25), sy(55));
    shape.bezierCurveTo(sx(28), sy(48), sx(25), sy(45), sx(20), sy(45));
  } else {
    shape.moveTo(sx(100), sy(45));
    shape.bezierCurveTo(sx(115), sy(40), sx(120), sy(50), sx(115), sy(60));
    shape.bezierCurveTo(sx(110), sy(70), sx(100), sy(65), sx(95), sy(55));
    shape.bezierCurveTo(sx(92), sy(48), sx(95), sy(45), sx(100), sy(45));
  }
  return shape;
}

function inflatedGeometry(shape, depth, center, segments = 128, rings = 12) {
  const outline = shape.getSpacedPoints(segments);
  const vertices = [center.x, center.y, depth, center.x, center.y, -depth];
  const indices = [];
  const frontRings = [], backRings = [];
  for (let ring = 1; ring <= rings; ++ring) {
    const ratio = ring / rings;
    const z = depth * Math.sqrt(Math.max(0, 1 - ratio * ratio));
    const front = [], back = [];
    for (const point of outline) {
      const x = center.x + (point.x - center.x) * ratio;
      const y = center.y + (point.y - center.y) * ratio;
      front.push(vertices.length / 3);
      vertices.push(x, y, z);
      back.push(vertices.length / 3);
      vertices.push(x, y, -z);
    }
    frontRings.push(front);
    backRings.push(back);
  }
  const count = outline.length;
  for (let i = 0; i < count; ++i) {
    const next = (i + 1) % count;
    indices.push(0, frontRings[0][i], frontRings[0][next]);
    indices.push(1, backRings[0][next], backRings[0][i]);
  }
  for (let ring = 1; ring < rings; ++ring) {
    const previousFront = frontRings[ring - 1], front = frontRings[ring];
    const previousBack = backRings[ring - 1], back = backRings[ring];
    for (let i = 0; i < count; ++i) {
      const next = (i + 1) % count;
      indices.push(previousFront[i], front[i], front[next],
        previousFront[i], front[next], previousFront[next]);
      indices.push(previousBack[i], back[next], back[i],
        previousBack[i], previousBack[next], back[next]);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createBody(material) {
  const geometry = inflatedGeometry(bodyShape(), 1.45, new THREE.Vector2(0, -.05));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'body-shell';
  return mesh;
}

function createClaw(side, material) {
  const pivot = new THREE.Group();
  pivot.name = side < 0 ? 'left-claw-pivot' : 'right-claw-pivot';
  const anchor = new THREE.Vector3(sx(side < 0 ? 25 : 95), sy(53), .08);
  const wristCenter = new THREE.Vector3(
    sx(side < 0 ? 15 : 105), sy(55), .08);
  const geometry = inflatedGeometry(
    clawShape(side), .6, new THREE.Vector2(side * 2.55, .3), 72, 10);
  geometry.translate(-wristCenter.x, -wristCenter.y, 0);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = side < 0 ? 'left-claw' : 'right-claw';
  const wrist = new THREE.Group();
  wrist.name = side < 0 ? 'left-wrist-pivot' : 'right-wrist-pivot';
  wrist.position.copy(wristCenter).sub(anchor);
  const wavePincer = new THREE.Group();
  wavePincer.name = side < 0 ? 'left-wave-pincer' : 'right-wave-pincer';
  const palm = new THREE.Mesh(new THREE.SphereGeometry(.34, 28, 18), material);
  palm.scale.set(1.05, .9, .72);
  const upperFinger = new THREE.Mesh(new THREE.SphereGeometry(.25, 24, 16), material);
  upperFinger.position.set(side * .28, .25, .02);
  upperFinger.rotation.z = side * -.28;
  upperFinger.scale.set(1.35, .55, .68);
  const lowerFinger = upperFinger.clone();
  lowerFinger.position.y = -.25;
  lowerFinger.rotation.z *= -1;
  wavePincer.add(palm, upperFinger, lowerFinger);
  wavePincer.visible = false;
  wrist.add(mesh);
  wrist.add(wavePincer);
  pivot.position.copy(anchor);
  pivot.add(wrist);
  pivot.userData.wrist = wrist;
  pivot.userData.handMesh = mesh;
  pivot.userData.wavePincer = wavePincer;
  return pivot;
}

function createFoot(side, material) {
  const centerX = sx(side < 0 ? 50 : 70);
  const anchor = new THREE.Vector3(centerX, sy(98), -.04);
  const geometry = inflatedGeometry(
    footShape(side), .48, new THREE.Vector2(centerX, sy(104)), 40, 8);
  geometry.translate(-anchor.x, -anchor.y, 0);
  const pivot = new THREE.Group();
  pivot.name = side < 0 ? 'left-foot-pivot' : 'right-foot-pivot';
  pivot.position.copy(anchor);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = side < 0 ? 'left-foot' : 'right-foot';
  pivot.add(mesh);
  return pivot;
}

function createAntenna(side, material) {
  const pivot = new THREE.Group();
  pivot.name = side < 0 ? 'left-antenna-pivot' : 'right-antenna-pivot';
  const base = new THREE.Vector3(sx(side < 0 ? 45 : 75), sy(15), .58);
  const control = new THREE.Vector3(
    sx(side < 0 ? 35 : 85) - base.x, sy(5) - base.y, -.22);
  const end = new THREE.Vector3(
    sx(side < 0 ? 30 : 90) - base.x, sy(8) - base.y, -.32);
  const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(), control, end);
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.085, 10, false), material);
  pivot.position.copy(base);
  pivot.add(mesh);
  return pivot;
}

function createWaveArmSegment(name, material) {
  const segment = new THREE.Mesh(
    new THREE.CylinderGeometry(.24, .3, 1, 24), material);
  segment.name = name;
  segment.visible = false;
  return segment;
}

function createWaveElbow(material) {
  const elbow = new THREE.Mesh(new THREE.SphereGeometry(.29, 24, 16), material);
  elbow.name = 'right-wave-elbow';
  elbow.visible = false;
  return elbow;
}

function createEye(side) {
  const pivot = new THREE.Group();
  pivot.name = side < 0 ? 'left-eye-pivot' : 'right-eye-pivot';
  pivot.position.set(sx(side < 0 ? 45 : 75), sy(35), 1.31);
  const sclera = new THREE.Mesh(new THREE.SphereGeometry(.34, 32, 20), DARK);
  sclera.scale.z = .32;
  sclera.name = 'sclera';
  const pupil = new THREE.Mesh(new THREE.SphereGeometry(.14, 24, 16), TEAL);
  pupil.position.set(.055, .055, .315);
  pupil.scale.z = .38;
  pupil.name = 'pupil';
  pivot.add(sclera, pupil);
  return {pivot, sclera, pupil};
}

export function createOpenClawScene(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, alpha: false, preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  renderer.setSize(WIDTH, HEIGHT, false);
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;

  const scene = new THREE.Scene();
  const aspect = WIDTH / HEIGHT;
  const camera = new THREE.OrthographicCamera(-4 * aspect, 4 * aspect, 4, -4, 0.1, 30);
  camera.position.set(0, 0, 12);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x121722, 1.55));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(-4, 6, 8);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffb8b8, .65);
  fill.position.set(5, 1, 5);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0x00e5cc, .45);
  rim.position.set(0, 4, -6);
  scene.add(rim);

  const shell = shellMaterial();
  const root = new THREE.Group();
  root.name = 'openclaw-root';
  root.position.y = .08;
  root.scale.setScalar(1.18);
  const body = createBody(shell);
  const leftClaw = createClaw(-1, shell);
  const rightClaw = createClaw(1, shell);
  const leftWrist = leftClaw.userData.wrist;
  const rightWrist = rightClaw.userData.wrist;
  const rightHandMesh = rightClaw.userData.handMesh;
  const rightWavePincer = rightClaw.userData.wavePincer;
  const rightUpperArm = createWaveArmSegment('right-wave-upper-arm', shell);
  const rightForearm = createWaveArmSegment('right-wave-forearm', shell);
  const rightElbow = createWaveElbow(shell);
  const leftFoot = createFoot(-1, shell);
  const rightFoot = createFoot(1, shell);
  const leftAntenna = createAntenna(-1, ANTENNA);
  const rightAntenna = createAntenna(1, ANTENNA);
  const leftEye = createEye(-1);
  const rightEye = createEye(1);
  root.add(leftFoot, rightFoot, rightUpperArm, rightForearm, rightElbow,
    body, leftClaw, rightClaw,
    leftAntenna, rightAntenna,
    leftEye.pivot, rightEye.pivot);
  scene.add(root);

  root.userData.sculptRuntime = {
    pivots: {root, leftClaw, rightClaw, leftWrist, rightWrist,
      rightUpperArm, rightForearm, rightElbow,
      leftFoot, rightFoot, leftAntenna, rightAntenna,
      leftEye: leftEye.pivot, rightEye: rightEye.pivot},
    sockets: {
      leftClaw: leftClaw.position.clone(), rightClaw: rightClaw.position.clone(),
      leftAntenna: leftAntenna.position.clone(), rightAntenna: rightAntenna.position.clone(),
    },
    colliders: [{id: 'body', type: 'inflated-contour', scale: [2.55, 2.78, 1.45]}],
  };

  const neutral = {
    rootPosition: root.position.clone(),
    rootScale: root.scale.clone(),
    leftClawPosition: leftClaw.position.clone(),
    rightClawPosition: rightClaw.position.clone(),
    leftFootPosition: leftFoot.position.clone(),
    rightFootPosition: rightFoot.position.clone(),
    leftClaw: leftClaw.rotation.clone(), rightClaw: rightClaw.rotation.clone(),
    leftWrist: leftWrist.rotation.clone(), rightWrist: rightWrist.rotation.clone(),
    leftFoot: leftFoot.rotation.clone(), rightFoot: rightFoot.rotation.clone(),
    leftAntenna: leftAntenna.rotation.clone(), rightAntenna: rightAntenna.rotation.clone(),
  };

  function reset() {
    root.position.copy(neutral.rootPosition);
    root.rotation.set(0, 0, 0);
    root.scale.copy(neutral.rootScale);
    leftClaw.position.copy(neutral.leftClawPosition);
    rightClaw.position.copy(neutral.rightClawPosition);
    leftFoot.position.copy(neutral.leftFootPosition);
    rightFoot.position.copy(neutral.rightFootPosition);
    leftClaw.rotation.copy(neutral.leftClaw);
    rightClaw.rotation.copy(neutral.rightClaw);
    leftWrist.rotation.copy(neutral.leftWrist);
    rightWrist.rotation.copy(neutral.rightWrist);
    rightHandMesh.visible = true;
    rightWavePincer.visible = false;
    for (const segment of [rightUpperArm, rightForearm, rightElbow]) {
      segment.visible = false;
      segment.position.set(0, 0, 0);
      segment.rotation.set(0, 0, 0);
      segment.scale.set(1, 1, 1);
    }
    leftFoot.rotation.copy(neutral.leftFoot);
    rightFoot.rotation.copy(neutral.rightFoot);
    leftAntenna.rotation.copy(neutral.leftAntenna);
    rightAntenna.rotation.copy(neutral.rightAntenna);
    for (const eye of [leftEye, rightEye]) {
      eye.pivot.position.x = sx(eye === leftEye ? 45 : 75);
      eye.pivot.position.y = sy(35);
      eye.sclera.scale.set(1, 1, .32);
      eye.pupil.scale.set(1, 1, .38);
      eye.pupil.position.set(.055, .055, .315);
      eye.pupil.visible = true;
    }
  }

  function applyPose(track, step, blinkLevel) {
    reset();
    const t = Math.max(0, Math.min(1, step / 23));
    const eased = t * t * (3 - 2 * t);
    const directions = {
      right: [-38, 0], left: [38, 0], up: [0, 22], down: [0, -22],
      up_right: [-32, 18], up_left: [32, 18],
      down_right: [0, -22], down_left: [0, -22],
    };
    if (directions[track]) {
      const horizontalTurn = directions[track][0] / 38;
      const followThrough = Math.min(1, eased + .12 * Math.sin(Math.PI * t));
      const leftLift = .09 + .14 * Math.max(horizontalTurn, 0);
      const rightLift = .09 + .14 * Math.max(-horizontalTurn, 0);
      root.rotation.y = THREE.MathUtils.degToRad(directions[track][0] * eased);
      root.rotation.x = THREE.MathUtils.degToRad(directions[track][1] * eased);
      root.rotation.z = THREE.MathUtils.degToRad(-2.2 * horizontalTurn * followThrough);
      root.position.y += .045 * Math.sin(Math.PI * t);
      leftClaw.rotation.z = -leftLift * followThrough;
      rightClaw.rotation.z = rightLift * followThrough;
      leftClaw.rotation.y = -.08 * horizontalTurn * followThrough;
      rightClaw.rotation.y = -.08 * horizontalTurn * followThrough;
      leftClaw.position.x -= .045 * followThrough;
      rightClaw.position.x += .045 * followThrough;
      leftClaw.position.y += (.065 + .095 * Math.max(horizontalTurn, 0)) * followThrough;
      rightClaw.position.y += (.065 + .095 * Math.max(-horizontalTurn, 0)) * followThrough;
      leftAntenna.rotation.z = .075 * horizontalTurn * followThrough;
      rightAntenna.rotation.z = .075 * horizontalTurn * followThrough;
      if (track === 'right') {
        const waveLift = THREE.MathUtils.smoothstep(t, 0, .28);
        const waveProgress = Math.max(0, (t - .28) / .72);
        const wristWave = Math.sin(4 * Math.PI * waveProgress);
        root.rotation.y = THREE.MathUtils.degToRad(-8 * waveLift);
        rightClaw.rotation.z += .38 * waveLift;
        rightClaw.rotation.y -= .14 * waveLift;
        rightClaw.position.x += .48 * waveLift;
        rightClaw.position.y += 1.28 * waveLift;
        rightWrist.rotation.z = .58 * wristWave;
        rightWrist.rotation.y = -.18 * waveLift + .12 * wristWave;
        root.rotation.z += THREE.MathUtils.degToRad(-2.8 * waveLift);
        leftClaw.rotation.z -= .08 * waveLift;
        leftEye.pupil.position.x += .035 * waveLift;
        rightEye.pupil.position.x += .035 * waveLift;
        leftEye.pupil.position.y += .025 * waveLift;
        rightEye.pupil.position.y += .025 * waveLift;
        if (waveLift > .01) {
          const shoulder = neutral.rightClawPosition;
          const elbow = new THREE.Vector3(
            shoulder.x + .52 * waveLift, shoulder.y + .58 * waveLift, -.08);
          const wrist = rightWrist.position.clone()
            .applyQuaternion(rightClaw.quaternion)
            .add(rightClaw.position);
          const placeSegment = (segment, start, end) => {
            const direction = new THREE.Vector3().subVectors(end, start);
            segment.visible = true;
            segment.position.copy(start).add(end).multiplyScalar(.5);
            segment.position.z = -.08;
            segment.scale.y = direction.length();
            segment.quaternion.setFromUnitVectors(
              new THREE.Vector3(0, 1, 0), direction.normalize());
          };
          placeSegment(rightUpperArm, shoulder, elbow);
          placeSegment(rightForearm, elbow, wrist);
          rightElbow.visible = true;
          rightElbow.position.copy(elbow);
          rightHandMesh.visible = false;
          rightWavePincer.visible = true;
        }
      }
    } else if (track === 'surprise') {
      const spring = Math.sin(Math.PI * t) * Math.exp(-1.35 * t);
      root.scale.copy(neutral.rootScale).multiplyScalar(1 - .15 * spring);
      root.position.y -= .18 * spring;
      leftClaw.rotation.z = -.38 * spring;
      rightClaw.rotation.z = .38 * spring;
      leftAntenna.rotation.z = -.24 * spring;
      rightAntenna.rotation.z = .24 * spring;
      for (const eye of [leftEye, rightEye]) eye.sclera.scale.multiplyScalar(1 + .28 * spring);
    } else if (track === 'working') {
      const phase = step ? (step - 1) / 22 * Math.PI * 2 : 0;
      const stride = Math.sin(phase);
      const bounce = Math.abs(stride);
      const leftStep = Math.max(stride, 0);
      const rightStep = Math.max(-stride, 0);
      root.rotation.y = THREE.MathUtils.degToRad(5 * stride);
      root.rotation.z = THREE.MathUtils.degToRad(-1.8 * stride);
      root.position.y += .035 + .085 * bounce;
      leftFoot.position.y += .19 * leftStep;
      rightFoot.position.y += .19 * rightStep;
      leftFoot.rotation.z = THREE.MathUtils.degToRad(-5 * leftStep);
      rightFoot.rotation.z = THREE.MathUtils.degToRad(5 * rightStep);
      leftClaw.rotation.z = -.15 + .08 * stride;
      rightClaw.rotation.z = .15 + .08 * stride;
      leftClaw.position.y += .055 * rightStep;
      rightClaw.position.y += .055 * leftStep;
      leftAntenna.rotation.z = -.035 * stride;
      rightAntenna.rotation.z = -.035 * stride;
      leftEye.pupil.position.x += .035 + .018 * stride;
      rightEye.pupil.position.x += .035 + .018 * stride;
      leftEye.pupil.position.y -= .045;
      rightEye.pupil.position.y -= .045;
    } else if (track === 'complete') {
      root.position.y += .16 * Math.sin(Math.PI * t);
      leftClaw.rotation.z = -.72 * eased;
      rightClaw.rotation.z = .72 * eased;
      leftAntenna.rotation.z = -.16 * eased;
      rightAntenna.rotation.z = .16 * eased;
    } else if (track === 'attention' || track === 'attention_alternate') {
      const side = track === 'attention' ? -1 : 1;
      root.rotation.z = THREE.MathUtils.degToRad(side * 8 * eased);
      (side < 0 ? leftClaw : rightClaw).rotation.z = side * .62 * eased;
      (side < 0 ? leftEye : rightEye).sclera.scale.multiplyScalar(1 + .22 * eased);
    }

    let expressionOpen = 1;
    if (track === 'working') expressionOpen = step ? .84 : 1;
    if (track === 'complete') expressionOpen = 1 - .72 * eased;
    const blinkOpen = [1, .75, .5, .25, .035][blinkLevel] ?? 1;
    const openness = Math.max(.035, expressionOpen * blinkOpen);
    for (const eye of [leftEye, rightEye]) {
      eye.sclera.scale.y *= openness;
      eye.pupil.scale.y *= openness;
      eye.pupil.visible = openness > .1;
    }
  }

  function render(pose) {
    applyPose(pose.track, pose.step, pose.blink);
    scene.updateMatrixWorld(true);
    renderer.render(scene, camera);
  }

  return {scene, camera, renderer, root, render};
}
