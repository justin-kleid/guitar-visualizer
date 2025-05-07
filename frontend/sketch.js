let socket;
let pitch = 0,
  rms = 0,
  confidence = 0;
let pitchHistory = [];
let rmsHistory = [];
let lastNoteTime = 0;
let noteInterval = 0;
let noteCount = 0;
let mood = "neutral";
let particles = [];
let hueOffset = 0;
let backgroundMode = 0;
let visualMode = 0;
const MAX_HISTORY = 100;
const MAX_PARTICLES = 100;

class FeatureExtractor {
  constructor() {
    this.pitchMean = 0;
    this.pitchVariance = 0;
    this.rmsMean = 0;
    this.tempo = 0;
    this.noteCount = 0;
    this.lastFeatureUpdate = 0;
  }

  update(pitch, rms, confidence) {
    const now = millis();
    if (now - this.lastFeatureUpdate < 500) return;

    if (pitchHistory.length > 10) {
      this.pitchMean = this.calculateMean(pitchHistory);
      this.pitchVariance = this.calculateVariance(pitchHistory, this.pitchMean);
    }

    if (rmsHistory.length > 10) {
      this.rmsMean = this.calculateMean(rmsHistory);
    }

    if (
      rms > 0.05 &&
      rmsHistory.length > 2 &&
      rmsHistory[rmsHistory.length - 1] >
        1.5 * rmsHistory[rmsHistory.length - 2]
    ) {
      const now = millis();
      if (now - lastNoteTime > 100) {
        noteInterval = now - lastNoteTime;
        this.tempo = 60000 / noteInterval; // bpm
        lastNoteTime = now;
        noteCount++;
      }
    }

    this.determineMood();
    this.lastFeatureUpdate = now;
  }

  calculateMean(array) {
    return array.reduce((sum, val) => sum + val, 0) / array.length;
  }

  calculateVariance(array, mean) {
    return (
      array.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
      array.length
    );
  }

  determineMood() {
    if (this.pitchVariance > 10000 && this.rmsMean > 0.07) {
      mood = "energetic";
    } else if (this.pitchMean < 200 && this.rmsMean < 0.03) {
      mood = "melancholic";
    } else if (this.tempo > 120 && this.rmsMean > 0.05) {
      mood = "happy";
    } else if (this.pitchVariance < 2000 && this.pitchMean > 400) {
      mood = "dreamy";
    } else {
      mood = "neutral";
    }
  }
}

// Particle class
class Particle {
  constructor() {
    this.reset();
  }

  reset() {
    this.x = width / 2;
    this.y = height / 2;
    this.size = random(5, 20);
    this.speed = random(1, 5);
    this.angle = random(TWO_PI);
    this.hue = map(pitch, 50, 1000, 0, 360, true);
    this.life = 255;
    this.decay = random(1, 3);
  }

  update() {
    this.x += cos(this.angle) * this.speed;
    this.y += sin(this.angle) * this.speed;
    this.life -= this.decay;

    if (
      this.life < 0 ||
      this.x < 0 ||
      this.x > width ||
      this.y < 0 ||
      this.y > height
    ) {
      this.reset();
    }
  }

  display() {
    noStroke();
    fill(this.hue, 100, 50, this.life / 255);
    ellipse(this.x, this.y, this.size, this.size);
  }
}

// Viz modes
const visualModes = [
  function drawParticles() {
    // particle logic
    if (random() < map(rms, 0, 0.1, 0, 0.3)) {
      if (particles.length < MAX_PARTICLES) {
        particles.push(new Particle());
      }
    }

    for (let i = particles.length - 1; i >= 0; i--) {
      particles[i].update();
      particles[i].display();

      if (particles[i].life < 0) {
        particles.splice(i, 1);
      }
    }
  },

  function drawFrequencyWaves() {
    //  wave visualization for PITCH
    stroke(map(pitch, 50, 1000, 0, 360, true), 100, 70);
    strokeWeight(map(rms, 0, 0.1, 1, 8, true));
    noFill();

    beginShape();
    for (let x = 0; x < width; x += 10) {
      let y =
        height / 2 +
        sin(x * 0.01 + frameCount * 0.02) * 50 +
        sin(x * 0.02 + frameCount * 0.01) * (pitch / 20);
      vertex(x, y);
    }
    endShape();
  },

  function drawMoodShapes() {
    // Shapes FOR MOOD
    let shapeSides;
    let shapeColor;
    let shapeRotation = frameCount * 0.01;

    switch (mood) {
      case "energetic":
        shapeSides = 8; // Octagon
        shapeColor = color(0, 100, 60);
        shapeRotation *= 2;
        break;
      case "melancholic":
        shapeSides = 4; // Square
        shapeColor = color(240, 70, 40);
        shapeRotation *= 0.5;
        break;
      case "happy":
        shapeSides = 5; // Pentagon
        shapeColor = color(60, 100, 60);
        break;
      case "dreamy":
        shapeSides = 12; // Dodecagon\
        shapeColor = color(280, 80, 70);
        break;
      default:
        shapeSides = 3; // Triangl
        shapeColor = color(180, 80, 50);
    }

    // Draw  shape
    push();
    translate(width / 2, height / 2);
    rotate(shapeRotation);
    fill(shapeColor);
    stroke(0);
    strokeWeight(2);

    let radius = map(rms, 0, 0.1, 100, height / 2, true);
    beginShape();
    for (let i = 0; i < shapeSides; i++) {
      let angle = (TWO_PI * i) / shapeSides;
      let x = cos(angle) * radius;
      let y = sin(angle) * radius;
      vertex(x, y);
    }
    endShape(CLOSE);
    pop();
  },
];

// init vars
let featureExtractor;
let detected_key = "Unknown";
let detected_tempo = 0;

function setup() {
  createCanvas(windowWidth, windowHeight);
  colorMode(HSL, 360, 100, 100);

  // init particles
  for (let i = 0; i < 20; i++) {
    particles.push(new Particle());
  }

  // init feature extractor
  featureExtractor = new FeatureExtractor();

  socket = new WebSocket("ws://localhost:8000/ws");

  socket.onopen = () => {
    console.log("WebSocket connected");
  };

  socket.onmessage = (e) => {
    try {
      let d = JSON.parse(e.data);

      pitch = d.pitch;
      rms = d.rms;
      confidence = d.confidence || 0.5;

      if (d.mood) mood = d.mood;
      if (d.key) detected_key = d.key;
      if (d.tempo) detected_tempo = d.tempo;

      pitchHistory.push(pitch);
      if (pitchHistory.length > MAX_HISTORY) pitchHistory.shift();

      rmsHistory.push(rms);
      if (rmsHistory.length > MAX_HISTORY) rmsHistory.shift();

      // Update feature extraction
      featureExtractor.update(pitch, rms, confidence);
    } catch (err) {
      console.error("Error processing message:", err);
    }
  };

  //  keyboard buttons for switching visualization modes
  document.addEventListener("keydown", function (event) {
    if (event.code === "Space") {
      visualMode = (visualMode + 1) % visualModes.length;
    } else if (event.code === "KeyB") {
      backgroundMode = (backgroundMode + 1) % 3;
    }
  });
}

function draw() {
  switch (
    backgroundMode // bg effects wip
  ) {
    case 0:
      background(0);
      break;
    case 1:
      noStroke();
      fill(0, 0, 0, 10);
      rect(0, 0, width, height);
      break;
    case 2: // bg on mood
      let bgHue;
      switch (mood) {
        case "energetic":
          bgHue = 0;
          break;
        case "melancholic":
          bgHue = 240;
          break; // Blue
        case "happy":
          bgHue = 60;
          break; // Yellow
        case "dreamy":
          bgHue = 280;
          break; // Purple
        default:
          bgHue = 180;
          break; // Cyan
      }
      background(bgHue, 30, 10);
      break;
  }

  visualModes[visualMode]();
  hueOffset += map(rms, 0, 0.1, 0.1, 2);

  // pitch history graph
  drawPitchHistory();
  drawUI();
}

function drawUI() {
  textSize(16);
  fill(200, 100, 80);
  text(`Mood: ${mood}`, 20, 30);
  text(`Pitch: ${pitch.toFixed(1)} Hz`, 20, 50);
  text(`Volume: ${(rms * 100).toFixed(1)}%`, 20, 70);
  if (detected_key !== "Unknown") {
    text(`Key: ${detected_key}`, 20, 90);
  }

  // Display viz mode indicator
  text(
    `Visualization: ${visualMode + 1}/${visualModes.length} (Space to change)`,
    20,
    height - 30
  );
  text(`Background: ${backgroundMode + 1}/3 (B to change)`, 20, height - 10);
}

function drawPitchHistory() {
  // Draw a small pitch history graph at the bottom
  const graphHeight = 100;
  const graphY = height - graphHeight - 60;

  stroke(120, 50, 70);
  noFill();
  rect(20, graphY, 200, graphHeight);

  if (pitchHistory.length > 1) {
    stroke(60, 100, 70);
    beginShape();
    for (let i = 0; i < pitchHistory.length; i++) {
      const x = map(i, 0, MAX_HISTORY, 20, 220);
      const y = map(
        pitchHistory[i],
        50,
        1000,
        graphY + graphHeight - 10,
        graphY + 10,
        true
      );
      vertex(x, y);
    }
    endShape();
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}
