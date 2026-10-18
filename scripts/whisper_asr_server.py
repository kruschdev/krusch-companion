#!/usr/bin/env python3
"""
Krusch Homelab Local Whisper STT Microservice (:9000)

Provides:
  - POST /asr?task=transcribe&language=en&output=json (used by krusch-companion & first-things-first)
  - POST /v1/audio/transcriptions (OpenAI-compatible endpoint used by home-ai)
  - GET  /health
"""

import json
import os
import re
import shutil
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import numpy as np
from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("WHISPER_MODEL", "base.en")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
PORT = int(os.environ.get("WHISPER_PORT", "9000"))
HOST = os.environ.get("WHISPER_HOST_BIND", "0.0.0.0")
FFMPEG_BIN = shutil.which("ffmpeg") or "/home/krusch/.local/bin/ffmpeg"

print(f"[krusch-whisper-stt] Loading Faster-Whisper model '{MODEL_NAME}' ({DEVICE}/{COMPUTE_TYPE})...", flush=True)
model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE)
print(f"[krusch-whisper-stt] Model '{MODEL_NAME}' ready on http://{HOST}:{PORT} (ffmpeg: {FFMPEG_BIN})", flush=True)


def extract_multipart_file(raw_body: bytes, content_type: str):
    """Extract first uploaded file bytes from multipart/form-data."""
    m = re.search(r"boundary=([^;\s]+)", content_type)
    if not m:
        return raw_body
    boundary = m.group(1).strip('"').encode("utf-8")
    parts = raw_body.split(b"--" + boundary)
    for part in parts:
        if b"Content-Disposition:" not in part:
            continue
        header_end = part.find(b"\r\n\r\n")
        if header_end == -1:
            continue
        payload = part[header_end + 4 :]
        if payload.endswith(b"\r\n"):
            payload = payload[:-2]
        if payload:
            return payload
    return None


def decode_audio_to_float32(audio_bytes: bytes) -> np.ndarray:
    """Decode arbitrary audio container (webm/opus, wav, m4a, mp3) to 16kHz mono float32 via ffmpeg."""
    proc = subprocess.run(
        [
            FFMPEG_BIN,
            "-nostdin",
            "-threads", "0",
            "-i", "pipe:0",
            "-f", "s16le",
            "-ac", "1",
            "-acodec", "pcm_s16le",
            "-ar", "16000",
            "pipe:1",
        ],
        input=audio_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    return np.frombuffer(proc.stdout, np.int16).flatten().astype(np.float32) / 32768.0


INITIAL_PROMPT = os.environ.get(
    "WHISPER_INITIAL_PROMPT",
    "Kevin, Maggie, my wife Maggie, La Habra High School, 1161 North Citrus Drive, La Habra, West Whittier Boulevard, West Highlander Avenue, Krusch Companion, Today's Board, checklist, priority, Home Depot, dishes.",
)
DYNAMIC_PROMPT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data",
    "whisper-prompt.txt",
)


def get_initial_prompt() -> str:
    try:
        if os.path.exists(DYNAMIC_PROMPT_PATH):
            with open(DYNAMIC_PROMPT_PATH, "r", encoding="utf-8") as f:
                custom = f.read().strip()
                if custom:
                    return custom
    except Exception:
        pass
    return INITIAL_PROMPT



def normalize_transcript(raw_text: str) -> str:
    text = (raw_text or "").strip()
    if not text:
        return ""
    # Fix spoken 4-digit street numbers split by Whisper: e.g. "11.6 to 1" or "11 6 to 1" -> "1161"
    text = re.sub(r"\b(\d{1,2})[.\s]+(\d)\s+to\s+(\d)\b", r"\1\2\3", text, flags=re.IGNORECASE)
    # Fix decimal-formatted 4-digit street numbers before directions/street names: "11.61 North" -> "1161 North"
    text = re.sub(
        r"\b(\d{2})\.(\d{2})(?=\s+(?:North|South|East|West|N\b|S\b|E\b|W\b|[A-Z][a-z]+\s+(?:St|Street|Ave|Avenue|Dr|Drive|Blvd|Boulevard|Rd|Road|Way|Ln|Lane)))",
        r"\1\2",
        text,
    )
    # Fix phonetic mishearings of La Habra High School ("Waba High School", "La Habra high school")
    text = re.sub(r"\b(?:waba|la\s*habra|lahabra)\s+high\s+school\b", "La Habra High School", text, flags=re.IGNORECASE)
    # Fix time with period ("at 3.30" -> "at 3:30")
    text = re.sub(r"\b(at|by|around|before|after)\s+(\d{1,2})\.(\d{2})\b", r"\1 \2:\3", text, flags=re.IGNORECASE)
    return text


class WhisperHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[krusch-whisper-stt] {self.address_string()} - {fmt % args}", flush=True)

    def _send_json(self, status_code: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health") or self.path == "/":
            self._send_json(200, {"status": "healthy", "model": MODEL_NAME, "device": DEVICE})
        else:
            self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        if not (self.path.startswith("/asr") or self.path.startswith("/v1/audio/transcriptions")):
            self._send_json(404, {"error": f"Unsupported endpoint: {self.path}"})
            return

        try:
            content_type = self.headers.get("Content-Type", "")
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length <= 0:
                self._send_json(400, {"error": "Empty request body"})
                return

            raw_body = self.rfile.read(content_length)
            if "multipart/form-data" in content_type:
                audio_bytes = extract_multipart_file(raw_body, content_type)
            else:
                audio_bytes = raw_body

            if not audio_bytes:
                self._send_json(400, {"error": "No audio file payload found in request"})
                return

            audio_np = decode_audio_to_float32(audio_bytes)
            if audio_np.size == 0:
                self._send_json(200, {"text": "", "language": "en"})
                return

            segments, info = model.transcribe(
                audio_np,
                beam_size=5,
                language="en",
                vad_filter=True,
                initial_prompt=get_initial_prompt(),
            )
            raw_text = " ".join(seg.text.strip() for seg in segments if seg.text.strip()).strip()
            text = normalize_transcript(raw_text)

            self._send_json(200, {"text": text, "language": getattr(info, "language", "en")})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), WhisperHandler)
    server.serve_forever()
