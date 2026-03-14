#!/usr/bin/env node
/**
 * Voice Assistant — Main Loop
 *
 * Wake word (openwakeword) → Record (in-process, zero gap) → STT (Groq Whisper) →
 * LLM (Claude SDK, streamed sentence-by-sentence) → TTS (macOS say, queued) →
 * Conversation mode (follow-up without wake word)
 *
 * Usage: node voice-assistant.js
 */

import { unstable_v2_createSession } from "@anthropic-ai/claude-agent-sdk";
import { spawn, execSync } from "child_process";
import { readFileSync, unlinkSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(readFileSync(join(__dirname, "config.json"), "utf8"));

// ── State ──────────────────────────────────────────────────────────────────

let session = null;
let turnCount = 0;
let wakeProcess = null;
let busy = false;
let aborted = false;
let conversationTurns = 0;

// Speech state
let isSpeaking = false;
let currentSayProc = null;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) {
  console.error("FATAL: GROQ_API_KEY not set. Source ~/.config/claude-code/api-keys.env");
  process.exit(1);
}

// ── Claude Session Management ──────────────────────────────────────────────

function ensureSession() {
  if (session && turnCount < CONFIG.llm.maxSessionTurns) return;

  if (session) {
    try { session.close(); } catch {}
    console.log(`  [session] Rotated after ${turnCount} turns`);
  }

  const model = CONFIG.llm.model || "claude-sonnet-4-6";
  session = unstable_v2_createSession({
    model,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  });
  console.log(`  [session] Model: ${model}`);
  turnCount = 0;
  console.log("  [session] Created new Claude session");
}

async function askClaude(transcript, onSentence) {
  ensureSession();

  const isFirstTurn = turnCount === 0;
  const systemPrompt = readFileSync(join(__dirname, "CLAUDE.md"), "utf8");

  let prompt;
  if (isFirstTurn) {
    prompt = `${systemPrompt}\n\n---\n\nThe user said: "${transcript}"`;
  } else {
    prompt = `The user said: "${transcript}"`;
  }

  const msg = {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: prompt }],
    },
    parent_tool_use_id: null,
    session_id: "jarvis",
  };

  await session.send(msg);
  turnCount++;

  let sentenceBuffer = "";

  for await (const message of session.stream()) {
    if (aborted) break;

    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") {
          sentenceBuffer += block.text;

          // Extract complete sentences and send to TTS
          const { sentences, remainder } = splitSentences(sentenceBuffer);
          sentenceBuffer = remainder;
          for (const s of sentences) {
            if (s && onSentence) onSentence(s);
          }
        }
      }
    }
    if (message.type === "result") {
      break;
    }
  }

  // Flush any remaining text
  if (sentenceBuffer.trim() && onSentence && !aborted) {
    onSentence(sentenceBuffer.trim());
  }
}

function splitSentences(text) {
  const sentences = [];
  let remaining = text;

  while (true) {
    // Sentence-ending punctuation followed by whitespace
    const match = remaining.match(/[.!?][\s]/);
    if (!match) break;

    const endIdx = match.index + 1; // include the punctuation
    const sentence = remaining.substring(0, endIdx).trim();
    if (sentence) sentences.push(sentence);
    remaining = remaining.substring(endIdx);
  }

  return { sentences, remainder: remaining };
}

// ── Speech-to-Text (Groq Whisper API) ─────────────────────────────────────

async function transcribeAudio(wavPath) {
  console.log("  [stt] Transcribing via Groq Whisper...");
  const startTime = Date.now();

  const result = execSync(
    `curl -s https://api.groq.com/openai/v1/audio/transcriptions ` +
    `-H "Authorization: Bearer ${GROQ_API_KEY}" ` +
    `-H "Content-Type: multipart/form-data" ` +
    `-F file="@${wavPath}" ` +
    `-F model="${CONFIG.stt.groqModel}" ` +
    `-F response_format="json" ` +
    `-F language="en" ` +
    `-F temperature="${CONFIG.stt.temperature}"`,
    { encoding: "utf8", timeout: 30000 }
  );

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  try {
    const parsed = JSON.parse(result);
    if (parsed.error) {
      console.error(`  [stt] Groq error: ${parsed.error.message}`);
      return null;
    }
    const text = parsed.text?.trim();
    console.log(`  [stt] "${text}" (${elapsed}s)`);
    return text || null;
  } catch (e) {
    console.error(`  [stt] Failed to parse response: ${result.substring(0, 200)}`);
    return null;
  }
}

// ── Text-to-Speech (macOS say, non-blocking) ──────────────────────────────

function sanitizeForSpeech(text) {
  return text
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'")
    .replace(/`/g, "'")
    .replace(/\\/g, "")
    .replace(/\$/g, "");
}

function speakSentence(text) {
  return new Promise((resolve) => {
    if (!text) { resolve(); return; }
    const sanitized = sanitizeForSpeech(text);
    currentSayProc = spawn("say", ["-v", CONFIG.tts.voice, "-r", String(CONFIG.tts.rate), sanitized]);
    currentSayProc.on("close", () => {
      currentSayProc = null;
      resolve();
    });
    currentSayProc.on("error", (err) => {
      console.error(`  [tts] Error: ${err.message}`);
      currentSayProc = null;
      resolve();
    });
  });
}

function stopSpeech() {
  aborted = true;
  if (currentSayProc) {
    currentSayProc.kill("SIGTERM");
    currentSayProc = null;
  }
  isSpeaking = false;
}

// ── Wake Word Listener (Python subprocess) ─────────────────────────────────

function startWakeListener() {
  return new Promise((resolve, reject) => {
    const pythonPath = join(process.env.HOME, "micromamba/envs/tools/bin/python");

    wakeProcess = spawn(pythonPath, [
      join(__dirname, "wake-listener.py"),
      "--model", CONFIG.wakeWord.model,
      "--threshold", String(CONFIG.wakeWord.threshold),
      "--pre-roll", String(CONFIG.audio.preRollSeconds),
      "--vad-threshold", String(CONFIG.audio.vadThreshold),
      "--silence-duration", String(CONFIG.audio.silenceTimeout),
      "--follow-up-timeout", String(CONFIG.conversation.followUpTimeout),
      "--max-recording", String(CONFIG.audio.maxRecordingSeconds),
    ], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = createInterface({ input: wakeProcess.stdout });

    wakeProcess.stderr.on("data", (d) => {
      const msg = d.toString().trim();
      if (msg) console.error(`  [wake:err] ${msg}`);
    });

    wakeProcess.on("error", (err) => {
      console.error(`  [wake] Failed to start: ${err.message}`);
      reject(err);
    });

    wakeProcess.on("close", (code) => {
      console.log(`  [wake] Process exited (code ${code})`);
      wakeProcess = null;
    });

    rl.on("line", async (line) => {
      const msg = line.trim();

      if (msg === "READY") {
        console.log("  [wake] Model loaded");
      } else if (msg === "LISTENING") {
        console.log("\n🎤 Ready — say \"Hey Claude\" to activate\n");
        resolve();
      } else if (msg.startsWith("LOADING")) {
        console.log(`  [wake] Loading model: ${msg.split(" ")[1]}`);
      } else if (msg === "WAKE") {
        handleWake();
      } else if (msg.startsWith("AUDIO_READY")) {
        const wavPath = msg.split(" ")[1];
        await handleAudioReady(wavPath);
      } else if (msg === "SILENCE") {
        console.log("  [main] No speech detected");
        busy = false;
        console.log("\n🎤 Listening for wake word...\n");
      } else if (msg === "FOLLOW_UP_TIMEOUT") {
        console.log("  [main] No follow-up, returning to wake word mode");
        conversationTurns = 0;
        console.log("\n🎤 Listening for wake word...\n");
      } else if (msg === "FOLLOW_UP_LISTENING") {
        console.log("  [main] Listening for follow-up...");
      }
    });
  });
}

// ── Main Interaction Flow ──────────────────────────────────────────────────

function handleWake() {
  if (isSpeaking) {
    // Barge-in: stop current speech
    console.log("\n⚡ Barge-in — stopping speech");
    stopSpeech();
  }

  console.log("\n✨ Wake word detected!");
  conversationTurns = 0;

  // Play acknowledgment tone (non-blocking — won't delay recording)
  try {
    spawn("play", ["-n", "synth", "0.15", "sine", "800", "vol", "0.4"],
      { stdio: "ignore" });
  } catch {}
}

async function handleAudioReady(wavPath) {
  busy = true;
  aborted = false;

  // 1. Transcribe
  const transcript = await transcribeAudio(wavPath);
  try { unlinkSync(wavPath); } catch {}

  if (!transcript) {
    console.log("  [main] No transcript");
    await speakSentence("Sorry, didn't catch that.");
    busy = false;
    console.log("\n🎤 Listening for wake word...\n");
    return;
  }

  // 2. Stream LLM response → TTS sentence by sentence
  console.log(`  [llm] Asking Claude: "${transcript}"`);
  const startLLM = Date.now();

  const sentences = [];
  let llmDone = false;
  let notifyReady = null;

  try {
    const llmPromise = askClaude(transcript, (sentence) => {
      sentences.push(sentence);
      if (notifyReady) { notifyReady(); notifyReady = null; }
    });

    llmPromise
      .then(() => {
        llmDone = true;
        if (notifyReady) { notifyReady(); notifyReady = null; }
      })
      .catch((err) => {
        console.error(`  [llm] Stream error: ${err.message}`);
        llmDone = true;
        if (notifyReady) { notifyReady(); notifyReady = null; }
      });

    // Speech loop: speak sentences as they arrive from LLM
    isSpeaking = true;
    let firstSentence = true;

    while (!aborted) {
      if (sentences.length > 0) {
        const s = sentences.shift();
        if (firstSentence) {
          const elapsed = ((Date.now() - startLLM) / 1000).toFixed(1);
          console.log(`  [tts] First sentence (${elapsed}s): "${s.substring(0, 100)}${s.length > 100 ? "..." : ""}"`);
          firstSentence = false;
        }
        await speakSentence(s);
      } else if (llmDone) {
        break;
      } else {
        // Wait for next sentence or LLM completion
        await new Promise((r) => { notifyReady = r; });
      }
    }

    isSpeaking = false;
    await llmPromise.catch(() => {});

  } catch (err) {
    console.error(`  [llm] Error: ${err.message}`);
    isSpeaking = false;
    await speakSentence("Something went wrong. Try again.");

    // Reset session on error
    try { session?.close(); } catch {}
    session = null;
    turnCount = CONFIG.llm.maxSessionTurns;
  }

  busy = false;

  if (aborted) {
    // Barge-in happened — don't enter conversation mode
    return;
  }

  // 3. Conversation mode: listen for follow-up without wake word
  conversationTurns++;
  if (conversationTurns < CONFIG.conversation.maxFollowUpTurns && wakeProcess) {
    wakeProcess.stdin.write("FOLLOW_UP\n");
  } else {
    conversationTurns = 0;
    console.log("\n🎤 Listening for wake word...\n");
  }
}

// ── Startup ────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║     Claude Voice Assistant v2.1      ║");
  console.log("╚══════════════════════════════════════╝\n");

  // Pre-warm Claude session
  console.log("[startup] Creating Claude session...");
  try {
    ensureSession();
    console.log("[startup] Claude session ready");
  } catch (err) {
    console.error(`[startup] Warning: Session pre-warm failed: ${err.message}`);
    console.error("[startup] Will retry on first interaction");
  }

  // Start wake word listener
  console.log("[startup] Starting wake word listener...");
  await startWakeListener();
}

// ── Cleanup ────────────────────────────────────────────────────────────────

function cleanup() {
  console.log("\n[shutdown] Cleaning up...");
  stopSpeech();
  if (wakeProcess) {
    wakeProcess.kill("SIGTERM");
    wakeProcess = null;
  }
  try { session?.close(); } catch {}
  try { unlinkSync("/tmp/claude-utterance.wav"); } catch {}
  console.log("[shutdown] Done");
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// ── Run ────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  cleanup();
});
