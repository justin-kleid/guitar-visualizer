let socket;
let pitch = 0,
  rms = 0;

function setup() {
  createCanvas(windowWidth, windowHeight);
  colorMode(HSL, 360, 100, 100);

  socket = new WebSocket("ws://localhost:8000/ws");
  socket.onopen = () => console.log("WS connected");
  socket.onmessage = (e) => {
    console.log("Received payload:", e.data);
    let d = JSON.parse(e.data);
    pitch = d.pitch;
    rms = d.rms;
  };
}

function draw() {
  background(0);
  // 50–1000 Hz → 0–360° hue
  let h = map(pitch, 50, 1000, 0, 360, true);
  // RMS 0–0.1 → lightness 30–90
  let l = map(rms, 0, 0.1, 30, 90, true);
  fill(h, 100, l);

  // RMS 0–0.1 → 50–width for circle
  let sz = map(rms, 0, 0.1, 50, width, true);
  noStroke();
  ellipse(width / 2, height / 2, sz, sz);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}
