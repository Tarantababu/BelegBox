import { NextResponse } from "next/server";
import { API_URL, SESSION_COOKIE, currentSession } from "../../../lib/api";

/**
 * Forwards an uploaded file to the API.
 *
 * The multipart form is unpacked here, where Next already parses it, and the
 * bytes go on as a plain body. That keeps a multipart parser out of the API's
 * dependency surface for the one route that needs one.
 */
export async function POST(request: Request): Promise<Response> {
  const token = await currentSession();
  if (!token) return NextResponse.redirect(new URL("/login", request.url), { status: 303 });

  const form = await request.formData();
  const part = form.get("file");
  const back = new URL("/inbox", request.url);

  // A part is not always a File. Depending on the content type the browser or
  // operating system guessed - text/plain for an .xml on some machines - the
  // runtime hands back a plain string instead, and checking only for File
  // rejected the upload with "no file transferred" while a file was sitting
  // right there. Both shapes carry the same bytes.
  let bytes: ArrayBuffer;
  let filename: string;
  let contentType: string;

  if (part instanceof File) {
    bytes = await part.arrayBuffer();
    filename = part.name;
    contentType = part.type || "application/octet-stream";
  } else if (typeof part === "string" && part.length > 0) {
    bytes = new TextEncoder().encode(part).buffer as ArrayBuffer;
    filename = "upload";
    contentType = "application/octet-stream";
  } else {
    back.searchParams.set("fehler", "Bitte eine Datei auswählen.");
    return NextResponse.redirect(back, { status: 303 });
  }

  if (bytes.byteLength === 0) {
    back.searchParams.set("fehler", "Die Datei ist leer.");
    return NextResponse.redirect(back, { status: 303 });
  }

  const response = await fetch(`${API_URL}/v1/documents/upload`, {
    method: "POST",
    headers: {
      "content-type": contentType,
      // Encoded: a filename can carry anything, including a newline that would
      // split the header.
      "x-belegbox-filename": encodeURIComponent(filename),
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    },
    body: bytes,
    cache: "no-store",
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
    back.searchParams.set("fehler", detail.message ?? detail.error ?? "Upload fehlgeschlagen.");
    return NextResponse.redirect(back, { status: 303 });
  }

  const body = (await response.json()) as {
    documents: Array<{ id: string; duplicate: boolean }>;
  };
  const first = body.documents[0];

  // Straight to the document, because the point of uploading one is to see
  // what the check says about it.
  if (first) {
    return NextResponse.redirect(new URL(`/documents/${first.id}`, request.url), { status: 303 });
  }
  return NextResponse.redirect(back, { status: 303 });
}
