import { rm } from "node:fs/promises";
import { URL } from "node:url";

await rm(new URL("../docs/reference", import.meta.url), { recursive: true, force: true });
