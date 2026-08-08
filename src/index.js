// Public API. Anything imported from "foreman-agent" comes through here, so this file
// is the compatibility surface — keep it stable.

export { Frame, Surface, supportsColor } from "./render.js";
export { createEngine, STATES, stateNames, stateFromHud, CTX_HAUL, CTX_STOP } from "./engine.js";
export { renderSvg, poseSvg, propSvg, frameToSvg, contactSheet,
         mergeRects, rectsToMarkup, bounds, defaultSize } from "./svg.js";
export { liveDocument, MOTION, resolveMotion } from "./svg-live.js";
export { sample, findTranscript, projectDir, tailUsage, scanTotals,
         promptTokens, estimateCost, PRICES,
         scanSubagents, subagentDir } from "./transcript.js";
export { load as loadCharacter, list as listCharacters, validate as validateCharacter,
         REQUIRED_POSES, REQUIRED_PROPS } from "./character.js";
export { emit, readState, writeHud, readHud, getConfig, setConfig,
         stateForHook, normalizeHook, toolKind,
         listSessions, currentSession, aggregate } from "./state.js";
export { parsePayload, formatLine } from "./statusline.js";
export * as claudeCode from "./adapters/claude-code.js";
export * as goose from "./adapters/goose.js";

export const ADAPTERS = ["claude-code", "goose"];

export async function getAdapter(name) {
  if (name === "claude-code") return await import("./adapters/claude-code.js");
  if (name === "goose") return await import("./adapters/goose.js");
  throw new Error(`unknown adapter '${name}'. Available: ${ADAPTERS.join(", ")}`);
}
