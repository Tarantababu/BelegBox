import QRCode from "qrcode";
import { buildGiroCodePayload, type GiroCodeInput } from "./girocode.js";

/**
 * EPC-069-12 mandates error correction level M for a GiroCode. Not a
 * preference: a code printed on paper and scanned under a shop light needs the
 * redundancy, and apps validating strictly will refuse another level.
 */
const ERROR_CORRECTION = "M" as const;

export interface GiroCodeSvg {
  payload: string;
  svg: string;
  byteLength: number;
}

/**
 * Renders the GiroCode.
 *
 * SVG rather than PNG: it prints at any size, embeds in a page without a second
 * request, and stays legible when a user zooms. The payload is returned beside
 * it so the screen can show exactly what was encoded - the whole point being
 * that the user can check the IBAN before their banking app acts on it.
 */
export async function renderGiroCodeSvg(input: GiroCodeInput): Promise<GiroCodeSvg> {
  const payload = buildGiroCodePayload(input);

  const svg = await QRCode.toString(payload, {
    type: "svg",
    errorCorrectionLevel: ERROR_CORRECTION,
    margin: 2,
    // The payload is Latin-1-safe ASCII in practice, but a supplier name can
    // carry umlauts and the EPC character set is UTF-8.
    version: undefined,
  });

  return { payload, svg, byteLength: Buffer.byteLength(payload, "utf8") };
}

export async function renderGiroCodeDataUrl(input: GiroCodeInput): Promise<GiroCodeSvg & { dataUrl: string }> {
  const rendered = await renderGiroCodeSvg(input);
  const dataUrl = await QRCode.toDataURL(rendered.payload, {
    errorCorrectionLevel: ERROR_CORRECTION,
    margin: 2,
    width: 512,
  });
  return { ...rendered, dataUrl };
}
