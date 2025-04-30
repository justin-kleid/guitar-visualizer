import asyncio
import json

import sounddevice as sd
import numpy as np
import aubio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import uvicorn

app = FastAPI()
clients = set()


stream = None
loop   = None

# init audio params
SAMPLERATE = 44100
BLOCKSIZE  = 1024
CHANNELS   = 1

# init aubio pitch detector
pitch_o = aubio.pitch("default", 2048, BLOCKSIZE, SAMPLERATE)
pitch_o.set_unit("Hz")
pitch_o.set_tolerance(0.8)

async def broadcast(msg: str):
    for ws in list(clients):
        try:
            await ws.send_text(msg)
        except:
            clients.remove(ws)

def audio_callback(indata, frames, time, status):
    if status:
        print("Audio status:", status)
    samples = indata[:, 0]
    p   = float(pitch_o(samples)[0])
    c   = float(pitch_o.get_confidence())
    r   = float(np.sqrt(np.mean(samples**2)))
    payload = json.dumps({"pitch": p, "confidence": c, "rms": r})

    # debugging
    print("Broadcasting:", payload)
    loop.create_task(broadcast(payload))


@app.on_event("startup")
def startup():
    global stream, loop
    loop = asyncio.get_event_loop() # loops
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
        while True:
            await asyncio.sleep(1)
    except WebSocketDisconnect:
        clients.remove(ws)


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
