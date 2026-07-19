import path from "node:path";

export function orbiterxPathOverride() {
  return (
    process.env.ORBITERX_EXECUTABLE ??
    path.join(process.cwd(), "..", "..", "orbiterx-rs", "target", "debug", "orbiterx")
  );
}
