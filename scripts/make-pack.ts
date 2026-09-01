/**
 * make-pack.ts — turn exceptions.csv into a minimal, valid one-page PDF.
 *
 * OFFLINE MODE ONLY (`make demo-offline`). The scored demo formats the
 * close pack in LibreOffice on a Solari desktop; this exists so the
 * curl-driven offline path has a real PDF to upload without any Solari
 * session or external tooling.
 *
 * Usage: node scripts/make-pack.ts <exceptions.csv> <out.pdf>
 *
 * Hand-rolled PDF 1.4: catalog → pages → page → Courier font → content
 * stream, with correct xref byte offsets. No dependencies.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Escape the three characters that are special inside a PDF literal string. */
function pdfEscape(text: string): string {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
}

/**
 * Build a one-page PDF whose body is `lines` rendered in 10pt Courier.
 * Lines that would overflow the page are dropped (close packs are short).
 */
export function buildPdf(lines: string[]): Uint8Array {
  const encoder = new TextEncoder();
  const maxLines = 48;
  const shown = lines.slice(0, maxLines);

  const content =
    "BT /F1 10 Tf 50 750 Td 14 TL\n" +
    shown.map((line) => `(${pdfEscape(line)}) Tj T*`).join("\n") +
    "\nET";

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
    `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`,
  ];

  const chunks: Uint8Array[] = [encoder.encode("%PDF-1.4\n")];
  const offsets: number[] = [];
  let position = chunks[0]!.length;

  objects.forEach((body, index) => {
    offsets.push(position);
    const chunk = encoder.encode(`${index + 1} 0 obj\n${body}\nendobj\n`);
    chunks.push(chunk);
    position += chunk.length;
  });

  const xrefStart = position;
  const entry = (offset: number, inUse: boolean): string =>
    `${offset.toString().padStart(10, "0")} ${inUse ? "00000 n" : "65535 f"} \n`;
  const xref =
    `xref\n0 ${objects.length + 1}\n` +
    entry(0, false) +
    offsets.map((offset) => entry(offset, true)).join("");
  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(encoder.encode(xref + trailer));

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

/** CLI entrypoint. */
export function main(argv: string[]): void {
  const [csvPath, outPath] = argv;
  if (!csvPath || !outPath) {
    console.error("usage: node scripts/make-pack.ts <exceptions.csv> <out.pdf>");
    process.exit(2);
  }
  const lines = readFileSync(csvPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  const pdf = buildPdf([
    "NOAPI monthly vendor close - exception pack",
    "",
    ...lines,
  ]);
  writeFileSync(outPath, pdf);
  console.log(`pack.ok out=${outPath} bytes=${pdf.length}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv.slice(2));
}
