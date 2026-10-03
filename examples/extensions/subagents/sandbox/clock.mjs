// Puts the time left (SBX_DEADLINE) into every model request: models can't sense elapsed time.
import { deadline as dl, budgetMin } from "./env.mjs";

export default function activate(ctx, { deadline = dl(), budget = budgetMin() } = {}) {
  if (!deadline) return;
  const start = Date.now() / 1000;
  ctx.agent.registerContextProducer("sbx-clock", () => {
    const now = Date.now() / 1000;
    const left = Math.max(0, (deadline - now) / 60);
    const used = (now - start) / 60;
    let msg = `Time: ${used.toFixed(1)} min used${budget ? ` of ${budget}` : ""}; ${left.toFixed(1)} min left before this process is killed.`;
    if (left < 3) msg += " FINAL MINUTES: stop exploring; make sure your deliverable files are saved and valid right now, then finish.";
    else if (left < 0.34 * (budget || 30)) msg += " Last third: consolidate. Keep the saved deliverable valid; only small, safe refinements.";
    else if (used > 0.34 * (budget || 30)) msg += " You should already have a valid improved deliverable saved.";
    return msg;
  }, { mode: "per-request" });
}
