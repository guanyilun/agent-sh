const STUB_URL = new URL("./pi-sdk-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@mariozechner/pi-coding-agent") {
    return { url: STUB_URL, format: "module", shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
