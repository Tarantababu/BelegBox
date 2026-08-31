#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { MustangClient, validateDocument } from "@belegbox/validation";
import { formatResult } from "./format.js";

const USAGE = `belegbox - e-invoice validation CLI

Usage
  belegbox validate <file...> [options]

Options
  --json            Machine-readable output.
  --offline         Skip L1/L2. Runs detection and D-001 only, no mustang-svc.
  --url <url>       mustang-svc base URL. Default: $MUSTANG_SVC_URL or
                    http://localhost:8081

Exit codes
  0  every document passed both verdicts
  1  at least one document failed a verdict
  2  usage or I/O error

Note
  L1 (XSD) and L2 (KoSIT Schematron) run inside services/mustang-svc, which
  needs Docker. Without it the form verdict is reported as "unknown" - never
  guessed.
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
      url: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const [command, ...files] = positionals;

  if (values.help || !command) {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }
  if (command !== "validate") {
    process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
    return 2;
  }
  if (files.length === 0) {
    process.stderr.write(`validate needs at least one file.\n\n${USAGE}`);
    return 2;
  }

  const client = values.url ? new MustangClient({ baseUrl: values.url }) : undefined;
  const results: unknown[] = [];
  let failed = false;

  for (const file of files) {
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch (err) {
      process.stderr.write(`Cannot read ${file}: ${(err as Error).message}\n`);
      return 2;
    }

    const result = await validateDocument(
      { filename: basename(file), bytes },
      {
        ...(client ? { client } : {}),
        ...(values.offline ? { skipL1L2: true } : {}),
      },
    );

    if (result.verdict.form === "fail" || result.verdict.content === "fail") {
      failed = true;
    }

    if (values.json) {
      results.push({ file, ...result });
    } else {
      process.stdout.write(`${formatResult(file, result)}\n\n`);
    }
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  }
  return failed ? 1 : 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
    process.exitCode = 2;
  });
