import * as os from "node:os";
import * as path from "node:path";

export const home = process.env.AGENT_SH_HOME || path.join(os.homedir(), ".agent-sh");
export const armed = process.env.SBX_GUARD === "1";
export const writeRoots = () => (process.env.SBX_WRITE_ROOTS || "").split(":").filter(Boolean);
export const hidden = () => (process.env.SBX_HIDE || "").split(":").filter(Boolean);
export const deadline = () => Number(process.env.SBX_DEADLINE || 0);
export const budgetMin = () => Number(process.env.SBX_BUDGET_MIN || 0);
export const policyFile = () => process.env.SBX_POLICY || "";
