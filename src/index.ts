type KnowteSummary = { id: string; title: string; tl_dr: string };

function buildSystemPrompt(existingKnowtes: KnowteSummary[]): string {
  const knowteContext = existingKnowtes.length > 0
    ? `\n\nEXISTING KNOWTES — identify relationships using exact IDs:\n${
        existingKnowtes
          .map((k) => `- id: "${k.id}"\n  title: "${k.title}"\n  summary: "${k.tl_dr}"`)
          .join("\n")
      }`
    : "";

  return `You are Jarvis, an AI that converts voice notes into structured Knowtes.${knowteContext}

Given a voice-transcribed input, produce a single JSON object:
{
  "title": "A concise, specific title (max 60 chars)",
  "tl_dr": "One sentence summary of the core idea",
  "content": "The idea expanded in clean prose or structured markdown",
  "insight": "The deeper implication — what does this mean? what should someone do?",
  "confidence": 0.85,
  "reasoning": "Why you assigned this confidence score (1-2 sentences)",
  "links": [
    { "to": "<exact-knowte-id>", "type": "supports|contradicts|causes|evolves_to|related" }
  ]
}

Link type guide:
- supports: this knowte provides evidence for the target
- contradicts: this knowte challenges or opposes the target
- causes: this knowte describes a cause or precursor of the target
- evolves_to: this knowte is a refinement or update of the target
- related: general conceptual connection

Only link when the relationship is clear and meaningful. Empty links array is fine.
Return ONLY the JSON object. No prose, no markdown fences, no explanation.`;
}

function corsHeaders(origin: string) {
  return {
  "Access-Control-Allow-Origin": origin,
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

async function verifyJarvisToken(request: Request, secret: string): Promise<boolean> {
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
    return claims.iss === "knowtes-backend" && claims.aud === "knowtes-jarvis"
      && claims.scope === "jarvis:voice" && ["pro", "premium", "admin"].includes(claims.plan)
      && claims.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const allowedOrigin = env.ALLOWED_ORIGIN || "*";
    const headers = corsHeaders(allowedOrigin);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(JSON.stringify({ status: "Knowtes Jarvis Worker is running" }), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      const ready = Boolean(env.JARVIS_TOKEN_SECRET && env.ANTHROPIC_API_KEY && env.AI);
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
    .catch(async (err: Error) => {
      try { await send({ type: "error", message: err.message ?? "Internal error" }); } catch {}
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
  const links = rawLinks
    .filter(
      (l): l is { to: string; type: string } =>
        typeof l === "object" && l !== null &&
        typeof (l as Record<string, unknown>).to === "string" &&
        typeof (l as Record<string, unknown>).type === "string" &&
        (existingKnowtes.length === 0 || validIds.has((l as Record<string, unknown>).to as string)),
    )
    .slice(0, 10);

  await send({
    type: "result",
    knowte: {
      title:      String(parsed.title ?? ""),
      tl_dr:      String(parsed.tl_dr ?? ""),
      content:    String(parsed.content ?? ""),
      insight:    String(parsed.insight ?? ""),
      confidence: Number(parsed.confidence ?? 0.7),
      reasoning:  String(parsed.reasoning ?? ""),
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
      max_tokens: 1024,
      stream: true,
      system: systemPrompt,
      messages: [{ role: "user", content: userText }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Claude API failed (${res.status}): ${body.slice(0, 200)}`);
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
