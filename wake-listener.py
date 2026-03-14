#!/usr/bin/env python3
"""Wake word listener with integrated recording.

Continuously processes microphone audio through openwakeword.
When wake word is detected, records audio using the SAME stream (zero gap).
Uses a ring buffer for pre-roll to capture words spoken during/after wake word.

Stdout protocol:
  LOADING <model>       — model loading
  READY                 — model loaded
  LISTENING             — mic open, ready for wake word
  WAKE                  — wake word detected, recording started
  AUDIO_READY <path>    — recording saved, ready for STT
  SILENCE               — recording contained no speech
  FOLLOW_UP_LISTENING   — entered follow-up listen mode
  FOLLOW_UP_TIMEOUT     — no speech during follow-up window

Stdin protocol:
  FOLLOW_UP             — enter follow-up mode (listen without wake word)
"""

import argparse
import collections
import sys
import threading
import time
import wave

import numpy as np
import sounddevice as sd
from openwakeword.model import Model

# States
STATE_IDLE = "idle"
STATE_RECORDING = "recording"
STATE_FOLLOW_UP = "follow_up"

WAV_PATH = "/tmp/claude-utterance.wav"


class ListenerState:
    """Mutable state shared between audio callback, stdin reader, and main thread."""

    def __init__(self):
        self.current = STATE_IDLE
        self.last_detection = 0.0
        self.recording_chunks = []
        self.silence_count = 0
        self.voice_detected = False
        self.follow_up_count = 0
        self.recording_start = 0.0
        self.recording_extra_chunks = 0  # chunks added after pre-roll grab


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="hey_claude")
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--cooldown", type=float, default=2.0)
    parser.add_argument("--pre-roll", type=float, default=1.5, help="Pre-roll buffer seconds")
    parser.add_argument("--vad-threshold", type=float, default=0.015, help="RMS threshold for voice")
    parser.add_argument("--silence-duration", type=float, default=1.5, help="Silence seconds to stop")
    parser.add_argument("--follow-up-timeout", type=float, default=4.5, help="Follow-up listen window")
    parser.add_argument("--max-recording", type=float, default=15.0, help="Max recording seconds")
    args = parser.parse_args()

    # Load wake word model — supports both built-in names and custom .onnx paths
    print(f"LOADING {args.model}", flush=True)
    model_path = args.model
    if model_path.endswith(".onnx"):
        import os
        model_path = os.path.abspath(model_path)
    oww = Model(wakeword_models=[model_path], inference_framework="onnx")
    print("READY", flush=True)

    # Audio config: 16kHz mono, 80ms chunks (1280 samples)
    sample_rate = 16000
    chunk_samples = 1280
    chunk_duration = chunk_samples / sample_rate  # 0.08s

    # Ring buffer for pre-roll
    pre_roll_chunk_count = int(args.pre_roll / chunk_duration) + 1
    ring_buffer = collections.deque(maxlen=pre_roll_chunk_count)

    # Derived chunk counts for timeouts
    silence_chunks_needed = int(args.silence_duration / chunk_duration)
    follow_up_chunks_needed = int(args.follow_up_timeout / chunk_duration)
    max_recording_chunks = int(args.max_recording / chunk_duration)

    st = ListenerState()

    def compute_rms(audio_float):
        return float(np.sqrt(np.mean(audio_float ** 2)))

    def save_wav(chunks):
        """Save list of float32 numpy arrays as 16-bit WAV."""
        if not chunks:
            return False
        audio = np.concatenate(chunks)
        audio_int16 = (audio * 32767).astype(np.int16)
        try:
            with wave.open(WAV_PATH, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(sample_rate)
                wf.writeframes(audio_int16.tobytes())
            return True
        except Exception as e:
            print(f"WAV_ERROR {e}", file=sys.stderr, flush=True)
            return False

    def begin_recording():
        """Transition to RECORDING: grab pre-roll and reset counters."""
        st.recording_chunks = list(ring_buffer)
        ring_buffer.clear()
        st.silence_count = 0
        st.voice_detected = False
        st.recording_start = time.time()
        st.recording_extra_chunks = 0
        st.current = STATE_RECORDING

    def finish_recording():
        """End recording: save WAV or report silence, return to IDLE."""
        # Need meaningful audio beyond just pre-roll
        actual_duration = st.recording_extra_chunks * chunk_duration
        if st.voice_detected and actual_duration >= 0.3:
            if save_wav(st.recording_chunks):
                print(f"AUDIO_READY {WAV_PATH}", flush=True)
            else:
                print("SILENCE", flush=True)
        else:
            print("SILENCE", flush=True)
        st.recording_chunks = []
        st.current = STATE_IDLE

    def audio_callback(indata, frames, time_info, status):
        if status:
            print(f"AUDIO_ERROR {status}", file=sys.stderr, flush=True)
            return

        chunk = indata[:, 0].copy()  # float32 mono
        rms = compute_rms(chunk)

        if st.current == STATE_IDLE:
            # Fill ring buffer and run wake word detection
            ring_buffer.append(chunk)
            audio_int16 = (chunk * 32767).astype(np.int16)
            prediction = oww.predict(audio_int16)

            for model_name, score in prediction.items():
                if score > args.threshold:
                    now = time.time()
                    if now - st.last_detection > args.cooldown:
                        st.last_detection = now
                        begin_recording()
                        oww.reset()
                        print("WAKE", flush=True)
                    break

        elif st.current == STATE_RECORDING:
            st.recording_chunks.append(chunk)
            st.recording_extra_chunks += 1

            if rms >= args.vad_threshold:
                st.voice_detected = True
                st.silence_count = 0
            else:
                st.silence_count += 1

            # Stop conditions
            should_stop = False

            # Sustained silence after voice was detected
            if st.voice_detected and st.silence_count >= silence_chunks_needed:
                should_stop = True

            # Max recording length
            if st.recording_extra_chunks >= max_recording_chunks:
                should_stop = True

            # No voice at all within 3 seconds of wake
            if not st.voice_detected and (time.time() - st.recording_start) > 3.0:
                should_stop = True

            if should_stop:
                finish_recording()

        elif st.current == STATE_FOLLOW_UP:
            ring_buffer.append(chunk)

            if rms >= args.vad_threshold:
                # Voice detected — start recording
                begin_recording()
                # Override: voice is already detected since that's what triggered us
                st.voice_detected = True
            else:
                st.follow_up_count += 1
                if st.follow_up_count >= follow_up_chunks_needed:
                    print("FOLLOW_UP_TIMEOUT", flush=True)
                    st.current = STATE_IDLE

    # Stdin reader thread — receives commands from Node.js
    def stdin_reader():
        try:
            for line in sys.stdin:
                cmd = line.strip()
                if cmd == "FOLLOW_UP":
                    ring_buffer.clear()
                    st.follow_up_count = 0
                    st.current = STATE_FOLLOW_UP
                    print("FOLLOW_UP_LISTENING", flush=True)
        except EOFError:
            pass

    stdin_thread = threading.Thread(target=stdin_reader, daemon=True)
    stdin_thread.start()

    # Start audio stream
    try:
        with sd.InputStream(
            samplerate=sample_rate,
            channels=1,
            dtype="float32",
            blocksize=chunk_samples,
            callback=audio_callback,
        ):
            print("LISTENING", flush=True)
            while True:
                time.sleep(0.1)
    except KeyboardInterrupt:
        print("STOPPED", flush=True)
    except Exception as e:
        print(f"FATAL {e}", file=sys.stderr, flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
