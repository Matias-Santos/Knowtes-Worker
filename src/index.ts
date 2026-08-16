type KnowteSummary = { id: string; title: string; tl_dr: string };

function buildSystemPrompt(existingKnowtes: KnowteSummary[]): string {
  const knowteContext = existingKnowtes.length > 0
    ? `\n\nEXISTING KNOWTES — identify relationships using exact IDs:\n${
        existingKnowtes
          .map((k) => `- id: "${k.id}"\n  title: "${k.title}"\n  summary: "${k.tl_dr}"`)
          .join("\n")
      }`
    : "";

  return `You are Jarvis, an AI that converts voice notes into useful, faithful structured Knowtes.${knowteContext}

Preserve the speaker's intent, language, names, numbers, decisions, and uncertainty. Do not invent facts. Remove filler and repetition, but keep concrete details. Use short headings and lists in content when they improve clarity.

Given a voice-transcribed input, produce a single JSON object:
{
  "title": "A concise, specific title (max 60 chars)",
  "tl_dr": "One sentence summary of the core idea",
  "content": "The idea expanded in clean prose or structured markdown",
  "insight": "The deeper implication — what does this mean? what should someone do?",
  "confidence": 0.85,
  "reasoning": "Why you assigned this confidence score (1-2 sentences)",
  "links": [
    { "to": "<exact-knowte-id>", "type": "supports|contradicts|causes|evolves_to|related", "status": "resolved|pending" }
  ]
}

Link type guide:
- supports: the NEW knowte provides evidence or reasoning that strengthens the target
- contradicts: the NEW knowte conflicts with or challenges a claim in the target
- causes: the NEW knowte describes a cause that leads to the target
- evolves_to: the TARGET is a later version, refinement, or next step of the new knowte
- related: general conceptual connection

Use "resolved" only when the target and relationship type are explicit and high-confidence; otherwise use "pending". Prefer related over a directional type when direction is unclear. Never link solely because two Knowtes share a broad topic. Do not emit duplicate targets. Empty links array is better than a weak connection.
The title and summary must stand alone. Content should be a polished, accurate version of the recording, not generic advice. Insight should add one genuinely useful implication or next action grounded in the recording.
Return ONLY the JSON object. No prose, no markdown fences, no explanation.`;
}

function corsHeaders(requestOrigin: string | null, allowedOrigin: string) {
  const origin = requestOrigin && requestOrigin === allowedOrigin ? requestOrigin : "";
  return {
  ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Vary": "Origin",
  "X-Content-Type-Options": "nosniff",
  };
};

interface Env {
  ANTHROPIC_API_KEY: string;
  JARVIS_TOKEN_SECRET: string;
  ALLOWED_ORIGIN?: string;
  AI: Ai;
}

type JarvisClaims = {
  sub: string;
  plan: string;
  scope: string;
  iss: string;
  aud: string;
  exp: number;
};

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function verifyJarvisToken(request: Request, secret: string): Promise<boolean> {
  const value = request.headers.get("Authorization");
  if (!value?.startsWith("Bearer ") || !secret) return false;
  const parts = value.slice(7).split(".");
  if (parts.length !== 3) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
    );
    const validSignature = await crypto.subtle.verify(
      "HMAC", key, base64UrlToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!validSignature) return false;
    const claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1]))) as JarvisClaims;
    const now = Math.floor(Date.now() / 1000);
    return typeof claims.sub === "string" && claims.sub.length > 0
      && claims.iss === "knowtes-backend" && claims.aud === "knowtes-jarvis"
      && claims.scope === "jarvis:voice" && ["pro", "premium", "admin"].includes(claims.plan)
      && claims.exp > now && claims.exp <= now + 10 * 60;
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const allowedOrigin = env.ALLOWED_ORIGIN || "";
    const requestOrigin = request.headers.get("Origin");
    const headers = corsHeaders(requestOrigin, allowedOrigin);
    if (request.method === "OPTIONS") {
      if (!allowedOrigin || requestOrigin !== allowedOrigin) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204, headers });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(JSON.stringify({ status: "Knowtes Jarvis Worker is running" }), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      const ready = Boolean(env.JARVIS_TOKEN_SECRET && env.ANTHROPIC_API_KEY && env.AI && env.ALLOWED_ORIGIN);
      return new Response(JSON.stringify({ status: ready ? "ok" : "misconfigured" }), {
        status: ready ? 200 : 503,
        headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    if (request.method === "POST" && url.pathname === "/voice/stream") {
      if (!(await verifyJarvisToken(request, env.JARVIS_TOKEN_SECRET))) {
        return new Response(JSON.stringify({ detail: "Knowtes Pro authorization required." }), {
          status: 403,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return handleVoiceStream(request, env, headers);
    }

    return new Response("Not Found", { status: 404, headers });
  },
};

function handleVoiceStream(request: Request, env: Env, cors: Record<string, string>): Response {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const send = async (event: object): Promise<void> => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  };

  processVoice(request, env, send)
    .catch(async () => {
      try { await send({ type: "error", message: "Voice processing failed. Please try again." }); } catch {}
    })
    .finally(async () => {
      try { await writer.close(); } catch {}
    });

  return new Response(readable, {
    headers: {
      ...cors,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}

async function processVoice(
  request: Request,
  env: Env,
  send: (event: object) => Promise<void>,
): Promise<void> {
  const formData = await request.formData();
  const audioFile = formData.get("audio") as File | null;
  if (!audioFile) throw new Error("No audio file in request");
  if (audioFile.size > 25 * 1024 * 1024) throw new Error("Audio file exceeds the 25 MB limit");
  const allowedAudioTypes = new Set([
    "audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/webm", "audio/ogg", "audio/aac",
  ]);
  if (audioFile.type && !allowedAudioTypes.has(audioFile.type)) throw new Error("Unsupported audio type");

  // Parse existing knowtes sent by the app for context
  const knowtesRaw = formData.get("knowtes") as string | null;
  const existingKnowtes: KnowteSummary[] = [];
  if (knowtesRaw) {
    if (knowtesRaw.length > 250_000) throw new Error("Knowte context is too large");
    try { existingKnowtes.push(...(JSON.parse(knowtesRaw) as KnowteSummary[]).slice(0, 500)); } catch {}
  }

  // Transcribe using Cloudflare AI (built-in Whisper — no extra API key needed)
  const audioBytes = [...new Uint8Array(await audioFile.arrayBuffer())];
  const whisperResult = await env.AI.run("@cf/openai/whisper", { audio: audioBytes });
  const text = (whisperResult as { text?: string }).text ?? "";

  if (!text.trim()) throw new Error("Transcription returned empty text");
  await send({ type: "transcribed", text });

  // Generate with Claude (streaming), passing existing knowtes as context
  const systemPrompt = buildSystemPrompt(existingKnowtes);
  const accumulated = await streamClaude(text, env.ANTHROPIC_API_KEY, systemPrompt, async (delta) => {
    await send({ type: "token", delta });
  });

  const jsonMatch = accumulated.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Claude did not return valid JSON");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error("Failed to parse Claude JSON response");
  }

  // Validate and filter links to only IDs present in the sent knowtes
  const validIds = new Set(existingKnowtes.map((k) => k.id));
  const rawLinks = Array.isArray(parsed.links) ? parsed.links : [];
  const linkTypes = new Set(["supports", "contradicts", "causes", "evolves_to", "related"]);
  const seenTargets = new Set<string>();
  const links = rawLinks
    .filter(
      (l): l is { to: string; type: string; status?: string } =>
        typeof l === "object" && l !== null &&
        typeof (l as Record<string, unknown>).to === "string" &&
        typeof (l as Record<string, unknown>).type === "string" &&
        linkTypes.has((l as Record<string, unknown>).type as string) &&
        (existingKnowtes.length === 0 || validIds.has((l as Record<string, unknown>).to as string)),
    )
    .filter((link) => {
      if (seenTargets.has(link.to)) return false;
      seenTargets.add(link.to);
      return true;
    })
    .map((link) => ({
      to: link.to,
      type: link.type,
      status: link.status === "resolved" ? "resolved" : "pending",
    }))
    .slice(0, 10);

  await send({
    type: "result",
    knowte: {
      title:      String(parsed.title ?? "").slice(0, 120),
      tl_dr:      String(parsed.tl_dr ?? "").slice(0, 1000),
      content:    String(parsed.content ?? "").slice(0, 50_000),
      insight:    String(parsed.insight ?? "").slice(0, 5000),
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence ?? 0.7) || 0.7)),
      reasoning:  String(parsed.reasoning ?? "").slice(0, 2000),
      source:     "claude-sonnet-4-6",
      links,
    },
  });
}

async function streamClaude(
  userText: string,
  anthropicKey: string,
  systemPrompt: string,
  onDelta: (delta: string) => Promise<void>,
): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      stream: true,
      system: systemPrompt,
      messages: [{ role: "user", content: userText }],
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Claude API failed (${res.status})`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let accumulated = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;

      try {
        const event = JSON.parse(data) as Record<string, unknown>;
        const delta = event.delta as Record<string, unknown> | undefined;
        if (event.type === "content_block_delta" && delta?.type === "text_delta") {
          const chunk = String(delta.text ?? "");
          accumulated += chunk;
          await onDelta(chunk);
        }
      } catch {}
    }
  }

  return accumulated;
}
