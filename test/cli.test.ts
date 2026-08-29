import assert from "node:assert/strict";
import test from "node:test";
import { parseCli } from "../src/cli.js";

test("normalizes an exact CNJ process number", () => {
  const options = parseCli(["--process", "08039489320204058000", "--skip-pdfs"]);
  assert.equal(options.criteria.processNumber, "0803948-93.2020.4.05.8000");
  assert.equal(options.skipPdfs, true);
});

test("accepts an ordered date range", () => {
  const options = parseCli(["--from", "01/08/2026", "--to", "02/08/2026"]);
  assert.deepEqual(options.criteria, { from: "01/08/2026", to: "02/08/2026" });
});

test("rejects missing, mixed, and invalid criteria", () => {
  assert.throws(() => parseCli([]), /Informe/);
  assert.throws(
    () => parseCli(["--process", "0803948-93.2020.4.05.8000", "--from", "01/08/2026", "--to", "02/08/2026"]),
    /no ambos/
  );
  assert.throws(() => parseCli(["--from", "31/02/2026", "--to", "01/03/2026"]), /inválida/);
});
