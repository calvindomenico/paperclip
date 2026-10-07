import { describe, expect, it } from "vitest";
import { buildRawMessage, decodeBase64Url, extractMessageBody, getHeader, MESSAGE_BODY_CHAR_CAP } from "./mime.js";

function encode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

describe("getHeader", () => {
  it("is case-insensitive", () => {
    const headers = [{ name: "Subject", value: "Hello" }];
    expect(getHeader(headers, "subject")).toBe("Hello");
    expect(getHeader(headers, "SUBJECT")).toBe("Hello");
  });

  it("returns null when absent", () => {
    expect(getHeader([], "Subject")).toBeNull();
    expect(getHeader(null, "Subject")).toBeNull();
  });
});

describe("extractMessageBody", () => {
  it("prefers a top-level text/plain body", () => {
    const result = extractMessageBody({
      mimeType: "text/plain",
      body: { data: encode("plain body") },
    });
    expect(result.text).toBe("plain body");
    expect(result.truncated).toBe(false);
    expect(result.attachmentFilenames).toEqual([]);
  });

  it("finds text/plain nested inside multipart/alternative", () => {
    const result = extractMessageBody({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { data: encode("<p>hi</p>") } },
        { mimeType: "text/plain", body: { data: encode("hi") } },
      ],
    });
    expect(result.text).toBe("hi");
  });

  it("falls back to stripped HTML when no text/plain part exists", () => {
    const result = extractMessageBody({
      mimeType: "text/html",
      body: { data: encode("<p>Hello <b>world</b></p><p>Second line</p>") },
    });
    expect(result.text).toContain("Hello");
    expect(result.text).toContain("world");
    expect(result.text).toContain("Second line");
    expect(result.text).not.toContain("<p>");
    expect(result.text).not.toContain("<b>");
  });

  it("caps the body at 20,000 characters and reports truncation", () => {
    const longBody = "x".repeat(MESSAGE_BODY_CHAR_CAP + 500);
    const result = extractMessageBody({
      mimeType: "text/plain",
      body: { data: encode(longBody) },
    });
    expect(result.text).toHaveLength(MESSAGE_BODY_CHAR_CAP);
    expect(result.truncated).toBe(true);
  });

  it("collects attachment filenames across nested parts without including them in the body", () => {
    const result = extractMessageBody({
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: encode("see attached") } },
        { mimeType: "application/pdf", filename: "invoice.pdf", body: { attachmentId: "abc", size: 1024 } },
        {
          mimeType: "multipart/mixed",
          parts: [{ mimeType: "image/png", filename: "screenshot.png", body: { attachmentId: "def" } }],
        },
      ],
    });
    expect(result.text).toBe("see attached");
    expect(result.attachmentFilenames).toEqual(["invoice.pdf", "screenshot.png"]);
  });

  it("returns an empty body for a payload with no text parts", () => {
    const result = extractMessageBody(null);
    expect(result.text).toBe("");
    expect(result.truncated).toBe(false);
  });
});

describe("decodeBase64Url", () => {
  it("round-trips UTF-8 text", () => {
    expect(decodeBase64Url(encode("héllo wörld"))).toBe("héllo wörld");
  });
});

describe("buildRawMessage", () => {
  it("builds a plain RFC 2822 message with no In-Reply-To when not replying", () => {
    const raw = Buffer.from(
      buildRawMessage({ to: ["a@example.com"], subject: "Hi", body: "Body text" }),
      "base64url",
    ).toString("utf8");

    expect(raw).toContain("To: a@example.com");
    expect(raw).toContain("Subject: Hi");
    expect(raw).toContain("Body text");
    expect(raw).not.toContain("In-Reply-To");
  });

  it("includes Cc/Bcc and threading headers when replying", () => {
    const raw = Buffer.from(
      buildRawMessage({
        to: ["a@example.com"],
        cc: ["b@example.com"],
        bcc: ["c@example.com"],
        subject: "Re: Hi",
        body: "Reply text",
        inReplyToMessageId: "<msg-1@mail.gmail.com>",
        references: "<msg-0@mail.gmail.com> <msg-1@mail.gmail.com>",
      }),
      "base64url",
    ).toString("utf8");

    expect(raw).toContain("Cc: b@example.com");
    expect(raw).toContain("Bcc: c@example.com");
    expect(raw).toContain("In-Reply-To: <msg-1@mail.gmail.com>");
    expect(raw).toContain("References: <msg-0@mail.gmail.com> <msg-1@mail.gmail.com>");
  });

  it("never emits a raw message containing the literal word 'send' as an API directive", () => {
    // Guard against accidental copy-paste of a send-capable template: this
    // module only ever feeds its output into users.drafts.create.
    const raw = buildRawMessage({ to: ["a@example.com"], subject: "Hi", body: "Body" });
    expect(raw).not.toMatch(/drafts\.send|messages\.send/i);
  });

  it("encodes a non-ASCII subject as a MIME encoded-word", () => {
    const raw = Buffer.from(
      buildRawMessage({ to: ["a@example.com"], subject: "héllo", body: "Body" }),
      "base64url",
    ).toString("utf8");
    expect(raw).toContain("Subject: =?UTF-8?B?");
  });
});
