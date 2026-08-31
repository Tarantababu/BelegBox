import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadTemplate } from "./load.js";
import { TemplateRegistry } from "./render.js";

export const TEMPLATES_DIR = join(import.meta.dirname, "../templates");

/**
 * Loads every template in a directory.
 *
 * One file per key, so a template's history is its file's history: a change to
 * a legal explanation shows up as a reviewable diff rather than a line moved
 * inside a bundle.
 */
export async function loadTemplateDir(dir = TEMPLATES_DIR): Promise<TemplateRegistry> {
  const registry = new TemplateRegistry();
  const files = (await readdir(dir)).filter((f) => f.endsWith(".yaml")).sort();

  for (const file of files) {
    const template = loadTemplate(await readFile(join(dir, file), "utf8"));
    registry.add(template);
  }
  return registry;
}
