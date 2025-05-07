import asyncio
import json
import time
import numpy as np
from collections import deque
from typing import Dict, List, Any

import sounddevice as sd
import aubio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

clients = set()
stream = None
loop = None

# init audio params
SAMPLERATE = 44100
BLOCKSIZE = 1024
CHANNELS = 1
BUFFER_SIZE = 10

# init aubio pitch detector
pitch_o = aubio.pitch("default", 2048, BLOCKSIZE, SAMPLERATE)
pitch_o.set_unit("Hz")
pitch_o.set_tolerance(0.8)

onset_o = aubio.onset("energy", 2048, BLOCKSIZE, SAMPLERATE)
onset_o.set_threshold(0.3)

# Audio buffer for feature extraction
audio_buffer = deque(maxlen=int(SAMPLERATE * BUFFER_SIZE / BLOCKSIZE))
pitch_history = deque(maxlen=20)
energy_history = deque(maxlen=20)
onset_times = deque(maxlen=10)

# State tracking
last_onset = 0
tempo = 0
last_feature_time = 0
detected_mood = "neutral"
detected_key = "Unknown"
detected_chord = "Unknown"

class AIAudioAnalyzer:
    def __init__(self):
        self.last_analysis = 0
        self.analysis_interval = 0.5
        
    def analyze(self, pitch: float, energy: float, onsets: List[float]) -> Dict[str, Any]:
        current_time = time.time()
        if current_time - self.last_analysis < self.analysis_interval:
            return {}
            
        result = {}
        
        if len(pitch_history) > 5:
            valid_pitches = [p for p in pitch_history if p > 20]
            if valid_pitches:
                pitch_mean = np.mean(valid_pitches)
                pitch_var = np.var(valid_pitches)
                result["pitch_mean"] = float(pitch_mean)
                result["pitch_variance"] = float(pitch_var)
                result["key"] = self._estimate_musical_key(valid_pitches)
        
        if len(onset_times) > 3:
            intervals = np.diff(onset_times)
            if len(intervals) > 0:
                mean_interval = np.mean(intervals)
                if mean_interval > 0:
                    result["tempo"] = float(60.0 / mean_interval)
        
        if len(energy_history) > 5:
            result["energy_mean"] = float(np.mean(energy_history))
            result["energy_variance"] = float(np.var(energy_history))
        
        result["mood"] = self._detect_mood(result)
        
        self.last_analysis = current_time
        return result
    
    def _detect_mood(self, features: Dict[str, Any]) -> str:
        if "tempo" in features and "energy_mean" in features:
            tempo = features["tempo"]
            energy = features["energy_mean"]
            pitch_var = features.get("pitch_variance", 0)
            
            if tempo > 120 and energy > 0.05:
                return "energetic"
            elif tempo < 80 and energy < 0.03:
                return "melancholic"
            elif tempo > 100 and energy > 0.03 and pitch_var < 2000:
                return "happy"
            elif energy < 0.04 and "key" in features and "minor" in features["key"].lower():
                return "sad"
            elif pitch_var > 5000:
                return "complex"
            
        return "neutral"
    
    def _estimate_musical_key(self, pitches: List[float]) -> str:
        midi_notes = [12 * np.log2(p/440) + 69 for p in pitches if p > 0]
        pitch_classes = [int(round(n % 12)) for n in midi_notes]
        counts = np.bincount(pitch_classes, minlength=12)
        
        major_profile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
        minor_profile = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
        
        major_corr = [np.corrcoef(np.roll(counts, i), major_profile)[0, 1] for i in range(12)]
        minor_corr = [np.corrcoef(np.roll(counts, i), minor_profile)[0, 1] for i in range(12)]
        
        best_major_key = np.argmax(major_corr)
        best_minor_key = np.argmax(minor_corr)
        
        if major_corr[best_major_key] > minor_corr[best_minor_key]:
            key_type = "Major"
            key_idx = best_major_key
        else:
            key_type = "Minor"
            key_idx = best_minor_key
            
        key_names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
        return f"{key_names[key_idx]} {key_type}"

analyzer = AIAudioAnalyzer()

def audio_callback(indata, frames, time_info, status):
    global last_onset, tempo
    
    if status:
        print("Audio status:", status)
        
    samples = indata[:, 0]
    audio_buffer.append(samples.copy())
    
    pitch = float(pitch_o(samples)[0])
    confidence = float(pitch_o.get_confidence())
    rms = float(np.sqrt(np.mean(samples**2)))
    
    if pitch > 20 and confidence > 0.5:
        pitch_history.append(pitch)
    
    energy_history.append(rms)
    
    is_onset = onset_o(samples)
    if is_onset:
        current_time = time.time()
        if current_time - last_onset > 0.1:
            onset_times.append(current_time)
            last_onset = current_time
            
            if len(onset_times) > 3:
                intervals = np.diff(onset_times)
                if len(intervals) > 0:
                    tempo = 60.0 / np.mean(intervals)
    
    ai_features = analyzer.analyze(pitch, rms, list(onset_times))
    if ai_features:
        if "mood" in ai_features:
            global detected_mood
            detected_mood = ai_features["mood"]
        if "key" in ai_features:
            global detected_key
            detected_key = ai_features["key"]
    
    payload = {
        "pitch": pitch,
        "confidence": confidence,
        "rms": rms,
        "tempo": tempo,
        "mood": detected_mood,
        "key": detected_key
    }
    
    for k, v in ai_features.items():
        if k not in payload:
            payload[k] = v
    
    message = json.dumps(payload)
    loop.create_task(broadcast(message))

async def broadcast(msg: str):
    for ws in list(clients):
        try:
            await ws.send_text(msg)
        except:
            clients.remove(ws)

@app.on_event("startup")
def startup():
    global stream, loop
    loop = asyncio.get_event_loop()
    
    stream = sd.InputStream(
        callback=audio_callback,
        channels=CHANNELS,
        samplerate=SAMPLERATE,
        blocksize=BLOCKSIZE,
    )
    stream.start()
    print("Audio stream started")

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    
    try:
        await ws.send_text(json.dumps({
            "pitch": 0,
            "confidence": 0,
            "rms": 0,
            "tempo": 0,
            "mood": "neutral",
            "key": "Unknown"
        }))
        
        while True:
            await asyncio.sleep(1)
            
    except WebSocketDisconnect:
        clients.remove(ws)
    except Exception:
        if ws in clients:
            clients.remove(ws)

@app.get("/")
async def root():
    return {
        "status": "online",
        "clients": len(clients),
        "audio_status": "active" if stream and stream.active else "inactive"
    }

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)