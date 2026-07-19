import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach } from "@jest/globals";

const originalOrbiterXHome = process.env.ORBITERX_HOME;
let currentOrbiterXHome: string | undefined;

beforeEach(async () => {
  currentOrbiterXHome = await fs.mkdtemp(path.join(os.tmpdir(), "orbiterx-sdk-test-"));
  process.env.ORBITERX_HOME = currentOrbiterXHome;
});

afterEach(async () => {
  const orbiterxHomeToDelete = currentOrbiterXHome;
  currentOrbiterXHome = undefined;

  if (originalOrbiterXHome === undefined) {
    delete process.env.ORBITERX_HOME;
  } else {
    process.env.ORBITERX_HOME = originalOrbiterXHome;
  }

  if (orbiterxHomeToDelete) {
    await fs.rm(orbiterxHomeToDelete, { recursive: true, force: true });
  }
});
