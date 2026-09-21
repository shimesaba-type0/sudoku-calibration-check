/**
 * sudoku-calibration-check
 *
 * Cloudflare Worker entry point. `env.AI` is the Workers AI binding
 * declared in wrangler.jsonc.
 */

const json = (data: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...init.headers },
  });

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return json({
        name: "sudoku-calibration-check",
        status: "ok",
        endpoints: ["/", "/health", "/ai/ping"],
      });
    }

    if (url.pathname === "/health") {
      return json({ status: "ok" });
    }

    // Smoke test for the Workers AI binding.
    if (url.pathname === "/ai/ping") {
      const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: [{ role: "user", content: "Reply with the single word: pong" }],
        max_tokens: 8,
      });
      return json({ result });
    }

    return json({ error: "Not Found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
