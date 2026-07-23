import worker from "./index.js";

const GARDENER_SIGNAL_CLASS = "gardener";

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return worker.fetch(request, env, ctx);
    }

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return worker.fetch(request, env, ctx);
    }

    let payload;
    try {
      payload = await request.clone().json();
    } catch {
      return worker.fetch(request, env, ctx);
    }

    if (payload?.signal_class !== GARDENER_SIGNAL_CLASS) {
      return worker.fetch(request, env, ctx);
    }

    const routedEnv = {
      ...env,
      CICD_WEBHOOK_URL: env.GARDENER_WEBHOOK_URL,
    };

    return worker.fetch(request, routedEnv, ctx);
  },
};
